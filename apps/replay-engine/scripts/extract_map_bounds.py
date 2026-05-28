"""One-time extractor: print map bounds + starting locations from a replay.

Usage:
    python scripts/extract_map_bounds.py path/to/replay.SC2Replay
    python scripts/extract_map_bounds.py path/to/replay.SC2Replay --json

The output is a JSON snippet ready to be pasted into ``data/map_bounds.json``.

The bounds are pulled in three layers, falling back gracefully:

1. ``replay.map.archive`` MPQ -> ``MapInfo`` file. This is the canonical
   playable area as Blizzard shipped the map. Parsed manually because
   sc2reader doesn't expose the bounds directly.
2. ``replay.map`` attributes (``map_size``, ``camera_left``, etc.) when the
   MapInfo file is missing or unreadable.
3. Empirical bounds derived from the actual unit positions in the replay's
   tracker stream. Always reported as a sanity check against (1).

Starting locations come from ``replay.players[i].team`` and ``replay.start_locations``
when available; otherwise the first town-hall born for each player is used.

This script is intentionally tolerant: a malformed MapInfo blob will not stop
the empirical fallback from producing usable bounds.
"""
from __future__ import annotations

import argparse
import json
import os
import struct
import sys
from typing import Dict, List, Optional, Tuple

# Make the project root importable so we can reuse load_replay_with_fallback.
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from core.replay_loader import load_replay_with_fallback  # noqa: E402
from core.event_extractor import (  # noqa: E402
    KNOWN_BUILDINGS,
    _clean_building_name,
    _get_owner_pid,
    _get_unit_type_name,
)

try:
    from sc2reader.events.tracker import (  # noqa: E402
        UnitBornEvent,
        UnitInitEvent,
    )
except ImportError:  # pragma: no cover
    print("sc2reader is required: pip install sc2reader", file=sys.stderr)
    sys.exit(1)


# --------------------------------------------------------------------- MapInfo
def _read_mapinfo_bounds(replay) -> Optional[Tuple[int, int, int, int]]:
    """Parse the MapInfo MPQ file for the playable rectangle.

    Returns ``(x_min, x_max, y_min, y_max)`` or ``None`` if unavailable.
    The MapInfo binary format starts with the magic ``MapI`` followed by a
    version int, then a few size/bounds blocks. The playable bounds we want
    are the second 4-tuple of uint32s after the magic+version header in the
    common layouts.
    """
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
    if not raw or len(raw) < 32 or raw[:4] != b"MapI":
        return None
    try:
        # Header layout (sufficient for bounds):
        #   4s     magic "MapI"
        #   I      version
        #   I I    width, height
        #   I I I I  small_x_min, small_y_min, small_x_max, small_y_max
        #   I I I I  large_x_min, large_y_min, large_x_max, large_y_max
        # We want the "large" (playable) rectangle.
        head = raw[:48]
        _magic, _ver, _w, _h, sx0, sy0, sx1, sy1, lx0, ly0, lx1, ly1 = (
            struct.unpack_from("<4sIIIIIIIIIII", head, 0)
        )
        # If the large rectangle looks degenerate, fall back to the small one.
        if lx1 > lx0 and ly1 > ly0:
            return int(lx0), int(lx1), int(ly0), int(ly1)
        if sx1 > sx0 and sy1 > sy0:
            return int(sx0), int(sx1), int(sy0), int(sy1)
    except struct.error:
        return None
    return None


def _attr_bounds(replay) -> Optional[Tuple[int, int, int, int]]:
    """Fall-back: pull bounds from sc2reader's parsed map object."""
    map_obj = getattr(replay, "map", None)
    if map_obj is None:
        return None
    size = getattr(map_obj, "map_size", None)
    if size and len(size) == 2:
        w, h = size
        return 0, int(w), 0, int(h)
    return None


def _empirical_bounds(replay) -> Tuple[int, int, int, int]:
    """Derive bounds from actual building positions in the tracker stream."""
    xs: List[int] = []
    ys: List[int] = []
    tracker = getattr(replay, "tracker_events", None) or []
    for evt in tracker:
        if not isinstance(evt, (UnitBornEvent, UnitInitEvent)):
            continue
        raw = _get_unit_type_name(evt)
        if not raw:
            continue
        clean = _clean_building_name(raw)
        if clean not in KNOWN_BUILDINGS:
            continue
        x = getattr(evt, "x", 0) or 0
        y = getattr(evt, "y", 0) or 0
        if x > 0 and y > 0:
            xs.append(x)
            ys.append(y)
    if not xs or not ys:
        return 0, 200, 0, 200
    # Pad by a few cells so units near the edge aren't clipped.
    pad = 8
    return (
        max(0, min(xs) - pad),
        max(xs) + pad,
        max(0, min(ys) - pad),
        max(ys) + pad,
    )


# ---------------------------------------------------------------- start locs
def _starting_locations(replay) -> List[List[float]]:
    """Best-effort start locations for the two players.

    Falls back to the first town-hall born for each player when sc2reader
    does not expose pre-game start coordinates.
    """
    out: Dict[int, Tuple[float, float]] = {}
    explicit = getattr(replay, "start_locations", None) or []
    for loc in explicit:
        try:
            x, y = float(loc[0]), float(loc[1])
            out.setdefault(len(out), (x, y))
        except Exception:
            continue
    if len(out) >= 2:
        return [[round(x, 1), round(y, 1)] for x, y in out.values()]

    # Fall back: walk tracker for the first town-hall per player.
    base_types = {
        "Hatchery", "Lair", "Hive", "Nexus",
        "CommandCenter", "OrbitalCommand", "PlanetaryFortress",
    }
    seen: Dict[int, Tuple[float, float]] = {}
    tracker = getattr(replay, "tracker_events", None) or []
    for evt in tracker:
        if not isinstance(evt, (UnitBornEvent, UnitInitEvent)):
            continue
        raw = _get_unit_type_name(evt)
        if not raw:
            continue
        clean = _clean_building_name(raw)
        if clean not in base_types:
            continue
        pid = _get_owner_pid(evt)
        if pid is None or pid in seen:
            continue
        x = getattr(evt, "x", 0) or 0
        y = getattr(evt, "y", 0) or 0
        if x > 0 and y > 0:
            seen[pid] = (float(x), float(y))
    return [[round(x, 1), round(y, 1)] for x, y in seen.values()]


# ----------------------------------------------------------------- entry
def extract(replay_path: str) -> Dict:
    replay = load_replay_with_fallback(replay_path)
    map_name = getattr(replay, "map_name", None) or "?"

    bounds = _read_mapinfo_bounds(replay) or _attr_bounds(replay)
    empirical = _empirical_bounds(replay)
    chosen = bounds or empirical
    x_min, x_max, y_min, y_max = chosen

    return {
        "map_name": map_name,
        "source": "MapInfo MPQ" if bounds else "empirical (unit positions)",
        "bounds": {
            "x_min": int(x_min),
            "x_max": int(x_max),
            "y_min": int(y_min),
            "y_max": int(y_max),
        },
        "empirical_bounds": {
            "x_min": int(empirical[0]),
            "x_max": int(empirical[1]),
            "y_min": int(empirical[2]),
            "y_max": int(empirical[3]),
        },
        "starting_locations": _starting_locations(replay),
    }


def _format_jsonsnippet(data: Dict) -> str:
    bounds = data["bounds"]
    starts = data["starting_locations"]
    return (
        f'  "{data["map_name"]}": {{\n'
        f'    "x_min": {bounds["x_min"]},\n'
        f'    "x_max": {bounds["x_max"]},\n'
        f'    "y_min": {bounds["y_min"]},\n'
        f'    "y_max": {bounds["y_max"]},\n'
        f'    "starting_locations": {json.dumps(starts)}\n'
        f'  }}'
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract SC2 map bounds.")
    parser.add_argument("replay", help="Path to a .SC2Replay file")
    parser.add_argument(
        "--json", action="store_true",
        help="Print only the JSON snippet (paste-ready).",
    )
    args = parser.parse_args()

    if not os.path.isfile(args.replay):
        print(f"Replay not found: {args.replay}", file=sys.stderr)
        return 2

    try:
        data = extract(args.replay)
    except Exception as exc:
        print(f"Extraction failed: {exc}", file=sys.stderr)
        return 1

    if args.json:
        print(_format_jsonsnippet(data))
        return 0

    print(f"Map:           {data['map_name']}")
    print(f"Bounds source: {data['source']}")
    b = data["bounds"]
    print(
        f"Bounds:        x=[{b['x_min']}, {b['x_max']}]  "
        f"y=[{b['y_min']}, {b['y_max']}]"
    )
    e = data["empirical_bounds"]
    print(
        f"Empirical:     x=[{e['x_min']}, {e['x_max']}]  "
        f"y=[{e['y_min']}, {e['y_max']}]  (sanity check)"
    )
    print(f"Start locs:    {data['starting_locations']}")
    print()
    print("--- JSON snippet for data/map_bounds.json ---")
    print(_format_jsonsnippet(data))
    return 0


if __name__ == "__main__":
    sys.exit(main())
