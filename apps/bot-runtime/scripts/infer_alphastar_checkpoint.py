"""Read-only, label-free inference from the immutable replay diagnostic checkpoint.

Uses the shared official AlphaStar graph and current-observation pointer binding.
It never imports a game client, executes an intent, updates weights, or rewrites
the checkpoint. Offline captured frames are diagnostics, not live-game evidence.
"""
from __future__ import annotations

import argparse
from collections.abc import Mapping
import json
import os
from pathlib import Path
import sys
import time
import traceback
import uuid

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))
from scripts.train_alphastar_replay import (  # noqa: E402
    DEFAULT_UPSTREAM, DISABLED_HEADS, HEADS, PINNED_COMMIT, TensorConfig, TensorError,
    build_official_bridge, read_dataset, runtime_registry, sha256, train_rows, verify_upstream,
)
from pluto_sc2.policy_intents import bind_observation, prediction_to_intent  # noqa: E402


def read_checkpoint_artifacts(directory, catalog_path):
    """Verify the original run and snapshots, without requiring unchanged callers."""
    directory = Path(directory)
    result = json.loads((directory / "result.json").read_text(encoding="utf-8"))
    if (result.get("schema") != "alphastar-real-replay-diagnostic-v1"
            or result.get("status") != "passed" or result.get("checkpoint_restore_verified") is not True
            or result.get("upstream_commit") != PINNED_COMMIT
            or result.get("learned_from_actual_replay") is not True
            or result.get("disabled_supervision") != list(DISABLED_HEADS)):
        raise TensorError("Requires a verified real-replay checkpoint with this bridge contract")
    checkpoint = directory / "checkpoint.msgpack"
    digest = sha256(checkpoint)
    if digest != result.get("checkpoint_sha256"):
        raise TensorError("Checkpoint hash mismatch")
    if sha256(catalog_path) != result.get("dataset_hashes", {}).get("game_data"):
        raise TensorError("Public game catalog differs from this checkpoint")
    source_hashes = result.get("source_hashes")
    if not isinstance(source_hashes, dict) or not source_hashes:
        raise TensorError("Missing original source hashes")
    for path, expected in source_hashes.items():
        # Training ran under WSL. Normalize only the stored filename; never
        # follow untrusted paths outside the immutable snapshot directory.
        name = path.replace("\\", "/").rsplit("/", 1)[-1]
        if not name or name in (".", "..") or sha256(directory / "source-snapshot" / name) != expected:
            raise TensorError("Original training snapshot hash mismatch")
    registry_data = json.loads((directory / "registry.json").read_text(encoding="utf-8"))
    registry = registry_data["functions"]
    if not registry or [row["id"] for row in registry] != list(range(len(registry))):
        raise TensorError("Registry indices are not the contiguous official head vocabulary")
    mapping = {int(key): value for key, value in registry_data["unit_types"].items()}
    return {"result": result, "checkpoint": checkpoint, "checkpoint_sha256": digest,
            "registry": registry, "unit_types": mapping,
            "config": TensorConfig(**result["tensor_config"]),
            "catalog": json.loads(Path(catalog_path).read_text(encoding="utf-8")),
            "result_sha256": sha256(directory / "result.json"),
            "registry_sha256": sha256(directory / "registry.json")}


def validate_observation_only(example):
    """Reject expert labels even if a graph would silently ignore extra keys."""
    if not isinstance(example, Mapping) or set(example) != {"inputs", "metadata"}:
        raise TensorError("Inference requires observation-only tensors, without labels or intents")
    inputs = example["inputs"]
    if not isinstance(inputs, Mapping) or "step_type" not in inputs:
        raise TensorError("Missing explicit inference step type")
    for key in inputs:
        if key != "step_type" and not (isinstance(key, tuple) and len(key) == 2 and key[0] == "observation"):
            raise TensorError("Expert behavior/action features are forbidden during inference")
    step = np.asarray(inputs["step_type"])
    if step.shape != () or step.dtype != np.int32 or int(step) != 1:
        raise TensorError("This checkpoint supports independent MID observations only")
    return inputs


def select_dataset_rows(directory, result, maximum):
    """Choose the recorded diagnostic events; labels stay out of graph inputs."""
    _, _, hashes, _ = read_dataset(directory)
    if hashes != result.get("dataset_hashes"):
        raise TensorError("Inference diagnostic dataset differs from checkpoint evidence")
    identities = [(row["replay_id"], row["player_id"], row["action_ordinal"])
                  for row in result["mask_proofs"][:maximum]]
    if not identities or len(set(identities)) != len(identities):
        raise TensorError("Missing or duplicate original diagnostic identities")
    wanted = set(identities)
    selected = {}
    for row in train_rows(directory):
        identity = row["replay_id"], row["player_id"], row["action_ordinal"]
        if identity in wanted:
            selected[identity] = row
    if set(selected) != wanted:
        raise TensorError("A recorded diagnostic event is missing")
    return [selected[identity] for identity in identities]


def score_after_prediction(prediction, sample, registry, mapping, config):
    """Post-inference scoring only; expert values never enter the policy graph."""
    from pluto_sc2.alphastar_tensor import tensorize_sample
    expert = tensorize_sample(sample, registry, mapping, config)
    same_function = int(expert["labels"]["function"]) == prediction["function"]
    metrics = {"function_exact": same_function}
    if same_function:
        for name in HEADS:
            if name == "function" or not expert["active_heads"][name]:
                continue
            actual = np.asarray(prediction[name])
            expected = expert["labels"][name]
            metrics[name + "_exact_given_correct_function"] = bool(np.array_equal(actual, expected))
    return {"scope": "same TRAIN events, independently predicted prefixes; not holdout or gameplay strength",
            "expert_function": expert["metadata"]["function"]["name"], "metrics": metrics}


def verify_tree_schema(expected, actual, path="model"):
    """Require exact parameter/state paths, shapes and dtypes; no partial restore."""
    if isinstance(expected, Mapping):
        if not isinstance(actual, Mapping) or set(expected) != set(actual):
            raise TensorError(f"Checkpoint mapping differs at {path}")
        count = size = 0
        for name in expected:
            leaves, values = verify_tree_schema(expected[name], actual[name], f"{path}/{name}")
            count += leaves
            size += values
        return count, size
    value = np.asarray(actual)
    if tuple(expected.shape) != value.shape or np.dtype(expected.dtype) != value.dtype:
        raise TensorError(f"Checkpoint shape/dtype differs at {path}")
    if not np.issubdtype(value.dtype, np.number) or not np.all(np.isfinite(value)):
        raise TensorError(f"Checkpoint contains nonfinite or unsupported values at {path}")
    return 1, value.size


def checkpoint_bridge(result):
    """Choose only the graph explicitly named by a verified run's contract.

    Legacy artifacts retain their original graph. Expanded artifacts must pin
    the reviewed helper source and shape; an unknown adapter never falls back.
    """
    adapter = result.get("capacity_adapter")
    if adapter is None:
        return build_official_bridge
    from scripts.alphastar_capacity_bridge import CAPACITY_ADAPTER, CAPACITY_MATMUL_PRECISION, build_capacity_bridge
    if adapter != CAPACITY_ADAPTER or result.get("tensor_config") != {
            "max_entities": 512, "max_selected": 64, "world_size": 256,
            "minimap_size": 64, "unit_features": 48}:
        raise TensorError("Unknown or inconsistent checkpoint capacity adapter")
    if result.get("matmul_precision") != CAPACITY_MATMUL_PRECISION:
        raise TensorError("Expanded checkpoint lacks its highest matmul precision contract")
    helper = ROOT / "scripts/alphastar_capacity_bridge.py"
    recorded = [digest for path, digest in result.get("source_hashes", {}).items()
                if path.replace("\\", "/").rsplit("/", 1)[-1] == helper.name]
    if recorded != [sha256(helper)]:
        raise TensorError("Checkpoint capacity adapter source hash differs")
    return build_capacity_bridge


def structured_prediction(outputs, registry, config):
    """Expose sampled actions and prove meaningful arguments were legal to sample.

    An all-masked active head is an explicit rejected prediction, never a
    substituted function or target. Unused head masks do not reject camera-only
    predictions. Every source slot, including EOS, is checked against its own
    recurrent step's mask.
    """
    sizes = {"function": len(registry), "delay": 2, "queued": 2, "repeat": 2,
             "unit_tags": config.max_entities + 1, "target_unit_tag": config.max_entities,
             "world": config.world_size**2}
    prediction, arrays = {}, {}
    for name in HEADS:
        shape = (config.max_selected,) if name == "unit_tags" else ()
        action = np.asarray(outputs["action", name])
        logits, masks = np.asarray(outputs["logits", name]), np.asarray(outputs["masks", name])
        if action.shape != (1, 1) + shape or action.dtype != np.int32:
            raise TensorError(f"Invalid sampled {name} shape/dtype")
        if (logits.shape != (1, 1) + shape + (sizes[name],) or logits.dtype != np.float32
                or masks.shape != logits.shape or masks.dtype != np.bool_ or not np.all(np.isfinite(logits))):
            raise TensorError(f"Invalid sampled {name} logits/masks")
        value = action[0, 0]
        if np.any(value < 0) or np.any(value >= sizes[name]):
            raise TensorError(f"Sampled {name} outside head vocabulary")
        prediction[name] = value.tolist() if shape else int(value)
        arrays[name] = (logits[0, 0], masks[0, 0])
    function = registry[prediction["function"]]
    if function["id"] != prediction["function"]:
        raise TensorError("Function head index does not match registry identity")
    if any(prediction[name] != 0 for name in DISABLED_HEADS):
        raise TensorError("Unsupported timing/repeat conditioning must remain zero")
    active = [name for name in HEADS if name not in DISABLED_HEADS
              and (name == "function" or name in function["args"])]
    proofs, failures = {}, []
    for name in active:
        argument = np.asarray(outputs["argument_masks", name])
        if argument.shape != (1, 1) or argument.dtype != np.bool_ or not bool(argument[0, 0]):
            failures.append(f"active_{name}_argument_mask_false")
        logits, masks = arrays[name]
        selected = prediction[name]
        if name == "unit_tags":
            allowed = masks[np.arange(config.max_selected), selected]
            selected_logits = logits[np.arange(config.max_selected), selected]
        else:
            allowed, selected_logits = np.asarray([masks[selected]]), np.asarray([logits[selected]])
        if not np.all(allowed):
            failures.append(f"sampled_{name}_target_mask_false")
        proofs[name] = {"sampled_values": selected, "all_selected_values_unmasked": bool(np.all(allowed)),
                        "selected_logits": selected_logits.astype(float).tolist()}
    return {"prediction": prediction, "function": function["name"], "active_heads": active,
            "mask_checks_passed": not failures, "mask_failures": failures, "mask_proofs": proofs}


class CheckpointPolicy:
    """Read-only checkpoint caller. Host must bind each actual observation later.

    Initialization traces a label-free graph to verify its schema. It does not
    initialize replacement weights. Restored weights are the only weights used
    by predict(). The current v3 bridge has no temporal torso or prior-action
    inputs; each event is therefore independent MID, as during its training.
    """

    def __init__(self, artifacts, example, *, upstream=DEFAULT_UPSTREAM, seed=42, sampling_mode="sample"):
        validate_observation_only(example)
        verify_upstream(upstream)
        sys.path.insert(0, str(Path(upstream).resolve()))
        import jax
        import jax.numpy as jnp
        import haiku as hk
        from flax import serialization
        from alphastar import types

        registry, mapping = runtime_registry(artifacts["catalog"])
        if registry != artifacts["registry"] or mapping != artifacts["unit_types"]:
            raise TensorError("Saved registry differs from pinned official functions/public catalog")
        self.artifacts, self.config = artifacts, artifacts["config"]
        self.jax, self.jnp, self.types = jax, jnp, types
        builder = checkpoint_bridge(artifacts["result"])
        if artifacts["result"].get("capacity_adapter") is not None:
            from scripts.alphastar_capacity_bridge import configure_capacity_runtime
            configure_capacity_runtime(artifacts["result"])
        self.component, _ = builder(example, self.config, registry,
                                                  is_training=False, sampling_mode=sampling_mode)
        source_proof = self.verify_inactive_source_component()
        if any(isinstance(key, tuple) and key[0] == "behaviour_features" for key in self.component.input_spec):
            raise TensorError("Inference graph unexpectedly requires teacher-forcing inputs")
        self.network = hk.transform_with_state(jax.vmap(self.component.unroll))
        self.previous = jax.tree_util.tree_map(
            lambda spec: jnp.zeros((1,) + spec.shape, spec.dtype), self.component.prev_state_spec)
        self.key = jax.random.PRNGKey(seed)
        expected_params, expected_state = jax.eval_shape(
            self.network.init, self.key, self.inputs_for(example), self.previous)
        restored = serialization.msgpack_restore(artifacts["checkpoint"].read_bytes())
        if (set(restored) != {"params", "network_state", "optimizer_state", "optimizer_updates"}
                or restored["optimizer_updates"] != artifacts["result"]["optimizer_updates"]):
            raise TensorError("Unexpected checkpoint contents or update count")
        param_leaves, parameter_count = verify_tree_schema(expected_params, restored["params"], "params")
        state_leaves, _ = verify_tree_schema(expected_state, restored["network_state"], "network_state")
        if parameter_count != artifacts["result"]["parameter_count"]:
            raise TensorError("Inference parameter count differs from trained architecture")
        self.params = jax.tree_util.tree_map(jnp.asarray, restored["params"])
        self.state = jax.tree_util.tree_map(jnp.asarray, restored["network_state"])
        self.apply = jax.jit(self.network.apply)
        self.schema_proof = {"parameter_count": parameter_count, "parameter_leaves": param_leaves,
                             "network_state_leaves": state_leaves, "checkpoint_schema_verified": True,
                             "input_keys": ["/".join(key) if isinstance(key, tuple) else key
                                            for key in self.component.input_spec],
                             "sampling_mode": sampling_mode, "disabled_conditioning": {name: 0 for name in DISABLED_HEADS},
                             "inactive_source_component_proof": source_proof,
                             "optimizer_state_loaded_for_updates": False}
        self.schema_proof["capacity_adapter"] = artifacts["result"].get("capacity_adapter")
        self.schema_proof["matmul_precision"] = artifacts["result"].get("matmul_precision")

    def verify_inactive_source_component(self):
        """Numerically exercise the actual parameter-free component, not a mock.

        Separate boundary check with synthetic logits; no expert action is fed
        into the actual replay inference network. Camera functions must produce
        EOS whether own sources exist or not; required-source masks stay intact.
        """
        def visit(component):
            yield component
            for part in getattr(component, "_components", ()):
                yield from visit(part)
            inner = getattr(component, "_inner_component", None)
            if inner is not None:
                yield from visit(inner)

        found = [part for part in visit(self.component) if part.name == "inactive_source_mask"]
        if len(found) != 1:
            raise TensorError("Exactly one function-aware source sampling adapter required")
        component = found[0]
        size = self.config.max_entities + 1
        records = []
        for active, available in ((False, False), (False, True), (True, False), (True, True)):
            logits = self.jnp.arange(size, dtype=self.jnp.float32)
            mask = self.jnp.arange(size) < (size - 1 if available else 0)
            data = self.types.StreamDict({("logits", "unit_tags"): logits, ("masks", "unit_tags"): mask,
                                          ("argument_masks", "unit_tags"): self.jnp.asarray(active)})
            result, _ = component._forward(data)
            actual_mask, actual_logits = np.asarray(result["masks", "unit_tags"]), np.asarray(result["logits", "unit_tags"])
            if active:
                passed = np.array_equal(actual_mask, np.asarray(mask)) and np.array_equal(actual_logits, np.asarray(logits))
            else:
                passed = (np.flatnonzero(actual_mask).tolist() == [size - 1]
                          and int(actual_logits.argmax()) == size - 1)
            if not passed:
                raise TensorError("Function-aware source sampling component changed prefix semantics")
            records.append({"source_argument_active": active, "selectable_own_units_exist": available,
                            "passed": True, "eos_only": not active})
        return {"actual_component_forward_executed": True, "model_forward_executed": False,
                "scope": "synthetic logit boundary check only", "cases": records}

    def inputs_for(self, example):
        raw = validate_observation_only(example)
        inputs = self.types.StreamDict()
        for key, spec in self.component.input_spec.items():
            if key not in raw:
                raise TensorError(f"Missing observation input {key}")
            spec.validate(raw[key])
            inputs[key] = self.jnp.asarray(raw[key])[None, None, ...]
        return inputs

    def predict(self, example):
        inputs = self.inputs_for(example)
        next_key, key = self.jax.random.split(self.key)
        (outputs, _, _), next_state = self.apply(self.params, self.state, key, inputs, self.previous)
        record = structured_prediction(outputs, self.artifacts["registry"], self.config)
        # No optimizer or parameter assignment exists. The official network's
        # state is checked before retaining it for the next observation.
        verify_tree_schema(self.state, next_state, "next_network_state")
        self.key, self.state = next_key, next_state
        return record


def run(args):
    os.environ.setdefault("XLA_PYTHON_CLIENT_PREALLOCATE", "false")
    os.environ.setdefault("OMP_NUM_THREADS", "4")
    os.environ.setdefault("JAX_COMPILATION_CACHE_DIR", str(Path.home() / ".cache/sc2-alphastar-v1/jax"))
    if args.cpu_schema_only:
        os.environ["JAX_PLATFORMS"] = "cpu"
    sys.dont_write_bytecode = True
    output = Path(args.output).resolve()
    if output.exists():
        raise TensorError("Inference audit requires a new output directory")
    output.mkdir(parents=True)
    state = {"schema": "alphastar-checkpoint-inference-v1", "status": "running", "started_unix": time.time(),
             "pid": os.getpid(), "optimizer_updates": 0, "checkpoint_writes": 0, "game_inputs": 0,
             "model_forward_executed": False, "live_game_ready": False, "strength_evidence": False,
             "frame_scope": "offline permitted observations; expert actions only for separate post-inference scoring",
             "seed": args.seed, "rng_policy": "PRNGKey(seed), split once per predicted observation in recorded order",
             "sampling_mode": args.sampling_mode}

    def save():
        (output / "inference.json").write_text(json.dumps(state, indent=2, allow_nan=False) + "\n", encoding="utf-8")

    def stop():
        markers = [output / "STOP", Path(args.run) / "STOP", DEFAULT_UPSTREAM.parent.parent / "STOP"]
        if args.dataset:
            markers.append(Path(args.dataset) / "STOP")
        for marker in markers:
            if marker.exists():
                raise TensorError(f"STOP marker respected: {marker}")

    try:
        stop()
        catalog_path = Path(args.catalog) if args.catalog else Path(args.dataset) / "game-data.json"
        paths = [Path(__file__), ROOT / "scripts/train_alphastar_replay.py",
                 ROOT / "scripts/alphastar_capacity_bridge.py",
                 ROOT / "src/pluto_sc2/alphastar_tensor.py", ROOT / "src/pluto_sc2/policy_intents.py",
                 ROOT / "src/pluto_sc2/rich_intents.py", ROOT / "src/pluto_sc2/rich_actions.py",
                 catalog_path, Path(args.run) / "result.json",
                 Path(args.run) / "registry.json", Path(args.run) / "checkpoint.msgpack"]
        if args.dataset:
            paths.extend(Path(args.dataset) / name for name in ("manifest.json", "samples.jsonl.gz"))
        else:
            paths.append(Path(args.frame))
        hashes = {str(path.resolve()): sha256(path) for path in paths}
        state["source_and_input_hashes"] = hashes
        state["pid_creation_time"] = __import__("psutil").Process().create_time()
        artifacts = read_checkpoint_artifacts(args.run, catalog_path)
        state["checkpoint_sha256"] = artifacts["checkpoint_sha256"]
        if args.dataset:
            rows = select_dataset_rows(args.dataset, artifacts["result"], args.max_frames)
        else:
            rows = [{"frame": json.loads(Path(args.frame).read_text(encoding="utf-8"))}]
        state["selected_frames"] = len(rows)
        state["original_diagnostic_frames"] = len(artifacts["result"].get("mask_proofs", []))
        state["original_frame_coverage"] = "all" if len(rows) == state["original_diagnostic_frames"] else "bounded subset"
        from pluto_sc2.alphastar_tensor import tensorize_observation
        examples = [tensorize_observation(row["frame"], artifacts["registry"], artifacts["unit_types"],
                                         artifacts["config"]) for row in rows]
        session = args.session_id or "offline-checkpoint-diagnostic-" + str(uuid.uuid4())
        state["session_id"] = session
        save()
        policy = CheckpointPolicy(artifacts, examples[0], upstream=args.upstream, seed=args.seed,
                                  sampling_mode=args.sampling_mode)
        state.update(schema_proof=policy.schema_proof, devices=[str(d) for d in policy.jax.devices()])
        stop()
        if args.cpu_schema_only:
            for example in examples:
                policy.inputs_for(example)
            state["status"] = "schema_verified"
        else:
            state["events"] = []
            for index, (row, example) in enumerate(zip(rows, examples)):
                stop()
                frame = row["frame"]
                binding = bind_observation(frame, example["metadata"]["entity_tags"], artifacts["registry"],
                                           artifacts["catalog"], session_id=session,
                                           max_entities=artifacts["config"].max_entities,
                                           max_selected=artifacts["config"].max_selected)
                record = policy.predict(example)
                stop()
                record.update(frame_index=index, observation_metadata=example["metadata"], observation_binding=binding)
                if record["mask_checks_passed"]:
                    intent = prediction_to_intent(record["prediction"], artifacts["registry"], frame, binding,
                                                  artifacts["catalog"], session_id=session)
                else:
                    intent = {"admitted": False, "reasons": record["mask_failures"], "provenance": "policy_prediction"}
                record.update(intent=intent, prediction_admitted_by_decoder=intent["admitted"])
                if args.dataset:
                    record["event_identity"] = {name: row[name] for name in
                                                ("replay_id", "player_id", "action_ordinal", "action_loop", "preceding_loop")}
                    record["score"] = score_after_prediction(record["prediction"], row, artifacts["registry"],
                                                            artifacts["unit_types"], artifacts["config"])
                state["events"].append(record)
                state["model_forward_executed"] = True
                save()
            state.update(status="inferred", frames_inferred=len(state["events"]),
                         decoder_admitted=sum(event["prediction_admitted_by_decoder"] for event in state["events"]),
                         mask_checks_passed=sum(event["mask_checks_passed"] for event in state["events"]))
        for path, expected in hashes.items():
            if sha256(path) != expected:
                raise TensorError(f"Source/input changed during inference audit: {path}")
        verify_upstream(args.upstream)
        state["source_input_checkpoint_unchanged"] = True
    except BaseException as exc:
        state.update(status="failed", error=f"{type(exc).__name__}: {exc}", traceback=traceback.format_exc())
        raise
    finally:
        state.update(finished_unix=time.time(), wall_seconds=time.time() - state["started_unix"])
        save()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True, help="Immutable completed training diagnostic directory")
    sources = parser.add_mutually_exclusive_group(required=True)
    sources.add_argument("--dataset", type=Path, help="Original dataset; select original diagnostic frames, post-score separately")
    sources.add_argument("--frame", type=Path, help="One permitted observation JSON, without expert intent")
    parser.add_argument("--catalog", type=Path, help="Exact game-data.json; defaults to dataset/game-data.json")
    parser.add_argument("--max-frames", type=int, default=24)
    parser.add_argument("--session-id", help="Fresh diagnostic identity; defaults to a new UUID, never reused across live games")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--upstream", type=Path, default=DEFAULT_UPSTREAM)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--sampling-mode", choices=("sample", "greedy"), default="sample")
    parser.add_argument("--cpu-schema-only", action="store_true", help="Trace schema on CPU; no model forward")
    args = parser.parse_args()
    if (not 0 <= args.seed < 2**32 or args.session_id is not None and not args.session_id.strip()
            or not 1 <= args.max_frames <= 64 or args.frame and not args.catalog):
        parser.error("Require uint32 seed, frames1..64, nonempty session ID and --catalog for single --frame")
    run(args)


if __name__ == "__main__":
    main()
