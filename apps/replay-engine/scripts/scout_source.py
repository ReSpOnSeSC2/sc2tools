"""Private input to the Daily Scout builder. Emits no replay or player identity."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
from pathlib import Path

import sc2reader

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core.build_definitions import is_eight_worker_game, name_for_game_version  # noqa: E402
from core.event_extractor import extract_building_lifecycle, extract_events, extract_unit_tracks  # noqa: E402
from core.preset_policy import validate_policy  # noqa: E402
from core.sc2_replay_parser import _is_resumed_replay  # noqa: E402
from core.strategy_detector import OpponentStrategyDetector, UserBuildDetector  # noqa: E402


def classify(replay, me, opp, side):
    my_events, opp_events, _ = extract_events(replay, me.pid)
    matchup = f"vs {opp.play_race}"
    length = replay.game_length.seconds
    version = replay.release_string
    eight_worker = is_eight_worker_game(version, replay.build)
    policy = validate_policy(
        {"schemaVersion": 1, "evaluatorVersion": 1, "revision": 0, "entries": []},
        verify_hash=False,
    )
    if side == "me":
        label = UserBuildDetector([], policy).detect_my_build(
            matchup, my_events, me.play_race, length, eight_worker,
        )
    else:
        label = OpponentStrategyDetector([], policy).get_strategy_name(
            opp.play_race, opp_events, matchup, length, me.play_race, eight_worker,
        )
    return name_for_game_version(label, version)


def replay_players(replay, perspective):
    players = replay.players
    if len(players) != 2 or len(replay.teams) != 2 or not all(p.is_human for p in players):
        raise ValueError("Scout requires a human 1v1 replay.")
    mine = [p for p in players if p.name == perspective]
    if len(mine) != 1:
        raise ValueError("Provide the exact in-replay name of one player.")
    me = mine[0]
    return me, next(p for p in players if p.pid != me.pid)


def read_scout_source(path, perspective, side):
    content = Path(path).read_bytes()
    replay = sc2reader.load_replay(io.BytesIO(content), load_level=4, load_map=False)
    me, opp = replay_players(replay, perspective)
    if not replay.tracker_events or _is_resumed_replay(replay):
        raise ValueError("Scout requires complete Tracker events from a full replay.")
    if not extract_unit_tracks(replay, me.pid)["complete"]:
        raise ValueError("Scout requires complete Tracker events from a full replay.")
    player = me if side == "me" else opp
    lifecycle = extract_building_lifecycle(replay).get(player.pid, [])
    return {
        "replaySha256": hashlib.sha256(content).hexdigest(),
        "playerSlot": player.pid,
        "side": side,
        "strategy": classify(replay, me, opp, side),
        "buildings": [
            {"owner": side, "name": item["name"], "x": item["x"], "y": item["y"], "t": item["born"]}
            for item in lifecycle
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--replay", required=True)
    parser.add_argument("--perspective", required=True)
    parser.add_argument("--side", required=True, choices=["me", "opp"])
    args = parser.parse_args()
    try:
        source = read_scout_source(args.replay, args.perspective, args.side)
    except Exception:
        parser.exit(1, "Could not establish the replay side, detector strategy and complete Tracker evidence.\n")
    print(json.dumps(source, allow_nan=False))


if __name__ == "__main__":
    main()
