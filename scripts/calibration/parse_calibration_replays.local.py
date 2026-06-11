"""Parse calibration replays through the production replay engine.

Drives ``apps/replay-engine``'s real pipeline (``parse_deep`` →
``extract_events`` → ``UserBuildDetector.detect_my_build``) over every
replay in ``calibration-replays/`` and emits one JSON line per replay
with everything the optimizer calibration needs:

  - metadata: file, date, map, release_string, sc2 build number,
    matchup, result, opponent
  - the production detector's build label (``my_build``)
  - the supply-stamped opening (first OPENING_WINDOW_S real seconds of
    buildings / units / upgrades, stamped with food_used from
    PlayerStatsEvent)
  - every chrono boost cast (real seconds + target building name,
    resolved through the tracker's unit ids at cast time)

No detection logic is re-implemented here: labels come from
``detect_my_build`` exactly as the production analyzer would emit them.
Timebase: ``core.timebase.event_seconds`` (frame / inferred fps; LotV
22.4), the same conversion pinned by
``apps/replay-engine/tests/test_timebase.py``.

Usage:
    python3 scripts/calibration/parse_calibration_replays.py \
        [--replays DIR] [--out FILE] [--handle ReSpOnSe] [--procs N]
"""

from __future__ import annotations

import argparse
import json
import multiprocessing
import os
import sys
import traceback

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(os.path.dirname(_HERE))
_ENGINE = os.path.join(_REPO, "apps", "replay-engine")
if _ENGINE not in sys.path:
    sys.path.insert(0, _ENGINE)

OPENING_WINDOW_S = 360  # first 6 minutes, real seconds
CHRONO_WINDOW_S = 480   # keep chrono casts a little past the opening


def _supply_at(stats_events, t):
    """food_used from the most recent PlayerStatsEvent at/before ``t``."""
    supply = None
    for ev in stats_events:
        if ev["time"] > t:
            break
        supply = ev.get("food_used")
    return supply


def _building_uid_history(replay, my_pid):
    """uid → [(time, name), ...] for the player's tracker units.

    Pure bookkeeping (no classification): UnitInit / UnitBorn /
    UnitTypeChange events give every unit id a name TIMELINE so a chrono
    cast resolves to what the building was AT CAST TIME (a Gateway that
    later transforms to WarpGate must not retro-label early casts).
    """
    from core.timebase import event_seconds

    hist = {}
    for event in getattr(replay, "tracker_events", []):
        cls = type(event).__name__
        if cls in ("UnitInitEvent", "UnitBornEvent"):
            pid = getattr(event, "control_pid", None)
            if pid is None:
                unit = getattr(event, "unit", None)
                owner = getattr(unit, "owner", None) if unit else None
                pid = getattr(owner, "pid", None)
            if pid != my_pid:
                continue
            uid = getattr(event, "unit_id", None)
            name = getattr(event, "unit_type_name", None)
            if uid is not None and name:
                hist.setdefault(uid, []).append((event_seconds(event, replay), name))
        elif cls == "UnitTypeChangeEvent":
            uid = getattr(event, "unit_id", None)
            name = getattr(event, "unit_type_name", None)
            if uid in hist and name:
                hist[uid].append((event_seconds(event, replay), name))
    return hist


def _name_at(hist, uid, t):
    """Name of unit ``uid`` at time ``t`` from a ``_building_uid_history`` map."""
    entries = hist.get(uid)
    if not entries:
        return "Unknown"
    name = entries[0][1]
    for et, en in entries:
        if et > t:
            break
        name = en
    return name


def parse_one(path):
    """Parse one replay; returns a result dict or an error dict."""
    from core.event_extractor import extract_macro_events
    from core.sc2_replay_parser import parse_deep

    handle = parse_one.handle  # set by pool initializer
    base = os.path.basename(path)
    try:
        ctx = parse_deep(path, handle)
        if ctx.is_ai_game:
            return {"file": base, "skip": "ai_game"}
        if not ctx.me or not ctx.opponent:
            return {"file": base, "skip": "player_not_found"}

        replay = ctx.raw
        release = getattr(replay, "release_string", "")
        build_num = getattr(replay, "build", 0)

        macro = extract_macro_events(replay, ctx.me.pid)
        stats_events = macro.get("stats_events", [])

        opening = []
        for e in sorted(ctx.my_events, key=lambda x: x.get("time", 0)):
            t = e.get("time", 0)
            if t > OPENING_WINDOW_S:
                break
            opening.append({
                "type": e.get("type"),
                "name": e.get("name"),
                "time": t,
                "supply": _supply_at(stats_events, t),
            })

        uid_hist = _building_uid_history(replay, ctx.me.pid)
        chronos = []
        for ev in macro.get("ability_events", []):
            if ev.get("category") != "chrono":
                continue
            t = ev.get("time", 0)
            if t > CHRONO_WINDOW_S:
                continue
            target_uid = ev.get("target_unit_id") or 0
            chronos.append({
                "time": t,
                "target": _name_at(uid_hist, target_uid, t),
            })

        return {
            "file": base,
            "date": ctx.date_iso,
            "map": ctx.map_name,
            "release": release,
            "build_num": build_num,
            "length_s": ctx.length_seconds,
            "me": ctx.me.name,
            "my_race": ctx.me.race,
            "opponent": ctx.opponent.name,
            "opp_race": ctx.opp_race if hasattr(ctx, "opp_race") else ctx.opponent.race,
            "result": ctx.me.result,
            "my_build": ctx.my_build,
            "opp_strategy": ctx.opp_strategy,
            "opening": opening,
            "chronos": chronos,
        }
    except Exception as exc:  # noqa: BLE001 - bulk job must survive bad files
        return {
            "file": base,
            "error": f"{type(exc).__name__}: {exc}",
            "trace": traceback.format_exc(limit=3),
        }

def _init_worker(handle):
    parse_one.handle = handle


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--replays", default=os.path.join(_REPO, "calibration-replays"))
    ap.add_argument("--out", default=os.path.join(_REPO, "calibration-replays", "parsed.jsonl"))
    ap.add_argument("--handle", default="ReSpOnSe")
    ap.add_argument("--procs", type=int, default=2)
    args = ap.parse_args()

    files = sorted(
        os.path.join(args.replays, f)
        for f in os.listdir(args.replays)
        if f.lower().endswith(".sc2replay")
    )
    done = set()
    if os.path.exists(args.out):
        with open(args.out, encoding="utf-8") as fh:
            for line in fh:
                try:
                    done.add(json.loads(line)["file"])
                except Exception:  # noqa: BLE001
                    pass
    todo = [f for f in files if os.path.basename(f) not in done]
    print(f"{len(files)} replays, {len(done)} done, {len(todo)} to go", flush=True)

    with multiprocessing.Pool(args.procs, initializer=_init_worker, initargs=(args.handle,)) as pool:
        with open(args.out, "a", encoding="utf-8") as fh:
            for i, res in enumerate(pool.imap_unordered(parse_one, todo, chunksize=4)):
                fh.write(json.dumps(res) + "\n")
                fh.flush()
                if (i + 1) % 25 == 0:
                    print(f"  {i + 1}/{len(todo)}", flush=True)
    print("done", flush=True)


if __name__ == "__main__":
    main()
