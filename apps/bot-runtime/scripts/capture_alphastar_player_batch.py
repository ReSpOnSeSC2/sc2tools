"""Prepare or explicitly run five immutable player-perspective captures; no training."""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time

import psutil
from filelock import FileLock

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = "alphastar-player-expansion-batch-v1"
MAX_WALL = 1500
# Current frozen native collector opens a window; hidden child Python alone does
# not establish the user's required no-foreground SC2 behavior. No CLI bypass.
BACKGROUND_NATIVE_LAUNCH_VERIFIED = False
def default_agent_state_path():
    local_appdata = os.environ.get("LOCALAPPDATA")
    base = Path(local_appdata) if local_appdata else Path.home() / "AppData" / "Local"
    return base / "sc2tools" / "agent.json"


AGENT_STATE = default_agent_state_path()
SELECTED = (
    ("b775da30c7b9fc23465b97257326937728f4ae9143e8f973bfde1bb3d2e30634", "train", "PvP"),
    ("86b7fe43c4943f1ec34736c540f4ddf3dbf1bcc2db1074cefa4c474233b92c94", "train", "PvZ"),
    ("f478fa1d96cb0b4c9a0accb3b614b64f5b064c84d99cceb4154de8338173c10f", "validation", "PvT"),
    ("c3ccbdfed7b7e66d36dbcc9092a3c3982eb0994623e37b686dd88a0ba89403e6", "validation", "PvP"),
    ("739e155ee05505a3d8628c79712a705a0e7b31be439453244c0b88e47a148c05", "validation", "PvZ"),
)


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read_json(path, limit=8 * 1024 * 1024):
    with Path(path).open("rb") as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise ValueError("JSON input exceeds size bound")
    result = json.loads(data)
    if not isinstance(result, dict):
        raise ValueError("Expected JSON object")
    return result


def write_json(path, value, *, fresh=False):
    path = Path(path)
    if fresh:
        with path.open("x", encoding="utf-8") as stream:
            json.dump(value, stream, indent=2, allow_nan=False)
        return
    pending = path.with_suffix(".pending")
    pending.write_text(json.dumps(value, indent=2, allow_nan=False), encoding="utf-8")
    pending.replace(path)


def partition_map(value):
    groups = value["split"]["matchups"].values() if "split" in value else [value]
    result = {}
    for group in groups:
        for part in ("train", "validation"):
            for row in group[part + "_replay_ids"]:
                rid = row if isinstance(row, str) else row["replay_id"]
                if rid in result:
                    raise ValueError("Duplicate or mixed whole-replay partition")
                result[rid] = part
    return result


def unchanged(hashes):
    for path, expected in hashes.items():
        if digest(path) != expected:
            raise ValueError(f"Pinned input changed: {path}")


def prepare(output):
    output = Path(output).resolve()
    if output.exists():
        raise FileExistsError("Plan output must be fresh")
    manifest_path = ROOT / "runs/response-90-manifest.json"
    split_path = ROOT / "runs/response90-replay-split.json"
    cli_split_path = ROOT / "runs/response90-imitation.summary.json"
    agent_path = ROOT / "runs/replay-expansion-inventory-v1/agent-process.json"
    candidates_paths = [ROOT / f"runs/replay-candidates-{m}.json" for m in ("PvT", "PvP", "PvZ")]
    baseline = ROOT / "runs/alphastar-rich-pilot-v3"
    source_paths = [Path(__file__), manifest_path, split_path, cli_split_path, agent_path, *candidates_paths,
        ROOT / "scripts/review_rich_capture.py", *[ROOT / "src/pluto_sc2" / f"{n}.py" for n in (
            "rich_replays", "rich_actions", "rich_intents", "rich_dataset", "fairplay", "runner", "replays")],
        *[baseline / name for name in ("capture.json", "frames.jsonl.gz", "actions.jsonl.gz",
                                      "game-data.json", "game-info.json")]]
    hashes = {str(p.resolve()): digest(p) for p in source_paths}
    corpus, direct, cli = map(read_json, (manifest_path, split_path, cli_split_path))
    membership = partition_map(direct)
    if (not corpus.get("complete") or membership != partition_map(cli)
            or Counter(membership.values()) != {"train": 72, "validation": 18}):
        raise ValueError("Original 72/18 split is not verified")
    by_id = {row["replay_id"]: row for row in corpus["replays"]}
    site = {row["gameId"]: row for path in candidates_paths for row in read_json(path)["items"]}
    selected = []
    for rid, part, matchup in SELECTED:
        row = dict(by_id[rid])
        if (membership[rid] != part or row["matchup"] != matchup or row["starting_workers"] != 8
                or row["base_build"] != 97563 or row["result"] != "Victory" or digest(row["path"]) != rid):
            raise ValueError("Candidate original/partition/metadata differs from audited choice")
        hashes[str(Path(row["path"]).resolve())] = rid
        labels = site[row["source_game_id"]]
        selected.append({**row, "partition": part, "site_build_label": labels["myBuild"],
            "opponent_site_label": labels.get("opponent", {}).get("strategy"),
            "site_labels_are_metadata_not_native_supervision": True,
            "max_game_seconds": math.ceil(row["duration_seconds"]) + 30,
            "capture_name": f"{part}-{matchup.lower()}-{rid[:12]}", "capture_status": "not_started",
            "supervision_identity": [rid, row["player_id"], "native_action_ordinal_after_capture"]})
    base_meta = read_json(baseline / "capture.json")
    if (base_meta.get("status") != "captured_full_replay" or base_meta.get("partition") != "train"
            or membership.get(base_meta["replay"]["replay_id"]) != "train"):
        raise ValueError("Existing PvT capture must remain complete TRAIN")
    agent = read_json(agent_path)
    count = Counter((row["matchup"], membership[row["replay_id"]], row["result"]) for row in corpus["replays"])
    value = {"schema": SCHEMA, "status": "prepared", "created_at": datetime.now(timezone.utc).isoformat(),
        "candidates": selected, "source_hashes": hashes,
        "split": {"path": str(split_path), "cli_path": str(cli_split_path),
                  "memberships": membership, "whole_replays": 90, "train": 72, "validation": 18,
                  "cli_split_identical": True, "counts": {"/".join(k): v for k, v in sorted(count.items())}},
        "manifest_path": str(manifest_path), "baseline_capture": str(baseline),
        "agent": {"state_path": str(AGENT_STATE), "pid": agent["pid"],
                  "process_created_at": datetime.fromisoformat(agent["created_at"]).timestamp()},
        "max_wall_seconds": MAX_WALL, "max_per_capture_seconds": 420, "step_mul": 1,
        "native_launch_eligible": False,
        "launch_blocker": "Current collector's no-foreground native launch is not verified; prepare only",
        "actor_contract": {"player_perspective": True, "disable_fog": False, "camera_restricted": True,
                           "starting_workers": 8, "expert_labels_never_actor_inputs": True},
        "models_trained": False, "active_corpus_modified": False, "eligible_for_training": False,
        "next_gates": ["Full native capture and wire/causal fidelity per replay",
                       "Immutable separate TRAIN/validation intent derivatives",
                       "Every-row tensor/function/argument-mask proof under current model capacity",
                       "New multi-replay trainer contract; validation has zero optimizer exposure",
                       "Unweighted evaluation per matchup and replay; no MMR claim"]}
    unchanged(hashes)
    output.mkdir(parents=True)
    write_json(output / "manifest.json", value, fresh=True)
    return value


def verified_process(pid, created):
    try:
        process = psutil.Process(pid)
        if abs(process.create_time() - created) > 0.01:
            raise RuntimeError("Process ID reused; refusing process action")
        return process
    except psutil.NoSuchProcess:
        return None


def engines():
    return [p for p in psutil.process_iter(["name"])
            if (p.info.get("name") or "").lower() in {"sc2_x64.exe", "sc2_x64"}]


def require_paused_agent(agent):
    if verified_process(agent["pid"], agent["process_created_at"]) is None:
        raise RuntimeError("The pinned SC2TOOLS agent is no longer running")
    # Never return/log the local state object, which can contain credentials.
    if read_json(agent["state_path"], limit=32 * 1024 * 1024).get("paused") is not True:
        raise RuntimeError("SC2TOOLS agent must remain paused")


def check_stop_deadline(stops, deadline, *, now=None):
    if any(Path(path).exists() for path in stops):
        raise InterruptedError("STOP marker respected")
    if (time.monotonic() if now is None else now) >= deadline:
        raise TimeoutError("Bounded capture/derivation wall deadline reached")


def owned_engines(child_pid, child_created, observed):
    child = verified_process(child_pid, child_created)
    descendants = {} if child is None else {p.pid: p.create_time() for p in child.children(recursive=True)}
    for engine in engines():
        created = engine.create_time()
        identity = (engine.pid, created)
        if descendants.get(engine.pid) != created and identity not in observed:
            raise RuntimeError("Unowned SC2 engine appeared; refusing concurrent capture")
        observed.add(identity)
    return observed


def stop_owned(child, created, observed):
    # Only identities proved descendants of our child may be terminated.
    parent = verified_process(child.pid, created)
    if parent is not None:
        for descendant in parent.children(recursive=True):
            if descendant.name().lower() in {"sc2_x64.exe", "sc2_x64"}:
                observed.add((descendant.pid, descendant.create_time()))
    for pid, stamp in [*sorted(observed), (child.pid, created)]:
        process = verified_process(pid, stamp)
        if process is not None:
            process.terminate()


def run_child(argv, *, log, agent, stops, deadline, capture_dir=None):
    require_paused_agent(agent)
    check_stop_deadline(stops, deadline)
    if engines():
        raise RuntimeError("SC2 engine already active; no process launched")
    observed = set()
    child = None
    created = None
    with Path(log).open("xb") as stream:
        try:
            import os
            environment = {**os.environ, "PYTHONPATH": str(ROOT / "src")}
            child = subprocess.Popen(argv, cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT, env=environment,
                shell=False, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            created = psutil.Process(child.pid).create_time()
            write_json(Path(log).with_suffix(".process.json"), {"pid": child.pid,
                "process_created_at": created, "argv": argv, "started_unix": time.time()}, fresh=True)
            while child.poll() is None:
                check_stop_deadline(stops, deadline)
                require_paused_agent(agent)
                owned_engines(child.pid, created, observed)
                time.sleep(min(.25, max(0, deadline - time.monotonic())))
            owned_engines(child.pid, created, observed)
            if child.returncode != 0 or engines():
                raise RuntimeError(f"Child failed or left an engine running: exit={child.returncode}")
            check_stop_deadline(stops, deadline)
            return {"pid": child.pid, "process_created_at": created, "exit_code": child.returncode,
                    "owned_engines": [list(x) for x in sorted(observed)]}
        except BaseException:
            if capture_dir is not None and Path(capture_dir).is_dir():
                marker = Path(capture_dir) / "STOP"
                if not marker.exists():
                    marker.write_text("Bounded batch stopped; preserve all partial artifacts.\n")
            if child is not None and created is not None:
                stop_owned(child, created, observed)
            raise


def capture_gate(directory, row):
    value = read_json(Path(directory) / "capture.json")
    if (value.get("status") != "captured_full_replay" or value.get("full_replay") is not True
            or value.get("engine_start_workers") != 8 or value.get("original_replay_unchanged") is not True
            or value.get("player_id") != row["player_id"] or value.get("partition") != row["partition"]
            or value.get("replay", {}).get("replay_id") != row["replay_id"]
            or value.get("step_mul") != 1
            or value.get("rules") != {"start_workers": 8, "max_apm": 200,
                                      "camera_restricted": True, "fog": True}
            or set(value.get("artifacts", {})) != {"frames.jsonl.gz", "actions.jsonl.gz",
                                                  "game-data.json", "game-info.json"}):
        raise ValueError("Capture is partial, failed, or differs from pinned perspective")
    unchanged({str(Path(directory) / name): sha for name, sha in value["artifacts"].items()})
    return value


def derivative_gate(directory, partition, expected_ids):
    value = read_json(Path(directory) / "manifest.json")
    if (value.get("status") != "complete" or value.get("eligible_for_training") is not True
            or value.get("source_artifacts_unchanged") is not True
            or value.get("replay_partitions") != dict.fromkeys(expected_ids, partition)
            or value.get("models_trained") is not False
            or value.get("counts", {}).get(partition + "_samples", 0) <= 0
            or value.get("counts", {}).get(("validation" if partition == "train" else "train") + "_samples", 0)):
        raise ValueError("Derivative mixed partitions, lost a replay, or failed provenance")
    for name, key in (("samples.jsonl.gz", "samples_sha256"), ("action-admission.jsonl.gz", "admission_sha256")):
        if digest(Path(directory) / name) != value[key]:
            raise ValueError("Derivative hash changed")
    return value


def run(plan_path, plan_sha256, output, *, wall_seconds=MAX_WALL):
    plan_path, output = Path(plan_path).resolve(), Path(output).resolve()
    if not 1 <= wall_seconds <= MAX_WALL or not math.isfinite(wall_seconds):
        raise ValueError("Wall budget must be1..1500 seconds")
    if digest(plan_path) != plan_sha256 or output.exists():
        raise ValueError("Pinned plan hash mismatch or execution output already exists")
    plan = read_json(plan_path)
    if (plan.get("schema") != SCHEMA or [(r["replay_id"], r["partition"], r["matchup"])
            for r in plan["candidates"]] != list(SELECTED)):
        raise ValueError("Only the five audited captures are supported")
    if not BACKGROUND_NATIVE_LAUNCH_VERIFIED:
        raise RuntimeError("Prepared only: no-foreground native launch must be implemented and verified first")
    hashes = {**plan["source_hashes"], str(plan_path): plan_sha256}
    stops = [ROOT / "STOP", output / "STOP", plan_path.parent / "STOP",
             ROOT / "runs/response-league/STOP", ROOT / "runs/response-league-monitor/STOP",
             ROOT / "runs/replay-expansion-inventory-v1/STOP"]
    started = time.monotonic()
    deadline = started + wall_seconds
    check_stop_deadline(stops, deadline)
    unchanged(hashes)
    require_paused_agent(plan["agent"])
    if engines():
        raise RuntimeError("SC2 engine already active")
    with FileLock(str(ROOT / "runs/.alphastar-native-preview.lock"), timeout=0):
        check_stop_deadline(stops, deadline)
        output.mkdir(parents=True)
        proc = psutil.Process()
        state = {"schema": SCHEMA, "status": "running", "pid": proc.pid,
            "process_created_at": proc.create_time(), "started_unix": time.time(), "max_wall_seconds": wall_seconds,
            "manifest_sha256": plan_sha256, "captures": [], "derivatives": {}, "models_trained": False,
            "active_corpus_modified": False, "eligible_for_training": False,
            "next_gate": "Per-row tensor and mask admission plus new multi-replay trainer contract"}
        write_json(output / "launch.json", state, fresh=True)
        try:
            captures = {"train": [Path(plan["baseline_capture"])], "validation": []}
            for row in plan["candidates"]:
                unchanged(hashes)
                directory = output / row["capture_name"]
                argv = [sys.executable, "-m", "pluto_sc2.rich_replays", "--manifest", plan["manifest_path"],
                    "--split-summary", plan["split"]["cli_path"], "--replay-id", row["replay_id"],
                    "--output", str(directory), "--seconds", str(row["max_game_seconds"]), "--step-mul", "1"]
                receipt = run_child(argv, log=output / f"{row['capture_name']}.capture.log", agent=plan["agent"],
                    stops=[*stops, directory / "STOP"], deadline=min(deadline, time.monotonic() + 420),
                    capture_dir=directory)
                meta = capture_gate(directory, row)
                run_child([sys.executable, str(ROOT / "scripts/review_rich_capture.py"), str(directory),
                    "--split-summary", plan["split"]["path"]], log=output / f"{row['capture_name']}.review.log",
                    agent=plan["agent"], stops=[*stops, directory / "STOP"], deadline=deadline)
                review = read_json(directory / "review.json")
                if review.get("fidelity_checks_passed") is not True:
                    raise ValueError("Native capture fidelity review failed")
                captures[row["partition"]].append(directory)
                state["captures"].append({"directory": str(directory), "replay_id": row["replay_id"],
                    "partition": row["partition"], "capture_sha256": digest(directory / "capture.json"),
                    "review_sha256": digest(directory / "review.json"), "counters": meta["counters"], **receipt})
                write_json(output / "status.json", state)
            for part, directories in captures.items():
                unchanged(hashes)
                target = output / f"intents-{part}"
                args = [sys.executable, "-m", "pluto_sc2.rich_dataset", "--output", str(target),
                        "--split-summary", plan["split"]["path"], "--through-seconds", "800"]
                for directory in directories:
                    args.extend(["--capture", str(directory)])
                run_child(args, log=output / f"derive-{part}.log", agent=plan["agent"],
                          stops=[*stops, target / "STOP"], deadline=deadline)
                expected = [read_json(d / "capture.json")["replay"]["replay_id"] for d in directories]
                derived = derivative_gate(target, part, expected)
                state["derivatives"][part] = {"directory": str(target), "counts": derived["counts"],
                    "manifest_sha256": digest(target / "manifest.json"), "samples_sha256": derived["samples_sha256"]}
            state["status"] = "captured_and_derived_pending_tensor_masks"
        except BaseException as error:
            state.update(status="stopped" if isinstance(error, InterruptedError) else "failed",
                         error=f"{type(error).__name__}: {error}")
            raise
        finally:
            state.update(finished_unix=time.time(), wall_seconds=time.monotonic() - started)
            try:
                unchanged(hashes)
                state["all_pinned_inputs_unchanged"] = True
            except (ValueError, OSError) as error:
                state.update(status="failed", all_pinned_inputs_unchanged=False, integrity_error=str(error))
            write_json(output / "status.json", state)
        if state["status"] != "captured_and_derived_pending_tensor_masks":
            raise RuntimeError("Final provenance gate failed")
        return state


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    init = sub.add_parser("prepare")
    init.add_argument("--output", type=Path, required=True)
    execute = sub.add_parser("run")
    execute.add_argument("--plan", type=Path, required=True)
    execute.add_argument("--plan-sha256", required=True)
    execute.add_argument("--output", type=Path, required=True)
    execute.add_argument("--wall-seconds", type=float, default=MAX_WALL)
    args = parser.parse_args()
    result = prepare(args.output) if args.command == "prepare" else run(
        args.plan, args.plan_sha256, args.output, wall_seconds=args.wall_seconds)
    print(json.dumps({"status": result["status"], "models_trained": False,
                      "eligible_for_training": False}, indent=2))


if __name__ == "__main__":
    main()
