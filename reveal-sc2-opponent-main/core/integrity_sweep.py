"""
core.integrity_sweep -- Stage 5 of STAGE_DATA_INTEGRITY_ROADMAP.

Walks ``data/`` at every backend / watcher / scanner start, surfaces
orphaned ``.tmp_*.json`` files, detects corrupt live files, and places
recovery candidates in ``data/.recovery/<basename>/`` for the user
to review and apply through the Diagnostics page (or the CLI).

Design notes
------------

* **Read-only.** The sweep never publishes a recovery automatically.
  All it does is move/copy files into the ``data/.recovery/<base>/``
  staging directory. A user clicks "Apply recovery" in the SPA (or
  runs ``python -m core.integrity_sweep --apply <candidate>``) to
  promote the candidate.
* **Idempotent.** Running the sweep N times against the same state
  produces the same staging output -- the candidate file is named
  ``<basename>-<UTC>.json`` so we never overwrite a previous run's
  candidate. Safe to invoke on every process start.
* **PII-safe.** Only counts and basenames are logged at INFO. Pulse
  IDs / opponent names never appear in log lines.
* **Cross-language friendly.** Mirrors the JS-side helpers in
  ``stream-overlay-backend/lib/integrity_sweep.js`` byte-for-byte on
  the staging-directory layout so either implementation can serve
  recovery candidates to the SPA.

Triage tiers per live file
--------------------------

1. Live parses cleanly + matches floor    -> OK
2. Live parses cleanly + below floor      -> CORRUPT_SMALL
3. Live fails to parse                    -> CORRUPT_UNPARSEABLE
4. Live missing                            -> MISSING

For tiers 2/3/4 the sweep looks for a candidate in this order:

* a ``.tmp_*.json`` orphan in the same dir that parses cleanly and
  has a key count >= the live file's
* the matching ``<basename>.bak`` snapshot
* the newest file in ``data/.recovery/<basename>/`` (a previous-
  run's candidate that was never applied)

Exactly the first hit is staged. If none of them are usable the
sweep raises a WARN and leaves the live file alone.

Exposed API
-----------

* :func:`run_sweep(data_dir, *, now=...)` -> :class:`SweepReport`
* :func:`apply_candidate(candidate_path, target_path)` -> ``None``
* CLI ``python -m core.integrity_sweep --data-dir DIR``
* CLI ``python -m core.integrity_sweep --apply CANDIDATE``
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as _dt
import json
import logging
import os
import shutil
import sys
import time
from typing import Any, Dict, List, Optional

# ---------------------------------------------------------------------------
# Tunables
# ---------------------------------------------------------------------------
DEFAULT_TMP_AGE_THRESHOLD_SEC = 300  # 5 min -- young .tmp may be a live write
RECOVERY_DIR_NAME = ".recovery"
ORPHAN_QUARANTINE_PREFIX = "recovery-orphans-"
TRACKED_BASENAMES = (
    "MyOpponentHistory.json",
    "meta_database.json",
    "custom_builds.json",
    "profile.json",
    "config.json",
)


logger = logging.getLogger("integrity_sweep")


# ---------------------------------------------------------------------------
# UTC helper -- timezone-aware, never deprecated
# ---------------------------------------------------------------------------
def _utc_stamp() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


# ---------------------------------------------------------------------------
# Floors mirror core.atomic_io.FILE_FLOORS but kept in a local copy so
# this module imports cleanly even on a partial install.
# ---------------------------------------------------------------------------
def _resolve_floor(basename: str) -> int:
    try:
        from core.atomic_io import FILE_FLOORS  # late import: optional dep
        return int(FILE_FLOORS.get(basename, 0) or 0)
    except Exception:  # noqa: BLE001
        return 0


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _read_json_bytes(path: str) -> Optional[Any]:
    try:
        with open(path, "rb") as f:
            raw = f.read()
        if raw.startswith(b"\xef\xbb\xbf"):
            raw = raw[3:]
        raw = raw.strip(b" \t\r\n\x00")
        if not raw:
            return None
        return json.loads(raw.decode("utf-8"))
    except Exception:  # noqa: BLE001
        return None


def _key_count(parsed: Any) -> int:
    return len(parsed) if isinstance(parsed, dict) else 0


def _atomic_publish_bytes(path: str, payload: bytes) -> None:
    """Bytes-level atomic publish used by apply_candidate.

    We deliberately do not delegate to ``core.atomic_io.atomic_write_json``
    here: the candidate may already be a complete on-disk file we just
    want to swap in. We do the same fsync+rename dance with a fresh
    temp so the swap survives a kill mid-publish.
    """
    parent = os.path.dirname(path) or "."
    os.makedirs(parent, exist_ok=True)
    tmp_path = os.path.join(parent, ".tmp_apply_recovery.json")
    try:
        with open(tmp_path, "wb") as f:
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())
        # .bak the old live file before publishing so safe-read fallbacks
        # still work if the candidate later turns out to be wrong.
        if os.path.exists(path):
            try:
                shutil.copy2(path, path + ".bak")
            except OSError:
                pass
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------------------
# Findings dataclass
# ---------------------------------------------------------------------------
@dataclasses.dataclass
class FileFinding:
    basename: str
    live_path: str
    status: str                        # "ok" | "missing" | "corrupt_small" | "corrupt_unparseable"
    live_keys: int = 0
    candidate_path: Optional[str] = None  # path under data/.recovery/<base>/
    candidate_keys: int = 0
    candidate_source: Optional[str] = None  # "orphan" | "bak" | "stale_recovery" | None
    notes: List[str] = dataclasses.field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return dataclasses.asdict(self)


@dataclasses.dataclass
class SweepReport:
    data_dir: str
    timestamp: str
    findings: List[FileFinding]
    orphans_seen: List[str]
    orphans_aged: List[str]            # those past the age threshold
    candidates_staged: List[str]
    warnings: List[str]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "data_dir": self.data_dir,
            "timestamp": self.timestamp,
            "findings": [f.to_dict() for f in self.findings],
            "orphans_seen": list(self.orphans_seen),
            "orphans_aged": list(self.orphans_aged),
            "candidates_staged": list(self.candidates_staged),
            "warnings": list(self.warnings),
        }


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------
def _discover_orphans(data_dir: str, now: float, age_threshold_sec: float) -> Dict[str, Any]:
    """Return ``{seen: [...], aged: [...]}``."""
    seen: List[str] = []
    aged: List[str] = []
    if not os.path.isdir(data_dir):
        return {"seen": seen, "aged": aged}
    for name in os.listdir(data_dir):
        if not (name.startswith(".tmp_") and name.endswith(".json")):
            continue
        path = os.path.join(data_dir, name)
        if not os.path.isfile(path):
            continue
        seen.append(path)
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            mtime = 0.0
        if now - mtime >= age_threshold_sec:
            aged.append(path)
    return {"seen": seen, "aged": aged}


def _newest_recovery_candidate(data_dir: str, basename: str) -> Optional[str]:
    """Newest stale candidate left over from a previous sweep, if any."""
    rdir = os.path.join(data_dir, RECOVERY_DIR_NAME, basename)
    if not os.path.isdir(rdir):
        return None
    files = []
    for name in os.listdir(rdir):
        if not name.endswith(".json"):
            continue
        path = os.path.join(rdir, name)
        if os.path.isfile(path):
            files.append(path)
    if not files:
        return None
    files.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    return files[0]


def _stage_candidate(
    data_dir: str,
    basename: str,
    source_path: str,
    *,
    source_label: str,
) -> str:
    """Copy ``source_path`` into ``data/.recovery/<basename>/<base>-<UTC>.json``.

    Returns the absolute candidate path. Existing candidate files are
    not overwritten -- we always create a new timestamped name.
    """
    rdir = os.path.join(data_dir, RECOVERY_DIR_NAME, basename)
    os.makedirs(rdir, exist_ok=True)
    stem = os.path.splitext(basename)[0]
    candidate_path = os.path.join(rdir, f"{stem}-{_utc_stamp()}-{source_label}.json")
    shutil.copy2(source_path, candidate_path)
    return candidate_path


# ---------------------------------------------------------------------------
# Per-file triage
# ---------------------------------------------------------------------------
def _triage_one(
    data_dir: str,
    basename: str,
    orphan_pool: List[str],
) -> FileFinding:
    """Inspect one tracked file and decide whether a candidate is needed."""
    live_path = os.path.join(data_dir, basename)
    finding = FileFinding(basename=basename, live_path=live_path, status="ok")
    floor = _resolve_floor(basename)

    if not os.path.exists(live_path):
        finding.status = "missing"
    else:
        parsed = _read_json_bytes(live_path)
        if parsed is None:
            finding.status = "corrupt_unparseable"
        else:
            finding.live_keys = _key_count(parsed)
            if floor and finding.live_keys < floor:
                finding.status = "corrupt_small"

    if finding.status == "ok":
        return finding

    # Need a candidate. Look in the orphan pool first.
    best_orphan: Optional[str] = None
    best_orphan_keys = -1
    for orphan in orphan_pool:
        parsed = _read_json_bytes(orphan)
        if not isinstance(parsed, dict):
            continue
        kc = len(parsed)
        if kc <= finding.live_keys:
            continue
        if kc > best_orphan_keys:
            best_orphan_keys = kc
            best_orphan = orphan
    if best_orphan is not None:
        candidate = _stage_candidate(
            data_dir, basename, best_orphan, source_label="orphan"
        )
        finding.candidate_path = candidate
        finding.candidate_keys = best_orphan_keys
        finding.candidate_source = "orphan"
        return finding

    # Try .bak.
    bak_path = live_path + ".bak"
    bak_parsed = _read_json_bytes(bak_path)
    if isinstance(bak_parsed, dict) and len(bak_parsed) > finding.live_keys:
        candidate = _stage_candidate(
            data_dir, basename, bak_path, source_label="bak"
        )
        finding.candidate_path = candidate
        finding.candidate_keys = len(bak_parsed)
        finding.candidate_source = "bak"
        return finding

    # Stale recovery from a previous sweep.
    stale = _newest_recovery_candidate(data_dir, basename)
    if stale and stale != finding.candidate_path:
        stale_parsed = _read_json_bytes(stale)
        if isinstance(stale_parsed, dict) and len(stale_parsed) > finding.live_keys:
            finding.candidate_path = stale
            finding.candidate_keys = len(stale_parsed)
            finding.candidate_source = "stale_recovery"
            return finding

    finding.notes.append("no usable candidate found")
    return finding


# ---------------------------------------------------------------------------
# Public sweep entry point
# ---------------------------------------------------------------------------
def run_sweep(
    data_dir: str,
    *,
    now: Optional[float] = None,
    tmp_age_threshold_sec: float = DEFAULT_TMP_AGE_THRESHOLD_SEC,
) -> SweepReport:
    """Walk ``data_dir`` once and stage any recovery candidates we find."""
    data_dir = os.path.abspath(data_dir)
    if now is None:
        now = time.time()
    report = SweepReport(
        data_dir=data_dir,
        timestamp=_utc_stamp(),
        findings=[],
        orphans_seen=[],
        orphans_aged=[],
        candidates_staged=[],
        warnings=[],
    )
    if not os.path.isdir(data_dir):
        report.warnings.append(f"data_dir does not exist: {data_dir}")
        return report

    orphans = _discover_orphans(data_dir, now=now, age_threshold_sec=tmp_age_threshold_sec)
    report.orphans_seen = sorted(orphans["seen"])
    report.orphans_aged = sorted(orphans["aged"])

    # Only consider AGED orphans for recovery -- a young one might be a
    # live write in progress by another process.
    pool = list(orphans["aged"])

    for basename in TRACKED_BASENAMES:
        finding = _triage_one(data_dir, basename, pool)
        report.findings.append(finding)
        if finding.candidate_path:
            report.candidates_staged.append(finding.candidate_path)
        if finding.status != "ok" and not finding.candidate_path:
            report.warnings.append(
                f"{basename}: {finding.status} -- no usable candidate"
            )

    if report.candidates_staged:
        logger.info("[integrity] candidates: %d", len(report.candidates_staged))
    elif any(f.status != "ok" for f in report.findings):
        logger.warning(
            "[integrity] %d file(s) in non-ok state but no candidates staged",
            sum(1 for f in report.findings if f.status != "ok"),
        )
    else:
        logger.info("[integrity] OK")

    return report


# ---------------------------------------------------------------------------
# Apply
# ---------------------------------------------------------------------------
def apply_candidate(candidate_path: str, target_path: str) -> None:
    """Promote ``candidate_path`` to ``target_path`` via atomic publish.

    Validates with Stage 4 gate logic (a corrupt candidate raises
    DataIntegrityError; live file is unchanged).

    Args:
        candidate_path: Path under ``data/.recovery/<base>/``.
        target_path:   Live data/<base> path to overwrite.
    """
    if not os.path.exists(candidate_path):
        raise FileNotFoundError(f"candidate not found: {candidate_path}")
    parsed = _read_json_bytes(candidate_path)
    if not isinstance(parsed, dict):
        from core.atomic_io import DataIntegrityError
        raise DataIntegrityError(
            f"apply_candidate: {candidate_path} did not parse to a dict"
        )
    floor = _resolve_floor(os.path.basename(target_path))
    if floor and len(parsed) < floor:
        from core.atomic_io import DataIntegrityError
        raise DataIntegrityError(
            f"apply_candidate: candidate has {len(parsed)} keys "
            f"(floor={floor}); refusing to apply"
        )

    with open(candidate_path, "rb") as f:
        payload = f.read()
    _atomic_publish_bytes(target_path, payload)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _build_argparser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Stage 5 -- scan data/ for orphaned tmp files and corrupt "
            "live files; stage recovery candidates."
        )
    )
    parser.add_argument("--data-dir", default=None,
                        help="Directory to scan (default: <repo>/data).")
    parser.add_argument("--apply", default=None,
                        help="Promote the given candidate path to its live target.")
    parser.add_argument("--target", default=None,
                        help="Explicit live target (only with --apply).")
    parser.add_argument("--json", action="store_true",
                        help="Emit the report as JSON on stdout.")
    parser.add_argument("-v", "--verbose", action="store_true")
    return parser


def _default_data_dir() -> str:
    return os.path.abspath(os.path.join(
        os.path.dirname(os.path.abspath(__file__)), os.pardir, "data"
    ))


def main(argv: Optional[List[str]] = None) -> int:
    args = _build_argparser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    if args.apply:
        candidate = os.path.abspath(args.apply)
        if args.target:
            target = os.path.abspath(args.target)
        else:
            # Default target: the live file with the same basename in data/.
            data_dir = os.path.abspath(args.data_dir or _default_data_dir())
            base = os.path.basename(candidate)
            # Strip trailing -<UTC>-<source>.json -> "<base>.json"
            stem, _ext = os.path.splitext(base)
            head = stem.split("-")[0]
            target = os.path.join(data_dir, head + ".json")
        try:
            apply_candidate(candidate, target)
        except Exception as exc:  # noqa: BLE001
            logger.error("apply_candidate failed: %s", exc)
            return 2
        print(f"applied {candidate} -> {target}")
        return 0

    data_dir = os.path.abspath(args.data_dir or _default_data_dir())
    report = run_sweep(data_dir)
    if args.json:
        print(json.dumps(report.to_dict(), indent=2, default=str))
    else:
        for f in report.findings:
            line = f"{f.basename:24s}  {f.status:22s}  keys={f.live_keys}"
            if f.candidate_path:
                line += f"  -> candidate ({f.candidate_source}, {f.candidate_keys} keys)"
            print(line)
        for w in report.warnings:
            print("WARN:", w)
    return 0


if __name__ == "__main__":
    sys.exit(main())
