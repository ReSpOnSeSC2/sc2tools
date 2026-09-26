"""Meaningful causal, privacy and label-mask boundaries for the NumPy bridge."""
import base64
from copy import deepcopy
import gzip
import hashlib
import json

import numpy as np
import pytest

from pluto_sc2.alphastar_tensor import (
    FEATURES, TensorConfig, TensorError, decode_image, resolve_function,
    tensorize_sample, validate_supervised_masks, world_pixel,
)
from scripts.train_alphastar_replay import (
    OPENING_ABILITIES, aggregate_metrics, read_dataset, select_diagnostic_examples,
    teacher_forced_metrics, train_rows,
)


REGISTRY = [
    {"id": 0, "name": "raw_move_camera", "ability_id": 0, "args": ["world"]},
    {"id": 1, "name": "Train_Probe_quick", "ability_id": 1006, "args": ["queued", "unit_tags"]},
    {"id": 2, "name": "Attack_Attack_unit", "ability_id": 23, "args": ["queued", "unit_tags", "target_unit_tag"]},
    {"id": 3, "name": "Build_CyberneticsCore_pt", "ability_id": 894, "args": ["queued", "unit_tags", "world"]},
    {"id": 4, "name": "Build_Assimilator_unit", "ability_id": 882, "args": ["queued", "unit_tags", "target_unit_tag"]},
]


def image(values, bits=8):
    values = np.asarray(values)
    raw = (np.packbits(values.astype(np.uint8).reshape(-1)).tobytes() if bits == 1
           else values.astype({8: np.uint8, 16: "<u2", 32: "<u4"}[bits]).tobytes())
    return {"size": {"x": values.shape[1], "y": values.shape[0]}, "bits_per_pixel": bits,
            "data": base64.b64encode(raw).decode()}


def entity(tag=4294967300, owner=1, position=None):
    return {"tag": tag, "owner": owner, "type_id": 84, "type_name": "Probe", "position": position or [50., 50.],
            "is_visible": True, "is_on_screen": True, "cloak_state": 3, "is_selected": True,
            "health": 20., "health_max": 20., "shield": 20., "shield_max": 20.,
            "energy": 50., "energy_max": 200., "build_progress": 1., "orders": [], "weapon_cooldown": 0.}


def example():
    own = entity()
    layers = {name: image(np.ones((64, 64), np.uint8) * value) for name, value in
              dict(height_map=8, visibility_map=2, creep=0, player_relative=1, alerts=0, pathable=1, buildable=1).items()}
    return {"replay_id": "a" * 64, "player_id": 1, "partition": "train", "action_ordinal": 7, "action_loop": 101,
            "preceding_loop": 100, "intent": {"admitted": True, "kind": "unit_command", "ability_id": 1006,
                "queued": False, "source_tags": [own["tag"]], "target": None,
                "supervision": {"execution_class": "immediate", "timing": False, "repeat": False}},
            "frame": {"schema": "protoss-rich-replay-v1", "game_loop": 100, "camera": [50., 50.],
                "entities": [own], "known_own": [{"tag": own["tag"], "owner": 1, "type_id": 84,
                    "type_name": "Probe", "position": own["position"], "last_seen_loop": 100}],
                "selection": [own["tag"]], "selection_complete": True, "hud": {"minerals": 50, "vespene": 0},
                "spatial": {"map_size": [100, 120], "camera_width": 24., "camera_height": 13.5,
                            "screen_visibility": np.full((72, 128), 2).tolist()},
                "feature_layers": {"minimap_renders": layers}}}


def encode(row=None, **kwargs):
    return tensorize_sample(row or example(), REGISTRY, {84: 7}, **kwargs)


def test_real_values_and_dtype_not_default_fixture():
    result = encode()
    raw = result["inputs"]["observation", "raw_units"]
    assert raw.dtype == np.int32
    assert raw[0, FEATURES["health"]] == 20
    assert raw[0, FEATURES["energy_ratio"]] == 63
    assert raw[0, FEATURES["tag"]] == 1  # 64-bit identity is not truncated into int32.
    assert result["metadata"]["entity_tags"] == [4294967300]
    assert result["labels"]["unit_tags"].tolist()[:3] == [0, 128, 128]
    assert result["active_heads"]["unit_tags"] and not result["active_heads"]["repeat"]
    assert result["inputs"]["observation", "minimap_visibility_map"].dtype == np.uint8


def test_unknown_compact_type_keeps_row_presence_and_player_two_is_still_self():
    row = example()
    row["player_id"] = 2
    row["frame"]["hud"]["player_id"] = 2
    row["frame"]["entities"][0]["type_id"] = 999999
    result = encode(row)
    raw = result["inputs"]["observation", "raw_units"]
    assert raw[0, FEATURES["unit_type"]] == 0
    assert result["inputs"]["observation", "raw_knownness"][0, FEATURES["unit_type"]] == 0
    assert raw[0, FEATURES["alliance"]] == 1
    assert raw[0, FEATURES["tag"]] > 0
    assert result["labels"]["unit_tags"][0] == 0
    assert result["metadata"]["player_id"] == 2


def test_missing_hud_is_unknown_and_observed_zero_is_known():
    inputs = encode()["inputs"]
    assert inputs["observation", "player_knownness"][:4].tolist() == [0, 1, 1, 0]
    assert inputs["observation", "player"][2] == 0
    assert inputs["observation", "raw_knownness"][0, FEATURES["is_powered"]] == 0


def test_privileged_enemy_fields_cannot_change_tensors():
    row = example()
    row["frame"]["entities"].append(entity(99, 4, [51, 50]))
    a = encode(row)
    enemy = row["frame"]["entities"][-1]
    enemy.update(energy=199, energy_max=200, orders=[{"ability_id": 1006}], cargo_space_taken=8,
                 assigned_harvesters=77, weapon_cooldown=32)
    b = encode(row)
    for key in a["inputs"]:
        np.testing.assert_array_equal(a["inputs"][key], b["inputs"][key])


@pytest.mark.parametrize("change", ["offscreen", "hidden", "cloaked", "fog_pixel"])
def test_rejects_enemy_without_current_screen_proof(change):
    row = example()
    enemy = entity(99, 4, [51, 50])
    row["frame"]["entities"].append(enemy)
    if change == "offscreen":
        enemy["is_on_screen"] = False
    elif change == "hidden":
        enemy["is_visible"] = False
    elif change == "cloaked":
        enemy["cloak_state"] = 1
    else:
        row["frame"]["spatial"]["screen_visibility"] = np.zeros((72, 128)).tolist()
    with pytest.raises(TensorError, match="confirmed current"):
        encode(row)


def test_selected_stale_own_memory_has_age_not_fresh_tactical_fields():
    row = example()
    row["frame"]["entities"] = []
    row["frame"]["known_own"][0].update(last_seen_loop=50, health=500, orders=[{"ability_id": 1006}])
    result = encode(row)
    inputs = result["inputs"]
    assert inputs["observation", "memory_status"][0].tolist() == pytest.approx([0, 50 / 2240])
    assert inputs["observation", "raw_knownness"][0, FEATURES["health"]] == 0
    assert inputs["observation", "raw_units"][0, FEATURES["health"]] == 0
    assert inputs["observation", "unit_counts_bow"].sum() == 0
    row["frame"]["selection_complete"] = False
    with pytest.raises(TensorError, match="current UI"):
        encode(row)


def test_assisted_geyser_memory_pointer_distinct_from_current_target():
    row = example()
    row["frame"]["known_neutral"] = [{"tag": 99, "owner": 3, "type_id": 342,
        "type_name": "VESPENEGEYSER", "position": [60, 60], "last_seen_loop": 20}]
    row["intent"].update(ability_id=882, target={"kind": "unit", "tag": 99})
    result = encode(row)
    assert result["labels"]["target_unit_tag"] == 1
    assert result["inputs"]["observation", "known_geyser_mask"].tolist()[:2] == [False, True]
    assert result["inputs"]["observation", "current_target_mask"].tolist()[:2] == [True, False]
    row["intent"]["ability_id"] = 23
    with pytest.raises(TensorError, match="not current"):
        encode(row)


def test_stale_source_labels_do_not_leak_into_observation_knownness():
    row = example()
    second = deepcopy(row["frame"]["known_own"][0])
    second.update(tag=88, position=[52, 50], last_seen_loop=50)
    row["frame"]["known_own"].append(second)
    row["frame"]["entities"] = []
    row["frame"]["selection"].append(88)
    a = encode(row)
    row["intent"]["source_tags"] = [88]
    b = encode(row)
    for key in a["inputs"]:
        if isinstance(key, tuple) and key[0] == "observation":
            np.testing.assert_array_equal(a["inputs"][key], b["inputs"][key])


def test_build_intent_legality_is_label_independent_and_never_expands_viewport():
    row = example()
    row["intent"].update(ability_id=894, target={"kind": "world_point", "point": [65, 70]})
    a = encode(row)
    row["intent"]["target"]["point"] = [68, 73]
    b = encode(row)
    for name in ("camera", "planned_build_mask"):
        np.testing.assert_array_equal(a["inputs"]["observation", name], b["inputs"]["observation", name])
    assert a["inputs"]["observation", "planned_build_mask"].sum() > a["inputs"]["observation", "camera"].sum()
    row["frame"]["feature_layers"]["minimap_renders"]["visibility_map"] = image(np.ones((64, 64), np.uint8))
    assert encode(row)["inputs"]["observation", "planned_build_mask"].sum() == 0


@pytest.mark.parametrize("field,value", [("preceding_loop", 101), ("action_loop", 100)])
def test_never_uses_equal_or_future_frame(field, value):
    row = example()
    row[field] = value
    with pytest.raises(TensorError, match="strictly before"):
        encode(row)


def test_future_memory_and_entity_overflow_fail_closed():
    row = example()
    row["frame"]["known_own"][0]["last_seen_loop"] = 101
    with pytest.raises(TensorError, match="last_seen_loop"):
        encode(row)
    row = example()
    row["frame"]["entities"] += [entity(11), entity(12)]
    with pytest.raises(TensorError, match="overflow"):
        encode(row, config=TensorConfig(max_entities=2))


def test_unmapped_ability_never_generalized_or_guessed():
    row = example()["intent"]
    row["ability_id"] = 99999
    with pytest.raises(TensorError, match="mapping count 0"):
        resolve_function(row, REGISTRY)
    row["ability_id"] = 1006
    with pytest.raises(TensorError, match="mapping count 2"):
        resolve_function(row, REGISTRY + [REGISTRY[1]])


@pytest.mark.parametrize("bits", [1, 8, 16, 32])
def test_native_image_layout_preserved(bits):
    values = np.asarray([[0, 1, 0], [1, 0, 1]])
    np.testing.assert_array_equal(decode_image(image(values, bits)), values)


def test_absent_image_not_fabricated():
    row = example()
    del row["frame"]["feature_layers"]["minimap_renders"]["buildable"]
    with pytest.raises(TensorError, match="no fabricated"):
        encode(row)


def test_world_grid_is_isotropic_and_y_flipped():
    assert world_pixel([60, 60], [100, 120]) == (128, 128)
    assert world_pixel([0, 119], [100, 120]) == (0, 2)
    assert world_pixel([99, 0], [100, 120]) == (211, 255)
    with pytest.raises(TensorError, match="outside"):
        world_pixel([100, 0], [100, 120])


def outputs_for(result):
    outputs = {}
    for name, action in result["labels"].items():
        outputs["argument_masks", name] = np.asarray([[result["active_heads"][name]]])
        outputs["action", name] = action.reshape((1, 1) + action.shape)
        outputs["masks", name] = (np.ones((1, 1, len(action), 129), bool) if name == "unit_tags"
                                 else np.ones((1, 1, 65536 if name == "world" else 129), bool))
        logits = np.zeros_like(outputs["masks", name], dtype=np.float32)
        if name == "unit_tags":
            logits[0, 0, np.arange(len(action)), action] = 10.
        else:
            logits.reshape(-1)[int(action)] = 10.
        outputs["logits", name] = logits
    return outputs


def test_upstream_silent_target_mask_is_hard_failure():
    result = encode()
    outputs = outputs_for(result)
    assert validate_supervised_masks(outputs, result)["unit_tags"] == 64
    outputs["masks", "unit_tags"][0, 0, 0, 0] = False
    with pytest.raises(TensorError, match="silently masked"):
        validate_supervised_masks(outputs, result)


def test_upstream_clipped_or_argument_masked_label_is_hard_failure():
    result = encode()
    outputs = outputs_for(result)
    outputs["action", "function"] = np.asarray([[0]])
    with pytest.raises(TensorError, match="changed function"):
        validate_supervised_masks(outputs, result)
    outputs = outputs_for(result)
    outputs["argument_masks", "unit_tags"][:] = False
    with pytest.raises(TensorError, match="argument is masked"):
        validate_supervised_masks(outputs, result)


def write_dataset(path, rows):
    path.mkdir()
    with gzip.open(path / "samples.jsonl.gz", "wt", encoding="utf-8") as stream:
        for row in rows:
            stream.write(json.dumps(row) + "\n")
    (path / "game-data.json").write_text('{"units":{},"abilities":{}}')
    manifest = {"schema": "alphastar-intent-dataset-v1", "status": "complete", "eligible_for_training": True,
                "training_scope": "bounded_imitation_diagnostic", "split_sha256": "f" * 64,
                "samples_sha256": hashlib.sha256((path / "samples.jsonl.gz").read_bytes()).hexdigest(),
                "game_data_sha256": hashlib.sha256((path / "game-data.json").read_bytes()).hexdigest(),
                "replay_partitions": {row["replay_id"]: row["partition"] for row in rows},
                "counts": {"samples": len(rows)}}
    (path / "manifest.json").write_text(json.dumps(manifest))
    return manifest


def test_training_reader_never_yields_validation(tmp_path):
    train = example()
    validation = deepcopy(train)
    validation.update(replay_id="b" * 64, partition="validation")
    path = tmp_path / "dataset"
    write_dataset(path, [train, validation])
    assert read_dataset(path)[3] == {"train": 1, "validation": 1}
    assert [row["replay_id"] for row in train_rows(path)] == ["a" * 64]


def test_validation_only_dataset_and_hash_change_rejected(tmp_path):
    validation = example()
    validation["partition"] = "validation"
    path = tmp_path / "dataset"
    write_dataset(path, [validation])
    with pytest.raises(TensorError, match="validation cannot train"):
        read_dataset(path)
    (path / "game-data.json").write_text("{}")
    with pytest.raises(TensorError, match="hash mismatch"):
        read_dataset(path)


def test_whole_replay_partition_collision_rejected(tmp_path):
    first = example()
    second = deepcopy(first)
    second.update(action_ordinal=8, partition="validation")
    path = tmp_path / "dataset"
    write_dataset(path, [first, second])
    with pytest.raises(TensorError, match="partition mismatch"):
        read_dataset(path)


def test_two_player_perspectives_may_share_action_ordinal(tmp_path):
    first = example()
    second = deepcopy(first)
    second["player_id"] = 2
    path = tmp_path / "dataset"
    write_dataset(path, [first, second])
    assert read_dataset(path)[3]["train"] == 2


def selection_example(ordinal, ability, name):
    return {"metadata": {"replay_id": "a", "player_id": 2, "action_ordinal": ordinal,
                         "function": {"ability_id": ability, "name": name}}}


def test_diagnostic_selector_covers_probes_stalker_camera_ahead_optional_cancel_spam():
    optional = [selection_example(i, 300 + i, f"Cancel_{i}") for i in range(20)]
    required = [selection_example(100 + i, ability, f"Opening_{ability}")
                for i, ability in enumerate(OPENING_ABILITIES)]
    camera = selection_example(200, 0, "raw_move_camera")
    gas_again = selection_example(201, 882, "Opening_882")
    by_function = {e["metadata"]["function"]["name"]: e for e in optional + required + [camera]}
    critical = [e for e in required if e["metadata"]["function"]["ability_id"] in (882, 894)] + [gas_again]
    selected = select_diagnostic_examples(critical, by_function, optional, 16)
    assert [e["metadata"]["function"]["ability_id"] for e in selected[:8]] == list(OPENING_ABILITIES)
    assert selected[8] is camera
    assert gas_again in selected
    assert len(selected) == 16
    assert len({e["metadata"]["action_ordinal"] for e in selected}) == 16
    with pytest.raises(TensorError, match="Increase max-samples"):
        select_diagnostic_examples(critical, by_function, optional, 8)


def test_teacher_forced_source_and_function_metrics_with_correct_predictions():
    example = encode()
    record = teacher_forced_metrics(outputs_for(example), example)
    assert record["metrics"] == {"function_accuracy": 1., "queued_accuracy": 1.,
                                  "source_token_accuracy": 1., "source_set_exact": 1.,
                                  "source_sequence_exact": 1.}
    assert aggregate_metrics([record])["function_accuracy"] == {"events": 1, "mean": 1.}


def test_teacher_forced_world_error_reports_grid_distance_not_fake_game_accuracy():
    row = example()
    row["intent"].update(ability_id=894, target={"kind": "world_point", "point": [50, 50]})
    tensor = encode(row)
    outputs = outputs_for(tensor)
    wanted = int(tensor["labels"]["world"])
    outputs["logits", "world"][:] = 0
    outputs["logits", "world"].reshape(-1)[wanted + 3 + 4 * 256] = 10
    metrics = teacher_forced_metrics(outputs, tensor)["metrics"]
    assert metrics["world_accuracy"] == 0
    assert metrics["world_grid_error"] == 5
