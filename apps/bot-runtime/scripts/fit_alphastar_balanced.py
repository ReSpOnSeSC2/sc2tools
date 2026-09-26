"""Bounded class-balanced continuation of the verified 24-event replay diagnostic.

Resumes actual parameters AND Adam moments; never trains validation observations,
launches SC2, executes a prediction, or promotes a model. Evaluation is unweighted
on the same TRAIN events, and is explicitly not a held-out strength estimate.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from collections.abc import Mapping
import json
import os
from pathlib import Path
import shutil
import sys
import time
import traceback

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))
from scripts.train_alphastar_replay import (  # noqa: E402
    DEFAULT_UPSTREAM, DISABLED_HEADS, HEADS, PINNED_COMMIT, TensorError,
    aggregate_metrics, build_official_bridge, runtime_registry, sha256,
    teacher_forced_metrics, tensorize_sample, validate_supervised_masks, verify_upstream,
)
from scripts.infer_alphastar_checkpoint import (  # noqa: E402
    read_checkpoint_artifacts, score_after_prediction, select_dataset_rows,
    structured_prediction, validate_observation_only, verify_tree_schema,
)
from pluto_sc2.alphastar_tensor import tensorize_observation  # noqa: E402


class BudgetExhausted(Exception):
    """No further numerical operation may start after the wall-time boundary."""


class RunGuard:
    def __init__(self, seconds, markers, *, clock=time.monotonic):
        if not 0 < seconds <= 900:
            raise TensorError("Wall-time limit must be in (0, 900] seconds")
        self.clock, self.started, self.seconds = clock, clock(), seconds
        self.markers = tuple(Path(marker) for marker in markers)

    def check(self, operation="next operation"):
        self.check_stop()
        if self.clock() - self.started >= self.seconds:
            raise BudgetExhausted(f"Wall-time budget exhausted before {operation}")

    def check_stop(self):
        for marker in self.markers:
            if marker.exists():
                raise TensorError(f"STOP marker respected: {marker}")


def balanced_schedule(function_ids, updates):
    """Equal function frequency; rotate occurrences within each function.

    For any prefix, function visit counts differ by at most one. A function's
    own event visit counts also differ by at most one. No example weight enters
    evaluation. Stable function-ID order makes every update reconstructible.
    """
    if type(updates) is not int or not 1 <= updates <= 1024:
        raise TensorError("New optimizer updates must be in 1..1024")
    if not function_ids or any(type(value) is not int or value < 0 for value in function_ids):
        raise TensorError("Require nonempty integer function identities")
    groups = defaultdict(list)
    for index, function in enumerate(function_ids):
        groups[function].append(index)
    functions = sorted(groups)
    return [groups[functions[step % len(functions)]][
        (step // len(functions)) % len(groups[functions[step % len(functions)]])]
        for step in range(updates)]


def verify_resume_recipe(artifacts, recipe):
    """Require explicit optimizer provenance, never silently reset Adam state."""
    result = artifacts["result"]
    if (recipe.get("optimizer") != "optax.adam" or recipe.get("learning_rate") != 1e-4
            or recipe.get("seed") != 42 or recipe.get("steps") != result["optimizer_updates"]
            or recipe.get("checkpoint_sha256") != artifacts["checkpoint_sha256"]
            or recipe.get("result_sha256") != artifacts["result_sha256"]
            or recipe.get("dataset_hashes") != result["dataset_hashes"]
            or recipe.get("source_hashes") != result["source_hashes"]
            or recipe.get("batch_size") != 1 or recipe.get("unroll_length") != 1):
        raise TensorError("Resume recipe does not prove the exact saved Adam configuration/provenance")
    for key in ("max_entities", "max_selected", "world_size", "minimap_size"):
        if recipe.get(key) != getattr(artifacts["config"], key):
            raise TensorError(f"Resume recipe shape mismatch: {key}")
    if (type(result.get("optimizer_updates")) is not int or result["optimizer_updates"] < 1
            or result.get("validation_optimizer_updates") != 0):
        raise TensorError("Resume requires positive TRAIN-only update accounting")


def verify_state_dict_schema(expected, actual, path="checkpoint"):
    """Validate Flax's full serialized model AND optimizer representation."""
    if isinstance(expected, Mapping):
        if not isinstance(actual, Mapping) or set(actual) != set(expected):
            raise TensorError(f"Restore mapping mismatch at {path}")
        return sum(verify_state_dict_schema(value, actual[key], f"{path}/{key}")
                   for key, value in expected.items())
    if isinstance(actual, Mapping):
        raise TensorError(f"Restore unexpected mapping at {path}")
    wanted, value = np.asarray(expected), np.asarray(actual)
    if wanted.shape != value.shape or wanted.dtype != value.dtype:
        raise TensorError(f"Restore shape/dtype mismatch at {path}")
    if not np.issubdtype(value.dtype, np.number) or not np.all(np.isfinite(value)):
        raise TensorError(f"Restore nonfinite or unsupported value at {path}")
    return 1


def verify_adam_count(decoded, updates):
    if (set(decoded) != {"params", "network_state", "optimizer_state", "optimizer_updates"}
            or type(decoded["optimizer_updates"]) is not int or decoded["optimizer_updates"] != updates):
        raise TensorError("Saved optimizer update count differs from recorded provenance")
    optimizer = decoded["optimizer_state"]
    if (not isinstance(optimizer, dict) or set(optimizer) != {"0", "1"}
            or not isinstance(optimizer["0"], dict) or set(optimizer["0"]) != {"count", "mu", "nu"}
            or optimizer["1"] != {}):
        raise TensorError("Saved optimizer is not the exact optax.adam state")
    count = np.asarray(optimizer["0"]["count"])
    if count.shape != () or count.dtype != np.int32 or int(count) != updates:
        raise TensorError("Adam bias-correction count differs from actual completed updates")


def greedy_summary(events):
    """All events count once; failed masks cannot count as complete actions."""
    if not events:
        raise TensorError("Evaluation requires every selected TRAIN event")
    function_correct = complete = 0
    histogram = Counter()
    for event in events:
        metrics = event["score"]["metrics"]
        correct = metrics["function_exact"]
        function_correct += bool(correct)
        complete += bool(correct and event["mask_checks_passed"] and all(metrics.values()))
        histogram[event["function"]] += 1
    return {"events": len(events), "function_exact": function_correct,
            "complete_action_exact": complete, "predicted_functions": dict(histogram),
            "unweighted": True, "held_out": False}


def supervised_mask_scalar(outputs, labels, active_heads, *, array_api=np):
    """Device-side equivalent of the preflight mask checks, one boolean back."""
    valid = []
    for name in HEADS:
        wanted = labels[name]
        allowed = array_api.take_along_axis(outputs["masks", name], wanted[..., None], axis=-1)
        check = (array_api.all(outputs["argument_masks", name]) & array_api.all(allowed)
                 & array_api.all(outputs["action", name] == wanted))
        valid.append(array_api.logical_or(array_api.logical_not(active_heads[name]), check))
    return array_api.all(array_api.stack(valid))


def run(args):
    # Validate bounds even when called as a library rather than through argparse.
    balanced_schedule([0], args.updates)
    os.environ.setdefault("XLA_PYTHON_CLIENT_PREALLOCATE", "false")
    os.environ.setdefault("OMP_NUM_THREADS", "4")
    os.environ.setdefault("JAX_COMPILATION_CACHE_DIR", str(Path.home() / ".cache/sc2-alphastar-v1/jax"))
    sys.dont_write_bytecode = True
    output, origin, dataset = (Path(value).resolve() for value in (args.output, args.run, args.dataset))
    guard = RunGuard(args.wall_seconds, [output / "STOP", origin / "STOP", dataset / "STOP",
                                         DEFAULT_UPSTREAM.parent.parent / "STOP"])
    guard.check("creating output")
    if output.exists():
        raise TensorError("Output must be a new directory; original models remain immutable")
    output.mkdir(parents=True)
    state = {"schema": "alphastar-real-replay-diagnostic-v1", "diagnostic_mode": "balanced-continuation-v1",
             "status": "running", "started_unix": time.time(), "pid": os.getpid(),
             "new_optimizer_updates": 0, "optimizer_updates": 0, "validation_optimizer_updates": 0,
             "checkpoints_written": 0, "game_inputs": 0, "live_game_ready": False, "strength_evidence": False,
             "upstream_commit": PINNED_COMMIT, "disabled_supervision": list(DISABLED_HEADS),
             "training_scope": "bounded_imitation_diagnostic", "max_new_updates": args.updates,
             "wall_time_budget_seconds": args.wall_seconds, "evaluations": [], "updates": [],
             "evaluation_scope": "all 24 same TRAIN events, unweighted; not holdout or strength",
             "deadline_semantics": "checked before and after numerical operations; in-flight compilation cannot be interrupted"}
    params = network_state = opt_state = None
    hashes = {}

    def save():
        pending = output / "result.json.pending"
        pending.write_text(json.dumps(state, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        pending.replace(output / "result.json")

    def unchanged():
        guard.check_stop()
        for path, digest in hashes.items():
            if sha256(path) != digest:
                raise TensorError(f"Source or input changed during fitting: {path}")
        verify_upstream(args.upstream)

    def write_checkpoint(name):
        # Finalization may preserve completed work after the time limit, but
        # performs no new model computation, update, or inference.
        guard.check_stop()
        checkpoint = {"params": jax.device_get(params), "network_state": jax.device_get(network_state),
                      "optimizer_state": jax.device_get(opt_state), "optimizer_updates": state["optimizer_updates"]}
        blob = serialization.to_bytes(checkpoint)
        restored = serialization.from_bytes(checkpoint, blob)
        leaves, tree = jax.tree_util.tree_flatten(checkpoint)
        recovered, other_tree = jax.tree_util.tree_flatten(restored)
        if tree != other_tree or len(leaves) != len(recovered) or any(
                np.asarray(a).dtype != np.asarray(b).dtype or not np.array_equal(a, b)
                for a, b in zip(leaves, recovered)):
            raise TensorError("Saved full model/Adam checkpoint failed exact roundtrip")
        with (output / name).open("xb") as stream:
            stream.write(blob)
        state["checkpoints_written"] += 1
        return sha256(output / name), len(recovered)

    try:
        state["pid_creation_time"] = __import__("psutil").Process().create_time()
        save()
        artifacts = read_checkpoint_artifacts(origin, dataset / "game-data.json")
        recipe = json.loads((origin / "reproduction-recipe.json").read_text(encoding="utf-8"))
        verify_resume_recipe(artifacts, recipe)
        rows = select_dataset_rows(dataset, artifacts["result"], 24)
        if len(rows) != 24 or len(artifacts["result"]["mask_proofs"]) != 24:
            raise TensorError("This bounded repair requires exactly the original 24 TRAIN events")
        if any(row.get("partition") != "train" for row in rows):
            raise TensorError("Validation observations must never enter fitting")
        registry, mapping, config = artifacts["registry"], artifacts["unit_types"], artifacts["config"]
        examples = [tensorize_sample(row, registry, mapping, config) for row in rows]
        observations = [tensorize_observation(row["frame"], registry, mapping, config) for row in rows]
        functions = [int(example["labels"]["function"]) for example in examples]
        if len(set(functions)) != 21:
            raise TensorError("Expected the diagnosed 21 function groups; refusing a changed curriculum")
        schedule = balanced_schedule(functions, args.updates)
        state.update(dataset_hashes=artifacts["result"]["dataset_hashes"],
                     tensor_config=artifacts["result"]["tensor_config"],
                     split_sha256=artifacts["result"]["split_sha256"],
                     optimizer_updates=artifacts["result"]["optimizer_updates"],
                     resumed_optimizer_updates=artifacts["result"]["optimizer_updates"],
                     resume_checkpoint_sha256=artifacts["checkpoint_sha256"],
                     resume_result_sha256=artifacts["result_sha256"],
                     sample_provenance=[example["metadata"] for example in examples],
                     admitted_samples=24, function_groups=21,
                     sampling_policy="equal round-robin function groups; rotating examples within each group",
                     learning_rate=recipe["learning_rate"], seed=recipe["seed"])
        paths = [Path(__file__), ROOT / "scripts/train_alphastar_replay.py",
                 ROOT / "scripts/infer_alphastar_checkpoint.py", ROOT / "src/pluto_sc2/alphastar_tensor.py",
                 ROOT / "src/pluto_sc2/rich_actions.py", ROOT / "src/pluto_sc2/rich_intents.py"]
        snapshot = output / "source-snapshot"
        snapshot.mkdir()
        source_hashes = {}
        for path in paths:
            digest = sha256(path)
            shutil.copy2(path, snapshot / path.name)
            if sha256(snapshot / path.name) != digest or sha256(path) != digest:
                raise TensorError("Source changed while capturing immutable reproduction snapshot")
            source_hashes[str(path)] = digest
        (snapshot / "manifest.json").write_text(json.dumps(source_hashes, indent=2) + "\n", encoding="utf-8")
        state["source_hashes"] = source_hashes
        for directory, names in ((origin, ("result.json", "registry.json", "checkpoint.msgpack", "reproduction-recipe.json")),
                                 (dataset, ("manifest.json", "samples.jsonl.gz", "game-data.json"))):
            paths.extend(directory / name for name in names)
        hashes = {str(path): sha256(path) for path in paths}
        state["source_and_input_hashes"] = hashes
        shutil.copy2(origin / "registry.json", output / "registry.json")
        guard.check("loading pinned runtime")
        state["upstream_manifest_sha256"], state["upstream_file_count"] = verify_upstream(args.upstream)
        sys.path.insert(0, str(Path(args.upstream).resolve()))
        import jax
        import jax.numpy as jnp
        import haiku as hk
        import optax
        from flax import serialization
        from alphastar import types
        from alphastar.unplugged.losses.supervised import Supervised
        if not any(device.platform == "gpu" for device in jax.devices()):
            raise TensorError("This diagnostic requires the pinned GPU runtime")
        state["devices"] = [str(device) for device in jax.devices()]
        current_registry, current_mapping = runtime_registry(artifacts["catalog"])
        if current_registry != registry or current_mapping != mapping:
            raise TensorError("Saved public action/type vocabulary changed")
        component, action_spec = build_official_bridge(examples[0], config, registry)
        greedy, _ = build_official_bridge(observations[0], config, registry,
                                         is_training=False, sampling_mode="greedy")
        network = hk.transform_with_state(jax.vmap(component.unroll))
        greedy_network = hk.transform_with_state(jax.vmap(greedy.unroll))
        previous = jax.tree_util.tree_map(lambda spec: jnp.zeros((1,) + spec.shape, spec.dtype), component.prev_state_spec)
        greedy_previous = jax.tree_util.tree_map(lambda spec: jnp.zeros((1,) + spec.shape, spec.dtype), greedy.prev_state_spec)

        def inputs_for(example, model, observation_only=False):
            raw = validate_observation_only(example) if observation_only else example["inputs"]
            result = types.StreamDict()
            for key, spec in model.input_spec.items():
                spec.validate(raw[key])
                result[key] = jnp.asarray(raw[key])[None, None, ...]
            return result

        inputs = [inputs_for(example, component) for example in examples]
        greedy_inputs = [inputs_for(example, greedy, True) for example in observations]
        key = jax.random.PRNGKey(recipe["seed"])
        guard.check("tracing training schema")
        expected_params, expected_state = jax.eval_shape(network.init, key, inputs[0], previous)
        guard.check("tracing inference schema")
        expected_greedy_params, expected_greedy_state = jax.eval_shape(
            greedy_network.init, key, greedy_inputs[0], greedy_previous)
        decoded = serialization.msgpack_restore(artifacts["checkpoint"].read_bytes())
        verify_adam_count(decoded, state["resumed_optimizer_updates"])
        param_leaves, param_count = verify_tree_schema(expected_params, decoded["params"], "params")
        verify_tree_schema(expected_state, decoded["network_state"], "network_state")
        verify_tree_schema(expected_greedy_params, decoded["params"], "greedy_params")
        verify_tree_schema(expected_greedy_state, decoded["network_state"], "greedy_state")
        if param_count != artifacts["result"]["parameter_count"]:
            raise TensorError("Resumed parameter count changed")
        params = jax.tree_util.tree_map(jnp.asarray, decoded["params"])
        network_state = jax.tree_util.tree_map(jnp.asarray, decoded["network_state"])
        optimizer = optax.adam(recipe["learning_rate"])
        guard.check("restoring optimizer schema")
        template = {"params": jax.device_get(params), "network_state": jax.device_get(network_state),
                    "optimizer_state": jax.device_get(optimizer.init(params)), "optimizer_updates": state["optimizer_updates"]}
        restore_leaves = verify_state_dict_schema(serialization.to_state_dict(template), decoded)
        restored = serialization.from_state_dict(template, decoded)
        roundtrip = serialization.to_state_dict(restored)
        verify_state_dict_schema(decoded, roundtrip)
        def equal_values(left, right):
            if isinstance(left, Mapping):
                return all(equal_values(left[name], right[name]) for name in left)
            return np.array_equal(left, right)
        if not equal_values(decoded, roundtrip):
            raise TensorError("Restored model/Adam values differ from serialized checkpoint")
        opt_state = jax.tree_util.tree_map(jnp.asarray, restored["optimizer_state"])
        state.update(parameter_count=param_count, restored_parameter_leaves=param_leaves,
                     restored_full_state_leaves=restore_leaves, optimizer_moments_restored=True,
                     optimizer_count_restored=True, optimizer_moments_exact=True,
                     fresh_parameter_initialization=False)
        apply, apply_greedy = jax.jit(network.apply), jax.jit(greedy_network.apply)
        weights = {name: 0. if name in DISABLED_HEADS else 1. for name in HEADS}
        loss = Supervised(action_spec=action_spec, weights=weights, burnin_len=0, overlap_len=0)

        labels = [{name: jnp.asarray(example["labels"][name])[None, None, ...] for name in HEADS}
                  for example in examples]
        active = [{name: jnp.asarray(example["active_heads"][name]) for name in HEADS} for example in examples]

        def objective(parameters, model_state, values, wanted, active_heads):
            (predictions, _, _), next_state = network.apply(parameters, model_state, key, values, previous)
            loss_inputs = predictions.copy()
            loss_inputs["step_type"] = values["step_type"]
            losses, _ = loss.batched_loss(loss_inputs)
            mask_valid = supervised_mask_scalar(predictions, wanted, active_heads, array_api=jnp)
            return jnp.mean(losses), (next_state, mask_valid)

        def all_finite(tree):
            return jnp.all(jnp.stack([jnp.all(jnp.isfinite(leaf)) for leaf in jax.tree_util.tree_leaves(tree)]))

        @jax.jit
        def tentative_update(parameters, model_state, optimizer_state, values, wanted, active_heads):
            (value, (next_state, mask_valid)), gradient = jax.value_and_grad(objective, has_aux=True)(
                parameters, model_state, values, wanted, active_heads)
            leaves = jax.tree_util.tree_leaves(gradient)
            norm = jnp.sqrt(sum(jnp.sum(jnp.square(leaf)) for leaf in leaves))
            updates, next_optimizer = optimizer.update(gradient, optimizer_state, parameters)
            next_params = optax.apply_updates(parameters, updates)
            finite = all_finite((gradient, next_params, next_state, next_optimizer)) & jnp.isfinite(value) & jnp.isfinite(norm)
            return next_params, next_state, next_optimizer, value, norm, finite, mask_valid

        def evaluate():
            # Masks depend on observed units and teacher-forced prefixes, never
            # weights. Prove all 24 before updates, then again each 128 updates.
            teacher, events, proofs = [], [], []
            for index, example in enumerate(examples):
                guard.check("teacher-forced evaluation")
                (predictions, _, _), _ = apply(params, network_state, key, inputs[index], previous)
                proof = validate_supervised_masks(predictions, example)
                teacher.append(teacher_forced_metrics(predictions, example))
                proofs.append({**example["metadata"], "verified_unmasked_targets": proof})
                guard.check("unweighted greedy evaluation")
                (predictions, _, _), _ = apply_greedy(params, network_state, key, greedy_inputs[index], greedy_previous)
                record = structured_prediction(predictions, registry, config)
                record["score"] = score_after_prediction(record["prediction"], rows[index], registry, mapping, config)
                record["action_ordinal"] = rows[index]["action_ordinal"]
                events.append(record)
                guard.check("next evaluation event")
            evaluation = {"new_updates": state["new_optimizer_updates"], "optimizer_updates": state["optimizer_updates"],
                          "teacher_forced": {"summary": aggregate_metrics(teacher), "events": teacher},
                          "greedy": {"summary": greedy_summary(events), "events": events}}
            state["mask_proofs"] = proofs
            state["evaluations"].append(evaluation)
            save()
            print(json.dumps({"evaluation": evaluation["new_updates"], "greedy": evaluation["greedy"]["summary"]}), flush=True)
            return evaluation

        baseline = evaluate()
        if baseline["teacher_forced"]["events"] != artifacts["result"]["teacher_forced_metrics"]["final"]["events"]:
            raise TensorError("Resumed teacher-forced outputs differ from archived checkpoint metrics")
        state["archived_teacher_forced_metrics_reproduced"] = True
        save()
        for step, index in enumerate(schedule, 1):
            guard.check("tentative numerical update")
            candidate = tentative_update(params, network_state, opt_state, inputs[index], labels[index], active[index])
            next_params, next_state, next_optimizer, value, norm, finite, mask_valid = candidate
            # The only device-to-host update transfers are these four scalars.
            value, norm, finite, mask_valid = float(value), float(norm), bool(finite), bool(mask_valid)
            guard.check("committing checked optimizer update")
            if not mask_valid or not finite or not np.isfinite(value) or not np.isfinite(norm) or norm <= 0:
                raise TensorError("Invalid mask, nonfinite/zero gradient or tentative state; no optimizer commit")
            params, network_state, opt_state = next_params, next_state, next_optimizer
            state["new_optimizer_updates"] = step
            state["optimizer_updates"] = state["resumed_optimizer_updates"] + step
            state["updates"].append({"new_update": step, "optimizer_update": state["optimizer_updates"],
                                     "sample_index": index, "function_id": functions[index],
                                     "action_ordinal": rows[index]["action_ordinal"], "partition": "train",
                                     "loss": value, "gradient_l2_norm": norm, "finite": finite, "mask_valid": mask_valid,
                                     "mask_proof_evaluation": state["evaluations"][-1]["new_updates"]})
            save()
            if step % 128 == 0 or step == args.updates:
                guard.check("checkpoint boundary")
                unchanged()
                digest, _ = write_checkpoint(f"checkpoint-new-{step:04d}.msgpack")
                state.setdefault("intermediate_checkpoints", []).append({"new_updates": step, "sha256": digest})
                evaluate()
        state["status"] = "passed"
    except BudgetExhausted as exc:
        state.update(status="budget_exhausted", stop_reason=str(exc))
    except BaseException as exc:
        state.update(status="failed", error=f"{type(exc).__name__}: {exc}", traceback=traceback.format_exc())
        raise
    finally:
        try:
            unchanged()
            if state["status"] in ("passed", "budget_exhausted") and state["new_optimizer_updates"]:
                digest, leaf_count = write_checkpoint("checkpoint.msgpack")
                state.update(checkpoint_sha256=digest, checkpoint_restore_verified=True,
                             checkpoint_restored_leaf_count=leaf_count, learned_from_actual_replay=True)
                state["teacher_forced_metrics"] = {"baseline": state["evaluations"][0]["teacher_forced"],
                                                   "last_evaluated": state["evaluations"][-1]["teacher_forced"]}
                if state["evaluations"][-1]["new_updates"] == state["new_optimizer_updates"]:
                    state["teacher_forced_metrics"]["final"] = state["evaluations"][-1]["teacher_forced"]
            state["source_inputs_original_checkpoint_unchanged"] = True
        except BaseException as exc:
            state.update(status="failed", finalization_error=f"{type(exc).__name__}: {exc}")
            raise
        finally:
            state.update(finished_unix=time.time(), wall_seconds=time.time() - state["started_unix"])
            state["function_update_counts"] = dict(Counter(str(entry["function_id"]) for entry in state["updates"]))
            save()
            if state.get("checkpoint_restore_verified"):
                replay_recipe = {"schema": "alphastar-replay-diagnostic-recipe-v1",
                    "optimizer": "optax.adam", "learning_rate": recipe["learning_rate"], "seed": recipe["seed"],
                    "steps": state["optimizer_updates"], "new_steps": state["new_optimizer_updates"],
                    "initialization": "exact resumed parameters, network state and Adam moments",
                    "resume_checkpoint_sha256": artifacts["checkpoint_sha256"],
                    "checkpoint_sha256": state["checkpoint_sha256"], "result_sha256": sha256(output / "result.json"),
                    "dataset_hashes": state["dataset_hashes"], "source_hashes": state["source_hashes"],
                    "batch_size": 1, "unroll_length": 1, "training_partition": "train only",
                    "max_entities": config.max_entities, "max_selected": config.max_selected,
                    "world_size": config.world_size, "minimap_size": config.minimap_size,
                    "sampling_policy": state["sampling_policy"], "max_new_updates": args.updates,
                    "wall_time_budget_seconds": args.wall_seconds, "actual_launch_arguments": sys.argv[1:]}
                (output / "reproduction-recipe.json").write_text(
                    json.dumps(replay_recipe, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True, help="Immutable v3 run with exact Adam recipe")
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True, help="New directory only")
    parser.add_argument("--upstream", type=Path, default=DEFAULT_UPSTREAM)
    parser.add_argument("--updates", type=int, default=1024)
    parser.add_argument("--wall-seconds", type=float, default=900)
    args = parser.parse_args()
    if not 1 <= args.updates <= 1024 or not 0 < args.wall_seconds <= 900:
        parser.error("Require 1..1024 new updates and a wall budget in (0,900] seconds")
    run(args)


if __name__ == "__main__":
    main()
