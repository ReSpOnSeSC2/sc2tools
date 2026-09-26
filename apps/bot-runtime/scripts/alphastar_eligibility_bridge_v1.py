"""Opt-in, parameter-free producer eligibility on a fresh official graph.

The original builders, checkpoints and modules are unchanged. Supplemental
observation masks can only narrow existing masks. They never supply a sampled
function, source, expert label, target or gameplay fallback. Callers must pin
the independent observation-only eligibility rules and this adapter version.
"""
from __future__ import annotations

import numpy as np

from pluto_sc2.alphastar_tensor import TensorError
from scripts.alphastar_capacity_bridge import build_capacity_bridge


ELIGIBILITY_ADAPTER = "conditional-producer-mask-v1"
ELIGIBILITY_RULES = "protoss-action-eligibility-v1"
FUNCTION_INPUT = ("observation", "eligibility_function")
SOURCES_INPUT = ("observation", "eligibility_sources")
FUNCTION_COMPONENT = "eligibility_function_mask_v1"
SOURCE_COMPONENT = "eligibility_source_mask_v1"


def intersect_logits(logits, base_mask, eligibility, *, array_api=np):
    """Intersection only; already forbidden values can never be unmasked."""
    mask = array_api.logical_and(base_mask, eligibility)
    return array_api.where(mask, logits, array_api.asarray(-1e10, dtype=logits.dtype)), mask


def conditional_source_logits(logits, base_mask, eligibility, function, *, array_api=np):
    """Apply the actual autoregressive function's producer row, before EOS."""
    return intersect_logits(logits, base_mask, eligibility[function], array_api=array_api)


def validate_eligibility_inputs(example, config, registry):
    """No synthesized defaults: all-ones parity must be explicitly supplied."""
    if not registry or [item.get("id") for item in registry] != list(range(len(registry))):
        raise TensorError("Eligibility requires a contiguous official registry")
    inputs = example.get("inputs", {})
    for key, shape in ((FUNCTION_INPUT, (len(registry),)),
                       (SOURCES_INPUT, (len(registry), config.max_entities))):
        value = inputs.get(key)
        if not isinstance(value, np.ndarray) or value.dtype != np.bool_ or value.shape != shape:
            raise TensorError(f"Missing or malformed supplemental eligibility input: {key}")


def _require(condition, message):
    if not condition:
        raise TensorError("Unreviewed eligibility graph composition: " + message)


def _compose(component, *, modular, vector, units, common, is_training,
             function_component, source_component):
    """Rebuild cached specs, retaining all original parameter-bearing objects.

    A private dependency-injected composition helper also lets CPU tests check
    exact insertion and failure behavior without importing a model runtime.
    Only the newly constructed graph passed by the builder may be supplied.
    """
    _require(isinstance(component, modular.SequentialComponent), "root is not sequential")
    _require(component.name == "official_lite_rich_intent_v1", "root name changed")
    children = list(component._components)
    function_heads = [p for p in children if p.name == "function_head"]
    source_heads = [p for p in children if p.name == "unit_tag_head"]
    _require(len(function_heads) == len(source_heads) == 1, "require exactly one function and source head")
    _require(children.index(function_heads[0]) < children.index(source_heads[0]), "source before function")
    prefix_class = common.ActionFromBehaviourFeatures if is_training else common.Sample

    def sequence(original, parts):
        rebuilt = modular.SequentialComponent(name=original.name)
        for part in parts:
            rebuilt.append(part)
        return rebuilt

    head = function_heads[0]
    _require(isinstance(head, modular.SequentialComponent), "function head is not sequential")
    function_parts = list(head._components)
    indices = [i for i, part in enumerate(function_parts) if isinstance(part, vector.Logits)]
    _require(len(indices) == 1, "function Logits count changed")
    index = indices[0]
    logits = function_parts[index]
    _require(logits.name == "logits" and logits._logits_output_name == ("logits", "function")
             and logits._mask_output_name == ("masks", "function"), "function streams changed")
    _require(index + 1 < len(function_parts) and isinstance(function_parts[index + 1], prefix_class),
             "function prefix no longer directly follows logits")
    _require(sum(isinstance(p, prefix_class) for p in function_parts) == 1, "function prefix count changed")
    _require(not any(p.name == FUNCTION_COMPONENT for p in function_parts), "function adapter already present")
    function_parts.insert(index + 1, function_component)
    new_function = sequence(head, function_parts)

    head = source_heads[0]
    _require(isinstance(head, modular.SequentialComponent), "source head is not sequential")
    source_parts = list(head._components)
    recurrent = [p for p in source_parts if isinstance(p, units.UnitTagsHead)]
    _require(len(recurrent) == 1 and recurrent[0].name == "recurrent_unit_tags_head",
             "recurrent source head changed")
    recurrent = recurrent[0]
    inner = recurrent._inner_component
    _require(isinstance(inner, modular.SequentialComponent) and inner.name == "inner_component",
             "source inner sequence changed")
    inner_parts = list(inner._components)
    indices = [i for i, part in enumerate(inner_parts) if isinstance(part, units.PointerLogits)]
    finalizers = [i for i, part in enumerate(inner_parts) if isinstance(part, units.FinalizeUnitTagsLogits)]
    _require(len(indices) == len(finalizers) == 1, "source pointer/finalizer count changed")
    index = indices[0]
    pointer = inner_parts[index]
    _require(pointer.name == "logits" and pointer._logits_output_name == ("pre_logits", "unit_tags")
             and pointer._mask_output_name == ("pre_masks", "unit_tags")
             and pointer._unit_tags_masking == units.UnitTagsMasking.SELECTABLE,
             "source pointer streams or selectable mask changed")
    _require(finalizers[0] == index + 1, "source finalizer no longer directly follows pointer")
    finalizer = inner_parts[finalizers[0]]
    _require(finalizer.name == "finalize_unit_tags_logits"
             and finalizer._input_logits_name == ("pre_logits", "unit_tags")
             and finalizer._input_mask_name == ("pre_masks", "unit_tags")
             and finalizer._output_logits_name == ("logits", "unit_tags")
             and finalizer._output_mask_name == ("masks", "unit_tags"), "source EOS streams changed")
    prefixes = [i for i, p in enumerate(inner_parts) if isinstance(p, prefix_class)]
    inactive = [i for i, p in enumerate(inner_parts) if p.name == "inactive_source_mask"]
    expected_prefix = finalizers[0] + (1 if is_training else 2)
    _require(prefixes == [expected_prefix], "source sampling/teacher prefix changed")
    _require(inactive == ([] if is_training else [finalizers[0] + 1]), "inactive-source EOS adapter changed")
    _require(not any(p.name == SOURCE_COMPONENT for p in inner_parts), "source adapter already present")
    extra = [("action", "function"), SOURCES_INPUT]
    _require(not set(extra).intersection(recurrent._constant_inputs), "eligibility constants already present")
    inner_parts.insert(index + 1, source_component)
    recurrent._inner_component = sequence(inner, inner_parts)
    recurrent._constant_inputs = [*recurrent._constant_inputs, *extra]
    # These specs are properties on UnitTagsHead, but its parents cache them.
    new_source = sequence(head, source_parts)
    replacements = {id(function_heads[0]): new_function, id(source_heads[0]): new_source}
    return sequence(component, [replacements.get(id(part), part) for part in children])


def build_eligibility_bridge(example, config, registry, *, is_training=True, sampling_mode="sample"):
    """Build an explicitly opted-in graph without editing any frozen source.

    Its parameter schema must be checked against the actual saved checkpoint by
    the caller before use. Existing inference/training entry points do not opt
    in automatically. The capacity adapter and its precision contract remain.
    """
    if type(is_training) is not bool:
        raise TensorError("Eligibility graph requires explicit boolean training mode")
    validate_eligibility_inputs(example, config, registry)
    component, action_spec = build_capacity_bridge(
        example, config, registry, is_training=is_training, sampling_mode=sampling_mode)
    import jax.numpy as jnp
    from dm_env import specs
    from alphastar import types
    from alphastar.architectures import modular
    from alphastar.architectures.components import common, units, vector

    class FunctionEligibilityMask(modular.BatchedComponent):
        @property
        def input_spec(self):
            return types.SpecDict({("logits", "function"): specs.Array((len(registry),), np.float32),
                                   ("masks", "function"): specs.Array((len(registry),), np.bool_),
                                   FUNCTION_INPUT: specs.Array((len(registry),), np.bool_)})

        @property
        def output_spec(self):
            return types.SpecDict({key: value for key, value in self.input_spec.items() if key != FUNCTION_INPUT})

        def _forward(self, inputs):
            logits, mask = intersect_logits(inputs["logits", "function"], inputs["masks", "function"],
                                             inputs[FUNCTION_INPUT], array_api=jnp)
            return types.StreamDict({("logits", "function"): logits, ("masks", "function"): mask}), {}

    class SourceEligibilityMask(modular.BatchedComponent):
        @property
        def input_spec(self):
            return types.SpecDict({("pre_logits", "unit_tags"): specs.Array((config.max_entities,), np.float32),
                                   ("pre_masks", "unit_tags"): specs.Array((config.max_entities,), np.bool_),
                                   ("action", "function"): specs.Array((), np.int32),
                                   SOURCES_INPUT: specs.Array((len(registry), config.max_entities), np.bool_)})

        @property
        def output_spec(self):
            return types.SpecDict({key: self.input_spec[key] for key in
                                   (("pre_logits", "unit_tags"), ("pre_masks", "unit_tags"))})

        def _forward(self, inputs):
            logits, mask = conditional_source_logits(inputs["pre_logits", "unit_tags"],
                inputs["pre_masks", "unit_tags"], inputs[SOURCES_INPUT], inputs["action", "function"], array_api=jnp)
            return types.StreamDict({("pre_logits", "unit_tags"): logits, ("pre_masks", "unit_tags"): mask}), {}

    result = _compose(component, modular=modular, vector=vector, units=units, common=common,
                      is_training=is_training,
                      function_component=FunctionEligibilityMask(name=FUNCTION_COMPONENT),
                      source_component=SourceEligibilityMask(name=SOURCE_COMPONENT))
    for key in (FUNCTION_INPUT, SOURCES_INPUT):
        _require(key in result.input_spec, "new observation dependency not propagated")
    return result, action_spec
