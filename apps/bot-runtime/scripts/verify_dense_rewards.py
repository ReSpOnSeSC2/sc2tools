"""Bounded live reward and PPO checks, separate from the active league."""
import argparse
from pathlib import Path

import torch

from pluto_sc2 import league
from pluto_sc2.replay_targets import load_targets
from pluto_sc2.rewards import RewardConfig
from pluto_sc2.runner import seed_everything, write_json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--league", required=True)
    parser.add_argument("--targets", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--map", required=True)
    parser.add_argument("--seconds", type=float, default=90)
    args = parser.parse_args()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    root = Path(args.league).resolve()
    state = league._state(root)
    targets = load_targets(args.targets)
    torch.set_num_threads(2)
    reports = []
    for index, race in enumerate(league.RACES):
        seed = 5000 + index
        source = league._verified_path(root, state["snapshots"][race][-1])
        loaded = league._load(source, race)
        trainer = league._trainer(loaded, source)
        other_race = "Terran" if race == "Protoss" else "Protoss"
        opponent_path = league._verified_path(root, state["snapshots"][other_race][-1])
        opponent = league._load(opponent_path, other_race)["policy"]
        opponent.eval().requires_grad_(False)
        seed_everything(seed)
        reference = league.select_reward_reference(targets, race, other_race, seed)
        bots, match = league.play_match(
            trainer.policy, race, opponent, other_race, args.map,
            max_game_seconds=args.seconds, seed=seed, max_apm=600,
            replay_path=output / f"{race}.SC2Replay", gamma=trainer.config.gamma,
            builtin_difficulty="VeryEasy" if race == "Protoss" else None,
            reward_config=RewardConfig(), reward_reference=reference,
        )
        rollout = league._validate_rollout(bots[0], trainer.policy, race)
        summary = match["reward_breakdown"][0]
        assert summary and summary["config"]["version"] == RewardConfig().version
        assert summary["auxiliary_used"] <= 4.000001
        assert abs(sum(row.reward for row in rollout) - summary["total"]) < 1e-6
        assert summary["signal_totals"].get("mined_minerals", 0) > 0
        metrics = trainer.update(rollout)
        for bot_index, bot in enumerate(bots):
            write_json(output / f"{race}-audit-{bot_index}.json",
                       {"summary": bot.fairplay.summary(), "actions": bot.fairplay.audit})
        report = dict(race=race, source=str(source), source_sha256=league.sha256(source),
                      transitions=len(rollout), match=match, ppo=metrics,
                      reference_replay_id=reference["replay_id"] if reference else None)
        write_json(output / f"{race}.json", report)
        reports.append(report)
        print({"race": race, "transitions": len(rollout), "reward": summary["total"]}, flush=True)
    write_json(output / "verification.json", {"passed": True, "reports": reports,
               "active_league_modified": False, "purpose": "Live adapter, fair-play and PPO integration; not strength evaluation"})


if __name__ == "__main__":
    main()
