"""Mask math and fail-closed composition; actual checkpoint parity is a separate gate."""
from types import SimpleNamespace

import numpy as np
import pytest

from pluto_sc2.alphastar_tensor import TensorConfig, TensorError
from scripts.alphastar_eligibility_bridge_v1 import (
    FUNCTION_COMPONENT, FUNCTION_INPUT, SOURCE_COMPONENT, SOURCES_INPUT, _compose,
    conditional_source_logits, intersect_logits, validate_eligibility_inputs,
)


def test_all_ones_preserves_original_finite_logits_and_masks_exactly():
    logits = np.array([1., -1e10, -3.], np.float32)
    mask = np.array([True, False, True])
    actual, allowed = intersect_logits(logits, mask, np.ones(3, np.bool_))
    np.testing.assert_array_equal(actual, logits)
    np.testing.assert_array_equal(allowed, mask)


def test_intersection_never_unmasks_original_forbidden_or_adds_a_fallback():
    logits = np.array([10., 20., 30.], np.float32)
    actual, mask = intersect_logits(logits, np.array([False, True, True]), np.array([True, False, True]))
    np.testing.assert_array_equal(mask, [False, False, True])
    assert actual[2] == 30 and np.all(actual[:2] == np.float32(-1e10))
    actual, mask = intersect_logits(logits, np.ones(3, np.bool_), np.zeros(3, np.bool_))
    assert not mask.any() and np.all(actual == np.float32(-1e10))


def test_source_eligibility_uses_actual_function_prefix_and_keeps_original_mask():
    logits = np.array([5., 6., 7.], np.float32)
    base = np.array([True, True, False])
    producers = np.array([[True, False, True], [False, True, True]])
    for function, expected in [(0, [True, False, False]), (1, [False, True, False])]:
        actual, mask = conditional_source_logits(logits, base, producers, np.int32(function))
        np.testing.assert_array_equal(mask, expected)
        np.testing.assert_array_equal(actual[mask], logits[mask])
        assert mask.shape == (3,)  # This component never manufactures or consumes EOS.


def valid_example():
    return {"inputs": {FUNCTION_INPUT: np.ones(2, np.bool_), SOURCES_INPUT: np.ones((2, 4), np.bool_)}}


@pytest.mark.parametrize("change", ["missing_function", "missing_sources", "int_mask", "source_shape", "registry_ids"])
def test_supplemental_masks_require_exact_bool_shapes_and_official_indices(change):
    example, registry = valid_example(), [{"id": 0}, {"id": 1}]
    config = TensorConfig(max_entities=4, max_selected=2)
    validate_eligibility_inputs(example, config, registry)
    if change == "missing_function":
        del example["inputs"][FUNCTION_INPUT]
    elif change == "missing_sources":
        del example["inputs"][SOURCES_INPUT]
    elif change == "int_mask":
        example["inputs"][FUNCTION_INPUT] = np.ones(2, np.int32)
    elif change == "source_shape":
        example["inputs"][SOURCES_INPUT] = np.ones((4, 2), np.bool_)
    else:
        registry[1]["id"] = 3
    with pytest.raises(TensorError):
        validate_eligibility_inputs(example, config, registry)


class Part:
    def __init__(self, name):
        self.name = name


class Sequence(Part):
    def __init__(self, name):
        super().__init__(name)
        self._components = []

    def append(self, part):
        self._components.append(part)


class VectorLogits(Part):
    _logits_output_name = ("logits", "function")
    _mask_output_name = ("masks", "function")


class PointerLogits(Part):
    _logits_output_name = ("pre_logits", "unit_tags")
    _mask_output_name = ("pre_masks", "unit_tags")
    _unit_tags_masking = "selectable"


class Finalize(Part):
    _input_logits_name = ("pre_logits", "unit_tags")
    _input_mask_name = ("pre_masks", "unit_tags")
    _output_logits_name = ("logits", "unit_tags")
    _output_mask_name = ("masks", "unit_tags")


class Recurrent(Part):
    def __init__(self, name, inner):
        super().__init__(name)
        self._inner_component = inner
        self._constant_inputs = ["unit_tags_keys", ("observation", "raw_units")]


class Sample(Part):
    pass


class Teacher(Part):
    pass


def sequence(name, *parts):
    result = Sequence(name)
    for part in parts:
        result.append(part)
    return result


def graph(training):
    prefix = Teacher if training else Sample
    function = sequence("function_head", Part("resnet"), VectorLogits("logits"),
                        prefix("prefix"), Part("argument_masks"), Part("action_embedding"))
    inner = sequence("inner_component", PointerLogits("logits"), Finalize("finalize_unit_tags_logits"))
    if not training:
        inner.append(Part("inactive_source_mask"))
    inner.append(prefix("prefix"))
    inner.append(Part("embedding"))
    source = sequence("unit_tag_head", Part("query_resnet"), Recurrent("recurrent_unit_tags_head", inner),
                      Part("embedding_merge"))
    root = sequence("official_lite_rich_intent_v1", Part("encoder"), function, Part("queued_head"),
                    source, Part("target_unit_tag_head"), Part("world_head"))
    return root, function, source, source._components[1], inner


def compose(root, training):
    return _compose(root, modular=SimpleNamespace(SequentialComponent=Sequence),
                    vector=SimpleNamespace(Logits=VectorLogits),
                    units=SimpleNamespace(UnitTagsHead=Recurrent, PointerLogits=PointerLogits,
                                          FinalizeUnitTagsLogits=Finalize,
                                          UnitTagsMasking=SimpleNamespace(SELECTABLE="selectable")),
                    common=SimpleNamespace(ActionFromBehaviourFeatures=Teacher, Sample=Sample),
                    is_training=training, function_component=Part(FUNCTION_COMPONENT),
                    source_component=Part(SOURCE_COMPONENT))


@pytest.mark.parametrize("training", [True, False])
def test_fresh_graph_insertions_preserve_original_parameter_objects_names_and_eos_order(training):
    root, function, source, recurrent, inner = graph(training)
    old_function_parts = list(function._components)
    old_inner_parts = list(inner._components)
    before_names = [p.name for p in root._components]
    result = compose(root, training)
    assert result is not root and result.name == root.name
    assert [p.name for p in result._components] == before_names
    assert result._components[0] is root._components[0]
    assert result._components[-1] is root._components[-1]
    function_parts = result._components[1]._components
    assert function_parts[2].name == FUNCTION_COMPONENT
    assert [p for p in function_parts if p.name != FUNCTION_COMPONENT] == old_function_parts
    actual_recurrent = result._components[3]._components[1]
    assert actual_recurrent is recurrent
    inner_parts = actual_recurrent._inner_component._components
    assert inner_parts[1].name == SOURCE_COMPONENT
    assert [p for p in inner_parts if p.name != SOURCE_COMPONENT] == old_inner_parts
    assert actual_recurrent._constant_inputs[-2:] == [("action", "function"), SOURCES_INPUT]
    # Original parents retain their cached child lists; the new parents rebuild specs.
    assert function._components == old_function_parts
    assert source._components[1] is recurrent


@pytest.mark.parametrize("change", [
    "wrong_root", "missing_function", "duplicate_function", "source_first", "extra_function_logits",
    "wrong_function_stream", "function_gap", "wrong_source_stream", "nonselectable",
    "source_gap", "extra_finalize", "wrong_eos_stream", "missing_inactive", "teacher_in_inference",
    "duplicate_prefix", "existing_constants", "duplicate_recurrent", "wrong_inner_name",
])
def test_unreviewed_composition_fails_before_recurrent_mutation(change):
    root, function, source, recurrent, inner = graph(False)
    pointer, finalize = inner._components[:2]
    if change == "wrong_root":
        root.name = "different"
    elif change == "missing_function":
        root._components.remove(function)
    elif change == "duplicate_function":
        root.append(function)
    elif change == "source_first":
        root._components[1], root._components[3] = source, function
    elif change == "extra_function_logits":
        function.append(VectorLogits("other"))
    elif change == "wrong_function_stream":
        function._components[1]._logits_output_name = ("logits", "delay")
    elif change == "function_gap":
        function._components.insert(2, Part("unexpected"))
    elif change == "wrong_source_stream":
        pointer._logits_output_name = ("logits", "unit_tags")
    elif change == "nonselectable":
        pointer._unit_tags_masking = "none"
    elif change == "source_gap":
        inner._components.insert(1, Part("unexpected"))
    elif change == "extra_finalize":
        inner.append(Finalize("other"))
    elif change == "wrong_eos_stream":
        finalize._output_mask_name = ("pre_masks", "unit_tags")
    elif change == "missing_inactive":
        inner._components.pop(2)
    elif change == "teacher_in_inference":
        inner._components[3] = Teacher("prefix")
    elif change == "duplicate_prefix":
        inner.append(Sample("extra"))
    elif change == "existing_constants":
        recurrent._constant_inputs.append(SOURCES_INPUT)
    elif change == "duplicate_recurrent":
        source.append(recurrent)
    elif change == "wrong_inner_name":
        inner.name = "different"
    original_inner = recurrent._inner_component
    original_constants = list(recurrent._constant_inputs)
    with pytest.raises(TensorError, match="Unreviewed eligibility graph composition"):
        compose(root, False)
    assert recurrent._inner_component is original_inner
    assert recurrent._constant_inputs == original_constants


def test_reapplying_adapter_is_rejected_instead_of_silently_doubling_masks():
    root, *_ = graph(False)
    adapted = compose(root, False)
    with pytest.raises(TensorError):
        compose(adapted, False)
