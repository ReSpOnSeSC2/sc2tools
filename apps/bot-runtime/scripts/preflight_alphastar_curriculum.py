"""Verify every immutable TRAIN label against the restored official graph.

This is a read-only curriculum audit: no optimizer, game, checkpoint write, or
held-out/generalization claim. The current 681-row dataset has exactly two known
unsupported Energy Recharge events; all other failures block curriculum use.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
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
    DEFAULT_UPSTREAM, PINNED_COMMIT, TensorError, build_official_bridge,
    read_dataset, runtime_registry, sha256, train_rows, verify_upstream,
)
from scripts.infer_alphastar_checkpoint import (  # noqa: E402
    read_checkpoint_artifacts, validate_observation_only, verify_tree_schema,
)
from pluto_sc2.alphastar_tensor import (  # noqa: E402
    tensorize_observation, tensorize_sample, validate_supervised_masks,
)

REPLAY = "ca381f141989827f2888542ea74f2dddc3c0a87d980a9665f7380ef6393fc21e"
ALLOWED_EXCLUSIONS = {(REPLAY, 2, 1033), (REPLAY, 2, 1385)}
EXCLUSION_ERROR = "Exact RAW_FUNCTION mapping count 0"


def identity(row):
    return row["replay_id"], row["player_id"], row["action_ordinal"]


def validate_train_identity(row, partitions, train_ids, validation_ids):
    if (row.get("partition") != "train" or partitions.get(row["replay_id"]) != "train"
            or row["replay_id"] not in train_ids or row["replay_id"] in validation_ids
            or train_ids & validation_ids):
        raise TensorError("TRAIN identity or whole-replay partition mismatch")


def permitted_exclusion(row, error):
    return (identity(row) in ALLOWED_EXCLUSIONS
            and row.get("intent", {}).get("ability_id") == 4129
            and isinstance(error, TensorError) and str(error) == EXCLUSION_ERROR)


def validate_checkpoint_root(decoded, expected_updates):
    if (set(decoded) != {"params", "network_state", "optimizer_state", "optimizer_updates"}
            or type(decoded["optimizer_updates"]) is not int
            or decoded["optimizer_updates"] != expected_updates):
        raise TensorError("Unexpected checkpoint contents or update count")


def validate_active_logits(outputs, active_heads):
    # The pinned mask implementation uses finite -1e10, not negative infinity.
    for name, active in active_heads.items():
        if active and not np.all(np.isfinite(np.asarray(outputs["logits", name]))):
            raise TensorError(f"Nonfinite active-head logits: {name}")


def _tensor_digest(items):
    digest = hashlib.sha256()
    for name, value in sorted(items, key=lambda item: item[0]):
        array = np.ascontiguousarray(value)
        if array.dtype.hasobject:
            raise TensorError("Object tensors cannot be fingerprinted")
        header = json.dumps([name, array.dtype.str, array.shape], separators=(",", ":")).encode()
        payload = array.tobytes()
        digest.update(len(header).to_bytes(8, "little"))
        digest.update(header)
        digest.update(len(payload).to_bytes(8, "little"))
        digest.update(payload)
    return digest.hexdigest()


def observation_fingerprint(encoded):
    """Only actual inference inputs; never expert action, metadata, or ordinal."""
    inputs = validate_observation_only(encoded)
    items = [(json.dumps(key), value) for key, value in inputs.items()]
    if not any(name == json.dumps("step_type") for name, _ in items) or len(items) < 2:
        raise TensorError("Missing observation inputs while fingerprinting")
    return _tensor_digest(items)


def label_fingerprint(example):
    return _tensor_digest([(name, example["labels"][name])
                           for name, active in example["active_heads"].items() if active])


def duplicate_summary(records):
    groups = defaultdict(list)
    for row in records:
        groups[row["observation_sha256"]].append(row)
    duplicate = [rows for rows in groups.values() if len(rows) > 1]
    conflicts = [rows for rows in duplicate if len({row["label_sha256"] for row in rows}) > 1]
    maximum_exact = sum(max(Counter(row["label_sha256"] for row in rows).values()) for rows in groups.values())
    return {"fingerprint_scope": "exact observation tensors including step_type, dtype and shape; excludes expert actions and metadata",
            "events": len(records), "unique_observations": len(groups),
            "duplicate_observation_groups": len(duplicate),
            "events_in_duplicate_groups": sum(map(len, duplicate)),
            "conflicting_label_groups": len(conflicts), "events_in_conflicting_groups": sum(map(len, conflicts)),
            "deterministic_full_action_ceiling_count": maximum_exact,
            "deterministic_full_action_ceiling_fraction": maximum_exact / len(records) if records else None,
            "conflict_groups": conflicts,
            "interpretation": "A stateless deterministic policy cannot exactly reproduce different labels for identical inputs; this is neither a validation score nor evidence of faulty expert play."}


def dataset_provenance_guard(manifest, hashes, result, split):
    if hashes != result.get("dataset_hashes") or manifest.get("split_sha256") != result.get("split_sha256"):
        raise TensorError("Curriculum differs from the checkpoint's immutable dataset or split")
    train_ids = {row["replay_id"] for row in split["train_replay_ids"]}
    validation_ids = {row["replay_id"] for row in split["validation_replay_ids"]}
    if train_ids & validation_ids:
        raise TensorError("Whole-replay TRAIN/validation overlap")
    if manifest.get("replay_partitions") != {REPLAY: "train"} or manifest.get("counts", {}).get("train_samples") != 681:
        raise TensorError("This bounded preflight covers only the pinned681-row TRAIN curriculum")
    return train_ids, validation_ids


def host_path(value):
    value = str(value).replace("\\", "/")
    if os.name != "nt" and value.startswith("C:/"):
        return Path("/mnt/c/" + value[3:])
    if os.name == "nt" and value.startswith("/mnt/c/"):
        return Path("C:/" + value[7:])
    return Path(value)


def run(args):
    if not 0 < args.wall_seconds <= 900:
        raise TensorError("Require a wall budget in (0,900] seconds")
    started = time.monotonic()
    output, origin, dataset = [Path(value).resolve() for value in (args.output, args.run, args.dataset)]
    markers = [output / "STOP", origin / "STOP", dataset / "STOP", DEFAULT_UPSTREAM.parent.parent / "STOP"]

    def guard():
        for marker in markers:
            if marker.exists():
                raise TensorError(f"STOP marker respected: {marker}")
        if time.monotonic() - started >= args.wall_seconds:
            raise TensorError("Preflight wall budget exhausted")

    guard()
    if output.exists():
        raise TensorError("Preflight requires a new immutable output directory")
    output.mkdir(parents=True)
    state = {"schema": "alphastar-full-curriculum-preflight-v1", "status": "running",
             "started_unix": time.time(), "pid": os.getpid(), "optimizer_updates": 0,
             "checkpoint_writes": 0, "game_inputs": 0, "game_launches": 0,
             "eligible_for_broader_training": False, "live_game_ready": False,
             "held_out_evaluation": False, "strength_evidence": False,
             "upstream_commit": PINNED_COMMIT, "failures": [], "known_exclusions": [],
             "tensor_records": [], "mask_records": [], "all_source_inputs_unchanged": False,
             "wall_budget_seconds": args.wall_seconds,
             "deadline_semantics": "Checked before/after numerical operations; in-flight compilation is not interruptible"}
    hashes = {}

    def save():
        pending = output / "preflight.json.pending"
        pending.write_text(json.dumps(state, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        pending.replace(output / "preflight.json")

    try:
        state["pid_creation_time"] = __import__("psutil").Process().create_time()
        artifacts = read_checkpoint_artifacts(origin, dataset / "game-data.json")
        manifest, _, dataset_hashes, counts = read_dataset(dataset)
        split_path = host_path(manifest["split_path"])
        if sha256(split_path) != manifest["split_sha256"]:
            raise TensorError("Pinned whole-replay split file changed")
        train_ids, validation_ids = dataset_provenance_guard(
            manifest, dataset_hashes, artifacts["result"], json.loads(split_path.read_text(encoding="utf-8")))
        source_paths = [Path(__file__), ROOT / "scripts/train_alphastar_replay.py",
                        ROOT / "scripts/infer_alphastar_checkpoint.py", ROOT / "src/pluto_sc2/alphastar_tensor.py",
                        ROOT / "src/pluto_sc2/rich_intents.py", ROOT / "src/pluto_sc2/rich_actions.py"]
        prior_sources = {Path(name.replace("\\", "/")).name: digest
                         for name, digest in artifacts["result"]["source_hashes"].items()}
        for path in source_paths[1:]:
            if prior_sources.get(path.name) != sha256(path):
                raise TensorError(f"Current bridge source differs from checkpoint: {path.name}")
        paths = source_paths + [split_path]
        paths.extend(origin / name for name in ("result.json", "registry.json", "checkpoint.msgpack", "reproduction-recipe.json"))
        paths.extend(dataset / name for name in ("manifest.json", "samples.jsonl.gz", "game-data.json"))
        hashes = {str(path): sha256(path) for path in paths}
        snapshot = output / "source-snapshot"
        snapshot.mkdir()
        for path in source_paths:
            shutil.copy2(path, snapshot / path.name)
            if sha256(snapshot / path.name) != hashes[str(path)]:
                raise TensorError("Source changed while copying preflight snapshot")
        (snapshot / "manifest.json").write_text(json.dumps({str(path): hashes[str(path)] for path in source_paths}, indent=2) + "\n")
        state.update(source_and_input_hashes=hashes, dataset_hashes=dataset_hashes,
                     partition_counts=dict(counts), checkpoint_sha256=artifacts["checkpoint_sha256"],
                     checkpoint_optimizer_updates=artifacts["result"]["optimizer_updates"],
                     tensor_config=artifacts["result"]["tensor_config"], split_sha256=manifest["split_sha256"])
        registry, mapping, config = artifacts["registry"], artifacts["unit_types"], artifacts["config"]
        first = None
        seen = set()
        supported = {}
        for row in train_rows(dataset):
            guard()
            validate_train_identity(row, manifest["replay_partitions"], train_ids, validation_ids)
            key = identity(row)
            if key in seen:
                raise TensorError("Duplicate curriculum identity")
            seen.add(key)
            try:
                example = tensorize_sample(row, registry, mapping, config)
            except TensorError as exc:
                record = {"identity": key, "ability_id": row["intent"].get("ability_id"), "error": str(exc)}
                state["known_exclusions" if permitted_exclusion(row, exc) else "failures"].append(record)
                continue
            first = first or example
            record = {"identity": key, "function": example["metadata"]["function"]["name"],
                      "observation_sha256": observation_fingerprint(tensorize_observation(row["frame"], registry, mapping, config)),
                      "label_sha256": label_fingerprint(example)}
            supported[key] = record
            state["tensor_records"].append(record)
        state["input_fingerprint_audit"] = duplicate_summary(state["tensor_records"])
        state["function_counts"] = dict(Counter(record["function"] for record in state["tensor_records"]))
        state["source_train_rows"] = len(seen)
        state["tensor_supported_rows"] = len(supported)
        if (len(seen) != 681 or {tuple(row["identity"]) for row in state["known_exclusions"]} != ALLOWED_EXCLUSIONS):
            state["failures"].append({"error": "Pinned681-row coverage or known-exclusion set changed"})
        save()
        if first is None:
            raise TensorError("No valid TRAIN examples to preflight")
        os.environ.setdefault("XLA_PYTHON_CLIENT_PREALLOCATE", "false")
        os.environ.setdefault("OMP_NUM_THREADS", "4")
        os.environ.setdefault("JAX_COMPILATION_CACHE_DIR", str(Path.home() / ".cache/sc2-alphastar-v1/jax"))
        sys.dont_write_bytecode = True
        state["upstream_manifest_sha256"], state["upstream_file_count"] = verify_upstream(args.upstream)
        sys.path.insert(0, str(Path(args.upstream).resolve()))
        import jax
        import jax.numpy as jnp
        import haiku as hk
        from flax import serialization
        from alphastar import types
        if not any(device.platform == "gpu" for device in jax.devices()):
            raise TensorError("Preflight requires the isolated pinnedGPU runtime")
        state["devices"] = [str(device) for device in jax.devices()]
        if runtime_registry(artifacts["catalog"]) != (registry, mapping):
            raise TensorError("Official registry/type mapping changed")
        component, _ = build_official_bridge(first, config, registry)
        network = hk.transform_with_state(jax.vmap(component.unroll))
        previous = jax.tree_util.tree_map(lambda spec: jnp.zeros((1,) + spec.shape, spec.dtype), component.prev_state_spec)
        key = jax.random.PRNGKey(42)

        def inputs_for(example):
            inputs = types.StreamDict()
            for name, spec in component.input_spec.items():
                spec.validate(example["inputs"][name])
                inputs[name] = jnp.asarray(example["inputs"][name])[None, None, ...]
            return inputs

        guard()
        expected_params, expected_state = jax.eval_shape(network.init, key, inputs_for(first), previous)
        decoded = serialization.msgpack_restore(artifacts["checkpoint"].read_bytes())
        validate_checkpoint_root(decoded, artifacts["result"]["optimizer_updates"])
        leaves, count = verify_tree_schema(expected_params, decoded["params"], "params")
        state_leaves, _ = verify_tree_schema(expected_state, decoded["network_state"], "network_state")
        if count != artifacts["result"]["parameter_count"]:
            raise TensorError("Restored parameter count differs from checkpoint")
        params = jax.tree_util.tree_map(jnp.asarray, decoded["params"])
        network_state = jax.tree_util.tree_map(jnp.asarray, decoded["network_state"])
        state.update(restored_parameter_leaves=leaves, parameter_count=count,
                     network_state_leaves=state_leaves, exact_parameter_schema=True,
                     optimizer_state_restored_for_updates=False, fresh_parameter_initialization=False)
        apply = jax.jit(network.apply)
        for row in train_rows(dataset):
            guard()
            record = supported.get(identity(row))
            if record is None:
                continue
            try:
                example = tensorize_sample(row, registry, mapping, config)
                if (observation_fingerprint(tensorize_observation(row["frame"], registry, mapping, config)) != record["observation_sha256"]
                        or label_fingerprint(example) != record["label_sha256"]):
                    raise TensorError("Tensor or label changed between CPU and graph preflight")
                (predictions, _, _), next_state = apply(params, network_state, key, inputs_for(example), previous)
                validate_active_logits(predictions, example["active_heads"])
                proof = validate_supervised_masks(predictions, example)
                verify_tree_schema(network_state, next_state, "next_network_state")
                # State is discarded; every example is an independent MID event.
                state["mask_records"].append({**record, "verified_unmasked_targets": proof})
            except TensorError as exc:
                state["failures"].append({"identity": identity(row), "stage": "official_graph_mask", "error": str(exc)})
            guard()
            if (len(state["mask_records"]) + len(state["failures"])) % 64 == 0:
                save()
                print(json.dumps({"masks_verified": len(state["mask_records"]), "failures": len(state["failures"])}), flush=True)
        state["mask_verified_rows"] = len(state["mask_records"])
        ready = len(state["mask_records"]) == 679 and not state["failures"]
        state.update(status="passed" if ready else "failed", eligible_for_broader_training=ready)
        state["readiness_scope"] = "ExistingTRAIN labels and graph masks only; no optimizer update, fit score, held-out evaluation or live ability/placement proof"
    except BaseException as exc:
        state.update(status="failed", error=f"{type(exc).__name__}: {exc}", traceback=traceback.format_exc())
        raise
    finally:
        try:
            changed = [path for path, digest in hashes.items() if sha256(path) != digest]
            if changed:
                state.update(status="failed", eligible_for_broader_training=False, changed_sources_or_inputs=changed)
                raise TensorError("Source or immutable input changed during preflight")
            if hashes:
                verify_upstream(args.upstream)
                state["all_source_inputs_unchanged"] = True
        except BaseException as exc:
            state.update(status="failed", eligible_for_broader_training=False,
                         finalization_error=f"{type(exc).__name__}: {exc}")
            raise
        finally:
            state.update(finished_unix=time.time(), wall_seconds=time.monotonic() - started)
            save()
            print(json.dumps({"status": state["status"], "masks_verified": len(state["mask_records"]),
                              "known_exclusions": len(state["known_exclusions"]), "failures": len(state["failures"]),
                              "eligible_for_broader_training": state["eligible_for_broader_training"]}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--upstream", type=Path, default=DEFAULT_UPSTREAM)
    parser.add_argument("--wall-seconds", type=float, default=900)
    run(parser.parse_args())


if __name__ == "__main__":
    main()
