"""Independent read-only restoration proof for the worker-retention Protoss depth prior.

No optimizer step, native game, actor connection or preferred-model mutation.
"""
from __future__ import annotations

from copy import deepcopy
from collections import Counter, defaultdict
import hashlib
import io
import json
from pathlib import Path
import sys
import random
import time

import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))

PARENT_SHA = "717f437beb02d7fc99fa2e70d514d4a781582399cadf7c456393ac3f4910cef5"
PARENT_UPDATES = 3492
LEARNING_RATE = .0005
SEQUENCE_SHA = "8cb5ac66b182e71cc2000b13503198d939be5f15e9b2904977cbee9e44685034"
CATEGORY_WEIGHTS = {"worker": 1, "building": 1.25, "army_production": 1.5, "research": 1.25,
                    "cancel": 1, "other": 1, "unknown": 1}
APPROVED_LOSS = "sum(weight*per-example CE)/sum(weight) +0.1 mean(unweighted smoothL1(log1p wait)) +1.0 mean_worker_rows(KL(parent||student))"
TEACHER_CONTRACT = {
    "checkpoint_sha256": PARENT_SHA, "frozen": True, "no_grad": True,
    "temperature": 1, "coefficient": 1.0, "membership": "TRAIN trueworker labels only",
    "normalization": "mean of per-row sum over same known-vocabulary masked token support, only worker rows",
    "worker_free_batch": "differentiable zero; no teacher forward required", "timing_distillation": False,
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def exact(left, right):
    """Exact shape, dtype and bytes, including signed floating-point zero."""
    if isinstance(left, torch.Tensor):
        return (isinstance(right, torch.Tensor) and left.dtype == right.dtype and left.shape == right.shape
                and left.detach().cpu().contiguous().numpy().tobytes() == right.detach().cpu().contiguous().numpy().tobytes())
    if isinstance(left, dict):
        return isinstance(right, dict) and left.keys() == right.keys() and all(exact(v, right[k]) for k, v in left.items())
    if isinstance(left, (tuple, list)):
        return type(left) is type(right) and len(left) == len(right) and all(exact(a, b) for a, b in zip(left, right))
    return type(left) is type(right) and left == right


def verify_lr_transition(parent, initial):
    """The recipe changes learning rate, never inherited parameters or moments."""
    require(parent["updates"] == initial["updates"] == PARENT_UPDATES, "Initial Adam age changed")
    require(parent["epoch"] == initial["epoch"] == 11, "Initial cumulative epoch changed")
    for name in ("parameters", "vocabulary", "partitions", "fixed_partitions", "perspective_hashes", "python_rng", "torch_rng"):
        require(exact(parent[name], initial[name]), "Initial restore changed " + name)
    require(exact(parent["optimizer"]["state"], initial["optimizer"]["state"]), "Initial Adam moments or steps changed")
    before, after = deepcopy(parent["optimizer"]["param_groups"]), deepcopy(initial["optimizer"]["param_groups"])
    require(len(before) == len(after) == 1, "Unexpected Adam parameter groups")
    require(before[0]["lr"] == .002 and after[0]["lr"] == LEARNING_RATE, "Learning-rate migration not explicit")
    before[0]["lr"] = LEARNING_RATE
    require(exact(before, after), "Adam hyperparameters changed beyond the approved learning rate")
    return {"parameters_exact": True, "moments_and_steps_exact": True, "vocabulary_and_lineage_exact": True,
            "rng_exact": True, "old_learning_rate": .002, "new_learning_rate": LEARNING_RATE}


def verify_adam(checkpoint, model):
    updates = checkpoint["updates"]
    require(type(updates) is int and PARENT_UPDATES <= updates <= PARENT_UPDATES + 756, "Depth optimizer budget/count changed")
    optimizer = checkpoint["optimizer"]
    require(set(optimizer) == {"state", "param_groups"} and len(optimizer["param_groups"]) == 1, "Adam schema changed")
    group = optimizer["param_groups"][0]
    require(group["lr"] == LEARNING_RATE and group["betas"] == (.9, .999) and group["eps"] == 1e-8
            and group["weight_decay"] == 0 and group["amsgrad"] is False and group["maximize"] is False, "Adam recipe changed")
    parameters = list(model.parameters())
    require(len(group["params"]) == len(parameters) and set(group["params"]) == set(optimizer["state"]), "Adam parameter coverage differs")
    for parameter_id, parameter in zip(group["params"], parameters):
        moment = optimizer["state"][parameter_id]
        require(torch.isfinite(parameter).all() and set(moment) == {"step", "exp_avg", "exp_avg_sq"}
                and float(moment["step"]) == updates, "Nonfinite parameter or reset Adam step")
        require(all(moment[name].shape == parameter.shape and moment[name].dtype == parameter.dtype
                    and torch.isfinite(moment[name]).all() for name in ("exp_avg", "exp_avg_sq")), "Adam moment shape/dtype/finite check failed")
    return len(parameters)


def load_checkpoint(path, expected, hashes):
    blob = Path(path).read_bytes()
    require(hashlib.sha256(blob).hexdigest() == expected, "Checkpoint differs from recorded SHA256")
    hashes[str(Path(path).resolve())] = expected
    return torch.load(io.BytesIO(blob), map_location="cpu", weights_only=True)


def verify_completed_cursor(checkpoint, examples, epoch):
    identities = [[row["replay_id"], row["player_id"], row["commands"][index]["source_event_index"]]
                  for row, index in examples]
    require(checkpoint.get("interrupted") is False and checkpoint.get("partial_cursor") == {
        "epoch_in_run": epoch, "next_example_offset": len(examples),
        "phase": "completed_evaluation" if epoch else "initial_evaluation",
        "shuffled_example_identities": identities, "resume_supported": False},
        "Completed checkpoint cursor differs from the independently reproduced pass")


def verify_recipe(recipe):
    require(recipe["learning_rate"] == LEARNING_RATE and recipe["parent_learning_rate"] == .002
            and recipe["parent_checkpoint_sha256"] == PARENT_SHA and recipe["parent_updates"] == PARENT_UPDATES
            and recipe["schema"] == "causal-own-command-depth-worker-retention-v2"
            and recipe["category_weights"] == CATEGORY_WEIGHTS and recipe["loss"] == APPROVED_LOSS
            and recipe["teacher"] == TEACHER_CONTRACT
            and recipe["adam_moments_preserved"] is True and recipe["horizon_seconds"] == 480
            and recipe["max_new_updates"] == 756 and 1 <= recipe["epochs"] <= 2
            and 1 <= recipe["threads"] <= 2 and 60 <= recipe["wall_seconds"] <= 900
            and recipe["ambiguous_unknown_weight"] == 1 and recipe["stasis_trap_weight"] == 1,
            "Depth objective, parent, learning-rate or budget recipe changed")


def independent_categories(raw_rows):
    names = defaultdict(set)
    for row in raw_rows:
        if row["partition"] == "train" and row["race"] == "Protoss":
            for event in row["events"]:
                name = event.get("decoded_name")
                names[f"{event['ability_link']}:{event['command_index']}"].add(name if isinstance(name, str) else "")
    result = {}
    for token, variants in names.items():
        name = next(iter(variants)) if len(variants) == 1 else ""
        if not name:
            category = "unknown"
        elif name == "TrainProbe":
            category = "worker"
        elif name == "BuildOracleStasisTrap":
            category = "other"
        elif name.startswith("Build"):
            category = "building"
        elif name.startswith(("Train", "WarpIn")):
            category = "army_production"
        elif name.startswith(("Research", "Upgrade", "Evolve")):
            category = "research"
        elif name.startswith("Cancel"):
            category = "cancel"
        else:
            category = "other"
        result[token] = {"names_audit_only": sorted(variants), "category": category, "weight": CATEGORY_WEIGHTS[category]}
    return result


def independent_retention(model, records, vocabulary, categories, base, check):
    buckets = defaultdict(lambda: {"events": 0, "correct": 0, "repeat_last_correct": 0})
    opening, seen = [], set()
    examples = [(row, index) for row in records for index, command in enumerate(row["commands"])
                if command["game_loop"] <= 480 * 22.4]
    model.eval()
    with torch.no_grad():
        for start in range(0, len(examples), 256):
            check()
            chunk = examples[start:start + 256]
            tokens, times, lengths, targets, _ = base.collate_examples([base.prefix_example(row, index, vocabulary) for row, index in chunk])
            logits, _ = model(tokens, times, lengths, len(vocabulary))
            for predicted, target, (row, index) in zip(logits.argmax(-1).tolist(), targets.tolist(), chunk):
                command = row["commands"][index]
                info = categories.get(base.token_key(command), {"category": "unknown", "names_audit_only": []})
                earlier = [c for c in row["commands"][:index] if c["game_loop"] < command["game_loop"]]
                repeated = bool(earlier and base.token_key(earlier[-1]) == base.token_key(command))
                for name in (info["category"], row["matchup"] + "/" + info["category"]):
                    buckets[name]["events"] += 1
                    buckets[name]["correct"] += int(predicted == target)
                    buckets[name]["repeat_last_correct"] += int(repeated)
                name = info["names_audit_only"][0] if len(info["names_audit_only"]) == 1 else None
                identity = row["replay_id"], row["player_id"], name
                if name in ("BuildPylon", "BuildGateway") and identity not in seen:
                    seen.add(identity)
                    opening.append({"replay_id": row["replay_id"], "player_id": row["player_id"], "matchup": row["matchup"],
                        "name_audit_only": name, "game_loop": command["game_loop"], "source_event_index": command["source_event_index"],
                        "correct": predicted == target})
    for bucket in buckets.values():
        bucket["accuracy"] = bucket["correct"] / bucket["events"]
        bucket["repeat_last_accuracy"] = bucket["repeat_last_correct"] / bucket["events"]
    return {"unweighted": True, "categories_from_train_only": True, "categories": dict(buckets), "opening_rows": opening,
        "first_opening": {name: {"events": sum(row["name_audit_only"] == name for row in opening),
            "correct": sum(row["name_audit_only"] == name and row["correct"] for row in opening)}
            for name in ("BuildPylon", "BuildGateway")}}


def run(args):
    from scripts import train_build_order_prior_v2 as base
    output, dataset, parent_dir, destination = map(lambda value: Path(value).resolve(),
                                                 (args.run, args.dataset, args.parent_run, args.output))
    require(not destination.exists(), "Require a fresh immutable reload report")
    started = time.monotonic()
    stops = [ROOT / "STOP", output / "STOP", dataset / "STOP", parent_dir / "STOP", destination.parent / "STOP"]

    def check():
        require(not any(path.exists() for path in stops), "Read-only reload STOP respected")
        require(time.monotonic() - started <= 200, "Read-only reload wall bound reached")

    check()
    status_bytes = (output / "status.json").read_bytes()
    status = json.loads(status_bytes)
    require(status.get("schema") == "own-command-build-depth-v2" and status.get("status") == "complete"
            and status.get("race") == "Protoss" and set(status.get("races", {})) == {"Protoss"}
            and status.get("source_inputs_unchanged") is True and status.get("native_games") == 0
            and status.get("native_actor_connected") is False and status.get("live_model_promoted") is False
            and status.get("horizon_seconds") == 480 and 1 <= status.get("epochs_requested", 0) <= 2, "Depth run not complete or contract changed")
    hashes = dict(status["source_hashes"])
    hashes[str(output / "status.json")] = hashlib.sha256(status_bytes).hexdigest()
    hashes[str(Path(__file__).resolve())] = sha(__file__)
    require(all(sha(path) == digest for path, digest in hashes.items()), "Source or input differs before reload")
    records, fixed, fingerprints, data_hashes = base.load_dataset(dataset)
    require(all(path not in hashes or hashes[path] == digest for path, digest in data_hashes.items()),
            "Dataset evidence conflicts with the original source pins")
    hashes.update(data_hashes)
    require(sha(dataset / "sequences.jsonl") == SEQUENCE_SHA, "Pinned depth sequence bytes changed")
    require(len(records) == 1238 and len({row["replay_id"] for row in records}) == 619, "Pinned619 corpus changed")
    recipe_path = output / "objective-recipe.json"
    recipe = json.loads(recipe_path.read_text(encoding="utf-8"))
    recipe_sha = sha(recipe_path)
    hashes[str(recipe_path)] = recipe_sha
    raw_rows = [json.loads(line) for line in (dataset / "sequences.jsonl").read_bytes().splitlines() if line]
    categories = independent_categories(raw_rows)
    require(recipe["token_categories_train_only"] == categories and status["recipe"] == recipe, "TRAIN category recipe changed")
    verify_recipe(recipe)
    parent = load_checkpoint(parent_dir / "Protoss-best.pt", PARENT_SHA, hashes)
    require(sha(output / "Protoss-parent-exact.pt") == PARENT_SHA, "Exact parent copy changed")
    hashes[str(output / "Protoss-parent-exact.pt")] = PARENT_SHA
    saved = status["races"]["Protoss"]
    initial = load_checkpoint(output / "Protoss-initial.pt", saved["initial_checkpoint_sha256"], hashes)
    migration = verify_lr_transition(parent, initial)
    require(status["restore_proof"]["teacher_exact_frozen_no_grad"] is True
            and status["restore_proof"]["teacher_creation_rng_preserved"] is True, "Teacher restoration proof missing")
    expected_contract = {**parent["model_contract"], "training_contract": "causal-own-command-depth-worker-retention-v2",
                         "objective_recipe_sha256": recipe_sha}
    require(status["model_contract"] == expected_contract, "Architecture or causal feature contract changed")
    torch.set_num_threads(2)
    valid = [row for row in records if row["race"] == "Protoss" and row["partition"] == "validation"]
    train = [row for row in records if row["race"] == "Protoss" and row["partition"] == "train"]
    worker_examples = [(row, index) for row in train for index, command in enumerate(row["commands"])
                       if command["game_loop"] <= 480 * 22.4
                       and categories[base.token_key(command)]["category"] == "worker"][:32]
    teacher_proof = status["initial_teacher_proof"]
    require(len(worker_examples) == teacher_proof["train_worker_examples"] == 32
            and teacher_proof["logits_exact"] is True and teacher_proof["optimizer_updates"] == 0
            and teacher_proof["absolute_kl_tolerance"] == 1e-6
            and abs(teacher_proof["worker_kl"]) <= 1e-6, "Initial TRAIN worker teacher proof missing or changed")
    expected_counts = Counter({(row["replay_id"], row["player_id"]): int(row["weight"]) for row in train})
    expected_events = sum(int(row["weight"]) * sum(command["game_loop"] <= 480 * 22.4 for command in row["commands"]) for row in train)
    increment = (expected_events + 127) // 128
    require(increment == recipe["updates_per_epoch"] and len(saved["passes"]) == status["epochs_requested"] == recipe["epochs"],
            "Epoch coverage changed")
    generator = random.Random()
    generator.setstate(parent["python_rng"])
    curve = []
    for index in range(len(saved["passes"]) + 1):
        check()
        path = output / ("Protoss-initial.pt" if index == 0 else f"Protoss-epoch{index:03d}.pt")
        checkpoint = initial if index == 0 else load_checkpoint(path, sha(path), hashes)
        require(checkpoint["schema"] == "own-command-build-depth-v2" and checkpoint["race"] == "Protoss"
                and checkpoint["model_contract"] == status["model_contract"]
                and checkpoint["model_contract"]["training_contract"] == "causal-own-command-depth-worker-retention-v2"
                and checkpoint["model_contract"]["objective_recipe_sha256"] == recipe_sha
                and checkpoint["objective_recipe"] == recipe and checkpoint["objective_recipe_sha256"] == recipe_sha
                and checkpoint["source_hashes"] == status["source_hashes"]
                and checkpoint["teacher_reference"] == {"checkpoint_sha256": PARENT_SHA, "frozen_exact": True, "no_grad": True}
                and checkpoint["parent_checkpoint_sha256"] == PARENT_SHA and checkpoint["native_actor_connected"] is False,
                "Candidate namespace/provenance changed")
        require(checkpoint["updates"] == PARENT_UPDATES + index * increment and checkpoint["epoch"] == 11 + index,
                "Checkpoint count/epoch differs from complete passes")
        require(checkpoint["fixed_partitions"] == fixed and checkpoint["perspective_hashes"] == fingerprints
                and checkpoint["vocabulary"] == parent["vocabulary"] and checkpoint["partitions"] == parent["partitions"],
                "Checkpoint vocabulary/split/content changed")
        model = base.BuildOrderPrior().cpu()
        model.load_state_dict(checkpoint["parameters"], strict=True)
        verified_states = verify_adam(checkpoint, model)
        if index == 0:
            teacher = base.BuildOrderPrior().cpu().eval().requires_grad_(False)
            teacher.load_state_dict(parent["parameters"], strict=True)
            model.eval()
            tokens, times, lengths, _, _ = base.collate_examples(
                [base.prefix_example(row, i, checkpoint["vocabulary"]) for row, i in worker_examples])
            with torch.no_grad():
                student_logits, _ = model(tokens, times, lengths, len(checkpoint["vocabulary"]))
                teacher_logits, _ = teacher(tokens, times, lengths, len(checkpoint["vocabulary"]))
                teacher_logp = torch.log_softmax(teacher_logits, -1)
                teacher_probe_kl = float((teacher_logp.exp() * (teacher_logp - torch.log_softmax(student_logits, -1))).sum(-1).mean())
            require(exact(student_logits, teacher_logits) and abs(teacher_probe_kl) <= 1e-6
                    and exact(teacher.state_dict(), parent["parameters"])
                    and all(parameter.grad is None and not parameter.requires_grad for parameter in teacher.parameters()),
                    "Independent actual initial teacher logits/KL/frozen-state proof failed")
        metrics = base.evaluate(model, valid, checkpoint["vocabulary"], horizon=480, check=check)
        retention = independent_retention(model, valid, checkpoint["vocabulary"], categories, base, check)
        wanted = saved["initial_validation"] if index == 0 else saved["passes"][index - 1]["validation"]
        wanted_retention = saved["initial_retention"] if index == 0 else saved["passes"][index - 1]["retention"]
        require(metrics == wanted and retention == wanted_retention, "Independent unweighted evaluation differs")
        if index:
            record = saved["passes"][index - 1]
            chosen = base.sample_pass(train, generator)
            examples = [(row, i) for row in chosen for i, command in enumerate(row["commands"]) if command["game_loop"] <= 480 * 22.4]
            generator.shuffle(examples)
            require(record["sampled_perspectives"] == [[row["replay_id"], row["player_id"]] for row in chosen]
                    and Counter(map(tuple, record["sampled_perspectives"])) == expected_counts
                    and record["events"] == expected_events and exact(generator.getstate(), checkpoint["python_rng"]),
                    "Complete weighted sampling pass/RNG differs")
            exposures = Counter(categories[base.token_key(row["commands"][i])]["category"] for row, i in examples)
            mass = sum(categories[base.token_key(row["commands"][i])]["weight"] for row, i in examples)
            require(dict(exposures) == record["category_example_exposures"] and mass == record["category_weight_mass"],
                    "Category exposure or weight mass differs")
            require(record["teacher_exact_frozen_no_grad"] is True
                    and record["training_worker_anchor_examples"] == exposures["worker"]
                    and -1e-6 <= record["training_worker_normalized_kl"] < float("inf"),
                    "TRAIN worker anchor coverage or finite KL diagnostic changed")
            verify_completed_cursor(checkpoint, examples, index)
        else:
            verify_completed_cursor(checkpoint, [], 0)
        curve.append({"epoch_in_run": index, "cumulative_epoch": checkpoint["epoch"], "updates": checkpoint["updates"],
            "checkpoint_filename": path.name, "checkpoint_sha256": sha(path), "independently_verified": True,
            "adam_parameter_states_verified": verified_states, "unweighted_validation_exact": True,
            "independent_category_and_opening_metrics_exact": True,
            "validation_ce": metrics["known_target_cross_entropy"], "validation_accuracy": metrics["accuracy"],
            "validation_nonrepeat_accuracy": metrics["nonrepeat_target_accuracy"],
            "categories": {name: value for name, value in retention["categories"].items() if "/" not in name},
            "first_opening": retention["first_opening"]})
    best_index = min(range(len(curve)), key=lambda i: curve[i]["validation_ce"])
    best_record = saved["passes"][best_index - 1] if best_index else {
        "validation": saved["initial_validation"], "retention": saved["initial_retention"]}
    require(saved["best_epoch"] == best_index and saved["best_checkpoint_sha256"] == curve[best_index]["checkpoint_sha256"]
            and saved["best_validation"] == best_record["validation"] and saved["best_retention"] == best_record["retention"]
            and saved["updates"] == saved["completed_evaluation_updates"] == status["actual_optimizer_updates"] == curve[-1]["updates"]
            and sha(output / "Protoss-best.pt") == saved["best_checkpoint_sha256"]
            and sha(output / "Protoss-last.pt") == curve[-1]["checkpoint_sha256"] == saved["last_checkpoint_sha256"], "Best/last alias selection differs")
    for name in ("Protoss-best.pt", "Protoss-last.pt"):
        hashes[str(output / name)] = sha(output / name)
    require(all(sha(path) == digest for path, digest in hashes.items()), "Source/input/checkpoint changed during reload")
    report = {"schema": "protoss-depth-worker-retention-independent-reload-v2", "status": "passed", "source_inputs_unchanged": True,
        "source_and_input_hashes": hashes, "parent_sha256": PARENT_SHA, "lr_transition": migration, "curve": curve,
        "finalized_status_path": str(output / "status.json"),
        "finalized_status_sha256": hashes[str(output / "status.json")],
        "worker_teacher_reference_verified": True, "independent_initial_teacher_probe": {
            "train_worker_examples": 32, "logits_exact": True, "worker_kl": teacher_probe_kl,
            "teacher_parameters_exact_no_grad": True},
        "best_epoch": best_index, "new_optimizer_updates": 0, "native_games": 0, "model_promoted": False,
        "scope": "Unweighted whole-replay validation of raw own-command attempts; no native execution or MMR evidence",
        "wall_seconds": time.monotonic() - started}
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("x", encoding="utf-8") as stream:
        json.dump(report, stream, indent=2, allow_nan=False)
        stream.write("\n")
    print(json.dumps({"status": "passed", "checkpoints": len(curve), "best_epoch": best_index,
                      "last_updates": curve[-1]["updates"], "wall_seconds": report["wall_seconds"]}))


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("run", "dataset", "parent-run", "output"):
        parser.add_argument("--" + name, required=True)
    run(parser.parse_args())
