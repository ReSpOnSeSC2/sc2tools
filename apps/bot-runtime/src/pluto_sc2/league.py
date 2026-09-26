"""Independent race learners, asymmetric opponents, and immutable snapshots.

One learner updates per match. Its opponent stays frozen for the whole match.
The atomic manifest is the commit point: failed games/updates never advance
the league, and orphan attempt folders are retained for diagnosis.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import random
import re
import time
import uuid

from filelock import FileLock
import psutil
import torch

from pluto_sc2 import adversary_schema
from pluto_sc2 import league_coach
from pluto_sc2.contract import validate_metadata
from pluto_sc2.learning import Policy, PPOConfig, PPOTrainer, load_checkpoint, save_checkpoint
from pluto_sc2.runner import (device_name, resolve_map, seed_everything, write_json,
                              validate_action_audit, _normalize_time_limit)
from pluto_sc2.schema import OBSERVATION_SIZE, ACTION_NAMES

RACES = ("Protoss", "Terran", "Zerg")
DIFFICULTIES = ("VeryEasy", "Easy", "Medium", "MediumHard", "Hard", "Harder", "VeryHard")
# Three balanced main-policy updates, plus two opponent improvements.
SCHEDULE = (("Protoss", "Terran"), ("Terran", "Protoss"), ("Protoss", "Protoss"),
            ("Protoss", "Zerg"), ("Zerg", "Protoss"))


def sha256(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _load(path, race, device="cpu", max_apm=600):
    if race == "Protoss":
        loaded = load_checkpoint(path, expected_input_dim=OBSERVATION_SIZE,
                                 expected_action_dim=len(ACTION_NAMES))
        validate_metadata(loaded["metadata"])
    else:
        spec = adversary_schema.get_spec(race)
        loaded = load_checkpoint(path, expected_input_dim=spec.input_dim,
                                 expected_action_dim=spec.action_dim)
        adversary_schema.validate_metadata(loaded["metadata"], race, max_apm=max_apm, step_mul=2)
    loaded["policy"].to(device_name(device))
    return loaded


def _trainer(loaded, source):
    stage = loaded["metadata"].get("stage")
    if stage not in ("imitation", "reinforcement", "initialization"):
        raise ValueError("Unsupported learner checkpoint stage")
    config = loaded["config"] or PPOConfig()
    reference = loaded["policy"] if stage == "imitation" else loaded["reference_policy"]
    if loaded["metadata"].get("reference_enabled") and reference is None:
        raise ValueError("Checkpoint lost its frozen imitation reference")
    trainer = PPOTrainer(loaded["policy"], config, reference_policy=reference)
    if stage == "reinforcement":
        if loaded["optimizer_state"] is None:
            raise ValueError("Reinforcement checkpoint has no resumable optimizer")
        load_checkpoint(source, policy=trainer.policy, optimizer=trainer.optimizer, restore_rng=True)
    return trainer


def _save_learner(path, trainer, metadata, games):
    metadata = {**metadata, "stage": "reinforcement",
                "reference_enabled": trainer.reference_policy is not None
                and trainer.config.reference_kl_coef > 0}
    save_checkpoint(path, trainer.policy, optimizer=trainer.optimizer, config=trainer.config,
                    reference_policy=trainer.reference_policy, counters={"games": games}, metadata=metadata)


def initialize(output, protoss, *, terran=None, zerg=None, max_apm=600, seed=1, hidden_dim=256,
               builtin_practice=False):
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    adversary_schema.metadata("Terran", max_apm=max_apm)
    with FileLock(str(output / ".league.lock"), timeout=0):
        if any(p.name != ".league.lock" for p in output.iterdir()):
            raise ValueError("Initialize an empty league folder; use train to continue")
        seed_everything(seed)
        entries = {}
        for race, source in zip(RACES, (protoss, terran, zerg)):
            if source:
                loaded = _load(source, race, max_apm=max_apm)
                trainer = _trainer(loaded, source)
                metadata = {**loaded["metadata"], "league_source_sha256": sha256(source)}
                if loaded["metadata"].get("stage") == "imitation":
                    metadata["reference_source"] = {"checkpoint_sha256": sha256(source),
                        "train_replay_ids": metadata.get("train_replay_ids", []),
                        "validation_replay_ids": metadata.get("validation_replay_ids", [])}
            else:
                spec = adversary_schema.get_spec(race)
                trainer = PPOTrainer(Policy(spec.input_dim, spec.action_dim, hidden_dim))
                metadata = adversary_schema.metadata(race, max_apm=max_apm, initialization="random",
                    training_ancestry={"version": 1, "known_train_replay_ids": [], "complete": True})
            destination = output / "initial" / (race + ".pt")
            _save_learner(destination, trainer, metadata, 0)
            entries[race] = [{"path": str(destination.relative_to(output)), "sha256": sha256(destination),
                              "updates": 0, "initialization": "checkpoint" if source else "random"}]
        state = {"schema": 1, "created_at": datetime.now(timezone.utc).isoformat(), "games": 0,
                 "seed": seed, "adversary_max_apm": max_apm, "snapshots": entries,
                 "rating_status": "unrated", "measured_mmr": None,
                 "matchups": {key: {"training_games": 0, "target_mmr": 6000,
                                    "measured_mmr": None} for key in ("PvT", "PvP", "PvZ")}}
        state["builtin_practice"] = {race: "VeryEasy" for race in RACES} if builtin_practice else None
        write_json(output / "state.json", state)
    return state


def _state(output):
    state = json.loads((output / "state.json").read_text())
    if (not isinstance(state, dict) or state.get("schema") != 1
            or not isinstance(state.get("snapshots"), dict) or set(state["snapshots"]) != set(RACES)):
        raise ValueError("Invalid league manifest")
    if type(state.get("games")) is not int or state["games"] < 0:
        raise ValueError("Invalid league game counter")
    if (type(state.get("seed")) is not int or state["seed"] < 0
            or state["seed"] + state["games"] + 1 >= 2**32):
        raise ValueError("Invalid league seed or exhausted game seed range")
    adversary_schema.metadata("Terran", max_apm=state.get("adversary_max_apm"))
    practice = state.get("builtin_practice")
    if practice is not None and (not isinstance(practice, dict) or set(practice) != set(RACES)
                                 or any(value not in DIFFICULTIES for value in practice.values())):
        raise ValueError("Invalid built-in practice curriculum")
    cycles, remainder = divmod(state["games"], len(SCHEDULE))
    update_counts = {race: cycles * sum(learner == race for learner, _ in SCHEDULE)
                     + sum(learner == race for learner, _ in SCHEDULE[:remainder]) for race in RACES}
    for race, entries in state["snapshots"].items():
        if not isinstance(entries, list) or not entries:
            raise ValueError("Each race must have a checkpoint")
        if len(entries) != update_counts[race] + 1:
            raise ValueError("Race update history disagrees with the committed game schedule")
        for index, entry in enumerate(entries):
            if (not isinstance(entry, dict) or type(entry.get("updates")) is not int or entry["updates"] != index
                    or not isinstance(entry.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"])
                    or not isinstance(entry.get("path"), str)):
                raise ValueError("Invalid race checkpoint history entry")
            path = (output / entry["path"]).resolve()
            if not path.is_relative_to(output) or not path.is_file():
                raise ValueError("League checkpoint missing or outside its folder")
    if not isinstance(state.get("matchups"), dict) or set(state["matchups"]) != {"PvT", "PvP", "PvZ"}:
        raise ValueError("League needs separate PvT/PvP/PvZ counters")
    for opponent in RACES:
        expected = cycles + sum(learner == "Protoss" and race == opponent for learner, race in SCHEDULE[:remainder])
        entry = state["matchups"]["Pv" + opponent[0]]
        if not isinstance(entry, dict) or type(entry.get("training_games")) is not int or entry["training_games"] != expected:
            raise ValueError("Matchup counter disagrees with committed schedule")
    return state


def _verified_path(output, entry):
    path = output / entry["path"]
    if sha256(path) != entry["sha256"]:
        raise ValueError("Immutable league checkpoint has changed")
    return path


def select_match(state):
    learner, opponent = SCHEDULE[state["games"] % len(SCHEDULE)]
    snapshots = state["snapshots"][opponent]
    rng = random.Random(state["seed"] + state["games"])
    # Current strategies dominate; old opponents remain in circulation.
    selected = snapshots[-1] if len(snapshots) == 1 or rng.random() < .7 else rng.choice(snapshots[:-1])
    return learner, opponent, selected


def _validate_rollout(bot, policy, race):
    if getattr(bot, "teacher", None) is not None:
        raise ValueError("Teacher demonstrations cannot enter an on-policy PPO update")
    if bot.policy is not policy or bot.error or not bot._episode_finished or not bot.transitions:
        raise ValueError("Incomplete or wrong-policy learner rollout")
    if not (bot.transitions[-1].terminated or bot.transitions[-1].truncated):
        raise ValueError("Learner rollout has no episode boundary")
    if any(row.terminated or row.truncated for row in bot.transitions[:-1]):
        raise ValueError("Learner rollout contains multiple episodes")
    audit = {"summary": bot.fairplay.summary(), "actions": bot.fairplay.audit}
    if race == "Protoss":
        validate_action_audit(audit)
    else:
        from pluto_sc2.adversary import validate_adversary_audit
        validate_adversary_audit(audit)
    return bot.transitions


def play_match(learner_policy, learner_race, opponent_policy, opponent_race, map_name, *,
               max_game_seconds=1800, seed=1, max_apm=600, replay_path=None, gamma=1.0,
               builtin_difficulty=None, reward_config=None, reward_reference=None,
               coached_opponent=None):
    if coached_opponent is not None and (builtin_difficulty is not None or opponent_race != "Protoss"
                                         or opponent_policy is not None or replay_path is None):
        raise ValueError("Coached opponent requires a frozen Protoss plan, replay path, and no neural/built-in opponent")
    if builtin_difficulty is not None:
        if learner_race != "Protoss" or builtin_difficulty not in DIFFICULTIES:
            raise ValueError("Built-in practice is a non-cheating main-Protoss curriculum")
        from pluto_sc2.runner import play_match as ordinary_match
        bots, match = ordinary_match(learner_policy, map_name, opponent="builtin", difficulty=builtin_difficulty,
            opponent_race=opponent_race, max_game_seconds=max_game_seconds, seed=seed,
            replay_path=replay_path, gamma=gamma, reward_shaping=.1, record=True,
            reward_config=reward_config, reward_reference=reward_reference)
        match.update(learner_race=learner_race, opponent_profile="builtin_standard")
        return bots, match
    from sc2.data import Race
    from sc2.main import run_game
    from sc2.player import Bot
    from pluto_sc2.adversary import AdversaryBot, validate_adversary_audit
    from pluto_sc2.league_client import league_clients
    from pluto_sc2.sc2_adapter import NeuralBot

    bots = []
    for policy, race, record in ((learner_policy, learner_race, True),
                                  (opponent_policy, opponent_race, False)):
        if not record and coached_opponent is not None:
            bot = league_coach.make_bot(coached_opponent, Path(replay_path).parent / "coach-opponent",
                                       f"league-coach-{seed}", max_game_seconds)
            bots.append(bot)
            continue
        common = dict(record=record, max_game_seconds=max_game_seconds, gamma=gamma, reward_shaping=.1)
        if record and reward_config is not None:
            common.update(reward_config=reward_config, reward_reference=reward_reference)
        bot = (NeuralBot(policy, **common) if race == "Protoss" else
               AdversaryBot(policy, race, max_apm=max_apm, step_mul=2, **common))
        bots.append(bot)
    players = [Bot(Race[race], bot, name=f"{race} {'learner' if index == 0 else 'frozen coach' if coached_opponent else 'snapshot'}")
               for index, (race, bot) in enumerate(zip((learner_race, opponent_race), bots))]
    if replay_path:
        Path(replay_path).parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    with league_clients():
        result = run_game(resolve_map(map_name), players, realtime=False, random_seed=seed,
                          disable_fog=False, game_time_limit=max_game_seconds,
                          save_replay_as=str(Path(replay_path).resolve()) if replay_path else None)
    if any(bot.error or not bot._episode_finished for bot in bots):
        raise RuntimeError("League episode failed: " + repr([bot.error for bot in bots]))
    if not isinstance(result, list) or len(result) != 2 or any(
            getattr(item, "name", None) not in ("Victory", "Defeat", "Tie") for item in result):
        raise RuntimeError("Missing or invalid league results")
    engine = [item.name for item in result]
    results, capped = _normalize_time_limit(bots, engine.copy(), max_game_seconds, 8)
    for race, bot in zip((learner_race, opponent_race), bots):
        data = {"summary": bot.fairplay.summary(), "actions": bot.fairplay.audit}
        (validate_action_audit if race == "Protoss" else validate_adversary_audit)(data)
    return bots, {"results": results, "engine_results": engine, "time_limit_reached": capped,
                  "game_seconds": [float(bot.time) for bot in bots], "wall_seconds": time.monotonic() - started,
                  "learner_race": learner_race, "opponent_race": opponent_race, "seed": seed,
                  "opponent_profile": (league_coach.PROFILE if coached_opponent is not None else
                                       "human" if opponent_race == "Protoss" else "asymmetric"),
                  "coached_opponent": league_coach.opponent_record(coached_opponent) if coached_opponent else None,
                  "coach_strategy": bots[1].mailbox.status if coached_opponent else None,
                  "policy_actions": [dict(bot.action_counts) for bot in bots],
                  "rejected_policy_actions": [dict(bot.rejected_policy_actions) for bot in bots],
                  "forfeits": [getattr(bot, "forfeit_reason", None) for bot in bots],
                  "control_rules": [getattr(bot, "control_summary", None) for bot in bots],
                  "reward_breakdown": [getattr(bot, "reward_summary", None) for bot in bots]}


def reward_configuration(output):
    """Read an explicitly activated profile once per match, never mid-rollout."""
    path = Path(output) / "reward-config.json"
    if not path.exists():
        return None, None
    document = json.loads(path.read_text(encoding="utf-8"))
    if (not isinstance(document, dict) or document.get("schema") != 1
            or type(document.get("enabled")) is not bool
            or set(document) - {"schema", "enabled", "config", "replay_targets", "replay_targets_sha256"}):
        raise ValueError("Invalid league reward configuration")
    if not document["enabled"]:
        return None, None
    from pluto_sc2.rewards import RewardConfig
    config = RewardConfig.from_dict(document.get("config", {}))
    targets = None
    if document.get("replay_targets"):
        source = Path(document["replay_targets"]).resolve()
        if sha256(source) != document.get("replay_targets_sha256"):
            raise ValueError("Replay reward targets changed after activation")
        from pluto_sc2.replay_targets import load_targets
        targets = load_targets(source)
        training = set(targets.get("train_replay_ids", []))
        validation = set(targets.get("validation_replay_ids", []))
        if not training or training & validation:
            raise ValueError("Replay reward targets have an invalid train/validation split")
        for trajectory in targets.get("trajectories", []):
            if trajectory.get("replay_id") not in training:
                raise ValueError("Reward trajectory is not from a training replay")
    return config, targets


def select_reward_reference(targets, learner_race, opponent_race, seed):
    if not targets or learner_race != "Protoss":
        return None
    candidates = [item for item in targets.get("trajectories", [])
                  if item.get("matchup") == "Pv" + opponent_race[0]]
    if not candidates:
        raise ValueError("Activated replay reward targets are missing a Protoss matchup")
    return random.Random(seed).choice(candidates)


def train(output, maps, *, games=1, device="cpu", max_game_seconds=1800, match_runner=None):
    if type(games) is not int or games < 1 or not maps or max_game_seconds <= 0:
        raise ValueError("Positive games/duration and at least one map are required")
    output = Path(output).resolve()
    match_runner = match_runner or play_match
    with FileLock(str(output / ".league.lock"), timeout=0):
        state = _state(output)
        for _ in range(games):
            if (output / "STOP").exists():
                break
            learner_race, opponent_race, opponent_entry = select_match(state)
            seed = state["seed"] + state["games"] + 1
            coached_opponent = league_coach.select_opponent(output, state, learner_race, opponent_race,
                                                            seed, len(SCHEDULE))
            learner_entry = state["snapshots"][learner_race][-1]
            source = _verified_path(output, learner_entry)
            opponent_path = _verified_path(output, opponent_entry) if coached_opponent is None else None
            loaded = _load(source, learner_race, device, state["adversary_max_apm"])
            if loaded["counters"].get("games") != learner_entry["updates"]:
                raise ValueError("Learner checkpoint counter differs from the committed manifest")
            trainer = _trainer(loaded, source)
            opponent = None
            if coached_opponent is None:
                opponent = _load(opponent_path, opponent_race, device, state["adversary_max_apm"])["policy"]
                opponent.eval().requires_grad_(False)
            seed_everything(seed)
            reward_config, reward_targets = reward_configuration(output)
            if reward_config is not None and trainer.config.gamma != 1.0:
                raise ValueError("Bounded dense league rewards require the undiscounted gamma=1 contract")
            reward_reference = select_reward_reference(reward_targets, learner_race, opponent_race, seed)
            attempt = output / "matches" / f"{state['games'] + 1:07d}-{uuid.uuid4().hex[:12]}"
            attempt.mkdir(parents=True)
            try:
                from pluto_sc2.sc2_adapter import CONTROL_PROFILE
                from pluto_sc2.adversary_orders import ORDER_PROFILE
                from pluto_sc2.adversary_placement import PLACEMENT_PROFILE
                process = psutil.Process()
                write_json(attempt / "viewer.json", {
                    "schema": 1, "game": state["games"] + 1,
                    "learner_race": learner_race, "opponent_race": opponent_race,
                    "map": str(maps[state["games"] % len(maps)]),
                    "started_at": datetime.now(timezone.utc).isoformat(),
                    "pid": process.pid, "process_created_at": process.create_time(),
                    "reward_version": reward_config.version if reward_config else "legacy-potential",
                    "reward_reference_replay_id": reward_reference["replay_id"] if reward_reference else None,
                    "coached_opponent": league_coach.opponent_record(coached_opponent) if coached_opponent else None,
                    "runtime_control_profiles": {"Protoss": CONTROL_PROFILE,
                                                 "adversary_orders": ORDER_PROFILE,
                                                 "adversary_placement": PLACEMENT_PROFILE},
                })
                practice = state.get("builtin_practice")
                builtin_difficulty = (practice[opponent_race] if not coached_opponent and practice and learner_race == "Protoss"
                                      and (state["games"] // len(SCHEDULE)) % 2 else None)
                reward_options = ({"reward_config": reward_config, "reward_reference": reward_reference}
                                  if reward_config is not None else {})
                if coached_opponent is not None:
                    # Record immutable input even for diagnostic/custom runners.
                    write_json(attempt / "coached-opponent.json", coached_opponent)
                    reward_options["coached_opponent"] = coached_opponent
                bots, match = match_runner(trainer.policy, learner_race, opponent, opponent_race,
                    maps[state["games"] % len(maps)], max_game_seconds=max_game_seconds,
                    seed=seed, max_apm=state["adversary_max_apm"], replay_path=attempt / "game.SC2Replay",
                    gamma=trainer.config.gamma, builtin_difficulty=builtin_difficulty, **reward_options)
                # Never merge opponent trajectories or different race schemas.
                rollout = _validate_rollout(bots[0], trainer.policy, learner_race)
                metrics = trainer.update(rollout)
                for index, bot in enumerate(bots):
                    write_json(attempt / f"audit-{index}.json",
                               {"summary": bot.fairplay.summary(), "actions": bot.fairplay.audit})
                checkpoint = attempt / "learner.pt"
                metadata = {**loaded["metadata"], "league_parent_sha256": learner_entry["sha256"],
                            "league_opponent_sha256": None if builtin_difficulty or coached_opponent else opponent_entry["sha256"],
                            "league_coached_opponent": league_coach.opponent_record(coached_opponent) if coached_opponent else None,
                            "reward_config": reward_config.to_dict() if reward_config else None,
                            "reward_reference_replay_id": reward_reference["replay_id"] if reward_reference else None}
                metadata["runtime_control_rules"] = match.get("control_rules")
                if coached_opponent is not None:
                    from pluto_sc2.replays import _checkpoint_training_ancestry
                    known, complete = _checkpoint_training_ancestry(metadata)
                    metadata["training_ancestry"] = {"version": 1, "complete": complete,
                        "known_train_replay_ids": sorted(set(known) | {coached_opponent["plan"]["replay_id"]})}
                _save_learner(checkpoint, trainer, metadata, learner_entry["updates"] + 1)
                opponent_record = (league_coach.opponent_record(coached_opponent) if coached_opponent else
                                   {"kind": "builtin", "race": opponent_race, "difficulty": builtin_difficulty}
                                   if builtin_difficulty else opponent_entry)
                record = {**match, "ppo": metrics, "learner_before": learner_entry,
                          "opponent": opponent_record, "checkpoint_sha256": sha256(checkpoint),
                          "reward_config": metadata["reward_config"],
                          "reward_reference_replay_id": metadata["reward_reference_replay_id"],
                          "reward_reference": reward_reference,
                          "rating_status": "unrated"}
                write_json(attempt / "match.json", record)
                updated = deepcopy(state)
                updated["snapshots"][learner_race].append({"path": str(checkpoint.relative_to(output)),
                    "sha256": record["checkpoint_sha256"], "updates": learner_entry["updates"] + 1})
                updated["games"] += 1
                if learner_race == "Protoss":
                    updated["matchups"]["Pv" + opponent_race[0]]["training_games"] += 1
                updated["last_match"] = str((attempt / "match.json").relative_to(output))
                write_json(output / "state.json", updated)
                state = updated
                print(json.dumps({"game": state["games"], "learner": learner_race,
                                  "opponent": opponent_race, "results": match["results"]}), flush=True)
            except BaseException as error:
                write_json(attempt / "failure.json", {"type": type(error).__name__, "message": str(error)})
                raise
    return state


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--threads", type=int, default=4)
    commands = parser.add_subparsers(dest="command", required=True)
    init = commands.add_parser("init")
    init.add_argument("--protoss", required=True)
    init.add_argument("--terran")
    init.add_argument("--zerg")
    init.add_argument("--adversary-apm", type=int, default=600)
    init.add_argument("--seed", type=int, default=1)
    init.add_argument("--builtin-practice", action="store_true",
                      help="Alternate league rounds with standard AI practice in all three matchups")
    start = commands.add_parser("train")
    start.add_argument("--maps", nargs="+", required=True)
    start.add_argument("--games", type=int, default=5)
    start.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    start.add_argument("--max-game-seconds", type=int, default=1800)
    commands.add_parser("status")
    for command in commands.choices.values():
        command.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    torch.set_num_threads(args.threads)
    if args.command == "init":
        result = initialize(args.output, args.protoss, terran=args.terran, zerg=args.zerg,
                            max_apm=args.adversary_apm, seed=args.seed, builtin_practice=args.builtin_practice)
    elif args.command == "train":
        result = train(args.output, args.maps, games=args.games, device=args.device,
                       max_game_seconds=args.max_game_seconds)
    else:
        result = _state(Path(args.output).resolve())
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
