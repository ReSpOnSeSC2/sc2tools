"""Read-only fixed-frame world logits, masks and spatial-support diagnostics.

Teacher prefixes and observation-only greedy prefixes are separate experiments.
Tap components copy streams without changing any existing stream or parameter.
No optimizer is constructed and no checkpoint is written.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import traceback

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))

PARENT_SHA = "a8dfbec8d7a6189c97fa5af304287bf1fa917bae5ed004d442da7685925efaa6"
CANDIDATE_SHA = "5c49d908b85bbd63e1f89fc1eadbcc9f437b28cdc03b5ed4b0f007e7956baa5a"
ORDINALS = (139, 234, 518, 593, 692)
STAGES = ("raw", "intent", "placement")


def require(value, message):
    if not value:
        raise ValueError(message)


def digest_json(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def distribution_metrics(logits, mask, target, *, size=256):
    """Float64 descriptive statistics; excluded targets have no conditional CE."""
    logits, mask = np.asarray(logits), np.asarray(mask)
    require(logits.shape == mask.shape == (size * size,) and mask.dtype == np.bool_, "Invalid world arrays")
    require(type(target) is int and 0 <= target < len(logits), "Invalid target index")
    require(np.isfinite(logits).all() and mask.any(), "Nonfinite logits or empty support")
    indices = np.flatnonzero(mask)
    allowed = logits[mask].astype(np.float64)
    peak = float(allowed.max())
    exponential = np.exp(allowed - peak)
    probabilities = exponential / exponential.sum()
    log_z = peak + np.log(exponential.sum())
    entropy = float(-np.sum(probabilities * (allowed - log_z)))
    target_allowed = bool(mask[target])
    maximum = int(indices[np.argmax(allowed)])
    order = np.lexsort((indices, -allowed))[:10]
    x, y = target % size, target // size
    distance = np.hypot(indices % size - x, indices // size - y)
    result = {"support_cells": int(mask.sum()), "target_allowed": target_allowed,
        "argmax": maximum, "argmax_cell": [maximum % size, maximum // size],
        "target_cell": [x, y], "entropy_nats": entropy, "effective_support": float(np.exp(entropy)),
        "uniform_entropy_nats": float(np.log(len(indices))), "max_probability": float(probabilities.max()),
        "target_logit": float(logits[target]), "top_logit": peak,
        "target_rank_strict": None, "target_tie_count": None, "target_probability": 0., "target_ce_nats": None,
        "mass_within_grid_radius": {str(radius): float(probabilities[distance <= radius].sum()) for radius in (1, 3, 8, 16)},
        "top10": [{"index": int(indices[j]), "cell": [int(indices[j] % size), int(indices[j] // size)],
                   "logit": float(allowed[j]), "probability": float(probabilities[j])} for j in order]}
    if target_allowed:
        value = float(logits[target])
        result.update(target_rank_strict=int(np.count_nonzero(allowed > value)) + 1,
                      target_tie_count=int(np.count_nonzero(allowed == value)),
                      target_probability=float(np.exp(value - log_z)), target_ce_nats=float(log_z - value),
                      top_minus_target_logit=float(peak - value))
    return result


def mask_transition(before_logits, before_mask, after_logits, after_mask):
    before_logits, after_logits = np.asarray(before_logits), np.asarray(after_logits)
    before_mask, after_mask = np.asarray(before_mask), np.asarray(after_mask)
    require(before_logits.shape == after_logits.shape == before_mask.shape == after_mask.shape, "Mask shape drift")
    require(not np.any(after_mask & ~before_mask), "Mask expanded support")
    require(np.array_equal(before_logits[after_mask], after_logits[after_mask]), "Mask changed an allowed logit")
    return {"removed_cells": int(np.count_nonzero(before_mask & ~after_mask)),
            "support_only_narrowed": True, "allowed_logits_exact": True}


def instrument_component(component, sequential_type, tap_factory):
    """Rebuild only the fresh world sequence with read-only stream copies."""
    require(isinstance(component, sequential_type) and component.name == "official_lite_rich_intent_v1", "Root graph changed")
    heads = [child for child in component._components if child.name == "world_head"]
    require(len(heads) == 1 and isinstance(heads[0], sequential_type), "World graph changed")
    original = heads[0]
    names = [part.name for part in original._components]
    require(names.count("intent_mask_world") == names.count("observed_building_overlap_mask_v1") == 1, "Mask graph changed")
    at = names.index("intent_mask_world")
    require(at > 0 and names[at - 1] == "logits" and names[at + 1] == "observed_building_overlap_mask_v1", "Mask ordering changed")
    head = sequential_type(name=original.name)
    visual = {key: spec for key, spec in original.input_spec.items() if isinstance(key, str) and key.startswith("visual_stream_ds")}
    require(bool(visual), "No world input visual streams")
    head.append(tap_factory("encoder_visual", visual))
    for part in original._components:
        head.append(part)
        stage = {"logits": "raw", "intent_mask_world": "intent", "observed_building_overlap_mask_v1": "placement"}.get(part.name)
        if stage:
            names_to_copy = (("logits", "world"), ("masks", "world"))
            head.append(tap_factory(stage, {key: part.output_spec[key] for key in names_to_copy}))
    root = sequential_type(name=component.name)
    for child in component._components:
        root.append(head if child is original else child)
    return root


def tapped_bridge(example, config, registry, *, training):
    from alphastar import types
    from alphastar.architectures import modular
    from scripts.alphastar_building_placement_bridge_v1 import build_placement_bridge

    class Tap(modular.BatchedComponent):
        def __init__(self, stage, streams):
            super().__init__(name="diagnostic_tap_" + stage)
            self.stage, self.streams = stage, streams

        @property
        def input_spec(self):
            return types.SpecDict(self.streams)

        @property
        def output_spec(self):
            return types.SpecDict({("diagnostic", self.stage + "/" + ("/".join(key) if isinstance(key, tuple) else key)): spec
                                   for key, spec in self.streams.items()})

        def _forward(self, inputs):
            return types.StreamDict({("diagnostic", self.stage + "/" + ("/".join(key) if isinstance(key, tuple) else key)): inputs[key]
                                     for key in self.streams}), {}

    component, _ = build_placement_bridge(example, config, registry, is_training=training,
                                           sampling_mode="sample" if training else "greedy")
    return instrument_component(component, modular.SequentialComponent, Tap)


def spatial_support(encoded, frame, points):
    """Report tensor samples and neighborhoods, not native placement legality."""
    inputs = encoded["inputs"]
    result = {"map_size": frame["spatial"]["map_size"], "camera": frame["camera"],
              "camera_size": [frame["spatial"]["camera_width"], frame["spatial"]["camera_height"]], "points": {}}
    for label, point in points.items():
        x, y = point
        record = {}
        for key, value in inputs.items():
            if not isinstance(key, tuple) or key[0] != "observation":
                continue
            name = key[1]
            array = np.asarray(value)
            if name in ("camera", "planned_build_mask") or name.startswith("minimap_"):
                require(array.ndim == 2 and array.shape[0] == array.shape[1], "Unexpected spatial tensor")
                factor = 256 // array.shape[0]
                px, py = min(x // factor, array.shape[1] - 1), min(y // factor, array.shape[0] - 1)
                record[name] = {"shape": list(array.shape), "cell": [px, py], "value": array[py, px].item(),
                    "crop_origin": [max(0, px - 2), max(0, py - 2)],
                    "crop": array[max(0, py - 2):py + 3, max(0, px - 2):px + 3].tolist()}
        result["points"][label] = record
    return result


def competing_learning_processes(psutil):
    found = []
    for process in psutil.process_iter(["pid", "name", "cmdline", "create_time"]):
        if process.pid == os.getpid():
            continue
        argv = process.info.get("cmdline") or []
        scripts = [Path(token).name for token in argv if token.endswith(".py")]
        if any(name.startswith(("fit_alphastar_", "train_alphastar_", "serve_alphastar_")) for name in scripts):
            found.append({"pid": process.pid, "name": process.info["name"], "scripts": scripts,
                          "create_time": process.info["create_time"]})
    return found


def run(args):
    os.environ.setdefault("XLA_PYTHON_CLIENT_PREALLOCATE", "false")
    os.environ.setdefault("OMP_NUM_THREADS", "4")
    sys.dont_write_bytecode = True
    from scripts.infer_alphastar_checkpoint import read_checkpoint_artifacts, structured_prediction, verify_tree_schema
    from scripts.train_alphastar_replay import DEFAULT_UPSTREAM, sha256, train_rows, verify_upstream
    from scripts.preflight_alphastar_curriculum import host_path, identity
    from scripts.fit_alphastar_balanced import RunGuard, verify_adam_count
    from scripts.fit_alphastar_building_world import frozen_state_digest
    from scripts.alphastar_capacity_bridge import configure_capacity_runtime
    from scripts.alphastar_building_placement_bridge_v1 import build_placement_bridge, WORLD_INPUT, CLASSES_INPUT
    from scripts.alphastar_eligibility_bridge_v2 import FUNCTION_INPUT, SOURCES_INPUT
    from scripts.audit_alphastar_building_placement_v1 import compare_outputs
    from pluto_sc2.action_eligibility_v2 import build_action_eligibility
    from pluto_sc2.building_placement_v1 import build_placement_masks
    from pluto_sc2.alphastar_tensor import tensorize_observation, tensorize_sample, validate_supervised_masks
    import psutil

    output, origin, candidate, dataset = [Path(value).resolve() for value in (args.output, args.parent, args.candidate, args.dataset)]
    guard = RunGuard(600, [ROOT / "STOP", output / "STOP", origin / "STOP", candidate / "STOP", dataset / "STOP",
                           DEFAULT_UPSTREAM.parent.parent / "STOP"])
    guard.check("read-only world audit setup")
    require(not output.exists(), "Require new immutable diagnostic output")
    other = competing_learning_processes(psutil)
    require(not other, "Another learning or model-service process is active: " + str(other))
    output.mkdir(parents=True)
    state = {"schema": "fixed-frame-world-logit-diagnostic-v1", "status": "running", "started_unix": time.time(),
        "pid": os.getpid(), "pid_creation_time": psutil.Process().create_time(), "other_learning_processes": other,
        "optimizer_updates": 0, "checkpoint_writes": 0, "game_launches": 0, "model_promoted": False,
        "source_and_input_hashes": {}, "events": [], "graph_parity": [],
        "scope": "Five fixed TRAIN observations, teacher prefix and observation-only greedy prefix separated"}

    def save():
        temporary = output / "audit.json.pending"
        temporary.write_text(json.dumps(state, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        temporary.replace(output / "audit.json")

    def unchanged():
        require(all(sha256(path) == digest for path, digest in state["source_and_input_hashes"].items()), "Audit provenance changed")

    save()
    try:
        artifacts = read_checkpoint_artifacts(origin, dataset / "game-data.json")
        require(artifacts["checkpoint_sha256"] == PARENT_SHA and artifacts["result"]["optimizer_updates"] == 6089, "Wrong parent")
        result = json.loads((candidate / "result.json").read_text())
        recipe = json.loads((candidate / "reproduction-recipe.json").read_text())
        require(result["schema"] == "alphastar-building-world-candidate-v1" and result["checkpoint_sha256"] == CANDIDATE_SHA
                and result["optimizer_updates"] == 6153 and result["new_optimizer_updates"] == 64
                and result["frozen_parameters_and_moments_exact"] and result["checkpoint_restore_verified"]
                and recipe["result_sha256"] == sha256(candidate / "result.json")
                and recipe["checkpoint_sha256"] == CANDIDATE_SHA, "Wrong or incomplete world candidate")
        state["source_and_input_hashes"] = {str(host_path(path)): digest for path, digest in result["source_and_input_hashes"].items()}
        additional = (Path(__file__), origin / "checkpoint.msgpack", origin / "result.json", candidate / "checkpoint.msgpack",
            candidate / "result.json", candidate / "reproduction-recipe.json", dataset / "samples.jsonl.gz",
            ROOT / "scripts/audit_alphastar_building_placement_v1.py", ROOT / "scripts/fit_alphastar_building_world.py")
        for path in additional:
            digest = sha256(path)
            prior = state["source_and_input_hashes"].get(str(path))
            require(prior is None or prior == digest, "Source differs from candidate provenance")
            state["source_and_input_hashes"][str(path)] = digest
        require(sha256(candidate / "checkpoint.msgpack") == CANDIDATE_SHA, "Candidate checkpoint bytes changed")
        unchanged()
        wanted = {tuple(row) for row in artifacts["result"]["admitted_identities"]}
        rows = {identity(row): row for row in train_rows(dataset) if identity(row) in wanted and identity(row)[2] in ORDINALS}
        require(len(rows) == 5 and {key[2] for key in rows} == set(ORDINALS)
                and all(row["partition"] == "train" for row in rows.values()), "Five exact TRAIN targets required")
        state["upstream_manifest_sha256"], _ = verify_upstream(DEFAULT_UPSTREAM)
        sys.path.insert(0, str(DEFAULT_UPSTREAM))
        import jax
        import jax.numpy as jnp
        import haiku as hk
        from flax import serialization
        from alphastar import types
        configure_capacity_runtime(artifacts["result"])
        require(any(device.platform == "gpu" for device in jax.devices()), "Expected bounded GPU runtime")
        decoded = {"parent6089": serialization.msgpack_restore(artifacts["checkpoint"].read_bytes()),
                   "candidate6153": serialization.msgpack_restore((candidate / "checkpoint.msgpack").read_bytes())}
        verify_adam_count(decoded["parent6089"], 6089)
        verify_adam_count(decoded["candidate6153"], 6153)
        require(frozen_state_digest(decoded["parent6089"]) == frozen_state_digest(decoded["candidate6153"]), "Frozen state differs")
        require(decoded["parent6089"]["network_state"] == decoded["candidate6153"]["network_state"] == {}, "Nonempty state")
        state.update(checkpoints={"parent6089": PARENT_SHA, "candidate6153": CANDIDATE_SHA},
            frozen_state_equal=True, devices=[str(device) for device in jax.devices()])
        registry, config = artifacts["registry"], artifacts["config"]
        key = jax.random.PRNGKey(42)

        def encode(row, training):
            encoded = tensorize_sample(row, registry, artifacts["unit_types"], config) if training else tensorize_observation(
                row["frame"], registry, artifacts["unit_types"], config)
            eligibility = build_action_eligibility(row["frame"], encoded["metadata"]["entity_tags"], registry, artifacts["catalog"], max_entities=config.max_entities)
            placement = build_placement_masks(row["frame"], registry, artifacts["catalog"])
            encoded["inputs"].update({FUNCTION_INPUT: np.asarray(eligibility["function_mask"], bool),
                SOURCES_INPUT: np.asarray(eligibility["source_masks"], bool), WORLD_INPUT: np.asarray(placement["masks"], bool).reshape(3, 65536),
                CLASSES_INPUT: np.asarray(placement["function_classes"], np.int32)})
            return encoded

        expected_events = {"parent6089": {tuple(event["identity"]): event for event in json.loads(
            host_path(next(path for path in result["source_and_input_hashes"] if path.endswith("graph-audit-v1/audit.json"))).read_text())["events"]}}
        candidate_evaluation = next(item for item in reversed(result["evaluations"]) if item["new_updates"] == 64)
        expected_events["candidate6153"] = {(event["replay_id"], event["player_id"], event["action_ordinal"]): event for event in candidate_evaluation["events"]}
        for training in (True, False):
            mode = "teacher_prefix" if training else "observation_only_greedy"
            first = encode(next(iter(rows.values())), training)
            component = tapped_bridge(first, config, registry, training=training)
            stock, _ = build_placement_bridge(first, config, registry, is_training=training,
                                                sampling_mode="sample" if training else "greedy")
            require(component.input_spec == stock.input_spec, "Instrumentation altered input requirements")
            if not training:
                require(not any(isinstance(name, tuple) and name[0] == "behaviour_features" for name in component.input_spec), "Inference consumes labels")
            network, reference = [hk.transform_with_state(jax.vmap(item.unroll)) for item in (component, stock)]
            previous = jax.tree_util.tree_map(lambda spec: jnp.zeros((1,) + spec.shape, spec.dtype), component.prev_state_spec)

            def inputs_for(encoded):
                streams = types.StreamDict()
                for name, spec in component.input_spec.items():
                    spec.validate(encoded["inputs"][name])
                    streams[name] = jnp.asarray(encoded["inputs"][name])[None, None, ...]
                return streams

            expected, expected_state = jax.eval_shape(network.init, key, inputs_for(first), previous)
            for checkpoint in decoded.values():
                verify_tree_schema(expected, checkpoint["params"], "tapped params")
                verify_tree_schema(expected_state, checkpoint["network_state"], "tapped state")
            forward, plain = jax.jit(network.apply), jax.jit(reference.apply)
            for model, checkpoint in decoded.items():
                parameters = jax.tree_util.tree_map(jnp.asarray, checkpoint["params"])
                for row_id, row in rows.items():
                    guard.check("fixed-frame logits forward")
                    encoded = encode(row, training)
                    streams = inputs_for(encoded)
                    (tapped, _, _), next_state = forward(parameters, {}, key, streams, previous)
                    (original, _, _), original_state = plain(parameters, {}, key, streams, previous)
                    require(next_state == original_state == {}, "Instrumentation created mutable state")
                    tapped, original = jax.device_get((tapped, original))
                    parity = compare_outputs(original, tapped)
                    require(parity["passed"], "Taps changed model outputs")
                    state["graph_parity"].append({"model": model, "mode": mode, "identity": row_id, **parity})
                    if training:
                        validate_supervised_masks(tapped, encoded)
                    prediction = structured_prediction(tapped, registry, config)
                    require(prediction["mask_checks_passed"], "Prediction violates graph masks")
                    if not training:
                        require(prediction["prediction"] == expected_events[model][row_id]["prediction"], "Replay of exact model output changed")
                    # Expert data only enters this scoring branch for inference after its forward is finished.
                    labeled = tensorize_sample(row, registry, artifacts["unit_types"], config)
                    target = int(labeled["labels"]["world"])
                    arrays = {stage + "_" + kind: np.asarray(tapped["diagnostic", stage + "/" + kind + "/world"])[0, 0]
                              for stage in STAGES for kind in ("logits", "masks")}
                    metrics = {stage: distribution_metrics(arrays[stage + "_logits"], arrays[stage + "_masks"], target) for stage in STAGES}
                    transitions = {f"{left}_to_{right}": mask_transition(arrays[left + "_logits"], arrays[left + "_masks"],
                        arrays[right + "_logits"], arrays[right + "_masks"]) for left, right in zip(STAGES, STAGES[1:])}
                    if training:
                        require(all(item["target_allowed"] for item in metrics.values()), "Expert target was excluded")
                    points = {"expert": [target % 256, target // 256], "prediction": metrics["placement"]["argmax_cell"]}
                    visual = {}
                    for name in tapped:
                        if not isinstance(name, tuple) or not name[1].startswith("encoder_visual/"):
                            continue
                        tensor = np.asarray(tapped[name])[0, 0]
                        arrays[name[1].replace("/", "_")] = tensor
                        visual[name[1]] = {"shape": list(tensor.shape), "std": float(tensor.std()), "points": {
                            label: {"cell": [x * tensor.shape[1] // 256, y * tensor.shape[0] // 256],
                                    "features": tensor[y * tensor.shape[0] // 256, x * tensor.shape[1] // 256].tolist()}
                            for label, (x, y) in points.items()}}
                    filename = f"{row_id[2]}-{model}-{mode}.npz"
                    np.savez_compressed(output / filename, **arrays)
                    event = {"identity": row_id, "model": model, "mode": mode, "frame_sha256": digest_json(row["frame"]),
                        "intent_sha256": digest_json(row["intent"]), "prediction": prediction["prediction"],
                        "expert_function": labeled["metadata"]["function"],
                        "function_prefix_matches_expert": prediction["prediction"]["function"] == int(labeled["labels"]["function"]),
                        "distributions": metrics, "mask_transitions": transitions, "spatial_support": spatial_support(encoded, row["frame"], points),
                        "encoder_visual": visual, "arrays": filename, "arrays_sha256": sha256(output / filename)}
                    state["events"].append(event)
                    save()
                    print(json.dumps({"ordinal": row_id[2], "mode": mode, "model": model,
                        "rank": metrics["placement"]["target_rank_strict"], "ce": metrics["placement"]["target_ce_nats"]}), flush=True)
        require(len(state["events"]) == len(state["graph_parity"]) == 20, "Incomplete experiment")
        state["status"] = "passed"
    except BaseException as error:
        state.update(status="failed", error=f"{type(error).__name__}: {error}", traceback=traceback.format_exc())
        raise
    finally:
        unchanged()
        state.update(source_inputs_checkpoints_unchanged=True, finished_unix=time.time(), wall_seconds=time.time() - state["started_unix"])
        save()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("parent", "candidate", "dataset", "output"):
        parser.add_argument("--" + name, required=True)
    run(parser.parse_args())
