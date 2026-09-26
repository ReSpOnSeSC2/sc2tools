"""Collect replay-build teacher openings, then fit independent T/Z policies.

Teacher wins are never counted as learned-policy wins. Held-out replay IDs
remain disjoint, and teachers are not present after the imitation checkpoint
enters the reinforcement-learning league.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from filelock import FileLock
import numpy as np
import torch

from pluto_sc2.adversary_schema import get_spec, metadata, validate_metadata
from pluto_sc2.build_teacher import ReplayBuildTeacher, sample_builds
from pluto_sc2.learning import Policy, save_checkpoint, load_checkpoint
from pluto_sc2.runner import device_name, resolve_map, seed_everything, write_json


def _digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def play_teacher(build, map_name, *, max_game_seconds=360, max_apm=600, seed=1, replay_path=None):
    from sc2.data import Difficulty, Race
    from sc2.main import run_game
    from sc2.player import Bot, Computer
    from pluto_sc2.adversary import AdversaryBot, validate_adversary_audit
    from pluto_sc2.league_client import league_clients

    spec = get_spec(build["race"])
    policy = Policy(spec.input_dim, spec.action_dim, 16)
    teacher = ReplayBuildTeacher(build, horizon_seconds=max_game_seconds)
    bot = AdversaryBot(policy, spec.race, teacher=teacher, record=True, max_apm=max_apm,
                       max_game_seconds=max_game_seconds)
    if replay_path:
        Path(replay_path).parent.mkdir(parents=True, exist_ok=True)
    with league_clients():
        result = run_game(resolve_map(map_name), [Bot(Race[spec.race], bot),
            Computer(Race.Protoss, Difficulty.VeryEasy)], realtime=False, random_seed=seed, disable_fog=False,
            game_time_limit=max_game_seconds, save_replay_as=str(Path(replay_path).resolve()) if replay_path else None)
    if bot.error or not bot._episode_finished or not bot.decisions:
        raise RuntimeError(f"Incomplete teacher episode: {bot.error}")
    if bot.transitions:
        raise RuntimeError("A teacher episode incorrectly generated PPO data")
    audit = {"summary": bot.fairplay.summary(), "actions": bot.fairplay.audit}
    validate_adversary_audit(audit)
    return bot, {"kind": "teacher_rollout", "result": result.name, "seed": seed,
                 "game_seconds": float(bot.time), "build": teacher.report(),
                 "policy_actions": dict(bot.action_counts), "rating_status": "not_a_policy_evaluation"}


def collect(builds_path, race, output, map_name, *, partition="train", games=12, max_game_seconds=360,
            max_apm=600, seed=1, user_loss_weight=2.0, match_runner=None):
    from pluto_sc2.opponent_builds import load_build_orders
    if partition not in ("train", "validation"):
        raise ValueError("Choose train or validation partition")
    spec = get_spec(race)
    contract = metadata(race, max_apm=max_apm)
    builds = load_build_orders(builds_path, race, partition=partition)
    if not builds or type(games) is not int or games < 1:
        raise ValueError("A nonempty build partition and positive episode count are required")
    if partition == "train":
        chosen = sample_builds(builds, games, seed=seed, user_loss_weight=user_loss_weight)
    else:
        if games > len(builds):
            raise ValueError("Validation uses distinct held-out builds without weighting or repetition")
        chosen = sorted(builds, key=lambda item: item["replay_id"])[:games]
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    config = {"schema": 1, "race": race, "contract": contract, "partition": partition,
              "builds_sha256": _digest(builds_path), "map": str(map_name), "games": games,
              "max_game_seconds": max_game_seconds, "max_apm": max_apm, "seed": seed,
              "user_loss_weight": user_loss_weight if partition == "train" else 1.0,
              "chosen_replay_ids": [item["replay_id"] for item in chosen]}
    match_runner = match_runner or play_teacher
    with FileLock(str(output / ".collect.lock"), timeout=0):
        config_path = output / "config.json"
        if config_path.exists() and json.loads(config_path.read_text()) != config:
            raise ValueError("Existing teacher collection uses a different configuration")
        write_json(config_path, config)
        rows = []
        reports = []
        for index, build in enumerate(chosen):
            folder = output / f"episode-{index:04d}"
            data_path = folder / "examples.npz"
            report_path = folder / "report.json"
            if (output / "STOP").exists():
                raise InterruptedError("Teacher collection stopped between episodes")
            if data_path.exists() and report_path.exists():
                report = json.loads(report_path.read_text())
                if (report.get("examples_sha256") != _digest(data_path)
                        or report.get("replay_id") != build["replay_id"] or report.get("partition") != partition):
                    raise ValueError("Previously collected teacher episode changed")
            else:
                seed_everything(seed + index)
                bot, report = match_runner(build, map_name, max_game_seconds=max_game_seconds,
                    max_apm=max_apm, seed=seed + index, replay_path=folder / "teacher.SC2Replay")
                accepted = [item for item in bot.decisions if item["action"] == 0 or item.get("accepted") is True]
                commands = [item for item in accepted if item["action"] != 0]
                idle = [item for item in accepted if item["action"] == 0]
                if not commands:
                    raise ValueError("Teacher produced no accepted production/economic commands")
                # Avoid teaching mostly waiting; loss weighting happens through
                # build sampling above and is not multiplied a second time.
                rng = np.random.default_rng(seed + index)
                if len(idle) > len(commands) // 3:
                    idle = [idle[i] for i in rng.choice(len(idle), len(commands) // 3, replace=False)]
                selected = sorted(commands + idle, key=lambda item: item["game_loop"])
                observations = np.stack([item["observation"] for item in selected])
                masks = np.stack([item["mask"] for item in selected])
                actions = np.asarray([item["action"] for item in selected], dtype=np.int64)
                if observations.shape[1] != spec.input_dim or masks.shape[1] != spec.action_dim:
                    raise ValueError("Teacher emitted wrong-race feature dimensions")
                folder.mkdir(parents=True, exist_ok=True)
                temporary = data_path.with_suffix(".tmp")
                with temporary.open("wb") as stream:
                    np.savez_compressed(stream, observations=observations, masks=masks, actions=actions)
                temporary.replace(data_path)
                write_json(folder / "audit.json", {"summary": bot.fairplay.summary(), "actions": bot.fairplay.audit})
                report.update(replay_id=build["replay_id"], partition=partition,
                              examples_sha256=_digest(data_path), examples=len(selected))
                write_json(report_path, report)
            with np.load(data_path, allow_pickle=False) as saved:
                rows.append((saved["observations"], saved["masks"], saved["actions"],
                             np.full(len(saved["actions"]), build["replay_id"], dtype="U64")))
            reports.append(report)
        arrays = [np.concatenate([row[index] for row in rows]) for index in range(4)]
        dataset = output / "dataset.npz"
        temporary = dataset.with_suffix(".tmp")
        with temporary.open("wb") as stream:
            np.savez_compressed(stream, observations=arrays[0], masks=arrays[1], actions=arrays[2],
                                replay_ids=arrays[3], metadata=np.asarray(json.dumps(config)))
        temporary.replace(dataset)
        summary = {**config, "dataset": str(dataset), "dataset_sha256": _digest(dataset),
                   "examples": len(arrays[2]), "reports": reports}
        write_json(output / "summary.json", summary)
        return summary


def _dataset(path, race, partition, max_apm):
    with np.load(path, allow_pickle=False) as saved:
        config = json.loads(str(saved["metadata"]))
        validate_metadata(config["contract"], race, max_apm=max_apm)
        if config.get("partition") != partition:
            raise ValueError("Wrong teacher dataset partition")
        obs, masks, actions, ids = [saved[key] for key in ("observations", "masks", "actions", "replay_ids")]
    spec = get_spec(race)
    chosen = config.get("chosen_replay_ids")
    if (not isinstance(chosen, list) or not chosen or ids.ndim != 1
            or not set(ids.tolist()).issubset(set(chosen))):
        raise ValueError("Teacher replay IDs do not belong to the recorded collection")
    if (obs.ndim != 2 or obs.shape[1] != spec.input_dim or masks.shape != (len(obs), spec.action_dim)
            or actions.shape != (len(obs),) or ids.shape != (len(obs),) or not len(obs)
            or not np.isfinite(obs).all() or not np.isin(masks, (0, 1)).all()
            or actions.dtype.kind not in "iu" or np.any(actions < 0) or np.any(actions >= spec.action_dim)
            or not masks[np.arange(len(obs)), actions].all()):
        raise ValueError("Invalid teacher examples")
    return obs, masks, actions, ids, config


def fit(training, validation, race, output, *, epochs=30, batch_size=512, hidden_dim=256,
        max_apm=600, device="cpu", seed=1):
    if type(epochs) is not int or epochs < 1 or type(batch_size) is not int or batch_size < 1:
        raise ValueError("Epochs and batch size must be positive")
    train = _dataset(training, race, "train", max_apm)
    valid = _dataset(validation, race, "validation", max_apm)
    train_ids, validation_ids = sorted(set(map(str, train[3]))), sorted(set(map(str, valid[3])))
    if set(train_ids) & set(validation_ids):
        raise ValueError("Original replay IDs overlap between training and validation")
    if train[4]["builds_sha256"] != valid[4]["builds_sha256"]:
        raise ValueError("Training and validation must use the same partitioned build corpus")
    output = Path(output).resolve()
    with FileLock(str(output) + ".lock", timeout=0):
        if output.exists():
            raise ValueError("Choose a fresh imitation checkpoint path")
        seed_everything(seed)
        spec = get_spec(race)
        policy = Policy(spec.input_dim, spec.action_dim, hidden_dim).to(device_name(device))
        optimizer = torch.optim.Adam(policy.parameters(), lr=3e-4)
        tensors = [[torch.as_tensor(value, device=policy.device) for value in data[:3]] for data in (train, valid)]
        best, history = float("inf"), []
        for epoch in range(epochs):
            policy.train()
            order = torch.randperm(len(train[0]), device=policy.device)
            for start in range(0, len(order), batch_size):
                indices = order[start:start + batch_size]
                obs, masks, actions = [value[indices] for value in tensors[0]]
                logits, _ = policy(obs)
                loss = torch.nn.functional.cross_entropy(logits.masked_fill(~masks.bool(), -torch.inf), actions.long())
                optimizer.zero_grad(set_to_none=True)
                loss.backward()
                torch.nn.utils.clip_grad_norm_(policy.parameters(), .5)
                optimizer.step()
            policy.eval()
            with torch.inference_mode():
                total_loss, correct, count = 0.0, 0, 0
                for start in range(0, len(valid[0]), batch_size):
                    obs, masks, actions = [value[start:start + batch_size] for value in tensors[1]]
                    logits, _ = policy(obs)
                    logits = logits.masked_fill(~masks.bool(), -torch.inf)
                    total_loss += torch.nn.functional.cross_entropy(logits, actions.long(), reduction="sum").item()
                    correct += (logits.argmax(-1) == actions).sum().item()
                    count += len(actions)
                metrics = {"epoch": epoch + 1, "validation_cross_entropy": total_loss / count,
                           "validation_accuracy": correct / count, "validation_examples": count}
            history.append(metrics)
            if metrics["validation_cross_entropy"] < best:
                best = metrics["validation_cross_entropy"]
                save_checkpoint(output, policy, metadata=metadata(race, max_apm=max_apm, stage="imitation",
                    bootstrap_method="opponent replay opening teacher imitation", train_replay_ids=train_ids,
                    validation_replay_ids=validation_ids, training_ancestry={"version": 1,
                        "known_train_replay_ids": train_ids, "complete": True},
                    user_loss_weight=train[4]["user_loss_weight"], best_validation=metrics,
                    source_training_sha256=_digest(training), source_validation_sha256=_digest(validation)))
        best_metrics = load_checkpoint(output)["metadata"]["best_validation"]
        result = {"checkpoint": str(output), "sha256": _digest(output), "race": race,
                  "train_replay_ids": train_ids, "validation_replay_ids": validation_ids,
                  "best_validation": best_metrics, "history": history, "rating_status": "unrated",
                  "limitation": "Opening teacher imitation; validation accuracy is not match strength"}
        write_json(output.with_suffix(".metrics.json"), result)
        return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--threads", type=int, default=4)
    commands = parser.add_subparsers(dest="command", required=True)
    collect_parser = commands.add_parser("collect")
    collect_parser.add_argument("--builds", required=True)
    collect_parser.add_argument("--map", required=True)
    collect_parser.add_argument("--partition", choices=("train", "validation"), default="train")
    collect_parser.add_argument("--games", type=int, default=12)
    collect_parser.add_argument("--max-game-seconds", type=int, default=360)
    collect_parser.add_argument("--user-loss-weight", type=float, default=2.0)
    fitting = commands.add_parser("fit")
    fitting.add_argument("--training", required=True)
    fitting.add_argument("--validation", required=True)
    fitting.add_argument("--epochs", type=int, default=30)
    fitting.add_argument("--hidden-dim", type=int, default=256)
    fitting.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    for command in commands.choices.values():
        command.add_argument("--race", choices=("Terran", "Zerg"), required=True)
        command.add_argument("--output", required=True)
        command.add_argument("--max-apm", type=int, default=600)
        command.add_argument("--seed", type=int, default=1)
    args = parser.parse_args(argv)
    torch.set_num_threads(args.threads)
    if args.command == "collect":
        result = collect(args.builds, args.race, args.output, args.map, partition=args.partition, games=args.games,
            max_game_seconds=args.max_game_seconds, max_apm=args.max_apm, seed=args.seed,
            user_loss_weight=args.user_loss_weight)
    else:
        result = fit(args.training, args.validation, args.race, args.output, epochs=args.epochs,
            hidden_dim=args.hidden_dim, device=args.device, max_apm=args.max_apm, seed=args.seed)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
