"""Inference boundaries without requiring JAX or a GPU in the Windows suite."""
from copy import deepcopy
from types import SimpleNamespace

import numpy as np
import pytest

from pluto_sc2.alphastar_tensor import HEADS, TensorConfig, TensorError
from scripts.infer_alphastar_checkpoint import (
    select_dataset_rows, structured_prediction, validate_observation_only, verify_tree_schema,
)
from scripts.train_alphastar_replay import build_official_bridge, inactive_source_logits


CONFIG = TensorConfig(max_entities=4, max_selected=3)
REGISTRY = [
    {"id": 0, "name": "raw_move_camera", "args": ["world"]},
    {"id": 1, "name": "Train_Probe_quick", "args": ["queued", "unit_tags"]},
    {"id": 2, "name": "Attack_unit", "args": ["queued", "unit_tags", "target_unit_tag"]},
]


def outputs(function=1):
    result = {}
    sizes = {"function": 3, "delay": 2, "queued": 2, "repeat": 2,
             "unit_tags": 5, "target_unit_tag": 4, "world": 65536}
    for name in HEADS:
        shape = (3,) if name == "unit_tags" else ()
        action = np.asarray([0, 4, 4] if shape else function if name == "function" else 0, np.int32)
        result["action", name] = action.reshape((1, 1) + shape)
        result["logits", name] = np.zeros((1, 1) + shape + (sizes[name],), np.float32)
        result["masks", name] = np.ones((1, 1) + shape + (sizes[name],), np.bool_)
        result["argument_masks", name] = np.asarray([[name == "function" or name in REGISTRY[function]["args"]]])
    return result


def test_observation_only_accepts_real_typed_inputs_without_expert_labels():
    value = {"inputs": {"step_type": np.asarray(1, np.int32),
                        ("observation", "game_loop"): np.asarray(128, np.int32)},
             "metadata": {"game_loop": 128, "entity_tags": [77]}}
    assert validate_observation_only(value) is value["inputs"]
    with pytest.raises(TensorError, match="without labels"):
        validate_observation_only({**value, "labels": {"function": 1}})
    value["inputs"]["behaviour_features", "action", "function"] = np.asarray(1, np.int32)
    with pytest.raises(TensorError, match="forbidden"):
        validate_observation_only(value)


@pytest.mark.parametrize("step", [np.asarray(0, np.int32), np.asarray(2, np.int32),
                                  np.asarray(1, np.int64), np.asarray([1], np.int32)])
def test_does_not_claim_untrained_episode_boundary_semantics(step):
    with pytest.raises(TensorError, match="MID"):
        validate_observation_only({"inputs": {"step_type": step}, "metadata": {}})


def test_exact_parameter_tree_rejects_same_shape_under_different_names():
    expected = {"official_lite/head": {"w": SimpleNamespace(shape=(2, 3), dtype=np.dtype("float32"))}}
    assert verify_tree_schema(expected, {"official_lite/head": {"w": np.zeros((2, 3), np.float32)}}) == (1, 6)
    with pytest.raises(TensorError, match="mapping differs"):
        verify_tree_schema(expected, {"renamed_head": {"w": np.zeros((2, 3), np.float32)}})
    with pytest.raises(TensorError, match="shape/dtype"):
        verify_tree_schema(expected, {"official_lite/head": {"w": np.zeros((2, 3), np.float64)}})
    with pytest.raises(TensorError, match="nonfinite"):
        verify_tree_schema(expected, {"official_lite/head": {"w": np.full((2, 3), np.nan, np.float32)}})


def test_sampled_source_sequence_and_eos_each_use_their_own_masks():
    value = outputs()
    result = structured_prediction(value, REGISTRY, CONFIG)
    assert result["mask_checks_passed"]
    assert result["prediction"]["unit_tags"] == [0, 4, 4]
    value["masks", "unit_tags"][0, 0, 1, 4] = False
    result = structured_prediction(value, REGISTRY, CONFIG)
    assert not result["mask_checks_passed"]
    assert result["mask_failures"] == ["sampled_unit_tags_target_mask_false"]
    assert result["prediction"]["unit_tags"] == [0, 4, 4]  # Never repairs the sampled choice.


def test_camera_does_not_require_unused_source_or_target_masks():
    value = outputs(0)
    value["masks", "unit_tags"][:] = False
    value["masks", "target_unit_tag"][:] = False
    result = structured_prediction(value, REGISTRY, CONFIG)
    assert result["mask_checks_passed"] and result["active_heads"] == ["function", "world"]


@pytest.mark.parametrize("own_units_available", [False, True])
def test_camera_sampling_preserves_training_empty_prefix_even_without_any_own_units(own_units_available):
    logits = np.asarray([8., 2., -1e10], np.float32)  # Stock source EOS is masked initially.
    masks = np.asarray([own_units_available, own_units_available, False])
    predicted, allowed = inactive_source_logits(logits, masks, np.bool_(False))
    assert allowed.tolist() == [False, False, True]
    assert predicted.dtype == np.float32 and int(predicted.argmax()) == 2
    assert float(predicted[2]) == 0
    active_logits, active_masks = inactive_source_logits(logits, masks, np.bool_(True))
    assert np.array_equal(active_logits, logits) and np.array_equal(active_masks, masks)
    # A no-own-unit source-required action stays all masked; no legal source is invented.
    assert bool(active_masks.any()) is own_units_available


def test_active_all_masked_target_is_rejected_without_substituting_action():
    value = outputs(2)
    value["action", "target_unit_tag"][0, 0] = 3
    value["masks", "target_unit_tag"][:] = False
    result = structured_prediction(value, REGISTRY, CONFIG)
    assert result["prediction"]["target_unit_tag"] == 3
    assert result["mask_failures"] == ["sampled_target_unit_tag_target_mask_false"]


def test_active_argument_mask_cannot_silently_disable_a_sampled_dependency():
    value = outputs()
    value["argument_masks", "unit_tags"][:] = False
    result = structured_prediction(value, REGISTRY, CONFIG)
    assert result["mask_failures"] == ["active_unit_tags_argument_mask_false"]


@pytest.mark.parametrize("failure", ["nan", "action_float", "wrong_batch", "outside", "timing"])
def test_malformed_model_outputs_fail_closed(failure):
    value = outputs()
    if failure == "nan":
        value["logits", "world"][0, 0, 3] = np.nan
    elif failure == "action_float":
        value["action", "queued"] = np.zeros((1, 1), np.float32)
    elif failure == "wrong_batch":
        value["action", "unit_tags"] = np.zeros((2, 1, 3), np.int32)
    elif failure == "outside":
        value["action", "function"][0, 0] = 3
    else:
        value["action", "delay"][0, 0] = 1
    with pytest.raises(TensorError):
        structured_prediction(value, REGISTRY, CONFIG)


def test_diagnostic_selection_preserves_original_order_and_player_perspective(monkeypatch):
    import scripts.infer_alphastar_checkpoint as module
    rows = [{"replay_id": "a", "player_id": player, "action_ordinal": 4, "intent": {"ability_id": player}}
            for player in (1, 2)]
    result = {"dataset_hashes": {"samples": "hash"}, "mask_proofs": list(reversed(deepcopy(rows)))}
    monkeypatch.setattr(module, "read_dataset", lambda _: ({}, {}, {"samples": "hash"}, {}))
    monkeypatch.setattr(module, "train_rows", lambda _: iter(rows))
    selected = select_dataset_rows("unused", result, 1)
    assert selected == [rows[1]]
    result["mask_proofs"] = [rows[1], rows[1]]
    with pytest.raises(TensorError, match="duplicate"):
        select_dataset_rows("unused", result, 2)


def test_mode_errors_are_rejected_before_optional_gpu_dependencies_import():
    with pytest.raises(TensorError, match="execution mode"):
        build_official_bridge({}, CONFIG, REGISTRY, is_training="false")
    with pytest.raises(TensorError, match="execution mode"):
        build_official_bridge({}, CONFIG, REGISTRY, is_training=False, sampling_mode="expert")
    with pytest.raises(TensorError, match="only to label-free"):
        build_official_bridge({}, CONFIG, REGISTRY, sampling_mode="greedy")
