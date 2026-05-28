"""Dump a slim macroBreakdown fixture for the phaseClassifier Jest tests.

Walks one .SC2Replay file through ``extract_macro_events`` and writes a
JSON file with just the keys ``apps/api/src/services/phaseClassifier.js``
consumes:

    {
      "race": "Protoss" | "Terran" | "Zerg",
      "durationSec": <int>,
      "macroBreakdown": {
        "bases":               [{name, born_time, died_time}, ...],
        "production_buildings":[{name, born_time, died_time}, ...],
        "stats_events":        [{time, food_workers, food_used, army_value}, ...],
        "opp_stats_events":    [...same shape...],
        "unit_timeline":       [{time, my: {...}, opp: {...}}, ...]
      }
    }

Usage::

    python3 scripts/dump-macro-fixture.py \\
      --replay path/to/replay.SC2Replay \\
      --player "ReSpOnSe" \\
      --out apps/api/__tests__/fixtures/phase/warpgate_adept_tracking.json

If --player is omitted the lone human player is used.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

# Make the replay-engine package importable.
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
_ANALYZER = os.path.join(_ROOT, "apps", "replay-engine")
if _ANALYZER not in sys.path:
    sys.path.insert(0, _ANALYZER)


def _match_me(replay, target):
    target_low = (target or "").lower()
    if target:
        for p in replay.players:
            if getattr(p, "name", None) == target:
                return p
        for p in replay.players:
            pname = (getattr(p, "name", "") or "").lower()
            if target_low and (target_low in pname or pname in target_low):
                return p
    humans = [
        p for p in replay.players
        if getattr(p, "is_human", True)
        and not getattr(p, "is_observer", False)
        and not getattr(p, "is_referee", False)
    ]
    if len(humans) == 1:
        return humans[0]
    return None


def _slim_stats(rows):
    out = []
    for s in rows:
        out.append({
            "time": int(s.get("time", 0)),
            "food_workers": int(s.get("food_workers", 0) or 0),
            "food_used": float(s.get("food_used", 0) or 0),
            "army_value": int(s.get("army_value", 0) or 0),
        })
    return out


def _slim_lifetime(rows):
    out = []
    for r in rows:
        out.append({
            "name": r.get("name"),
            "born_time": int(r.get("born_time", 0)),
            "died_time": int(r.get("died_time", 0)),
        })
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(prog="dump-macro-fixture")
    ap.add_argument("--replay", required=True)
    ap.add_argument("--player", default="")
    ap.add_argument("--out", required=True)
    args = ap.parse_args(argv)

    from core.replay_loader import load_replay_with_fallback
    from core.event_extractor import extract_macro_events

    replay = load_replay_with_fallback(args.replay)
    me = _match_me(replay, args.player)
    if me is None:
        raise SystemExit(f"player '{args.player}' not found in replay")

    opp_pid = None
    for player in (getattr(replay, "players", None) or []):
        if not getattr(player, "is_human", False):
            continue
        ppid = getattr(player, "pid", None)
        if ppid is None or ppid == me.pid:
            continue
        opp_pid = ppid
        break

    ev = extract_macro_events(replay, me.pid, opp_pid)
    length_sec = int(replay.game_length.seconds if replay.game_length else 0)

    fixture = {
        "race": me.play_race,
        "durationSec": length_sec,
        "macroBreakdown": {
            "bases": _slim_lifetime(ev.get("bases", [])),
            "production_buildings": _slim_lifetime(
                ev.get("production_buildings", [])),
            "stats_events": _slim_stats(ev.get("stats_events", [])),
            "opp_stats_events": _slim_stats(ev.get("opp_stats_events", [])),
            "unit_timeline": ev.get("unit_timeline", []),
        },
    }

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(fixture, f, indent=2)
        f.write("\n")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
