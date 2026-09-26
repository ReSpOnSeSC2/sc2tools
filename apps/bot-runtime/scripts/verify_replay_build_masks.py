"""Verify replay Pylon/Gateway masks on a real player's visible prior states."""
import argparse
import asyncio
import json
from pathlib import Path
import sys

from loguru import logger

import pluto_sc2.sc2_adapter as adapter
from pluto_sc2.replays import ReplayError, _extract_one, inspect_replay, select_player
from pluto_sc2.schema import ACTION_NAMES, ACTION_TO_INDEX


class ProbeFinished(Exception):
    pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--replay", required=True)
    parser.add_argument("--player", default="ReSpOnSe")
    parser.add_argument("--max-loops", type=int, default=6000)
    parser.add_argument("--output", default="runs/replay-build-mask-probe.json")
    args = parser.parse_args()
    logger.remove()
    logger.add(sys.stderr, level="INFO")
    original = adapter.legal_action_mask
    found = {}

    async def capture(bot):
        mask = await original(bot)
        for name in ("build_pylon", "build_gateway"):
            if mask[ACTION_TO_INDEX[name]] and name not in found:
                found[name] = {"game_loop": bot.state.game_loop, "minerals": bot.minerals,
                               "camera": list(bot.fairplay.camera_center),
                               "available_build_actions": [label for index, label in enumerate(ACTION_NAMES) if label.startswith("build_") and mask[index]]}
        if len(found) == 2:
            raise ProbeFinished()
        if bot.state.game_loop >= args.max_loops:
            raise ReplayError(f"Build-mask probe exceeded {args.max_loops} loops; found {list(found)}")
        return mask

    info = inspect_replay(args.replay)
    adapter.legal_action_mask = capture
    try:
        try:
            asyncio.run(_extract_one(info, select_player(info, player_name=args.player), 8))
        except ProbeFinished:
            pass
        if len(found) != 2:
            raise ReplayError(f"Replay ended without both required build masks: {list(found)}")
    finally:
        adapter.legal_action_mask = original
    report = {"replay_id": info["replay_id"], "player": args.player, "verified_masks": found,
              "note": "Read-only replay observation probe; no training examples or model were created."}
    destination = Path(args.output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
