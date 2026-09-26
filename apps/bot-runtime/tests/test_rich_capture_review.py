"""Tiny real protocol records exercise the offline review; no SC2 process."""
import base64
from copy import deepcopy
import gzip
import hashlib
import json

import pytest
from s2clientprotocol import common_pb2 as common
from s2clientprotocol import raw_pb2 as raw
from s2clientprotocol import sc2api_pb2 as api
from s2clientprotocol import spatial_pb2 as spatial
from s2clientprotocol import ui_pb2 as ui

from pluto_sc2.rich_actions import serialize_action
from scripts.review_rich_capture import main, review_capture, write_review


def context(loop=8):
    return {"game_loop": loop, "camera": [10, 10], "entities": [
        {"tag": 101, "type_name": "PROBE", "owner": 1, "is_visible": True, "is_on_screen": True},
        {"tag": 201, "type_name": "MARINE", "owner": 4, "is_visible": True, "is_on_screen": True,
         "cloak_state": raw.NotCloaked}], "known_own": [], "selection": [101], "selection_complete": True,
        "ui": {"single": {"unit": {"unit_type": 84}}}, "available_abilities": [{"ability_id": 881}],
        "public_abilities": {"881": {"id": 881, "name": "ProtossBuildPylon", "target": 2,
                                    "available": True, "current_available": True},
                             "23": {"id": 23, "name": "Attack", "target": 4,
                                    "available": True, "current_available": True}},
        "spatial": {"screen_size": [8, 8], "minimap_size": [8, 8], "camera_width": 8,
                    "screen_visibility": [[2] * 8 for _ in range(8)],
                    "minimap_visibility": [[2] * 8 for _ in range(8)]}}


def commands():
    build = api.Action(game_loop=9, action_raw=raw.ActionRaw(unit_command=raw.ActionRawUnitCommand(
        ability_id=881, unit_tags=[101], queue_command=True,
        target_world_space_pos=common.Point2D(x=11, y=10))))
    attack = api.Action(game_loop=9, action_raw=raw.ActionRaw(unit_command=raw.ActionRawUnitCommand(
        ability_id=23, unit_tags=[101], target_unit_tag=201, queue_command=False)))
    camera = api.Action(game_loop=9, action_raw=raw.ActionRaw(camera_move=raw.ActionRawCameraMove(
        center_world_space=common.Point(x=15, y=15))))
    army = api.Action(game_loop=9, action_ui=ui.ActionUI(select_army=ui.ActionSelectArmy(selection_add=False)))
    selection = api.Action(game_loop=9, action_feature_layer=spatial.ActionSpatial(
        unit_selection_point=spatial.ActionSpatialUnitSelectionPoint(
            type=1, selection_screen_coord=common.PointI(x=4, y=4))))
    dual = api.Action()
    dual.CopyFrom(build)
    dual.action_feature_layer.unit_command.CopyFrom(spatial.ActionSpatialUnitCommand(
        ability_id=881, target_screen_coord=common.PointI(x=5, y=4), queue_command=True))
    return [build, attack, camera, army, selection, dual]


def write_lines(path, rows):
    with gzip.open(path, "wt", encoding="utf-8") as stream:
        for row in rows:
            stream.write(json.dumps(row) + "\n")


def capture(tmp_path, *, records=None, frames=None, partition="validation"):
    directory = tmp_path / "capture"
    directory.mkdir()
    records = records if records is not None else [serialize_action(action, context()) for action in commands()]
    frames = frames if frames is not None else [context(0), context(8), context(9)]
    write_lines(directory / "frames.jsonl.gz", frames)
    write_lines(directory / "actions.jsonl.gz", records)
    (directory / "game-data.json").write_text(json.dumps({"abilities": context()["public_abilities"]}), encoding="utf-8")
    (directory / "capture.json").write_text(json.dumps({"status": "captured_prefix", "partition": partition,
        "replay": {"replay_id": "pinned-replay"}, "full_replay": False,
        "eligible_for_training": False, "trained_weights": False,
        "counters": {"frames": len(frames), "actions": len(records)}}), encoding="utf-8")
    return directory


def test_streamed_native_records_preserve_all_views_and_arguments_without_admitting_training(tmp_path):
    directory = capture(tmp_path)
    before = {path.name: path.read_bytes() for path in directory.iterdir()}
    review = review_capture(directory)
    assert review["fidelity_checks_passed"] and not review["eligible_for_training"]
    assert not review["semantic_reproduction_verified"] and not review["trained_models"]
    assert review["partition"]["source_partition"] == "validation"
    counts = review["counts"]
    assert counts["actions"] == counts["native_payload_matches_wire"] == counts["wire_sha_verified"] == 6
    assert counts["strict_preceding_references_verified"] == 6
    assert counts["command_components"] == 4 and counts["multi_view_command_actions"] == 1
    assert counts["ui_components"] == counts["camera_components"] == counts["selection_components"] == 1
    assert counts["point_targets"] == 3 and counts["unit_tag_targets"] == 1
    assert counts["queued_commands"] == 3 and counts["native_source_tag_entries"] == 3
    assert review["abilities"]["881"] == 3 and review["ability_action_counts"]["881"] == 2
    sample = review["early_build_samples"][0]
    assert sample["native_arguments"]["unit_tags"] == ["101"]
    assert sample["command_matches_native_fields"] and sample["payload_matches_native_wire"]
    assert len(review["multi_view_command_samples"][0]["views"]) == 2
    assert {path.name: path.read_bytes() for path in directory.iterdir()} == before


def test_exclusion_reason_totals_overlap_instead_of_counting_additional_actions(tmp_path):
    conflicting = commands()[-1]
    conflicting.action_feature_layer.unit_command.ability_id = 23
    conflicting.action_feature_layer.unit_command.queue_command = False
    record = serialize_action(conflicting, context())
    review = review_capture(capture(tmp_path, records=[record]))
    assert review["counts"]["actions"] == review["counts"]["label_flag_excluded"] == 1
    assert sum(review["exclusion_reasons"].values()) > 1
    assert review["fidelity_checks_passed"]  # Preserved conflict, not an admitted positive label.


@pytest.mark.parametrize("mutation,error", [
    ("hash", "wire_sha_mismatch"), ("payload", "native_payload_mismatch"),
    ("source_label", "normalized_command_disagrees_with_native"),
    ("same_loop", "reference_not_strictly_preceding"),
    ("old_frame", "reference_not_latest_captured_preceding_frame"),
    ("missing_frame", "missing_preceding_frame_reference"),
    ("loop_label", "native_action_loop_mismatch"),
])
def test_corruption_or_noncausal_reference_fails_review(tmp_path, mutation, error):
    record = serialize_action(commands()[0], context())
    if mutation == "hash":
        record["wire_sha256"] = "0" * 64
    elif mutation == "payload":
        record["payload"]["action_raw"]["unit_command"]["ability_id"] = 23
    elif mutation == "source_label":
        record["components"][0]["command"]["source_tags"] = [999]
    elif mutation == "same_loop":
        record["preceding_game_loop"] = 9
    elif mutation == "old_frame":
        record["preceding_game_loop"] = 0
    elif mutation == "missing_frame":
        record["preceding_game_loop"] = None
    else:
        record["game_loop"] = 10
    result = review_capture(capture(tmp_path, records=[record]))
    assert not result["fidelity_checks_passed"] and result["errors"][error] == 1
    assert not result["eligible_for_training"]


def test_unframed_action_is_retained_and_excluded_without_fabricating_preceding_observation(tmp_path):
    record = serialize_action(commands()[0], context())
    action = commands()[0]
    action.game_loop = 0
    original = serialize_action(action, context())
    record.update({key: original[key] for key in ("payload", "game_loop", "wire_base64", "wire_sha256")})
    record.update(preceding_game_loop=None, components=[],
                  supervision={"trainable": False, "exclusion_reasons": ["no_preceding_observation"]})
    result = review_capture(capture(tmp_path, records=[record]))
    assert result["fidelity_checks_passed"]
    assert result["counts"]["actions_without_preceding_frame"] == 1
    assert result["counts"]["commands_without_normalized_label"] == 1
    assert result["counts"]["native_payload_matches_wire"] == 1


def test_unknown_native_fields_survive_wire_review(tmp_path):
    original = commands()[0]
    extended = api.Action.FromString(original.SerializeToString() + b"\xa0\x06\x01")
    record = serialize_action(extended, context())
    result = review_capture(capture(tmp_path, records=[record]))
    assert result["fidelity_checks_passed"]
    assert result["counts"]["actions_with_unknown_wire_fields"] == 1
    assert "unknown_protobuf_fields" in result["exclusion_reasons"]
    assert base64.b64decode(record["wire_base64"]).endswith(b"\xa0\x06\x01")


def test_missing_wire_hash_is_reported_unverified_not_invented(tmp_path):
    record = serialize_action(commands()[0], context())
    record.pop("wire_sha256")
    result = review_capture(capture(tmp_path, records=[record]))
    assert result["fidelity_checks_passed"] and result["counts"]["wire_sha_absent_unverified"] == 1
    assert result["counts"].get("wire_sha_verified", 0) == 0
    assert not result["early_build_samples"][0]["wire_sha_verified"]


@pytest.mark.parametrize("partitions,valid", [(["validation"], True), (["train"], False),
                                            (["train", "validation"], False), ([], False)])
def test_pinned_whole_replay_split_must_match_unique_source_membership(tmp_path, partitions, valid):
    directory = capture(tmp_path)
    split = tmp_path / "split.json"
    split.write_text(json.dumps({"split": {"matchups": {"PvT": {
        "train_replay_ids": ["pinned-replay"] if "train" in partitions else [],
        "validation_replay_ids": ["pinned-replay"] if "validation" in partitions else []}}}}), encoding="utf-8")
    if valid:
        result = review_capture(directory, split_summary=split)
        assert result["partition"]["membership_verified"] and not result["eligible_for_training"]
    else:
        with pytest.raises(ValueError, match="partition"):
            review_capture(directory, split_summary=split)


def test_cli_writes_only_new_reviews_and_refuses_overwrite(tmp_path):
    directory = capture(tmp_path)
    raw_hashes = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in directory.iterdir()}
    assert main([str(directory), "--max-samples", "1"]) == 0
    review = json.loads((directory / "review.json").read_text(encoding="utf-8"))
    assert len(review["early_build_samples"]) == 1
    assert not review["eligible_for_training"]
    for name, sha in raw_hashes.items():
        assert hashlib.sha256((directory / name).read_bytes()).hexdigest() == sha
    with pytest.raises(FileExistsError):
        write_review(directory, review)


@pytest.mark.parametrize("copies", [1, 2])
def test_direct_corpus_split_records_verify_membership_and_reject_duplicate_rows(tmp_path, copies):
    directory = capture(tmp_path)
    split = tmp_path / "split.json"
    split.write_text(json.dumps({"train_replay_ids": [], "validation_replay_ids": [
        {"replay_id": "pinned-replay", "matchup": "PvT"}] * copies}), encoding="utf-8")
    if copies == 1:
        assert review_capture(directory, split_summary=split)["partition"]["membership_verified"]
    else:
        with pytest.raises(ValueError, match="unique"):
            review_capture(directory, split_summary=split)


def test_active_capture_and_false_training_claims_are_not_approved(tmp_path):
    directory = capture(tmp_path)
    path = directory / "capture.json"
    metadata = json.loads(path.read_text(encoding="utf-8"))
    active = dict(metadata, status="running")
    path.write_text(json.dumps(active), encoding="utf-8")
    with pytest.raises(ValueError, match="close"):
        review_capture(directory)
    metadata["eligible_for_training"] = True
    path.write_text(json.dumps(metadata), encoding="utf-8")
    result = review_capture(directory)
    assert not result["fidelity_checks_passed"] and not result["eligible_for_training"]


def test_frame_order_error_is_bounded_and_does_not_hide_retained_actions(tmp_path):
    result = review_capture(capture(tmp_path, frames=[context(8), context(8)]))
    assert result["errors"]["frame_loop_not_strictly_increasing"] == 1
    assert result["counts"]["actions"] == 6


def test_artifact_hash_disagreement_fails_without_changing_raw_file(tmp_path):
    directory = capture(tmp_path)
    path = directory / "capture.json"
    metadata = json.loads(path.read_text(encoding="utf-8"))
    metadata["artifacts"] = {"actions.jsonl.gz": "0" * 64}
    path.write_text(json.dumps(metadata), encoding="utf-8")
    before = deepcopy((directory / "actions.jsonl.gz").read_bytes())
    result = review_capture(directory)
    assert result["errors"]["artifact_hash_mismatch:actions.jsonl.gz"] == 1
    assert (directory / "actions.jsonl.gz").read_bytes() == before
