"""Opt-in, parameter-free observed structure overlap mask on the verified graph.

The caller supplies observation-only masks from building_placement_v1. This
component intersects the existing world mask after the actual function prefix;
it neither chooses a target nor certifies native placement legality.
"""
from __future__ import annotations

import numpy as np

from pluto_sc2.alphastar_tensor import TensorError
from scripts.alphastar_eligibility_bridge_v2 import build_eligibility_bridge
from scripts.alphastar_eligibility_bridge_v1 import intersect_logits

PLACEMENT_ADAPTER = 'observed-building-overlap-mask-v1'
WORLD_INPUT = ('observation', 'placement_world_masks')
CLASSES_INPUT = ('observation', 'placement_function_classes')
COMPONENT = 'observed_building_overlap_mask_v1'


def conditional_world_logits(logits, base_mask, placements, classes, function, *, array_api=np):
    """Unknown functions retain exactly their existing mask; known ones narrow it."""
    selected = classes[function]
    allowed = array_api.where(selected < 0, array_api.ones_like(base_mask),
                              placements[array_api.maximum(selected, 0)])
    return intersect_logits(logits, base_mask, allowed, array_api=array_api)


def validate_placement_inputs(example, config, registry):
    inputs = example.get('inputs', {})
    masks, classes = inputs.get(WORLD_INPUT), inputs.get(CLASSES_INPUT)
    if (not isinstance(masks, np.ndarray) or masks.dtype != np.bool_
            or masks.shape != (3, config.world_size ** 2)):
        raise TensorError('Placement masks require exactly three boolean world grids')
    if (not isinstance(classes, np.ndarray) or classes.dtype != np.int32
            or classes.shape != (len(registry),) or np.any(classes < -1) or np.any(classes > 2)):
        raise TensorError('Placement function classes must be int32 in [-1,2]')


def _compose(component, *, modular, common, is_training, placement_component):
    def require(condition, message):
        if not condition:
            raise TensorError('Unreviewed placement graph composition: ' + message)

    require(isinstance(component, modular.SequentialComponent)
            and component.name == 'official_lite_rich_intent_v1', 'root changed')
    children = list(component._components)
    heads = [p for p in children if p.name == 'world_head']
    require(len(heads) == 1 and isinstance(heads[0], modular.SequentialComponent), 'world head changed')
    original = heads[0]
    parts = list(original._components)
    masks = [i for i, p in enumerate(parts) if p.name == 'intent_mask_world']
    require(len(masks) == 1, 'intent world mask count changed')
    index = masks[0]
    prefix = common.ActionFromBehaviourFeatures if is_training else common.Sample
    require(index + 1 < len(parts) and isinstance(parts[index + 1], prefix), 'world prefix moved')
    require(sum(isinstance(p, prefix) for p in parts) == 1, 'world prefix count changed')
    require(not any(p.name == COMPONENT for p in parts), 'placement adapter already present')
    parts.insert(index + 1, placement_component)
    head = modular.SequentialComponent(name=original.name)
    for part in parts:
        head.append(part)
    rebuilt = modular.SequentialComponent(name=component.name)
    for child in children:
        rebuilt.append(head if child is original else child)
    return rebuilt


def build_placement_bridge(example, config, registry, *, is_training=True, sampling_mode='sample'):
    if type(is_training) is not bool:
        raise TensorError('Placement graph requires boolean training mode')
    validate_placement_inputs(example, config, registry)
    component, action_spec = build_eligibility_bridge(example, config, registry,
        is_training=is_training, sampling_mode=sampling_mode)
    import jax.numpy as jnp
    from dm_env import specs
    from alphastar import types
    from alphastar.architectures import modular
    from alphastar.architectures.components import common

    class PlacementMask(modular.BatchedComponent):
        @property
        def input_spec(self):
            size = config.world_size ** 2
            return types.SpecDict({('logits', 'world'): specs.Array((size,), np.float32),
                ('masks', 'world'): specs.Array((size,), np.bool_),
                ('action', 'function'): specs.Array((), np.int32),
                WORLD_INPUT: specs.Array((3, size), np.bool_),
                CLASSES_INPUT: specs.Array((len(registry),), np.int32)})

        @property
        def output_spec(self):
            return types.SpecDict({key: self.input_spec[key] for key in
                                   (('logits', 'world'), ('masks', 'world'))})

        def _forward(self, inputs):
            logits, mask = conditional_world_logits(inputs['logits', 'world'], inputs['masks', 'world'],
                inputs[WORLD_INPUT], inputs[CLASSES_INPUT], inputs['action', 'function'], array_api=jnp)
            return types.StreamDict({('logits', 'world'): logits, ('masks', 'world'): mask}), {}

    result = _compose(component, modular=modular, common=common, is_training=is_training,
                      placement_component=PlacementMask(name=COMPONENT))
    if WORLD_INPUT not in result.input_spec or CLASSES_INPUT not in result.input_spec:
        raise TensorError('Placement observation inputs did not propagate')
    return result, action_spec
