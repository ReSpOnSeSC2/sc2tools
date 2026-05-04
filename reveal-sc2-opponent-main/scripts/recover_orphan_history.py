"""
recover_orphan_history.py -- Stage 1 of STAGE_DATA_INTEGRITY_ROADMAP.

Production-grade recovery script that promotes the orphaned
``data/.tmp_*.json`` snapshots produced by ``Reveal-Sc2Opponent.ps1``
back into the live ``data/MyOpponentHistory.json``.

The orphans (each ~279 MB, 3,180 opponents, ~10,376 game records,
2017-04-01 -> 2026-05-03) carry the user's full historical Black Book
in the *legacy flat schema*::

    {"<pulse_id>": {"Name": "...",
                    "Wins":   <int>,
                    "Losses": <int>,
                    "Games":  [{"Date":"YYYY-MM-DD HH:MM",
                                "Result":"Victory|Defeat",
                                "Map":"..."}, ...]}}

The live file uses the *current Matchups schema* introduced in 2026-04::

    {"<pulse_id>": {"Name":"...",
                    "Race":"...",
                    "Notes":"...",
                    "Matchups": {
                        "<matchup_key>": {
                            "Wins":   <int>,
                            "Losses": <int>,
                            "Games":  [{"Date":..., "Result":..., "Map":...,
                                        "Duration":..., "opp_strategy":...,
                                        "my_build":..., "build_log":[...]
                                        }, ...]}}}}

This script merges the two:

* Every orphan opponent is upgraded to the Matchups schema. The flat
  ``Games`` list lands in a synthetic ``"Unknown"`` matchup so the
  modern readers can render it without needing a race lookup we don't
  have.
* For every pulse_id present in BOTH the orphan and the live file, the
  live entry wins on Name / Race / Notes (it is the most recent edit)
  AND we merge the live Matchups dict over the orphan's. The orphan's
  "Unknown" bucket is preserved alongside the live entry's modern
  matchup keys.
* The ``.bak`` is consulted as a third source: any pulse_id in the
  ``.bak`` but not in the live or orphan is folded in (defensive --
  it has happened that ``.bak`` carried a record neither side did).

The merge is verified to satisfy ``len(merged) >= 3,180`` and
``total_games >= 10,376`` before publishing, and the publish goes
through the binary-mode atomic-write pattern documented in
``docs/STAGE_DATA_INTEGRITY_ROADMAP.md`` Section 2 ("File-write
protocol"):

    1. Pre-edit checkpoint -- save the live file to
       ``MyOpponentHistory.json.pre-recovery-<UTC>``.
    2. Write merged JSON to a sibling .tmp via mkstemp.
    3. ``flush()`` + ``os.fsync()`` before rename.
    4. ``os.replace()`` to atomically swap.
    5. Post-edit verification -- parse the live file, re-count
       opponents and games.

The script is idempotent: running it twice on the same orphan does NOT
double-count games (game identity is the (Date prefix, Map, Result)
tuple, the same identity used by ``BlackBookStore.upsert_game``).

Quarantine: after a successful publish, the source ``.tmp_*`` files
are moved into ``data/.recovery-orphans-<UTC>/`` so any future
integrity sweep does not mistake them for stale junk.

Usage
-----

    python scripts/recover_orphan_history.py
    python scripts/recover_orphan_history.py --dry-run
    python scripts/recover_orphan_history.py --orphan PATH --target PATH

Engineering preamble compliance
-------------------------------
* Pure module: paths and timeouts injectable through ``main()``.
* Type hints + docstrings on every public function.
* No magic constants; every threshold is a named module-level constant.
* PII-safe: opponent names never logged at INFO; only counts and pulse
  ID hashes when individual records are mentioned.
* Best-effort cleanup: the temp file is unlinked on every error path.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import logging
import os
import shutil
import sys
import tempfile
from typing import Any, Dict, Iterable, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
DEFAULT_DATA_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), os.pardir, "data"
)
HISTORY_BASENAME = "MyOpponentHistory.json"
BAK_SUFFIX = ".bak"
PRE_RECOVERY_TAG = ".pre-recovery-"
RECOVERY_QUARANTINE_TAG = ".recovery-orphans-"
LEGACY_FALLBACK_MATCHUP = "Unknown"

# Roadmap-stated minimums on a successful merge.
MIN_OPPONENTS_FLOOR = 3_180
MIN_GAMES_FLOOR = 10_376


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logger = logging.getLogger("recover_orphan_history")


def _utc_stamp() -> str:
    """Compact UTC timestamp tag, e.g. ``20260504T184400Z``."""
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _hash_id(pulse_id: str) -> str:
    """Short opaque ID for log lines so we never leak pulse IDs at INFO."""
    digest = hashlib.sha1(str(pulse_id).encode("utf-8")).hexdigest()
    return digest[:8]


# ---------------------------------------------------------------------------
# IO helpers (binary mode -- never lose CRLF, never decode/re-encode)
# ---------------------------------------------------------------------------
def _read_json_bytes(path: str) -> Optional[Any]:
    """Read JSON via raw bytes; returns ``None`` if missing or unparseable."""
    if not os.path.exists(path):
        return None
    try:
        with open(path, "rb") as f:
            raw = f.read()
        if raw.startswith(b"\xef\xbb\xbf"):
            raw = raw[3:]
        raw = raw.strip(b" \t\r\n\x00")
        if not raw:
            return None
        return json.loads(raw.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        logger.warning("could not parse %s: %s", path, exc)
        return None


def _atomic_write_bytes(path: str, payload: bytes) -> None:
    """Bytes-level atomic write: mkstemp -> flush+fsync -> os.replace."""
    parent = os.path.dirname(path) or "."
    os.makedirs(parent, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=".tmp_recovery_", suffix=".json", dir=parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------------------
# Schema upgrade (flat legacy -> Matchups)
# ---------------------------------------------------------------------------
def _looks_legacy(record: Any) -> bool:
    """A flat-schema entry has top-level Wins/Losses/Games and no Matchups."""
    if not isinstance(record, dict):
        return False
    has_top_counts = "Wins" in record or "Losses" in record
    has_top_games = isinstance(record.get("Games"), list)
    has_matchups = isinstance(record.get("Matchups"), dict)
    return (has_top_counts or has_top_games) and not has_matchups


def _upgrade_legacy(record: Dict[str, Any]) -> Dict[str, Any]:
    """Promote a flat-schema record to the Matchups schema.

    The synthetic ``"Unknown"`` matchup carries the flat ``Games`` list
    plus the flat ``Wins`` / ``Losses`` counters so the count-only
    rendering paths in the analyzer SPA still see the right totals.
    """
    games = record.get("Games") or []
    if not isinstance(games, list):
        games = []
    wins = record.get("Wins")
    losses = record.get("Losses")
    if not isinstance(wins, int):
        wins = sum(1 for g in games if isinstance(g, dict) and g.get("Result") == "Victory")
    if not isinstance(losses, int):
        losses = sum(1 for g in games if isinstance(g, dict) and g.get("Result") == "Defeat")

    matchups: Dict[str, Any] = {
        LEGACY_FALLBACK_MATCHUP: {
            "Wins": int(wins),
            "Losses": int(losses),
            "Games": list(games),
        }
    }
    return {
        "Name": record.get("Name", "") or "",
        "Race": record.get("Race", "") or "",
        "Notes": record.get("Notes", "") or "",
        "Matchups": matchups,
    }


def _ensure_matchups_shape(record: Any) -> Dict[str, Any]:
    """Return ``record`` in the modern Matchups shape (no-op if already so).

    Tolerates partial records: missing Name / Race / Notes get filled
    with empty strings; missing Matchups becomes an empty dict.
    """
    if not isinstance(record, dict):
        return {"Name": "", "Race": "", "Notes": "", "Matchups": {}}
    if _looks_legacy(record):
        return _upgrade_legacy(record)
    return {
        "Name": record.get("Name", "") or "",
        "Race": record.get("Race", "") or "",
        "Notes": record.get("Notes", "") or "",
        "Matchups": record.get("Matchups") or {},
    }


# ---------------------------------------------------------------------------
# Game identity (must match BlackBookStore._game_identity)
# ---------------------------------------------------------------------------
def _game_identity(game: Dict[str, Any]) -> Tuple[str, str, str]:
    return (
        (game.get("Date") or "")[:16],
        (game.get("Map") or ""),
        (game.get("Result") or ""),
    )


def _merge_games(target: List[Dict[str, Any]], incoming: Iterable[Dict[str, Any]]) -> int:
    """Append non-duplicate games to ``target`` in place. Returns added count."""
    seen = {_game_identity(g) for g in target if isinstance(g, dict)}
    added = 0
    for g in incoming:
        if not isinstance(g, dict):
            continue
        ident = _game_identity(g)
        if ident in seen:
            continue
        target.append(g)
        seen.add(ident)
        added += 1
    return added


def _merge_matchup_dicts(
    target_matchups: Dict[str, Any],
    incoming_matchups: Dict[str, Any],
    *,
    incoming_wins_authoritative: bool,
) -> int:
    """Merge ``incoming_matchups`` into ``target_matchups``.

    Counters: when ``incoming_wins_authoritative`` is True, the incoming
    record's Wins/Losses overwrite the target's for matchup keys present
    on both sides. Otherwise the larger of the two is kept (defensive
    against partial-write losses on either side).

    Returns the total number of new game records folded in.
    """
    added = 0
    for mu_key, mu_val in incoming_matchups.items():
        if not isinstance(mu_val, dict):
            continue
        slot = target_matchups.setdefault(
            mu_key, {"Wins": 0, "Losses": 0, "Games": []}
        )
        if not isinstance(slot.get("Games"), list):
            slot["Games"] = []
        in_games = mu_val.get("Games") or []
        if isinstance(in_games, list):
            added += _merge_games(slot["Games"], in_games)

        in_w = mu_val.get("Wins", 0)
        in_l = mu_val.get("Losses", 0)
        cur_w = slot.get("Wins", 0)
        cur_l = slot.get("Losses", 0)
        if not isinstance(in_w, int):
            in_w = 0
        if not isinstance(in_l, int):
            in_l = 0
        if not isinstance(cur_w, int):
            cur_w = 0
        if not isinstance(cur_l, int):
            cur_l = 0
        if incoming_wins_authoritative:
            slot["Wins"] = in_w
            slot["Losses"] = in_l
        else:
            slot["Wins"] = max(cur_w, in_w)
            slot["Losses"] = max(cur_l, in_l)
    return added


def _merge_record_into(
    target: Dict[str, Any],
    incoming: Dict[str, Any],
    *,
    incoming_is_authoritative: bool,
) -> int:
    """Merge ``incoming`` into ``target`` in place. Both already in Matchups shape."""
    if incoming_is_authoritative:
        if incoming.get("Name"):
            target["Name"] = incoming["Name"]
        if incoming.get("Race"):
            target["Race"] = incoming["Race"]
        if incoming.get("Notes"):
            target["Notes"] = incoming["Notes"]
    else:
        target.setdefault("Name", incoming.get("Name", "") or "")
        target.setdefault("Race", incoming.get("Race", "") or "")
        target.setdefault("Notes", incoming.get("Notes", "") or "")

    target_matchups = target.setdefault("Matchups", {})
    return _merge_matchup_dicts(
        target_matchups,
        incoming.get("Matchups") or {},
        incoming_wins_authoritative=incoming_is_authoritative,
    )


# ---------------------------------------------------------------------------
# Counting helpers
# ---------------------------------------------------------------------------
def _count_games(record: Dict[str, Any]) -> int:
    """Total Games[] entries across every matchup of one record."""
    total = 0
    for mu in (record.get("Matchups") or {}).values():
        games = mu.get("Games") if isinstance(mu, dict) else None
        if isinstance(games, list):
            total += len(games)
    return total


def _total_opponents_and_games(history: Dict[str, Any]) -> Tuple[int, int]:
    total_games = 0
    for v in history.values():
        if isinstance(v, dict):
            total_games += _count_games(v)
    return len(history), total_games


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------
def _discover_orphans(data_dir: str) -> List[str]:
    """Return absolute paths of ``data/.tmp_*.json`` orphans, newest first."""
    out: List[str] = []
    if not os.path.isdir(data_dir):
        return out
    for name in os.listdir(data_dir):
        if not name.startswith(".tmp_") or not name.endswith(".json"):
            continue
        path = os.path.join(data_dir, name)
        if os.path.isfile(path):
            out.append(path)
    out.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    return out


def _pick_recovery_source(orphans: List[str]) -> Optional[str]:
    """Pick the newest orphan that parses cleanly and has > 100 keys.

    The 167-byte stub orphan from the audit is rejected automatically
    because its parsed dict will have 0 or 1 keys.
    """
    for path in orphans:
        parsed = _read_json_bytes(path)
        if not isinstance(parsed, dict):
            continue
        if len(parsed) < 100:
            logger.info(
                "skipping orphan %s (%d keys < 100)", os.path.basename(path), len(parsed)
            )
            continue
        return path
    return None


# ---------------------------------------------------------------------------
# Top-level recovery
# ---------------------------------------------------------------------------
class RecoveryResult:
    """Summary of a recovery run -- printed and returned for tests."""

    def __init__(self) -> None:
        self.live_path: Optional[str] = None
        self.source_orphan: Optional[str] = None
        self.bak_used: Optional[str] = None
        self.orphans_quarantined: List[str] = []
        self.opponents_pre: int = 0
        self.opponents_post: int = 0
        self.games_pre: int = 0
        self.games_post: int = 0
        self.pre_recovery_backup: Optional[str] = None
        self.dry_run: bool = False
        self.published: bool = False
        self.notes: List[str] = []

    def to_dict(self) -> Dict[str, Any]:
        return dict(self.__dict__)


def recover(
    data_dir: str = DEFAULT_DATA_DIR,
    *,
    explicit_orphan: Optional[str] = None,
    explicit_target: Optional[str] = None,
    dry_run: bool = False,
    skip_quarantine: bool = False,
) -> RecoveryResult:
    """Run the full Stage 1 recovery against ``data_dir``.

    Args:
        data_dir: Directory holding ``MyOpponentHistory.json`` and the
            ``.tmp_*.json`` orphans. Defaults to the project ``data/``.
        explicit_orphan: Optional override path to a specific orphan
            (skips auto-pick).
        explicit_target: Optional override path to the live history file.
        dry_run: When True, do every step except the final atomic
            write and the orphan quarantine. Used in CI / smoke tests.
        skip_quarantine: When True, leave the orphan files in place
            (they are still treated as the recovery source). Useful
            when running the script repeatedly during development.

    Returns:
        :class:`RecoveryResult` with timestamps, file paths, and counts.

    Raises:
        FileNotFoundError: if no usable orphan can be found AND no
            explicit orphan was supplied.
        ValueError: if the merged dict fails the integrity floors.
    """
    data_dir = os.path.abspath(data_dir)
    target = explicit_target or os.path.join(data_dir, HISTORY_BASENAME)
    target = os.path.abspath(target)
    result = RecoveryResult()
    result.live_path = target
    result.dry_run = dry_run

    # ---- Pick the orphan ------------------------------------------------
    if explicit_orphan:
        if not os.path.exists(explicit_orphan):
            raise FileNotFoundError(f"explicit orphan not found: {explicit_orphan}")
        orphan_path = os.path.abspath(explicit_orphan)
    else:
        orphans = _discover_orphans(data_dir)
        orphan_path = _pick_recovery_source(orphans)
        if orphan_path is None:
            raise FileNotFoundError(
                "no .tmp_*.json orphan with >100 keys found in " + data_dir
            )
    result.source_orphan = orphan_path
    logger.info("recovery source orphan: %s", os.path.basename(orphan_path))

    # ---- Load all three sources -----------------------------------------
    orphan_data = _read_json_bytes(orphan_path)
    if not isinstance(orphan_data, dict):
        raise ValueError(f"orphan {orphan_path} did not parse to a dict")

    live_data = _read_json_bytes(target)
    if not isinstance(live_data, dict):
        live_data = {}
    bak_path = target + BAK_SUFFIX
    bak_data = _read_json_bytes(bak_path)
    if isinstance(bak_data, dict) and bak_data:
        result.bak_used = bak_path

    result.opponents_pre, result.games_pre = _total_opponents_and_games(live_data)
    logger.info(
        "pre-recovery live: opponents=%d games=%d",
        result.opponents_pre,
        result.games_pre,
    )
    o_count, o_games = _total_opponents_and_games(
        {k: _ensure_matchups_shape(v) for k, v in orphan_data.items()}
    )
    logger.info("orphan: opponents=%d games=%d", o_count, o_games)

    # ---- Build merged dict ---------------------------------------------
    merged: Dict[str, Any] = {}
    # 1) Start with the orphan, normalised to Matchups shape.
    for pid, rec in orphan_data.items():
        merged[str(pid)] = _ensure_matchups_shape(rec)

    # 2) Fold in .bak entries that are NEW (orphan didn't have them).
    if isinstance(bak_data, dict):
        bak_added = 0
        for pid, rec in bak_data.items():
            spid = str(pid)
            shaped = _ensure_matchups_shape(rec)
            if spid not in merged:
                merged[spid] = shaped
                bak_added += 1
            else:
                # Defensive merge: any games in .bak we don't have yet.
                _merge_record_into(
                    merged[spid], shaped, incoming_is_authoritative=False
                )
        if bak_added:
            logger.info("folded %d new pulse_ids in from .bak", bak_added)

    # 3) Live wins on conflict for Name / Race / Notes; matchup data merges.
    live_added_pids = 0
    live_merged_games = 0
    for pid, rec in live_data.items():
        spid = str(pid)
        shaped = _ensure_matchups_shape(rec)
        if spid not in merged:
            merged[spid] = shaped
            live_added_pids += 1
            live_merged_games += _count_games(shaped)
            continue
        live_merged_games += _merge_record_into(
            merged[spid], shaped, incoming_is_authoritative=True
        )
    logger.info(
        "live: %d new pulse_ids folded, %d new games merged",
        live_added_pids,
        live_merged_games,
    )

    # ---- Integrity floors ----------------------------------------------
    final_opps, final_games = _total_opponents_and_games(merged)
    result.opponents_post = final_opps
    result.games_post = final_games
    logger.info("merged: opponents=%d games=%d", final_opps, final_games)
    if final_opps < MIN_OPPONENTS_FLOOR:
        raise ValueError(
            f"merged opponent count {final_opps} below floor {MIN_OPPONENTS_FLOOR}; "
            f"refusing to publish"
        )
    if final_games < MIN_GAMES_FLOOR:
        raise ValueError(
            f"merged game count {final_games} below floor {MIN_GAMES_FLOOR}; "
            f"refusing to publish"
        )

    # ---- Pre-recovery snapshot (binary copy, byte-identical) -----------
    if os.path.exists(target):
        snap_path = target + PRE_RECOVERY_TAG + _utc_stamp()
        if not dry_run:
            shutil.copy2(target, snap_path)
        result.pre_recovery_backup = snap_path
        logger.info("pre-recovery snapshot: %s", os.path.basename(snap_path))

    # ---- Serialize + publish -------------------------------------------
    payload = json.dumps(merged, indent=4, ensure_ascii=False).encode("utf-8")
    # Sanity-check that what we serialised round-trips.
    rt = json.loads(payload.decode("utf-8"))
    if not isinstance(rt, dict) or len(rt) != final_opps:
        raise RuntimeError(
            "round-trip sanity check failed: serialised dict re-parsed to a "
            f"different shape ({type(rt).__name__}, len={len(rt) if hasattr(rt,'__len__') else '?'})"
        )

    if dry_run:
        logger.info("[dry-run] would write %d bytes to %s", len(payload), target)
        return result

    _atomic_write_bytes(target, payload)
    result.published = True

    # Verify on-disk parse now that we've published.
    final_check = _read_json_bytes(target)
    if not isinstance(final_check, dict) or len(final_check) != final_opps:
        raise RuntimeError(
            "post-write verification failed: on-disk shape "
            f"{type(final_check).__name__}, len={len(final_check) if hasattr(final_check,'__len__') else '?'}"
        )

    # ---- Quarantine the orphans ---------------------------------------
    if not skip_quarantine:
        quarantine_dir = os.path.join(
            data_dir, RECOVERY_QUARANTINE_TAG.lstrip(".") + _utc_stamp()
        )
        os.makedirs(quarantine_dir, exist_ok=True)
        for orphan in _discover_orphans(data_dir):
            dest = os.path.join(quarantine_dir, os.path.basename(orphan))
            shutil.move(orphan, dest)
            result.orphans_quarantined.append(dest)
        logger.info(
            "quarantined %d orphan(s) into %s",
            len(result.orphans_quarantined),
            quarantine_dir,
        )

    return result


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------
def _build_argparser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Stage 1 of STAGE_DATA_INTEGRITY_ROADMAP: recover the orphaned "
            "MyOpponentHistory tmp snapshots back into the live file."
        )
    )
    parser.add_argument(
        "--data-dir",
        default=DEFAULT_DATA_DIR,
        help=f"Project data/ directory (default: {DEFAULT_DATA_DIR}).",
    )
    parser.add_argument(
        "--orphan",
        default=None,
        help="Explicit orphan path (default: auto-pick newest >100-key .tmp_*.json).",
    )
    parser.add_argument(
        "--target",
        default=None,
        help="Explicit target live-file path (default: <data-dir>/MyOpponentHistory.json).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Compute and verify the merge but do not publish or quarantine.",
    )
    parser.add_argument(
        "--no-quarantine",
        action="store_true",
        help="Leave the orphan files in place after a successful publish.",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Verbose logging (DEBUG).",
    )
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    args = _build_argparser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    try:
        result = recover(
            args.data_dir,
            explicit_orphan=args.orphan,
            explicit_target=args.target,
            dry_run=args.dry_run,
            skip_quarantine=args.no_quarantine,
        )
    except (FileNotFoundError, ValueError, RuntimeError) as exc:
        logger.error("recovery failed: %s", exc)
        return 1
    print(json.dumps(result.to_dict(), indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
