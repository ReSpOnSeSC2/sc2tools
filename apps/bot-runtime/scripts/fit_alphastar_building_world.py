"""Opt-in building world-head continuation primitives; no automatic training.

The6089 parent, full1201 corpus and all earlier model sources are immutable.
Only world-head parameters and their Adam mu/nu may change. The shared Adam
counter advances for these updates; a future full-model thaw needs a separately
reviewed optimizer contract. Camera/move/attack world outputs share this head.
"""
from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
import hashlib
import json
import math
from pathlib import Path
import sys

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))
from scripts.fit_alphastar_balanced import verify_adam_count  # noqa: E402
from scripts.fit_alphastar_full_game import balanced_full_game_schedule  # noqa: E402
from scripts.infer_alphastar_checkpoint import verify_tree_schema  # noqa: E402
from pluto_sc2.alphastar_tensor import TensorError  # noqa: E402

MODE = "building-world-only-adam-continuation-v1"
PARENT_UPDATES = 6089
PARENT_SHA256 = "a8dfbec8d7a6189c97fa5af304287bf1fa917bae5ed004d442da7685925efaa6"
MAX_UPDATES = 256
MAX_SECONDS = 600
WORLD_PREFIX = "official_lite_rich_intent_v1/world_head/"
_MODULE_SUFFIXES = (
    "downscale_ds1/conv2_d_transpose", "downscale_ds1/layer_norm",
    "downscale_ds2/conv2_d_transpose", "downscale_ds2/layer_norm",
    "downscale_ds4/conv2_d_transpose", "downscale_ds4/layer_norm",
    "logits/conv2_d_transpose", "logits/layer_norm",
    "resnet/visual_resblock/conv2_d", "resnet/visual_resblock/conv2_d_1",
    "resnet/visual_resblock/layer_norm", "resnet/visual_resblock/layer_norm_1",
    "resnet/visual_resblock_1/conv2_d", "resnet/visual_resblock_1/conv2_d_1",
    "resnet/visual_resblock_1/layer_norm", "resnet/visual_resblock_1/layer_norm_1",
    "vector_to_visual/conv2_d_transpose", "vector_to_visual/conv2_d_transpose_1",
    "vector_to_visual/layer_norm", "vector_to_visual/layer_norm_1", "vector_to_visual/layer_norm_2",
    "vector_to_visual/linear",
)
WORLD_MODULES = frozenset(WORLD_PREFIX + suffix for suffix in _MODULE_SUFFIXES)
OPENING_WORLD_ORDINALS = (139, 234, 518, 593, 692)
ROLE_CYCLE = ("opening", "full", "opening", "opening", "full", "opening", "opening", "full", "opening", "opening")


def partition_world(parameters):
    """Select exact reviewed Haiku scopes, not substring matches or zero gradients."""
    if not isinstance(parameters, Mapping) or any(not isinstance(key, str) for key in parameters):
        raise TensorError("Require exact Haiku parameter mapping")
    world = {name: value for name, value in parameters.items() if name.startswith(WORLD_PREFIX)}
    frozen = {name: value for name, value in parameters.items() if not name.startswith(WORLD_PREFIX)}
    if set(world) != WORLD_MODULES or not frozen:
        raise TensorError("World-head parameter namespaces differ from reviewed6089 schema")
    for name, leaves in world.items():
        expected = {"offset", "scale"} if "/layer_norm" in name else {"b", "w"}
        if not isinstance(leaves, Mapping) or set(leaves) != expected:
            raise TensorError("World-head parameter leaf schema changed")
    return world, frozen


def tree_digest(tree):
    """Value/dtype/shape/negative-zero exact proof over serialized numerical state."""
    digest = hashlib.sha256()

    def visit(value, path):
        if isinstance(value, Mapping):
            if any(not isinstance(key, str) for key in value):
                raise TensorError("Optimizer proof requires string-keyed state dictionaries")
            for name in sorted(value):
                visit(value[name], path + [name])
        else:
            array = np.asarray(value)
            if not np.issubdtype(array.dtype, np.number) or not np.all(np.isfinite(array)):
                raise TensorError("Nonfinite or unsupported numerical checkpoint value")
            header = json.dumps([path, array.dtype.str, list(array.shape)], separators=(",", ":")).encode()
            digest.update(len(header).to_bytes(8, "little"))
            digest.update(header)
            digest.update(np.ascontiguousarray(array).tobytes())

    visit(tree, [])
    return digest.hexdigest()


def extract_world_optimizer(decoded):
    """Restore only the world subtree while preserving the original Adam age."""
    verify_adam_count(decoded, PARENT_UPDATES)
    if decoded["network_state"] != {}:
        raise TensorError("This head-only contract requires the actual empty6089 network state")
    parameters, _ = partition_world(decoded["params"])
    adam = decoded["optimizer_state"]["0"]
    verify_tree_schema(decoded["params"], adam["mu"], "Adam/mu")
    verify_tree_schema(decoded["params"], adam["nu"], "Adam/nu")
    mu, _ = partition_world(adam["mu"])
    nu, _ = partition_world(adam["nu"])
    return deepcopy(parameters), {"0": {"count": np.asarray(adam["count"]).copy(),
                                        "mu": deepcopy(mu), "nu": deepcopy(nu)}, "1": {}}


def frozen_state_digest(decoded):
    """Do not include sharedcount or allowed world parameters/moments."""
    _, parameters = partition_world(decoded["params"])
    adam = decoded["optimizer_state"]["0"]
    _, mu = partition_world(adam["mu"])
    _, nu = partition_world(adam["nu"])
    return tree_digest({"params": parameters, "mu": mu, "nu": nu,
                        "network_state": decoded["network_state"], "optimizer_tail": decoded["optimizer_state"]["1"]})


def assemble_world_checkpoint(parent, world_parameters, world_optimizer, completed):
    """Reassemble unchanged four-key checkpoint format after a bounded update.

Do not run full Adam with zero gradients for frozen branches: that would decay
their moments and could update their parameters. Only subset Adam is permitted.
"""
    if type(completed) is not int or not 0 <= completed <= MAX_UPDATES:
        raise TensorError("World objective is bounded to0..256 updates")
    original_world, _ = extract_world_optimizer(parent)
    verify_tree_schema(original_world, world_parameters, "world params")
    subset = {"params": world_parameters, "network_state": {},
              "optimizer_state": world_optimizer, "optimizer_updates": PARENT_UPDATES + completed}
    verify_adam_count(subset, PARENT_UPDATES + completed)
    for moment in ("mu", "nu"):
        verify_tree_schema(original_world, world_optimizer["0"][moment], "world " + moment)
    candidate = deepcopy(parent)
    candidate["params"].update(deepcopy(world_parameters))
    for moment in ("mu", "nu"):
        candidate["optimizer_state"]["0"][moment].update(deepcopy(world_optimizer["0"][moment]))
    candidate["optimizer_state"]["0"]["count"] = np.asarray(world_optimizer["0"]["count"]).copy()
    candidate["optimizer_updates"] = PARENT_UPDATES + completed
    if frozen_state_digest(candidate) != frozen_state_digest(parent):
        raise TensorError("A frozen parameter, Adam moment, or network state changed")
    if completed == 0 and tree_digest(candidate) != tree_digest(parent):
        raise TensorError("Zero-update reassembly must exactly preserve full state")
    return candidate


def building_schedule(metadata, *, updates=MAX_UPDATES):
    """70% five opening points;30% balanced full building corpus, no autoresume."""
    if type(updates) is not int or not 1 <= updates <= MAX_UPDATES:
        raise TensorError("Building-world fitting permits1..256 new updates")
    selected = {key: row for key, row in metadata.items()
                if row["function"]["name"].startswith("Build_") and "world" in row["function"]["args"]}
    if not selected:
        raise TensorError("No admitted ground-targeted building labels")
    opening = [next((key for key in selected if key[2] == ordinal), None) for ordinal in OPENING_WORLD_ORDINALS]
    if any(key is None for key in opening) or len({key[:2] for key in selected}) != 1:
        raise TensorError("Require the five exact opening world targets from one immutable perspective")
    roles = [ROLE_CYCLE[step % 10] for step in range(updates)]
    full_count = roles.count("full")
    full, full_initial, full_final = balanced_full_game_schedule(list(selected),
        {key: row["function"]["id"] for key, row in selected.items()}, updates=max(1, full_count))
    initial = {"schema": "opening-building70-full30-sampler-v1", "draws": 0, "opening_draws": 0, "full": full_initial}
    schedule, opening_count, full_position = [], 0, 0
    for step, role in enumerate(roles):
        if role == "opening":
            key = opening[opening_count % len(opening)]
            item = {"identity": key, "function_id": selected[key]["function"]["id"],
                    "group_draw": opening_count, "group_epoch": opening_count // len(opening),
                    "group_position": opening_count % len(opening)}
            opening_count += 1
        else:
            item = full[full_position]
            full_position += 1
        schedule.append({**item, "role": role, "objective_draw": step})
    final = {**initial, "draws": updates, "opening_draws": opening_count,
             "full": full_final if full_count else full_initial}
    return schedule, initial, final


def retention_groups(metadata):
    """Disjoint expert-function retention groups, scored once/unweighted."""
    groups = {"building_world": [], "camera": [], "move_or_smart_world": [], "attack_world": [], "other": []}
    for key, row in metadata.items():
        function = row["function"]
        name, args = function["name"], function["args"]
        if "world" in args and name.startswith("Build_"):
            group = "building_world"
        elif name == "raw_move_camera":
            group = "camera"
        elif "world" in args and name.startswith("Attack_"):
            group = "attack_world"
        elif "world" in args and (name.startswith("Move_") or name.startswith("Smart_")):
            group = "move_or_smart_world"
        else:
            group = "other"
        groups[group].append(key)
    return groups


def historical_retention_groups(available, anchors, original):
    """Preserve the original independently admitted cohorts, with no substitutions."""
    groups = {"original24": [tuple(row) for row in anchors],
              "original679": [tuple(row) for row in original]}
    for name, expected in (("original24", 24), ("original679", 679)):
        values = groups[name]
        if len(values) != expected or len(set(values)) != expected or not set(values) <= set(available):
            raise TensorError("Historical retention cohort changed or contains unavailable identities")
    if not set(groups["original24"]) <= set(groups["original679"]):
        raise TensorError("Original anchors no longer belong to the original admitted cohort")
    return groups


def require_placement_proof(proof, checkpoint_sha256):
    if (proof.get("schema") != "alphastar-building-placement-graph-audit-v1"
            or proof.get("status") != "passed" or proof.get("checkpoint_sha256") != checkpoint_sha256
            or checkpoint_sha256 != PARENT_SHA256 or proof.get("adam_count_verified") != PARENT_UPDATES
            or any(proof.get(name) != 0 for name in ("optimizer_updates", "checkpoint_writes", "game_launches"))
            or any(proof.get(name) != 1201 for name in ("inference_rows", "teacher_graph_rows", "inference_mask_passes"))
            or proof.get("source_inputs_checkpoint_unchanged") is not True or proof.get("changed_inputs")
            or proof.get("quarantine_identities") or len(proof.get("parity", [])) != 3
            or not all(row.get("passed") is True for row in proof.get("parity", []))
            or len(proof.get("events", [])) != 1201 or not proof.get("source_and_input_hashes")
            or any(row.get("mask_checks_passed") is not True or row.get("teacher_graph_masks_passed") is not True
                   for row in proof.get("events", []))):
        raise TensorError("Building-world fitting requires a passed zero-update1201 placement graph proof")


def stage_quality(baseline, candidate, *, world_size=256):
    """Post-prediction retention only; distance never certifies legal placement."""
    def indexed(evaluation):
        return {(row["replay_id"], row["player_id"], row["action_ordinal"]): row for row in evaluation["events"]}
    before, after = indexed(baseline), indexed(candidate)
    if set(before) != set(after) or len(before) != len(baseline["events"]) or len(after) != len(candidate["events"]):
        raise TensorError("World stage evaluation changed unique identity coverage")
    earlier = all(all(value == before[key]["prediction"][head] for head, value in row["prediction"].items()
                      if head != "world") for key, row in after.items())
    gates = {"earlier_heads_exact": earlier}
    for name in ("camera", "move_or_smart_world", "attack_world", "original24", "original679"):
        if name in baseline["groups"]:
            gates[name + "_complete_retained"] = candidate["groups"][name]["complete_action_exact"] >= baseline["groups"][name]["complete_action_exact"]
        if name in baseline.get("world_error", {}):
            gates[name + "_world_error_retained"] = candidate["world_error"][name] <= baseline["world_error"][name] + 1e-6
    opening = []
    for ordinal in OPENING_WORLD_ORDINALS:
        key = next((key for key in before if key[2] == ordinal), None)
        if key is None:
            raise TensorError("Opening world target missing from stage evaluation")
        old, new = before[key], after[key]
        old_cell, new_cell = old["prediction"]["world"], new["prediction"]["world"]
        opening.append({"identity": key, "baseline_cell": [old_cell % world_size, old_cell // world_size],
                        "candidate_cell": [new_cell % world_size, new_cell // world_size],
                        "expert_cell": new["expert_world_cell"],
                        "baseline_distance": old["world_grid_error"], "candidate_distance": new["world_grid_error"]})
    old_collapse = opening[0]["baseline_cell"] == opening[1]["baseline_cell"]
    new_collapse = opening[0]["candidate_cell"] == opening[1]["candidate_cell"]
    gates["no_new_first_Pylon_Gateway_collapse"] = not new_collapse or old_collapse
    gates["five_opening_distances_retained"] = all(row["candidate_distance"] <= row["baseline_distance"] + 1e-6 for row in opening)
    return {"retention_gates": gates, "retention_gates_passed": all(gates.values()), "opening_world_targets": opening,
            "first_Pylon_Gateway_same_cell": {"baseline": old_collapse, "candidate": new_collapse},
            "native_placement_legality_claimed": False, "model_promoted": False}


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
        raise TensorError("Explicit --execute-fit,1..256 updates and<=600seconds are required")
    os.environ.setdefault("XLA_PYTHON_CLIENT_PREALLOCATE", "false")
    os.environ.setdefault("OMP_NUM_THREADS", "4")
    sys.dont_write_bytecode = True
    output, origin, dataset, proof_path = [Path(path).resolve() for path in
        (args.output, args.run, args.dataset, args.placement_proof)]
    guard = RunGuard(args.wall_seconds, [ROOT / "STOP", output / "STOP", origin / "STOP", dataset / "STOP",
        proof_path.parent / "STOP", Path(args.upstream).resolve().parent.parent / "STOP"])
    guard.check("head-only fit setup")
    if output.exists():
        raise TensorError("World-fit output must be new")
    output.mkdir(parents=True)
    state = {"schema": "alphastar-building-world-candidate-v1", "diagnostic_mode": MODE, "status": "running",
             "started_unix": time.time(), "pid": os.getpid(), "new_optimizer_updates": 0,
             "optimizer_updates": PARENT_UPDATES, "max_new_updates": args.max_updates,
             "wall_budget_seconds": args.wall_seconds, "objective": "building expert world cross-entropy only",
             "optimizer_namespace": "world-head-only-adam-v1", "world_parameter_prefix": WORLD_PREFIX,
             "shared_Adam_count_semantics": "Advances for world updates; frozen mu/nu retain exact values. Full-model thaw requires a new reviewed contract.",
             "ordinary_full_model_continuation_allowed": False, "live_game_ready": False, "model_promoted": False,
             "strength_evidence": False, "game_launches": 0, "validation_optimizer_updates": 0,
             "evaluations": [], "updates": [], "stage_checkpoints": [], "source_and_input_hashes": {},
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
        hashes = {str(host_path(path)): digest for path, digest in proof["source_and_input_hashes"].items()}
        hashes.update({str(Path(__file__).resolve()): sha256(__file__), str(proof_path): proof_sha,
                       str(origin / "reproduction-recipe.json"): recipe_sha})
        parent_sources = {str(host_path(path)): digest for path, digest in artifacts["result"]["source_hashes"].items()}
        for relative in ("scripts/fit_alphastar_full_game.py", "scripts/fit_alphastar_curriculum.py"):
            if str(ROOT / relative) not in parent_sources:
                raise TensorError("Parent receipt lacks a required sampler dependency")
        for relative in ("scripts/fit_alphastar_full_game.py", "scripts/fit_alphastar_curriculum.py",
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
        schedule, initial_sampler, final_sampler = building_schedule(metadata, updates=args.max_updates)
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
            if not example["active_heads"]["world"] or not example["metadata"]["function"]["name"].startswith("Build_"):
                raise TensorError("Non-building label entered world fitting")
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
                _, _, cursor = building_schedule(metadata, updates=step)
                stage_receipt = {"schema": "building-world-stage-checkpoint-v1", "filename": filename,
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
                    "schema": "building-world-stage-evaluation-v1", "checkpoint_sha256": stage_receipt["sha256"],
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
            save()
            if state.get("checkpoint_restore_verified"):
                final_recipe = {"schema": "building-world-only-recipe-v1", "optimizer_namespace": state["optimizer_namespace"],
                    "ordinary_full_model_continuation_allowed": False, "parent_checkpoint_sha256": PARENT_SHA256,
                    "checkpoint_sha256": state["checkpoint_sha256"], "result_sha256": sha256(output / "result.json"),
                    "placement_proof_sha256": state["placement_proof_sha256"], "source_and_input_hashes": state["source_and_input_hashes"],
                    "initial_global_Adam_count": PARENT_UPDATES, "world_updates": state["new_optimizer_updates"],
                    "shared_global_Adam_count": state["optimizer_updates"], "non_world_mu_nu_exactly_preserved": True,
                    "learning_rate": recipe["learning_rate"], "beta1": 0.9, "beta2": 0.999, "epsilon": 1e-8,
                    "max_updates": MAX_UPDATES, "max_seconds": MAX_SECONDS, "seed": 42}
                (output / "reproduction-recipe.json").write_text(json.dumps(final_recipe, indent=2) + "\n", encoding="utf-8")


def main():
    import argparse
    from scripts.train_alphastar_replay import DEFAULT_UPSTREAM
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("run", "dataset", "placement-proof", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--execute-fit", action="store_true")
    parser.add_argument("--max-updates", type=int, default=MAX_UPDATES)
    parser.add_argument("--wall-seconds", type=float, default=MAX_SECONDS)
    parser.add_argument("--upstream", type=Path, default=DEFAULT_UPSTREAM)
    run(parser.parse_args())


if __name__ == "__main__":
    main()
