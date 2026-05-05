"""Public landing-page preview CLI for sc2tools.com.

Parses a single .SC2Replay file and emits one JSON line that the cloud's
``/v1/public/preview-replay`` route streams back to the marketing
landing demo. The output is the smallest shape that lets the demo
render an "opponent dossier" — both players' identity + race + build
log + the shared map / duration.

We deliberately do NOT pick a "you" side: the visitor isn't signed in,
we have no ``my_handle``, and a marketing demo doesn't need to identify
the uploader. The modal renders a perspective toggle so the visitor
can read whichever side they care about.

Auth: none. The route is rate-limited per IP and capped at a small
body size so the CLI assumes inputs are tiny, one replay at a time.

Hardening: this CLI is the public-facing parser. Compared to the
desktop / agent ingestion path, it must NEVER let a Python crash
escape — every exception (including ``BaseException`` like
``SystemExit``) is converted into a structured ``ok: false`` line and
the process exits 0. The route's friendly-errors map then turns the
code into a human-readable hint. Otherwise the route handler raises
``python_error`` and the user sees the generic "The cloud parser hit
an error" message, which doesn't tell them anything actionable.

To keep the dependency surface small and predictable, this CLI imports
``sc2reader`` directly rather than going through
``core.replay_loader`` — that module's transitive imports
(``analytics.macro_score`` -> numpy/pandas, ``detectors.*`` ->
customtkinter via the desktop UI tree) are not needed here and have
historically been the source of import-time failures on the slim
Render image.

Modes:
  ``--file PATH``     parse a replay (the normal mode)
  ``--self-test``     emit an environment report (python version,
                      sc2reader version, working dir, sys.path) and
                      exit. Used by the cloud's
                      ``/preview-replay/health`` diagnostic endpoint
                      to verify the entire chain is reachable without
                      uploading a real replay.

Output (stdout, NDJSON, single line on success):

    {
      "ok": true,
      "game_id": "...",
      "map": "Equilibrium LE",
      "duration_sec": 642,
      "players": [ ... two entries ... ]
    }

On failure: a single object with ``ok: false`` and a ``code`` /
``message`` describing the failure. Exit code is 0 in both branches so
the caller can read stdout instead of guessing from exit codes.

Usage:

    python scripts/preview_replay_cli.py --file /tmp/upload.SC2Replay
    python scripts/preview_replay_cli.py --self-test
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import sys
import time
from typing import Any, Dict, Iterable, List, Optional, Tuple


# Cap how many build-log lines we emit. The marketing modal only needs
# enough to look meaningful; the live product is unlimited.
_BUILD_LOG_PREVIEW_LIMIT = 60

# Mirror apps/api/src/services/perGameCompute.js BUILD_LOG_NOISE_RE so
# the demo doesn't render Beacons/Sprays/RewardDance lines that the
# real product filters out at parse time.
_NOISE_RE = re.compile(r"^(Beacon|Reward|Spray)", re.IGNORECASE)

# When sc2reader can't read a replay because the SC2 patch that
# generated it is newer than sc2reader's bundled protocol catalog, the
# library throws a handful of low-level errors deep inside the binary
# decoder. The exact text varies across replay versions but always
# matches one of these signatures. We use them to map
# "library-too-old-for-this-patch" into a specific code so the front
# end can show a friendlier hint than "Couldn't parse that replay."
_PATCH_TOO_NEW_SIGNATURES: Tuple[str, ...] = (
    "ord() expected a character",
    "ReadError",
    "is not a valid",  # protocol enum bumps
    "BuildIdNotSupported",
    "could not load protocol",
    "no module named 'sc2reader.resources.protocol",
    "tuple index out of range",  # truncated protocol tables
)

# Skip filters for the public preview build-log. Mirror the canonical
# event_extractor SKIP_UNITS / SKIP_BUILDINGS lists — but we keep this
# CLI self-contained so the public route doesn't import the desktop
# tree. Workers, larva, locusts, spawn-eggs etc. would otherwise
# dominate the first 60 lines and make the dossier look like noise.
_SKIP_UNITS = frozenset({
    "MULE", "Larva", "LocustMP", "Probe", "SCV", "Drone", "Egg",
    "BroodlingEscort", "Broodling", "Changeling", "ChangelingMarine",
    "ChangelingMarineShield", "ChangelingZergling", "ChangelingZealot",
    "InfestedTerran", "AutoTurret", "PointDefenseDrone", "Interceptor",
    "AdeptPhaseShift", "Overlord", "OverseerCocoon", "BanelingCocoon",
    "RavagerCocoon", "LurkerCocoon", "TransportOverlordCocoon",
})
_SKIP_BUILDINGS = frozenset({
    "SupplyDepot", "SupplyDepotLowered", "CreepTumor",
    "CreepTumorBurrowed", "CreepTumorQueen", "ShieldBattery",
})
_RACE_PREFIXES: Tuple[str, ...] = ("Protoss", "Terran", "Zerg")


def _emit(obj: Dict[str, Any]) -> None:
    """Write one NDJSON record to stdout."""
    sys.stdout.write(json.dumps(obj, default=str) + "\n")
    sys.stdout.flush()


def _step(step: str, **fields: Any) -> None:
    """Emit a step-marker NDJSON line so the route can correlate
    Python-side progress with server-side timing logs."""
    payload: Dict[str, Any] = {"trace": True, "step": step}
    payload.update(fields)
    _emit(payload)


def _err(code: str, message: str) -> int:
    """Emit a structured failure record and return 0.

    The CLI ALWAYS exits 0 — the caller (`runPythonNdjson`) treats a
    non-zero exit with no records as ``python_error``, which surfaces
    as the unfriendly "cloud parser hit an error" string. Returning a
    structured record lets the route map ``code`` to a friendly hint.
    """
    _emit({"ok": False, "code": code, "message": message})
    return 0


def _classify_load_failure(exc: BaseException) -> str:
    """Map an sc2reader load-time exception to a code the UI knows.

    Returns ``"replay_too_new"`` when the failure looks like sc2reader
    can't read a newer SC2 patch's protocol; ``"parse_failed"``
    otherwise.
    """
    text = f"{type(exc).__name__}: {exc}"
    low = text.lower()
    for sig in _PATCH_TOO_NEW_SIGNATURES:
        if sig.lower() in low:
            return "replay_too_new"
    return "parse_failed"


def _clean_unit_name(raw: str) -> str:
    """Strip race prefixes and Lower/Upper variant suffixes."""
    name = raw
    for prefix in _RACE_PREFIXES:
        name = name.replace(prefix, "")
    for suffix in ("Lower", "Upper"):
        name = name.replace(suffix, "")
    return name.strip()


def _is_human(player: Any) -> bool:
    if getattr(player, "is_observer", False):
        return False
    if getattr(player, "is_referee", False):
        return False
    return True


def _player_name(player: Any) -> str:
    s = str(getattr(player, "name", "") or "").strip()
    return s or "?"


def _player_handle(player: Any) -> Optional[str]:
    return getattr(player, "toon_handle", None) or getattr(player, "handle", None)


def _race(player: Any) -> str:
    raw = getattr(player, "play_race", None) or getattr(player, "pick_race", None)
    s = str(raw or "").strip()
    return s or "Unknown"


def _result(player: Any) -> str:
    s = str(getattr(player, "result", "") or "").strip()
    return s or "Unknown"


def _owner_pid(event: Any) -> Optional[int]:
    """Best-effort owner-pid extraction across sc2reader event variants."""
    for attr in ("control_pid", "pid"):
        pid = getattr(event, attr, None)
        if isinstance(pid, int) and pid > 0:
            return pid
    unit = getattr(event, "unit", None)
    if unit is not None:
        owner = getattr(unit, "owner", None)
        owner_pid = getattr(owner, "pid", None) if owner is not None else None
        if isinstance(owner_pid, int) and owner_pid > 0:
            return owner_pid
    player = getattr(event, "player", None)
    pid = getattr(player, "pid", None) if player is not None else None
    if isinstance(pid, int) and pid > 0:
        return pid
    return None


def _unit_type_name(event: Any) -> Optional[str]:
    name = getattr(event, "unit_type_name", None)
    if name:
        return str(name)
    unit = getattr(event, "unit", None)
    if unit is not None:
        n = getattr(unit, "name", None)
        if n:
            return str(n)
    return None


def _walk_events(replay: Any) -> Dict[int, List[Dict[str, Any]]]:
    """Walk tracker events and bucket them by player pid."""
    try:
        from sc2reader.events.tracker import (
            UnitBornEvent, UnitInitEvent, UnitDoneEvent,
            UpgradeCompleteEvent, UnitTypeChangeEvent,
        )
    except ImportError:
        return {}

    by_pid: Dict[int, List[Dict[str, Any]]] = {}
    source: Iterable[Any] = (
        getattr(replay, "tracker_events", None)
        or getattr(replay, "events", None)
        or []
    )
    try:
        for evt in source:
            try:
                pid = _owner_pid(evt)
                raw = _unit_type_name(evt)
                second = int(getattr(evt, "second", 0) or 0)
                if pid is None:
                    continue
                if isinstance(evt, UpgradeCompleteEvent):
                    name = getattr(evt, "upgrade_type_name", None)
                    if not name:
                        continue
                    bucket = by_pid.setdefault(pid, [])
                    bucket.append(
                        {"name": str(name), "time": second, "type": "upgrade"}
                    )
                    continue
                if raw is None:
                    continue
                clean = _clean_unit_name(raw)
                if not clean:
                    continue
                if isinstance(evt, UnitInitEvent):
                    if clean in _SKIP_BUILDINGS:
                        continue
                    bucket = by_pid.setdefault(pid, [])
                    bucket.append(
                        {"name": clean, "time": second, "type": "building"}
                    )
                elif isinstance(evt, UnitBornEvent):
                    if clean in _SKIP_BUILDINGS or clean in _SKIP_UNITS:
                        continue
                    bucket = by_pid.setdefault(pid, [])
                    bucket.append(
                        {"name": clean, "time": second, "type": "unit"}
                    )
                elif isinstance(evt, UnitTypeChangeEvent):
                    if clean in _SKIP_BUILDINGS or clean in _SKIP_UNITS:
                        continue
                    bucket = by_pid.setdefault(pid, [])
                    bucket.append(
                        {"name": clean, "time": second, "type": "building"}
                    )
                elif isinstance(evt, UnitDoneEvent):
                    pass
            except Exception:
                continue
    except Exception:
        pass
    return by_pid


def _format_build_log(events: List[Dict[str, Any]]) -> List[str]:
    """Render bucketed events as ``"[m:ss] Name"`` lines, deduped and capped."""
    lines: List[str] = []
    seen: set = set()
    try:
        ordered = sorted(
            events,
            key=lambda e: (int(e.get("time", 0) or 0), str(e.get("name", "")))
        )
    except Exception:
        ordered = events
    for e in ordered:
        try:
            name = str(e.get("name") or "")
            if not name or _NOISE_RE.match(name):
                continue
            t = int(e.get("time", 0) or 0)
            if t < 0:
                t = 0
            m, s = divmod(t, 60)
            line = f"[{m}:{s:02d}] {name}"
            key = (t, name)
            if key in seen:
                continue
            seen.add(key)
            lines.append(line)
            if len(lines) >= _BUILD_LOG_PREVIEW_LIMIT:
                break
        except Exception:
            continue
    return lines


def _load_replay_with_fallback(path: str) -> Any:
    """Mirror ``core.replay_loader.load_replay_with_fallback`` inline."""
    import sc2reader  # local import — module-level imports kept lean
    try:
        return sc2reader.load_replay(path, load_level=4)
    except Exception:
        return sc2reader.load_replay(path, load_level=3)


def _self_test() -> int:
    """Emit one JSON line describing the Python environment.

    Used by the cloud's ``GET /v1/public/preview-replay/health``
    diagnostic endpoint — confirms the spawn chain works, sc2reader
    is importable, and reports the version. Always exits 0 so the
    runner gets a clean read on stdout.
    """
    info: Dict[str, Any] = {
        "ok": True,
        "self_test": True,
        "python_version": sys.version.split()[0],
        "python_implementation": platform.python_implementation(),
        "platform": platform.platform(),
        "executable": sys.executable,
        "cwd": os.getcwd(),
    }
    try:
        import sc2reader
        info["sc2reader_version"] = getattr(sc2reader, "__version__", "unknown")
        info["sc2reader_import_ok"] = True
    except BaseException as exc:  # noqa: BLE001
        info["ok"] = False
        info["sc2reader_import_ok"] = False
        info["sc2reader_import_error"] = f"{type(exc).__name__}: {exc}"
    _emit(info)
    return 0


def _run(path: str, trace: bool) -> int:
    """Inner driver. Caller wraps this in a BaseException net.

    When ``trace`` is set, emits a stream of step-marker NDJSON lines
    so the server can correlate per-stage timing. The route ignores
    these (it scans for the first ``ok:true|false`` record) but pino
    can log them as structured progress events.
    """
    t0 = time.monotonic()

    if not os.path.isfile(path):
        return _err("file_not_found", f"replay not found: {path}")
    if trace:
        _step("file_check_passed", path_size=os.path.getsize(path))

    try:
        import sc2reader  # noqa: F401  — fail fast if missing
    except ImportError as exc:
        return _err(
            "parser_import_failed",
            f"could not import sc2reader: {exc}",
        )
    if trace:
        _step(
            "sc2reader_imported",
            version=getattr(sc2reader, "__version__", "unknown"),
            elapsed_ms=int((time.monotonic() - t0) * 1000),
        )

    try:
        t_load = time.monotonic()
        replay = _load_replay_with_fallback(path)
        if trace:
            _step(
                "sc2reader_loaded",
                load_ms=int((time.monotonic() - t_load) * 1000),
                map_name=str(getattr(replay, "map_name", "") or ""),
            )
    except Exception as exc:  # noqa: BLE001
        code = _classify_load_failure(exc)
        return _err(code, f"sc2reader load failed: {exc}")

    humans = [p for p in getattr(replay, "players", []) if _is_human(p)]
    if len(humans) < 2:
        return _err(
            "no_two_humans",
            "this demo only handles 1v1 replays with two human players.",
        )
    p1, p2 = humans[0], humans[1]

    try:
        t_walk = time.monotonic()
        bucketed = _walk_events(replay)
        if trace:
            _step(
                "events_walked",
                walk_ms=int((time.monotonic() - t_walk) * 1000),
                pids=list(bucketed.keys()),
                event_counts={str(k): len(v) for k, v in bucketed.items()},
            )
    except Exception as exc:  # noqa: BLE001
        return _err("extract_failed", f"event walk failed: {exc}")

    p1_events = bucketed.get(getattr(p1, "pid", -1), [])
    p2_events = bucketed.get(getattr(p2, "pid", -2), [])

    map_name = str(getattr(replay, "map_name", "") or "")
    length_sec = 0
    gl = getattr(replay, "game_length", None)
    if gl is not None and getattr(gl, "seconds", None) is not None:
        try:
            length_sec = int(gl.seconds)
        except Exception:  # noqa: BLE001
            length_sec = 0
    date_str = ""
    if getattr(replay, "date", None) is not None:
        try:
            date_str = replay.date.isoformat()
        except Exception:  # noqa: BLE001
            date_str = ""

    game_id = f"{date_str}|{_player_name(p2)}|{map_name}|{length_sec}"

    payload: Dict[str, Any] = {
        "ok": True,
        "game_id": game_id,
        "map": map_name,
        "duration_sec": length_sec,
        "date": date_str,
        "players": [
            {
                "name": _player_name(p1),
                "race": _race(p1),
                "result": _result(p1),
                "handle": _player_handle(p1),
                "build_log": _format_build_log(p1_events),
            },
            {
                "name": _player_name(p2),
                "race": _race(p2),
                "result": _result(p2),
                "handle": _player_handle(p2),
                "build_log": _format_build_log(p2_events),
            },
        ],
    }
    if trace:
        payload["total_ms"] = int((time.monotonic() - t0) * 1000)
    _emit(payload)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Preview a single replay.")
    parser.add_argument("--file", help="Path to .SC2Replay")
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Emit a Python environment / sc2reader-version report and exit.",
    )
    parser.add_argument(
        "--trace",
        action="store_true",
        help=(
            "Emit per-step NDJSON markers in addition to the final result. "
            "The route forwards these to the server log for diagnostics."
        ),
    )
    args = parser.parse_args()

    # Top-level safety net: catch BaseException so even SystemExit from
    # deep in a transitive dep can't surface as a Python crash.
    try:
        if args.self_test:
            return _self_test()
        if not args.file:
            return _err("missing_arg", "either --file or --self-test is required")
        return _run(args.file, trace=bool(args.trace))
    except BaseException as exc:  # noqa: BLE001
        kind = type(exc).__name__
        return _err("python_error", f"{kind}: {exc}")


if __name__ == "__main__":
    sys.exit(main())
