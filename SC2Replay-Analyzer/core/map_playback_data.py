"""Headless data layer for the map playback viewer.

The desktop UI (`ui/map_viewer.py`) and the web UI (`web_analyzer.py`)
both consume the same shape, so the parsing / centroid / battle-detection
logic lives here without any Tk dependency. Importing this module from a
headless Flask process must not require tkinter or customtkinter.
"""

from __future__ import annotations

import bisect
import json
import os
from typing import Dict, List, Optional, Tuple

from .paths import APP_DIR
from .replay_loader import load_replay_with_fallback
from .event_extractor import PlayerStatsEvent, extract_events


DEFAULT_BOUNDS = {
    "x_min": 0,
    "x_max": 200,
    "y_min": 0,
    "y_max": 200,
    "starting_locations": [],
}

BATTLE_WINDOW_SEC = 10
BATTLE_DIFF_THRESHOLD = 500

_BOUNDS_CACHE: Optional[Dict] = None


def load_map_bounds_table() -> Dict:
    """Read ``data/map_bounds.json`` once per process and cache it."""
    global _BOUNDS_CACHE
    if _BOUNDS_CACHE is not None:
        return _BOUNDS_CACHE
    path = os.path.join(APP_DIR, "data", "map_bounds.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            _BOUNDS_CACHE = json.load(f)
    except Exception:
        _BOUNDS_CACHE = {}
    return _BOUNDS_CACHE


def bounds_for(map_name: Optional[str], events: List[Dict]) -> Dict:
    """Resolve playable bounds for a map name with a graceful fallback chain."""
    table = load_map_bounds_table() or {}
    entry = table.get(map_name) if map_name else None
    if entry is None:
        entry = table.get("_default", DEFAULT_BOUNDS)

    bounds = {
        "x_min": float(entry.get("x_min", 0)),
        "x_max": float(entry.get("x_max", 200)),
        "y_min": float(entry.get("y_min", 0)),
        "y_max": float(entry.get("y_max", 200)),
        "starting_locations": list(entry.get("starting_locations", []) or []),
    }

    xs = [e["x"] for e in events if e.get("x")]
    ys = [e["y"] for e in events if e.get("y")]
    if xs and ys:
        bounds["x_min"] = min(bounds["x_min"], min(xs) - 4)
        bounds["x_max"] = max(bounds["x_max"], max(xs) + 4)
        bounds["y_min"] = min(bounds["y_min"], min(ys) - 4)
        bounds["y_max"] = max(bounds["y_max"], max(ys) + 4)
    return bounds


def interp(stats: List[Dict], t: float, key: str) -> float:
    """Linearly interpolate ``key`` from a sorted-by-time stats list."""
    if not stats:
        return 0.0
    times = [s["time"] for s in stats]
    if t <= times[0]:
        return float(stats[0][key])
    if t >= times[-1]:
        return float(stats[-1][key])
    i = bisect.bisect_left(times, t)
    a, b = stats[i - 1], stats[i]
    span = max(1e-9, (b["time"] - a["time"]))
    frac = (t - a["time"]) / span
    return float(a[key] + (b[key] - a[key]) * frac)


def centroid(events: List[Dict], t: float, window: float = 60.0) -> Optional[Tuple[float, float]]:
    """Centroid of the events whose ``time`` falls in (t - window, t]."""
    lo = t - window
    xs, ys = [], []
    for e in events:
        et = e.get("time", 0)
        if et > t:
            break
        if et < lo:
            continue
        x = e.get("x")
        y = e.get("y")
        if x and y:
            xs.append(x)
            ys.append(y)
    if not xs:
        return None
    return sum(xs) / len(xs), sum(ys) / len(ys)


def detect_battle_markers(
    my_stats: List[Dict],
    opp_stats: List[Dict],
    my_events: List[Dict],
    opp_events: List[Dict],
    game_length: float,
) -> List[Dict]:
    """Return [{time, x, y, side}] for army-value-diff swings > threshold."""
    if not my_stats or not opp_stats:
        return []
    times = sorted(
        {int(s["time"]) for s in my_stats}
        | {int(s["time"]) for s in opp_stats}
    )
    diffs = [
        interp(my_stats, t, "army_val") - interp(opp_stats, t, "army_val")
        for t in times
    ]
    markers: List[Dict] = []
    last_marker_t = -BATTLE_WINDOW_SEC
    for i, t in enumerate(times):
        j = bisect.bisect_left(times, t - BATTLE_WINDOW_SEC)
        if j >= i:
            continue
        swing = diffs[j] - diffs[i]
        if abs(swing) < BATTLE_DIFF_THRESHOLD:
            continue
        if t - last_marker_t < BATTLE_WINDOW_SEC:
            continue
        mid = (times[j] + t) / 2.0
        c_me = centroid(my_events, mid)
        c_opp = centroid(opp_events, mid)
        if c_me and c_opp:
            x, y = (c_me[0] + c_opp[0]) / 2.0, (c_me[1] + c_opp[1]) / 2.0
        elif c_me:
            x, y = c_me
        elif c_opp:
            x, y = c_opp
        else:
            continue
        side = "me" if swing < 0 else "opp"
        markers.append({"time": float(mid), "x": x, "y": y, "side": side})
        last_marker_t = t
    return [m for m in markers if 0 <= m["time"] <= game_length]


def build_playback_data(file_path: str, player_name: str) -> Optional[Dict]:
    """Walk the replay once and produce all data the viewer needs."""
    try:
        replay = load_replay_with_fallback(file_path)
    except Exception as exc:
        print(f"map_playback: failed to load replay {file_path}: {exc}")
        return None

    me, opp = None, None
    for p in replay.players:
        if p.name == player_name:
            me = p
        elif (not getattr(p, "is_observer", False)
              and not getattr(p, "is_referee", False)):
            opp = p
    if me is None or opp is None:
        return None

    my_events, opp_events, _ = extract_events(replay, me.pid)

    stats_by_pid: Dict[int, List[Dict]] = {me.pid: [], opp.pid: []}
    try:
        for e in replay.tracker_events:
            if not isinstance(e, PlayerStatsEvent):
                continue
            pid = getattr(e, "pid", None)
            if pid is None:
                pid = getattr(getattr(e, "player", None), "pid", None)
            if pid not in stats_by_pid:
                continue
            army_val = (
                getattr(e, "minerals_used_active_forces",
                        getattr(e, "minerals_used_current_army", 0))
                + getattr(e, "vespene_used_active_forces",
                          getattr(e, "vespene_used_current_army", 0))
            )
            stats_by_pid[pid].append({
                "time": float(e.second),
                "army_val": float(army_val),
            })
    except Exception:
        pass
    for arr in stats_by_pid.values():
        arr.sort(key=lambda s: s["time"])

    gl = getattr(replay, "game_length", None)
    game_length = float(gl.seconds) if gl else 0.0
    if not game_length:
        last_ts = []
        for src in (my_events, opp_events,
                    stats_by_pid[me.pid], stats_by_pid[opp.pid]):
            if src:
                last_ts.append(src[-1].get("time", 0))
        game_length = max(last_ts) if last_ts else 600.0

    sorted_my_events = sorted(my_events, key=lambda e: e.get("time", 0))
    sorted_opp_events = sorted(opp_events, key=lambda e: e.get("time", 0))

    bounds = bounds_for(getattr(replay, "map_name", None), sorted_my_events + sorted_opp_events)

    return {
        "map_name": getattr(replay, "map_name", None),
        "game_length": game_length,
        "bounds": bounds,
        "me_name": me.name,
        "opp_name": opp.name,
        "result": me.result,
        "my_events": sorted_my_events,
        "opp_events": sorted_opp_events,
        "my_stats": stats_by_pid[me.pid],
        "opp_stats": stats_by_pid[opp.pid],
    }
