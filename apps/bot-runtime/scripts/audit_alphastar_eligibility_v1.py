"""Read-only actual-checkpoint proof of the opt-in eligibility graph.

Proves all-eligible parameter/loss/gradient parity, then evaluates actual
observation-only masks against immutable TRAIN observations. Never optimizes,
recaptures, launches SC2, edits parent artifacts or promotes a model.
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
from scripts.alphastar_capacity_bridge import build_capacity_bridge, configure_capacity_runtime  # noqa: E402
from scripts.alphastar_eligibility_bridge_v1 import (  # noqa: E402
    ELIGIBILITY_ADAPTER, FUNCTION_INPUT, SOURCES_INPUT, build_eligibility_bridge,
)
from scripts.alphastar_source_objective import gradient_comparison, make_source_objective  # noqa: E402
from scripts.fit_alphastar_balanced import RunGuard, verify_adam_count  # noqa: E402
from scripts.infer_alphastar_checkpoint import (  # noqa: E402
    read_checkpoint_artifacts, score_after_prediction, structured_prediction, verify_tree_schema,
)
from scripts.preflight_action_eligibility_v1 import PREFERRED_SHA  # noqa: E402
from scripts.preflight_alphastar_curriculum import identity  # noqa: E402
from scripts.train_alphastar_replay import (  # noqa: E402
    DEFAULT_UPSTREAM, HEADS, TensorError, read_dataset, runtime_registry, sha256, train_rows, verify_upstream,
)
from pluto_sc2.action_eligibility_v1 import build_action_eligibility  # noqa: E402
from pluto_sc2.alphastar_tensor import tensorize_observation, tensorize_sample, validate_supervised_masks  # noqa: E402


def add_eligibility(example, config, registry, masks=None):
    result = {**example, "inputs": dict(example["inputs"])}
    result["inputs"][FUNCTION_INPUT] = (np.ones(len(registry), bool) if masks is None
                                           else np.asarray(masks["function_mask"], bool))
    result["inputs"][SOURCES_INPUT] = (np.ones((len(registry), config.max_entities), bool) if masks is None
                                          else np.asarray(masks["source_masks"], bool))
    return result


def compare_outputs(left, right):
    checks = {}
    for kind in ("logits", "masks", "action", "argument_masks"):
        for head in HEADS:
            key = kind, head
            if key not in left and key not in right:
                continue
            if key not in left or key not in right:
                raise TensorError("Graph output vocabulary differs")
            a, b = np.asarray(left[key]), np.asarray(right[key])
            same = (a.shape == b.shape and a.dtype == b.dtype and
                    (np.allclose(a, b, rtol=2e-6, atol=1e-6) if kind == "logits" else np.array_equal(a, b)))
            checks["/".join(key)] = bool(same)
    return {"passed": all(checks.values()), "checks": checks}


def run(args):
    os.environ.setdefault("XLA_PYTHON_CLIENT_PREALLOCATE", "false")
    os.environ.setdefault("OMP_NUM_THREADS", "4")
    sys.dont_write_bytecode = True
    output, origin, dataset, preflight_path = map(lambda value: Path(value).resolve(),
                                                 (args.output, args.run, args.dataset, args.preflight))
    if output.exists():
        raise TensorError("New immutable audit output required")
    guard = RunGuard(args.wall_seconds, [ROOT / "STOP", output / "STOP", origin / "STOP", dataset / "STOP",
                                         preflight_path.parent / "STOP", Path(args.upstream).resolve().parent.parent / "STOP"])
    guard.check("eligibility checkpoint audit")
    output.mkdir(parents=True, exist_ok=False)
    state = {"schema": "alphastar-eligibility-graph-audit-v1", "status": "running",
             "adapter": ELIGIBILITY_ADAPTER, "started_unix": time.time(), "pid": os.getpid(),
             "optimizer_updates": 0, "checkpoint_writes": 0, "game_launches": 0,
             "model_promoted": False, "eligible_for_training": False, "strength_evidence": False,
             "source_and_input_hashes": {}, "parity": [], "events": [],
             "scope": "Single-PvT sameTRAIN mask diagnostics; not native execution or generalization"}

    def save():
        temp = output / "audit.json.pending"
        temp.write_text(json.dumps(state, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        temp.replace(output / "audit.json")

    save()
    try:
        import psutil
        state["pid_creation_time"] = psutil.Process().create_time()
        artifacts = read_checkpoint_artifacts(origin, dataset / "game-data.json")
        if artifacts["checkpoint_sha256"] != PREFERRED_SHA or artifacts["result"]["optimizer_updates"] != 6089:
            raise TensorError("Exact preferred6089 checkpoint required")
        preflight = json.loads(preflight_path.read_text(encoding="utf-8"))
        if (preflight.get("schema") != "action-eligibility1201-cpu-preflight-v1"
                or preflight.get("checkpoint_sha256") != PREFERRED_SHA
                or preflight["status"] not in ("label_contract_passed", "label_conflicts_require_review")
                or preflight["rows_checked"] != 1201 or not preflight["source_inputs_unchanged"]):
            raise TensorError("Require complete unchanged CPU1201 preflight")
        for path, digest in preflight["source_and_input_hashes"].items():
            if path.startswith("C:\\") or path.startswith("C:/"):
                path = "/mnt/c/" + path[3:].replace("\\", "/")
            if sha256(path) != digest:
                raise TensorError("CPU-preflight provenance changed")
            state["source_and_input_hashes"][path] = digest
        for path in (Path(__file__), ROOT / "scripts/alphastar_eligibility_bridge_v1.py",
                     ROOT / "scripts/alphastar_capacity_bridge.py", ROOT / "scripts/alphastar_source_objective.py",
                     ROOT / "scripts/fit_alphastar_balanced.py", preflight_path):
            state["source_and_input_hashes"][str(path)] = sha256(path)
        original_sources = {Path(path).name: digest for path, digest in artifacts["result"]["source_hashes"].items()}
        for path, digest in state["source_and_input_hashes"].items():
            if Path(path).name in original_sources and original_sources[Path(path).name] != digest:
                raise TensorError("Shared frozen implementation differs from6089 provenance")
        _, _, hashes, _ = read_dataset(dataset)
        if hashes != artifacts["result"]["dataset_hashes"]:
            raise TensorError("Dataset hashes changed")
        wanted = {tuple(row) for row in artifacts["result"]["admitted_identities"]}
        rows = [row for row in train_rows(dataset) if identity(row) in wanted]
        if len(rows) != 1201 or {identity(row) for row in rows} != wanted:
            raise TensorError("Require exact original1201 rows")
        quarantined = {tuple(row["identity"]) for row in preflight["quarantine_candidates"]}
        if ({tuple(row["identity"]) for row in preflight["records"]} != wanted
                or len(preflight["records"]) != len(wanted) or not quarantined <= wanted
                or len(quarantined) != preflight["teacher_labels_rejected"]):
            raise TensorError("Preflight record/quarantine identity set differs")
        state["quarantine_identities"] = [list(row) for row in sorted(quarantined)]
        probes = [next(row for row in rows if len(row["intent"].get("source_tags", [])) == size)
                  for size in (1, 0)]
        probes.insert(1, next(row for row in rows if 2 <= len(row["intent"].get("source_tags", [])) < 16))
        state["upstream_manifest_sha256"], _ = verify_upstream(args.upstream)
        sys.path.insert(0, str(Path(args.upstream).resolve()))
        import haiku as hk
        import jax
        import jax.numpy as jnp
        from flax import serialization
        from alphastar import types
        configure_capacity_runtime(artifacts["result"])
        registry, config = artifacts["registry"], artifacts["config"]
        if runtime_registry(artifacts["catalog"]) != (registry, artifacts["unit_types"]):
            raise TensorError("Official vocabulary differs")
        checkpoint_bytes = artifacts["checkpoint"].read_bytes()
        if hashlib.sha256(checkpoint_bytes).hexdigest() != PREFERRED_SHA:
            raise TensorError("Checkpoint changed before exact decode")
        decoded = serialization.msgpack_restore(checkpoint_bytes)
        verify_adam_count(decoded, 6089)
        parameters = jax.tree_util.tree_map(jnp.asarray, decoded["params"])
        network_state = jax.tree_util.tree_map(jnp.asarray, decoded["network_state"])
        key = jax.random.PRNGKey(42)
        state.update(devices=[str(device) for device in jax.devices()], checkpoint_sha256=PREFERRED_SHA,
                     parameter_count=artifacts["result"]["parameter_count"], adam_count_verified=6089)

        def graph(eligible, training):
            example = (tensorize_sample(probes[0], registry, artifacts["unit_types"], config) if training else
                       tensorize_observation(probes[0]["frame"], registry, artifacts["unit_types"], config))
            example = add_eligibility(example, config, registry) if eligible else example
            builder = build_eligibility_bridge if eligible else build_capacity_bridge
            component, action_spec = builder(example, config, registry, is_training=training,
                                             sampling_mode="sample" if training else "greedy")
            if not training and any(isinstance(name, tuple) and name[0] == "behaviour_features" for name in component.input_spec):
                raise TensorError("Inference graph requires expert behavior")
            network = hk.transform_with_state(jax.vmap(component.unroll))
            previous = jax.tree_util.tree_map(lambda spec: jnp.zeros((1,) + spec.shape, spec.dtype), component.prev_state_spec)

            def inputs_for(encoded):
                inputs = types.StreamDict()
                for name, spec in component.input_spec.items():
                    spec.validate(encoded["inputs"][name])
                    inputs[name] = jnp.asarray(encoded["inputs"][name])[None, None, ...]
                return inputs

            expected, expected_state = jax.eval_shape(network.init, key, inputs_for(example), previous)
            leaves, size = verify_tree_schema(expected, decoded["params"], "params")
            verify_tree_schema(expected_state, decoded["network_state"], "network_state")
            if size != state["parameter_count"]:
                raise TensorError("Parameter count changed")
            state.setdefault("graph_schemas", []).append({"eligibility": eligible, "training": training,
                                                         "leaves": leaves, "parameters": size})
            forward = jax.jit(network.apply)
            objective = make_source_objective(action_spec)

            def loss(params, inputs):
                (predictions, _, _), _ = network.apply(params, network_state, key, inputs, previous)
                loss_inputs = predictions.copy()
                loss_inputs["step_type"] = inputs["step_type"]
                values, _ = objective.batched_loss(loss_inputs)
                return jnp.mean(values)

            differentiate = jax.jit(jax.value_and_grad(loss)) if training else None

            def evaluate(encoded, gradient=False):
                guard.check("actual eligibility graph call")
                inputs = inputs_for(encoded)
                (predictions, _, _), next_state = jax.device_get(forward(parameters, network_state, key, inputs, previous))
                verify_tree_schema(decoded["network_state"], next_state, "next_state")
                values = jax.device_get(differentiate(parameters, inputs)) if gradient else None
                guard.check("eligibility graph call completion")
                return predictions, values

            return evaluate

        legacy_train, new_train = graph(False, True), graph(True, True)
        legacy_infer, new_infer = graph(False, False), graph(True, False)
        save()
        for row in probes:
            teacher = tensorize_sample(row, registry, artifacts["unit_types"], config)
            a, (a_loss, a_gradient) = legacy_train(teacher, True)
            b, (b_loss, b_gradient) = new_train(add_eligibility(teacher, config, registry), True)
            validate_supervised_masks(a, teacher)
            validate_supervised_masks(b, teacher)
            observation = tensorize_observation(row["frame"], registry, artifacts["unit_types"], config)
            c, _ = legacy_infer(observation)
            d, _ = new_infer(add_eligibility(observation, config, registry))
            comparison = gradient_comparison(a_gradient, b_gradient, rtol=2e-6, atol=1e-6)
            proof = {"identity": identity(row), "training_outputs": compare_outputs(a, b),
                     "inference_outputs": compare_outputs(c, d), "gradient": comparison,
                     "loss_exact": bool(np.isclose(a_loss, b_loss, rtol=2e-6, atol=1e-6))}
            proof["passed"] = (proof["training_outputs"]["passed"] and proof["inference_outputs"]["passed"]
                               and proof["loss_exact"] and comparison["passed"])
            state["parity"].append(proof)
            save()
            if not proof["passed"]:
                raise TensorError("All-eligible graph failed strict parity")
        for row in rows:
            observation = tensorize_observation(row["frame"], registry, artifacts["unit_types"], config)
            eligibility = build_action_eligibility(row["frame"], observation["metadata"]["entity_tags"],
                                                  registry, artifacts["catalog"], max_entities=config.max_entities)
            outputs, _ = new_infer(add_eligibility(observation, config, registry, eligibility))
            prediction = structured_prediction(outputs, registry, config)
            prediction["identity"] = list(identity(row))
            prediction["score"] = score_after_prediction(prediction["prediction"], row, registry, artifacts["unit_types"], config)
            prediction["teacher_quarantined"] = identity(row) in quarantined
            if not prediction["teacher_quarantined"]:
                teacher = tensorize_sample(row, registry, artifacts["unit_types"], config)
                teacher_outputs, _ = new_train(add_eligibility(teacher, config, registry, eligibility))
                validate_supervised_masks(teacher_outputs, teacher)
                prediction["teacher_graph_masks_passed"] = True
            else:
                prediction["teacher_graph_masks_passed"] = False
            state["events"].append(prediction)
            if len(state["events"]) % 128 == 0:
                save()
                print(json.dumps({"rows": len(state["events"]), "quarantined": len(quarantined)}), flush=True)
        state.update(status="passed", actual_model_forward_executed=True, all_eligible_gradient_parity=True,
                     inference_rows=len(state["events"]), teacher_graph_rows=len(rows) - len(quarantined),
                     inference_mask_passes=sum(row["mask_checks_passed"] for row in state["events"]),
                     function_exact=sum(row["score"]["metrics"]["function_exact"] for row in state["events"]),
                     complete_action_exact=sum(row["mask_checks_passed"] and all(row["score"]["metrics"].values())
                                               for row in state["events"]))
    except BaseException as error:
        state.update(status="failed", error=f"{type(error).__name__}: {error}", traceback=traceback.format_exc())
        raise
    finally:
        changed = [path for path, digest in state["source_and_input_hashes"].items() if sha256(path) != digest]
        state.update(source_inputs_checkpoint_unchanged=not changed, changed_inputs=changed,
                     finished_unix=time.time(), wall_seconds=time.time() - state["started_unix"])
        if changed:
            state["status"] = "failed"
        save()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--preflight", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--upstream", type=Path, default=DEFAULT_UPSTREAM)
    parser.add_argument("--wall-seconds", type=float, default=900)
    run(parser.parse_args())


if __name__ == "__main__":
    main()
