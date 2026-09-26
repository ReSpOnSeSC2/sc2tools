"""Bounded child jobs, periodic independent evaluation, and durable league progress."""
from __future__ import annotations

import argparse
from copy import deepcopy
import json
from pathlib import Path
import shutil
import sys
import uuid

from filelock import FileLock
import psutil

from pluto_sc2 import league
from pluto_sc2.campaign import CampaignConfig, DIFFICULTIES, MATCHUPS, RACES, apply_evaluation, evaluate_cycle, execute_child, utcnow
from pluto_sc2.runner import append_json, write_json


class _EvaluationStopped(Exception):
    """Stop between evaluation children without treating it as a retryable failure."""


def _current_league(league_path, state):
    current = league._state(league_path)
    if current["games"] < state["league_games"]:
        raise ValueError("League manifest is older than the supervisor's committed game counter")
    return current


def initialize(output, league_path, maps, *, games_per_cycle=30, eval_games=3, region=None):
    output, league_path = Path(output).resolve(), Path(league_path).resolve()
    config = CampaignConfig(maps=tuple(str(Path(p).resolve()) for p in maps), region=region,
                            training_games_per_cycle=games_per_cycle, evaluation_games_per_matchup=eval_games)
    if games_per_cycle % len(league.SCHEDULE):
        raise ValueError("League review cycles must contain whole five-game race schedules")
    output.mkdir(parents=True, exist_ok=True)
    with FileLock(str(output / ".supervisor.lock"), timeout=0):
        if any(p.name != ".supervisor.lock" for p in output.iterdir()):
            raise ValueError("Supervisor output must be empty")
        state = league._state(league_path)
        from dataclasses import asdict
        write_json(output / "config.json", {"schema": 1, "league": str(league_path), **asdict(config)})
        progress = {"schema": 1, "status": "ready", "completed_cycles": 0, "stagnant_cycles": 0,
                    "next_review_game": state["games"] + games_per_cycle, "league_games": state["games"],
                    "created_at": utcnow(), "matchups": {key: {
                        "difficulty_index": 0, "promotion_streak": 0, "best_wins": -1,
                        "evaluation_games": 0, "measured_mmr": None, "rating_status": "unrated",
                    } for key in MATCHUPS}}
        write_json(output / "state.json", progress)
    return progress


def _read(output):
    raw = json.loads((output / "config.json").read_text())
    if raw.pop("schema") != 1:
        raise ValueError("Unknown supervisor schema")
    league_path = Path(raw.pop("league"))
    raw["maps"] = tuple(raw["maps"])
    config = CampaignConfig(**raw)
    state = json.loads((output / "state.json").read_text())
    if state.get("schema") != 1:
        raise ValueError("Unknown supervisor state schema")
    return league_path, config, state


def run(output, *, max_new_games=None, acknowledge_review=False, execute=execute_child):
    output = Path(output).resolve()
    if max_new_games is not None and (type(max_new_games) is not int or max_new_games < 1):
        raise ValueError("Batch size must be positive")
    with FileLock(str(output / ".supervisor.lock"), timeout=0):
        league_path, config, state = _read(output)
        if state["status"] == "needs_review" and not acknowledge_review:
            raise ValueError("Inspect the recorded review reason before continuing")
        if acknowledge_review:
            state["stagnant_cycles"] = 0
            state.pop("reason", None)
        initial_games = _current_league(league_path, state)["games"]
        process = psutil.Process()
        state.pop("error", None)
        state.update(pid=process.pid, process_created_at=process.create_time(), status="running", updated_at=utcnow())
        write_json(output / "state.json", state)
        try:
            while not (output / "STOP").exists() and not (league_path / "STOP").exists():
                current = _current_league(league_path, state)
                state["league_games"] = current["games"]
                if shutil.disk_usage(output).free < config.min_free_gb * 1024**3:
                    state.update(status="needs_review", reason="Free disk space below configured minimum")
                    break
                if current["games"] >= state["next_review_game"]:
                    # Prevent any other local training job changing the main
                    # policy while this held-out evaluation cycle is pending.
                    with FileLock(str(league_path / ".league.lock"), timeout=0):
                        current = _current_league(league_path, state)
                        entry = current["snapshots"]["Protoss"][-1]
                        checkpoint = league._verified_path(league_path, entry)

                        def evaluation_child(command, log, timeout):
                            if (output / "STOP").exists() or (league_path / "STOP").exists():
                                raise _EvaluationStopped()
                            execute(command, log, timeout)

                        try:
                            results = evaluate_cycle(output, config, state, checkpoint, evaluation_child)
                        except _EvaluationStopped:
                            results = None
                        if results is None:
                            break
                        # If writing the league curriculum fails, keep the
                        # supervisor's old review state. Its completed ledger
                        # can then be reapplied without replaying evaluations.
                        reviewed = deepcopy(state)
                        apply_evaluation(reviewed, results, config.evaluation_games_per_matchup)
                        reviewed["next_review_game"] += config.training_games_per_cycle
                        if current.get("builtin_practice") is not None:
                            current["builtin_practice"] = {race: DIFFICULTIES[reviewed["matchups"][key]["difficulty_index"]]
                                                           for race, key in zip(RACES, MATCHUPS)}
                            write_json(league_path / "state.json", current)
                        state = reviewed
                    if state["stagnant_cycles"] >= config.review_after_stagnant_cycles:
                        state.update(status="needs_review", reason="No evaluation improvement; inspect behavior and training design")
                        break
                elif max_new_games is not None and current["games"] - initial_games >= max_new_games:
                    state["status"] = "batch_complete"
                    break
                else:
                    before = current["games"]
                    command = [sys.executable, "-u", "-m", "pluto_sc2.league", "--threads", str(config.threads),
                        "train", "--output", str(league_path), "--maps", *config.maps, "--games", "1",
                        "--max-game-seconds", str(config.max_game_seconds), "--device", config.device]
                    for attempt in range(3):
                        if (output / "STOP").exists() or (league_path / "STOP").exists():
                            break
                        log = output / "logs" / f"game-{before + 1:07d}-{uuid.uuid4().hex[:10]}.log"
                        state.update(last_log=str(log), last_job=command, updated_at=utcnow())
                        write_json(output / "state.json", state)
                        try:
                            execute(command, log, config.child_timeout_seconds)
                        except Exception as error:
                            append_json(output / "failures.jsonl", {"at": utcnow(), "error": str(error),
                                        "attempt": attempt + 1, "log": str(log)})
                            after = league._state(league_path)["games"]
                            if after == before + 1:
                                break  # A committed update is never replayed.
                            if after != before or attempt == 2:
                                raise
                            continue
                        after = league._state(league_path)["games"]
                        if after != before + 1 and not (league_path / "STOP").exists():
                            raise ValueError("League child did not commit exactly one game")
                        break
                state["updated_at"] = utcnow()
                write_json(output / "state.json", state)
            if (output / "STOP").exists() or (league_path / "STOP").exists():
                state["status"] = "stopped"
        except BaseException as error:
            state.update(status="failed", error=f"{type(error).__name__}: {error}")
            raise
        finally:
            state.update(updated_at=utcnow(), league_games=max(state["league_games"], league._state(league_path)["games"]))
            write_json(output / "state.json", state)
    return state


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    init = commands.add_parser("init")
    init.add_argument("--league", required=True)
    init.add_argument("--maps", required=True, nargs="+")
    init.add_argument("--region", choices=("NA", "EU", "KR"))
    commands.add_parser("status")
    commands.add_parser("stop")
    start = commands.add_parser("run")
    start.add_argument("--max-new-games", type=int)
    start.add_argument("--acknowledge-review", action="store_true")
    for item in commands.choices.values():
        item.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    if args.command == "init":
        result = initialize(args.output, args.league, args.maps, region=args.region)
    elif args.command == "run":
        result = run(args.output, max_new_games=args.max_new_games, acknowledge_review=args.acknowledge_review)
    else:
        output = Path(args.output).resolve()
        league_path, config, result = _read(output)
        if args.command == "stop":
            (output / "STOP").write_text("User requested a stop after the current game.\n")
        result.update(league_games=league._state(league_path)["games"], measured_mmr=None,
                      rating_status="unrated", target_mmr=config.target_mmr,
                      stop_requested=(output / "STOP").exists() or (league_path / "STOP").exists())
        try:
            process = psutil.Process(result.get("pid", -1))
            active = process.is_running() and process.create_time() == result.get("process_created_at")
        except (psutil.Error, ValueError):
            active = False
        result["process_running"] = active
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
