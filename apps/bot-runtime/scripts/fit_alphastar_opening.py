"""Two bounded opening-focused continuation stages; no automatic promotion.

Restores the exact5065 checkpoint/Adam before a new objective and persistent
70/30 opening/full-game sampler. Only immutable TRAIN observations enter updates.
Each invocation permits<=1024 updates and<=900s; the lineage permits<=2048 total.
"""
from __future__ import annotations

import argparse
from collections import Counter
from collections.abc import Mapping
from copy import deepcopy
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
from scripts.fit_alphastar_full_game import (  # noqa: E402
    DEFAULT_UPSTREAM, DISABLED_HEADS, HEADS, PINNED_COMMIT, TensorError,
    aggregate_metrics, read_dataset, runtime_registry, sha256, teacher_forced_metrics,
    train_rows, validate_supervised_masks, verify_upstream, read_checkpoint_artifacts,
    score_after_prediction, structured_prediction, validate_observation_only, verify_tree_schema,
    BudgetExhausted, RunGuard, supervised_mask_scalar, verify_adam_count, verify_resume_recipe,
    verify_state_dict_schema, host_path, identity, label_fingerprint, observation_fingerprint,
    validate_active_logits, validate_train_identity, tensorize_observation, tensorize_sample,
    group_metrics, original_anchor_teacher_events, CAPACITY_MATMUL_PRECISION,
    build_capacity_bridge, configure_capacity_runtime, balanced_full_game_schedule,
    full_dataset_guard, require_full_game_preflight, read_hashed_json, require_capacity_adapter,
    pin_artifact_inputs, verified_checkpoint_bytes, exclusion_index, mask_exclusion_index,
    verified_mask_exclusion, verify_admission_coverage, matches_exclusion, retention_identities,
    evaluation_subset, mixed_reload_order, own_build_metadata,
)
from scripts.alphastar_source_objective import (  # noqa: E402
    SOURCE_OBJECTIVE, make_source_objective, objective_contract, require_objective_contract,
)

MODE = "opening70-full30-source-normalization16-v1"
BASE_UPDATES = 5065
MAX_TOTAL_UPDATES = 2048
BASE_CHECKPOINT = "b875612894a602e6537ef226b9394c50ba082776a254e570a2122fb42abbca22"
BASE_RESULT = "4f823d38fef000fe6783b975c3344766b3fe15f2cbb6d621b5cd8f4c2f2882ef"
GRADIENT_AUDIT_SHA256 = "4938679a02bdfd0f029930c800fb010d692c86bb7732286a3622c0fc198ed5b1"
REPLAY = "ca381f141989827f2888542ea74f2dddc3c0a87d980a9665f7380ef6393fc21e"
MILESTONES = {139: "Build_Pylon_pt", 234: "Build_Gateway_pt", 518: "Build_Nexus_pt",
              533: "Build_Assimilator_unit", 593: "Build_CyberneticsCore_pt",
              613: "Train_Probe_quick", 639: "Build_Assimilator_unit", 692: "Build_Pylon_pt"}
ROLE_CYCLE = ("opening", "full", "opening", "opening", "full", "opening", "opening", "full", "opening", "opening")


def opening_identities(metadata):
    expected = [(REPLAY, 2, ordinal) for ordinal in MILESTONES]
    if any(row_id not in metadata or metadata[row_id]["function"]["name"] != MILESTONES[row_id[2]]
           for row_id in expected):
        raise TensorError("Exact requested opening milestone labels changed")
    opening = [row_id for row_id in metadata if row_id[:2] == (REPLAY, 2) and row_id[2] <= max(MILESTONES)]
    if len(opening) != 285 or len(set(opening)) != 285:
        raise TensorError("Frozen opening pool must contain285 causal TRAIN observations")
    names = {metadata[row_id]["function"]["name"] for row_id in opening}
    if not {"raw_move_camera", "Train_Probe_quick", "Smart_unit"} <= names:
        raise TensorError("Opening pool lost camera, worker production or mining supervision")
    return opening, expected


def opening_schedule(identities, function_by_identity, opening, *, updates=1024, previous=None):
    """Exact7/10 opening visits; both pools persist balanced per-function cursors."""
    if (type(updates) is not int or not 1 <= updates <= 1024 or not opening
            or len(set(opening)) != len(opening) or not set(opening) <= set(identities)):
        raise TensorError("Require unique opening subset and1..1024 stage updates")
    pools = {"opening": opening, "full": identities}
    initial_children = {}
    for role, values in pools.items():
        _, initial_children[role], _ = balanced_full_game_schedule(values,
            {key: function_by_identity[key] for key in values}, updates=1)
    initial = {"schema": MODE + "-sampler", "objective_id": SOURCE_OBJECTIVE,
               "draws": 0, "pools": initial_children}
    if previous is not None:
        if (set(previous) != set(initial) or previous.get("schema") != initial["schema"]
                or previous.get("objective_id") != SOURCE_OBJECTIVE
                or type(previous.get("draws")) is not int or not 0 <= previous["draws"] <= MAX_TOTAL_UPDATES
                or not isinstance(previous.get("pools"), dict) or set(previous["pools"]) != set(pools)):
            raise TensorError("Opening sampler lineage changed")
        expected = Counter(ROLE_CYCLE[index % 10] for index in range(previous["draws"]))
        for role, values in pools.items():
            _, verified, _ = balanced_full_game_schedule(values,
                {key: function_by_identity[key] for key in values}, updates=1, previous=previous["pools"][role])
            if verified["function_draws"] != expected[role]:
                raise TensorError("Opening sampler role counters differ from70/30 sequence")
        initial = deepcopy(previous)
    if initial["draws"] + updates > MAX_TOTAL_UPDATES:
        raise TensorError("Opening continuation is bounded to2048 updates after5065")
    roles = [ROLE_CYCLE[index % 10] for index in range(initial["draws"], initial["draws"] + updates)]
    counts, schedules, cursor = Counter(roles), {}, deepcopy(initial)
    for role, values in pools.items():
        if counts[role]:
            schedules[role], _, cursor["pools"][role] = balanced_full_game_schedule(values,
                {key: function_by_identity[key] for key in values}, updates=counts[role], previous=initial["pools"][role])
    positions, result = Counter(), []
    for index, role in enumerate(roles):
        item = schedules[role][positions[role]]
        result.append({**item, "role": role, "objective_draw": initial["draws"] + index})
        positions[role] += 1
    cursor["draws"] += updates
    return result, initial, cursor


def commit_sampler(cursor, item):
    """Advance only after an actual finite, mask-checked optimizer update."""
    if (item["objective_draw"] != cursor["draws"]
            or item["role"] != ROLE_CYCLE[cursor["draws"] % 10]):
        raise TensorError("Committed update differs from deterministic opening schedule")
    child = cursor["pools"][item["role"]]
    key = str(item["function_id"])
    if child["group_draws"].get(key) != item["group_draw"]:
        raise TensorError("Opening sampler source group counter drifted")
    cursor["draws"] += 1
    child["function_draws"] += 1
    child["group_draws"][key] += 1


def require_gradient_audit(audit):
    if (audit.get("schema") != "alphastar-source-objective-gradient-audit-v1" or audit.get("status") != "passed"
            or audit.get("normalization_gradient_proof") is not True
            or audit.get("source_inputs_checkpoint_unchanged") is not True
            or audit.get("optimizer_updates") != 0 or audit.get("checkpoint_writes") != 0
            or audit.get("game_launches") != 0 or audit.get("matmul_precision") != "highest"
            or len(audit.get("records", [])) < 3 or not all(row.get("passed") is True for row in audit["records"])
            or not any(row.get("inactive_loss_and_gradient_zero") is True for row in audit["records"])
            or not any(row.get("new_source_proof", {}).get("source_count", 0) > 1 for row in audit["records"])
            or not audit.get("source_and_input_hashes")):
        raise TensorError("Requires completed actual CPU network-gradient audit; unit tests are insufficient")
    require_objective_contract(audit.get("objective"), 64)
    return {str(host_path(path)): digest for path, digest in audit["source_and_input_hashes"].items()}


def require_opening_origin(artifacts, recipe, origin, catalog_path, audit_sha):
    """First exact5065; subsequent stages bind the same immutable base and audit."""
    result = artifacts["result"]
    if result.get("diagnostic_mode") == "class-balanced-full-game-continuation-v1":
        base, base_path, previous = artifacts, Path(origin).resolve(), None
    elif result.get("diagnostic_mode") == MODE:
        require_objective_contract(result.get("objective"), 64)
        require_objective_contract(recipe.get("objective"), 64)
        if not result.get("opening_base_run"):
            raise TensorError("Opening continuation lost immutable5065 origin")
        base_path = host_path(result["opening_base_run"]).resolve()
        base = read_checkpoint_artifacts(base_path, catalog_path)
        previous = result.get("sampler_state")
        count = result.get("optimizer_updates")
        if (result.get("objective_audit_sha256") != audit_sha or recipe.get("objective_audit_sha256") != audit_sha
                or result.get("opening_base_checkpoint_sha256") != BASE_CHECKPOINT
                or result.get("opening_base_result_sha256") != BASE_RESULT
                or type(count) is not int or not BASE_UPDATES < count < BASE_UPDATES + MAX_TOTAL_UPDATES
                or not isinstance(previous, dict) or previous.get("draws") != count - BASE_UPDATES
                or result.get("sampler_state_checkpoint_updates") != count
                or recipe.get("sampler_state") != previous
                or any(result.get(key) != base["result"].get(key) for key in (
                    "dataset_hashes", "split_sha256", "tensor_config", "capacity_adapter", "matmul_precision", "preflight_sha256"))):
            raise TensorError("Opening continuation objective, capacity, origin or update cursor changed")
    else:
        raise TensorError("Require exact5065 origin or reviewed bounded opening continuation")
    if (base["checkpoint_sha256"] != BASE_CHECKPOINT or base["result_sha256"] != BASE_RESULT
            or base["result"].get("optimizer_updates") != BASE_UPDATES):
        raise TensorError("Opening origin must be exact reviewed5065 parameters and Adam")
    return base, base_path, previous


def run(args):
    if type(args.max_updates) is not int or not 1 <= args.max_updates <= 1024:
        raise TensorError("Maximum new updates must be in1..1024")
    os.environ.setdefault("XLA_PYTHON_CLIENT_PREALLOCATE", "false")
    os.environ.setdefault("OMP_NUM_THREADS", "4")
    os.environ.setdefault("JAX_COMPILATION_CACHE_DIR", str(Path.home() / ".cache/sc2-alphastar-v1/jax"))
    sys.dont_write_bytecode = True
    output, origin, dataset, preflight_path = [Path(value).resolve() for value in
                                              (args.output, args.run, args.dataset, args.preflight)]
    guard = RunGuard(args.wall_seconds, [ROOT / "STOP", output / "STOP", origin / "STOP", dataset / "STOP", Path(args.objective_audit).resolve().parent / "STOP",
                                         preflight_path.parent / "STOP", DEFAULT_UPSTREAM.parent.parent / "STOP"])
    guard.check("creating output")
    if output.exists():
        raise TensorError("Output must be new; existing models are immutable")
    output.mkdir(parents=True)
    state = {"schema": "alphastar-real-replay-diagnostic-v1", "diagnostic_mode": MODE, "objective": objective_contract(64),
             "status": "running", "started_unix": time.time(), "pid": os.getpid(),
             "new_optimizer_updates": 0, "optimizer_updates": 0, "validation_optimizer_updates": 0,
             "checkpoints_written": 0, "game_inputs": 0, "live_game_ready": False, "strength_evidence": False,
             "model_promoted": False, "upstream_commit": PINNED_COMMIT, "disabled_supervision": list(DISABLED_HEADS),
             "training_scope": "bounded_imitation_diagnostic", "evaluations": [], "anchor_evaluations": [], "retention_evaluations": [], "attack_evaluations": [], "opening_evaluations": [], "milestone_evaluations": [], "worker_mining_evaluations": [],
             "updates": [], "max_new_updates": args.max_updates, "wall_time_budget_seconds": args.wall_seconds,
             "evaluation_scope": "All preflighted full-game TRAIN events once/unweighted; original679 and24 subsets; no holdout",
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
        recipe, recipe_sha = read_hashed_json(origin / "reproduction-recipe.json")
        verify_resume_recipe(artifacts, recipe)
        audit_path = Path(args.objective_audit).resolve()
        audit, audit_sha = read_hashed_json(audit_path)
        if audit_sha != GRADIENT_AUDIT_SHA256:
            raise TensorError("Requires the exact reviewed CPU gradient audit receipt")
        audit_inputs = require_gradient_audit(audit)
        if any(sha256(path) != digest for path, digest in audit_inputs.items()):
            raise TensorError("Actual gradient-audit source/input changed")
        base_artifacts, base_path, previous_sampler = require_opening_origin(
            artifacts, recipe, origin, dataset / "game-data.json", audit_sha)
        if artifacts["result"]["optimizer_updates"] - BASE_UPDATES + args.max_updates > MAX_TOTAL_UPDATES:
            raise TensorError("Two-stage opening update cap would be exceeded")
        manifest, _, dataset_hashes, _ = read_dataset(dataset)
        preflight, preflight_sha = read_hashed_json(preflight_path)
        admitted, migration_artifacts, migration_path = require_full_game_preflight(
            preflight, base_artifacts, dataset_hashes, origin=base_path, catalog_path=dataset / "game-data.json",
            preflight_sha256=preflight_sha)
        split_path = host_path(manifest["split_path"])
        if sha256(split_path) != manifest["split_sha256"]:
            raise TensorError("Pinned whole-replay split changed")
        train_ids, validation_ids = full_dataset_guard(manifest, dataset_hashes, artifacts["result"],
                                                       json.loads(split_path.read_text(encoding="utf-8")))
        preflight_inputs = {str(host_path(path)): digest for path, digest in preflight["source_and_input_hashes"].items()}
        for path, digest in preflight_inputs.items():
            if sha256(path) != digest:
                raise TensorError(f"Preflight source/input no longer matches: {path}")
        source_paths = [Path(__file__), ROOT / "scripts/alphastar_source_objective.py", ROOT / "scripts/audit_alphastar_source_objective.py", ROOT / "scripts/fit_alphastar_full_game.py", ROOT / "scripts/alphastar_capacity_bridge.py", ROOT / "scripts/migrate_alphastar_capacity.py", ROOT / "scripts/fit_alphastar_balanced.py", ROOT / "scripts/fit_alphastar_curriculum.py",
                        ROOT / "scripts/preflight_alphastar_curriculum.py", ROOT / "scripts/train_alphastar_replay.py",
                        ROOT / "scripts/infer_alphastar_checkpoint.py", ROOT / "src/pluto_sc2/alphastar_tensor.py",
                        ROOT / "src/pluto_sc2/rich_actions.py", ROOT / "src/pluto_sc2/rich_intents.py"]
        source_hashes = {str(path): sha256(path) for path in source_paths}
        prior_sources = {Path(path.replace("\\", "/")).name: digest for path, digest in artifacts["result"]["source_hashes"].items()}
        for path, digest in source_hashes.items():
            if ((path in preflight_inputs and preflight_inputs[path] != digest)
                    or (Path(path).name in prior_sources and prior_sources[Path(path).name] != digest)):
                raise TensorError(f"Shared source differs from the preflight/checkpoint: {path}")
        hashes = {**audit_inputs, **preflight_inputs, **source_hashes, str(preflight_path): preflight_sha, str(audit_path): audit_sha}
        # The original migration's proof does not itself name a later resumed
        # candidate. Pin both, including recipes, for the complete run lifetime.
        hashes.update(pin_artifact_inputs(origin, artifacts, recipe_sha))
        base_recipe, base_recipe_sha = read_hashed_json(base_path / "reproduction-recipe.json")
        verify_resume_recipe(base_artifacts, base_recipe)
        hashes.update(pin_artifact_inputs(base_path, base_artifacts, base_recipe_sha))
        migration_recipe, migration_recipe_sha = read_hashed_json(migration_path / "reproduction-recipe.json")
        verify_resume_recipe(migration_artifacts, migration_recipe)
        hashes.update(pin_artifact_inputs(migration_path, migration_artifacts, migration_recipe_sha))
        adapter = require_capacity_adapter(preflight, artifacts["result"], recipe,
                                            migration_artifacts["result"], migration_recipe)
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
        rows, metadata, omissions, mask_omissions = {}, {}, [], []
        expected_exclusions = exclusion_index(preflight)
        expected_mask_exclusions = mask_exclusion_index(preflight)
        for row in train_rows(dataset):
            guard.check("CPU curriculum verification")
            validate_train_identity(row, manifest["replay_partitions"], train_ids, validation_ids)
            row_id = identity(row)
            try:
                example = tensorize_sample(row, registry, mapping, config)
            except TensorError as exc:
                if not matches_exclusion(row, exc, expected_exclusions):
                    raise
                omissions.append(row_id)
                continue
            observation = tensorize_observation(row["frame"], registry, mapping, config)
            if verified_mask_exclusion(row, example, observation, expected_mask_exclusions):
                mask_omissions.append(row_id)
                continue
            proof = admitted.get(row_id)
            if (proof is None or row_id in rows or proof["function"] != example["metadata"]["function"]["name"]
                    or proof["label_sha256"] != label_fingerprint(example)
                    or proof["observation_sha256"] != observation_fingerprint(observation)
                    or set(proof["verified_unmasked_targets"]) != {head for head, active in example["active_heads"].items() if active}):
                raise TensorError("CPU event/tensor differs from the exact preflight admission")
            rows[row_id], metadata[row_id] = row, example["metadata"]
        verify_admission_coverage(rows, admitted, omissions, expected_exclusions, mask_omissions,
                                  expected_mask_exclusions, manifest["counts"]["train_samples"])
        if sum(record["function"]["name"].startswith("Attack_") for record in metadata.values()) != 29:
            raise TensorError("All29 admitted attack events must survive the exact mask admission")
        anchors = [tuple(item) for item in artifacts["result"].get("original_anchor_identities", [])]
        if not anchors:
            anchors = [(item["replay_id"], item["player_id"], item["action_ordinal"])
                       for item in artifacts["result"]["mask_proofs"]]
        if len(anchors) != 24 or len(set(anchors)) != 24 or not set(anchors) <= set(rows):
            raise TensorError("Original24 anchor identities must be retained exactly")
        retention = retention_identities(preflight, artifacts["result"], set(rows))
        opening, milestones = opening_identities(metadata)
        worker_mining = [row_id for row_id in opening if metadata[row_id]["function"]["name"]
                        in {"Train_Probe_quick", "Smart_unit", "Harvest_Gather_unit", "Harvest_Return_quick"}]
        schedule, initial_sampler, final_sampler = opening_schedule(
            list(rows), {row_id: item["function"]["id"] for row_id, item in metadata.items()}, opening,
            updates=args.max_updates, previous=previous_sampler)
        diagnostic_order = mixed_reload_order(metadata, anchors)
        state.update(objective=objective_contract(64), objective_audit_sha256=audit_sha,
                     objective_audit_path=str(audit_path), opening_base_run=str(base_path),
                     opening_base_checkpoint_sha256=BASE_CHECKPOINT, opening_base_result_sha256=BASE_RESULT,
                     maximum_objective_updates=MAX_TOTAL_UPDATES, opening_identities=opening,
                     opening_milestone_identities=milestones, worker_mining_identities=worker_mining,
                     dataset_hashes=dataset_hashes, split_sha256=manifest["split_sha256"], source_hashes=source_hashes,
                     source_and_input_hashes=hashes, preflight_sha256=preflight_sha, preflight_path=str(preflight_path),
                     tensor_config=artifacts["result"]["tensor_config"], capacity_adapter=adapter,
                     matmul_precision=CAPACITY_MATMUL_PRECISION, original_anchor_identities=anchors,
                     admitted_identities=list(rows), known_excluded_identities=omissions + mask_omissions,
                     known_tensor_excluded_identities=omissions,
                     known_mask_exclusions=list(expected_mask_exclusions.values()),
                     mask_exclusion_fingerprints_reproved=True, admitted_samples=len(rows),
                     original_admitted_identities=retention, original_retention_count=len(retention),
                     original_anchor_count=len(anchors), function_groups=len({item["function"]["id"] for item in metadata.values()}),
                     sample_provenance=list(metadata.values()), mask_proofs=[{**metadata[row_id], "verified_unmasked_targets":
                         admitted[row_id]["verified_unmasked_targets"]} for row_id in diagnostic_order],
                     reload_probe_identities=diagnostic_order[:64], reload_probe_max_frames=64,
                     reload_probe_scope="mixed sameTRAIN original24 anchors + all29 admitted attacks + other functions/late rows; canonical corpus unchanged",
                     optimizer_updates=artifacts["result"]["optimizer_updates"],
                     resumed_optimizer_updates=artifacts["result"]["optimizer_updates"],
                     resume_checkpoint_sha256=artifacts["checkpoint_sha256"], resume_result_sha256=artifacts["result_sha256"],
                     learning_rate=recipe["learning_rate"], seed=42, sampling_policy="7/10 opening285,3/10 full1201; function-balanced within each pool; persistent deterministic cursors",
                     schedule=schedule, scheduled_new_updates=len(schedule), input_fingerprint_audit=preflight["input_fingerprint_audit"],
                     sampler_state_initial=initial_sampler,
                     sampler_state=deepcopy(initial_sampler),
                     sampler_state_checkpoint_updates=artifacts["result"]["optimizer_updates"],
                     sampler_origin="resumed_opening_objective_cursor" if previous_sampler is not None else "explicit_new_objective_and70/30_groups_after5065",
                     archived_previous_sampler_state=base_artifacts["result"]["sampler_state"],
                     capacity_migration_run=str(migration_path),
                     capacity_migration_checkpoint_sha256=migration_artifacts["checkpoint_sha256"],
                     capacity_migration_result_sha256=migration_artifacts["result_sha256"],
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
        configure_capacity_runtime(artifacts["result"])
        state["effective_matmul_precision"] = jax.config.jax_default_matmul_precision
        if not any(device.platform == "gpu" for device in jax.devices()):
            raise TensorError("Requires the isolated pinnedGPU runtime")
        state["devices"] = [str(device) for device in jax.devices()]
        if runtime_registry(artifacts["catalog"]) != (registry, mapping):
            raise TensorError("Saved vocabulary changed")
        first = tensorize_sample(rows[anchors[0]], registry, mapping, config)
        first_observation = tensorize_observation(rows[anchors[0]]["frame"], registry, mapping, config)
        component, action_spec = build_capacity_bridge(first, config, registry)
        greedy_component, _ = build_capacity_bridge(first_observation, config, registry,
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
        decoded = serialization.msgpack_restore(verified_checkpoint_bytes(artifacts))
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
        loss = make_source_objective(action_spec)

        @jax.jit
        def head_losses(predictions, step_type):
            inputs = predictions.copy()
            inputs["step_type"] = step_type
            return {name: jnp.mean(value) for name, value in loss.batched_head_losses(inputs).items()}

        def objective(parameters, model_state, inputs, wanted, active):
            (predictions, _, _), next_state = network.apply(parameters, model_state, key, inputs, previous)
            loss_inputs = predictions.copy()
            loss_inputs["step_type"] = inputs["step_type"]
            values, _ = loss.batched_loss(loss_inputs)
            return jnp.mean(values), (next_state, supervised_mask_scalar(predictions, wanted, active, array_api=jnp), head_losses(predictions, inputs["step_type"]))

        @jax.jit
        def tentative_update(parameters, model_state, optimizer_state, inputs, wanted, active):
            (value, (next_state, masks, heads)), gradient = jax.value_and_grad(objective, has_aux=True)(parameters, model_state, inputs, wanted, active)
            norm = jnp.sqrt(sum(jnp.sum(jnp.square(leaf)) for leaf in jax.tree_util.tree_leaves(gradient)))
            updates, next_optimizer = optimizer.update(gradient, optimizer_state, parameters)
            next_params = optax.apply_updates(parameters, updates)
            finite = jnp.all(jnp.stack([jnp.all(jnp.isfinite(leaf)) for leaf in
                jax.tree_util.tree_leaves((gradient, next_state, next_optimizer, next_params))])) & jnp.isfinite(value) & jnp.isfinite(norm)
            return next_params, next_state, next_optimizer, value, norm, finite, masks, heads

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
                teacher_record = teacher_forced_metrics(predictions, example)
                teacher_record["objective_head_losses"] = {name: float(value) for name, value in
                    head_losses(predictions, jnp.asarray(example["inputs"]["step_type"])[None, None]).items()}
                if not all(np.isfinite(value) for value in teacher_record["objective_head_losses"].values()):
                    raise TensorError("Nonfinite per-head evaluation loss")
                teacher.append(teacher_record)
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
                    "teacher_forced": {"summary": aggregate_metrics(teacher), "events": teacher,
                        "objective_head_loss_mean": {name: float(np.mean([row["objective_head_losses"][name]
                            for row in teacher])) for name in HEADS}},
                    "greedy": {"summary": group_metrics(events), "events": events}}

        def record_subsets(full):
            anchor = evaluation_subset(full, anchors, "original24 anchors")
            state["anchor_evaluations"].append(anchor)
            state["retention_evaluations"].append(evaluation_subset(full, retention, "original679 retention"))
            attacks = [row_id for row_id in rows if metadata[row_id]["function"]["name"].startswith("Attack_")]
            if not attacks:
                raise TensorError("Full-game curriculum must retain its admitted attack events")
            state["attack_evaluations"].append(evaluation_subset(full, attacks, "all admitted attack events"))
            state["opening_evaluations"].append(evaluation_subset(full, opening, "all285 opening observations"))
            state["milestone_evaluations"].append(evaluation_subset(full, milestones, "eight ordered opening milestones"))
            state["worker_mining_evaluations"].append(evaluation_subset(full, worker_mining, "opening worker/mining unit targets"))
            return anchor

        baseline = evaluation_for(list(rows), "all full-game TRAIN baseline")
        anchor_baseline = record_subsets(baseline)
        expected_anchor = (preflight.get("migrated_anchor_teacher_events") if origin == migration_path
                           else original_anchor_teacher_events(artifacts["result"], anchors))
        if [{key: value for key, value in row.items() if key != "objective_head_losses"} for row in anchor_baseline["teacher_forced"]["events"]] != [{key: value for key, value in row.items() if key != "objective_head_losses"} for row in expected_anchor]:
            raise TensorError("Original24 anchor baseline differs from the exact migrated-shape preflight")
        state["evaluations"].append(baseline)
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
            next_params, next_state, next_optimizer, value, norm, finite, masks, heads = candidate
            value, norm, finite, masks = float(value), float(norm), bool(finite), bool(masks)
            heads = {name: float(number) for name, number in heads.items()}
            if (not all(np.isfinite(number) for number in heads.values())
                    or not np.isclose(sum(heads.values()), value, rtol=2e-5, atol=2e-4)):
                raise TensorError("Per-head objective contributions disagree with the update loss")
            guard.check("committing checked optimizer update")
            if not masks or not finite or not np.isfinite(value) or not np.isfinite(norm) or norm <= 0:
                raise TensorError("Invalid target mask or nonfinite/zero gradient; no optimizer commit")
            params, network_state, opt_state = next_params, next_state, next_optimizer
            seen_training_events.add(row_id)
            commit_sampler(state["sampler_state"], item)
            state.update(new_optimizer_updates=step, optimizer_updates=state["resumed_optimizer_updates"] + step,
                         sampler_state_checkpoint_updates=state["resumed_optimizer_updates"] + step,
                         unique_training_events_visited=len(seen_training_events))
            state["updates"].append({"new_update": step, "optimizer_update": state["optimizer_updates"],
                                     "identity": row_id, "role": item["role"], "partition": "train",
                                     "group_draw": item["group_draw"], "group_epoch": item["group_epoch"], "group_position": item["group_position"],
                                     "function_id": metadata[row_id]["function"]["id"], "loss": value,
                                     "gradient_l2_norm": norm, "finite": finite, "mask_valid": masks,
                                     "objective_head_losses": heads})
            if step % 32 == 0:
                save()
            if step % 128 == 0:
                unchanged()
                digest, _ = write_checkpoint(f"checkpoint-new-{step:04d}.msgpack")
                state.setdefault("intermediate_checkpoints", []).append({"new_updates": step, "sha256": digest,
                    "filename": f"checkpoint-new-{step:04d}.msgpack", "optimizer_updates": state["optimizer_updates"],
                    "sampler_state": deepcopy(state["sampler_state"])})
                (output / "checkpoint-manifest.json").write_text(json.dumps({
                    "schema": "opening-continuation-intermediate-manifest-v1", "objective": state["objective"],
                    "origin_checkpoint_sha256": BASE_CHECKPOINT, "source_hashes": source_hashes,
                    "objective_audit_sha256": audit_sha, "model_promoted": False,
                    "resumable_only_after_final_evaluation_and_recipe": True,
                    "checkpoints": state["intermediate_checkpoints"]}, indent=2) + "\n")
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
        final = evaluation_for(list(rows), "all full-game TRAIN final")
        state["evaluations"].append(final)
        record_subsets(final)
        before, after = baseline["greedy"]["summary"], final["greedy"]["summary"]
        state["quality_review"] = {"required": True, "promotion_allowed": False,
            "full_action_count_change": after["complete_action_exact"] - before["complete_action_exact"],
            "function_count_change": after["function_exact"] - before["function_exact"],
            "old679_complete_action_change": state["retention_evaluations"][-1]["greedy"]["summary"]["complete_action_exact"]
                - state["retention_evaluations"][0]["greedy"]["summary"]["complete_action_exact"],
            "attack_complete_action_change": state["attack_evaluations"][-1]["greedy"]["summary"]["complete_action_exact"]
                - state["attack_evaluations"][0]["greedy"]["summary"]["complete_action_exact"],
            "macro_complete_action_accuracy_change": after["macro_complete_action_accuracy"] - before["macro_complete_action_accuracy"],
            "anchor_complete_action_change": state["anchor_evaluations"][-1]["greedy"]["summary"]["complete_action_exact"]
                - anchor_baseline["greedy"]["summary"]["complete_action_exact"],
            "opening_complete_action_change": state["opening_evaluations"][-1]["greedy"]["summary"]["complete_action_exact"]
                - state["opening_evaluations"][0]["greedy"]["summary"]["complete_action_exact"],
            "milestone_complete_action_change": state["milestone_evaluations"][-1]["greedy"]["summary"]["complete_action_exact"]
                - state["milestone_evaluations"][0]["greedy"]["summary"]["complete_action_exact"],
            "stage2_requires_explicit_review": True,
            "note": "Execution success only; all evaluation uses TRAIN data. Preserve candidate even if diagnostic accuracy regresses, without automatic promotion."}
        state["retention_gates"] = {name: state["quality_review"][name] >= 0 for name in (
            "old679_complete_action_change", "anchor_complete_action_change",
            "attack_complete_action_change", "opening_complete_action_change", "milestone_complete_action_change")}
        state["retention_gates_passed"] = all(state["retention_gates"].values())
        state["second_stage_automatically_authorized"] = False
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
                    "source_hashes": state["source_hashes"], "objective": state["objective"],
                    "objective_audit_sha256": state["objective_audit_sha256"],
                    "opening_base_run": state["opening_base_run"], "opening_base_checkpoint_sha256": BASE_CHECKPOINT,
                    "opening_base_result_sha256": BASE_RESULT, "maximum_objective_updates": MAX_TOTAL_UPDATES,
                    "opening_identities": opening, "opening_milestone_identities": milestones,
                    "archived_previous_sampler_state": state["archived_previous_sampler_state"], "batch_size": 1, "unroll_length": 1,
                    "max_entities": config.max_entities, "max_selected": config.max_selected,
                    "world_size": config.world_size, "minimap_size": config.minimap_size,
                    "training_partition": "train only", "sampling_policy": state["sampling_policy"],
                    "preflight_sha256": state["preflight_sha256"], "original_anchor_identities": anchors,
                    "capacity_migration_run": state["capacity_migration_run"],
                    "capacity_migration_checkpoint_sha256": state["capacity_migration_checkpoint_sha256"],
                    "capacity_migration_result_sha256": state["capacity_migration_result_sha256"],
                    "capacity_adapter": state["capacity_adapter"],
                    "matmul_precision": state["matmul_precision"],
                    "original_admitted_identities": retention,
                    "scheduled_new_updates": len(schedule), "sampler_state_initial": state["sampler_state_initial"],
                    "sampler_state": state["sampler_state"], "sampler_state_checkpoint_updates": state["sampler_state_checkpoint_updates"],
                    "build_library_sha256": state["build_library_sha256"], "build_labels_model_inputs": False,
                    "actual_launch_arguments": sys.argv[1:]}
                (output / "reproduction-recipe.json").write_text(json.dumps(final_recipe, indent=2, allow_nan=False) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--preflight", type=Path, required=True, help="Exact passed capacity migration preflight.json; every full-game row checked")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--objective-audit", type=Path, required=True)
    parser.add_argument("--upstream", type=Path, default=DEFAULT_UPSTREAM)
    parser.add_argument("--max-updates", type=int, default=1024)
    parser.add_argument("--wall-seconds", type=float, default=900)
    parser.add_argument("--build-library", type=Path, default=ROOT / "runs/build-library-review-20260925/multi-opening-library-v2.json",
                        help="Own build-label provenance only; never model inputs or opponent labels")
    run(parser.parse_args())


if __name__ == "__main__":
    main()
