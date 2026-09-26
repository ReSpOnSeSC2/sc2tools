"""Streaming derivation fixtures use real protos, never launch a replay engine."""
import base64
from copy import deepcopy
import gzip
import hashlib
import json
from pathlib import Path

import pytest
from s2clientprotocol import common_pb2 as common
from s2clientprotocol import raw_pb2 as raw
from s2clientprotocol import sc2api_pb2 as api
from s2clientprotocol import spatial_pb2 as spatial
from s2clientprotocol import ui_pb2 as ui

from pluto_sc2.rich_actions import serialize_action
from scripts.relabel_rich_capture import relabel_capture


def frame(loop=8):
    return {"game_loop": loop, "camera": [10, 10], "entities": [],
        "known_own": [{"tag": 101, "owner": 1, "type_name": "NEXUS", "last_seen_loop": 0}],
        "selection": [101], "selection_complete": True,
        "ui": {"production": {"unit": {"unit_type": 59, "player_relative": 1}, "build_queue": []}},
        "available_abilities": [{"ability_id": 1006}],
        "public_abilities": {
            "1006": {"id": 1006, "name": "NEXUSTRAIN_PROBE", "target": 1, "available": True, "current_available": True},
            "917": {"id": 917, "name": "GATEWAYTRAIN_STALKER", "target": 1, "available": True, "current_available": False},
            "23": {"id": 23, "name": "ATTACK", "target": 4, "available": True, "current_available": False}},
        "spatial": {"screen_size": [8, 8], "minimap_size": [8, 8], "camera_width": 8,
                    "screen_visibility": [[2] * 8 for _ in range(8)],
                    "minimap_visibility": [[2] * 8 for _ in range(8)]}}


def command(loop=9, *, paired=False, hidden=False):
    part = raw.ActionRawUnitCommand(ability_id=23 if hidden else 1006, unit_tags=[101], queue_command=False)
    if hidden:
        part.target_unit_tag = 999
    action = api.Action(game_loop=loop, action_raw=raw.ActionRaw(unit_command=part))
    if paired:
        action.action_feature_layer.unit_command.CopyFrom(spatial.ActionSpatialUnitCommand(
            ability_id=1006, queue_command=False))
    return action


def _write_rows(path, rows):
    with gzip.open(path, "wt", encoding="utf-8") as stream:
        for row in rows:
            stream.write(json.dumps(row) + "\n")


def setup_capture(tmp_path, *, actions=None, frames=None, records=None, partition="train"):
    source = tmp_path / "source"
    source.mkdir()
    frames = frames if frames is not None else [frame(0), frame(8), frame(9)]
    if records is None:
        actions = actions if actions is not None else [command()]
        records = [serialize_action(action, next(f for f in reversed(frames) if f["game_loop"] < action.game_loop))
                   for action in actions]
    _write_rows(source / "frames.jsonl.gz", frames)
    _write_rows(source / "actions.jsonl.gz", records)
    catalog = deepcopy(frame()["public_abilities"])
    for value in catalog.values():
        value.pop("current_available", None)
    (source / "game-data.json").write_text(json.dumps({"abilities": catalog}), encoding="utf-8")
    metadata = {"status": "captured_prefix", "partition": partition, "replay": {"replay_id": "pinned"},
        "full_replay": False, "eligible_for_training": False, "trained_weights": False,
        "counters": {"frames": len(frames), "actions": len(records)}, "artifacts": {}}
    for path in source.iterdir():
        metadata["artifacts"][path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
    (source / "capture.json").write_text(json.dumps(metadata), encoding="utf-8")
    split = tmp_path / "split.json"
    split.write_text(json.dumps({"train_replay_ids": ["pinned"] if partition == "train" else [],
        "validation_replay_ids": ["pinned"] if partition == "validation" else []}), encoding="utf-8")
    return source, tmp_path / "derived", split


def read_actions(directory):
    with gzip.open(directory / "actions.jsonl.gz", "rt", encoding="utf-8") as stream:
        return [json.loads(line) for line in stream]


def test_targetless_production_uses_observed_ui_and_preserves_all_source_bytes(tmp_path):
    source, output, split = setup_capture(tmp_path, actions=[command(paired=True)])
    before = {path.name: path.read_bytes() for path in source.iterdir()}
    state = relabel_capture(source, output, split_summary=split)
    records = read_actions(output)
    assert state["status"] == "relabelled_prefix" and state["partition"] == "train"
    assert not state["eligible_for_training"] and not state["trained_weights"]
    assert state["counters"]["wire_inputs_preserved"] == 1
    assert records[0]["supervision"]["trainable"]
    for key in ("wire_base64", "wire_sha256", "payload", "game_loop", "preceding_game_loop"):
        assert records[0][key] == read_actions(source)[0][key]
    assert {path.name: path.read_bytes() for path in source.iterdir()} == before
    assert (output / "frames.jsonl.gz").read_bytes() == before["frames.jsonl.gz"]
    assert (output / "game-data.json").read_bytes() == before["game-data.json"]
    manifest = json.loads((output / "source-manifest.json").read_text(encoding="utf-8"))
    assert manifest["partition"]["membership_verified"]
    assert set(manifest["source_code"]) == {"rich_actions.py", "relabel_rich_capture.py", "review_rich_capture.py"}


@pytest.mark.parametrize("change", ["paired_conflict", "hidden_target", "unknown_field", "selected_ability_missing"])
def test_unsafe_or_unresolved_native_records_remain_present_and_excluded(tmp_path, change):
    action = command(paired=change == "paired_conflict", hidden=change == "hidden_target")
    frames = [frame(0), frame(8), frame(9)]
    if change == "paired_conflict":
        action.action_feature_layer.unit_command.ability_id = 917
    if change == "unknown_field":
        action = api.Action.FromString(action.SerializeToString() + b"\xa0\x06\x01")
    if change == "selected_ability_missing":
        frames[1]["available_abilities"] = []
    source, output, split = setup_capture(tmp_path, actions=[action], frames=frames)
    relabel_capture(source, output, split_summary=split)
    original, derived = read_actions(source)[0], read_actions(output)[0]
    assert not derived["supervision"]["trainable"]
    assert derived["wire_base64"] == original["wire_base64"]
    assert base64.b64decode(derived["wire_base64"]) == action.SerializeToString(deterministic=True)


def test_intervening_ui_invalidates_same_frame_selection_then_new_frame_restores_it(tmp_path):
    ui_action = api.Action(game_loop=9, action_ui=ui.ActionUI(select_army=ui.ActionSelectArmy(selection_add=False)))
    actions = [ui_action, command(9), command(10)]
    source, output, split = setup_capture(tmp_path, actions=actions, frames=[frame(0), frame(8), frame(9), frame(10)])
    state = relabel_capture(source, output, split_summary=split)
    result = read_actions(output)
    assert result[0]["supervision"]["trainable"]
    assert not result[1]["supervision"]["trainable"]
    assert "offscreen_source_without_confirmed_targetless_production" in result[1]["supervision"]["exclusion_reasons"]
    assert result[2]["supervision"]["trainable"]
    assert state["counters"]["contexts_with_selection_invalidated"] == 1


def test_no_map_dimensions_are_inferred_to_enable_paired_camera(tmp_path):
    action = api.Action(game_loop=9, action_raw=raw.ActionRaw(camera_move=raw.ActionRawCameraMove(
        center_world_space=common.Point(x=10, y=10))), action_feature_layer=spatial.ActionSpatial(
        camera_move=spatial.ActionSpatialCameraMove(center_minimap=common.PointI(x=4, y=4))))
    source, output, split = setup_capture(tmp_path, actions=[action])
    relabel_capture(source, output, split_summary=split)
    assert not read_actions(output)[0]["supervision"]["trainable"]
    with gzip.open(output / "frames.jsonl.gz", "rt", encoding="utf-8") as stream:
        assert all("map_size" not in json.loads(line) for line in stream)


@pytest.mark.parametrize("mutation", ["wire_hash", "payload", "nonlatest_reference", "same_loop_reference", "action_order"])
def test_corruption_or_noncausal_order_fails_without_modifying_source(tmp_path, mutation):
    actions = [command(9), command(10)]
    records = [serialize_action(actions[0], frame(8)), serialize_action(actions[1], frame(9))]
    if mutation == "wire_hash":
        records[0]["wire_sha256"] = "0" * 64
    elif mutation == "payload":
        records[0]["payload"]["action_raw"]["unit_command"]["ability_id"] = 23
    elif mutation == "nonlatest_reference":
        records[0]["preceding_game_loop"] = 0
    elif mutation == "same_loop_reference":
        records[0]["preceding_game_loop"] = 9
    else:
        records.reverse()
    source, output, split = setup_capture(tmp_path, records=records, frames=[frame(0), frame(8), frame(9), frame(10)])
    before = {path.name: path.read_bytes() for path in source.iterdir()}
    with pytest.raises(ValueError):
        relabel_capture(source, output, split_summary=split)
    assert {path.name: path.read_bytes() for path in source.iterdir()} == before
    assert json.loads((output / "capture.json").read_text())["status"] == "failed"


@pytest.mark.parametrize("destination", ["same", "child", "existing"])
def test_output_must_be_new_and_outside_original_capture(tmp_path, destination):
    source, output, split = setup_capture(tmp_path)
    if destination == "same":
        output = source
    elif destination == "child":
        output = source / "derived"
    else:
        output.mkdir()
    with pytest.raises(ValueError, match="new directory"):
        relabel_capture(source, output, split_summary=split)


def test_validation_replay_stays_validation_and_never_training_eligible(tmp_path):
    source, output, split = setup_capture(tmp_path, partition="validation")
    result = relabel_capture(source, output, split_summary=split)
    assert result["partition"] == "validation" and not result["eligible_for_training"]


def test_split_mismatch_rejected_before_new_directory_created(tmp_path):
    source, output, split = setup_capture(tmp_path)
    split.write_text(json.dumps({"train_replay_ids": [], "validation_replay_ids": ["pinned"]}))
    with pytest.raises(ValueError, match="partition"):
        relabel_capture(source, output, split_summary=split)
    assert not output.exists()


def test_source_frame_stream_order_is_validated_after_last_action(tmp_path):
    source, output, split = setup_capture(tmp_path, frames=[frame(0), frame(8), frame(9), frame(9)])
    with pytest.raises(ValueError, match="strictly increase"):
        relabel_capture(source, output, split_summary=split)
    assert json.loads((output / "capture.json").read_text())["status"] == "failed"


def test_loop_zero_input_is_preserved_without_a_fabricated_prior_frame(tmp_path):
    action = command(loop=0)
    record = serialize_action(action, frame())
    record.update(preceding_game_loop=None, components=[],
                  supervision={"trainable": False, "exclusion_reasons": ["no_preceding_observation"]})
    source, output, split = setup_capture(tmp_path, records=[record])
    state = relabel_capture(source, output, split_summary=split)
    regenerated = read_actions(output)[0]
    assert regenerated["preceding_game_loop"] is None
    assert regenerated["wire_base64"] == record["wire_base64"]
    assert regenerated["supervision"]["exclusion_reasons"] == ["no_preceding_observation"]
    assert state["counters"]["no_preceding_observation"] == 1


def test_raw_gzip_inputs_are_never_materialized_with_read_bytes(tmp_path, monkeypatch):
    source, output, split = setup_capture(tmp_path)
    original = Path.read_bytes

    def bounded_read(path):
        if path.suffix == ".gz":
            pytest.fail("Compressed streams must not be loaded into a single byte string")
        return original(path)

    monkeypatch.setattr(Path, "read_bytes", bounded_read)
    state = relabel_capture(source, output, split_summary=split)
    assert state["counters"]["frames"] == 3 and state["counters"]["actions"] == 1
