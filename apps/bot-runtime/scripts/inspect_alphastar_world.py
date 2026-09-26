"""Read-only world-head numerical audit of an immutable replay diagnostic.

Reconstructs initialization, restores weights, and differentiates world-only
losses. Contains no optimizer update, game action or checkpoint write.
"""
from __future__ import annotations

import argparse
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
from scripts.train_alphastar_replay import (  # noqa: E402
    DEFAULT_UPSTREAM, HEADS, TensorConfig, build_official_bridge, read_dataset,
    sha256, teacher_forced_metrics, tensorize_sample, train_rows, verify_upstream,
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    os.environ["XLA_PYTHON_CLIENT_PREALLOCATE"] = "false"
    os.environ.setdefault("JAX_COMPILATION_CACHE_DIR", str(Path.home() / ".cache/sc2-alphastar-v1/jax"))
    sys.dont_write_bytecode = True
    if args.output.exists():
        raise ValueError("Audit output must be new")
    args.output.mkdir(parents=True)
    state = {"status": "running", "started_unix": time.time(), "pid": os.getpid(),
             "optimizer_updates": 0, "checkpoint_writes": 0, "game_launches": 0}

    def save():
        (args.output / "review.json").write_text(json.dumps(state, indent=2, allow_nan=False) + "\n")

    try:
        previous = json.loads((args.run / "result.json").read_text())
        if previous["status"] != "passed" or not previous["checkpoint_restore_verified"]:
            raise ValueError("Requires a successful restored checkpoint")
        checkpoint_hash = sha256(args.run / "checkpoint.msgpack")
        if checkpoint_hash != previous["checkpoint_sha256"]:
            raise ValueError("Checkpoint hash mismatch")
        for source, digest in previous["source_hashes"].items():
            if sha256(source) != digest:
                raise ValueError("Replay bridge source changed")
        verify_upstream(DEFAULT_UPSTREAM)
        _, _, hashes, _ = read_dataset(args.dataset)
        if hashes != previous["dataset_hashes"]:
            raise ValueError("Dataset differs from trained input")
        state.update(checkpoint_sha256=checkpoint_hash, source_result_sha256=sha256(args.run / "result.json"))
        registry_data = json.loads((args.run / "registry.json").read_text())
        registry = registry_data["functions"]
        mapping = {int(k): v for k, v in registry_data["unit_types"].items()}
        config = TensorConfig(**previous["tensor_config"])
        identities = [(row["replay_id"], row["player_id"], row["action_ordinal"]) for row in previous["mask_proofs"]]
        wanted = set(identities)
        encoded = {}
        for row in train_rows(args.dataset):
            identity = row["replay_id"], row["player_id"], row["action_ordinal"]
            if identity in wanted:
                encoded[identity] = tensorize_sample(row, registry, mapping, config)
        examples = [encoded[key] for key in identities]
        sys.path.insert(0, str(DEFAULT_UPSTREAM))
        import jax
        import jax.numpy as jnp
        import haiku as hk
        import optax
        from flax import serialization
        from alphastar import types
        from alphastar.unplugged.losses.supervised import Supervised
        state["devices"] = [str(device) for device in jax.devices()]
        component, action_spec = build_official_bridge(examples[0], config, registry)
        network = hk.transform_with_state(jax.vmap(component.unroll))
        prior = jax.tree_util.tree_map(lambda spec: jnp.zeros((1,) + spec.shape, spec.dtype), component.prev_state_spec)

        def inputs_for(example):
            inputs = types.StreamDict()
            for key, spec in component.input_spec.items():
                value = example["inputs"][key]
                spec.validate(value)
                inputs[key] = jnp.asarray(value)[None, None, ...]
            return inputs

        key = jax.random.PRNGKey(42)
        initial, initial_state = jax.jit(network.init)(key, inputs_for(examples[0]), prior)
        template = {"params": jax.device_get(initial), "network_state": jax.device_get(initial_state),
                    "optimizer_state": jax.device_get(optax.adam(1e-4).init(initial)), "optimizer_updates": 0}
        restored = serialization.from_bytes(template, (args.run / "checkpoint.msgpack").read_bytes())
        final = jax.tree_util.tree_map(jnp.asarray, restored["params"])
        model_state = jax.tree_util.tree_map(jnp.asarray, restored["network_state"])
        apply = jax.jit(network.apply)
        per_parameter = []
        for module, parameters in initial.items():
            if "world_head" in module:
                for name, array in parameters.items():
                    difference = np.asarray(final[module][name]) - np.asarray(array)
                    per_parameter.append({"module": module, "parameter": name,
                                          "changed_values": int(np.count_nonzero(difference)),
                                          "delta_l2": float(np.linalg.norm(difference)),
                                          "initial_l2": float(np.linalg.norm(np.asarray(array)))})
        state["world_parameter_deltas"] = per_parameter
        world_loss = Supervised(action_spec=action_spec,
                               weights={name: float(name == "world") for name in HEADS})

        def world_objective(parameters, inputs):
            (outputs, _, _), _ = network.apply(parameters, model_state, key, inputs, prior)
            values = outputs.copy()
            values["step_type"] = inputs["step_type"]
            losses, _ = world_loss.batched_loss(values)
            return jnp.mean(losses)

        gradient = jax.jit(jax.value_and_grad(world_objective))
        records = []
        for index, example in enumerate(examples):
            if not example["active_heads"]["world"]:
                continue
            result = {"action_ordinal": example["metadata"]["action_ordinal"],
                      "function": example["metadata"]["function"]["name"]}
            inputs = inputs_for(example)
            for phase, parameters in (("baseline", initial), ("final", final)):
                (predictions, _, _), _ = apply(parameters, model_state, key, inputs, prior)
                metrics = teacher_forced_metrics(predictions, example)
                recorded = previous["teacher_forced_metrics"][phase]["events"][index]
                if metrics != recorded:
                    raise ValueError(f"Reconstructed {phase} metrics do not exactly match archived diagnostic")
                logits = np.asarray(predictions["logits", "world"]).reshape(-1)
                mask = np.asarray(predictions["masks", "world"]).reshape(-1)
                target = int(example["labels"]["world"])
                active = logits[mask].astype(np.float64)
                normalizer = np.logaddexp.reduce(active)
                loss_value, derivatives = gradient(parameters, inputs)
                world_leaves = [np.asarray(array) for module, params in derivatives.items()
                                if "world_head" in module for array in params.values()]
                all_leaves = [np.asarray(value) for value in jax.tree_util.tree_leaves(derivatives)]
                result[phase] = {"world_only_loss": float(loss_value), "target_logit": float(logits[target]),
                                 "target_probability": float(np.exp(logits[target] - normalizer)),
                                 "argmax_world": int(logits.argmax()), "target_world": target,
                                 "allowed_count": int(mask.sum()), "allowed_logit_std": float(active.std()),
                                 "allowed_distinct_logits": len(np.unique(active)),
                                 "gradient_world_head_l2": float(np.sqrt(sum(np.square(a).sum() for a in world_leaves))),
                                 "gradient_all_l2": float(np.sqrt(sum(np.square(a).sum() for a in all_leaves))),
                                 "gradients_finite": all(np.isfinite(a).all() for a in all_leaves)}
            records.append(result)
            state["events"] = records
            save()
            print(json.dumps(result), flush=True)
        if sha256(args.run / "checkpoint.msgpack") != checkpoint_hash:
            raise ValueError("Checkpoint changed during read-only inspection")
        state.update(status="passed", reconstruction_matches_archived_metrics=True,
                     checkpoint_unchanged=True)
    except BaseException as exc:
        state.update(status="failed", error=f"{type(exc).__name__}: {exc}", traceback=traceback.format_exc())
        raise
    finally:
        state.update(finished_unix=time.time(), wall_seconds=time.time() - state["started_unix"])
        save()


if __name__ == "__main__":
    main()
