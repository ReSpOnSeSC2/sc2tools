"""Explicit parameter-free compatibility adapter for the 128-entity model.

The pinned official ToVector pools all capacity slots after an affine MLP.
Empty rows therefore contribute the learned MLP's f(0), not zero. Preserve the
original128-slot mixture while including every observed entity beyond128.
This module changes fresh graph instances only; upstream files stay immutable.
"""
from __future__ import annotations

import numpy as np

from scripts.train_alphastar_replay import TensorError, build_official_bridge

CAPACITY_ADAPTER = "empty-affine-preserving-entity-pool128-v1"
CAPACITY_MATMUL_PRECISION = "highest"


def configure_capacity_runtime(record):
    """Configure only an explicitly versioned capacity model before tracing.

    Legacy records cause no JAX import or configuration change. The precision
    is part of the expanded model's contract, never inferred from its weights.
    """
    if record.get("capacity_adapter") is None:
        return False
    if (record.get("capacity_adapter") != CAPACITY_ADAPTER
            or record.get("matmul_precision") != CAPACITY_MATMUL_PRECISION):
        raise TensorError("Unknown capacity adapter or missing highest matmul precision contract")
    import jax
    jax.config.update("jax_default_matmul_precision", CAPACITY_MATMUL_PRECISION)
    return True


def capacity_preserving_pool(transformed, non_empty, transformed_zero, *, array_api=np):
    """Original128 denominator below128 entities, observed count above128.

    Valid observations can occupy arbitrary slots; no observation is sliced out.
    The reference zero is transformed by exactly the same learned MLP.
    """
    count = array_api.sum(non_empty, dtype=array_api.float32)
    denominator = array_api.maximum(array_api.float32(128), count)
    total = array_api.sum(array_api.where(non_empty[:, None], transformed, 0), axis=0)
    return (total + (denominator - count) * transformed_zero) / denominator


def build_capacity_bridge(example, config, registry, **kwargs):
    """Preserve the old graph; explicitly adapt only reviewed larger capacity."""
    component, action_spec = build_official_bridge(example, config, registry, **kwargs)
    if config.max_entities == 128 and config.max_selected == 16:
        return component, action_spec
    if config.max_entities != 512 or config.max_selected != 64:
        raise TensorError("Capacity adapter only supports reviewed128/16 and512/64 shapes")
    import haiku as hk
    import jax
    if jax.config.jax_default_matmul_precision != CAPACITY_MATMUL_PRECISION:
        raise TensorError("Expanded capacity graph requires configured highest matmul precision")
    import jax.numpy as jnp
    from dm_env import specs
    from alphastar import types
    from alphastar.architectures import modular
    from alphastar.architectures.components import units, util

    class CompatibleToVector(units.ToVector):
        @property
        def input_spec(self):
            spec = super().input_spec.copy()
            spec["non_empty_units"] = specs.Array((self._max_num_observed_units,), jnp.bool_)
            return spec

        def _forward(self, inputs):
            # The sentinel is only a reference for the affine image of empty
            # padding. It is never an observed unit or selectable pointer.
            x = inputs[self._input_name]
            x = jnp.concatenate([x, jnp.zeros_like(x[:1])], axis=0)
            for size in self._units_hidden_sizes:
                if self._use_layer_norm:
                    x = util.units_layer_norm(x)
                x = jax.nn.relu(x)
                x = hk.Linear(output_size=size)(x)
            x = capacity_preserving_pool(x[:-1], inputs["non_empty_units"], x[-1], array_api=jnp)
            if self._use_layer_norm:
                x = util.vector_layer_norm(x)
            x = jax.nn.relu(x)
            x = hk.Linear(output_size=self._vector_stream_size)(x)
            return types.StreamDict({self._output_name: x}), {}

    adapted = []

    def rebuild(part):
        if isinstance(part, units.ToVector):
            if part.name != "torso_units_to_vector" or part._max_num_observed_units != 512:
                raise TensorError("Unreviewed official ToVector path or capacity")
            part.__class__ = CompatibleToVector
            adapted.append(part.name)
        if isinstance(part, modular.SequentialComponent):
            replacement = modular.SequentialComponent(name=part.name)
            for child in part._components:
                replacement.append(rebuild(child))
            return replacement
        return part

    component = rebuild(component)
    if adapted != ["torso_units_to_vector"]:
        raise TensorError("Expected exactly one reviewed units-to-vector pool")
    return component, action_spec
