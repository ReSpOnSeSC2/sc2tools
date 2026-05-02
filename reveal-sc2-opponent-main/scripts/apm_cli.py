"""apm_cli -- per-player APM/SPM curve over a single replay.

Spawned by the Express overlay backend at
``analyzer.js -> /games/:id/apm-curve`` to populate the activity
charts in the analyzer game-detail drawer.

Output contract
---------------
On success (single ndjson record, exit 0)::

    {"ok": true,
     "game_length_sec": <int>,
     "window_sec": 30,
     "has_data": <bool>,
     "players": [
        {"pid": <int>, "name": <str>, "race": <str>,
         "apm": [<float>, ...], "spm": [<float>, ...]},
        ...
     ]}

On failure (single ndjson record, exit 1)::

    {"ok": false, "error": "<reason>"}

APM = sc2reader CommandEvent count per minute.
SPM = SelectionEvent + ControlGroup* event count per minute.
Both reported as a 30s sliding window, sampled once per second from
``t = 0`` through ``t = game_length_sec``.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from typing import Any, Dict, List, Optional

# Allow running as ``python scripts/apm_cli.py`` from project root.
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.dirname(_THIS_DIR)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from core.sc2_replay_parser import _load_replay  # noqa: E402

# sc2reader event-class imports are best-effort: classes are present in
# every published version that the toolkit supports, but a stale dev
# install or a future rename should degrade gracefully (empty curve)
# instead of crashing the whole drawer.
try:
    from sc2reader.events.game import CommandEvent  # type: ignore
except Exception:
    CommandEvent = None  # type: ignore

try:
    from sc2reader.events.game import SelectionEvent  # type: ignore
except Exception:
    SelectionEvent = None  # type: ignore

try:
    from sc2reader.events.game import ControlGroupEvent  # type: ignore
    _CG_BASE = ControlGroupEvent
except Exception:
    _CG_BASE = None


# 30s window matches the Node side's default and the convention every
# SC2 stats site uses (sc2replaystats, GGTracker). Don't tune unless
# you also update analyzer.js's `r.window_sec || 30` fallback.
WINDOW_SEC: int = 30

# sc2reader frames-per-second for "Faster" game speed. Used when an
# event lacks ``second`` but does carry ``frame``.
SC2_FRAMES_PER_SEC: float = 22.4


def _emit(obj: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _is_control_group_event(ev) -> bool:
    if _CG_BASE is not None and isinstance(ev, _CG_BASE):
        return True
    return "ControlGroup" in type(ev).__name__


def _event_pid(ev) -> Optional[int]:
    pid = getattr(ev, "pid", None)
    if pid is not None:
        return pid
    p = getattr(ev, "player", None)
    return getattr(p, "pid", None) if p is not None else None


def _event_second(ev) -> Optional[int]:
    sec = getattr(ev, "second", None)
    if sec is not None:
        try:
            return int(sec)
        except (TypeError, ValueError):
            return None
    frame = getattr(ev, "frame", None)
    if frame is None:
        return None
    try:
        return int(int(frame) / SC2_FRAMES_PER_SEC)
    except (TypeError, ValueError):
        return None


def _sliding_window(per_sec: List[int], game_len: int, window: int) -> List[float]:
    """Return per-second event-rate samples over the game.

    For each second ``t`` in ``[0, game_len]``, sum events in the window
    ``(t - window, t]`` and convert to a per-minute rate. The result is
    one float per second, length ``game_len + 1``.
    """
    if game_len <= 0:
        return []
    out: List[float] = []
    running = 0
    for t in range(game_len + 1):
        if 0 <= t < len(per_sec):
            running += per_sec[t]
        drop = t - window
        if 0 <= drop < len(per_sec):
            running -= per_sec[drop]
        out.append(round(running * 60.0 / max(1, window), 1))
    return out


def _cmd_compute(args: argparse.Namespace) -> int:
    if not args.replay or not os.path.exists(args.replay):
        _emit({"ok": False, "error": f"replay file not found: {args.replay}"})
        return 1

    try:
        replay = _load_replay(args.replay, load_level=4)
    except Exception as exc:
        _emit({"ok": False, "error": f"sc2reader load failed: {exc}"})
        return 1

    gl = getattr(replay, "game_length", None)
    game_len = int(gl.seconds) if gl is not None and hasattr(gl, "seconds") else 0

    humans = []
    by_pid_apm: Dict[int, List[int]] = {}
    by_pid_spm: Dict[int, List[int]] = {}
    for p in getattr(replay, "players", []) or []:
        if not getattr(p, "is_human", True):
            continue
        if getattr(p, "is_observer", False):
            continue
        pid = getattr(p, "pid", None)
        if pid is None:
            continue
        humans.append(p)
        by_pid_apm[pid] = [0] * (game_len + 1)
        by_pid_spm[pid] = [0] * (game_len + 1)

    if not humans or game_len <= 0:
        _emit({
            "ok": True,
            "game_length_sec": game_len,
            "window_sec": WINDOW_SEC,
            "has_data": False,
            "players": [],
        })
        return 0

    saw_any = False
    events = getattr(replay, "events", None) or []
    for ev in events:
        sec = _event_second(ev)
        if sec is None or sec < 0 or sec > game_len:
            continue
        pid = _event_pid(ev)
        if pid is None or pid not in by_pid_apm:
            continue
        is_cmd = CommandEvent is not None and isinstance(ev, CommandEvent)
        is_sel = SelectionEvent is not None and isinstance(ev, SelectionEvent)
        is_cg = _is_control_group_event(ev)
        if not (is_cmd or is_sel or is_cg):
            continue
        if is_cmd:
            by_pid_apm[pid][sec] += 1
        if is_sel or is_cg:
            by_pid_spm[pid][sec] += 1
        saw_any = True

    out_players: List[Dict[str, Any]] = []
    for p in humans:
        pid = p.pid
        out_players.append({
            "pid": pid,
            "name": getattr(p, "name", "") or "",
            "race": getattr(p, "play_race", "") or "",
            "apm": _sliding_window(by_pid_apm[pid], game_len, WINDOW_SEC),
            "spm": _sliding_window(by_pid_spm[pid], game_len, WINDOW_SEC),
        })

    _emit({
        "ok": True,
        "game_length_sec": game_len,
        "window_sec": WINDOW_SEC,
        "has_data": bool(saw_any),
        "players": out_players,
    })
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(prog="apm_cli")
    sub = p.add_subparsers(dest="cmd", required=True)

    cp = sub.add_parser(
        "compute",
        help="Walk replay.events and emit per-second APM/SPM curves.",
    )
    cp.add_argument("--replay", required=True, help="Path to .SC2Replay.")

    args = p.parse_args(argv)
    if args.cmd == "compute":
        return _cmd_compute(args)
    p.error(f"unknown subcommand: {args.cmd}")
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:
        _emit({"ok": False, "error": f"fatal: {exc}"})
        traceback.print_exc(file=sys.stderr)
        sys.exit(3)
