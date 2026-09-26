"""Authorized local pipeline: replay-build bootstrap, league, then supervision.

Run as a hidden background process. Each expensive stage writes resumable
artifacts. This script does not claim a rating or purchase remote compute.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sys
import threading
import time
import uuid

from filelock import FileLock
import psutil

from pluto_sc2.campaign import execute_child, utcnow
from pluto_sc2.league import sha256
from pluto_sc2.runner import write_json


def run(root, *, training_games=12, validation_games=6):
    root = Path(root).resolve()
    output = root / "runs" / "training-pipeline"
    output.mkdir(parents=True, exist_ok=True)
    cpu = root / ".venv" / "Scripts" / "python.exe"
    gpu = root / ".venv-gpu" / "Scripts" / "python.exe"
    builds = root / "runs" / "response90-opponent-builds.json"
    protoss = root / "runs" / "response90-imitation.pt"
    protoss_metrics = protoss.with_suffix(".metrics.json")
    race_checkpoints = {race: root / "runs" / f"response90-{race.lower()}-imitation.pt" for race in ("Terran", "Zerg")}
    league = root / "runs" / "response-league"
    monitor = root / "runs" / "response-league-monitor"
    maps = [str(root / "maps" / (name + ".SC2Map")) for name in
            ("SanctuaryIIILE", "TourmalineLE", "BlackrockLE", "RainfallLE")]
    process = psutil.Process()
    state = {"schema": 1, "status": "running", "pid": process.pid,
             "process_created_at": process.create_time(), "started_at": utcnow(), "stages": {}}
    mutex = threading.Lock()

    def progress(key, value):
        with mutex:
            state["stages"][key] = value
            state["updated_at"] = utcnow()
            write_json(output / "state.json", state)

    def stopped():
        return any(path.exists() for path in (output / "STOP", league / "STOP", monitor / "STOP"))

    def job(key, command, timeout):
        if stopped():
            raise InterruptedError("Persistent STOP marker is set")
        command = [str(item) for item in command]
        log = output / "logs" / f"{key}-{uuid.uuid4().hex[:10]}.log"
        progress(key, {"status": "running", "command": command, "log": str(log)})
        execute_child(command, log, timeout)
        progress(key, {"status": "complete", "log": str(log)})

    def checkpoint_complete(path):
        metrics = path.with_suffix(".metrics.json")
        if not path.exists() and not metrics.exists():
            return False
        if not (path.exists() and metrics.exists()):
            raise ValueError(f"Partial imitation fit requires inspection before resuming: {path}")
        report = json.loads(metrics.read_text())
        if report.get("sha256") != sha256(path):
            raise ValueError(f"Completed imitation checkpoint digest changed: {path}")
        return True

    def race_pipeline(race):
        destination = root / "runs" / ("response90-" + race.lower() + "-teachers")
        for partition, count, map_name in (("train", training_games, maps[0]),
                                             ("validation", validation_games, maps[1])):
            job(f"{race}-{partition}", [cpu, "-u", "-m", "pluto_sc2.bootstrap", "--threads", "2", "collect",
                "--builds", builds, "--race", race, "--partition", partition, "--games", count,
                "--output", destination / partition, "--map", map_name, "--max-game-seconds", "360",
                "--user-loss-weight", "2", "--max-apm", "600", "--seed", "1"], 10800)
        checkpoint = race_checkpoints[race]
        if not checkpoint_complete(checkpoint):
            job(f"{race}-fit", [gpu, "-u", "-m", "pluto_sc2.bootstrap", "--threads", "4", "fit",
                "--race", race, "--training", destination / "train" / "dataset.npz",
                "--validation", destination / "validation" / "dataset.npz", "--output", checkpoint,
                "--epochs", "30", "--hidden-dim", "256", "--device", "cuda"], 1800)
        if not checkpoint_complete(checkpoint):
            raise ValueError("Imitation fit returned without complete artifacts")

    with FileLock(str(output / ".pipeline.lock"), timeout=0):
        write_json(output / "state.json", state)
        try:
            corpus = json.loads(builds.read_text())
            if corpus["protoss_split"].get("stratify_outcomes") is not True:
                raise ValueError("Wait for the final matchup-and-outcome-stratified build corpus")
            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(race_pipeline, race) for race in ("Terran", "Zerg")]
                for future in futures:
                    future.result()
            deadline = time.monotonic() + 7200
            progress("Protoss", {"status": "waiting_for_fresh_imitation", "checkpoint": str(protoss)})
            while not protoss_metrics.is_file():
                if stopped() or time.monotonic() > deadline:
                    raise InterruptedError("Stopped or timed out waiting for Protoss imitation completion")
                time.sleep(5)
            if not protoss.is_file():
                raise ValueError("Protoss imitation completion has no checkpoint")
            progress("Protoss", {"status": "complete", "checkpoint": str(protoss), "sha256": sha256(protoss)})
            if not (league / "state.json").exists():
                job("league-init", [cpu, "-m", "pluto_sc2.league", "init", "--output", league,
                    "--protoss", protoss, "--terran", race_checkpoints["Terran"], "--zerg", race_checkpoints["Zerg"],
                    "--adversary-apm", "600", "--builtin-practice"], 120)
            if not (monitor / "state.json").exists():
                job("monitor-init", [cpu, "-m", "pluto_sc2.league_supervisor", "init", "--output", monitor,
                    "--league", league, "--maps", *maps], 120)
            active_path = root / "TRAINING_ACTIVE.json"
            active = json.loads(active_path.read_text())
            active.update(phase="three_race_reinforcement_learning", league=str(league), supervisor=str(monitor),
                          pipeline=str(output), protoss_checkpoint=str(protoss),
                          terran_initial_checkpoint=str(race_checkpoints["Terran"]),
                          zerg_initial_checkpoint=str(race_checkpoints["Zerg"]),
                          notes=["Read the league and supervisor manifests for committed progress and current checkpoint paths.",
                                 "Preserve every STOP marker. Standard evaluation and asymmetric training remain separate."])
            write_json(active_path, active)
            job("league-supervision", [cpu, "-u", "-m", "pluto_sc2.league_supervisor", "run", "--output", monitor], 7 * 86400)
            state["status"] = "supervisor_returned"
        except BaseException as error:
            state.update(status="stopped" if isinstance(error, InterruptedError) or stopped() else "failed",
                         error=f"{type(error).__name__}: {error}")
            raise
        finally:
            state["updated_at"] = utcnow()
            write_json(output / "state.json", state)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--training-games", type=int, default=12)
    parser.add_argument("--validation-games", type=int, default=6)
    args = parser.parse_args()
    try:
        run(args.workspace, training_games=args.training_games, validation_games=args.validation_games)
    except Exception as error:
        print(f"Training pipeline needs inspection: {error}", file=sys.stderr)
        raise
