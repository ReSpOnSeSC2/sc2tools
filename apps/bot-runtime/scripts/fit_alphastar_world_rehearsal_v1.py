"""Opt-in world-head rehearsal with a mandatory zero-update gradient proof.

The6089 parent, full1201 corpus and all earlier model sources are immutable.
Only world-head parameters and their Adam mu/nu may change. The shared Adam
counter advances for these updates; a future full-model thaw needs a separately
reviewed optimizer contract. Camera/move/attack world outputs share this head.
"""
from __future__ import annotations

from copy import deepcopy
import json
import math
from pathlib import Path
import sys

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))
from scripts.fit_alphastar_full_game import balanced_full_game_schedule  # noqa: E402
from scripts.infer_alphastar_checkpoint import verify_tree_schema  # noqa: E402
from pluto_sc2.alphastar_tensor import TensorError  # noqa: E402

from scripts.fit_alphastar_building_world import (  # noqa: E402
    PARENT_UPDATES, PARENT_SHA256, WORLD_MODULES, WORLD_PREFIX, OPENING_WORLD_ORDINALS,
    assemble_world_checkpoint, extract_world_optimizer, frozen_state_digest, tree_digest,
    partition_world, retention_groups, historical_retention_groups, require_placement_proof, stage_quality,
)

MODE = "world-rehearsal-opening50-retention40-other10-v1"
MAX_UPDATES = 128
MAX_SECONDS = 600
ALREADY_SPENT = 64
GLOBAL_CEILING = 256
ROLE_CYCLE = ("opening", "rehearsal", "opening", "rehearsal", "other", "opening", "rehearsal", "opening", "rehearsal", "opening")
REHEARSAL_CLASSES = ("camera", "move_or_smart_world", "attack_world")


def mixed_world_schedule(metadata, *, updates=MAX_UPDATES):
    """Deterministic 50/40/10 objective; replay labels remain unchanged."""
    if type(updates) is not int or not 1 <= updates <= MAX_UPDATES or ALREADY_SPENT + updates > GLOBAL_CEILING:
        raise TensorError("Distinct rehearsal permits1..128 updates within the original remaining192")
    groups = retention_groups(metadata)
    opening = [next((key for key in groups["building_world"] if key[2] == ordinal), None) for ordinal in OPENING_WORLD_ORDINALS]
    if any(key is None for key in opening) or len({key[:2] for key in metadata}) != 1:
        raise TensorError("Require all five original opening points from one replay perspective")
    other = [key for key in groups["building_world"] if key not in opening]
    if not other or any(not groups[name] for name in REHEARSAL_CLASSES):
        raise TensorError("Require nonempty other-building and camera/move/attack rehearsal pools")
    roles = [ROLE_CYCLE[step % len(ROLE_CYCLE)] for step in range(updates)]
    rehearsal = [REHEARSAL_CLASSES[index % 3] for index in range(roles.count("rehearsal"))]
    initial = {"schema": MODE + "-sampler", "draws": 0, "opening_draws": 0, "rehearsal_draws": 0, "groups": {}}
    final, schedules, cursors = deepcopy(initial), {}, {}
    for name, identities in {"other": other, **{name: groups[name] for name in REHEARSAL_CLASSES}}.items():
        count = roles.count("other") if name == "other" else rehearsal.count(name)
        items, before, after = balanced_full_game_schedule(identities,
            {key: metadata[key]["function"]["id"] for key in identities}, updates=max(1, count))
        schedules[name], cursors[name] = items, 0
        initial["groups"][name], final["groups"][name] = before, after if count else before
    schedule, opening_count, rehearsal_count = [], 0, 0
    for step, role in enumerate(roles):
        if role == "opening":
            key = opening[opening_count % 5]
            item = {"identity": key, "function_id": metadata[key]["function"]["id"], "group_draw": opening_count,
                    "group_epoch": opening_count // 5, "group_position": opening_count % 5}
            opening_count += 1
            class_name = "opening"
        else:
            class_name = "other" if role == "other" else REHEARSAL_CLASSES[rehearsal_count % 3]
            item = schedules[class_name][cursors[class_name]]
            cursors[class_name] += 1
            rehearsal_count += role == "rehearsal"
        schedule.append({**item, "role": role, "rehearsal_class": class_name, "objective_draw": step})
    final.update(draws=updates, opening_draws=opening_count, rehearsal_draws=rehearsal_count)
    return schedule, initial, final


def require_objective_proof(proof, source_sha):
    if (proof.get("schema") != "world-rehearsal-zero-update-proof-v1" or proof.get("status") != "passed"
            or proof.get("objective_version") != MODE or proof.get("checkpoint_sha256") != PARENT_SHA256
            or proof.get("source_sha256") != source_sha or proof.get("source_inputs_checkpoint_unchanged") is not True
            or proof.get("optimizer_updates") != 0 or proof.get("checkpoint_writes") != 0 or proof.get("game_launches") != 0
            or proof.get("probes") != 8 or len(proof.get("events", [])) != 8
            or proof.get("optimizer_constructed") is not False or proof.get("full_checkpoint_state_unchanged") is not True
            or set(proof.get("roles", [])) != {"opening", *REHEARSAL_CLASSES}
            or not proof.get("source_and_input_hashes")
            or not all(row.get("masks_passed") and row.get("gradient_finite") and row.get("gradient_norm", 0) > 0
                       and row.get("world_gradient_matches_full") for row in proof.get("events", []))):
        raise TensorError("Require exact-source passed zero-update world-rehearsal gradient proof")
    events = proof["events"]
    if (len({tuple(row["identity"]) for row in events}) != 8
            or {row["identity"][2] for row in events if row["role"] == "opening"} != set(OPENING_WORLD_ORDINALS)
            or any(sum(row["role"] == name for row in events) != 1 for name in REHEARSAL_CLASSES)):
        raise TensorError("Zero-update proof changed the five-opening/three-rehearsal coverage")

def run(args):
    """Explicit opt-in; writes a separately versioned, non-promoted candidate."""
    import os
    import shutil
    import time
    import traceback

    from scripts.fit_alphastar_balanced import BudgetExhausted, RunGuard, supervised_mask_scalar, verify_resume_recipe
    from scripts.fit_alphastar_full_game import read_hashed_json, verified_checkpoint_bytes, group_metrics
    from scripts.infer_alphastar_checkpoint import read_checkpoint_artifacts, score_after_prediction, structured_prediction
    from scripts.preflight_alphastar_curriculum import host_path, identity, validate_active_logits
    from scripts.train_alphastar_replay import HEADS, read_dataset, sha256, train_rows, verify_upstream
    from pluto_sc2.alphastar_tensor import tensorize_observation, tensorize_sample, validate_supervised_masks

    if (args.execute_fit is not True or type(args.max_updates) is not int or not 1 <= args.max_updates <= MAX_UPDATES
            or not 0 < args.wall_seconds <= MAX_SECONDS):
        raise TensorError("Explicit --execute-fit,1..128 updates and<=600seconds are required")
    os.environ.setdefault("XLA_PYTHON_CLIENT_PREALLOCATE", "false")
    os.environ.setdefault("OMP_NUM_THREADS", "4")
    sys.dont_write_bytecode = True
    output, origin, dataset, proof_path = [Path(path).resolve() for path in
        (args.output, args.run, args.dataset, args.placement_proof)]
    guard = RunGuard(args.wall_seconds, [ROOT / "STOP", output / "STOP", origin / "STOP", dataset / "STOP",
        proof_path.parent / "STOP", Path(args.objective_proof).resolve().parent / "STOP",
        Path(args.upstream).resolve().parent.parent / "STOP"])
    guard.check("head-only fit setup")
    if output.exists():
        raise TensorError("World-fit output must be new")
    output.mkdir(parents=True)
    state = {"schema": "alphastar-world-rehearsal-candidate-v1", "diagnostic_mode": MODE, "status": "running",
             "started_unix": time.time(), "pid": os.getpid(), "new_optimizer_updates": 0,
             "optimizer_updates": PARENT_UPDATES, "max_new_updates": args.max_updates,
             "wall_budget_seconds": args.wall_seconds, "objective": "world CE: opening50%, camera/move/attack rehearsal40%, other building10%",
             "optimizer_namespace": "world-head-only-adam-v1", "world_parameter_prefix": WORLD_PREFIX,
             "shared_Adam_count_semantics": "Advances for world updates; frozen mu/nu retain exact values. Full-model thaw requires a new reviewed contract.",
             "ordinary_full_model_continuation_allowed": False, "live_game_ready": False, "model_promoted": False,
             "strength_evidence": False, "game_launches": 0, "validation_optimizer_updates": 0,
             "evaluations": [], "updates": [], "stage_checkpoints": [], "source_and_input_hashes": {},
             "specialization_budget": {"ceiling": GLOBAL_CEILING, "previously_spent": ALREADY_SPENT, "remaining_before": GLOBAL_CEILING - ALREADY_SPENT, "this_candidate_cap": MAX_UPDATES},
             "deadline_semantics": "Checked around numerical calls; in-flight compilation is not interruptible"}
    parent = world_parameters = world_opt_state = None

    def save():
        pending = output / "result.json.pending"
        pending.write_text(json.dumps(state, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        pending.replace(output / "result.json")

    def unchanged():
        guard.check_stop()
        if any(sha256(path) != digest for path, digest in state["source_and_input_hashes"].items()):
            raise TensorError("World-fit source, proof, corpus or parent checkpoint changed")

    save()
    try:
        state["pid_creation_time"] = __import__("psutil").Process().create_time()
        save()
        artifacts = read_checkpoint_artifacts(origin, dataset / "game-data.json")
        recipe, recipe_sha = read_hashed_json(origin / "reproduction-recipe.json")
        verify_resume_recipe(artifacts, recipe)
        if artifacts["checkpoint_sha256"] != PARENT_SHA256 or artifacts["result"]["optimizer_updates"] != PARENT_UPDATES:
            raise TensorError("World fitting starts only from exact6089 parent")
        proof, proof_sha = read_hashed_json(proof_path)
        require_placement_proof(proof, artifacts["checkpoint_sha256"])
        objective_path = Path(args.objective_proof).resolve()
        objective_proof, objective_sha = read_hashed_json(objective_path)
        require_objective_proof(objective_proof, sha256(__file__))
        hashes = {str(host_path(path)): digest for path, digest in proof["source_and_input_hashes"].items()}
        for path, digest in objective_proof["source_and_input_hashes"].items():
            path = str(host_path(path))
            if path in hashes and hashes[path] != digest:
                raise TensorError("Objective and placement proof disagree")
            hashes[path] = digest
        hashes[str(objective_path)] = objective_sha
        state["objective_proof_sha256"] = objective_sha
        hashes.update({str(Path(__file__).resolve()): sha256(__file__), str(proof_path): proof_sha,
                       str(origin / "reproduction-recipe.json"): recipe_sha})
        parent_sources = {str(host_path(path)): digest for path, digest in artifacts["result"]["source_hashes"].items()}
        for relative in ("scripts/fit_alphastar_full_game.py", "scripts/fit_alphastar_curriculum.py"):
            if str(ROOT / relative) not in parent_sources:
                raise TensorError("Parent receipt lacks a required sampler dependency")
        for relative in ("scripts/fit_alphastar_building_world.py", "scripts/fit_alphastar_full_game.py", "scripts/fit_alphastar_curriculum.py",
                         "scripts/fit_alphastar_balanced.py", "scripts/infer_alphastar_checkpoint.py",
                         "scripts/preflight_alphastar_curriculum.py", "scripts/train_alphastar_replay.py",
                         "scripts/alphastar_building_placement_bridge_v1.py", "scripts/alphastar_eligibility_bridge_v2.py",
                         "scripts/alphastar_eligibility_bridge_v1.py", "scripts/alphastar_capacity_bridge.py",
                         "src/pluto_sc2/action_eligibility_v2.py", "src/pluto_sc2/building_placement_v1.py",
                         "src/pluto_sc2/alphastar_tensor.py", "src/pluto_sc2/policy_intents.py",
                         "src/pluto_sc2/rich_intents.py", "src/pluto_sc2/rich_actions.py"):
            path = str(ROOT / relative)
            digest = sha256(path)
            if path in hashes and hashes[path] != digest:
                raise TensorError("A source differs from the placement proof")
            if path in parent_sources and parent_sources[path] != digest:
                raise TensorError("A required dependency differs from the parent source receipt")
            hashes[path] = digest
        state["source_and_input_hashes"] = hashes
        unchanged()
        manifest, catalog, dataset_hashes, counts = read_dataset(dataset)
        if dataset_hashes != artifacts["result"]["dataset_hashes"] or dict(counts) != {"train": 1217}:
            raise TensorError("Immutable full replay corpus changed")
        registry, mapping, config = artifacts["registry"], artifacts["unit_types"], artifacts["config"]
        wanted = {tuple(value) for value in artifacts["result"]["admitted_identities"]}
        previous = {tuple(event["identity"]): event for event in proof["events"]}
        if len(wanted) != 1201 or set(previous) != wanted:
            raise TensorError("Placement proof does not retain exact1201 admitted identities")
        rows, metadata, world_labels = {}, {}, {}
        for row in train_rows(dataset):
            guard.check("immutable TRAIN row verification")
            key = identity(row)
            if key not in wanted:
                continue
            if row.get("partition") != "train" or manifest["replay_partitions"].get(key[0]) != "train" or key in rows:
                raise TensorError("TRAIN identity duplicate or partition changed")
            example = tensorize_sample(row, registry, mapping, config)
            rows[key], metadata[key] = row, example["metadata"]
            if example["active_heads"]["world"]:
                world_labels[key] = int(example["labels"]["world"])
        if set(rows) != wanted:
            raise TensorError("Missing admitted TRAIN observations")
        schedule, initial_sampler, final_sampler = mixed_world_schedule(metadata, updates=args.max_updates)
        groups = retention_groups(metadata)
        if len(groups["building_world"]) != 28:
            raise TensorError("Expected all28 unchanged admitted ground-building observations")
        groups.update(historical_retention_groups(rows, artifacts["result"]["original_anchor_identities"],
                                                 artifacts["result"]["original_admitted_identities"]))
        state.update(checkpoint_parent_sha256=PARENT_SHA256, placement_proof_sha256=proof_sha,
                     admitted_identities=list(rows), admitted_samples=1201, dataset_hashes=dataset_hashes,
                     tensor_config=artifacts["result"]["tensor_config"], sampler_initial=initial_sampler,
                     scheduled_sampler_final=final_sampler, schedule=schedule, retention_groups=groups,
                     original_anchor_identities=artifacts["result"]["original_anchor_identities"],
                     original_admitted_identities=artifacts["result"]["original_admitted_identities"],
                     world_modules=sorted(WORLD_MODULES))
        snapshot = output / "source-snapshot"
        snapshot.mkdir()
        state["source_hashes"] = {path: digest for path, digest in hashes.items() if Path(path).suffix == ".py"}
        if len({Path(path).name for path in state["source_hashes"]}) != len(state["source_hashes"]):
            raise TensorError("Source snapshot filenames must be unique")
        for path, digest in state["source_hashes"].items():
            shutil.copy2(path, snapshot / Path(path).name)
            if sha256(snapshot / Path(path).name) != digest:
                raise TensorError("Source snapshot differs")
        shutil.copy2(origin / "registry.json", output / "registry.json")
        verify_upstream(args.upstream)
        sys.path.insert(0, str(Path(args.upstream).resolve()))
        from scripts.alphastar_building_placement_bridge_v1 import build_placement_bridge, WORLD_INPUT, CLASSES_INPUT
        from scripts.alphastar_eligibility_bridge_v2 import FUNCTION_INPUT, SOURCES_INPUT
        from scripts.alphastar_capacity_bridge import configure_capacity_runtime
        from pluto_sc2.action_eligibility_v2 import build_action_eligibility
        from pluto_sc2.building_placement_v1 import build_placement_masks
        import jax
        import jax.numpy as jnp
        import haiku as hk
        import optax
        from flax import serialization
        from alphastar import types
        from alphastar.unplugged.losses.supervised import Supervised
        configure_capacity_runtime(artifacts["result"])
        if not any(device.platform == "gpu" for device in jax.devices()):
            raise TensorError("Explicit fitting requires the pinnedGPU runtime")

        def encode(row, *, training):
            example = tensorize_sample(row, registry, mapping, config) if training else tensorize_observation(row["frame"], registry, mapping, config)
            eligibility = build_action_eligibility(row["frame"], example["metadata"]["entity_tags"], registry, catalog, max_entities=config.max_entities)
            placement = build_placement_masks(row["frame"], registry, catalog)
            example["inputs"] = {**example["inputs"], FUNCTION_INPUT: np.asarray(eligibility["function_mask"], bool),
                SOURCES_INPUT: np.asarray(eligibility["source_masks"], bool),
                WORLD_INPUT: np.asarray(placement["masks"], bool).reshape(3, config.world_size**2),
                CLASSES_INPUT: np.asarray(placement["function_classes"], np.int32)}
            return example

        first_key = schedule[0]["identity"]
        first, first_observation = encode(rows[first_key], training=True), encode(rows[first_key], training=False)
        component, action_spec = build_placement_bridge(first, config, registry, is_training=True)
        greedy_component, _ = build_placement_bridge(first_observation, config, registry, is_training=False, sampling_mode="greedy")
        network = hk.transform_with_state(jax.vmap(component.unroll))
        greedy = hk.transform_with_state(jax.vmap(greedy_component.unroll))
        key = jax.random.PRNGKey(42)
        empty_state = {}
        prev = jax.tree_util.tree_map(lambda spec: jnp.zeros((1,) + spec.shape, spec.dtype), component.prev_state_spec)
        greedy_prev = jax.tree_util.tree_map(lambda spec: jnp.zeros((1,) + spec.shape, spec.dtype), greedy_component.prev_state_spec)

        def inputs_for(encoded, model):
            result = types.StreamDict()
            for name, spec in model.input_spec.items():
                spec.validate(encoded["inputs"][name])
                result[name] = jnp.asarray(encoded["inputs"][name])[None, None, ...]
            return result

        expected_params, expected_state = jax.eval_shape(network.init, key, inputs_for(first, component), prev)
        parent = serialization.msgpack_restore(verified_checkpoint_bytes(artifacts))
        leaves, total_parameters = verify_tree_schema(expected_params, parent["params"], "params")
        verify_tree_schema(expected_state, parent["network_state"], "network state")
        initial_world, initial_world_optimizer = extract_world_optimizer(parent)
        world_parameters = jax.tree_util.tree_map(jnp.asarray, initial_world)
        _, frozen_parameters = partition_world(parent["params"])
        frozen_parameters = jax.tree_util.tree_map(jnp.asarray, frozen_parameters)
        optimizer = optax.adam(recipe["learning_rate"])
        world_opt_state = serialization.from_state_dict(optimizer.init(world_parameters), initial_world_optimizer)
        world_opt_state = jax.tree_util.tree_map(jnp.asarray, world_opt_state)
        initial_check = assemble_world_checkpoint(parent, jax.device_get(world_parameters),
            serialization.to_state_dict(jax.device_get(world_opt_state)), 0)
        state.update(parameter_count=total_parameters, parameter_leaves=leaves,
                     frozen_state_sha256=frozen_state_digest(parent), exact_parameter_and_Adam_restore=True,
                     zero_update_full_state_sha256=tree_digest(initial_check), network_state_empty=True,
                     world_parameter_count=sum(np.asarray(value).size for module in initial_world.values() for value in module.values()),
                     world_parameter_leaves=44, devices=[str(device) for device in jax.devices()])
        loss = Supervised(action_spec=action_spec, weights={name: float(name == "world") for name in HEADS}, burnin_len=0, overlap_len=0)

        def full_params(world):
            return {**frozen_parameters, **world}

        def objective(world, inputs, wanted_labels, active):
            (prediction, _, _), next_state = network.apply(full_params(world), empty_state, key, inputs, prev)
            if next_state:
                raise TensorError("Unexpected mutable network state")
            loss_inputs = prediction.copy()
            loss_inputs["step_type"] = inputs["step_type"]
            values, _ = loss.batched_loss(loss_inputs)
            return jnp.mean(values), supervised_mask_scalar(prediction, wanted_labels, active, array_api=jnp)

        @jax.jit
        def update(world, optimizer_state, inputs, wanted_labels, active):
            (value, valid), gradient = jax.value_and_grad(objective, has_aux=True)(world, inputs, wanted_labels, active)
            delta, next_optimizer = optimizer.update(gradient, optimizer_state, world)
            candidate = optax.apply_updates(world, delta)
            norm = jnp.sqrt(sum(jnp.sum(jnp.square(leaf)) for leaf in jax.tree_util.tree_leaves(gradient)))
            finite = jnp.all(jnp.stack([jnp.all(jnp.isfinite(leaf)) for leaf in jax.tree_util.tree_leaves((candidate, next_optimizer, gradient))]))
            return candidate, next_optimizer, value, norm, finite, valid

        apply, infer = jax.jit(network.apply), jax.jit(greedy.apply)

        def decorate_world(record, row_id):
            if row_id in world_labels and record["score"]["metrics"]["function_exact"]:
                wanted = world_labels[row_id]
                actual = record["prediction"]["world"]
                record["expert_world_cell"] = [wanted % config.world_size, wanted // config.world_size]
                record["world_grid_error"] = math.hypot(actual % config.world_size - wanted % config.world_size,
                                                       actual // config.world_size - wanted // config.world_size)
            return record

        def summarize(events, scope):
            indexed = {(row["replay_id"], row["player_id"], row["action_ordinal"]): row for row in events}
            errors = {name: [indexed[row_id]["world_grid_error"] for row_id in values if "world_grid_error" in indexed[row_id]]
                      for name, values in groups.items()}
            return {"scope": scope, "unweighted": True, "held_out": False, "new_updates": state["new_optimizer_updates"],
                    "events": events, "summary": group_metrics(events),
                    "groups": {name: group_metrics([indexed[row_id] for row_id in values]) for name, values in groups.items() if values},
                    "world_error": {name: float(np.mean(values)) for name, values in errors.items() if values}}

        def evaluate(scope):
            events = []
            for number, (row_id, row) in enumerate(rows.items(), 1):
                guard.check("unweighted full1201 world-retention evaluation")
                example = encode(row, training=True)
                (teacher, _, _), _ = apply(full_params(world_parameters), empty_state, key, inputs_for(example, component), prev)
                validate_active_logits(teacher, example["active_heads"])
                validate_supervised_masks(teacher, example)
                observation = encode(row, training=False)
                (prediction, _, _), _ = infer(full_params(world_parameters), empty_state, key, inputs_for(observation, greedy_component), greedy_prev)
                record = structured_prediction(prediction, registry, config)
                record.update(replay_id=row_id[0], player_id=row_id[1], action_ordinal=row_id[2])
                record["score"] = score_after_prediction(record["prediction"], row, registry, mapping, config)
                events.append(decorate_world(record, row_id))
                if number % 128 == 0:
                    print(json.dumps({"scope": scope, "rows": number, "new_updates": state["new_optimizer_updates"]}), flush=True)
            return summarize(events, scope)

        baseline_events = []
        for row_id in rows:
            record = deepcopy(previous[row_id])
            record.update(replay_id=row_id[0], player_id=row_id[1], action_ordinal=row_id[2])
            baseline_events.append(decorate_world(record, row_id))
        baseline = summarize(baseline_events, "reused immutable full1201 zero-update placement proof")
        probes = [tuple(row) for row in artifacts["result"]["reload_probe_identities"]]
        if len(probes) != 64 or len(set(probes)) != 64 or not set(probes) <= set(rows):
            raise TensorError("Require original independent64-frame reload probe")
        for row_id in probes:
            guard.check("64-frame initial graph reload")
            observation = encode(rows[row_id], training=False)
            (prediction, _, _), _ = infer(full_params(world_parameters), empty_state, key,
                inputs_for(observation, greedy_component), greedy_prev)
            actual = structured_prediction(prediction, registry, config)
            if not actual["mask_checks_passed"] or actual["prediction"] != previous[row_id]["prediction"]:
                raise TensorError("Restored graph differs from the immutable placement baseline")
        state["baseline_provenance"] = {"full1201": "hash-bound existing zero-update graph proof",
            "freshly_reloaded_canonical_predictions": 64, "no_new_full_baseline_forward_claim": True}
        state["evaluations"].append(baseline)
        save()
        for step, item in enumerate(schedule, 1):
            guard.check("tentative world-only update")
            example = encode(rows[item["identity"]], training=True)
            if not example["active_heads"]["world"]:
                raise TensorError("Inactive-world label entered rehearsal fitting")
            labels = {name: jnp.asarray(example["labels"][name])[None, None, ...] for name in HEADS}
            active = {name: jnp.asarray(example["active_heads"][name]) for name in HEADS}
            next_world, next_optimizer, value, norm, finite, valid = update(world_parameters, world_opt_state, inputs_for(example, component), labels, active)
            value, norm, finite, valid = float(value), float(norm), bool(finite), bool(valid)
            guard.check("committing finite world-only update")
            if not finite or not valid or not np.isfinite(value) or not np.isfinite(norm) or norm <= 0:
                raise TensorError("World-only gradient is nonfinite/zero or a label is masked")
            world_parameters, world_opt_state = next_world, next_optimizer
            state.update(new_optimizer_updates=step, optimizer_updates=PARENT_UPDATES + step)
            state["updates"].append({"step": step, "identity": item["identity"], "world_loss": value, "world_gradient_norm": norm})
            if step % 32 == 0:
                unchanged()
                save()
            if step % 64 == 0 or step == len(schedule):
                unchanged()
                stage = assemble_world_checkpoint(parent, jax.device_get(world_parameters),
                    serialization.to_state_dict(jax.device_get(world_opt_state)), step)
                blob = serialization.to_bytes(stage)
                if tree_digest(serialization.msgpack_restore(blob)) != tree_digest(stage):
                    raise TensorError("Stage checkpoint serialization changed values")
                filename = f"checkpoint-world-{step:04d}.msgpack"
                with (output / filename).open("xb") as stream:
                    stream.write(blob)
                _, _, cursor = mixed_world_schedule(metadata, updates=step)
                stage_receipt = {"schema": "world-rehearsal-stage-checkpoint-v1", "filename": filename,
                    "sha256": sha256(output / filename), "new_updates": step, "optimizer_updates": PARENT_UPDATES + step,
                    "frozen_state_sha256": frozen_state_digest(stage), "sampler_state": cursor,
                    "placement_proof_sha256": proof_sha, "source_hashes": state["source_hashes"],
                    "model_promoted": False, "evaluation_status": "pending"}
                (output / f"checkpoint-world-{step:04d}.json").write_text(json.dumps(stage_receipt, indent=2) + "\n")
                state["stage_checkpoints"].append(stage_receipt)
                save()
                final = evaluate(f"world-only stage{step}, all1201")
                quality = stage_quality(baseline, final, world_size=config.world_size)
                if not quality["retention_gates"]["earlier_heads_exact"]:
                    raise TensorError("A frozen earlier head changed canonical predictions")
                state["evaluations"].append(final)
                state["stage_checkpoints"][-1] = {**stage_receipt, "evaluation_status": "complete", "quality": quality}
                (output / f"evaluation-world-{step:04d}.json").write_text(json.dumps({
                    "schema": "world-rehearsal-stage-evaluation-v1", "checkpoint_sha256": stage_receipt["sha256"],
                    "new_updates": step, "evaluation": final, "quality": quality}, indent=2) + "\n")
                state.update(earlier_heads_exact_all1201=True, retention_gates=quality["retention_gates"],
                             retention_gates_passed=quality["retention_gates_passed"],
                             checkpoint_selection="independent reload and root review required; no automatic promotion")
                save()
                if not quality["retention_gates_passed"]:
                    state["stopped_after_retention_regression"] = True
                    break
        state["status"] = "passed"
    except BudgetExhausted as error:
        state.update(status="budget_exhausted", error=str(error))
    except BaseException as error:
        state.update(status="failed", error=f"{type(error).__name__}: {error}", traceback=traceback.format_exc())
        raise
    finally:
        try:
            unchanged()
            if parent is not None and state["new_optimizer_updates"] and state["status"] in ("passed", "budget_exhausted"):
                candidate = assemble_world_checkpoint(parent, jax.device_get(world_parameters),
                    serialization.to_state_dict(jax.device_get(world_opt_state)), state["new_optimizer_updates"])
                blob = serialization.to_bytes(candidate)
                if tree_digest(serialization.msgpack_restore(blob)) != tree_digest(candidate):
                    raise TensorError("World checkpoint serialization changed values")
                with (output / "checkpoint.msgpack").open("xb") as stream:
                    stream.write(blob)
                state.update(checkpoint_sha256=sha256(output / "checkpoint.msgpack"), frozen_parameters_and_moments_exact=True,
                             frozen_state_sha256_final=frozen_state_digest(candidate), checkpoint_restore_verified=True)
            state["source_inputs_checkpoint_unchanged"] = True
        except BaseException as error:
            state.update(status="failed", finalization_error=str(error))
            raise
        finally:
            state.update(finished_unix=time.time(), wall_seconds=time.time() - state["started_unix"])
            state["specialization_budget"]["spent_after_this_candidate"] = ALREADY_SPENT + state["new_optimizer_updates"]
            state["specialization_budget"]["remaining_after_this_candidate"] = GLOBAL_CEILING - ALREADY_SPENT - state["new_optimizer_updates"]
            save()
            if state.get("checkpoint_restore_verified"):
                final_recipe = {"schema": "world-rehearsal-only-recipe-v1", "optimizer_namespace": state["optimizer_namespace"],
                    "ordinary_full_model_continuation_allowed": False, "parent_checkpoint_sha256": PARENT_SHA256,
                    "checkpoint_sha256": state["checkpoint_sha256"], "result_sha256": sha256(output / "result.json"),
                    "placement_proof_sha256": state["placement_proof_sha256"], "source_and_input_hashes": state["source_and_input_hashes"],
                    "initial_global_Adam_count": PARENT_UPDATES, "world_updates": state["new_optimizer_updates"],
                    "shared_global_Adam_count": state["optimizer_updates"], "non_world_mu_nu_exactly_preserved": True,
                    "learning_rate": recipe["learning_rate"], "beta1": 0.9, "beta2": 0.999, "epsilon": 1e-8,
                    "specialization_budget": state["specialization_budget"], "objective_proof_sha256": state["objective_proof_sha256"],
                    "max_updates": MAX_UPDATES, "max_seconds": MAX_SECONDS, "seed": 42}
                (output / "reproduction-recipe.json").write_text(json.dumps(final_recipe, indent=2) + "\n", encoding="utf-8")


def preflight(args):
    """Actual zero-update supervised loss/gradient proof; constructs no optimizer."""
    import os
    import time
    import traceback
    import psutil
    from scripts.audit_alphastar_world_logits_v1 import distribution_metrics, competing_learning_processes
    from scripts.alphastar_source_objective import gradient_comparison
    from scripts.fit_alphastar_balanced import RunGuard
    from scripts.infer_alphastar_checkpoint import read_checkpoint_artifacts
    from scripts.preflight_alphastar_curriculum import host_path, identity
    from scripts.train_alphastar_replay import sha256, train_rows, verify_upstream, HEADS
    from scripts.alphastar_capacity_bridge import configure_capacity_runtime
    from scripts.alphastar_building_placement_bridge_v1 import build_placement_bridge, WORLD_INPUT, CLASSES_INPUT
    from scripts.alphastar_eligibility_bridge_v2 import FUNCTION_INPUT, SOURCES_INPUT
    from pluto_sc2.action_eligibility_v2 import build_action_eligibility
    from pluto_sc2.building_placement_v1 import build_placement_masks
    from pluto_sc2.alphastar_tensor import tensorize_sample, validate_supervised_masks
    os.environ.setdefault("XLA_PYTHON_CLIENT_PREALLOCATE", "false")
    os.environ.setdefault("OMP_NUM_THREADS", "4")
    sys.dont_write_bytecode = True
    output, origin, dataset, placement_path, audit_path = [Path(path).resolve() for path in
        (args.output, args.run, args.dataset, args.placement_proof, args.world_audit)]
    guard = RunGuard(min(args.wall_seconds, MAX_SECONDS), [ROOT / "STOP", output / "STOP", origin / "STOP",
        dataset / "STOP", placement_path.parent / "STOP", Path(args.upstream).resolve().parent.parent / "STOP"])
    guard.check("zero-update rehearsal preflight")
    if output.exists() or competing_learning_processes(psutil):
        raise TensorError("Require a new proof directory and no other learning process")
    output.mkdir(parents=True)
    state = {"schema": "world-rehearsal-zero-update-proof-v1", "objective_version": MODE, "status": "running",
        "pid": os.getpid(), "pid_creation_time": psutil.Process().create_time(), "started_unix": time.time(),
        "optimizer_updates": 0, "checkpoint_writes": 0, "game_launches": 0, "events": [],
        "source_sha256": sha256(__file__), "source_and_input_hashes": {}, "probes": 0,
        "optimizer_constructed": False, "specialization_budget": {"ceiling": GLOBAL_CEILING, "previously_spent": ALREADY_SPENT,
                                                                   "candidate_maximum": MAX_UPDATES}}

    def save():
        temporary = output / "audit.json.pending"
        temporary.write_text(json.dumps(state, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        temporary.replace(output / "audit.json")

    save()
    try:
        artifacts = read_checkpoint_artifacts(origin, dataset / "game-data.json")
        if artifacts["checkpoint_sha256"] != PARENT_SHA256 or artifacts["result"]["optimizer_updates"] != PARENT_UPDATES:
            raise TensorError("Require exact6089 checkpoint")
        placement = json.loads(placement_path.read_text())
        require_placement_proof(placement, PARENT_SHA256)
        diagnostic = json.loads(audit_path.read_text())
        if (diagnostic.get("schema") != "fixed-frame-world-logit-diagnostic-v1" or diagnostic.get("status") != "passed"
                or diagnostic.get("checkpoints") != {"parent6089": PARENT_SHA256,
                    "candidate6153": "5c49d908b85bbd63e1f89fc1eadbcc9f437b28cdc03b5ed4b0f007e7956baa5a"}
                or diagnostic.get("source_inputs_checkpoints_unchanged") is not True
                or len(diagnostic.get("events", [])) != 20):
            raise TensorError("Require fixed-frame diagnosis of the already-spent64 updates")
        hashes = {}
        for receipt in (placement, diagnostic):
            for path, digest in receipt["source_and_input_hashes"].items():
                path = str(host_path(path))
                if (path in hashes and hashes[path] != digest) or sha256(path) != digest:
                    raise TensorError("Immutable diagnosis provenance changed")
                hashes[path] = digest
        for path in (Path(__file__), placement_path, audit_path, ROOT / "scripts/alphastar_source_objective.py",
                     ROOT / "scripts/audit_alphastar_world_logits_v1.py", ROOT / "scripts/fit_alphastar_building_world.py"):
            hashes[str(path)] = sha256(path)
        state["source_and_input_hashes"] = hashes
        wanted = {tuple(row) for row in artifacts["result"]["admitted_identities"]}
        rows, metadata = {}, {}
        for row in train_rows(dataset):
            guard.check("zero-update immutable corpus verification")
            row_id = identity(row)
            if row_id in wanted:
                if row_id in rows or row.get("partition") != "train":
                    raise TensorError("Duplicate or non-TRAIN row")
                rows[row_id] = row
                metadata[row_id] = tensorize_sample(row, artifacts["registry"], artifacts["unit_types"], artifacts["config"])["metadata"]
        if set(rows) != wanted or len(rows) != 1201:
            raise TensorError("Corpus admission changed")
        groups = retention_groups(metadata)
        if len(groups["building_world"]) != 28:
            raise TensorError("Original28 building observations changed")
        schedule, initial, final = mixed_world_schedule(metadata, updates=128)
        selected = [(next(key for key in rows if key[2] == ordinal), "opening") for ordinal in OPENING_WORLD_ORDINALS]
        selected.extend((groups[name][0], name) for name in REHEARSAL_CLASSES)
        state.update(checkpoint_sha256=PARENT_SHA256, roles=sorted({role for _, role in selected}),
                     sampler_initial=initial, sampler_128_final=final, schedule_128=schedule,
                     admitted_identities=list(rows), metadata_groups={name: len(values) for name, values in groups.items()})
        state["upstream_manifest_sha256"], _ = verify_upstream(args.upstream)
        sys.path.insert(0, str(Path(args.upstream).resolve()))
        import jax
        import jax.numpy as jnp
        import haiku as hk
        from flax import serialization
        from alphastar import types
        from alphastar.unplugged.losses.supervised import Supervised
        configure_capacity_runtime(artifacts["result"])
        if not any(device.platform == "gpu" for device in jax.devices()):
            raise TensorError("Require pinnedGPU proof runtime")
        parent = serialization.msgpack_restore(artifacts["checkpoint"].read_bytes())
        initial_digest = tree_digest(parent)
        world, _ = extract_world_optimizer(parent)
        _, frozen = partition_world(parent["params"])
        world, frozen = [jax.tree_util.tree_map(jnp.asarray, tree) for tree in (world, frozen)]
        registry, config = artifacts["registry"], artifacts["config"]

        def encode(row):
            example = tensorize_sample(row, registry, artifacts["unit_types"], config)
            eligibility = build_action_eligibility(row["frame"], example["metadata"]["entity_tags"], registry,
                                                  artifacts["catalog"], max_entities=config.max_entities)
            placement_masks = build_placement_masks(row["frame"], registry, artifacts["catalog"])
            example["inputs"].update({FUNCTION_INPUT: np.asarray(eligibility["function_mask"], bool),
                SOURCES_INPUT: np.asarray(eligibility["source_masks"], bool),
                WORLD_INPUT: np.asarray(placement_masks["masks"], bool).reshape(3, 65536),
                CLASSES_INPUT: np.asarray(placement_masks["function_classes"], np.int32)})
            return example

        example = encode(rows[selected[0][0]])
        component, action_spec = build_placement_bridge(example, config, registry, is_training=True)
        network = hk.transform_with_state(jax.vmap(component.unroll))
        previous = jax.tree_util.tree_map(lambda spec: jnp.zeros((1,) + spec.shape, spec.dtype), component.prev_state_spec)
        rng = jax.random.PRNGKey(42)

        def inputs_for(encoded):
            streams = types.StreamDict()
            for name, spec in component.input_spec.items():
                spec.validate(encoded["inputs"][name])
                streams[name] = jnp.asarray(encoded["inputs"][name])[None, None, ...]
            return streams

        expected, expected_state = jax.eval_shape(network.init, rng, inputs_for(example), previous)
        verify_tree_schema(expected, parent["params"], "params")
        verify_tree_schema(expected_state, parent["network_state"], "network_state")
        loss = Supervised(action_spec=action_spec, weights={head: float(head == "world") for head in HEADS}, burnin_len=0, overlap_len=0)

        def objective(parameters, inputs):
            (prediction, _, _), mutable = network.apply(parameters, {}, rng, inputs, previous)
            if mutable:
                raise TensorError("Unexpected mutable network state")
            loss_inputs = prediction.copy()
            loss_inputs["step_type"] = inputs["step_type"]
            values, _ = loss.batched_loss(loss_inputs)
            return jnp.mean(values), prediction

        subset_gradient = jax.jit(jax.value_and_grad(lambda parameters, inputs: objective({**frozen, **parameters}, inputs), has_aux=True))
        full_gradient = jax.jit(jax.value_and_grad(objective, has_aux=True))
        full_parameters = {**frozen, **world}
        for row_id, role in selected:
            guard.check("zero-update world gradient proof")
            example = encode(rows[row_id])
            (value, prediction), gradient = subset_gradient(world, inputs_for(example))
            (full_value, _), full = full_gradient(full_parameters, inputs_for(example))
            value, full_value, prediction, gradient, full = jax.device_get((value, full_value, prediction, gradient, full))
            validate_supervised_masks(prediction, example)
            if not example["active_heads"]["world"]:
                raise TensorError("Proof includes inactive world target")
            world_full, _ = partition_world(full)
            comparison = gradient_comparison(world_full, gradient, rtol=2e-6, atol=2e-6)
            reference = distribution_metrics(np.asarray(prediction["logits", "world"])[0, 0],
                np.asarray(prediction["masks", "world"])[0, 0], int(example["labels"]["world"]))
            norm = float(np.sqrt(sum(np.sum(np.square(np.asarray(leaf, np.float64))) for leaf in jax.tree_util.tree_leaves(gradient))))
            finite = all(np.isfinite(leaf).all() for leaf in jax.tree_util.tree_leaves(gradient))
            if (not comparison["passed"] or not finite or norm <= 0 or not np.isclose(value, full_value, rtol=2e-6, atol=2e-6)
                    or not np.isclose(value, reference["target_ce_nats"], rtol=2e-6, atol=2e-6)):
                raise TensorError("World CE or subset/full gradient proof failed")
            state["events"].append({"identity": row_id, "role": role, "world_ce": float(value),
                "independent_ce": reference["target_ce_nats"], "masks_passed": True, "gradient_finite": finite,
                "gradient_norm": norm, "world_gradient_matches_full": True, "gradient_comparison": comparison})
            state["probes"] = len(state["events"])
            save()
            print(json.dumps({"probe": row_id[2], "role": role, "world_ce": float(value), "norm": norm}), flush=True)
        if tree_digest(parent) != initial_digest:
            raise TensorError("Zero-update parent state changed")
        state.update(status="passed", full_checkpoint_state_unchanged=True)
    except BaseException as error:
        state.update(status="failed", error=f"{type(error).__name__}: {error}", traceback=traceback.format_exc())
        raise
    finally:
        if any(sha256(path) != digest for path, digest in state["source_and_input_hashes"].items()):
            state.update(status="failed", finalization_error="Pinned source or input changed")
        state.update(source_inputs_checkpoint_unchanged=state["status"] == "passed",
                     finished_unix=time.time(), wall_seconds=time.time() - state["started_unix"])
        save()


def main():
    import argparse
    from scripts.train_alphastar_replay import DEFAULT_UPSTREAM
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("run", "dataset", "placement-proof", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--preflight-only", action="store_true")
    modes.add_argument("--execute-fit", action="store_true")
    parser.add_argument("--world-audit", type=Path)
    parser.add_argument("--objective-proof", type=Path)
    parser.add_argument("--max-updates", type=int, default=MAX_UPDATES)
    parser.add_argument("--wall-seconds", type=float, default=MAX_SECONDS)
    parser.add_argument("--upstream", type=Path, default=DEFAULT_UPSTREAM)
    args = parser.parse_args()
    if args.preflight_only:
        if not args.world_audit:
            parser.error("--preflight-only requires --world-audit")
        preflight(args)
    else:
        if not args.objective_proof:
            parser.error("--execute-fit requires --objective-proof")
        run(args)


if __name__ == "__main__":
    main()
