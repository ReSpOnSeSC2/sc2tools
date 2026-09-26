"""Label-free live tensors, with pre-refactor training byte fingerprints."""
from copy import deepcopy
import hashlib
import json

import numpy as np
import pytest

from pluto_sc2 import alphastar_tensor as tensor
from pluto_sc2.policy_intents import bind_observation
from test_alphastar_tensor import REGISTRY, entity, example, image
from test_rich_intents import catalog


CONFIG = tensor.TensorConfig(max_entities=8, max_selected=4)
MAPPING = {84: 7, 59: 8, 342: 9}


def mixed_sample(mode="mixed"):
    sample = example()
    frame = sample["frame"]
    frame["hud"]["player_id"] = 1
    frame["entities"] += [entity(300, 4, [51, 50]), entity(200, 3, [49, 50])]
    frame["entities"][-1].update(type_id=999999, type_name="MineralField")
    frame["known_own"].append({"tag": 7, "owner": 1, "type_id": 59, "type_name": "Nexus",
                                "position": [40, 65], "last_seen_loop": 20,
                                "energy": 999, "orders": [{"ability_id": 1006}]})
    frame["known_neutral"] = [{"tag": 99, "owner": 3, "type_id": 342, "type_name": "VespeneGeyser",
                                "position": [60, 60], "last_seen_loop": 40}]
    frame["entities"].reverse()
    if mode == "gas":
        sample["intent"].update(ability_id=882, target={"kind": "unit", "tag": 99})
    elif mode == "memory_source":
        sample["intent"]["source_tags"] = [7]
        frame["selection"].append(7)
    return sample


def fingerprint(result):
    digest = hashlib.sha256()
    for key, value in sorted(result["inputs"].items(), key=lambda item: repr(item[0])):
        value = np.asarray(value)
        digest.update(repr(key).encode())
        digest.update(str(value.dtype).encode())
        digest.update(repr(value.shape).encode())
        digest.update(value.tobytes())
    digest.update(json.dumps(result["metadata"], sort_keys=True, separators=(",", ":"),
                             default=lambda value: value.item()).encode())
    digest.update(json.dumps(result["active_heads"], sort_keys=True).encode())
    return digest.hexdigest()


# Captured from tensorize_sample before observation-only extraction, including
# every tensor's key, shape, dtype and bytes plus training metadata/head flags.
GOLDEN = {
    "mixed": "f7890e2c2996f75afa0cf43eb4b434866831a139612abbfc6d40193050a8c614",
    "gas": "7e0c0a2ea6a8dd51561a6363963c59583ae8c5097a0d1ecd2c9a39fdf45d9df8",
    "memory_source": "44bcfc1fcfaa818848c509cf830ef78314d305ef685d29cd52625ea0480c1975",
}


@pytest.mark.parametrize("mode", ["mixed", "gas", "memory_source"])
def test_training_numerical_tensors_and_metadata_unchanged(mode):
    encoded = tensor.tensorize_sample(mixed_sample(mode), REGISTRY, MAPPING, CONFIG)
    assert fingerprint(encoded) == GOLDEN[mode]


def test_live_encoder_requires_only_observation_and_returns_no_action_evidence():
    frame = mixed_sample()["frame"]
    before = deepcopy(frame)
    encoded = tensor.tensorize_observation(frame, REGISTRY, MAPPING, CONFIG)
    assert set(encoded) == {"inputs", "metadata"}
    assert all(key == "step_type" or key[0] == "observation" for key in encoded["inputs"])
    assert not {"intent", "function", "labels", "active_heads", "replay_id", "action_loop", "action_ordinal"} & set(encoded["metadata"])
    assert encoded["metadata"]["game_loop"] == frame["game_loop"]
    assert encoded["metadata"]["player_id"] == 1
    assert encoded["metadata"]["entity_tags"] == [200, 300, 4294967300, 7, 99]
    assert frame == before


@pytest.mark.parametrize("mode", ["mixed", "gas", "memory_source"])
def test_live_and_training_observations_are_identical_without_teacher_inputs(mode):
    sample = mixed_sample(mode)
    live = tensor.tensorize_observation(sample["frame"], REGISTRY, MAPPING, CONFIG)
    trained = tensor.tensorize_sample(sample, REGISTRY, MAPPING, CONFIG)
    for key, value in live["inputs"].items():
        np.testing.assert_array_equal(value, trained["inputs"][key], strict=True)
    for key in ("entity_tags", "current_entity_count", "remembered_own_count", "remembered_neutral_count", "unknown_type_count"):
        assert live["metadata"][key] == trained["metadata"][key]


def test_encoder_sidecar_passes_prediction_binding_without_replay_metadata():
    frame = mixed_sample()["frame"]
    encoded = tensor.tensorize_observation(frame, REGISTRY, MAPPING, CONFIG)
    registry = [{**row, "general_id": 0, "camera_only_pt": False, "planned_build": False} for row in REGISTRY]
    bound = bind_observation(frame, encoded["metadata"]["entity_tags"], registry, catalog(),
                             session_id="observation-only-native-session", max_entities=8, max_selected=4)
    assert bound["entity_tags"] == encoded["metadata"]["entity_tags"]
    assert bound["game_loop"] == frame["game_loop"] and "replay_id" not in bound


@pytest.mark.parametrize("step_type", [0, 1, 2])
def test_explicit_actual_episode_step_type(step_type):
    encoded = tensor.tensorize_observation(mixed_sample()["frame"], REGISTRY, MAPPING, CONFIG, step_type=step_type)
    value = encoded["inputs"]["step_type"]
    assert value.shape == () and value.dtype == np.int32 and int(value) == step_type


@pytest.mark.parametrize("step_type", [-1, 3, True, 1.0])
def test_invalid_episode_step_type_does_not_get_coerced(step_type):
    with pytest.raises(tensor.TensorError, match="step_type"):
        tensor.tensorize_observation(mixed_sample()["frame"], REGISTRY, MAPPING, CONFIG, step_type=step_type)


def test_unknown_nonselected_own_memory_is_encodable_without_source_label_permission():
    frame = mixed_sample()["frame"]
    frame["selection_complete"] = False
    frame["selection"] = []
    encoded = tensor.tensorize_observation(frame, REGISTRY, MAPPING, CONFIG)
    index = encoded["metadata"]["entity_tags"].index(7)
    inputs = encoded["inputs"]
    assert inputs["observation", "memory_status"][index, 0] == 0
    assert inputs["observation", "raw_knownness"][index, tensor.FEATURES["energy"]] == 0
    assert not inputs["observation", "current_target_mask"][index]


@pytest.mark.parametrize("change", ["hidden_enemy", "offscreen_enemy", "cloaked_enemy", "fog", "future_memory", "missing_minimap"])
def test_live_encoder_keeps_permitted_visibility_and_causality_gates(change):
    frame = mixed_sample()["frame"]
    enemy = next(row for row in frame["entities"] if row["owner"] == 4)
    if change == "hidden_enemy":
        enemy["is_visible"] = False
    elif change == "offscreen_enemy":
        enemy["is_on_screen"] = False
    elif change == "cloaked_enemy":
        enemy["cloak_state"] = 1
    elif change == "fog":
        frame["spatial"]["screen_visibility"] = np.zeros((72, 128)).tolist()
    elif change == "future_memory":
        frame["known_own"][-1]["last_seen_loop"] = frame["game_loop"] + 1
    else:
        del frame["feature_layers"]["minimap_renders"]["pathable"]
    with pytest.raises(tensor.TensorError):
        tensor.tensorize_observation(frame, REGISTRY, MAPPING, CONFIG)


def test_no_enemy_private_or_stale_tactical_fields_reach_live_tensors():
    frame = mixed_sample()["frame"]
    before = tensor.tensorize_observation(frame, REGISTRY, MAPPING, CONFIG)
    enemy = next(row for row in frame["entities"] if row["owner"] == 4)
    enemy.update(energy=999, orders=[{"ability_id": 882}], cargo_space_taken=50, weapon_cooldown=77)
    frame["known_own"][-1].update(health=9999, orders=[{"ability_id": 23}], energy=1)
    after = tensor.tensorize_observation(frame, REGISTRY, MAPPING, CONFIG)
    for key in before["inputs"]:
        np.testing.assert_array_equal(before["inputs"][key], after["inputs"][key], strict=True)


def test_camera_and_planned_build_masks_keep_separate_observable_meanings():
    frame = mixed_sample()["frame"]
    encoded = tensor.tensorize_observation(frame, REGISTRY, MAPPING, CONFIG)
    camera = encoded["inputs"]["observation", "camera"]
    planned = encoded["inputs"]["observation", "planned_build_mask"]
    assert 0 < camera.sum() < planned.sum()
    frame["feature_layers"]["minimap_renders"]["visibility_map"] = image(np.ones((64, 64), np.uint8))
    fogged = tensor.tensorize_observation(frame, REGISTRY, MAPPING, CONFIG)
    assert fogged["inputs"]["observation", "planned_build_mask"].sum() == 0
    np.testing.assert_array_equal(camera, fogged["inputs"]["observation", "camera"])


def test_empty_current_screen_and_whole_entity_overflow_remain_explicit():
    frame = mixed_sample()["frame"]
    frame["entities"] = []
    encoded = tensor.tensorize_observation(frame, REGISTRY, MAPPING, CONFIG)
    assert encoded["metadata"]["current_entity_count"] == 0
    assert encoded["inputs"]["observation", "unit_counts_bow"].sum() == 0
    assert encoded["inputs"]["observation", "current_target_mask"].sum() == 0
    with pytest.raises(tensor.TensorError, match="overflow"):
        tensor.tensorize_observation(mixed_sample()["frame"], REGISTRY, MAPPING, tensor.TensorConfig(max_entities=2))
