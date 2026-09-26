"""CPU-only actual restored-network proof for source normalization16-v1.

No training, optimizer construction, checkpoint copy, game client or promotion.
The strongest identity is corrected=4*legacy on the SAME512 graph. Old128/16
versus512/64 is separately measured against the existing strict parity margin.
"""
from __future__ import annotations

import argparse
from dataclasses import asdict
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

from scripts.alphastar_source_objective import (  # noqa: E402
    SOURCE_OBJECTIVE, gradient_comparison, make_source_objective, objective_contract, source_loss_reference,
)
from scripts.alphastar_capacity_bridge import (  # noqa: E402
    CAPACITY_ADAPTER, CAPACITY_MATMUL_PRECISION, build_capacity_bridge, configure_capacity_runtime,
)
from scripts.migrate_alphastar_capacity import (  # noqa: E402
    DATASET_HASHES, NEW_CONFIG, OLD_CONFIG, SOURCE_SHA256, SOURCE_UPDATES, verify_observation_expansion,
)
from scripts.train_alphastar_replay import (  # noqa: E402
    DEFAULT_UPSTREAM, HEADS, TensorError, read_dataset, runtime_registry, sha256, train_rows, verify_upstream,
)
from scripts.infer_alphastar_checkpoint import read_checkpoint_artifacts, verify_tree_schema  # noqa: E402
from scripts.fit_alphastar_balanced import RunGuard, verify_adam_count, verify_resume_recipe  # noqa: E402
from scripts.preflight_alphastar_curriculum import identity, label_fingerprint, observation_fingerprint  # noqa: E402
from pluto_sc2.alphastar_tensor import tensorize_observation, tensorize_sample, validate_supervised_masks  # noqa: E402


def select_probe_rows(rows, anchors, original_ids, limit):
    """Retained one-source, multisource and inactive examples, then anchors."""
    if type(limit) is not int or not 3 <= limit <= 25:
        raise TensorError("CPU proof requires3..25 bounded retained frames")
    anchor_set, original_set = set(anchors), set(original_ids)
    found, multi = {}, None
    for row in rows:
        row_id = identity(row)
        if row_id not in original_set:
            continue
        if row.get("partition") != "train":
            raise TensorError("Only original admitted TRAIN rows may enter the gradient proof")
        count = len(row.get("intent", {}).get("source_tags", []))
        if row_id in anchor_set:
            found[row_id] = row
        if 2 <= count < 16 and (multi is None or count > len(multi["intent"]["source_tags"])):
            multi = row
    if set(found) != anchor_set:
        raise TensorError("Original anchor observations missing from frozen dataset")
    source = next((found[key] for key in anchors if len(found[key]["intent"].get("source_tags", [])) == 1), None)
    inactive = next((found[key] for key in anchors if not found[key]["intent"].get("source_tags")), None)
    if source is None or inactive is None or multi is None:
        raise TensorError("Proof requires retained one-source, multisource and inactive observations")
    selected, seen = [], set()
    for row in [source, multi, inactive, *(found[key] for key in anchors)]:
        row_id = identity(row)
        if row_id not in seen and len(selected) < limit:
            selected.append(row)
            seen.add(row_id)
    return selected


def source_output_proof(outputs, example, config):
    validate_supervised_masks(outputs, example)
    logits = np.asarray(outputs["logits", "unit_tags"])[0, 0]
    masks = np.asarray(outputs["masks", "unit_tags"])[0, 0]
    labels = np.asarray(example["labels"]["unit_tags"])
    active = bool(example["active_heads"]["unit_tags"])
    reference = source_loss_reference(logits, labels, masks, active=active)
    eos = config.max_entities
    first = np.flatnonzero(labels == eos)
    if active and not len(first):
        raise TensorError("Selected proof row lacks a first EOS inside its capacity")
    count = int(first[0]) if len(first) else len(labels)
    if active and (count < 1 or not np.all(labels[count:] == eos)
                   or not np.all(masks[count + 1:, eos])
                   or np.any(masks[count + 1:, :eos])):
        raise TensorError("Actual official source masks do not enforce EOS-only padding")
    if active and (np.any(reference["token_loss"][count + 1:] != 0)
                   or np.any(reference["corrected_gradient"][count + 1:] != 0)):
        raise TensorError("Post-EOS padding unexpectedly has a loss or logit gradient")
    return {"active": active, "source_count": count if active else 0,
            "meaningful_slots_including_first_eos": count + 1 if active else 0,
            "legacy_loss_reference": reference["legacy_loss"],
            "corrected_loss_reference": reference["corrected_loss"],
            "post_eos_loss_and_gradient_zero": True}


def run(args):
    # Must run in a fresh process; never silently initialize a GPU backend.
    os.environ["JAX_PLATFORMS"] = "cpu"
    os.environ["JAX_PLATFORM_NAME"] = "cpu"
    os.environ.setdefault("OMP_NUM_THREADS", "4")
    os.environ.setdefault("XLA_PYTHON_CLIENT_PREALLOCATE", "false")
    sys.dont_write_bytecode = True
    output, origin, dataset, preflight_path = map(lambda path: Path(path).resolve(),
                                               (args.output, args.run, args.dataset, args.capacity_preflight))
    if output.exists():
        raise TensorError("Objective audit requires a new output directory")
    guard = RunGuard(args.wall_seconds, [ROOT / "STOP", output / "STOP", origin / "STOP", dataset / "STOP"])
    guard.check("CPU source-objective proof")
    output.mkdir(parents=True, exist_ok=False)
    state = {"schema": "alphastar-source-objective-gradient-audit-v1", "status": "running",
             "objective_id": SOURCE_OBJECTIVE,
             "objective": objective_contract(64), "started_unix": time.time(), "pid": os.getpid(),
             "optimizer_updates": 0, "checkpoint_writes": 0, "game_launches": 0,
             "eligible_for_training": False, "model_promoted": False, "strength_evidence": False,
             "scope": "Retained TRAIN gradient mathematics, not learning, opening execution or spatial repair",
             "records": [], "source_and_input_hashes": {}, "wall_budget_seconds": args.wall_seconds,
             "deadline_semantics": "Checked around numerical calls; compilation is not interruptible in-flight"}

    def save():
        temporary = output / "audit.json.pending"
        temporary.write_text(json.dumps(state, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        temporary.replace(output / "audit.json")

    save()
    try:
        artifacts = read_checkpoint_artifacts(origin, dataset / "game-data.json")
        recipe = json.loads((origin / "reproduction-recipe.json").read_text())
        verify_resume_recipe(artifacts, recipe)
        if artifacts["checkpoint_sha256"] != SOURCE_SHA256 or artifacts["result"]["optimizer_updates"] != SOURCE_UPDATES:
            raise TensorError("Cross-capacity proof requires the exact4041-update checkpoint")
        _, _, hashes, counts = read_dataset(dataset)
        if hashes != DATASET_HASHES or dict(counts) != {"train": 1217}:
            raise TensorError("The reviewed full replay dataset changed")
        preflight = json.loads(preflight_path.read_text())
        if (preflight.get("status") != "passed" or preflight.get("checkpoint_sha256") != SOURCE_SHA256
                or preflight.get("dataset_hashes") != DATASET_HASHES
                or preflight.get("mask_verified_rows") != 1201
                or preflight.get("tensor_config") != asdict(NEW_CONFIG)
                or preflight.get("old_tensor_config") != asdict(OLD_CONFIG)
                or preflight.get("observation_parity_verified") is not True
                or len(preflight.get("parity_records", [])) != 24
                or not all(row.get("canonical_prediction_exact") is True for row in preflight["parity_records"])):
            raise TensorError("Requires the passed immutable capacity/observation proof")
        anchors = [tuple(key) for key in artifacts["result"]["original_anchor_identities"]]
        original_ids = [tuple(key) for key in artifacts["result"]["admitted_identities"]]
        rows = select_probe_rows(train_rows(dataset), anchors, original_ids, args.frames)
        paths = [origin / name for name in ("checkpoint.msgpack", "result.json", "registry.json", "reproduction-recipe.json")]
        paths += [dataset / name for name in ("manifest.json", "samples.jsonl.gz", "game-data.json")]
        paths += [preflight_path, Path(__file__), ROOT / "scripts/alphastar_source_objective.py",
                  ROOT / "scripts/alphastar_capacity_bridge.py", ROOT / "scripts/train_alphastar_replay.py",
                  ROOT / "scripts/infer_alphastar_checkpoint.py", ROOT / "scripts/migrate_alphastar_capacity.py",
                  ROOT / "src/pluto_sc2/alphastar_tensor.py"]
        state["source_and_input_hashes"] = {str(path): sha256(path) for path in paths}
        state.update(checkpoint_sha256=SOURCE_SHA256, checkpoint_optimizer_updates=SOURCE_UPDATES,
                     dataset_hashes=hashes, selected_identities=[identity(row) for row in rows],
                     selected_frames=len(rows), original_anchor_frames=sum(identity(row) in anchors for row in rows))
        state["upstream_manifest_sha256"], state["upstream_files"] = verify_upstream(args.upstream)
        save()
        sys.path.insert(0, str(Path(args.upstream).resolve()))
        import jax
        import jax.numpy as jnp
        import haiku as hk
        from flax import serialization
        from alphastar import types
        from alphastar.unplugged.losses.supervised import Supervised
        if any(device.platform != "cpu" for device in jax.devices()):
            raise TensorError("Objective proof is CPU-only; a GPU backend must never run")
        configure_capacity_runtime({"capacity_adapter": CAPACITY_ADAPTER, "matmul_precision": CAPACITY_MATMUL_PRECISION})
        state.update(devices=[str(device) for device in jax.devices()],
                     matmul_precision=jax.config.jax_default_matmul_precision)
        registry, mapping = artifacts["registry"], artifacts["unit_types"]
        if runtime_registry(artifacts["catalog"]) != (registry, mapping):
            raise TensorError("Official registry or unit type mapping changed")
        decoded = serialization.msgpack_restore(artifacts["checkpoint"].read_bytes())
        verify_adam_count(decoded, SOURCE_UPDATES)
        parameters = jax.tree_util.tree_map(jnp.asarray, decoded["params"])
        model_state = jax.tree_util.tree_map(jnp.asarray, decoded["network_state"])
        key = jax.random.PRNGKey(recipe["seed"])

        def graph(config):
            example = tensorize_sample(rows[0], registry, mapping, config)
            component, action_spec = build_capacity_bridge(example, config, registry, is_training=True)
            network = hk.transform_with_state(jax.vmap(component.unroll))
            previous = jax.tree_util.tree_map(lambda spec: jnp.zeros((1,) + spec.shape, spec.dtype), component.prev_state_spec)

            def inputs_for(encoded):
                inputs = types.StreamDict()
                for name, spec in component.input_spec.items():
                    spec.validate(encoded["inputs"][name])
                    inputs[name] = jnp.asarray(encoded["inputs"][name])[None, None, ...]
                return inputs

            expected_params, expected_state = jax.eval_shape(network.init, key, inputs_for(example), previous)
            leaves, count = verify_tree_schema(expected_params, decoded["params"], "params")
            verify_tree_schema(expected_state, decoded["network_state"], "state")
            if count != artifacts["result"]["parameter_count"]:
                raise TensorError("Actual graph parameter count changed")
            state.setdefault("graph_schema", []).append({"config": asdict(config), "parameter_count": count,
                                                        "leaves": leaves, "fresh_parameter_initialization": False})
            legacy = Supervised(action_spec=action_spec, weights={head: float(head == "unit_tags") for head in HEADS},
                                burnin_len=0, overlap_len=0)
            corrected = make_source_objective(action_spec, source_only=True)

            def objective(params, inputs, use_corrected):
                (predictions, _, _), next_state = network.apply(params, model_state, key, inputs, previous)
                loss_inputs = predictions.copy()
                loss_inputs["step_type"] = inputs["step_type"]
                a, _ = legacy.batched_loss(loss_inputs)
                b, _ = corrected.batched_loss(loss_inputs)
                return jnp.mean(jnp.where(use_corrected, b, a)), (predictions, next_state)

            differentiate = jax.jit(jax.value_and_grad(objective, has_aux=True))

            def evaluate(encoded, corrected):
                guard.check("actual CPU parameter gradient")
                (value, (predictions, next_state)), gradient = jax.device_get(
                    differentiate(parameters, inputs_for(encoded), jnp.asarray(corrected)))
                verify_tree_schema(decoded["network_state"], next_state, "next_state")
                guard.check("actual CPU gradient completion")
                return float(value), predictions, gradient
            return evaluate

        old_graph, new_graph = graph(OLD_CONFIG), graph(NEW_CONFIG)
        save()
        for row in rows:
            guard.check("next retained observation")
            old_observation = tensorize_observation(row["frame"], registry, mapping, OLD_CONFIG)
            new_observation = tensorize_observation(row["frame"], registry, mapping, NEW_CONFIG)
            verify_observation_expansion(old_observation, new_observation)
            old_example = tensorize_sample(row, registry, mapping, OLD_CONFIG)
            new_example = tensorize_sample(row, registry, mapping, NEW_CONFIG)
            a, old_outputs, old_gradient = old_graph(old_example, False)
            b, legacy_outputs, legacy_gradient = new_graph(new_example, False)
            c, corrected_outputs, corrected_gradient = new_graph(new_example, True)
            old_proof = source_output_proof(old_outputs, old_example, OLD_CONFIG)
            new_proof = source_output_proof(legacy_outputs, new_example, NEW_CONFIG)
            source_output_proof(corrected_outputs, new_example, NEW_CONFIG)
            cross = gradient_comparison(old_gradient, corrected_gradient)
            same = gradient_comparison(jax.tree_util.tree_map(lambda value: value * 4, legacy_gradient),
                                       corrected_gradient, rtol=2e-6, atol=1e-6)
            record = {"identity": identity(row), "function": new_example["metadata"]["function"]["name"],
                      "old_observation_sha256": observation_fingerprint(old_observation),
                      "new_observation_sha256": observation_fingerprint(new_observation),
                      "new_label_sha256": label_fingerprint(new_example), "old_source_proof": old_proof,
                      "new_source_proof": new_proof, "legacy16_loss": a, "legacy64_loss": b, "corrected64_loss": c,
                      "cross_capacity_loss_parity": bool(np.isclose(a, c, rtol=2e-5, atol=2e-4)),
                      "same_graph_loss_factor4": bool(np.isclose(4 * b, c, rtol=2e-6, atol=1e-6)),
                      "old_loss_reference_matches": bool(np.isclose(a, old_proof["legacy_loss_reference"], rtol=2e-5, atol=2e-4)),
                      "new_loss_reference_matches": bool(np.isclose(c, new_proof["corrected_loss_reference"], rtol=2e-5, atol=2e-4)),
                      "cross_capacity_gradient": cross, "same512_graph_gradient_factor4": same}
            if not old_proof["active"]:
                record["inactive_loss_and_gradient_zero"] = a == b == c == 0 and cross["reference_l2"] == same["reference_l2"] == 0
            else:
                record["active_gradient_nonzero"] = cross["reference_l2"] > 0 and same["reference_l2"] > 0
            record["passed"] = all(record[name] for name in ("cross_capacity_loss_parity", "same_graph_loss_factor4",
                "old_loss_reference_matches", "new_loss_reference_matches")) and cross["passed"] and same["passed"] and (
                record.get("inactive_loss_and_gradient_zero", record.get("active_gradient_nonzero")))
            state["records"].append(record)
            save()
            print(json.dumps({"identity": identity(row), "passed": record["passed"],
                              "gradient_max_error": cross["max_abs_error"]}), flush=True)
            if not record["passed"]:
                raise TensorError("Source gradient audit failed strict measured parity; no tolerance relaxation")
        state.update(status="passed", normalization_gradient_proof=True,
                     pending_learning_gates=["Exact5065 parameter/Adam continuation", "Same unweighted1201/679/24/29 evaluation",
                         "Production/opening and camera retention", "Attack source recall/count and EOS improvement",
                         "No spatial or unit-target regression", "Independent64-frame reload", "Separate native opening test"])
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
    parser.add_argument("--capacity-preflight", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--upstream", type=Path, default=DEFAULT_UPSTREAM)
    parser.add_argument("--frames", type=int, default=3)
    parser.add_argument("--wall-seconds", type=float, default=900)
    run(parser.parse_args())


if __name__ == "__main__":
    main()
