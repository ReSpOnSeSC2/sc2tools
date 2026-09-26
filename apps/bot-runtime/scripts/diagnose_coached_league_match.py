"""One isolated learner-vs-frozen-coach game and optional in-memory PPO check.

Never advances a league manifest or writes a learner checkpoint. Requires an
explicit enabled/pinned curriculum file and a new output directory. The coach
is a frozen script using ordinary Protoss human-input constraints, not live
Codex strategy decisions. No game is started without --run.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import time

import psutil
import torch

from pluto_sc2 import league, league_coach
from pluto_sc2.runner import seed_everything, write_json


def diagnose(checkpoint, race, config_path, output, map_name, *, seed=149123,
             max_game_seconds=900, max_apm=600, update_in_memory=False, run=False):
    output, checkpoint = Path(output).resolve(), Path(checkpoint).resolve()
    if output.exists() and any(output.iterdir()):
        raise ValueError("Use a new isolated diagnostic output directory")
    if race not in league.RACES or type(seed) is not int or not 0 <= seed < 2**32:
        raise ValueError("Invalid explicit learner race or seed")
    if not 60 <= max_game_seconds <= 3600:
        raise ValueError("Diagnostic duration must be 60 to 3600 game seconds")
    config = league_coach.configuration(config_path)
    if config is None:
        raise ValueError("Diagnostic needs an explicitly enabled coached opponent configuration")
    frozen = league_coach.freeze_opponent(config, race, seed)
    digest = league.sha256(checkpoint)
    loaded = league._load(checkpoint, race, "cpu", max_apm)
    trainer = league._trainer(loaded, checkpoint)
    seed_everything(seed)
    output.mkdir(parents=True, exist_ok=True)
    process = psutil.Process()
    state = {"schema": 1, "status": "ready", "learner_race": race, "opponent_race": "Protoss",
             "checkpoint": str(checkpoint), "checkpoint_sha256": digest, "seed": seed,
             "map": str(map_name), "max_game_seconds": max_game_seconds,
             "pid": process.pid, "process_created_at": process.create_time(),
             "created_at": datetime.now(timezone.utc).isoformat(), "league_manifest_updated": False,
             "checkpoint_saved": False, "update_in_memory": bool(update_in_memory),
             "coached_opponent": league_coach.opponent_record(frozen), "rating_status": "unrated"}
    write_json(output / "coached-opponent.json", frozen)
    write_json(output / "status.json", state)
    if not run:
        return state
    if (output / "STOP").exists():
        raise ValueError("Diagnostic STOP marker is present")
    # Avoid duplicate/user game interference. Never kill an existing client.
    for peer in psutil.process_iter(["name"]):
        if (peer.info.get("name") or "").lower() in {"sc2_x64.exe", "sc2_x64"}:
            raise RuntimeError("An SC2 client is already active; diagnostic did not launch")
    state.update(status="running", started_at=datetime.now(timezone.utc).isoformat())
    write_json(output / "status.json", state)
    started = time.monotonic()
    try:
        bots, match = league.play_match(trainer.policy, race, None, "Protoss", map_name,
            max_game_seconds=max_game_seconds, seed=seed, max_apm=max_apm,
            replay_path=output / "game.SC2Replay", gamma=trainer.config.gamma, coached_opponent=frozen)
        rollout = league._validate_rollout(bots[0], trainer.policy, race)
        for index, bot in enumerate(bots):
            write_json(output / f"audit-{index}.json", {"summary": bot.fairplay.summary(),
                                                       "actions": bot.fairplay.audit})
        if bots[1].policy is not None or bots[1].record or bots[1].transitions:
            raise RuntimeError("Frozen coach unexpectedly supplied a learned policy or training transitions")
        metrics = trainer.update(rollout) if update_in_memory else None
        if league.sha256(checkpoint) != digest:
            raise RuntimeError("Diagnostic source checkpoint changed")
        write_json(output / "match.json", {**match, "ppo_in_memory": metrics, "transitions": len(rollout),
                                          "source_checkpoint_sha256": digest, "rating_status": "unrated"})
        state.update(status="complete", results=match["results"], engine_results=match["engine_results"],
                     time_limit_reached=match["time_limit_reached"], game_seconds=match["game_seconds"],
                     transitions=len(rollout), ppo_in_memory=metrics,
                     policy_actions=match["policy_actions"], coach_strategy=match["coach_strategy"],
                     control_rules=match["control_rules"])
    except BaseException as error:
        state.update(status="failed", error=f"{type(error).__name__}: {error}")
        raise
    finally:
        state.update(finished_at=datetime.now(timezone.utc).isoformat(), wall_seconds=time.monotonic() - started)
        write_json(output / "status.json", state)
    return state


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--race", required=True, choices=league.RACES)
    parser.add_argument("--config", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--map", required=True)
    parser.add_argument("--seed", type=int, default=149123)
    parser.add_argument("--seconds", type=float, default=900)
    parser.add_argument("--adversary-apm", type=int, default=600)
    parser.add_argument("--update-in-memory", action="store_true")
    parser.add_argument("--run", action="store_true")
    args = parser.parse_args()
    torch.set_num_threads(2)
    result = diagnose(args.checkpoint, args.race, args.config, args.output, args.map,
                      seed=args.seed, max_game_seconds=args.seconds, max_apm=args.adversary_apm,
                      update_in_memory=args.update_in_memory, run=args.run)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
