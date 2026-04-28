"""APM / SPM curve CLI used by the analyzer's /games/:id/apm-curve endpoint.

Subcommand
----------

    compute --replay PATH [--player NAME] [--window-sec N]

Walks ``replay.events`` once and counts ``CommandEvent``,
``SelectionEvent`` and ``ControlGroupEvent`` timestamps per second per
player. From those raw per-second counts it derives a sliding-window
APM (CommandEvents) and SPM (SelectionEvent + ControlGroupEvent) curve
sampled at every game second.

Output is one newline-delimited JSON record on stdout::

    {
      "ok": true,
      "game_length_sec": 812,
      "window_sec": 30,
      "players": [
        {"pid": 1, "name": "Foo", "race": "Protoss",
         "apm": [...], "spm": [...]},
        ...
      ]
    }

When the replay has no command/selection/control-group events at all
(corrupt / truncated stream) the CLI still exits 0 with
``{"ok": true, "players": [...empty curves...]}`` so the SPA can render
"Activity data unavailable" instead of erroring.

Exit codes mirror ``macro_cli.py``: 0 on success, 1 on usage error,
2 on runtime error. The CLI never prints to stderr unless something is
genuinely wrong, so the Node side can pipe stdout straight into a JSON
parser.

Example::

    python scripts/apm_cli.py compute \
        --replay path/to/foo.SC2Replay --window-sec 30
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, List, Optional, Tuple

# Project root on sys.path so 'core' imports.
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

# --- Constants --------------------------------------------------------
DEFAULT_WINDOW_SEC = 30
SECONDS_PER_MINUTE = 60
COMMAND_EVENT_NAME = "CommandEvent"
SELECTION_EVENT_NAME = "SelectionEvent"
CONTROL_GROUP_EVENT_NAME = "ControlGroupEvent"
# sc2reader attaches a number of subclasses; we count anything whose
# class hierarchy includes one of these base names.
_COMMAND_EVENT_NAMES = frozenset({
    COMMAND_EVENT_NAME, "TargetUnitCommandEvent",
    "TargetPointCommandEvent", "BasicCommandEvent", "DataCommandEvent",
    "UpdateTargetPointCommandEvent", "UpdateTargetUnitCommandEvent",
    "CmdEvent",
})
_SELECTION_EVENT_NAMES = frozenset({SELECTION_EVENT_NAME})
_CONTROL_GROUP_EVENT_NAMES = frozenset({
    CONTROL_GROUP_EVENT_NAME, "SetControlGroupEvent",
    "AddToControlGroupEvent", "GetControlGroupEvent",
    "ControlGroupUpdateEvent",
})


def _eprint(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _emit(obj: Dict[str, Any]) -> None:
    """Write one newline-delimited JSON record to stdout."""
    sys.stdout.write(json.dumps(obj, default=str) + "\n")
    sys.stdout.flush()


def _classify_event(event: Any) -> Optional[str]:
    """Return 'cmd' / 'sel' / 'ctrl' for relevant events, else None.

    Walks the class MRO so subclasses (TargetUnitCommandEvent,
    SetControlGroupEvent, ...) are caught. Returning None for everything
    else is what keeps the per-second walk cheap on long replays.
    """
    cls = type(event)
    for base in cls.__mro__:
        name = base.__name__
        if name in _COMMAND_EVENT_NAMES:
            return "cmd"
        if name in _SELECTION_EVENT_NAMES:
            return "sel"
        if name in _CONTROL_GROUP_EVENT_NAMES:
            return "ctrl"
    return None


def _resolve_pid(event: Any) -> Optional[int]:
    """Return the canonical 1-indexed Player.pid for this event, or None.

    sc2reader's ``event.pid`` is the *0-indexed* protocol ``user_id`` and
    can legitimately be 0 for the opponent in some replay formats. The
    canonical attribution is on ``event.player.pid``. Prefer that, fall
    back to ``event.pid`` only when the player object is missing.
    """
    player = getattr(event, "player", None)
    if player is not None:
        ppid = getattr(player, "pid", None)
        if isinstance(ppid, int) and ppid > 0:
            return ppid
    pid = getattr(event, "pid", None)
    if isinstance(pid, int) and pid > 0:
        return pid
    return None


def _per_second_counts(replay) -> Tuple[int, Dict[int, Dict[str, List[int]]]]:
    """Walk replay.events once; bucket cmd/sel/ctrl counts per second per pid.

    Returns ``(game_length_sec, counts)`` where ``counts[pid]`` has three
    parallel arrays (``cmd``, ``sel``, ``ctrl``) of length
    ``game_length_sec + 1``.
    """
    gl = getattr(replay, "game_length", None)
    length_sec = int(gl.seconds) if gl is not None and hasattr(gl, "seconds") else 0
    counts: Dict[int, Dict[str, List[int]]] = {}
    for event in getattr(replay, "events", None) or []:
        kind = _classify_event(event)
        if kind is None:
            continue
        pid = _resolve_pid(event)
        if pid is None:
            continue
        sec = int(getattr(event, "second", 0) or 0)
        if sec < 0:
            continue
        if sec > length_sec:
            length_sec = sec
        bucket = counts.get(pid)
        if bucket is None:
            bucket = {"cmd": [], "sel": [], "ctrl": []}
            counts[pid] = bucket
        for key in ("cmd", "sel", "ctrl"):
            arr = bucket[key]
            if sec >= len(arr):
                arr.extend([0] * (sec - len(arr) + 1))
            if key == kind:
                arr[sec] += 1
    _pad_counts(counts, length_sec)
    return length_sec, counts


def _pad_counts(counts: Dict[int, Dict[str, List[int]]], length_sec: int) -> None:
    """Right-pad every array so all curves share length ``length_sec + 1``."""
    target = length_sec + 1
    for bucket in counts.values():
        for key in ("cmd", "sel", "ctrl"):
            arr = bucket[key]
            if len(arr) < target:
                arr.extend([0] * (target - len(arr)))


def _sliding_per_minute(per_sec: List[int], window_sec: int) -> List[float]:
    """Return per-second sliding-window per-minute rate over ``per_sec``.

    Uses a rolling sum so this is O(n) — important for 60-min replays
    that have ~3600 samples.
    """
    out: List[float] = [0.0] * len(per_sec)
    if not per_sec:
        return out
    rolling = 0
    for i, count in enumerate(per_sec):
        rolling += count
        if i >= window_sec:
            rolling -= per_sec[i - window_sec]
        span = min(i + 1, window_sec)
        out[i] = round(rolling * SECONDS_PER_MINUTE / span, 2)
    return out


def _player_payload(player: Any, bucket: Dict[str, List[int]],
                    window_sec: int) -> Dict[str, Any]:
    """Build one player's APM/SPM curve dict for the JSON response."""
    cmd = bucket.get("cmd") or []
    sel = bucket.get("sel") or []
    ctrl = bucket.get("ctrl") or []
    spm_input = [s + c for s, c in zip(sel, ctrl)]
    return {
        "pid": getattr(player, "pid", None),
        "name": getattr(player, "name", "") or "",
        "race": getattr(player, "play_race", "") or "",
        "is_human": bool(getattr(player, "is_human", False)),
        "apm": _sliding_per_minute(cmd, window_sec),
        "spm": _sliding_per_minute(spm_input, window_sec),
    }


def _build_payload(replay, window_sec: int) -> Dict[str, Any]:
    """Compute the full per-replay APM/SPM payload."""
    length_sec, counts = _per_second_counts(replay)
    players_out: List[Dict[str, Any]] = []
    for player in getattr(replay, "players", None) or []:
        if getattr(player, "is_observer", False):
            continue
        if getattr(player, "is_referee", False):
            continue
        pid = getattr(player, "pid", None)
        bucket = counts.get(pid) or {"cmd": [], "sel": [], "ctrl": []}
        # Pad this player's bucket too in case they had zero events.
        for key in ("cmd", "sel", "ctrl"):
            if len(bucket[key]) < length_sec + 1:
                bucket[key] = bucket[key] + [0] * (length_sec + 1 - len(bucket[key]))
        players_out.append(_player_payload(player, bucket, window_sec))
    has_any_events = any(
        any(p["apm"]) or any(p["spm"]) for p in players_out
    )
    return {
        "ok": True,
        "game_length_sec": length_sec,
        "window_sec": window_sec,
        "has_data": bool(has_any_events),
        "players": players_out,
    }


def cmd_compute(args) -> int:
    if not args.replay or not os.path.isfile(args.replay):
        _emit({"ok": False, "error": "replay file not found"})
        return 2
    window_sec = int(args.window_sec or DEFAULT_WINDOW_SEC)
    if window_sec < 1:
        _emit({"ok": False, "error": "window-sec must be >= 1"})
        return 1
    try:
        from core.replay_loader import load_replay_with_fallback
        replay = load_replay_with_fallback(args.replay)
        payload = _build_payload(replay, window_sec)
        _emit(payload)
        return 0
    except Exception as exc:  # pragma: no cover
        _emit({"ok": False, "error": str(exc)})
        return 2


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="apm_cli",
        description="APM / SPM sliding-window curve CLI for the SPA backend.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_compute = sub.add_parser("compute", help="Compute APM/SPM curves.")
    p_compute.add_argument("--replay", required=True,
                           help="Path to .SC2Replay file.")
    p_compute.add_argument("--player", default="",
                           help="Reserved for parity with macro_cli; ignored "
                                "(both players are always returned).")
    p_compute.add_argument("--window-sec", type=int,
                           default=DEFAULT_WINDOW_SEC,
                           help="Sliding-window length in seconds (default 30).")
    p_compute.set_defaults(func=cmd_compute)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        return 130
    except Exception as exc:  # pragma: no cover
        _emit({"ok": False, "error": f"runtime error: {exc}"})
        return 2


if __name__ == "__main__":
    sys.exit(main())
