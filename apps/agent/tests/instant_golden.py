"""Instant Analysis goldens and desktop-parity report (CLI helper).

Not a pytest module: the file name does not match ``test_*.py``. It runs in
its own interpreter because the engine data view (custom builds file, map
bounds table) must be fixed BEFORE any engine module is imported, and a
fresh interpreter cannot be polluted by stubs other test modules install.

Usage::

    python apps/agent/tests/instant_golden.py --out DIR
        [--data-view installed|source] [--repeat N]
        [--parity-report FILE] [--path-variants] [--fixture-dir DIR]

For every fixture in ``apps/replay-engine/tests/fixtures/replays`` and every
human perspective (each listed player with a toon handle) it writes
``DIR/<fixture-stem>__<toon>.json``::

    {"fixture": <file name>, "filename": <name passed>,
     "runtime": {"player_toon": <toon>},
     "envelope": <parse_replay_bytes result minus "payload">}

plus ``DIR/index.json``. The web engine test (``apps/web/tests/engine``)
feeds the same inputs to the Pyodide bundle and compares the envelopes.

Data views:

* ``installed`` (default) is what the shipped desktop agent and the browser
  bundle see: an EMPTY ``custom_builds.json`` and no ``map_bounds.json``.
* ``source`` uses the repo's data files. The custom builds file is copied to
  a temp file first, so nothing in the repo is ever written.

``--parity-report FILE`` also runs, per case, the desktop agent path
(``parse_replay_for_cloud_ex`` on the fixture with the player's name, a temp
``state_dir`` and ``resolve_pulse=True`` against a stubbed SC2Pulse resolver)
and the sandbox-flag agent path (``state_dir=None``, ``resolve_pulse=False``),
and records the differing dotted paths and digests for
``test_instant_analysis.py``. ``--path-variants`` adds filename, folder,
mtime and toon-folder variants. Per-case parse timings go to stderr.

Only needs the stdlib plus sc2reader (and its mpyq dependency).

Example:
    python apps/agent/tests/instant_golden.py --out /tmp/instant-golden --repeat 5
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import statistics
import sys
import tempfile
import time
import types
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

AGENT_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[3]
ENGINE_DATA_DIR = REPO_ROOT / "apps" / "replay-engine" / "data"
FIXTURE_DIR = REPO_ROOT / "apps" / "replay-engine" / "tests" / "fixtures" / "replays"

DATA_VIEW_INSTALLED = "installed"
DATA_VIEW_SOURCE = "source"
DATA_VIEWS: Tuple[str, ...] = (DATA_VIEW_INSTALLED, DATA_VIEW_SOURCE)
INDEX_FILE = "index.json"
GOLDEN_SCHEMA = 1
REPLAY_SUFFIX = ".sc2replay"

#: Fixed id the stubbed SC2Pulse resolver returns on the desktop path.
PULSE_STUB_CHARACTER_ID = "4242424"
# >= 30 s makes _resolve_pulse_character_id call the resolver synchronously
# (no daemon thread), so the stub is exercised deterministically.
PULSE_SYNC_TIMEOUT_SEC = "30"
# 2001-01-01T00:00:00Z: an mtime nobody's fresh copy has, to prove the file
# mtime never reaches the payload.
OLD_MTIME_EPOCH = 978307200
VARIANT_ERROR_PREFIX = "error:"
MS_PER_SECOND = 1000

_MASKED_ENV_VARS: Tuple[str, ...] = (
    "SC2TOOLS_OBSERVATION_DIR",
    "SC2TOOLS_PLAYER_HANDLE",
    "SC2TOOLS_PLAYER_CONFIG",
)
_ENGINE_SENTINEL_MODULE = "core.paths"


@dataclass(frozen=True)
class Case:
    """One fixture parsed from one human player's perspective."""

    fixture: Path
    toon: str
    name: str

    @property
    def key(self) -> str:
        """Golden file stem, e.g. ``warpgate_adept_tracking__1-S2-1-267727``."""
        return f"{self.fixture.stem}__{self.toon}"


# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------
def configure_data_view(view: str, scratch: Path) -> None:
    """Pin the engine data view. Must run before the engine is imported.

    Args:
        view: ``installed`` or ``source``.
        scratch: Temp dir that receives the custom builds file.

    Raises:
        RuntimeError: The engine was already imported in this process.
    """
    if _ENGINE_SENTINEL_MODULE in sys.modules:
        raise RuntimeError("configure_data_view must run before the engine is imported")
    builds_file = scratch / "custom_builds.json"
    if view == DATA_VIEW_INSTALLED:
        empty = {"version": _schema_version(), "builds": []}
        builds_file.write_text(json.dumps(empty), encoding="utf-8")
    else:
        shutil.copyfile(ENGINE_DATA_DIR / "custom_builds.json", builds_file)
    os.environ["SC2T_CUSTOM_BUILDS_FILE"] = str(builds_file)
    for name in _MASKED_ENV_VARS:
        os.environ.pop(name, None)
    if str(AGENT_DIR) not in sys.path:
        sys.path.insert(0, str(AGENT_DIR))
    if view == DATA_VIEW_INSTALLED:
        _force_empty_map_bounds()


def _schema_version() -> int:
    """``properties.version.const`` of the custom builds schema (no import)."""
    schema_path = ENGINE_DATA_DIR / "custom_builds.schema.json"
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    return int(schema["properties"]["version"]["const"])


def _force_empty_map_bounds() -> None:
    """Mirror the frozen agent, whose APP_DIR/data has no map_bounds.json."""
    from sc2tools_agent import replay_pipeline
    import core.map_playback_data as engine_copy  # type: ignore

    pipeline_copy = replay_pipeline._load_sc2ra_package_module("map_playback_data")
    copies: Tuple[Any, ...] = (engine_copy, pipeline_copy)
    for module in copies:
        module._BOUNDS_CACHE = {}


def _install_pulse_stub() -> None:
    """Replace the SC2Pulse resolver so the desktop path never hits the network."""
    stub = types.ModuleType("core.pulse_resolver")

    def resolve_pulse_id_by_toon(handle: str, name: str) -> str:
        return PULSE_STUB_CHARACTER_ID

    stub.resolve_pulse_id_by_toon = resolve_pulse_id_by_toon  # type: ignore[attr-defined]
    sys.modules["core.pulse_resolver"] = stub
    os.environ["SC2TOOLS_PULSE_TIMEOUT_SEC"] = PULSE_SYNC_TIMEOUT_SEC


# ---------------------------------------------------------------------------
# Cases and browser parses
# ---------------------------------------------------------------------------
def discover_cases(fixture_dir: Path) -> List[Case]:
    """Every fixture x every listed player that has a toon handle."""
    from sc2tools_agent.instant_analysis import list_replay_players

    fixtures = sorted(p for p in fixture_dir.iterdir() if p.suffix.lower() == REPLAY_SUFFIX)
    cases: List[Case] = []
    for fixture in fixtures:
        listing = list_replay_players(fixture.read_bytes(), filename=fixture.name)
        if not listing["ok"]:
            raise RuntimeError(f"cannot list players of {fixture.name}: {listing['errorKind']}")
        cases.extend(
            Case(fixture=fixture, toon=player["toon"], name=player["name"])
            for player in listing["players"]
            if player["toon"]
        )
    return cases


def browser_parse(case: Case, filename: str, runtime: Any) -> Dict[str, Any]:
    """``parse_replay_bytes`` on the fixture bytes."""
    from sc2tools_agent.instant_analysis import parse_replay_bytes

    return parse_replay_bytes(case.fixture.read_bytes(), filename=filename, runtime=runtime)


def run_browser_cases(cases: Sequence[Case], repeat: int) -> Dict[str, Tuple[Dict[str, Any], List[float]]]:
    """Parse every case ``repeat`` times; return (envelope, samples in ms)."""
    from sc2tools_agent.instant_analysis import RuntimeOptions

    results: Dict[str, Tuple[Dict[str, Any], List[float]]] = {}
    for case in cases:
        runtime = RuntimeOptions(player_toon=case.toon)
        samples: List[float] = []
        envelopes: List[Dict[str, Any]] = []
        for _ in range(max(1, repeat)):
            started = time.perf_counter()
            envelopes.append(browser_parse(case, case.fixture.name, runtime))
            samples.append((time.perf_counter() - started) * MS_PER_SECOND)
        if len({envelope.get("json") for envelope in envelopes}) != 1:
            raise RuntimeError(f"non-deterministic payload for {case.key}")
        results[case.key] = (envelopes[0], samples)
    return results


# ---------------------------------------------------------------------------
# Goldens
# ---------------------------------------------------------------------------
def golden_document(case: Case, envelope: Dict[str, Any]) -> Dict[str, Any]:
    """The per-case golden: inputs plus the envelope without ``payload``."""
    return {
        "fixture": case.fixture.name,
        "filename": case.fixture.name,
        "runtime": {"player_toon": case.toon},
        "envelope": {key: value for key, value in envelope.items() if key != "payload"},
    }


def write_goldens(out_dir: Path, view: str, cases: Sequence[Case], results: Dict[str, Any]) -> None:
    """Write one golden per case plus ``index.json``."""
    import sc2reader  # type: ignore
    from sc2tools_agent.instant_analysis import ENGINE_PROTOCOL

    out_dir.mkdir(parents=True, exist_ok=True)
    index_cases: List[Dict[str, Any]] = []
    for case in cases:
        envelope = results[case.key][0]
        write_json(out_dir / f"{case.key}.json", golden_document(case, envelope))
        index_cases.append({
            "file": f"{case.key}.json",
            "fixture": case.fixture.name,
            "filename": case.fixture.name,
            "toon": case.toon,
            "ok": envelope["ok"],
            "gameId": envelope.get("gameId"),
            "errorKind": envelope.get("errorKind"),
            "jsonSha256": sha256_text(envelope.get("json")),
        })
    write_json(out_dir / INDEX_FILE, {
        "schema": GOLDEN_SCHEMA,
        "engineProtocol": ENGINE_PROTOCOL,
        "dataView": view,
        "sc2reader": sc2reader.__version__,
        "cases": index_cases,
    })


def write_json(path: Path, document: Dict[str, Any]) -> None:
    """Deterministic, LF-terminated JSON on every platform."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(document, indent=2, sort_keys=True) + "\n")


def sha256_text(text: Optional[str]) -> Optional[str]:
    """SHA-256 hex of an ASCII JSON string, or None."""
    if text is None:
        return None
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Parity report
# ---------------------------------------------------------------------------
def diff_paths(left: Any, right: Any, prefix: str = "") -> List[str]:
    """Dotted paths where two JSON values differ (lists compare as a whole).

    Example:
        >>> diff_paths({"a": {"b": 1, "c": [1]}}, {"a": {"b": 2, "c": [1]}})
        ['a.b']
    """
    if isinstance(left, dict) and isinstance(right, dict):
        out: List[str] = []
        for key in sorted(set(left) | set(right)):
            path = f"{prefix}.{key}" if prefix else str(key)
            if key not in left or key not in right:
                out.append(path)
            else:
                out.extend(diff_paths(left[key], right[key], path))
        return out
    from sc2tools_agent.upload_json import compact_json_bytes

    if compact_json_bytes(left) == compact_json_bytes(right):
        return []
    return [prefix or "<root>"]


def agent_parse(fixture: Path, handle: str, state_dir: Optional[Path], resolve_pulse: bool) -> Dict[str, Any]:
    """The desktop call: ``parse_replay_for_cloud_ex`` on a real path."""
    from sc2tools_agent import replay_pipeline
    from sc2tools_agent.upload_json import compact_json_bytes

    if state_dir is not None:
        state_dir.mkdir(parents=True, exist_ok=True)
    game, reason = replay_pipeline.parse_replay_for_cloud_ex(
        fixture,
        player_handle=handle,
        state_dir=state_dir,
        resolve_pulse=resolve_pulse,
    )
    payload = game.to_payload() if game is not None else None
    text = compact_json_bytes(payload).decode("ascii") if payload is not None else None
    return {
        "reason": reason,
        "payload": payload,
        "gameId": payload.get("gameId") if payload else None,
        "jsonSha256": sha256_text(text),
    }


def parity_entry(case: Case, envelope: Dict[str, Any], scratch: Path) -> Dict[str, Any]:
    """Compare the browser envelope with both desktop agent call shapes."""
    browser_payload = envelope.get("payload")
    desktop = agent_parse(case.fixture, case.name, scratch / "state" / case.key, True)
    sandbox = agent_parse(case.fixture, case.name, None, False)
    return {
        "key": case.key,
        "fixture": case.fixture.name,
        "toon": case.toon,
        "browserOk": envelope["ok"],
        "browserErrorKind": envelope.get("errorKind"),
        "browserGameId": envelope.get("gameId"),
        "browserJsonSha256": sha256_text(envelope.get("json")),
        "agentReason": desktop["reason"],
        "agentGameId": desktop["gameId"],
        "agentDiffPaths": diff_paths(desktop["payload"], browser_payload),
        "agentPulseCharacterId": ((desktop["payload"] or {}).get("opponent") or {}).get("pulseCharacterId"),
        "agentPlainReason": sandbox["reason"],
        "agentPlainJsonSha256": sandbox["jsonSha256"],
        "agentPlainDiffPaths": diff_paths(sandbox["payload"], browser_payload),
    }


def _variant_digest(envelope: Dict[str, Any]) -> str:
    if envelope.get("ok"):
        return str(sha256_text(envelope["json"]))
    return f"{VARIANT_ERROR_PREFIX}{envelope.get('errorKind')}"


def _agent_copy_digest(case: Case, scratch: Path) -> str:
    """Desktop call on a renamed copy in another folder with a 2001 mtime."""
    copy = scratch / "copies" / case.key / "elsewhere" / "Renamed Copy.SC2Replay"
    copy.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(case.fixture, copy)
    os.utime(copy, (OLD_MTIME_EPOCH, OLD_MTIME_EPOCH))
    result = agent_parse(copy, case.name, None, False)
    return result["jsonSha256"] or f"{VARIANT_ERROR_PREFIX}{result['reason']}"


def path_variants(case: Case, scratch: Path, full: bool) -> Dict[str, str]:
    """Digests of the same bytes under other names, folders and selectors."""
    from sc2tools_agent.instant_analysis import RuntimeOptions

    by_toon = RuntimeOptions(player_toon=case.toon)
    toon_folder = f"Accounts/1/{case.toon}/Replays/Multiplayer/{case.fixture.name}"
    variants = {"toonFolder": _variant_digest(browser_parse(case, toon_folder, RuntimeOptions()))}
    if not full:
        return variants
    renamed = {
        "renamedNested": "some/deep/dir/Other Name (2).SC2Replay",
        "windowsAbsolute": "C:\\Users\\someone\\Documents\\game.sc2replay",
        "traversal": "../../x/../game.SC2Replay",
        "noExtension": "download.bin",
    }
    for label, filename in renamed.items():
        variants[label] = _variant_digest(browser_parse(case, filename, by_toon))
    handle_only = RuntimeOptions(player_handle=case.name)
    variants["handleOnly"] = _variant_digest(browser_parse(case, case.fixture.name, handle_only))
    variants["agentCopyOldMtime"] = _agent_copy_digest(case, scratch)
    return variants


def build_parity_report(
    view: str,
    cases: Sequence[Case],
    results: Dict[str, Any],
    scratch: Path,
    with_variants: bool,
) -> Dict[str, Any]:
    """Parity entries for every case (variants: all cases get toonFolder)."""
    _install_pulse_stub()
    entries: List[Dict[str, Any]] = []
    fixtures_with_full_variants: Set[str] = set()
    for case in cases:
        entry = parity_entry(case, results[case.key][0], scratch)
        if with_variants:
            full = case.fixture.name not in fixtures_with_full_variants
            entry["pathVariants"] = path_variants(case, scratch, full)
            fixtures_with_full_variants.add(case.fixture.name)
        entries.append(entry)
    return {
        "dataView": view,
        "pulseStubCharacterId": PULSE_STUB_CHARACTER_ID,
        "cases": entries,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _parse_args(argv: Optional[Sequence[str]]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, required=True, help="golden output directory")
    parser.add_argument("--data-view", choices=DATA_VIEWS, default=DATA_VIEW_INSTALLED)
    parser.add_argument("--repeat", type=int, default=1, help="parses per case (timing median)")
    parser.add_argument("--parity-report", type=Path, default=None)
    parser.add_argument("--path-variants", action="store_true")
    parser.add_argument("--fixture-dir", type=Path, default=FIXTURE_DIR)
    return parser.parse_args(argv)


def _print_timings(cases: Sequence[Case], results: Dict[str, Any]) -> None:
    for case in cases:
        envelope, samples = results[case.key]
        print(
            f"instant_golden case={case.key} ok={envelope['ok']} "
            f"median_ms={statistics.median(samples):.0f} runs={len(samples)}",
            file=sys.stderr,
        )


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Run the CLI; returns the process exit code."""
    args = _parse_args(argv)
    scratch = Path(tempfile.mkdtemp(prefix="sc2ia-golden-"))
    try:
        configure_data_view(args.data_view, scratch)
        cases = discover_cases(args.fixture_dir)
        results = run_browser_cases(cases, args.repeat)
        write_goldens(args.out, args.data_view, cases, results)
        if args.parity_report is not None:
            report = build_parity_report(args.data_view, cases, results, scratch, args.path_variants)
            write_json(args.parity_report, report)
        _print_timings(cases, results)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
