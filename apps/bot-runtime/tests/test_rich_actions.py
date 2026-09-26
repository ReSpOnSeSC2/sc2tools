"""Actual protobuf action fixtures; no fabricated replay training data."""
from copy import deepcopy
import base64
import json

from google.protobuf.json_format import MessageToDict
import pytest
from s2clientprotocol import common_pb2 as common
from s2clientprotocol import raw_pb2 as raw
from s2clientprotocol import sc2api_pb2 as api
from s2clientprotocol import spatial_pb2 as spatial
from s2clientprotocol import ui_pb2 as ui

from pluto_sc2.rich_actions import serialize_action, validate_action_record


def frame():
    return {
        "game_loop": 8, "camera": [10.0, 10.0],
        "entities": [
            {"tag": 101, "type": "NEXUS", "owner": raw.Self, "is_on_screen": True, "is_visible": True},
            {"tag": 102, "type": "STALKER", "owner": raw.Self, "is_on_screen": True, "is_visible": True},
            {"tag": 201, "type": "MARINE", "owner": raw.Enemy, "cloak_state": raw.NotCloaked,
             "is_on_screen": True, "is_visible": True},
        ],
        "known_own": [{"tag": 103, "type": "NEXUS", "owner": raw.Self, "last_seen_loop": 4}],
        "selection": [101], "selection_complete": True,
        "ui": {"groups": [{"control_group_index": 2, "count": 2}], "multi": {"units": [{}, {}]}},
        "public_abilities": {
            "23": {"id": 23, "name": "ATTACK", "target": 4, "available": True, "current_available": True},
            "1006": {"id": 1006, "name": "NEXUSTRAIN_PROBE", "target": 1, "available": True, "current_available": True},
            "917": {"id": 917, "name": "GATEWAYTRAIN_STALKER", "target": 1, "available": True, "current_available": True},
        },
        "spatial": {"screen_size": [8, 8], "minimap_size": [8, 8], "camera_width": 8.0,
                    "screen_visibility": [[2] * 8 for _ in range(8)],
                    "minimap_visibility": [[2] * 8 for _ in range(8)]},
    }


def command(*, ability=1006, tags=(101,), target=None, loop=9, queued=False):
    value = raw.ActionRawUnitCommand(ability_id=ability, unit_tags=tags, queue_command=queued)
    if isinstance(target, int):
        value.target_unit_tag = target
    elif target is not None:
        value.target_world_space_pos.CopyFrom(common.Point2D(x=target[0], y=target[1]))
    return api.Action(game_loop=loop, action_raw=raw.ActionRaw(unit_command=value))


def reasons(record):
    return record["supervision"]["exclusion_reasons"]


def test_native_round_trip_preserves_tags_queue_target_and_does_not_mutate_inputs():
    action = command(ability=23, tags=(102, 101), target=201, queued=True)
    context = frame()
    before_frame, before_wire = deepcopy(context), action.SerializeToString(deterministic=True)
    record = serialize_action(action, context)
    assert record["supervision"]["trainable"]
    assert record["components"][0]["command"] == {
        "ability_id": 23, "source_tags": [102, 101], "queue_command": True,
        "target": {"kind": "unit", "tag": 201},
    }
    assert record["payload"]["action_raw"]["unit_command"]["unit_tags"] == ["102", "101"]
    assert base64.b64decode(record["wire_base64"]) == before_wire
    validate_action_record(json.loads(json.dumps(record)), context)
    assert context == before_frame and action.SerializeToString(deterministic=True) == before_wire


@pytest.mark.parametrize("target", [101, 102, 103])
def test_attack_on_current_or_remembered_own_recipient_is_never_positive(target):
    record = serialize_action(command(ability=23, tags=(102,), target=target), frame())
    assert "friendly_attack_target" in reasons(record)
    assert record["components"][0]["command"]["target"]["tag"] == target


@pytest.mark.parametrize("change", ["fog", "offscreen", "missing", "cloak_unknown", "cloak_undetected"])
def test_enemy_recipient_requires_current_screen_and_detection(change):
    context = frame()
    enemy = context["entities"][-1]
    if change == "fog":
        enemy["is_visible"] = False
    elif change == "offscreen":
        enemy["is_on_screen"] = False
    elif change == "missing":
        context["entities"].pop()
    else:
        enemy["cloak_state"] = raw.CloakedUnknown if change == "cloak_unknown" else raw.Cloaked
    record = serialize_action(command(ability=23, tags=(102,), target=201), context)
    assert "unit_target_not_currently_visible_on_screen" in reasons(record)


def test_detected_cloaked_enemy_can_be_targeted():
    context = frame()
    context["entities"][-1]["cloak_state"] = raw.CloakedDetected
    assert serialize_action(command(ability=23, tags=(102,), target=201), context)["supervision"]["trainable"]


@pytest.mark.parametrize("loop", [0, 7, 8])
def test_actions_must_follow_prior_observation(loop):
    record = serialize_action(command(loop=loop), frame())
    assert "action_not_strictly_after_preceding_frame" in reasons(record)


def test_missing_timestamp_is_preserved_but_excluded():
    action = command()
    action.ClearField("game_loop")
    record = serialize_action(action, frame())
    assert record["game_loop"] is None
    assert not record["supervision"]["trainable"]


def test_multiple_commands_same_interval_each_retains_own_full_record():
    actions = [command(loop=9), command(loop=10, queued=True), command(loop=11)]
    records = [serialize_action(a, frame()) for a in actions]
    assert len(records) == 3 and [r["game_loop"] for r in records] == [9, 10, 11]
    assert len({r["wire_sha256"] for r in records}) == 3


def test_actual_selected_known_offscreen_nexus_targetless_production_is_kept():
    context = frame()
    context["selection"] = [103]
    record = serialize_action(command(tags=(103,)), context)
    assert record["supervision"]["trainable"]
    validate_action_record(record, context)


@pytest.mark.parametrize("change", ["not_selected", "incomplete", "wrong_producer", "ability_unknown", "ability_unavailable", "targeted"])
def test_remote_production_requires_all_current_selection_and_public_producer_proofs(change):
    context = frame()
    context["selection"] = [103]
    ability, target = 1006, None
    if change == "not_selected":
        context["selection"] = [101]
    elif change == "incomplete":
        context["selection_complete"] = False
    elif change == "wrong_producer":
        context["known_own"][0]["type"] = "PROBE"
    elif change == "ability_unknown":
        ability = 4135
    elif change == "ability_unavailable":
        context["public_abilities"]["1006"]["current_available"] = False
    else:
        ability, target = 23, 201
    record = serialize_action(command(ability=ability, tags=(103,), target=target), context)
    assert not record["supervision"]["trainable"]
    assert "offscreen_source_without_confirmed_targetless_production" in reasons(record)


def test_historical_visibility_flags_cannot_turn_cached_source_into_current():
    context = frame()
    context["known_own"][0].update(is_visible=True, is_on_screen=True)
    record = serialize_action(command(ability=23, tags=(103,), target=201), context)
    assert "offscreen_source_without_confirmed_targetless_production" in reasons(record)


def test_known_own_container_does_not_require_duplicate_owner_field():
    context = frame()
    context["known_own"][0].pop("owner")
    context["selection"] = [103]
    assert serialize_action(command(tags=(103,)), context)["supervision"]["trainable"]


def test_exact_raw_world_point_is_retained_when_currently_visible():
    record = serialize_action(command(ability=23, tags=(102,), target=(10.25, 11.5)), frame())
    assert record["components"][0]["command"]["target"] == {"kind": "world_point", "point": [10.25, 11.5]}
    assert record["supervision"]["trainable"]


@pytest.mark.parametrize("change", ["no_camera_width", "offscreen", "fog"])
def test_raw_world_point_visibility_is_not_guessed(change):
    context = frame()
    target = (10, 10)
    if change == "no_camera_width":
        context["spatial"].pop("camera_width")
    elif change == "offscreen":
        target = (30, 30)
    else:
        context["spatial"]["screen_visibility"][4][4] = 1
    assert not serialize_action(command(ability=23, tags=(102,), target=target), context)["supervision"]["trainable"]


def test_camera_exact_coordinate_into_fog_is_not_treated_as_enemy_knowledge():
    context = frame()
    context["spatial"]["minimap_visibility"][2][3] = 0
    action = api.Action(game_loop=9, action_feature_layer=spatial.ActionSpatial(
        camera_move=spatial.ActionSpatialCameraMove(center_minimap=common.PointI(x=3, y=2))))
    record = serialize_action(action, context)
    assert record["supervision"]["trainable"]
    assert record["payload"]["action_feature_layer"]["camera_move"]["center_minimap"] == {"x": 3, "y": 2}


def test_raw_camera_exact_float_coordinates_preserved():
    action = api.Action(game_loop=9, action_raw=raw.ActionRaw(
        camera_move=raw.ActionRawCameraMove(center_world_space=common.Point(x=3.25, y=17.5, z=2))))
    record = serialize_action(action, frame())
    assert record["payload"]["action_raw"]["camera_move"]["center_world_space"] == {"x": 3.25, "y": 17.5, "z": 2.0}


def test_spatial_command_preserves_click_but_does_not_guess_picked_unit():
    action = api.Action(game_loop=9, action_feature_layer=spatial.ActionSpatial(
        unit_command=spatial.ActionSpatialUnitCommand(ability_id=23, target_screen_coord=common.PointI(x=4, y=4), queue_command=True)))
    record = serialize_action(action, frame())
    assert record["components"][0]["command"]["target"] == {"kind": "screen_point", "point": [4, 4]}
    assert "spatial_command_pick_resolution_unavailable" in reasons(record)


def test_spatial_targetless_production_uses_actual_complete_selection():
    context = frame()
    context["selection"] = [103]
    action = api.Action(game_loop=9, action_feature_layer=spatial.ActionSpatial(
        unit_command=spatial.ActionSpatialUnitCommand(ability_id=1006)))
    assert serialize_action(action, context)["supervision"]["trainable"]
    context["selection_complete"] = False
    assert "selection_incomplete" in reasons(serialize_action(action, context))


def test_rectangle_selection_preserves_all_rectangles_and_add_flag():
    action = api.Action(game_loop=9, action_feature_layer=spatial.ActionSpatial(
        unit_selection_rect=spatial.ActionSpatialUnitSelectionRect(selection_add=True, selection_screen_coord=[
            common.RectangleI(p0=common.PointI(x=1, y=1), p1=common.PointI(x=4, y=4)),
            common.RectangleI(p0=common.PointI(x=5, y=5), p1=common.PointI(x=7, y=7)),
        ])))
    record = serialize_action(action, frame())
    assert record["supervision"]["trainable"]
    rect = record["payload"]["action_feature_layer"]["unit_selection_rect"]
    assert rect["selection_add"] and len(rect["selection_screen_coord"]) == 2


@pytest.mark.parametrize("operation", [ui.ActionControlGroup.Recall, ui.ActionControlGroup.Set,
                                       ui.ActionControlGroup.Append, ui.ActionControlGroup.SetAndSteal,
                                       ui.ActionControlGroup.AppendAndSteal])
def test_all_native_group_operations_are_preserved(operation):
    action = api.Action(game_loop=9, action_ui=ui.ActionUI(control_group=ui.ActionControlGroup(action=operation, control_group_index=2)))
    record = serialize_action(action, frame())
    assert record["supervision"]["trainable"]
    assert record["payload"]["action_ui"]["control_group"] == {"action": operation, "control_group_index": 2}


def test_unseen_group_recall_and_incomplete_group_store_excluded():
    action = api.Action(game_loop=9, action_ui=ui.ActionUI(control_group=ui.ActionControlGroup(action=1, control_group_index=7)))
    assert "control_group_not_observed_in_ui" in reasons(serialize_action(action, frame()))
    context = frame()
    context["selection_complete"] = False
    action.action_ui.control_group.action = 2
    assert "selection_incomplete" in reasons(serialize_action(action, context))


def test_native_f2_without_hidden_army_positions_is_usable():
    action = api.Action(game_loop=9, action_ui=ui.ActionUI(select_army=ui.ActionSelectArmy(selection_add=False)))
    context = frame()
    context["entities"] = []
    context["known_own"] = []
    record = serialize_action(action, context)
    assert record["supervision"]["trainable"]
    assert record["components"][0]["kind"] == "select_army"


@pytest.mark.parametrize("index,expected", [(0, True), (1, True), (-1, False), (2, False)])
def test_portrait_index_needs_actual_current_ui_panel(index, expected):
    action = api.Action(game_loop=9, action_ui=ui.ActionUI(multi_panel=ui.ActionMultiPanel(type=ui.ActionMultiPanel.SingleSelect, unit_index=index)))
    assert serialize_action(action, frame())["supervision"]["trainable"] is expected


def test_unknown_wire_field_preserved_even_when_json_omits_it():
    original = command().SerializeToString() + b"\xa0\x06\x01"
    action = api.Action.FromString(original)
    record = serialize_action(action, frame())
    assert "unknown_protobuf_fields" in reasons(record)
    recovered = api.Action.FromString(base64.b64decode(record["wire_base64"]))
    assert recovered.SerializeToString(deterministic=True) == action.SerializeToString(deterministic=True)
    validate_action_record(record, frame())


def test_unknown_enum_is_not_defaulted_into_positive_group_recall():
    action = api.Action(game_loop=9)
    action.action_ui.control_group.ParseFromString(b"\x08\x63\x10\x02")
    record = serialize_action(action, frame())
    assert "unknown_protobuf_fields" in reasons(record)
    assert not record["supervision"]["trainable"]


def test_combined_surfaces_are_lossless_but_not_guessed_as_single_action():
    action = command()
    action.action_ui.select_army.selection_add = True
    record = serialize_action(action, frame())
    assert len(record["components"]) == 2
    assert "empty_or_combined_action_semantics" in reasons(record)
    assert record["payload"] == MessageToDict(action, preserving_proto_field_name=True, use_integers_for_enums=True)


def test_render_action_is_preserved_with_explicit_coordinate_space_exclusion():
    action = api.Action(game_loop=9, action_render=spatial.ActionSpatial(
        camera_move=spatial.ActionSpatialCameraMove(center_minimap=common.PointI(x=2, y=3))))
    assert "render_coordinate_space_unverified" in reasons(serialize_action(action, frame()))


def test_chat_audit_is_not_gameplay_supervision():
    action = api.Action(game_loop=9, action_chat=api.ActionChat(message="gg", channel=api.ActionChat.Broadcast))
    record = serialize_action(action, frame())
    assert record["payload"]["action_chat"]["message"] == "gg"
    assert "chat_not_gameplay_supervision" in reasons(record)


@pytest.mark.parametrize("field", ["payload", "wire_sha256", "game_loop", "components", "supervision"])
def test_semantic_validator_rejects_record_tampering(field):
    record = serialize_action(command(), frame())
    if field == "supervision":
        record[field]["trainable"] = False
        record[field]["exclusion_reasons"] = ["invented"]
    elif field == "game_loop":
        record[field] += 1
    elif field in {"payload", "components"}:
        record[field] = {} if field == "payload" else []
    else:
        record[field] = "0" * 64
    with pytest.raises(ValueError):
        validate_action_record(record, frame())


def test_validation_rechecks_causal_frame_not_just_wire():
    record = serialize_action(command(ability=23, tags=(102,), target=201), frame())
    changed = frame()
    changed["entities"][-1]["is_visible"] = False
    with pytest.raises(ValueError, match="causal frame"):
        validate_action_record(record, changed)


@pytest.mark.parametrize("value", [None, {}, {"game_loop": True}, {"game_loop": -1}, {"game_loop": 1.5}])
def test_invalid_frame_rejected(value):
    with pytest.raises(ValueError):
        serialize_action(command(), value)


# Exact action bytes copied from immutable alphastar-rich-pilot-v1 capture.
# Contexts below retain the relevant native tags/camera/positions; unneeded
# visibility cells are conservatively zeroed, not claimed as captured pixels.
_NATIVE_WIRE = {
    "probe": "CgsKCQjuByCBgLCbEBIFCgMI7gc4Bw==",
    "pylon": "ChcKFQjxBhIKDQAADEMVAAAaQyCBgMCcEBILCgkI8QYSBAgtEAI42gU=",
    "gateway": "ChcKFQjzBhIKDQCAC0MVAIAXQyCBgJCcEBILCgkI8wYSBAgqEBA4ygk=",
    "smart": "ChYKFAgBGIGAoIgQIIGAkJwQIIGAsJwQEgoKCAgBEgQIQRAEOBU=",
    "chrono": "ChEKDwirHRiBgLCbECCBgLCbEBILCgkIqx0SBAhAEBo4mwE=",
    "camera": "Cg4SDAoKDQDAEUMVAIIVQxIIEgYKBAguEBA4BQ==",
}


def native_example(name):
    action = api.Action.FromString(base64.b64decode(_NATIVE_WIRE[name]))
    context = frame()
    context.update(game_loop=action.game_loop - 1, camera=[143.5, 147.7578125],
                   selection=[], selection_complete=False, known_own=[], ui={})
    context["spatial"].update(screen_size=[128, 72], minimap_size=[64, 64],
                              camera_width=24.0, camera_height=13.5,
                              screen_visibility=[[0] * 128 for _ in range(72)],
                              minimap_visibility=[[0] * 64 for _ in range(64)])
    context["public_abilities"].update({
        "1": {"id": 1, "name": "", "target": 4, "available": True, "current_available": True},
        "881": {"id": 881, "name": "ProtossBuild", "target": 2, "available": True},
        "883": {"id": 883, "name": "ProtossBuild", "target": 2, "available": True},
        "3755": {"id": 3755, "name": "ChronoBoostEnergyCost", "target": 3, "available": True},
    })
    context["public_abilities"]["1006"]["current_available"] = False
    context["entities"] = [
        {"tag": 4352376833, "type_name": "Nexus", "owner": raw.Self, "is_visible": True,
         "is_on_screen": True, "position": [143.5, 149.5], "radius": 2.75},
    ]
    sources = list(action.action_raw.unit_command.unit_tags)
    context["entities"] += [
        {"tag": tag, "type_name": "Probe", "owner": raw.Self, "is_visible": True, "is_on_screen": True}
        for tag in sources if tag != 4352376833
    ]
    if name in {"probe", "smart"}:
        context["camera"] = [145.75, 149.5078125]
    if name == "smart":
        context["entities"].append({"tag": 4312268801, "type_name": "MineralField", "owner": raw.Neutral,
                                    "is_visible": True, "is_on_screen": True,
                                    "position": [146.0, 155.5], "radius": 1.125})
    for x, y in {"pylon": [(45, 2)], "gateway": [(42, 16)], "smart": [(65, 4)], "chrono": [(64, 26)]}.get(name, []):
        context["spatial"]["screen_visibility"][y][x] = 2
    return action, context


@pytest.mark.parametrize("name,ability", [("probe", 1006), ("pylon", 881), ("gateway", 883), ("smart", 1), ("chrono", 3755)])
def test_actual_native_dual_views_become_one_verified_canonical_action(name, ability):
    action, context = native_example(name)
    record = serialize_action(action, context)
    assert record["supervision"]["trainable"], reasons(record)
    assert len(record["components"]) == 2
    assert record["canonical"]["command"]["ability_id"] == ability
    assert record["canonical"]["command"]["source_tags"] == list(action.action_raw.unit_command.unit_tags)
    assert record["canonical"]["correlated_view"]["paced_decoder_verified"] is False
    assert record["wire_base64"] == _NATIVE_WIRE[name]
    validate_action_record(record, context)


def test_native_first_probe_uses_actual_known_actor_despite_same_loop_selection():
    action, context = native_example("probe")
    assert context["selection"] == [] and context["selection_complete"] is False
    assert context["public_abilities"]["1006"]["current_available"] is False
    record = serialize_action(action, context)
    assert record["supervision"]["trainable"]
    assert record["canonical"]["command"]["source_tags"] == [4352376833]
    assert record["canonical"]["correlated_view"]["target_correlation"] == "both_targetless"


def test_native_paired_camera_needs_recorded_public_map_dimensions():
    action, context = native_example("camera")
    record = serialize_action(action, context)
    assert "dual_view_correlation_geometry_unavailable" in reasons(record)
    # Explicit geometry fixture only: v1 did NOT record this map-size evidence.
    context["spatial"]["map_size"] = [200, 200]
    record = serialize_action(action, context)
    assert record["supervision"]["trainable"], reasons(record)
    assert record["canonical"]["correlated_view"]["feature_pixel"] == [46, 16]


@pytest.mark.parametrize("change,reason", [
    ("ability", "dual_view_ability_mismatch"),
    ("queue", "dual_view_queue_mismatch"),
    ("target", "dual_view_target_mismatch"),
    ("coordinate", "dual_view_coordinate_mismatch"),
    ("kind", "dual_view_component_mismatch"),
])
def test_conflicting_paired_views_stay_audit_only(change, reason):
    action, context = native_example("pylon")
    feature = action.action_feature_layer.unit_command
    if change == "ability":
        feature.ability_id = 883  # Same public link_name is not a proven remap.
    elif change == "queue":
        feature.queue_command = True
    elif change == "target":
        feature.ClearField("target_screen_coord")
    elif change == "coordinate":
        feature.target_screen_coord.x += 8
        context["spatial"]["screen_visibility"][2][53] = 2
    else:
        action.action_feature_layer.ClearField("unit_command")
        action.action_feature_layer.camera_move.center_minimap.CopyFrom(common.PointI(x=45, y=2))
    record = serialize_action(action, context)
    assert reason in reasons(record)
    assert record["canonical"] is None and not record["supervision"]["trainable"]


def test_explicit_public_ability_remap_can_correlate_different_ids():
    action, context = native_example("probe")
    context["public_abilities"]["4000"] = {"id": 4000, "name": "MappedProbe", "target": 1,
                                           "available": True, "remaps_to_ability_id": 1006}
    action.action_feature_layer.unit_command.ability_id = 4000
    assert serialize_action(action, context)["supervision"]["trainable"]
    context["public_abilities"]["1006"]["remaps_to_ability_id"] = 4000
    assert "dual_view_ability_mismatch" in reasons(serialize_action(action, context))


def test_correlated_target_cannot_make_friendly_attack_positive():
    action, context = native_example("chrono")
    action.action_raw.unit_command.ability_id = 23
    action.action_feature_layer.unit_command.ability_id = 23
    record = serialize_action(action, context)
    assert record["canonical"] is not None
    assert "friendly_attack_target" in reasons(record)


def test_correlated_views_do_not_erase_offscreen_source_requirements():
    action, context = native_example("probe")
    context["known_own"] = context["entities"]
    context["entities"] = []
    record = serialize_action(action, context)
    assert "offscreen_source_without_confirmed_targetless_production" in reasons(record)
    context["selection"] = [4352376833]
    context["selection_complete"] = True
    context["public_abilities"]["1006"]["current_available"] = True
    assert serialize_action(action, context)["supervision"]["trainable"]


def test_correlated_known_recipient_disappearing_into_fog_is_not_positive():
    action, context = native_example("smart")
    context["entities"][-1]["is_visible"] = False
    record = serialize_action(action, context)
    assert "dual_view_unit_target_not_current" in reasons(record)


def test_blank_public_link_name_does_not_discard_actual_engine_smart_ability():
    context = frame()
    context["public_abilities"]["1"] = {"id": 1, "name": "", "target": 4, "available": True}
    record = serialize_action(command(ability=1, target=101), context)
    assert record["supervision"]["trainable"]
    context["public_abilities"]["1"].pop("id")
    assert "public_ability_metadata_unavailable" in reasons(serialize_action(command(ability=1, target=101), context))
