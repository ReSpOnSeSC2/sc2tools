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
from .event_extractor import PlayerStatsEvent, extract_events, extract_unit_tracks


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


def _read_mapinfo_bounds(replay):
    """Lift the playable rectangle from the replay's MPQ MapInfo file.

    Battle.net ships every melee map with a MapInfo binary inside the
    map MPQ archive. Its header carries both the FULL map dimensions
    (the "small" rect, including non-playable border) and the PLAYABLE
    rectangle (the "large" rect that actually matters for unit
    positions). We return the playable rect when it looks valid,
    otherwise the full rect, otherwise ``None`` so the caller can fall
    back to event-derived bounds.

    Returns ``(x_min, x_max, y_min, y_max)`` or ``None``.

    Example:
        bounds = _read_mapinfo_bounds(replay) or (0, 200, 0, 200)
    """
    import struct
    map_obj = getattr(replay, "map", None)
    if map_obj is None:
        return None
    archive = getattr(map_obj, "archive", None)
    if archive is None:
        return None
    try:
        raw = archive.read_file("MapInfo")
    except Exception:
        return None
    if not raw or len(raw) < 48 or raw[:4] != b"MapI":
        return None
    try:
        # Header: <4s magic, I version, I width, I height,
        #          I sx0, I sy0, I sx1, I sy1,    # "small" rect
        #          I lx0, I ly0, I lx1, I ly1>    # "large" / playable
        head = raw[:48]
        unpacked = struct.unpack_from("<4sIIIIIIIIIII", head, 0)
        _magic, _ver, _w, _h = unpacked[0:4]
        sx0, sy0, sx1, sy1 = unpacked[4:8]
        lx0, ly0, lx1, ly1 = unpacked[8:12]
        if lx1 > lx0 and ly1 > ly0:
            return int(lx0), int(lx1), int(ly0), int(ly1)
        if sx1 > sx0 and sy1 > sy0:
            return int(sx0), int(sx1), int(sy0), int(sy1)
    except struct.error:
        return None
    return None


def _attr_bounds(replay):
    """Sc2reader-attribute fallback when MapInfo is unreadable."""
    map_obj = getattr(replay, "map", None)
    if map_obj is None:
        return None
    size = getattr(map_obj, "map_size", None)
    if size and len(size) == 2:
        w, h = size
        try:
            return 0, int(w), 0, int(h)
        except (TypeError, ValueError):
            return None
    return None


def bounds_for(map_name, events, replay=None):
    """Resolve playable bounds for a map name with a graceful fallback chain.

    * Per-map JSON entry: trust as authoritative; only EXPAND for events
      that spilled past the configured rect.
    * No entry: derive bounds tightly from event positions with a margin.
      The (0..200) _default is much wider than any real LE map, so using
      it caused unit positions to be projected into the wrong region of
      the Liquipedia minimap (the playable image gets stretched to bounds,
      so wide-bounds + tight-events => the spawn appears off-center).
    """
    table = load_map_bounds_table() or {}
    entry = table.get(map_name) if map_name else None

    xs = [e["x"] for e in events if e.get("x")]
    ys = [e["y"] for e in events if e.get("y")]
    have_events = bool(xs and ys)

    if entry is not None:
        bounds = {
            "x_min": float(entry.get("x_min", 0)),
            "x_max": float(entry.get("x_max", 200)),
            "y_min": float(entry.get("y_min", 0)),
            "y_max": float(entry.get("y_max", 200)),
            "starting_locations": list(entry.get("starting_locations", []) or []),
        }
        if have_events:
            bounds["x_min"] = min(bounds["x_min"], min(xs) - 4)
            bounds["x_max"] = max(bounds["x_max"], max(xs) + 4)
            bounds["y_min"] = min(bounds["y_min"], min(ys) - 4)
            bounds["y_max"] = max(bounds["y_max"], max(ys) + 4)
        return bounds

    # No explicit map_bounds.json entry. Try the replay's MPQ MapInfo
    # block FIRST so bounds match the actual playable rectangle the map
    # ships with -- this is how the spawn markers and the Liquipedia
    # minimap image stay aligned for every map automatically, no manual
    # curation in map_bounds.json required.
    mb = _read_mapinfo_bounds(replay) if replay is not None else None
    if mb is None and replay is not None:
        mb = _attr_bounds(replay)
    if mb is not None:
        x0, x1, y0, y1 = mb
        bounds = {
            "x_min": float(x0), "x_max": float(x1),
            "y_min": float(y0), "y_max": float(y1),
            "starting_locations": [],
        }
        if have_events:
            bounds["x_min"] = min(bounds["x_min"], min(xs) - 4)
            bounds["x_max"] = max(bounds["x_max"], max(xs) + 4)
            bounds["y_min"] = min(bounds["y_min"], min(ys) - 4)
            bounds["y_max"] = max(bounds["y_max"], max(ys) + 4)
        return bounds

    if have_events:
        margin = 8.0
        return {
            "x_min": min(xs) - margin,
            "x_max": max(xs) + margin,
            "y_min": min(ys) - margin,
            "y_max": max(ys) + margin,
            "starting_locations": [],
        }

    return {
        "x_min": 0, "x_max": 200, "y_min": 0, "y_max": 200,
        "starting_locations": [],
    }


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




# Maps each town-hall name to the race it belongs to. The very first one a
# player spawns is the authoritative starting location for that game in SC2
# cell coords.
_TOWNHALL_TYPES = {
    "Nexus", "Hatchery", "Lair", "Hive",
    "CommandCenter", "OrbitalCommand", "PlanetaryFortress",
}


def detect_spawn_locations(my_events: List[Dict], opp_events: List[Dict]) -> List[Dict]:
    """Return [{owner: 'me'|'opp', x, y}, ...] using each player's earliest
    town-hall placement as the spawn anchor. SC2 always spawns players with
    a single town hall already in place, so the earliest building event of
    that type is reliable. Empty list if neither player has one (corrupt
    replay or all-in maps with shared bases)."""
    out: List[Dict] = []
    for owner, evs in (("me", my_events), ("opp", opp_events)):
        first = None
        for e in sorted(evs, key=lambda r: r.get("time", 0)):
            if e.get("type") != "building":
                continue
            if e.get("name") not in _TOWNHALL_TYPES:
                continue
            x = e.get("x"); y = e.get("y")
            if not (x and y):
                continue
            first = (float(x), float(y))
            break
        if first is not None:
            out.append({"owner": owner, "x": first[0], "y": first[1]})
    return out


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
            # PlayerStatsEvent's killed/lost fields are CUMULATIVE
            # resource values:
            #   minerals_lost_army  + vespene_lost_army    -> resources of
            #     my own army units the opponent has killed (what I LOST)
            #   minerals_killed_army + vespene_killed_army -> resources of
            #     enemy army units I have killed (what I KILLED)
            # These let the viewer show army-efficiency live: a big
            # killed-vs-lost gap tells you who traded better.
            lost_min = int(getattr(e, "minerals_lost_army", 0) or 0)
            lost_gas = int(getattr(e, "vespene_lost_army", 0) or 0)
            killed_min = int(getattr(e, "minerals_killed_army", 0) or 0)
            killed_gas = int(getattr(e, "vespene_killed_army", 0) or 0)
            stats_by_pid[pid].append({
                "time": float(e.second),
                "army_val": float(army_val),
                "minerals": int(getattr(e, "minerals_current", 0) or 0),
                "vespene": int(getattr(e, "vespene_current", 0) or 0),
                "food_used": int(getattr(e, "food_used", 0) or 0),
                "food_made": int(getattr(e, "food_made", 0) or 0),
                "workers": int(getattr(e, "food_workers", 0) or 0),
                "lost": lost_min + lost_gas,
                "killed": killed_min + killed_gas,
            })
    except Exception:
        pass
    for arr in stats_by_pid.values():
        arr.sort(key=lambda s: s["time"])

    # game_length is computed below, after tracks are extracted.


    sorted_my_events = sorted(my_events, key=lambda e: e.get("time", 0))
    sorted_opp_events = sorted(opp_events, key=lambda e: e.get("time", 0))

    # Use building events (which never move and always sit inside the
    # playable area) for bounds derivation.
    building_events = [e for e in (sorted_my_events + sorted_opp_events) if e.get("type") == "building"]
    bounds_source = building_events or (sorted_my_events + sorted_opp_events)
    bounds = bounds_for(getattr(replay, "map_name", None),
                        bounds_source, replay=replay)

    # Detect actual spawn locations from the very first town hall per player.
    # These are reliable in SC2 cell coords and double as visual reference
    # markers on the playback canvas + a tighter bounds anchor below.
    spawn_locations = detect_spawn_locations(sorted_my_events, sorted_opp_events)
    if spawn_locations:
        # Always include the spawn coordinates inside the playable bounds.
        # This catches the case where building events were sparse near a
        # spawn and didn't extend the rect far enough.
        margin = 6.0
        sxs = [s["x"] for s in spawn_locations]
        sys_ = [s["y"] for s in spawn_locations]
        bounds["x_min"] = min(bounds["x_min"], min(sxs) - margin)
        bounds["x_max"] = max(bounds["x_max"], max(sxs) + margin)
        bounds["y_min"] = min(bounds["y_min"], min(sys_) - margin)
        bounds["y_max"] = max(bounds["y_max"], max(sys_) + margin)

    # Walk again specifically for unit movement tracks. Wrapped so a
    # corrupt replay doesn't kill the whole payload -- worst case we emit
    # empty unit lists and the viewer just shows buildings.
    try:
        tracks = extract_unit_tracks(replay, me.pid)
    except Exception as exc:
        print(f"map_playback: extract_unit_tracks failed: {exc}")
        tracks = {"my_units": [], "opp_units": []}

    # game_length: take the MAX of the reported length, the latest event
    # timestamp, and the latest unit waypoint / death timestamp. This
    # catches units born after the surrender (e.g. a Carrier warp-in
    # finishing 30s after the GG click) so they're visible in the bar.
    gl = getattr(replay, "game_length", None)
    game_length = float(gl.seconds) if gl else 0.0
    last_ts = []
    for src in (my_events, opp_events,
                stats_by_pid[me.pid], stats_by_pid[opp.pid]):
        if src:
            last_ts.append(src[-1].get("time", 0))
    for unit_list in (tracks.get("my_units") or [], tracks.get("opp_units") or []):
        for u in unit_list:
            wp = u.get("waypoints") or []
            if wp:
                # Last entry's time is at index len-3 (waypoints are flat
                # [t, x, y, t, x, y, ...]).
                last_ts.append(wp[-3])
            if u.get("died") is not None:
                last_ts.append(u["died"])
            if u.get("born") is not None:
                last_ts.append(u["born"])
    if last_ts:
        game_length = max(game_length, max(last_ts))
    if not game_length:
        game_length = 600.0

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
        "my_units": tracks.get("my_units", []),
        "opp_units": tracks.get("opp_units", []),
        "spawn_locations": spawn_locations,
    }
