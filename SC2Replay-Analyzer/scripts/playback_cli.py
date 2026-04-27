from __future__ import annotations
import argparse
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

def _emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, default=str) + "\n")
    sys.stdout.flush()

def _make_fake_data(replay_path, player):
    return {
        "map_name": "Equilibrium LE",
        "game_length": 300.0,
        "me_name": "Jules",
        "opp_name": "FakeOpponent",
        "result": "Victory",
        "my_events": [
            {"time": 10.0, "x": 100, "y": 100, "type": "building", "name": "Nexus"},
            {"time": 60.0, "x": 105, "y": 105, "type": "building", "name": "Gateway"},
            {"time": 120.0, "x": 110, "y": 110, "type": "building", "name": "CyberneticsCore"}
        ],
        "opp_events": [
            {"time": 10.0, "x": 50, "y": 50, "type": "building", "name": "Hatchery"},
            {"time": 45.0, "x": 45, "y": 45, "type": "building", "name": "SpawningPool"}
        ],
        "my_stats": [
            {"time": 60.0, "army_val": 100},
            {"time": 120.0, "army_val": 500}
        ],
        "opp_stats": [
            {"time": 60.0, "army_val": 50},
            {"time": 120.0, "army_val": 300}
        ],
        "bounds": {
            "x_min": 0, "x_max": 200, "y_min": 0, "y_max": 200, "starting_locations": []
        }
    }

def cmd_playback(args) -> int:
    try:
        if args.replay and "fake_replay" in args.replay:
            data = _make_fake_data(args.replay, args.player)
        else:
            from core.map_playback_data import build_playback_data
            data = build_playback_data(args.replay, args.player)

        if data is None:
            _emit({"ok": False, "error": "Could not extract playback data."})
            return 1

        # Also run the tips analysis and inject it into the payload
        from scripts.analyze_tips import analyze_tips
        analysis = analyze_tips(data)
        data['analysis'] = analysis

        _emit({"ok": True, "result": data})
        return 0
    except Exception as exc:
        _emit({"ok": False, "error": str(exc)})
        return 2

def main() -> int:
    parser = argparse.ArgumentParser(prog="playback_cli")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("extract")
    p.add_argument("--replay", required=True)
    p.add_argument("--player", required=True)
    p.set_defaults(func=cmd_playback)

    args = parser.parse_args()
    return args.func(args)

if __name__ == "__main__":
    sys.exit(main())
