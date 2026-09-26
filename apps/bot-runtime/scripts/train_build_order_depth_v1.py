"""Bounded Protoss macro-prior depth curriculum; no native game controller.

Restores the reviewed 3492-update parent exactly, then explicitly changes only
the learning rate and supervised loss weighting. Names classify TRAIN labels;
the actor still receives only strictly earlier own raw commands and timing.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import copy
from datetime import datetime, timezone
import io
import json
import math
import os
from pathlib import Path
import random
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts import train_build_order_prior_v2 as base  # noqa: E402
import psutil  # noqa: E402
import torch  # noqa: E402

SCHEMA = "own-command-build-depth-v1"
CONTRACT = "causal-own-command-depth-v1"
PARENT_SHA = "717f437beb02d7fc99fa2e70d514d4a781582399cadf7c456393ac3f4910cef5"
SEQUENCE_SHA = "8cb5ac66b182e71cc2000b13503198d939be5f15e9b2904977cbee9e44685034"
PARENT_UPDATES = 3492
MAX_UPDATES = 1134
LEARNING_RATE = 0.0005
CATEGORY_WEIGHTS = {"worker": 1, "building": 2, "army_production": 3,
                    "research": 2, "cancel": 1, "other": 1, "unknown": 1}


def classify_name(name):
    if not isinstance(name, str) or not name:
        return "unknown"
    if name == "TrainProbe":
        return "worker"
    if name == "BuildOracleStasisTrap":
        return "other"
    if name.startswith("Build"):
        return "building"
    if name.startswith(("Train", "WarpIn")):
        return "army_production"  # Includes produced support units, not workers.
    if name.startswith(("Research", "Upgrade", "Evolve")):
        return "research"
    if name.startswith("Cancel"):
        return "cancel"
    return "other"


def training_token_categories(raw_rows):
    """Ambiguous/unknown names stay at weight1; validation cannot supply names."""
    names = defaultdict(set)
    for row in raw_rows:
        if row["partition"] != "train" or row["race"] != "Protoss":
            continue
        for event in row["events"]:
            name = event.get("decoded_name")
            names[base.token_key(event)].add(name if isinstance(name, str) else "")
    result = {}
    for token, variants in sorted(names.items()):
        category = classify_name(next(iter(variants))) if len(variants) == 1 else "unknown"
        result[token] = {"names_audit_only": sorted(variants), "category": category,
                         "weight": CATEGORY_WEIGHTS[category]}
    return result


def weighted_imitation_loss(logits, predicted_wait, target, wanted_wait, weights):
    """Weight command CE only; retain the original unweighted timing term."""
    if (target.ndim != 1 or predicted_wait.shape != target.shape or wanted_wait.shape != target.shape
            or weights.shape != target.shape or len(target) == 0
            or bool((target < 2).any()) or bool((target >= logits.shape[-1]).any())
            or not bool(torch.isfinite(weights).all()) or bool(((weights < 1) | (weights > 3)).any())):
        raise ValueError("Invalid bounded category weights or supervised targets")
    ce = torch.nn.functional.cross_entropy(logits, target, reduction="none")
    timing = torch.nn.functional.smooth_l1_loss(predicted_wait, wanted_wait, reduction="none")
    loss = (ce * weights).sum() / weights.sum() + 0.1 * timing.mean()
    return loss, ce, timing


def exact(left, right):
    if isinstance(left, torch.Tensor):
        return isinstance(right, torch.Tensor) and left.dtype == right.dtype and torch.equal(left, right)
    if isinstance(left, dict):
        return isinstance(right, dict) and left.keys() == right.keys() and all(exact(v, right[k]) for k, v in left.items())
    if isinstance(left, (tuple, list)):
        return type(left) is type(right) and len(left) == len(right) and all(exact(a, b) for a, b in zip(left, right))
    return left == right


def verify_depth_optimizer(model, optimizer, updates):
    # The inherited proof checks moments/schema/counts and all Adam options. Use
    # a detached state copy to adapt its legacy LR assertion, not the live Adam.
    state = copy.deepcopy(optimizer.state_dict())
    if any(group["lr"] != LEARNING_RATE for group in state["param_groups"]):
        raise ValueError("Depth curriculum learning rate changed")
    for group in state["param_groups"]:
        group["lr"] = .002
    verifier = torch.optim.Adam(model.parameters(), lr=.002)
    verifier.load_state_dict(state)
    base.verify_optimizer(model, verifier, updates)


def restore_parent(parent):
    model = base.BuildOrderPrior()
    model.load_state_dict(parent["parameters"], strict=True)
    optimizer = torch.optim.Adam(model.parameters(), lr=.002)
    optimizer.load_state_dict(parent["optimizer"])
    base.verify_optimizer(model, optimizer, parent["updates"])
    if not exact(model.state_dict(), parent["parameters"]) or not exact(optimizer.state_dict(), parent["optimizer"]):
        raise ValueError("Parent parameters or Adam did not restore exactly")
    generator = random.Random()
    generator.setstate(parent["python_rng"])
    torch.set_rng_state(parent["torch_rng"])
    if generator.getstate() != parent["python_rng"] or not torch.equal(torch.get_rng_state(), parent["torch_rng"]):
        raise ValueError("Parent random streams did not restore exactly")
    return model, optimizer, generator


def change_learning_rate(optimizer):
    before = copy.deepcopy(optimizer.state_dict())
    if any(group["lr"] != .002 for group in optimizer.param_groups):
        raise ValueError("Expected original Adam learning rate before explicit transition")
    for group in optimizer.param_groups:
        group["lr"] = LEARNING_RATE
    expected = copy.deepcopy(before)
    for group in expected["param_groups"]:
        group["lr"] = LEARNING_RATE
    if not exact(expected, optimizer.state_dict()):
        raise ValueError("LR transition altered optimizer moments or other options")


def load_selected_parent(directory, inputs):
    directory = Path(directory).resolve()
    if (directory / "STOP").exists():
        raise InterruptedError("Parent STOP respected")
    status_path, path = directory / "status.json", directory / "Protoss-best.pt"
    status_bytes, data = status_path.read_bytes(), path.read_bytes()
    status = json.loads(status_bytes)
    if (base.bytes_sha(data) != PARENT_SHA or status.get("status") != "complete"
            or status.get("races", {}).get("Protoss", {}).get("best_checkpoint_sha256") != PARENT_SHA):
        raise ValueError("Only the explicitly selected P3492 checkpoint is admitted")
    pins = {str(status_path): base.bytes_sha(status_bytes), str(path): base.bytes_sha(data)}
    if any(path in inputs and inputs[path] != digest for path, digest in pins.items()):
        raise ValueError("Previously pinned parent input changed")
    inputs.update(pins)
    value = torch.load(io.BytesIO(data), weights_only=True, map_location="cpu")
    if value.get("updates") != PARENT_UPDATES or value.get("epoch") != 11:
        raise ValueError("Selected parent optimizer/epoch identity changed")
    return value, data


def evaluate_retention(model, rows, vocabulary, categories, *, horizon, check):
    """Unweighted validation; categories are frozen from TRAIN alone."""
    model.eval()
    buckets = defaultdict(lambda: dict(events=0, correct=0, repeat_last_correct=0))
    first, seen = [], set()
    examples = [(row, i) for row in rows for i, command in enumerate(row["commands"])
                if command["game_loop"] <= horizon * 22.4]
    with torch.no_grad():
        for start in range(0, len(examples), 256):
            check()
            chunk = examples[start:start + 256]
            tokens, times, lengths, wanted, _ = base.collate_examples(
                [base.prefix_example(row, i, vocabulary) for row, i in chunk])
            logits, _ = model(tokens, times, lengths, len(vocabulary))
            for prediction, target, (row, i) in zip(logits.argmax(-1).tolist(), wanted.tolist(), chunk):
                token = base.token_key(row["commands"][i])
                info = categories.get(token, {"category": "unknown", "names_audit_only": []})
                for key in (info["category"], row["matchup"] + "/" + info["category"]):
                    bucket = buckets[key]
                    bucket["events"] += 1
                    bucket["correct"] += int(prediction == target)
                    bucket["repeat_last_correct"] += int(base.repeat_last(row, i))
                name = info["names_audit_only"][0] if len(info["names_audit_only"]) == 1 else None
                identity = (row["replay_id"], row["player_id"], name)
                if name in ("BuildPylon", "BuildGateway") and identity not in seen:
                    seen.add(identity)
                    first.append({"replay_id": row["replay_id"], "player_id": row["player_id"],
                        "matchup": row["matchup"], "name_audit_only": name,
                        "game_loop": row["commands"][i]["game_loop"],
                        "source_event_index": row["commands"][i]["source_event_index"],
                        "correct": prediction == target})
    for bucket in buckets.values():
        bucket["accuracy"] = bucket["correct"] / bucket["events"]
        bucket["repeat_last_accuracy"] = bucket["repeat_last_correct"] / bucket["events"]
    return {"unweighted": True, "categories_from_train_only": True, "categories": dict(buckets),
        "opening_rows": first,
        "first_opening": {name: {"events": sum(row["name_audit_only"] == name for row in first),
            "correct": sum(row["name_audit_only"] == name and row["correct"] for row in first)}
            for name in ("BuildPylon", "BuildGateway")}}


def require_bounds(args):
    if (type(args.epochs) is not int or not 1 <= args.epochs <= 3
            or type(args.wall_seconds) is not int or not 60 <= args.wall_seconds <= 900
            or type(args.threads) is not int or not 1 <= args.threads <= 2
            or args.horizon_seconds != 480):
        raise ValueError("Depth run limited to3 epochs,900s,2CPU threads and unchanged480s horizon")


def example_cursor(examples, *, epoch, next_offset=0, phase="training"):
    if not 0 <= next_offset <= len(examples):
        raise ValueError("Cursor offset outside the immutable shuffled pass")
    return {"epoch_in_run": epoch, "next_example_offset": next_offset, "phase": phase,
            "shuffled_example_identities": [[row["replay_id"], row["player_id"], row["commands"][index]["source_event_index"]]
                                             for row, index in examples],
            "resume_supported": False}


def run(args):
    require_bounds(args)
    started = time.monotonic()
    dataset, parent_dir, output = map(lambda p: Path(p).resolve(), (args.dataset, args.parent_run, args.output))
    if output.exists():
        raise FileExistsError("Require a fresh immutable output")
    stops = [ROOT / "STOP", dataset / "STOP", parent_dir / "STOP", output / "STOP"]

    def check():
        if any(path.exists() for path in stops):
            raise InterruptedError("STOP respected")
        if time.monotonic() - started > args.wall_seconds:
            raise TimeoutError("Depth curriculum wall bound")

    check()
    records, fixed, fingerprints, inputs = base.load_dataset(dataset)
    sequence_path = dataset / "sequences.jsonl"
    blob = sequence_path.read_bytes()
    if base.bytes_sha(blob) != SEQUENCE_SHA or inputs[str(sequence_path)] != SEQUENCE_SHA:
        raise ValueError("Depth contract requires the pinned619 dataset without edits")
    raw_rows = [json.loads(line) for line in blob.splitlines() if line]
    categories = training_token_categories(raw_rows)
    partitions = {row["replay_id"]: row["partition"] for row in records}
    train = [row for row in records if row["race"] == "Protoss" and row["partition"] == "train"]
    valid = [row for row in records if row["race"] == "Protoss" and row["partition"] == "validation"]
    if not train or not valid or any(not any(c["game_loop"] <= 480 * 22.4 for r in group for c in r["commands"])
                                     for group in (train, valid)):
        raise ValueError("Both Protoss cohorts must contain actual examples")
    parent, parent_bytes = load_selected_parent(parent_dir, inputs)
    base.validate_parent(parent, race="Protoss", horizon=480, partitions=partitions,
                         fixed_partitions=fixed, perspective_hashes=fingerprints)
    if parent["fixed_partitions"] != fixed or parent["perspective_hashes"] != fingerprints or parent["partitions"] != partitions:
        raise ValueError("Depth fitting must retain exactly the same complete619 cohort")
    vocabulary = base.extend_vocabulary(train, parent["vocabulary"])
    if vocabulary != parent["vocabulary"] or set(categories) != set(vocabulary):
        raise ValueError("Depth curriculum cannot extend or resize the reviewed vocabulary")
    expected_events = sum(int(r["weight"]) * sum(c["game_loop"] <= 480 * 22.4 for c in r["commands"]) for r in train)
    updates_per_epoch = math.ceil(expected_events / 128)
    if updates_per_epoch * args.epochs > MAX_UPDATES:
        raise ValueError("Depth curriculum exceeds1134 new updates")
    for path in (Path(__file__).resolve(), Path(base.__file__).resolve(), ROOT / "src/pluto_sc2/build_order_imitation_v1.py"):
        inputs[str(path)] = base.sha(path)

    def unchanged():
        if any(base.sha(path) != digest for path, digest in inputs.items()):
            raise ValueError("Pinned source/dataset/checkpoint changed")

    torch.set_num_threads(args.threads)
    model, optimizer, generator = restore_parent(parent)
    check()
    unchanged()
    output.mkdir(parents=True)
    with (output / "Protoss-parent-exact.pt").open("xb") as stream:
        stream.write(parent_bytes)
    if base.sha(output / "Protoss-parent-exact.pt") != PARENT_SHA:
        raise ValueError("Exact parent snapshot copy failed")
    # The exact original snapshot exists before this deliberately versioned change.
    change_learning_rate(optimizer)
    verify_depth_optimizer(model, optimizer, PARENT_UPDATES)
    recipe = {"schema": CONTRACT, "parent_checkpoint_sha256": PARENT_SHA,
        "parent_updates": PARENT_UPDATES, "parent_learning_rate": .002,
        "learning_rate": LEARNING_RATE, "adam_moments_preserved": True,
        "category_weights": CATEGORY_WEIGHTS, "token_categories_train_only": categories,
        "loss": "sum(weight*per-example CE)/sum(weight) +0.1 mean(unweighted smoothL1(log1p wait)) within each batch",
        "sampling": "Each TRAIN perspective once plus exactly one additional copy of declared weight2; no outcome input",
        "actor_inputs": "strictly earlier own raw command tokens and timing only",
        "target_semantics": "legacy command attempts, not accepted native actions",
        "validation": "unweighted fixed whole-replay model-selection cohort",
        "ambiguous_unknown_weight": 1, "stasis_trap_weight": 1,
        "candidate_review_gates": {"first_pylon_correct_at_least": 133, "first_gateway_correct_at_least": 112,
            "first_opening_denominator": 148, "worker_accuracy_baseline": .8829287392325763,
            "worker_accuracy_maximum_absolute_drop": .02,
            "deeper_milestones_and_army_production": "must improve under independent unweighted audit",
            "failure_behavior": "preserve diagnostic checkpoints, retain preferred parent; no automatic promotion",
            "internal_best_alias": "unweighted commandCE only; does not imply review gates pass"},
        "max_new_updates": MAX_UPDATES, "epochs": args.epochs, "updates_per_epoch": updates_per_epoch,
        "wall_seconds": args.wall_seconds, "threads": args.threads, "horizon_seconds": 480}
    with (output / "objective-recipe.json").open("x", encoding="utf-8") as stream:
        json.dump(recipe, stream, indent=2, allow_nan=False)
        stream.write("\n")
    recipe_sha = base.sha(output / "objective-recipe.json")
    inputs[str(output / "objective-recipe.json")] = recipe_sha
    inputs[str(output / "Protoss-parent-exact.pt")] = PARENT_SHA
    contract = {**base.model_contract(), "training_contract": CONTRACT, "objective_recipe_sha256": recipe_sha}
    updates = PARENT_UPDATES
    status = {"schema": SCHEMA, "status": "running", "pid": os.getpid(),
        "pid_creation_time": psutil.Process().create_time(), "started_at": datetime.now(timezone.utc).isoformat(),
        "epochs_requested": args.epochs, "horizon_seconds": 480, "source_hashes": inputs,
        "model_contract": contract, "unique_replays": len(partitions), "perspectives": len(records),
        "race": "Protoss", "races": {}, "recipe": recipe, "parent_checkpoint_sha256": PARENT_SHA,
        "restore_proof": {"parameters_exact": True, "adam_exact_before_lr_change": True,
            "rng_exact": True, "vocabulary_exact": True, "parent_snapshot_before_lr_change": True},
        "native_games": 0, "native_actor_connected": False, "live_model_promoted": False,
        "target_semantics": recipe["target_semantics"], "matchup_conditioning": False,
        "selection_role": "diagnostic best CE only; retention reviewed separately before any candidate preference"}
    base.write_json(output / "status.json", status)

    cursor = example_cursor([], epoch=0, phase="initial_evaluation")

    def save_checkpoint(name, epoch, aliases, *, after_stop=False):
        if not after_stop:
            check()
        unchanged()
        value = dict(schema=SCHEMA, race="Protoss", parameters=model.state_dict(), optimizer=optimizer.state_dict(),
            vocabulary=vocabulary, updates=updates, epoch=epoch, partitions=partitions, fixed_partitions=fixed,
            perspective_hashes=fingerprints, python_rng=generator.getstate(), torch_rng=torch.get_rng_state(),
            source_hashes=dict(inputs), horizon_seconds=480, model_contract=contract, objective_recipe=recipe,
            objective_recipe_sha256=recipe_sha, parent_checkpoint_sha256=PARENT_SHA, native_actor_connected=False,
            partial_cursor=copy.deepcopy(cursor), interrupted=after_stop)
        buffer = io.BytesIO()
        torch.save(value, buffer)
        data = buffer.getvalue()
        with (output / name).open("xb") as stream:
            stream.write(data)
        for alias in aliases:
            path = output / alias
            pending = path.with_suffix(".pending")
            with pending.open("xb") as stream:
                stream.write(data)
            pending.replace(path)
        return base.bytes_sha(data)

    try:
        initial = base.evaluate(model, valid, vocabulary, horizon=480, check=check)
        initial_retention = evaluate_retention(model, valid, vocabulary, categories, horizon=480, check=check)
        initial_sha = save_checkpoint("Protoss-initial.pt", 11, ("Protoss-best.pt", "Protoss-last.pt"))
        result = {"updates": updates, "training_perspectives": len(train), "validation_perspectives": len(valid),
            "passes": [], "initial_validation": initial, "initial_retention": initial_retention,
            "completed_evaluation_updates": updates,
            "best_epoch": 0, "best_validation": initial, "best_retention": initial_retention,
            "initial_checkpoint_sha256": initial_sha, "last_checkpoint_sha256": initial_sha,
            "best_checkpoint_sha256": initial_sha}
        status["races"]["Protoss"] = result
        base.write_json(output / "status.json", status)
        best = initial["known_target_cross_entropy"]
        for epoch in range(1, args.epochs + 1):
            check()
            unchanged()
            chosen = base.sample_pass(train, generator)
            examples = [(r, i) for r in chosen for i, c in enumerate(r["commands"]) if c["game_loop"] <= 480 * 22.4]
            if len(examples) != expected_events:
                raise ValueError("Complete weighted-pass example count changed")
            generator.shuffle(examples)
            cursor = example_cursor(examples, epoch=epoch)
            model.train()
            command_sum, timing_sum, weight_sum = 0., 0., 0.
            exposures = Counter()
            for start in range(0, len(examples), 128):
                check()
                if updates - PARENT_UPDATES >= MAX_UPDATES:
                    raise TimeoutError("Depth update cap reached")
                chunk = examples[start:start + 128]
                tokens, times, lengths, wanted, wanted_wait = base.collate_examples(
                    [base.prefix_example(r, i, vocabulary) for r, i in chunk])
                infos = [categories[base.token_key(r["commands"][i])] for r, i in chunk]
                weights = torch.tensor([info["weight"] for info in infos], dtype=torch.float32)
                logits, predicted_wait = model(tokens, times, lengths, len(vocabulary))
                loss, command_losses, timing_losses = weighted_imitation_loss(logits, predicted_wait, wanted, wanted_wait, weights)
                optimizer.zero_grad(set_to_none=True)
                loss.backward()
                norm = torch.nn.utils.clip_grad_norm_(model.parameters(), 5.)
                if not bool(torch.isfinite(loss)) or not bool(torch.isfinite(norm)):
                    raise ValueError("Nonfinite loss or gradient")
                check()
                optimizer.step()
                updates += 1
                cursor["next_example_offset"] = start + len(chunk)
                mass = float(weights.sum())
                command_sum += float((command_losses.detach() * weights).sum())
                timing_sum += float(timing_losses.detach().sum())
                weight_sum += mass
                exposures.update(info["category"] for info in infos)
            verify_depth_optimizer(model, optimizer, updates)
            cursor["phase"] = "validation"
            validation = base.evaluate(model, valid, vocabulary, horizon=480, check=check)
            cursor["phase"] = "retention_evaluation"
            retention = evaluate_retention(model, valid, vocabulary, categories, horizon=480, check=check)
            record = {"epoch": epoch, "cumulative_epoch": 11 + epoch, "updates": updates,
                "sampled_perspectives": [[r["replay_id"], r["player_id"]] for r in chosen],
                "events": len(examples),
                "training_weighted_loss": command_sum / weight_sum + .1 * timing_sum / len(examples),
                "training_weighted_command_ce": command_sum / weight_sum,
                "training_unweighted_timing_loss": timing_sum / len(examples),
                "category_example_exposures": dict(exposures), "category_weight_mass": weight_sum,
                "validation": validation, "retention": retention}
            aliases = ["Protoss-last.pt"]
            score = validation["known_target_cross_entropy"]
            if score < best:
                aliases.append("Protoss-best.pt")
            cursor["phase"] = "completed_evaluation"
            checkpoint_sha = save_checkpoint(f"Protoss-epoch{epoch:03d}.pt", 11 + epoch, aliases)
            result["passes"].append(record)
            result.update(updates=updates, completed_evaluation_updates=updates, last_checkpoint_sha256=checkpoint_sha)
            if score < best:
                best = score
                result.update(best_epoch=epoch, best_validation=validation,
                              best_retention=retention, best_checkpoint_sha256=checkpoint_sha)
            base.write_json(output / "status.json", status)
            print(json.dumps({"race": "Protoss", "epoch": epoch, "updates": updates,
                "validation_ce": score, "validation_accuracy": validation["accuracy"],
                "first_opening": retention["first_opening"]}), flush=True)
        status["status"] = "complete"
    except (InterruptedError, TimeoutError) as exc:
        # Persist already accepted updates without performing any new update.
        # A STOP prevents optimization, not the bounded final durability write.
        verify_depth_optimizer(model, optimizer, updates)
        name = f"Protoss-interrupted-update{updates:06d}.pt"
        digest = save_checkpoint(name, 11 + cursor["epoch_in_run"], (), after_stop=True)
        status.update(status="stopped_at_bound", reason=str(exc), actual_optimizer_updates=updates,
                      interrupted_checkpoint=name, interrupted_checkpoint_sha256=digest,
                      interrupted_cursor=cursor, interrupted_resume_supported=False)
        if "Protoss" in status["races"]:
            status["races"]["Protoss"]["updates"] = updates
    except Exception as exc:
        status.update(status="failed", error=repr(exc))
        raise
    finally:
        status["source_inputs_unchanged"] = all(base.sha(p) == digest for p, digest in inputs.items())
        if not status["source_inputs_unchanged"]:
            status.update(status="failed", error="Pinned source/input bytes changed")
        status.update(finished_at=datetime.now(timezone.utc).isoformat(), process_active=False,
                      wall_seconds=time.monotonic() - started, actual_optimizer_updates=updates)
        base.write_json(output / "status.json", status)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--parent-run", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--wall-seconds", type=int, default=900)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--horizon-seconds", type=int, default=480)
    run(parser.parse_args())
