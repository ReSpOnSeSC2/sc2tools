"""Prepare or run one visible native neural checkpoint preview (no training)."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))


def main():
    from pluto_sc2.alphastar_live import DEFAULT_AGENT_STATE, prepare, run
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    init = commands.add_parser("prepare", help="Create a fresh pinned spool session; starts no processes")
    init.add_argument("--output", required=True, type=Path)
    init.add_argument("--checkpoint-run", required=True, type=Path)
    init.add_argument("--catalog", required=True, type=Path)
    init.add_argument("--map", required=True)
    init.add_argument("--seconds", type=float, default=900)
    init.add_argument("--speed", type=float, default=1)
    init.add_argument("--wall-seconds", type=float, default=1800)
    init.add_argument("--timeout-seconds", type=float, default=180)
    init.add_argument("--opponent-race", choices=("Terran", "Protoss", "Zerg"), default="Terran")
    init.add_argument("--difficulty", choices=("Easy", "Medium", "Hard"), default="Hard")
    init.add_argument("--agent-state", type=Path, default=DEFAULT_AGENT_STATE,
                      help="Local SC2TOOLS state; only its paused bit is read before/during native play")
    play = commands.add_parser("run", help="Start one visible game; the separate worker must already be running")
    play.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.command == "prepare":
        result = prepare(args.output, args.checkpoint_run, args.catalog, args.map, seconds=args.seconds,
                         speed=args.speed, wall_seconds=args.wall_seconds, timeout_seconds=args.timeout_seconds,
                         opponent_race=args.opponent_race, difficulty=args.difficulty, agent_state=args.agent_state)
    else:
        result = run(args.output)
    print(json.dumps(result, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
