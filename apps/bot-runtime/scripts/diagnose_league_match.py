"""Replay the next league pairing without changing saved models or league state."""
import argparse
from datetime import datetime, timezone
import math
from pathlib import Path

import torch

from pluto_sc2 import league
from pluto_sc2.runner import ManagedSC2Process, seed_everything, write_json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--league", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--map", required=True)
    parser.add_argument("--seconds", type=float, default=1800)
    parser.add_argument("--validate-ppo", action="store_true",
                        help="Run a PPO update on an isolated in-memory copy after a complete valid game.")
    args = parser.parse_args()
    root, output = Path(args.league).resolve(), Path(args.output).resolve()
    if output.is_relative_to(root):
        raise ValueError("Diagnostic output must be outside the league")
    output.mkdir(parents=True, exist_ok=False)
    state = league._state(root)
    state_hash = league.sha256(root / "state.json")
    race, other_race, other_entry = league.select_match(state)
    source = league._verified_path(root, state["snapshots"][race][-1])
    other = league._verified_path(root, other_entry)
    policy = league._load(source, race)["policy"]
    opponent = league._load(other, other_race)["policy"]
    policy.eval().requires_grad_(False)
    opponent.eval().requires_grad_(False)
    seed = state["seed"] + state["games"] + 1
    seed_everything(seed)
    torch.set_num_threads(4)
    config, targets = league.reward_configuration(root)
    reference = league.select_reward_reference(targets, race, other_race, seed)
    report = {"purpose": __doc__, "started_at": datetime.now(timezone.utc).isoformat(),
              "committed_games": state["games"], "source": str(source), "opponent": str(other),
              "source_sha256": league.sha256(source), "opponent_sha256": league.sha256(other),
              "seed": seed, "passed": False, "league_updates": False,
              "pass_scope": "Complete neural pairing and rollout validation, plus isolated PPO if requested",
              "addon_repair_verified": False,
              "addon_verification_note": "A successful neural pairing alone does not verify addon reuse; use verify_addon_reuse.py"}
    write_json(output / "diagnostic.json", report)
    try:
        bots, match = league.play_match(policy, race, opponent, other_race, args.map,
            max_game_seconds=args.seconds, seed=seed, max_apm=state["adversary_max_apm"],
            replay_path=output / "game.SC2Replay", gamma=1.0,
            reward_config=config, reward_reference=reference)
        rollout = league._validate_rollout(bots[0], policy, race)
        for index, bot in enumerate(bots):
            write_json(output / f"audit-{index}.json", {"summary": bot.fairplay.summary(), "actions": bot.fairplay.audit})
        report.update(passed=True, match=match, transitions=len(rollout))
        report["accepted_addon_commands"] = {
            str(index): {str(ability): sum(event.get("ability") == ability and event.get("result") == [1]
                                          for event in bot.fairplay.audit)
                         for ability in (454, 485, 520)}
            for index, bot in enumerate(bots)
        }
        if args.validate_ppo:
            # Reload the immutable checkpoint and its optimizer into memory;
            # never save to it or advance the active league manifest here.
            trainer = league._trainer(league._load(source, race), source)
            report["isolated_ppo_update"] = trainer.update(rollout)
            if not all(math.isfinite(value) for value in report["isolated_ppo_update"].values()
                       if isinstance(value, (float, int))):
                raise RuntimeError("Isolated PPO verification returned non-finite metrics")
            report["source_checkpoint_unchanged"] = league.sha256(source) == report["source_sha256"]
            if not report["source_checkpoint_unchanged"]:
                raise RuntimeError("Immutable source checkpoint changed during isolated PPO verification")
    except BaseException as error:
        report["passed"] = False
        report["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        report["engine_lifecycle"] = list(ManagedSC2Process._lifecycle_events)
        report["league_manifest_unchanged"] = league.sha256(root / "state.json") == state_hash
        report["source_checkpoint_unchanged"] = league.sha256(source) == report["source_sha256"]
        report["opponent_checkpoint_unchanged"] = league.sha256(other) == report["opponent_sha256"]
        unchanged = all(report[key] for key in ("league_manifest_unchanged", "source_checkpoint_unchanged",
                                                "opponent_checkpoint_unchanged"))
        if not unchanged:
            report["passed"] = False
            report["immutability_error"] = "Input checkpoint or league manifest changed during isolated diagnostic"
        report["finished_at"] = datetime.now(timezone.utc).isoformat()
        write_json(output / "diagnostic.json", report)
        if not unchanged:
            raise RuntimeError(report["immutability_error"])


if __name__ == "__main__":
    main()
