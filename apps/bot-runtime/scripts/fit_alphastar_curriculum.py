"""One bounded full-TRAIN epoch with original diagnostic-anchor rehearsal.

Requires the immutable all-row graph preflight and resumes exact parameters and
Adam state. Candidate execution success is not model promotion, held-out skill,
or gameplay evidence. No SC2 process or game interface is used.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from collections.abc import Mapping
import json
import os
from pathlib import Path
import random
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
    aggregate_metrics, build_official_bridge, read_dataset, runtime_registry, sha256,
    teacher_forced_metrics, train_rows, validate_supervised_masks, verify_upstream,
)
from scripts.infer_alphastar_checkpoint import (  # noqa: E402
    read_checkpoint_artifacts, score_after_prediction, structured_prediction,
    validate_observation_only, verify_tree_schema,
)
from scripts.fit_alphastar_balanced import (  # noqa: E402
    BudgetExhausted, RunGuard, balanced_schedule, greedy_summary, supervised_mask_scalar,
    verify_adam_count, verify_resume_recipe, verify_state_dict_schema,
)
from scripts.preflight_alphastar_curriculum import (  # noqa: E402
    ALLOWED_EXCLUSIONS, EXCLUSION_ERROR, dataset_provenance_guard, host_path, identity,
    label_fingerprint, observation_fingerprint, permitted_exclusion,
    validate_active_logits, validate_train_identity,
)
from pluto_sc2.alphastar_tensor import tensorize_observation, tensorize_sample  # noqa: E402


def curriculum_schedule(identities, anchors, anchor_functions, *, seed=42, max_updates=1024):
    """Each broad row once; one rotating balanced anchor after every third row."""
    if (type(seed) is not int or type(max_updates) is not int or not 1 <= max_updates <= 1024
            or len(identities) != 679 or len(set(identities)) != 679
            or len(anchors) != 24 or len(set(anchors)) != 24
            or not set(anchors) <= set(identities) or len(anchor_functions) != 24
            or len(set(anchor_functions)) != 21):
        raise TensorError("Require exact679 distinct broad rows and original24 anchors/21 functions")
    broad = list(identities)
    random.Random(seed).shuffle(broad)
    anchor_indices = iter(balanced_schedule(anchor_functions, len(broad) // 3))
    schedule = []
    for number, row_id in enumerate(broad, 1):
        schedule.append({"identity": row_id, "role": "broad"})
        if number % 3 == 0:
            schedule.append({"identity": anchors[next(anchor_indices)], "role": "anchor"})
    if len(schedule) > max_updates:
        raise TensorError("Update cap cannot cover the complete one-epoch curriculum")
    return schedule


def require_preflight(preflight, artifacts, dataset_hashes):
    """A passed count alone is insufficient: bind exact identities and tensors."""
    if (preflight.get("schema") != "alphastar-full-curriculum-preflight-v1"
            or preflight.get("status") != "passed" or preflight.get("eligible_for_broader_training") is not True
            or preflight.get("all_source_inputs_unchanged") is not True
            or preflight.get("checkpoint_sha256") != artifacts["checkpoint_sha256"]
            or preflight.get("checkpoint_optimizer_updates") != artifacts["result"]["optimizer_updates"]
            or preflight.get("dataset_hashes") != dataset_hashes
            or preflight.get("tensor_config") != artifacts["result"]["tensor_config"]
            or preflight.get("split_sha256") != artifacts["result"]["split_sha256"]
            or preflight.get("optimizer_updates") != 0 or preflight.get("checkpoint_writes") != 0
            or preflight.get("failures") != [] or preflight.get("mask_verified_rows") != 679
            or preflight.get("source_train_rows") != 681 or preflight.get("tensor_supported_rows") != 679):
        raise TensorError("Requires the exact passed immutable full-curriculum preflight")
    omissions = preflight.get("known_exclusions", [])
    if (len(omissions) != 2 or {tuple(row["identity"]) for row in omissions} != ALLOWED_EXCLUSIONS
            or any(row.get("ability_id") != 4129 or row.get("error") != EXCLUSION_ERROR for row in omissions)):
        raise TensorError("Preflight omission identities or reasons changed")
    maps = []
    for name in ("tensor_records", "mask_records"):
        records = preflight.get(name, [])
        mapped = {tuple(row["identity"]): row for row in records}
        if len(records) != 679 or len(mapped) != 679:
            raise TensorError("Preflight must identify679 unique admitted events")
        maps.append(mapped)
    if set(maps[0]) != set(maps[1]):
        raise TensorError("Preflight tensor/mask identities differ")
    for row_id, record in maps[0].items():
        proof = maps[1][row_id]
        if (any(record.get(key) != proof.get(key) for key in ("function", "observation_sha256", "label_sha256"))
                or not all(isinstance(record.get(key), str) and len(record[key]) == 64
                           for key in ("observation_sha256", "label_sha256"))
                or not proof.get("verified_unmasked_targets")
                or any(type(count) is not int or count < 1 for count in proof["verified_unmasked_targets"].values())):
            raise TensorError("Preflight fingerprints or mask proofs differ")
    if not preflight.get("source_and_input_hashes"):
        raise TensorError("Preflight source/input provenance missing")
    return maps[1]


def group_metrics(events):
    groups = defaultdict(list)
    for event in events:
        groups[event["score"]["expert_function"]].append(event)
    grouped = {}
    for name, rows in sorted(groups.items()):
        summary = greedy_summary(rows)
        args = defaultdict(list)
        for row in rows:
            for head, correct in row["score"]["metrics"].items():
                if head != "function_exact":
                    args[head].append(bool(correct))
        grouped[name] = {"events": len(rows), "function_exact": summary["function_exact"],
                         "complete_action_exact": summary["complete_action_exact"],
                         "function_accuracy": summary["function_exact"] / len(rows),
                         "complete_action_accuracy": summary["complete_action_exact"] / len(rows),
                         "argument_metrics_conditional_on_correct_function": {
                             key: {"correct": sum(values), "events": len(values)} for key, values in args.items()}}
    summary = greedy_summary(events)
    summary.update(per_expert_function=grouped,
                   macro_function_accuracy=float(np.mean([row["function_accuracy"] for row in grouped.values()])),
                   macro_complete_action_accuracy=float(np.mean([row["complete_action_accuracy"] for row in grouped.values()])))
    return summary


def original_anchor_teacher_events(result, anchors):
    archived = result["teacher_forced_metrics"]["final"]["events"]
    by_identity = {identity(row): row for row in archived}
    if len(by_identity) != len(archived) or not set(anchors) <= set(by_identity):
        raise TensorError("Archived final teacher metrics do not uniquely cover the original anchors")
    return [by_identity[row_id] for row_id in anchors]


def run(args):
    if type(args.max_updates) is not int or not 1 <= args.max_updates <= 1024:
        raise TensorError("Maximum new updates must be in1..1024")
    os.environ.setdefault("XLA_PYTHON_CLIENT_PREALLOCATE", "false")
    os.environ.setdefault("OMP_NUM_THREADS", "4")
    os.environ.setdefault("JAX_COMPILATION_CACHE_DIR", str(Path.home() / ".cache/sc2-alphastar-v1/jax"))
    sys.dont_write_bytecode = True
    output, origin, dataset, preflight_path = [Path(value).resolve() for value in
                                              (args.output, args.run, args.dataset, args.preflight)]
    guard = RunGuard(args.wall_seconds, [output / "STOP", origin / "STOP", dataset / "STOP",
                                         preflight_path.parent / "STOP", DEFAULT_UPSTREAM.parent.parent / "STOP"])
    guard.check("creating output")
    if output.exists():
        raise TensorError("Output must be new; existing models are immutable")
    output.mkdir(parents=True)
    state = {"schema": "alphastar-real-replay-diagnostic-v1", "diagnostic_mode": "full-curriculum-continuation-v1",
             "status": "running", "started_unix": time.time(), "pid": os.getpid(),
             "new_optimizer_updates": 0, "optimizer_updates": 0, "validation_optimizer_updates": 0,
             "checkpoints_written": 0, "game_inputs": 0, "live_game_ready": False, "strength_evidence": False,
             "model_promoted": False, "upstream_commit": PINNED_COMMIT, "disabled_supervision": list(DISABLED_HEADS),
             "training_scope": "bounded_imitation_diagnostic", "evaluations": [], "anchor_evaluations": [],
             "updates": [], "max_new_updates": args.max_updates, "wall_time_budget_seconds": args.wall_seconds,
             "evaluation_scope": "All679 unique existingTRAIN events once/unweighted; separately original24 anchors; no holdout",
             "deadline_semantics": "Checked before/after numerical operations; an in-flight compilation cannot be interrupted",
             "broad_coverage": 0, "source_inputs_original_checkpoint_unchanged": False}
    hashes, params, network_state, opt_state = {}, None, None, None

    def save():
        pending = output / "result.json.pending"
        pending.write_text(json.dumps(state, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        pending.replace(output / "result.json")

    def unchanged():
        guard.check_stop()
        changed = [path for path, digest in hashes.items() if sha256(path) != digest]
        if changed:
            raise TensorError(f"Source or input changed during fitting: {changed}")
        verify_upstream(args.upstream)

    def write_checkpoint(name):
        guard.check_stop()
        checkpoint = {"params": jax.device_get(params), "network_state": jax.device_get(network_state),
                      "optimizer_state": jax.device_get(opt_state), "optimizer_updates": state["optimizer_updates"]}
        blob = serialization.to_bytes(checkpoint)
        restored = serialization.from_bytes(checkpoint, blob)
        left, tree = jax.tree_util.tree_flatten(checkpoint)
        right, other = jax.tree_util.tree_flatten(restored)
        if tree != other or len(left) != len(right) or any(
                np.asarray(a).dtype != np.asarray(b).dtype or not np.array_equal(a, b) for a, b in zip(left, right)):
            raise TensorError("Full model/Adam serialization roundtrip failed")
        with (output / name).open("xb") as stream:
            stream.write(blob)
        state["checkpoints_written"] += 1
        return sha256(output / name), len(right)

    try:
        state["pid_creation_time"] = __import__("psutil").Process().create_time()
        save()
        artifacts = read_checkpoint_artifacts(origin, dataset / "game-data.json")
        recipe = json.loads((origin / "reproduction-recipe.json").read_text(encoding="utf-8"))
        verify_resume_recipe(artifacts, recipe)
        manifest, _, dataset_hashes, _ = read_dataset(dataset)
        preflight = json.loads(preflight_path.read_text(encoding="utf-8"))
        admitted = require_preflight(preflight, artifacts, dataset_hashes)
        split_path = host_path(manifest["split_path"])
        if sha256(split_path) != manifest["split_sha256"]:
            raise TensorError("Pinned whole-replay split changed")
        train_ids, validation_ids = dataset_provenance_guard(manifest, dataset_hashes, artifacts["result"],
                                                           json.loads(split_path.read_text(encoding="utf-8")))
        preflight_inputs = {str(host_path(path)): digest for path, digest in preflight["source_and_input_hashes"].items()}
        for path, digest in preflight_inputs.items():
            if sha256(path) != digest:
                raise TensorError(f"Preflight source/input no longer matches: {path}")
        source_paths = [Path(__file__), ROOT / "scripts/fit_alphastar_balanced.py",
                        ROOT / "scripts/preflight_alphastar_curriculum.py", ROOT / "scripts/train_alphastar_replay.py",
                        ROOT / "scripts/infer_alphastar_checkpoint.py", ROOT / "src/pluto_sc2/alphastar_tensor.py",
                        ROOT / "src/pluto_sc2/rich_actions.py", ROOT / "src/pluto_sc2/rich_intents.py"]
        source_hashes = {str(path): sha256(path) for path in source_paths}
        prior_sources = {Path(path.replace("\\", "/")).name: digest for path, digest in artifacts["result"]["source_hashes"].items()}
        for path, digest in source_hashes.items():
            if ((path in preflight_inputs and preflight_inputs[path] != digest)
                    or (Path(path).name in prior_sources and prior_sources[Path(path).name] != digest)):
                raise TensorError(f"Shared source differs from the preflight/checkpoint: {path}")
        hashes = {**preflight_inputs, **source_hashes, str(preflight_path): sha256(preflight_path)}
        snapshot = output / "source-snapshot"
        snapshot.mkdir()
        for path in source_paths:
            shutil.copy2(path, snapshot / path.name)
            if sha256(snapshot / path.name) != source_hashes[str(path)]:
                raise TensorError("Source changed while saving snapshot")
        (snapshot / "manifest.json").write_text(json.dumps(source_hashes, indent=2) + "\n")
        shutil.copy2(origin / "registry.json", output / "registry.json")
        registry, mapping, config = artifacts["registry"], artifacts["unit_types"], artifacts["config"]
        rows, metadata, omissions = {}, {}, []
        for row in train_rows(dataset):
            guard.check("CPU curriculum verification")
            validate_train_identity(row, manifest["replay_partitions"], train_ids, validation_ids)
            row_id = identity(row)
            try:
                example = tensorize_sample(row, registry, mapping, config)
            except TensorError as exc:
                if not permitted_exclusion(row, exc):
                    raise
                omissions.append(row_id)
                continue
            proof = admitted.get(row_id)
            if (proof is None or row_id in rows or proof["function"] != example["metadata"]["function"]["name"]
                    or proof["label_sha256"] != label_fingerprint(example)
                    or proof["observation_sha256"] != observation_fingerprint(tensorize_observation(row["frame"], registry, mapping, config))
                    or set(proof["verified_unmasked_targets"]) != {head for head, active in example["active_heads"].items() if active}):
                raise TensorError("CPU event/tensor differs from the exact preflight admission")
            rows[row_id], metadata[row_id] = row, example["metadata"]
        if set(rows) != set(admitted) or set(omissions) != ALLOWED_EXCLUSIONS or len(omissions) != 2:
            raise TensorError("Full curriculum coverage differs from preflight")
        anchors = [tuple(item) for item in artifacts["result"].get("original_anchor_identities", [])]
        if not anchors:
            anchors = [(item["replay_id"], item["player_id"], item["action_ordinal"])
                       for item in artifacts["result"]["mask_proofs"]]
        anchor_functions = [metadata[row_id]["function"]["id"] for row_id in anchors]
        schedule = curriculum_schedule(list(rows), anchors, anchor_functions, seed=42, max_updates=args.max_updates)
        state.update(dataset_hashes=dataset_hashes, split_sha256=manifest["split_sha256"], source_hashes=source_hashes,
                     source_and_input_hashes=hashes, preflight_sha256=sha256(preflight_path), preflight_path=str(preflight_path),
                     tensor_config=artifacts["result"]["tensor_config"], original_anchor_identities=anchors,
                     admitted_identities=list(rows), known_excluded_identities=omissions, admitted_samples=len(rows),
                     original_anchor_count=len(anchors), function_groups=len({item["function"]["id"] for item in metadata.values()}),
                     sample_provenance=list(metadata.values()), mask_proofs=[{**metadata[row_id], "verified_unmasked_targets":
                         admitted[row_id]["verified_unmasked_targets"]} for row_id in rows],
                     optimizer_updates=artifacts["result"]["optimizer_updates"],
                     resumed_optimizer_updates=artifacts["result"]["optimizer_updates"],
                     resume_checkpoint_sha256=artifacts["checkpoint_sha256"], resume_result_sha256=artifacts["result_sha256"],
                     learning_rate=recipe["learning_rate"], seed=42, sampling_policy="one shuffled broad epoch; balanced original anchor after every3 broad examples",
                     schedule=schedule, scheduled_new_updates=len(schedule), input_fingerprint_audit=preflight["input_fingerprint_audit"],
                     memory_policy="CPU replay rows cached; one example at a time transferred toGPU, no all-curriculum GPU cache")
        save()
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
            raise TensorError("Requires the isolated pinnedGPU runtime")
        state["devices"] = [str(device) for device in jax.devices()]
        if runtime_registry(artifacts["catalog"]) != (registry, mapping):
            raise TensorError("Saved vocabulary changed")
        first = tensorize_sample(rows[anchors[0]], registry, mapping, config)
        first_observation = tensorize_observation(rows[anchors[0]]["frame"], registry, mapping, config)
        component, action_spec = build_official_bridge(first, config, registry)
        greedy_component, _ = build_official_bridge(first_observation, config, registry,
                                                    is_training=False, sampling_mode="greedy")
        network = hk.transform_with_state(jax.vmap(component.unroll))
        greedy_network = hk.transform_with_state(jax.vmap(greedy_component.unroll))
        previous = jax.tree_util.tree_map(lambda spec: jnp.zeros((1,) + spec.shape, spec.dtype), component.prev_state_spec)
        greedy_previous = jax.tree_util.tree_map(lambda spec: jnp.zeros((1,) + spec.shape, spec.dtype), greedy_component.prev_state_spec)
        key = jax.random.PRNGKey(recipe["seed"])

        def inputs_for(example, model, observation_only=False):
            raw = validate_observation_only(example) if observation_only else example["inputs"]
            inputs = types.StreamDict()
            for name, spec in model.input_spec.items():
                spec.validate(raw[name])
                inputs[name] = jnp.asarray(raw[name])[None, None, ...]
            return inputs

        guard.check("restoring exact model and optimizer schema")
        expected_params, expected_state = jax.eval_shape(network.init, key, inputs_for(first, component), previous)
        greedy_params, greedy_state = jax.eval_shape(greedy_network.init, key,
            inputs_for(first_observation, greedy_component, True), greedy_previous)
        decoded = serialization.msgpack_restore(artifacts["checkpoint"].read_bytes())
        verify_adam_count(decoded, state["resumed_optimizer_updates"])
        param_leaves, param_count = verify_tree_schema(expected_params, decoded["params"], "params")
        verify_tree_schema(expected_state, decoded["network_state"], "network_state")
        verify_tree_schema(greedy_params, decoded["params"], "greedy_params")
        verify_tree_schema(greedy_state, decoded["network_state"], "greedy_state")
        if param_count != artifacts["result"]["parameter_count"]:
            raise TensorError("Resumed parameter count changed")
        params = jax.tree_util.tree_map(jnp.asarray, decoded["params"])
        network_state = jax.tree_util.tree_map(jnp.asarray, decoded["network_state"])
        optimizer = optax.adam(recipe["learning_rate"])
        template = {"params": jax.device_get(params), "network_state": jax.device_get(network_state),
                    "optimizer_state": jax.device_get(optimizer.init(params)), "optimizer_updates": state["optimizer_updates"]}
        restore_leaves = verify_state_dict_schema(serialization.to_state_dict(template), decoded)
        restored = serialization.from_state_dict(template, decoded)
        roundtrip = serialization.to_state_dict(restored)
        verify_state_dict_schema(decoded, roundtrip)

        def equal(left, right):
            return all(equal(value, right[name]) for name, value in left.items()) if isinstance(left, Mapping) else np.array_equal(left, right)

        if not equal(decoded, roundtrip):
            raise TensorError("Restored model/Adam values differ from saved checkpoint")
        opt_state = jax.tree_util.tree_map(jnp.asarray, restored["optimizer_state"])
        state.update(parameter_count=param_count, restored_parameter_leaves=param_leaves,
                     restored_full_state_leaves=restore_leaves, optimizer_moments_restored=True,
                     optimizer_count_restored=True, optimizer_moments_exact=True, fresh_parameter_initialization=False)
        apply, apply_greedy = jax.jit(network.apply), jax.jit(greedy_network.apply)
        loss = Supervised(action_spec=action_spec, weights={name: 0. if name in DISABLED_HEADS else 1. for name in HEADS},
                          burnin_len=0, overlap_len=0)

        def objective(parameters, model_state, inputs, wanted, active):
            (predictions, _, _), next_state = network.apply(parameters, model_state, key, inputs, previous)
            loss_inputs = predictions.copy()
            loss_inputs["step_type"] = inputs["step_type"]
            values, _ = loss.batched_loss(loss_inputs)
            return jnp.mean(values), (next_state, supervised_mask_scalar(predictions, wanted, active, array_api=jnp))

        @jax.jit
        def tentative_update(parameters, model_state, optimizer_state, inputs, wanted, active):
            (value, (next_state, masks)), gradient = jax.value_and_grad(objective, has_aux=True)(parameters, model_state, inputs, wanted, active)
            norm = jnp.sqrt(sum(jnp.sum(jnp.square(leaf)) for leaf in jax.tree_util.tree_leaves(gradient)))
            updates, next_optimizer = optimizer.update(gradient, optimizer_state, parameters)
            next_params = optax.apply_updates(parameters, updates)
            finite = jnp.all(jnp.stack([jnp.all(jnp.isfinite(leaf)) for leaf in
                jax.tree_util.tree_leaves((gradient, next_state, next_optimizer, next_params))])) & jnp.isfinite(value) & jnp.isfinite(norm)
            return next_params, next_state, next_optimizer, value, norm, finite, masks

        def evaluation_for(row_ids, scope):
            if len(row_ids) != len(set(row_ids)):
                raise TensorError("Evaluation identities must be unique and unweighted")
            teacher, events = [], []
            for number, row_id in enumerate(row_ids, 1):
                guard.check("teacher-forced evaluation")
                row = rows[row_id]
                example = tensorize_sample(row, registry, mapping, config)
                (predictions, _, _), _ = apply(params, network_state, key, inputs_for(example, component), previous)
                validate_active_logits(predictions, example["active_heads"])
                validate_supervised_masks(predictions, example)
                teacher.append(teacher_forced_metrics(predictions, example))
                guard.check("observation-only greedy evaluation")
                observation = tensorize_observation(row["frame"], registry, mapping, config)
                (predictions, _, _), _ = apply_greedy(params, network_state, key,
                    inputs_for(observation, greedy_component, True), greedy_previous)
                record = structured_prediction(predictions, registry, config)
                record["score"] = score_after_prediction(record["prediction"], row, registry, mapping, config)
                record.update(replay_id=row_id[0], player_id=row_id[1], action_ordinal=row_id[2])
                events.append(record)
                guard.check("next evaluation event")
                if number % 128 == 0:
                    print(json.dumps({"scope": scope, "evaluation_rows": number, "new_updates": state["new_optimizer_updates"]}), flush=True)
            return {"scope": scope, "new_updates": state["new_optimizer_updates"], "optimizer_updates": state["optimizer_updates"],
                    "unweighted": True, "held_out": False, "identities": row_ids,
                    "teacher_forced": {"summary": aggregate_metrics(teacher), "events": teacher},
                    "greedy": {"summary": group_metrics(events), "events": events}}

        def anchors_from(full):
            selected = {row_id: index for index, row_id in enumerate(full["identities"])}
            teacher = [full["teacher_forced"]["events"][selected[row_id]] for row_id in anchors]
            events = [full["greedy"]["events"][selected[row_id]] for row_id in anchors]
            return {"scope": "original24 anchors", "new_updates": full["new_updates"], "optimizer_updates": full["optimizer_updates"],
                    "identities": anchors, "unweighted": True, "held_out": False,
                    "teacher_forced": {"summary": aggregate_metrics(teacher), "events": teacher},
                    "greedy": {"summary": group_metrics(events), "events": events}}

        baseline = evaluation_for(list(rows), "all679TRAIN baseline")
        anchor_baseline = anchors_from(baseline)
        if anchor_baseline["teacher_forced"]["events"] != original_anchor_teacher_events(artifacts["result"], anchors):
            raise TensorError("Original24 anchor baseline differs from saved checkpoint metrics")
        state["evaluations"].append(baseline)
        state["anchor_evaluations"].append(anchor_baseline)
        state["archived_teacher_forced_metrics_reproduced"] = True
        save()
        broad_seen = set()
        for step, item in enumerate(schedule, 1):
            guard.check("tentative optimizer update")
            row_id = item["identity"]
            example = tensorize_sample(rows[row_id], registry, mapping, config)
            wanted = {name: jnp.asarray(example["labels"][name])[None, None, ...] for name in HEADS}
            active = {name: jnp.asarray(example["active_heads"][name]) for name in HEADS}
            candidate = tentative_update(params, network_state, opt_state, inputs_for(example, component), wanted, active)
            next_params, next_state, next_optimizer, value, norm, finite, masks = candidate
            value, norm, finite, masks = float(value), float(norm), bool(finite), bool(masks)
            guard.check("committing checked optimizer update")
            if not masks or not finite or not np.isfinite(value) or not np.isfinite(norm) or norm <= 0:
                raise TensorError("Invalid target mask or nonfinite/zero gradient; no optimizer commit")
            params, network_state, opt_state = next_params, next_state, next_optimizer
            if item["role"] == "broad":
                broad_seen.add(row_id)
            state.update(new_optimizer_updates=step, optimizer_updates=state["resumed_optimizer_updates"] + step,
                         broad_coverage=len(broad_seen))
            state["updates"].append({"new_update": step, "optimizer_update": state["optimizer_updates"],
                                     "identity": row_id, "role": item["role"], "partition": "train",
                                     "function_id": metadata[row_id]["function"]["id"], "loss": value,
                                     "gradient_l2_norm": norm, "finite": finite, "mask_valid": masks})
            if step % 32 == 0:
                save()
            if step % 128 == 0:
                unchanged()
                digest, _ = write_checkpoint(f"checkpoint-new-{step:04d}.msgpack")
                state.setdefault("intermediate_checkpoints", []).append({"new_updates": step, "sha256": digest})
                anchor_eval = evaluation_for(anchors, "original24 anchors")
                state["anchor_evaluations"].append(anchor_eval)
                save()
                print(json.dumps({"new_updates": step, "broad_coverage": len(broad_seen),
                                  "anchor_complete": anchor_eval["greedy"]["summary"]["complete_action_exact"]}), flush=True)
        if broad_seen != set(rows):
            raise TensorError("Single-epoch broad coverage incomplete")
        final = evaluation_for(list(rows), "all679TRAIN final")
        state["evaluations"].append(final)
        state["anchor_evaluations"].append(anchors_from(final))
        before, after = baseline["greedy"]["summary"], final["greedy"]["summary"]
        state["quality_review"] = {"required": True, "promotion_allowed": False,
            "full_action_count_change": after["complete_action_exact"] - before["complete_action_exact"],
            "function_count_change": after["function_exact"] - before["function_exact"],
            "macro_complete_action_accuracy_change": after["macro_complete_action_accuracy"] - before["macro_complete_action_accuracy"],
            "anchor_complete_action_change": state["anchor_evaluations"][-1]["greedy"]["summary"]["complete_action_exact"]
                - anchor_baseline["greedy"]["summary"]["complete_action_exact"],
            "note": "Execution success only; all evaluation uses TRAIN data. Preserve candidate even if diagnostic accuracy regresses, without automatic promotion."}
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
                digest, leaves = write_checkpoint("checkpoint.msgpack")
                state.update(checkpoint_sha256=digest, checkpoint_restore_verified=True,
                             checkpoint_restored_leaf_count=leaves, learned_from_actual_replay=True)
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
            state["function_update_counts"] = dict(Counter(str(row["function_id"]) for row in state["updates"]))
            state["role_update_counts"] = dict(Counter(row["role"] for row in state["updates"]))
            save()
            if state.get("checkpoint_restore_verified"):
                final_recipe = {"schema": "alphastar-replay-diagnostic-recipe-v1", "optimizer": "optax.adam",
                    "learning_rate": recipe["learning_rate"], "seed": 42, "steps": state["optimizer_updates"],
                    "new_steps": state["new_optimizer_updates"], "initialization": "exact resumed parameters, network state and Adam moments",
                    "resume_checkpoint_sha256": artifacts["checkpoint_sha256"], "checkpoint_sha256": state["checkpoint_sha256"],
                    "result_sha256": sha256(output / "result.json"), "dataset_hashes": state["dataset_hashes"],
                    "source_hashes": state["source_hashes"], "batch_size": 1, "unroll_length": 1,
                    "max_entities": config.max_entities, "max_selected": config.max_selected,
                    "world_size": config.world_size, "minimap_size": config.minimap_size,
                    "training_partition": "train only", "sampling_policy": state["sampling_policy"],
                    "preflight_sha256": state["preflight_sha256"], "original_anchor_identities": anchors,
                    "scheduled_new_updates": len(schedule), "actual_launch_arguments": sys.argv[1:]}
                (output / "reproduction-recipe.json").write_text(json.dumps(final_recipe, indent=2, allow_nan=False) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--preflight", type=Path, required=True, help="Exact passed preflight.json")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--upstream", type=Path, default=DEFAULT_UPSTREAM)
    parser.add_argument("--max-updates", type=int, default=1024)
    parser.add_argument("--wall-seconds", type=float, default=900)
    run(parser.parse_args())


if __name__ == "__main__":
    main()
