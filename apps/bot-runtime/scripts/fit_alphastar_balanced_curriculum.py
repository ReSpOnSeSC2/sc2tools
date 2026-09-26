"""Bounded class-balanced continuation across all preflighted TRAIN groups.

Requires the immutable all-row graph preflight and resumes exact parameters and
Adam state. Candidate execution success is not model promotion, held-out skill,
or gameplay evidence. No SC2 process or game interface is used.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from collections.abc import Mapping
import hashlib
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
    BudgetExhausted, RunGuard, supervised_mask_scalar,
    verify_adam_count, verify_resume_recipe, verify_state_dict_schema,
)
from scripts.preflight_alphastar_curriculum import (  # noqa: E402
    ALLOWED_EXCLUSIONS, dataset_provenance_guard, host_path, identity,
    label_fingerprint, observation_fingerprint, permitted_exclusion,
    validate_active_logits, validate_train_identity,
)
from pluto_sc2.alphastar_tensor import tensorize_observation, tensorize_sample  # noqa: E402
from scripts.fit_alphastar_curriculum import (  # noqa: E402
    group_metrics, original_anchor_teacher_events, require_preflight,
)


def balanced_curriculum_schedule(identities, function_by_identity, *, seed=42, updates=1024, previous=None):
    """Equal function visits with deterministic, persistent per-group cursors.

    Shuffle each group's distinct rows once per group epoch. A continuation
    starts at the saved cursor, rather than repeatedly drawing the first rows.
    """
    if (type(seed) is not int or type(updates) is not int or not 1 <= updates <= 1024
            or len(identities) != 679 or len(set(identities)) != 679
            or set(function_by_identity) != set(identities)):
        raise TensorError("Require679 distinct curriculum identities and1..1024 updates")
    groups = defaultdict(list)
    for row_id in identities:
        function = function_by_identity[row_id]
        if type(function) is not int or function < 0:
            raise TensorError("Invalid curriculum function identity")
        groups[function].append(row_id)
    if len(groups) != 21:
        raise TensorError("Require the preflighted21 function groups")
    groups = {function: sorted(rows) for function, rows in sorted(groups.items())}
    functions = list(groups)
    group_hash = hashlib.sha256(json.dumps(groups, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    initial = {"schema": "class-balanced-full-curriculum-sampler-v1", "seed": seed,
               "groups_sha256": group_hash, "function_draws": 0,
               "group_draws": {str(function): 0 for function in functions}}
    if previous is not None:
        if (set(previous) != set(initial) or previous.get("schema") != initial["schema"]
                or previous.get("seed") != seed or previous.get("groups_sha256") != group_hash
                or type(previous.get("function_draws")) is not int or previous["function_draws"] < 0
                or not isinstance(previous.get("group_draws"), dict)
                or set(previous["group_draws"]) != set(initial["group_draws"])):
            raise TensorError("Saved class-balanced sampler provenance changed")
        rounds, remainder = divmod(previous["function_draws"], len(functions))
        for index, function in enumerate(functions):
            value = previous["group_draws"][str(function)]
            if type(value) is not int or value != rounds + (index < remainder):
                raise TensorError("Saved sampler counters do not match exact function rotation")
        initial = {**previous, "group_draws": dict(previous["group_draws"])}
    cursor = {**initial, "group_draws": dict(initial["group_draws"])}
    order_cache, schedule = {}, []
    for _ in range(updates):
        function = functions[cursor["function_draws"] % len(functions)]
        count = cursor["group_draws"][str(function)]
        epoch, position = divmod(count, len(groups[function]))
        cache_key = function, epoch
        if cache_key not in order_cache:
            order = list(groups[function])
            epoch_seed = int.from_bytes(hashlib.sha256(f"{seed}:{function}:{epoch}".encode()).digest(), "big")
            random.Random(epoch_seed).shuffle(order)
            order_cache[cache_key] = order
        schedule.append({"identity": order_cache[cache_key][position], "role": "class_balanced",
                         "function_id": function, "group_draw": count, "group_epoch": epoch,
                         "group_position": position})
        cursor["function_draws"] += 1
        cursor["group_draws"][str(function)] += 1
    return schedule, initial, cursor


def own_build_metadata(library, replay_ids):
    """Retain labels as provenance only; never expose an opponent build label."""
    labels = {}
    for candidate in library.get("protoss_candidates", []):
        replay_id = candidate.get("replay_id")
        if replay_id not in replay_ids:
            continue
        own = {"replay_id": replay_id, "own_build_label": candidate.get("site_build_label"),
               "matchup": candidate.get("matchup"), "use": "metadata_only_not_model_conditioning"}
        if replay_id in labels and labels[replay_id] != own:
            raise TensorError("Conflicting own build metadata for one immutable replay")
        labels[replay_id] = own
    return [labels.get(replay_id, {"replay_id": replay_id, "own_build_label": None,
                                  "use": "metadata_unavailable_not_model_conditioning"})
            for replay_id in sorted(replay_ids)]


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
    state = {"schema": "alphastar-real-replay-diagnostic-v1", "diagnostic_mode": "class-balanced-full-curriculum-continuation-v1",
             "status": "running", "started_unix": time.time(), "pid": os.getpid(),
             "new_optimizer_updates": 0, "optimizer_updates": 0, "validation_optimizer_updates": 0,
             "checkpoints_written": 0, "game_inputs": 0, "live_game_ready": False, "strength_evidence": False,
             "model_promoted": False, "upstream_commit": PINNED_COMMIT, "disabled_supervision": list(DISABLED_HEADS),
             "training_scope": "bounded_imitation_diagnostic", "evaluations": [], "anchor_evaluations": [],
             "updates": [], "max_new_updates": args.max_updates, "wall_time_budget_seconds": args.wall_seconds,
             "evaluation_scope": "All679 unique existingTRAIN events once/unweighted; separately original24 anchors; no holdout",
             "deadline_semantics": "Checked before/after numerical operations; an in-flight compilation cannot be interrupted",
             "unique_training_events_visited": 0, "source_inputs_original_checkpoint_unchanged": False}
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
        source_paths = [Path(__file__), ROOT / "scripts/fit_alphastar_balanced.py", ROOT / "scripts/fit_alphastar_curriculum.py",
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
        build_path = Path(args.build_library).resolve() if args.build_library else None
        if build_path is not None:
            hashes[str(build_path)] = sha256(build_path)
            build_library = json.loads(build_path.read_text(encoding="utf-8"))
        else:
            build_library = {}
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
        if len(anchors) != 24 or len(set(anchors)) != 24 or not set(anchors) <= set(rows):
            raise TensorError("Original24 anchor identities must be retained exactly")
        previous_sampler = artifacts["result"].get("sampler_state")
        if previous_sampler is not None and artifacts["result"].get("sampler_state_checkpoint_updates") != artifacts["result"]["optimizer_updates"]:
            raise TensorError("Saved sampler cursor is not bound to the resumed optimizer count")
        schedule, initial_sampler, final_sampler = balanced_curriculum_schedule(
            list(rows), {row_id: item["function"]["id"] for row_id, item in metadata.items()},
            seed=42, updates=args.max_updates, previous=previous_sampler)
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
                     learning_rate=recipe["learning_rate"], seed=42, sampling_policy="equal function rotation; shuffled distinct rows within each group epoch; persisted cursors",
                     schedule=schedule, scheduled_new_updates=len(schedule), input_fingerprint_audit=preflight["input_fingerprint_audit"],
                     sampler_state_initial=initial_sampler,
                     sampler_state={**initial_sampler, "group_draws": dict(initial_sampler["group_draws"])},
                     sampler_state_checkpoint_updates=artifacts["result"]["optimizer_updates"],
                     sampler_origin="resumed_class_balanced_cursor" if previous_sampler is not None else "new_sampler_only_weights_and_Adam_resumed",
                     replay_build_metadata=own_build_metadata(build_library, {row_id[0] for row_id in rows}),
                     build_library_sha256=hashes.get(str(build_path)) if build_path else None,
                     build_labels_model_inputs=False, hidden_opponent_build_inputs=False,
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
        seen_training_events = set()
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
            seen_training_events.add(row_id)
            state["sampler_state"]["function_draws"] += 1
            state["sampler_state"]["group_draws"][str(item["function_id"])] += 1
            state.update(new_optimizer_updates=step, optimizer_updates=state["resumed_optimizer_updates"] + step,
                         sampler_state_checkpoint_updates=state["resumed_optimizer_updates"] + step,
                         unique_training_events_visited=len(seen_training_events))
            state["updates"].append({"new_update": step, "optimizer_update": state["optimizer_updates"],
                                     "identity": row_id, "role": item["role"], "partition": "train",
                                     "group_draw": item["group_draw"], "group_epoch": item["group_epoch"], "group_position": item["group_position"],
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
                print(json.dumps({"new_updates": step, "unique_training_events": len(seen_training_events),
                                  "anchor_complete": anchor_eval["greedy"]["summary"]["complete_action_exact"]}), flush=True)
        if state["sampler_state"] != final_sampler:
            raise TensorError("Committed sampler cursors differ from the deterministic schedule")
        state["class_event_coverage"] = {str(function): {
            "available_events": sum(item["function"]["id"] == function for item in metadata.values()),
            "visited_distinct_events": sum(metadata[row_id]["function"]["id"] == function for row_id in seen_training_events)}
            for function in sorted({item["function"]["id"] for item in metadata.values()})}
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
                    "scheduled_new_updates": len(schedule), "sampler_state_initial": state["sampler_state_initial"],
                    "sampler_state": state["sampler_state"], "sampler_state_checkpoint_updates": state["sampler_state_checkpoint_updates"],
                    "build_library_sha256": state["build_library_sha256"], "build_labels_model_inputs": False,
                    "actual_launch_arguments": sys.argv[1:]}
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
    parser.add_argument("--build-library", type=Path, default=ROOT / "runs/build-library-review-20260925/multi-opening-library-v2.json",
                        help="Own build-label provenance only; never model inputs or opponent labels")
    run(parser.parse_args())


if __name__ == "__main__":
    main()
