"""Structural and intersection checks; actual checkpoint parity is separate."""
from types import SimpleNamespace

import numpy as np
import pytest

from pluto_sc2.alphastar_tensor import TensorConfig, TensorError
from scripts.alphastar_building_placement_bridge_v1 import (
    CLASSES_INPUT, COMPONENT, WORLD_INPUT, _compose, conditional_world_logits, validate_placement_inputs,
)


def test_unknown_function_preserves_existing_fog_mask():
    logits, mask = conditional_world_logits(np.array([1., -1e10, 3.], np.float32),
        np.array([True, False, True]), np.zeros((3, 3), bool), np.array([-1], np.int32), 0)
    np.testing.assert_array_equal(mask, [True, False, True])
    np.testing.assert_array_equal(logits, np.array([1., -1e10, 3.], np.float32))


@pytest.mark.parametrize('footprint', [0, 1, 2])
def test_actual_function_chooses_footprint_without_unmasking(footprint):
    placements = np.eye(3, dtype=bool)
    classes = np.array([2, 0, 1], np.int32)
    function = int(np.flatnonzero(classes == footprint)[0])
    _, mask = conditional_world_logits(np.array([1., 2., 3.], np.float32),
        np.array([False, True, True]), placements, classes, function)
    np.testing.assert_array_equal(mask, placements[footprint] & [False, True, True])


def test_all_ones_parity_and_empty_intersection_no_fallback():
    logits = np.array([2., -1e10, 4.], np.float32)
    base = np.array([True, False, True])
    actual, mask = conditional_world_logits(logits, base, np.ones((3, 3), bool), np.array([1]), 0)
    np.testing.assert_array_equal(actual, logits)
    np.testing.assert_array_equal(mask, base)
    _, empty = conditional_world_logits(logits, base, np.zeros((3, 3), bool), np.array([1]), 0)
    assert not empty.any()


@pytest.mark.parametrize('bad', ['missing', 'dtype', 'shape', 'class_dtype', 'class_range', 'class_shape'])
def test_input_contract_rejects_ambiguous_shapes(bad):
    config = TensorConfig()
    example = {'inputs': {WORLD_INPUT: np.ones((3, 65536), bool), CLASSES_INPUT: np.array([0, -1], np.int32)}}
    registry = [{}, {}]
    validate_placement_inputs(example, config, registry)
    if bad == 'missing':
        del example['inputs'][WORLD_INPUT]
    elif bad == 'dtype':
        example['inputs'][WORLD_INPUT] = np.ones((3, 65536), np.int32)
    elif bad == 'shape':
        example['inputs'][WORLD_INPUT] = np.ones((16,), bool)
    elif bad == 'class_dtype':
        example['inputs'][CLASSES_INPUT] = np.array([0, -1], np.int64)
    elif bad == 'class_range':
        example['inputs'][CLASSES_INPUT] = np.array([3, -1], np.int32)
    else:
        example['inputs'][CLASSES_INPUT] = np.array([-1], np.int32)
    with pytest.raises(TensorError):
        validate_placement_inputs(example, config, registry)


class Part:
    def __init__(self, name):
        self.name = name


class Sequence(Part):
    def __init__(self, name):
        super().__init__(name)
        self._components = []

    def append(self, part):
        self._components.append(part)


class Sample(Part):
    pass


class Teacher(Part):
    pass


def fixture(training):
    root = Sequence('official_lite_rich_intent_v1')
    head = Sequence('world_head')
    for part in (Part('logits'), Part('intent_mask_world'), (Teacher if training else Sample)('world_prefix')):
        head.append(part)
    root.append(Part('retained_upstream'))
    root.append(head)
    return root


def compose(root, training):
    return _compose(root, modular=SimpleNamespace(SequentialComponent=Sequence),
        common=SimpleNamespace(Sample=Sample, ActionFromBehaviourFeatures=Teacher),
        is_training=training, placement_component=Part(COMPONENT))


@pytest.mark.parametrize('training', [True, False])
def test_insertion_is_after_fog_mask_before_prefix_without_touching_original(training):
    original = fixture(training)
    rebuilt = compose(original, training)
    assert rebuilt._components[0] is original._components[0]
    assert [p.name for p in rebuilt._components[1]._components] == [
        'logits', 'intent_mask_world', COMPONENT, 'world_prefix']
    assert len(original._components[1]._components) == 3
    assert rebuilt._components[1]._components[0] is original._components[1]._components[0]


@pytest.mark.parametrize('change', ['root', 'head', 'mask_missing', 'mask_duplicate', 'prefix', 'already_added'])
def test_changed_upstream_layout_fails_closed(change):
    root = fixture(False)
    head = root._components[1]
    if change == 'root':
        root.name = 'new_root'
    elif change == 'head':
        head.name = 'new_world_head'
    elif change == 'mask_missing':
        head._components.pop(1)
    elif change == 'mask_duplicate':
        head._components.insert(1, Part('intent_mask_world'))
    elif change == 'prefix':
        head._components.insert(2, Part('intervening'))
    else:
        head._components.append(Part(COMPONENT))
    with pytest.raises(TensorError):
        compose(root, False)
