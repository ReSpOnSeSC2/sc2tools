"""Persistent local curriculum with independent PvT/PvP/PvZ evaluation.

Built-in difficulty is a curriculum level, never a ladder MMR estimate.
Each child runs one game, so completed updates survive process restarts and
code corrections can take effect between games. No service is installed.
"""
from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from filelock import FileLock
import psutil

from pluto_sc2.learning import PPOConfig, load_checkpoint
from pluto_sc2.runner import append_json, validate_action_audit, write_json

RACES = ("Terran", "Protoss", "Zerg")
MATCHUPS = ("PvT", "PvP", "PvZ")
DIFFICULTIES = ("VeryEasy", "Easy", "Medium", "MediumHard", "Hard", "Harder", "VeryHard")


def utcnow():
    return datetime.now(timezone.utc).isoformat()


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


@dataclass(frozen=True)
class CampaignConfig:
    maps: tuple[str, ...]
    region: str | None = None
    target_mmr: int = 6000
    training_games_per_cycle: int = 30
    evaluation_games_per_matchup: int = 3
    max_game_seconds: int = 1800
    child_timeout_seconds: int = 2700
    threads: int = 4
    device: str = "cpu"
    min_free_gb: float = 10.0
    review_after_stagnant_cycles: int = 6

    def __post_init__(self):
        if not self.maps or any(not Path(p).is_file() or Path(p).suffix.lower() != ".sc2map" for p in self.maps):
            raise ValueError("All campaign maps must be existing .SC2Map files")
        for name in ("target_mmr", "training_games_per_cycle", "evaluation_games_per_matchup",
                     "max_game_seconds", "child_timeout_seconds", "threads", "review_after_stagnant_cycles"):
            if type(getattr(self, name)) is not int or getattr(self, name) < 1:
                raise ValueError(f"{name} must be a positive integer")
        if self.training_games_per_cycle % 3:
            raise ValueError("Training cycle size must be divisible by three for balanced matchups")
        if self.device not in ("cpu", "cuda") or not 0 < self.min_free_gb < 10000:
            raise ValueError("Invalid device or free-disk requirement")
        if self.region not in (None, "NA", "EU", "KR"):
            raise ValueError("Region must be NA, EU, KR or null")


def initialize(output, checkpoint, config):
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    with FileLock(str(output / ".campaign.lock"), timeout=0):
        if any(p.name != ".campaign.lock" for p in output.iterdir()):
            raise ValueError("Campaign folder must be empty; use run to continue an existing campaign")
        from pluto_sc2.runner import load_policy
        _, loaded = load_policy(checkpoint, config.device)
        if loaded["metadata"].get("stage") not in ("imitation", "reinforcement"):
            raise ValueError("Initial checkpoint must be imitation or reinforcement")
        # Current CLI exposes these PPO settings; reject unsupported variants.
        ppo = loaded["config"] or PPOConfig()
        defaults = PPOConfig()
        for name in ("clip_range", "value_coef", "max_grad_norm", "target_kl"):
            if getattr(ppo, name) != getattr(defaults, name):
                raise ValueError(f"Campaign CLI cannot resume non-default {name}")
        initial = output / "initial.pt"
        shutil.copyfile(checkpoint, initial)
        base = loaded["counters"].get("games", 0) if loaded["metadata"]["stage"] == "reinforcement" else 0
        write_json(output / "config.json", {"schema": 1, **asdict(config), "ppo": asdict(ppo),
                                            "initial_sha256": digest(initial), "base_games": base})
        state = {"schema": 1, "status": "ready", "created_at": utcnow(), "new_training_games": 0,
                 "completed_cycles": 0, "cycle_training_target": config.training_games_per_cycle,
                 "stagnant_cycles": 0, "matchups": {key: {
                     "difficulty_index": 0, "promotion_streak": 0, "best_wins": -1,
                     "training_games": 0, "evaluation_games": 0, "measured_mmr": None,
                     "rating_status": "unrated", "target_mmr": config.target_mmr,
                 } for key in MATCHUPS}}
        write_json(output / "state.json", state)
        return state


def _read(output):
    raw = json.loads((output / "config.json").read_text())
    if raw.pop("schema") != 1:
        raise ValueError("Unsupported campaign schema")
    extra = {key: raw.pop(key) for key in ("ppo", "initial_sha256", "base_games")}
    raw["maps"] = tuple(raw["maps"])
    config = CampaignConfig(**raw)
    if digest(output / "initial.pt") != extra["initial_sha256"]:
        raise ValueError("Campaign initial checkpoint has changed")
    state = json.loads((output / "state.json").read_text())
    if state.get("schema") != 1 or set(state.get("matchups", {})) != set(MATCHUPS):
        raise ValueError("Invalid campaign state")
    return config, extra, state


def reconcile(output, extra, state):
    latest = output / "training" / "latest.pt"
    actual = extra["base_games"]
    if latest.is_file():
        actual = load_checkpoint(latest)["counters"]["games"]
    total = actual - extra["base_games"]
    if total < state["new_training_games"]:
        raise ValueError("Checkpoint is older than campaign state; refusing to replay committed training")
    state["new_training_games"] = total
    for index, key in enumerate(MATCHUPS):
        state["matchups"][key]["training_games"] = (total + 2 - index) // 3
    return latest if latest.is_file() else output / "initial.pt"


def _base_command(config):
    return [sys.executable, "-u", "-m", "pluto_sc2", "--threads", str(config.threads)]


def training_command(output, config, extra, state, checkpoint):
    number = state["new_training_games"]
    index = number % 3
    matchup = state["matchups"][MATCHUPS[index]]
    command = _base_command(config) + [
        "train", "--resume", str(checkpoint), "--output", str(output / "training"),
        "--games", "1", "--map", config.maps[(number // 3) % len(config.maps)],
        "--opponent", "builtin", "--opponent-race", RACES[index],
        "--difficulty", DIFFICULTIES[matchup["difficulty_index"]], "--seed", "100",
        "--max-game-seconds", str(config.max_game_seconds), "--device", config.device,
    ]
    for field in ("learning_rate", "gamma", "gae_lambda", "epochs", "minibatch_size",
                  "entropy_coef", "reference_kl_coef"):
        command += ["--" + field.replace("_", "-"), str(extra["ppo"][field])]
    return command


def _terminate_tree(child):
    if child.poll() is not None:
        return
    try:
        process = psutil.Process(child.pid)
        owned = process.children(recursive=True) + [process]
        for item in reversed(owned):
            try:
                item.terminate()
            except psutil.NoSuchProcess:
                pass
        _, alive = psutil.wait_procs(owned, timeout=5)
        for item in alive:
            try:
                item.kill()
            except psutil.NoSuchProcess:
                pass
    except psutil.NoSuchProcess:
        pass
    child.wait(timeout=10)


def execute_child(command, log_path, timeout_seconds):
    log_path.parent.mkdir(parents=True, exist_ok=True)
    options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    with log_path.open("x", encoding="utf-8") as stream:
        child = subprocess.Popen(command, stdout=stream, stderr=subprocess.STDOUT, **options)
        try:
            code = child.wait(timeout=timeout_seconds)
        except BaseException:
            _terminate_tree(child)
            raise
    if code:
        raise RuntimeError(f"Game process exited {code}; inspect {log_path}")


def _run_with_retries(output, config, state, make_job, execute):
    for attempt in range(3):
        if (output / "STOP").exists():
            return False
        command, log_path = make_job(attempt)
        state.update(status="running", last_job=command, last_log=str(log_path), updated_at=utcnow())
        write_json(output / "state.json", state)
        try:
            execute(command, log_path, config.child_timeout_seconds)
            return True
        except (RuntimeError, OSError, subprocess.TimeoutExpired) as error:
            append_json(output / "failures.jsonl", {"at": utcnow(), "attempt": attempt + 1,
                                                    "error": str(error), "log": str(log_path)})
            if attempt == 2:
                raise
    return False


def _evaluation_result(folder, config, state, checkpoint_hash, index):
    """Validate a single child result and bind it to its original evidence."""
    names = ("evaluation.json", "matches.jsonl", "audit-0000.json")
    hashes = {name: digest(folder / name) for name in names}
    summary = json.loads((folder / names[0]).read_text())
    match_lines = (folder / names[1]).read_text().splitlines()
    if len(match_lines) != 1:
        raise ValueError("Evaluation child must produce exactly one match")
    match = json.loads(match_lines[0])
    audit = validate_action_audit(json.loads((folder / names[2]).read_text()))
    race_index = index % 3
    key = MATCHUPS[race_index]
    difficulty = DIFFICULTIES[state["matchups"][key]["difficulty_index"]]
    seed = 1_000_000_000 + state["completed_cycles"] * 3 * config.evaluation_games_per_matchup + index
    if not isinstance(summary, dict) or not isinstance(match, dict):
        raise ValueError("Evaluation summary and match must be objects")
    result = match.get("results")
    if (not isinstance(result, list) or len(result) != 1 or result[0] not in ("Victory", "Defeat", "Tie")
            or type(match.get("time_limit_reached")) is not bool):
        raise ValueError("Invalid evaluation result or time-limit flag")
    if (summary.get("checkpoint_sha256") != checkpoint_hash or type(summary.get("games")) is not int
            or summary["games"] != 1 or summary.get("results") != {result[0]: 1}):
        raise ValueError("Evaluation checkpoint or result count mismatch")
    expected = {"opponent_race": RACES[race_index], "difficulty": difficulty,
                "seed": seed, "action_selection": "sampled"}
    if any(summary.get(name) != value or match.get(name) != value for name, value in expected.items()):
        raise ValueError("Evaluation matchup, difficulty, seed or policy sampling mismatch")
    if (summary.get("map") != config.maps[(index // 3) % len(config.maps)]
            or summary.get("max_game_seconds") != config.max_game_seconds
            or summary.get("step_mul") != 8 or match.get("opponent") != "builtin"):
        raise ValueError("Evaluation map, duration or opponent configuration mismatch")
    if any(digest(folder / name) != value for name, value in hashes.items()):
        raise ValueError("Evaluation artifacts changed while validating")
    return {"matchup": key, "difficulty": difficulty, "result": result[0],
            "time_limit_reached": match["time_limit_reached"], "checkpoint_sha256": checkpoint_hash,
            "audit": audit, "path": str(folder), "artifact_sha256": hashes}


def evaluate_cycle(output, config, state, checkpoint, execute):
    cycle = state["completed_cycles"]
    root = output / "evaluations" / f"cycle-{cycle:05d}"
    root.mkdir(parents=True, exist_ok=True)
    snapshot = root / "checkpoint.pt"
    if not snapshot.exists():
        temporary = snapshot.with_suffix(".tmp")
        shutil.copyfile(checkpoint, temporary)
        os.replace(temporary, snapshot)
    checkpoint_hash = digest(snapshot)
    if digest(checkpoint) != checkpoint_hash:
        raise ValueError("Training checkpoint changed during a pending evaluation cycle")
    checkpoint = snapshot
    ledger = root / "results.json"
    results = json.loads(ledger.read_text()) if ledger.is_file() else []
    total = 3 * config.evaluation_games_per_matchup
    if not isinstance(results, list) or len(results) > total:
        raise ValueError("Invalid saved evaluation ledger")
    for index, item in enumerate(results):
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            raise ValueError("Invalid saved evaluation ledger record")
        folder = Path(item["path"]).resolve()
        prefix = f"game-{index:03d}-attempt-"
        if folder.parent != root.resolve() or not folder.name.startswith(prefix) or not folder.name[len(prefix):].isdigit():
            raise ValueError("Saved evaluation path is outside its expected cycle/game")
        expected = _evaluation_result(folder, config, state, checkpoint_hash, index)
        if item != expected:
            raise ValueError("Saved evaluation ledger does not match the current checkpoint/curriculum")
    for index in range(len(results), total):
        race_index = index % 3
        matchup = state["matchups"][MATCHUPS[race_index]]
        outcome_folder = []

        def job(attempt):
            # An interrupted/failed evaluation may leave partial artifacts.
            # A unique attempt folder avoids overwriting any of that evidence.
            sequence = 0
            while ((root / f"game-{index:03d}-attempt-{sequence:03d}").exists()
                   or (root / f"game-{index:03d}-attempt-{sequence:03d}.log").exists()):
                sequence += 1
            folder = root / f"game-{index:03d}-attempt-{sequence:03d}"
            outcome_folder[:] = [folder]
            command = _base_command(config) + [
                "evaluate", "--checkpoint", str(checkpoint), "--output", str(folder), "--games", "1",
                "--map", config.maps[(index // 3) % len(config.maps)], "--opponent-race", RACES[race_index],
                "--difficulty", DIFFICULTIES[matchup["difficulty_index"]],
                "--seed", str(1_000_000_000 + cycle * total + index),
                "--max-game-seconds", str(config.max_game_seconds), "--device", config.device,
            ]
            return command, folder.with_suffix(".log")

        if not _run_with_retries(output, config, state, job, execute):
            return None
        folder = outcome_folder[0]
        item = _evaluation_result(folder, config, state, checkpoint_hash, index)
        if digest(checkpoint) != checkpoint_hash:
            raise ValueError("Evaluation checkpoint changed")
        results.append(item)
        write_json(ledger, results)
    return results


def apply_evaluation(state, results, games_per_matchup):
    if type(games_per_matchup) is not int or games_per_matchup < 1:
        raise ValueError("Evaluation games per matchup must be a positive integer")
    if not isinstance(results, list) or len(results) != 3 * games_per_matchup:
        raise ValueError("Incomplete matchup evaluation; cannot promote")
    for item in results:
        if (not isinstance(item, dict) or item.get("matchup") not in MATCHUPS
                or item.get("result") not in ("Victory", "Defeat", "Tie")
                or type(item.get("time_limit_reached")) is not bool):
            raise ValueError("Invalid matchup evaluation; cannot promote")
    grouped = {key: [r for r in results if r["matchup"] == key] for key in MATCHUPS}
    if any(len(matches) != games_per_matchup for matches in grouped.values()):
        raise ValueError("Incomplete matchup evaluation; cannot promote")
    improved = False
    for key in MATCHUPS:
        matches = grouped[key]
        wins = sum(r["result"] == "Victory" and not r["time_limit_reached"] for r in matches)
        entry = state["matchups"][key]
        improved |= wins > entry["best_wins"]
        entry.update(last_wins=wins, last_games=len(matches),
                     last_time_limits=sum(r["time_limit_reached"] for r in matches),
                     evaluation_games=entry["evaluation_games"] + len(matches),
                     best_wins=max(wins, entry["best_wins"]))
        # This is an engineering curriculum gate, not a statistical MMR claim.
        entry["promotion_streak"] = entry["promotion_streak"] + 1 if wins == len(matches) else 0
        if entry["promotion_streak"] >= 2 and entry["difficulty_index"] < len(DIFFICULTIES) - 1:
            entry.update(difficulty_index=entry["difficulty_index"] + 1, promotion_streak=0, best_wins=-1)
            improved = True
    state["stagnant_cycles"] = 0 if improved else state["stagnant_cycles"] + 1
    state["completed_cycles"] += 1


def run(output, *, max_new_games=None, acknowledge_review=False, execute=execute_child):
    if max_new_games is not None and (type(max_new_games) is not int or max_new_games < 1):
        raise ValueError("max_new_games must be a positive integer or None")
    output = Path(output).resolve()
    with FileLock(str(output / ".campaign.lock"), timeout=0):
        config, extra, state = _read(output)
        if state["status"] == "needs_review" and not acknowledge_review:
            raise ValueError("Campaign needs review; diagnose its recorded reason before --acknowledge-review")
        if acknowledge_review:
            state["stagnant_cycles"] = 0
            state.pop("reason", None)
        checkpoint = reconcile(output, extra, state)
        start_total = state["new_training_games"]
        pid = psutil.Process()
        state.update(pid=pid.pid, process_created_at=pid.create_time(), status="running", updated_at=utcnow())
        write_json(output / "state.json", state)
        try:
            while not (output / "STOP").exists():
                checkpoint = reconcile(output, extra, state)
                if max_new_games is not None and state["new_training_games"] - start_total >= max_new_games:
                    state["status"] = "batch_complete"
                    break
                if shutil.disk_usage(output).free < config.min_free_gb * 1024**3:
                    state.update(status="needs_review", reason="Free disk space below configured minimum")
                    break
                if state["new_training_games"] < state["cycle_training_target"]:
                    before = state["new_training_games"]

                    def job(attempt):
                        current = reconcile(output, extra, state)
                        if state["new_training_games"] != before:
                            raise ValueError("Child committed a checkpoint but exited unexpectedly; review before retry")
                        sequence = attempt
                        while (output / "logs" / f"train-{before + 1:07d}-attempt-{sequence}.log").exists():
                            sequence += 1
                        return (training_command(output, config, extra, state, current),
                                output / "logs" / f"train-{before + 1:07d}-attempt-{sequence}.log")

                    if not _run_with_retries(output, config, state, job, execute):
                        break
                    checkpoint = reconcile(output, extra, state)
                    if state["new_training_games"] != before + 1:
                        raise ValueError("Training child did not commit exactly one game")
                else:
                    results = evaluate_cycle(output, config, state, checkpoint, execute)
                    if results is None:
                        break
                    apply_evaluation(state, results, config.evaluation_games_per_matchup)
                    state["cycle_training_target"] += config.training_games_per_cycle
                    if state["stagnant_cycles"] >= config.review_after_stagnant_cycles:
                        state.update(status="needs_review", reason="Curriculum plateau; inspect behavior before more identical training")
                        break
                state["updated_at"] = utcnow()
                write_json(output / "state.json", state)
            else:
                state["status"] = "stopped"
            if (output / "STOP").exists():
                state["status"] = "stopped"
        except BaseException as error:
            state.update(status="failed", error=f"{type(error).__name__}: {error}")
            raise
        finally:
            state["updated_at"] = utcnow()
            write_json(output / "state.json", state)
        return state


def status(output):
    output = Path(output).resolve()
    config, extra, state = _read(output)
    checkpoint = reconcile(output, extra, state)
    active = False
    try:
        process = psutil.Process(state.get("pid", -1))
        active = process.create_time() == state.get("process_created_at") and process.is_running()
    except (psutil.Error, ValueError):
        pass
    state.update(process_running=active, region=config.region, target_mmr=config.target_mmr,
                 measured_mmr=None, rating_status="unrated", checkpoint=str(checkpoint),
                 checkpoint_sha256=digest(checkpoint), stop_requested=(output / "STOP").exists())
    for entry in state["matchups"].values():
        entry["difficulty"] = DIFFICULTIES[entry["difficulty_index"]]
    return state


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    init = sub.add_parser("init")
    init.add_argument("--checkpoint", required=True)
    init.add_argument("--maps", nargs="+", required=True)
    init.add_argument("--region", choices=("NA", "EU", "KR"))
    init.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    init.add_argument("--training-games-per-cycle", type=int, default=30)
    init.add_argument("--evaluation-games-per-matchup", type=int, default=3)
    init.add_argument("--threads", type=int, default=4)
    start = sub.add_parser("run")
    start.add_argument("--max-new-games", type=int)
    start.add_argument("--acknowledge-review", action="store_true")
    sub.add_parser("status")
    sub.add_parser("stop")
    for item in sub.choices.values():
        item.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    if args.command == "init":
        config = CampaignConfig(maps=tuple(str(Path(p).resolve()) for p in args.maps), region=args.region,
                                device=args.device, threads=args.threads,
                                training_games_per_cycle=args.training_games_per_cycle,
                                evaluation_games_per_matchup=args.evaluation_games_per_matchup)
        result = initialize(args.output, args.checkpoint, config)
    elif args.command == "run":
        if args.max_new_games is not None and args.max_new_games < 1:
            parser.error("--max-new-games must be positive")
        result = run(args.output, max_new_games=args.max_new_games, acknowledge_review=args.acknowledge_review)
    elif args.command == "stop":
        output = Path(args.output).resolve()
        _read(output)
        (output / "STOP").write_text("User requested a stop after the current game.\n")
        result = {"stop_requested": True, "output": str(output)}
    else:
        result = status(args.output)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
