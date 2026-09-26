import base64
import gzip
import hashlib
import json

import pytest
from google.protobuf.json_format import MessageToDict
from s2clientprotocol import sc2api_pb2 as api

from pluto_sc2.rich_dataset import causal_pairs, export_dataset, file_hash, replay_partitions


def _record(loop, prior, *, selection=False):
    action = api.Action(game_loop=loop)
    if selection:
        action.action_ui.select_army.selection_add = False
    else:
        action.action_raw.unit_command.ability_id = 1006
        action.action_raw.unit_command.unit_tags.append(55)
    wire = action.SerializeToString(deterministic=True)
    return {"game_loop": loop, "preceding_game_loop": prior,
            "wire_base64": base64.b64encode(wire).decode(), "wire_sha256": hashlib.sha256(wire).hexdigest(),
            "payload": MessageToDict(action, preserving_proto_field_name=True, use_integers_for_enums=True)}


def _frame(loop, tag=None):
    return {"game_loop": loop, "selection_complete": True, "selection": [55], "entities": [] if tag is None else [
        {"tag": tag, "owner": 3, "type_id": 342, "type_name": "VespeneGeyser", "position": [10, 20],
         "is_visible": True, "is_on_screen": True, "remaining_gas": 2250}]}


def _source(tmp_path, frames, actions):
    for filename, values in (("frames.jsonl.gz", frames), ("actions.jsonl.gz", actions)):
        with gzip.open(tmp_path / filename, "wt", encoding="utf-8") as stream:
            for value in values:
                stream.write(json.dumps(value) + "\n")
    return tmp_path


def test_neutral_memory_uses_only_prior_permitted_sightings_and_no_live_resource_fields(tmp_path):
    source = _source(tmp_path, [_frame(0, 1), _frame(8), _frame(9, 2), _frame(10)],
                     [_record(9, 8), _record(10, 9)])
    first, second = list(causal_pairs(source))
    assert first[2]["game_loop"] == 8
    assert first[2]["known_neutral"] == [{"tag": 1, "owner": 3, "type_id": 342,
        "type_name": "VespeneGeyser", "position": [10, 20], "last_seen_loop": 0}]
    assert [row["tag"] for row in second[2]["known_neutral"]] == [1, 2]
    assert "remaining_gas" not in second[2]["known_neutral"][1]


def test_same_frame_ui_invalidates_selection_without_changing_original_frames(tmp_path):
    original = [_frame(0), _frame(8), _frame(9), _frame(10)]
    source = _source(tmp_path, original, [_record(9, 8, selection=True), _record(9, 8), _record(10, 9)])
    contexts = [row[2] for row in causal_pairs(source)]
    assert [row["selection_complete"] for row in contexts] == [True, False, True]
    assert all(row["selection_complete"] for row in original)


@pytest.mark.parametrize("prior", [0, 9, 10])
def test_nonlatest_equal_or_future_references_are_rejected(tmp_path, prior):
    source = _source(tmp_path, [_frame(0), _frame(8), _frame(9), _frame(10)], [_record(9, prior)])
    with pytest.raises(ValueError, match="latest strictly preceding"):
        list(causal_pairs(source))


def test_native_provenance_corruption_fails_before_a_sample_can_be_admitted(tmp_path):
    action = _record(9, 8)
    action["payload"]["action_raw"]["unit_command"]["ability_id"] = 917
    source = _source(tmp_path, [_frame(0), _frame(8), _frame(9)], [action])
    with pytest.raises(ValueError, match="Native action wire"):
        list(causal_pairs(source))


def test_unknown_or_invisible_neutral_entities_do_not_enter_memory(tmp_path):
    a, b = _frame(0, 1), _frame(8, 2)
    a["entities"][0]["is_visible"] = False
    b["entities"][0]["owner"] = 4
    source = _source(tmp_path, [a, b, _frame(9)], [_record(9, 8)])
    assert list(causal_pairs(source))[0][2]["known_neutral"] == []


def test_both_player_perspectives_are_bound_to_original_replay_partition(tmp_path):
    path = tmp_path / "split.json"
    path.write_text(json.dumps({"train_replay_ids": [{"replay_id": "one"}],
                               "validation_replay_ids": [{"replay_id": "two"}]}))
    assert replay_partitions(path) == {"one": "train", "two": "validation"}
    path.write_text(json.dumps({"train_replay_ids": ["one"], "validation_replay_ids": ["one"]}))
    with pytest.raises(ValueError, match="unique whole-game"):
        replay_partitions(path)


def test_nonmonotonic_action_timestamps_are_rejected(tmp_path):
    source = _source(tmp_path, [_frame(0), _frame(8), _frame(9), _frame(10)],
                     [_record(10, 9), _record(9, 8)])
    with pytest.raises(ValueError, match="nondecreasing"):
        list(causal_pairs(source))


def _complete_capture(tmp_path, *, player=1, partition="train", declared_actions=1):
    from pluto_sc2.rich_actions import serialize_action

    source = tmp_path / f"capture-{player}"
    source.mkdir()
    frame = {**_frame(8), "camera": [20, 20], "spatial": {
        "map_size": [100, 100], "screen_size": [128, 72], "minimap_size": [64, 64],
        "camera_width": 24, "camera_height": 13.5}}
    action = api.Action(game_loop=9)
    action.action_raw.camera_move.center_world_space.x = 25
    action.action_raw.camera_move.center_world_space.y = 25
    record = serialize_action(action, frame)
    _source(source, [frame, {**frame, "game_loop": 9}], [record])
    for name, value in (("game-data.json", {"abilities": {}}), ("game-info.json", {})):
        (source / name).write_text(json.dumps(value), encoding="utf-8")
    meta = {"status": "captured_full_replay", "full_replay": True, "engine_start_workers": 8,
            "original_replay_unchanged": True, "replay": {"replay_id": "one"}, "player_id": player,
            "partition": partition, "counters": {"actions": declared_actions},
            "artifacts": {name: file_hash(source / name) for name in (
                "game-data.json", "game-info.json", "frames.jsonl.gz", "actions.jsonl.gz")}}
    (source / "capture.json").write_text(json.dumps(meta), encoding="utf-8")
    return source


def _split(tmp_path):
    split = tmp_path / "split.json"
    split.write_text(json.dumps({"train_replay_ids": ["one"], "validation_replay_ids": []}), encoding="utf-8")
    return split


def test_complete_export_preserves_both_perspectives_and_native_sources(tmp_path):
    sources = [_complete_capture(tmp_path, player=player) for player in (1, 2)]
    before = [{p.name: file_hash(p) for p in source.iterdir()} for source in sources]
    output = tmp_path / "derivative"
    manifest = export_dataset(sources, output, split_summary=_split(tmp_path))
    assert manifest["status"] == "complete" and manifest["counts"]["samples"] == 2
    assert manifest["replay_partitions"] == {"one": "train"}
    assert manifest["models_trained"] is False and manifest["live_decoder_verified"] is False
    assert manifest["training_scope"] == "bounded_imitation_diagnostic"
    assert {"rich_dataset.py", "rich_intents.py", "rich_actions.py"} == set(manifest["source_code"])
    assert before == [{p.name: file_hash(p) for p in source.iterdir()} for source in sources]
    with gzip.open(output / "samples.jsonl.gz", "rt", encoding="utf-8") as stream:
        samples = [json.loads(line) for line in stream]
    assert {row["player_id"] for row in samples} == {1, 2}
    assert all(row["action_loop"] > row["frame"]["game_loop"] for row in samples)


def test_declared_native_count_mismatch_keeps_failed_derivative_ineligible(tmp_path):
    source = _complete_capture(tmp_path, declared_actions=2)
    output = tmp_path / "derivative"
    with pytest.raises(ValueError, match="Native action count"):
        export_dataset([source], output, split_summary=_split(tmp_path))
    manifest = json.loads((output / "manifest.json").read_text())
    assert manifest["status"] == "failed" and manifest["eligible_for_training"] is False


@pytest.mark.parametrize("fault", ["duplicate", "partition", "tampered"])
def test_unsafe_capture_is_rejected_before_output_is_created(tmp_path, fault):
    source = _complete_capture(tmp_path, partition="validation" if fault == "partition" else "train")
    if fault == "tampered":
        (source / "game-info.json").write_text('{"tampered":true}')
    output = tmp_path / "derivative"
    with pytest.raises(ValueError):
        export_dataset([source] * (2 if fault == "duplicate" else 1), output, split_summary=_split(tmp_path))
    assert not output.exists()
