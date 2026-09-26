"""Prove a 128/16 -> 512/64 shape expansion without changing learned values.

The source checkpoint, dataset and upstream code remain immutable. A passed run
copies the checkpoint bytes and publishes a new shape contract only after exact
parameter/Adam restoration, equivalent-observation parity and every admitted
TRAIN target's official graph mask have been checked. No SC2 client is used.
"""
from __future__ import annotations

import argparse
from collections import Counter
from collections.abc import Mapping
from dataclasses import asdict
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
    DEFAULT_UPSTREAM, DISABLED_HEADS, HEADS, PINNED_COMMIT, TensorConfig,
    TensorError, aggregate_metrics, read_dataset,
    runtime_registry, sha256, teacher_forced_metrics, train_rows, verify_upstream,
)
from scripts.infer_alphastar_checkpoint import (  # noqa: E402
    read_checkpoint_artifacts, structured_prediction, validate_observation_only,
    verify_tree_schema,
)
from scripts.fit_alphastar_balanced import (  # noqa: E402
    RunGuard, verify_adam_count, verify_resume_recipe, verify_state_dict_schema,
)
from scripts.preflight_alphastar_curriculum import (  # noqa: E402
    REPLAY, duplicate_summary, host_path, identity, label_fingerprint,
    observation_fingerprint, validate_active_logits, validate_train_identity,
)
from pluto_sc2.alphastar_tensor import (  # noqa: E402
    tensorize_observation, tensorize_sample, validate_supervised_masks,
)
from scripts.alphastar_capacity_bridge import (  # noqa: E402
    CAPACITY_ADAPTER, CAPACITY_MATMUL_PRECISION, build_capacity_bridge, configure_capacity_runtime,
)

SCHEMA = "alphastar-capacity-migration-preflight-v2"
SOURCE_SHA256 = "4f74e4564ca269dae8a25327d3e076400b3342348fe07c4915a2fd830f31f5cf"
SOURCE_UPDATES = 4041
OLD_INFERENCE_SHA256 = "483b8f0a4958365c3771ebe528f01607c126fb9e190c75a771a6e216a9481d85"
DATASET_HASHES = {
    "samples": "55fee0bf9d3adccbcfb5caf01a479410a1e2ae5b3314dfba5a82807c52265bfa",
    "game_data": "f78c8a751a5919ff572d2bd4a0aa84de56a6c5bdf2bed3a5a8da0d40e60ab0f1",
    "manifest": "5a79e363f51bcdcc68521b3c314946b3c22b3e62bb2723b18d4aedfcf2a2b150",
}
OLD_CONFIG = TensorConfig(max_entities=128, max_selected=16)
NEW_CONFIG = TensorConfig(max_entities=512, max_selected=64)
EXCLUSIONS = {
    **{(REPLAY, 2, ordinal): (4129, "Exact RAW_FUNCTION mapping count 0")
       for ordinal in (1033, 1385, 1573)},
    **{(REPLAY, 2, ordinal): (1518, "Exact RAW_FUNCTION mapping count 2")
       for ordinal in (2436, 2437, 2438)},
    **{(REPLAY, 2, ordinal): (ability, "Invalid weapon_cooldown")
       for ordinal, ability in ((2467, 23), (2468, 1), (2470, 1), (2471, 23),
                                (2472, None), (2473, None), (2474, None),
                                (2475, None), (2476, 1))},
}
MASK_EXCLUSIONS = {
    (REPLAY, 2, 2086): {
        "function": "Build_Pylon_pt", "ability_id": 881,
        "error": "World target outside current camera and visible-buildable planning mask",
        "observation_sha256": "63b5550ed46aca79ad9b66e62da594025805c3ca6d4d5bb3e4f001d0967f984e",
        "label_sha256": "215da6352b240976b3a2cf432317d41fa447455270fc8a9326ec5b7c24a601df",
        "mask_evidence": {"world_pixel": [192, 168], "camera_mask": False, "planned_mask": False,
                          "planned_build": True, "camera_only_pt": True,
                          "minimap_visibility": 0, "minimap_buildable": 1, "legal": False},
    },
}


def world_target_mask_evidence(example):
    """CPU evaluation of the unchanged IntentMask world-target predicate."""
    if not example["active_heads"]["world"]:
        return None
    function, inputs = example["metadata"]["function"], example["inputs"]
    y, x = divmod(int(example["labels"]["world"]), NEW_CONFIG.world_size)
    camera = bool(inputs["observation", "camera"][y, x])
    planned = bool(inputs["observation", "planned_build_mask"][y, x])
    is_build, camera_only = bool(function["planned_build"]), bool(function["camera_only_pt"])
    return {"world_pixel": [x, y], "camera_mask": camera, "planned_mask": planned,
            "planned_build": is_build, "camera_only_pt": camera_only,
            "minimap_visibility": int(inputs["observation", "minimap_visibility_map"][y // 4, x // 4]),
            "minimap_buildable": int(inputs["observation", "minimap_buildable"][y // 4, x // 4]),
            "legal": (camera or planned) if is_build else (camera or not camera_only)}


def capacity_mask_exclusion(row, example, encoded_observation):
    """Quarantine only the reviewed exact masked label; fail on any new case."""
    row_id = identity(row)
    evidence = world_target_mask_evidence(example)
    if evidence is None or evidence["legal"]:
        if row_id in MASK_EXCLUSIONS:
            raise TensorError("Pinned mask exclusion no longer fails its unchanged mask")
        return None
    record = {"identity": list(row_id), "function": example["metadata"]["function"]["name"],
              "ability_id": row["intent"].get("ability_id"),
              "error": "World target outside current camera and visible-buildable planning mask",
              "observation_sha256": observation_fingerprint(encoded_observation),
              "label_sha256": label_fingerprint(example), "mask_evidence": evidence}
    if record != {"identity": list(row_id), **MASK_EXCLUSIONS.get(row_id, {})}:
        raise TensorError(f"Unreviewed world-mask rejection or changed exclusion evidence: {row_id}")
    return record


def permitted_capacity_exclusion(row, error):
    return (isinstance(error, TensorError)
            and EXCLUSIONS.get(identity(row)) == (row["intent"].get("ability_id"), str(error)))


def exact_state_equal(left, right):
    """Value proof for every serialized leaf, including Adam moments/count."""
    verify_state_dict_schema(left, right)
    if isinstance(left, Mapping):
        return all(exact_state_equal(value, right[key]) for key, value in left.items())
    return bool(np.array_equal(np.asarray(left), np.asarray(right)))


def validate_expansion(old, new):
    if old != OLD_CONFIG or new != NEW_CONFIG:
        raise TensorError("Only the reviewed128/16 to512/64 capacity expansion is allowed")


def verify_observation_expansion(old, new, old_config=OLD_CONFIG, new_config=NEW_CONFIG):
    """All observed values and entity order survive; added slots are empty."""
    validate_expansion(old_config, new_config)
    left, right = validate_observation_only(old), validate_observation_only(new)
    if set(left) != set(right) or old["metadata"]["entity_tags"] != new["metadata"]["entity_tags"]:
        raise TensorError("Observation keys or entity pointer order changed")
    expanded = []
    for key in left:
        a, b = np.asarray(left[key]), np.asarray(right[key])
        if a.dtype != b.dtype:
            raise TensorError(f"Observation dtype changed: {key}")
        if a.shape == b.shape:
            equal = np.array_equal(a, b)
        elif a.ndim and a.shape[0] == old_config.max_entities and b.shape == (new_config.max_entities,) + a.shape[1:]:
            equal = np.array_equal(a, b[:old_config.max_entities]) and not np.any(b[old_config.max_entities:])
            expanded.append(str(key))
        else:
            raise TensorError(f"Unreviewed observation shape changed: {key}")
        if not equal:
            raise TensorError(f"Observed value changed or nonempty new entity padding: {key}")
    return expanded


def canonical_prediction(prediction, registry, config):
    """Ignore inactive heads and repeated EOS padding, never actual selections."""
    function = int(prediction["function"])
    if not 0 <= function < len(registry):
        raise TensorError("Invalid predicted function")
    result = {"function": function}
    for name in registry[function]["args"]:
        value = prediction[name]
        if name == "unit_tags":
            values = list(value)
            if config.max_entities in values:
                end = values.index(config.max_entities)
                if any(item != config.max_entities for item in values[end:]):
                    raise TensorError("Non-EOS source after termination")
                values = values[:end]
            else:
                raise TensorError("Capacity parity requires source termination before old selection cap")
            value = values
        result[name] = value
    return result


def verify_output_parity(old_outputs, new_outputs, active_heads, *, atol=2e-4, rtol=2e-5):
    """Compare equivalent legal logits/masks; remap only the EOS pointer.

    Unit decoding is compared through the first old EOS inclusive. Its remaining
    recurrent padding is not a meaningful action prefix. No tolerance is used
    for legal masks or predicted actions.
    """
    records = {}
    for name, active in active_heads.items():
        if not active:
            continue
        a = np.asarray(old_outputs["logits", name])[0, 0]
        b = np.asarray(new_outputs["logits", name])[0, 0]
        ma = np.asarray(old_outputs["masks", name])[0, 0]
        mb = np.asarray(new_outputs["masks", name])[0, 0]
        aa = np.asarray(old_outputs["action", name])[0, 0]
        ab = np.asarray(new_outputs["action", name])[0, 0]
        if name == "unit_tags":
            eos = np.flatnonzero(aa == OLD_CONFIG.max_entities)
            if not len(eos):
                raise TensorError("Capacity parity requires source termination before old selection cap")
            stop = int(eos[0]) + 1
            if np.any(mb[:stop, OLD_CONFIG.max_entities:NEW_CONFIG.max_entities]):
                raise TensorError("New padded source entities became legal")
            columns = list(range(OLD_CONFIG.max_entities)) + [NEW_CONFIG.max_entities]
            a, ma = a[:stop], ma[:stop]
            b, mb = b[:stop, columns], mb[:stop, columns]
            # Advanced indexing transposes only when separated by another
            # advanced index; here a slice plus list preserves slot,pointer.
            aa = aa[:stop]
            ab = np.where(ab[:stop] == NEW_CONFIG.max_entities, OLD_CONFIG.max_entities, ab[:stop])
        elif name == "target_unit_tag":
            if np.any(mb[OLD_CONFIG.max_entities:]):
                raise TensorError("New padded target entities became legal")
            b, mb = b[:OLD_CONFIG.max_entities], mb[:OLD_CONFIG.max_entities]
        if a.shape != b.shape or ma.shape != mb.shape or not np.array_equal(ma, mb):
            raise TensorError(f"Capacity changed a meaningful legal mask: {name}")
        if not np.array_equal(aa, ab):
            raise TensorError(f"Capacity changed a meaningful action prefix: {name}")
        if not np.all(np.isfinite(a)) or not np.all(np.isfinite(b)):
            raise TensorError(f"Nonfinite capacity parity logits: {name}")
        delta = np.abs(a[ma] - b[ma])

        def distribution(logits, mask):
            legal = np.where(mask, logits.astype(np.float64), -np.inf)
            maximum = np.max(legal, axis=-1, keepdims=True)
            shifted = np.where(mask, legal - np.where(np.isfinite(maximum), maximum, 0), -np.inf)
            exponent = np.exp(shifted)
            probabilities = exponent / np.maximum(exponent.sum(axis=-1, keepdims=True), 1e-300)
            ordered = np.sort(legal, axis=-1)
            margin = ordered[..., -1] - ordered[..., -2]
            return probabilities, np.where(np.isfinite(margin), margin, 0)

        ap, am = distribution(a, ma)
        bp, bm = distribution(b, mb)
        records[name] = {"legal_logits": int(np.count_nonzero(ma)),
            "maximum_absolute_logit_error": float(np.max(delta)) if delta.size else 0.0,
            "maximum_relative_logit_error": float(np.max(delta / np.maximum(np.abs(a[ma]), 1e-6))) if delta.size else 0.0,
            "maximum_absolute_probability_error": float(np.max(np.abs(ap - bp))),
            "old_argmax": np.argmax(a, axis=-1).tolist(), "new_argmax": np.argmax(b, axis=-1).tolist(),
            "old_argmax_margin": am.tolist(), "new_argmax_margin": bm.tolist(),
            "actions_exact": True, "legal_masks_exact": True}
        if not np.allclose(a[ma], b[ma], atol=atol, rtol=rtol):
            raise TensorError(f"Capacity changed meaningful logits beyond tolerance: {json.dumps({'head': name, **records[name]})}")
    return records


def diagnose_output_parity(old_outputs, new_outputs, active_heads):
    """Report every head without turning a failed strict comparison into proof."""
    records = {}
    for name, active in active_heads.items():
        if not active:
            continue
        try:
            records.update(verify_output_parity(old_outputs, new_outputs, {name: True}))
            records[name]["strict_tolerance_passed"] = True
        except TensorError as error:
            try:
                records.update(verify_output_parity(old_outputs, new_outputs, {name: True}, atol=np.finfo(np.float64).max, rtol=0))
            except TensorError:
                records[name] = {}
            records[name].update(strict_tolerance_passed=False, error=str(error))
    return records


def require_capacity_preflight(preflight, artifacts, dataset_hashes):
    """Return admission records only when every migration proof binds exactly."""
    required_true = ("eligible_for_broader_training", "all_source_inputs_unchanged",
                     "parameter_values_exact", "optimizer_moments_exact", "optimizer_count_restored",
                     "exact_parameter_schema", "observation_parity_verified")
    if (preflight.get("schema") != SCHEMA or preflight.get("status") != "passed"
            or any(preflight.get(name) is not True for name in required_true)
            or preflight.get("checkpoint_sha256") != artifacts["checkpoint_sha256"]
            or preflight.get("checkpoint_optimizer_updates") != SOURCE_UPDATES
            or artifacts["result"].get("optimizer_updates") != SOURCE_UPDATES
            or artifacts["checkpoint_sha256"] != SOURCE_SHA256
            or preflight.get("dataset_hashes") != dataset_hashes or dataset_hashes != DATASET_HASHES
            or preflight.get("tensor_config") != asdict(NEW_CONFIG)
            or preflight.get("capacity_adapter") != CAPACITY_ADAPTER
            or artifacts["result"].get("capacity_adapter") != CAPACITY_ADAPTER
            or preflight.get("matmul_precision") != CAPACITY_MATMUL_PRECISION
            or artifacts["result"].get("matmul_precision") != CAPACITY_MATMUL_PRECISION
            or artifacts["result"].get("tensor_config") != asdict(NEW_CONFIG)
            or preflight.get("split_sha256") != artifacts["result"].get("split_sha256")
            or preflight.get("optimizer_updates") != 0 or preflight.get("new_checkpoint_writes") != 0
            or preflight.get("checkpoint_copies") != 1 or preflight.get("failures") != []
            or preflight.get("supported_rows") != 1201 or preflight.get("mask_verified_rows") != 1201
            or preflight.get("tensor_supported_rows") != 1202
            or preflight.get("source_train_rows") != 1217 or not preflight.get("source_and_input_hashes")):
        raise TensorError("Capacity preflight proof or immutable provenance mismatch")
    omissions = preflight.get("known_exclusions", [])
    if len(omissions) != len(EXCLUSIONS) or {tuple(r["identity"]): (r["ability_id"], r["error"]) for r in omissions} != EXCLUSIONS:
        raise TensorError("Capacity preflight exclusions changed")
    mask_omissions = preflight.get("known_mask_exclusions", [])
    if mask_omissions != [{"identity": list(key), **value} for key, value in MASK_EXCLUSIONS.items()]:
        raise TensorError("Capacity preflight pinned mask exclusions changed")
    maps = []
    for field in ("tensor_records", "mask_records"):
        records = preflight.get(field, [])
        mapped = {tuple(r["identity"]): r for r in records}
        if len(records) != 1201 or len(mapped) != 1201 or any(k[0:2] != (REPLAY, 2) or k in EXCLUSIONS or k in MASK_EXCLUSIONS for k in mapped):
            raise TensorError("Capacity preflight coverage changed")
        maps.append(mapped)
    if set(maps[0]) != set(maps[1]):
        raise TensorError("Capacity graph/tensor admission identities differ")
    counts = Counter(row["function"] for row in maps[0].values())
    if counts["Attack_Attack_pt"] != 20 or counts["Attack_Attack_unit"] != 9:
        raise TensorError("All29 supported attack examples must remain admitted")
    for key, row in maps[0].items():
        proof = maps[1][key]
        if any(row.get(name) != proof.get(name) for name in ("function", "observation_sha256", "label_sha256")):
            raise TensorError("Capacity preflight tensor fingerprints differ")
        for name in ("observation_sha256", "label_sha256"):
            if not isinstance(row.get(name), str) or len(row[name]) != 64:
                raise TensorError("Missing tensor fingerprint")
        targets = proof.get("verified_unmasked_targets")
        if not isinstance(targets, dict) or not targets or any(type(n) is not int or n < 1 for n in targets.values()):
            raise TensorError("Missing actual graph mask proof")
    old = list(map(tuple, preflight.get("original_admitted_identities", [])))
    anchors = list(map(tuple, preflight.get("original_anchor_identities", [])))
    if len(old) != 679 or len(set(old)) != 679 or not set(old) <= set(maps[1]) or len(anchors) != 24 or len(set(anchors)) != 24 or not set(anchors) <= set(old):
        raise TensorError("Original curriculum or anchor coverage changed")
    if len(preflight.get("parity_records", [])) != 24 or len(preflight.get("migrated_anchor_teacher_events", [])) != 24:
        raise TensorError("Missing equivalent-observation anchor proof")
    return maps[1]


def run(args):
    started = time.monotonic()
    diagnostic_only = getattr(args, "parity_diagnostic", False)
    precision = getattr(args, "diagnostic_matmul_precision", None)
    if precision and not diagnostic_only:
        raise TensorError("Precision override is permitted only in read-only parity diagnostics")
    origin, dataset, output = map(lambda p: Path(p).resolve(), (args.run, args.dataset, args.output))
    guard = RunGuard(args.wall_seconds, [origin / "STOP", dataset / "STOP", output / "STOP", DEFAULT_UPSTREAM.parent.parent / "STOP"])
    guard.check("capacity preflight")
    if output.exists():
        raise TensorError("Capacity preflight requires a new immutable output directory")
    output.mkdir(parents=True)
    state = {"schema": SCHEMA, "status": "running", "pid": os.getpid(),
             "started_unix": time.time(), "optimizer_updates": 0, "new_checkpoint_writes": 0,
             "checkpoint_copies": 0, "game_inputs": 0, "game_launches": 0,
             "eligible_for_broader_training": False, "live_game_ready": False,
             "held_out_evaluation": False, "strength_evidence": False,
             "failures": [], "known_exclusions": [], "known_mask_exclusions": [], "tensor_records": [], "mask_records": [],
             "parity_records": [], "migrated_anchor_teacher_events": [], "capacity_adapter": CAPACITY_ADAPTER,
             "matmul_precision": CAPACITY_MATMUL_PRECISION,
             "numerical_parity_scope": "Both original and expanded graphs evaluated at highest matmul precision",
             "all_source_inputs_unchanged": False, "old_tensor_config": asdict(OLD_CONFIG),
             "tensor_config": asdict(NEW_CONFIG), "wall_budget_seconds": args.wall_seconds,
             "parity_diagnostic_only": diagnostic_only, "diagnostic_matmul_precision": precision,
             "deadline_semantics": "Checked around operations; compilation cannot be interrupted in-flight"}
    hashes = {}

    def save():
        pending = output / "preflight.json.pending"
        pending.write_text(json.dumps(state, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        pending.replace(output / "preflight.json")

    try:
        artifacts = read_checkpoint_artifacts(origin, dataset / "game-data.json")
        recipe = json.loads((origin / "reproduction-recipe.json").read_text(encoding="utf-8"))
        verify_resume_recipe(artifacts, recipe)
        validate_expansion(artifacts["config"], NEW_CONFIG)
        if artifacts["checkpoint_sha256"] != SOURCE_SHA256 or artifacts["result"]["optimizer_updates"] != SOURCE_UPDATES:
            raise TensorError("Capacity migration requires the pinned4041-update checkpoint")
        manifest, _, dataset_hashes, counts = read_dataset(dataset)
        if dataset_hashes != DATASET_HASHES or dict(counts) != {"train": 1217} or manifest["split_sha256"] != artifacts["result"]["split_sha256"]:
            raise TensorError("Full replay dataset or original TRAIN split changed")
        split_path = host_path(manifest["split_path"])
        if sha256(split_path) != manifest["split_sha256"]:
            raise TensorError("Whole-replay split hash changed")
        split = json.loads(split_path.read_text(encoding="utf-8"))
        train_ids = {r["replay_id"] for r in split["train_replay_ids"]}
        validation_ids = {r["replay_id"] for r in split["validation_replay_ids"]}
        old_ids = [tuple(x) for x in artifacts["result"]["admitted_identities"]]
        anchors = [tuple(x) for x in artifacts["result"]["original_anchor_identities"]]
        if len(set(old_ids)) != 679 or len(old_ids) != 679 or len(anchors) != 24 or len(set(anchors)) != 24 or not set(anchors) <= set(old_ids):
            raise TensorError("Pinned old curriculum coverage changed")
        prior_sources = {Path(name.replace("\\", "/")).name: digest for name, digest in artifacts["result"]["source_hashes"].items()}
        source_paths = [Path(__file__), ROOT / "scripts/train_alphastar_replay.py", ROOT / "scripts/infer_alphastar_checkpoint.py",
                        ROOT / "scripts/fit_alphastar_balanced.py", ROOT / "scripts/preflight_alphastar_curriculum.py",
                        ROOT / "src/pluto_sc2/alphastar_tensor.py", ROOT / "src/pluto_sc2/rich_actions.py", ROOT / "src/pluto_sc2/rich_intents.py"]
        for path in source_paths[1:]:
            current = sha256(path)
            if path.name == "infer_alphastar_checkpoint.py":
                if prior_sources.get(path.name) != OLD_INFERENCE_SHA256:
                    raise TensorError("Original inference selector source is not the reviewed revision")
                state["reviewed_inference_source_migration"] = {"old_sha256": OLD_INFERENCE_SHA256,
                    "new_sha256": current, "change": "Explicit capacity adapter selection; legacy graph unchanged"}
            elif prior_sources.get(path.name) != current:
                raise TensorError(f"Shared source differs from pinned checkpoint: {path.name}")
        source_paths.append(ROOT / "scripts/alphastar_capacity_bridge.py")
        paths = source_paths + [split_path] + [origin / n for n in ("checkpoint.msgpack", "result.json", "registry.json", "reproduction-recipe.json")]
        paths += [dataset / n for n in ("manifest.json", "samples.jsonl.gz", "game-data.json")]
        hashes = {str(p): sha256(p) for p in paths}
        source_hashes = {str(p): hashes[str(p)] for p in source_paths}
        snapshot = output / "source-snapshot"
        snapshot.mkdir()
        for path in source_paths:
            shutil.copy2(path, snapshot / path.name)
            if sha256(snapshot / path.name) != source_hashes[str(path)]:
                raise TensorError("Source changed during snapshot copy")
        (snapshot / "manifest.json").write_text(json.dumps(source_hashes, indent=2) + "\n", encoding="utf-8")
        state.update(source_and_input_hashes=hashes, dataset_hashes=dataset_hashes,
                     original_dataset_hashes=artifacts["result"]["dataset_hashes"], split_sha256=manifest["split_sha256"],
                     checkpoint_sha256=SOURCE_SHA256, checkpoint_optimizer_updates=SOURCE_UPDATES,
                     original_admitted_identities=old_ids, original_anchor_identities=anchors)
        state["pid_creation_time"] = __import__("psutil").Process().create_time()
        save()
        registry, mapping = artifacts["registry"], artifacts["unit_types"]
        seen, supported, anchor_rows = set(), {}, {}
        first = None
        for row in train_rows(dataset):
            guard.check("CPU tensor admission")
            validate_train_identity(row, manifest["replay_partitions"], train_ids, validation_ids)
            row_id = identity(row)
            if row_id in seen:
                raise TensorError("Duplicate full-game identity")
            seen.add(row_id)
            try:
                example = tensorize_sample(row, registry, mapping, NEW_CONFIG)
            except TensorError as exc:
                record = {"identity": row_id, "ability_id": row["intent"].get("ability_id"), "error": str(exc)}
                if not permitted_capacity_exclusion(row, exc):
                    raise TensorError(f"Unreviewed full-game exclusion {row_id}: {exc}") from exc
                state["known_exclusions"].append(record)
                continue
            if row_id in EXCLUSIONS:
                raise TensorError("Previously excluded semantics changed without review")
            first = first or example
            encoded = tensorize_observation(row["frame"], registry, mapping, NEW_CONFIG)
            mask_exclusion = capacity_mask_exclusion(row, example, encoded)
            if mask_exclusion is not None:
                state["known_mask_exclusions"].append(mask_exclusion)
                continue
            record = {"identity": row_id, "function": example["metadata"]["function"]["name"],
                      "observation_sha256": observation_fingerprint(encoded), "label_sha256": label_fingerprint(example)}
            supported[row_id] = record
            state["tensor_records"].append(record)
            if row_id in anchors:
                anchor_rows[row_id] = row
        if (len(seen) != 1217 or len(supported) != 1201
                or {tuple(r["identity"]) for r in state["known_exclusions"]} != set(EXCLUSIONS)
                or {tuple(r["identity"]) for r in state["known_mask_exclusions"]} != set(MASK_EXCLUSIONS)
                or not set(old_ids) <= set(supported)):
            raise TensorError("Full-game or original curriculum coverage differs from pinned audit")
        state.update(source_train_rows=len(seen), supported_rows=len(supported),
                     tensor_supported_rows=len(supported) + len(state["known_mask_exclusions"]),
                     function_counts=dict(Counter(r["function"] for r in supported.values())),
                     input_fingerprint_audit=duplicate_summary(state["tensor_records"]))
        save()
        os.environ.setdefault("XLA_PYTHON_CLIENT_PREALLOCATE", "false")
        os.environ.setdefault("OMP_NUM_THREADS", "4")
        os.environ.setdefault("JAX_COMPILATION_CACHE_DIR", str(Path.home() / ".cache/sc2-alphastar-v1/jax"))
        sys.dont_write_bytecode = True
        state["upstream_manifest_sha256"], state["upstream_file_count"] = verify_upstream(args.upstream)
        sys.path.insert(0, str(Path(args.upstream).resolve()))
        import jax
        configure_capacity_runtime(state)
        import jax.numpy as jnp
        import haiku as hk
        import optax
        from flax import serialization
        from alphastar import types
        if not any(d.platform == "gpu" for d in jax.devices()):
            raise TensorError("Use the isolated pinnedGPU runtime for actual graph preflight")
        state["devices"] = [str(d) for d in jax.devices()]
        state["effective_matmul_precision"] = jax.config.jax_default_matmul_precision
        if runtime_registry(artifacts["catalog"]) != (registry, mapping):
            raise TensorError("Official vocabulary or unit mapping changed")
        decoded = serialization.msgpack_restore(artifacts["checkpoint"].read_bytes())
        verify_adam_count(decoded, SOURCE_UPDATES)
        params = jax.tree_util.tree_map(jnp.asarray, decoded["params"])
        network_state = jax.tree_util.tree_map(jnp.asarray, decoded["network_state"])
        optimizer = optax.adam(recipe["learning_rate"])
        template = {"params": jax.device_get(params), "network_state": jax.device_get(network_state),
                    "optimizer_state": jax.device_get(optimizer.init(params)), "optimizer_updates": SOURCE_UPDATES}
        leaves = verify_state_dict_schema(serialization.to_state_dict(template), decoded)
        restored = serialization.from_state_dict(template, decoded)
        if not exact_state_equal(decoded, serialization.to_state_dict(restored)):
            raise TensorError("Exact parameter/Adam restoration failed")
        state.update(parameter_values_exact=True, optimizer_moments_exact=True, optimizer_count_restored=True,
                     restored_full_state_leaves=leaves, fresh_parameter_initialization=False)
        key = jax.random.PRNGKey(recipe["seed"])

        def make_graph(config, row, training):
            example = tensorize_sample(row, registry, mapping, config) if training else tensorize_observation(row["frame"], registry, mapping, config)
            component, _ = build_capacity_bridge(example, config, registry, is_training=training,
                                                 sampling_mode="sample" if training else "greedy")
            network = hk.transform_with_state(jax.vmap(component.unroll))
            previous = jax.tree_util.tree_map(lambda spec: jnp.zeros((1,) + spec.shape, spec.dtype), component.prev_state_spec)

            def inputs_for(encoded):
                raw = encoded["inputs"] if training else validate_observation_only(encoded)
                inputs = types.StreamDict()
                for name, spec in component.input_spec.items():
                    spec.validate(raw[name])
                    inputs[name] = jnp.asarray(raw[name])[None, None, ...]
                return inputs

            guard.check("exact graph shape evaluation")
            expected_params, expected_state = jax.eval_shape(network.init, key, inputs_for(example), previous)
            _, count = verify_tree_schema(expected_params, decoded["params"], "params")
            verify_tree_schema(expected_state, decoded["network_state"], "network_state")
            if count != artifacts["result"]["parameter_count"]:
                raise TensorError("Model parameter count changed")
            apply = jax.jit(network.apply)

            def forward(encoded):
                guard.check("official graph forward")
                (outputs, _, _), next_state = apply(params, network_state, key, inputs_for(encoded), previous)
                # Materialize to make wall timing and all finite/schema checks actual.
                outputs = jax.device_get(outputs)
                verify_tree_schema(network_state, jax.device_get(next_state), "next_network_state")
                guard.check("official graph forward completion")
                return outputs
            return forward

        anchor = anchor_rows[anchors[0]]
        old_teacher, new_teacher = (make_graph(c, anchor, True) for c in (OLD_CONFIG, NEW_CONFIG))
        old_greedy, new_greedy = (make_graph(c, anchor, False) for c in (OLD_CONFIG, NEW_CONFIG))
        state["exact_parameter_schema"] = True
        for row_id in anchors:
            row = anchor_rows[row_id]
            old_obs = tensorize_observation(row["frame"], registry, mapping, OLD_CONFIG)
            new_obs = tensorize_observation(row["frame"], registry, mapping, NEW_CONFIG)
            expanded = verify_observation_expansion(old_obs, new_obs)
            old_example = tensorize_sample(row, registry, mapping, OLD_CONFIG)
            new_example = tensorize_sample(row, registry, mapping, NEW_CONFIG)
            a, b = old_teacher(old_example), new_teacher(new_example)
            validate_supervised_masks(a, old_example)
            validate_supervised_masks(b, new_example)
            compare = diagnose_output_parity if diagnostic_only else verify_output_parity
            teacher_parity = compare(a, b, old_example["active_heads"])
            state["migrated_anchor_teacher_events"].append(teacher_forced_metrics(b, new_example))
            a, b = old_greedy(old_obs), new_greedy(new_obs)
            pa = structured_prediction(a, registry, OLD_CONFIG)
            pb = structured_prediction(b, registry, NEW_CONFIG)
            ca = canonical_prediction(pa["prediction"], registry, OLD_CONFIG)
            cb = canonical_prediction(pb["prediction"], registry, NEW_CONFIG)
            canonical_equal = ca == cb and pa["mask_checks_passed"] == pb["mask_checks_passed"]
            if not canonical_equal and not diagnostic_only:
                raise TensorError(f"Label-free action changed after capacity expansion: {row_id}")
            active = {name: name == "function" or name in registry[ca["function"]]["args"] for name in HEADS}
            greedy_parity = compare(a, b, active)
            state["parity_records"].append({"identity": row_id, "expanded_observation_fields": expanded,
                "teacher": teacher_parity, "greedy": greedy_parity, "canonical_prediction": ca,
                "canonical_prediction_exact": canonical_equal,
                "absolute_tolerance": 2e-4, "relative_tolerance": 2e-5})
            if diagnostic_only:
                save()
        if diagnostic_only:
            state["strict_parity_passed"] = all(r["canonical_prediction_exact"] and all(
                head["strict_tolerance_passed"] for mode in ("teacher", "greedy") for head in r[mode].values())
                for r in state["parity_records"])
            state["status"] = "diagnostic_complete"
            state["all_source_inputs_unchanged"] = all(sha256(path) == digest for path, digest in hashes.items())
            return  # Diagnostic mode can never publish a checkpoint or training admission.
        state["observation_parity_verified"] = True
        save()
        for row in train_rows(dataset):
            guard.check("all-row mask preflight")
            record = supported.get(identity(row))
            if record is None:
                continue
            example = tensorize_sample(row, registry, mapping, NEW_CONFIG)
            encoded = tensorize_observation(row["frame"], registry, mapping, NEW_CONFIG)
            if label_fingerprint(example) != record["label_sha256"] or observation_fingerprint(encoded) != record["observation_sha256"]:
                raise TensorError("Actual graph input differs from CPU admission")
            predictions = new_teacher(example)
            validate_active_logits(predictions, example["active_heads"])
            proof = validate_supervised_masks(predictions, example)
            state["mask_records"].append({**record, "verified_unmasked_targets": proof})
            if len(state["mask_records"]) % 128 == 0:
                save()
                print(json.dumps({"mask_verified_rows": len(state["mask_records"]), "optimizer_updates": 0}), flush=True)
        state["mask_verified_rows"] = len(state["mask_records"])
        guard.check("publish migration proof")
        if state["mask_verified_rows"] != 1201:
            raise TensorError("Incomplete all-row graph preflight")
        for path, digest in hashes.items():
            if sha256(path) != digest:
                raise TensorError(f"Source or immutable input changed: {path}")
        verify_upstream(args.upstream)
        state["all_source_inputs_unchanged"] = True
        shutil.copy2(artifacts["checkpoint"], output / "checkpoint.msgpack")
        shutil.copy2(origin / "registry.json", output / "registry.json")
        if sha256(output / "checkpoint.msgpack") != SOURCE_SHA256 or sha256(output / "registry.json") != artifacts["registry_sha256"]:
            raise TensorError("Migration artifact copy differs")
        state.update(checkpoint_copies=1, status="passed", eligible_for_broader_training=True)
        result = {"schema": "alphastar-real-replay-diagnostic-v1", "status": "passed",
                  "artifact_role": "capacity_migration_no_learning", "upstream_commit": PINNED_COMMIT,
                  "capacity_adapter": CAPACITY_ADAPTER,
                  "matmul_precision": CAPACITY_MATMUL_PRECISION,
                  "numerical_parity_scope": state["numerical_parity_scope"],
                  "checkpoint_restore_verified": True, "learned_from_actual_replay": True,
                  "disabled_supervision": list(DISABLED_HEADS), "checkpoint_sha256": SOURCE_SHA256,
                  "optimizer_updates": SOURCE_UPDATES, "new_optimizer_updates": 0, "validation_optimizer_updates": 0,
                  "source_hashes": source_hashes, "dataset_hashes": dataset_hashes,
                  "split_sha256": manifest["split_sha256"], "tensor_config": asdict(NEW_CONFIG),
                  "parameter_count": artifacts["result"]["parameter_count"], "fresh_parameter_initialization": False,
                  "optimizer_moments_exact": True, "optimizer_count_restored": True,
                  "origin_run": str(origin), "origin_result_sha256": artifacts["result_sha256"],
                  "original_dataset_hashes": artifacts["result"]["dataset_hashes"],
                  "original_admitted_identities": old_ids, "original_anchor_identities": anchors,
                  "admitted_identities": list(supported), "admitted_samples": 1201,
                  "known_mask_exclusions": state["known_mask_exclusions"],
                  "mask_proofs": [{"replay_id": r["identity"][0], "player_id": r["identity"][1],
                                   "action_ordinal": r["identity"][2],
                                   "verified_unmasked_targets": r["verified_unmasked_targets"]}
                                  for r in state["mask_records"]],
                  "known_excluded_identities": [r["identity"] for field in ("known_exclusions", "known_mask_exclusions") for r in state[field]],
                  "archived_previous_sampler_state": artifacts["result"].get("sampler_state"),
                  "sampler_migration": "New full-game groups require a separately versioned sampler; weights and Adam unchanged",
                  "migrated_anchor_teacher_events": state["migrated_anchor_teacher_events"],
                  "teacher_forced_metrics": {"final": {"events": state["migrated_anchor_teacher_events"],
                    "summary": aggregate_metrics(state["migrated_anchor_teacher_events"])}},
                  "live_game_ready": False, "held_out_evaluation": False, "strength_evidence": False,
                  "training_scope": "bounded_imitation_diagnostic"}
        require_capacity_preflight(state, {"checkpoint_sha256": SOURCE_SHA256, "result": result}, dataset_hashes)
        (output / "result.json").write_text(json.dumps(result, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        new_recipe = {**recipe, "steps": SOURCE_UPDATES, "new_steps": 0,
                      "capacity_adapter": CAPACITY_ADAPTER,
                      "matmul_precision": CAPACITY_MATMUL_PRECISION,
                      "initialization": "byte-identical4041-update model and Adam; shape capacity migration only",
                      "checkpoint_sha256": SOURCE_SHA256, "result_sha256": sha256(output / "result.json"),
                      "dataset_hashes": dataset_hashes, "source_hashes": source_hashes,
                      **{name: getattr(NEW_CONFIG, name) for name in ("max_entities", "max_selected", "world_size", "minimap_size")}}
        (output / "reproduction-recipe.json").write_text(json.dumps(new_recipe, indent=2) + "\n", encoding="utf-8")
    except BaseException as exc:
        state.update(status="failed", eligible_for_broader_training=False,
                     error=f"{type(exc).__name__}: {exc}", traceback=traceback.format_exc())
        raise
    finally:
        if hashes:
            changed = [path for path, digest in hashes.items() if sha256(path) != digest]
            if changed:
                state.update(status="failed", eligible_for_broader_training=False, all_source_inputs_unchanged=False,
                             changed_sources_or_inputs=changed)
        state.update(finished_unix=time.time(), wall_seconds=time.monotonic() - started)
        save()
        print(json.dumps({"status": state["status"], "mask_verified_rows": state.get("mask_verified_rows", 0),
                          "checkpoint_copies": state["checkpoint_copies"], "optimizer_updates": 0}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--upstream", type=Path, default=DEFAULT_UPSTREAM)
    parser.add_argument("--wall-seconds", type=float, default=900)
    parser.add_argument("--parity-diagnostic", action="store_true")
    parser.add_argument("--diagnostic-matmul-precision", choices=("highest",))
    run(parser.parse_args())


if __name__ == "__main__":
    main()
