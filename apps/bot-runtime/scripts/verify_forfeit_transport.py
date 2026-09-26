"""Two bounded live concession-transport checks, isolated from league training.

This deliberately injects a concession after ten game seconds. It verifies the
actual SC2 leave/result/rollout/replay transport, NOT the zero-worker detection
condition, policy strength, or an ordinary autonomous economic resignation.
Run only when an operator has scheduled the two local SC2 clients.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import math
from pathlib import Path

import torch

from pluto_sc2 import league
from pluto_sc2.adversary import validate_adversary_audit
from pluto_sc2.rewards import RewardConfig
from pluto_sc2.runner import seed_everything, validate_action_audit, write_json
from pluto_sc2.sc2_adapter import NeuralBot


GAMES = 2
CONCEDE_SECONDS = 10.0
MAX_GAME_SECONDS = 60.0
PURPOSE = "Injected concession transport verification; not a zero-worker-condition or strength test"


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def verify(league_path: Path, map_name: str, output: Path) -> dict:
    root, output = league_path.resolve(), output.resolve()
    if output == root or output.is_relative_to(root):
        raise ValueError("Verification output must be outside the active league directory")
    if not 0 < CONCEDE_SECONDS < MAX_GAME_SECONDS <= 60:
        raise ValueError("Transport verification requires positive bounded game times")
    state = league._state(root)
    manifest_before = league.sha256(root / "state.json")
    sources = {race: league._verified_path(root, state["snapshots"][race][-1])
               for race in ("Protoss", "Terran")}
    hashes = {race: league.sha256(path) for race, path in sources.items()}
    policies = {race: league._load(path, race, max_apm=state["adversary_max_apm"])["policy"]
                for race, path in sources.items()}
    for policy in policies.values():
        policy.eval().requires_grad_(False)
    output.mkdir(parents=True, exist_ok=False)
    config = RewardConfig()
    report = {
        "purpose": PURPOSE,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "league": str(root), "map": map_name,
        "source_checkpoints": {race: {"path": str(sources[race]), "sha256": hashes[race]}
                               for race in sources},
        "league_games_at_start": state["games"],
        "injected_concession_seconds": CONCEDE_SECONDS,
        "max_game_seconds": MAX_GAME_SECONDS,
        "expected_games": GAMES, "reward_config": config.to_dict(),
        "league_writes_performed": False, "ppo_updates_performed": False,
        "games": [], "passed": False,
    }
    write_json(output / "verification.json", report)
    original_step = NeuralBot._step

    async def injected_step(self: NeuralBot, iteration: int) -> None:
        if (not self._episode_finished and self.forfeit_reason is None
                and self.time >= CONCEDE_SECONDS):
            # Refresh the final ordinary observation; retain the real pending
            # on-policy transition and let Burnysc2 invoke normal on_end.
            self.fairplay.sync_camera(self)
            self._observe()
            await self._forfeit({
                "reason": "explicit_transport_verification",
                "verification_only": True,
                "game_seconds": float(self.time),
                "game_loop": int(self.state.game_loop),
                "purpose": PURPOSE,
            })
            return
        await original_step(self, iteration)

    NeuralBot._step = injected_step
    previous_bot = None
    try:
        for index in range(GAMES):
            game_output = output / f"game-{index + 1}"
            game_output.mkdir()
            replay = game_output / "game.SC2Replay"
            seed = 93210 + index
            seed_everything(seed)
            started_at = datetime.now(timezone.utc).isoformat()
            report["current_game"] = index + 1
            write_json(output / "verification.json", report)
            bots, match = league.play_match(
                policies["Protoss"], "Protoss", policies["Terran"], "Terran", map_name,
                max_game_seconds=MAX_GAME_SECONDS, seed=seed, max_apm=state["adversary_max_apm"],
                replay_path=replay, gamma=1.0, reward_config=config,
            )
            write_json(game_output / "match.json", match)
            _require(len(bots) == 2, "Transport check did not create two participants")
            learner, opponent = bots
            _require(learner is not previous_bot, "Next game reused its previous bot episode")
            previous_bot = learner
            _require(match["engine_results"] == ["Defeat", "Victory"],
                     "SC2 did not return the expected real concession defeat/victory")
            _require(match["results"] == ["Defeat", "Victory"] and not match["time_limit_reached"],
                     "Concession was incorrectly normalized to a timeout")
            _require(learner.forfeit_reason is not None
                     and learner.forfeit_reason.get("reason") == "explicit_transport_verification",
                     "The expected explicit test concession did not occur")
            _require(CONCEDE_SECONDS <= learner.forfeit_reason["game_seconds"] < MAX_GAME_SECONDS,
                     "Injected concession fell outside the intended bounded interval")
            rollout = league._validate_rollout(learner, policies["Protoss"], "Protoss")
            final = rollout[-1]
            _require(final.terminated and not final.truncated and final.next_value == 0,
                     "Concession did not produce a true terminal transition with zero bootstrap")
            rewards = learner.reward_summary
            _require(rewards is not None and rewards["terminal_reward"] == -10
                     and learner.reward_terminal_outcome == -10,
                     "Concession did not receive the configured -10 terminal reward")
            _require(math.isclose(sum(row.reward for row in rollout), rewards["total"], abs_tol=1e-6),
                     "Final rollout lost or duplicated reward during concession")
            _require(opponent._episode_finished and getattr(opponent.result, "name", None) == "Victory",
                     "Opponent did not complete with a real victory")
            for bot_index, bot in enumerate(bots):
                audit = {"summary": bot.fairplay.summary(), "actions": bot.fairplay.audit}
                (validate_action_audit if bot_index == 0 else validate_adversary_audit)(audit)
                write_json(game_output / f"audit-{bot_index}.json", audit)
            _require(replay.is_file() and replay.stat().st_size > 0,
                     "Conceded game did not save its replay")
            game = {
                "game": index + 1, "started_at": started_at,
                "finished_at": datetime.now(timezone.utc).isoformat(),
                "match": match, "transitions": len(rollout),
                "final_transition": {"reward": final.reward, "terminated": final.terminated,
                                     "truncated": final.truncated, "next_value": final.next_value},
                "replay": str(replay), "replay_sha256": league.sha256(replay),
                "injection": learner.forfeit_reason,
            }
            write_json(game_output / "result.json", game)
            report["games"].append(game)
            write_json(output / "verification.json", report)
            print({"game": index + 1, "engine_results": match["engine_results"],
                   "terminal_reward": rewards["terminal_reward"], "replay": str(replay)}, flush=True)
        _require(all(league.sha256(path) == hashes[race] for race, path in sources.items()),
                 "An immutable input checkpoint changed during verification")
        report["checkpoint_hashes_unchanged"] = True
        report["next_game_started_after_concession"] = len(report["games"]) == GAMES
        report["league_manifest_sha256_before"] = manifest_before
        report["league_manifest_sha256_after"] = league.sha256(root / "state.json")
        report["passed"] = True
    except BaseException as error:
        report["failure"] = {"type": type(error).__name__, "message": str(error)}
        raise
    finally:
        NeuralBot._step = original_step
        report["runtime_patch_restored"] = NeuralBot._step is original_step
        report["finished_at"] = datetime.now(timezone.utc).isoformat()
        write_json(output / "verification.json", report)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--league", required=True)
    parser.add_argument("--map", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    torch.set_num_threads(2)
    verify(Path(args.league), args.map, Path(args.output))


if __name__ == "__main__":
    main()
