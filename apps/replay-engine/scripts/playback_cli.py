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

def cmd_playback(args) -> int:
    try:
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
