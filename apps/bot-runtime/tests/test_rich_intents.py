"""Intent admission is distinct from strict immediate-click admission."""

import base64
from copy import deepcopy

import pytest
from s2clientprotocol import common_pb2 as common
from s2clientprotocol import raw_pb2 as raw
from s2clientprotocol import sc2api_pb2 as api
from s2clientprotocol import spatial_pb2 as spatial

from pluto_sc2.rich_actions import serialize_action
from pluto_sc2.rich_intents import normalize_intent


def context():
    return {
        "game_loop": 2588,
        "camera": [138.609375, 151.34375],
        "entities": [
            {
                "tag": 101,
                "owner": 1,
                "type_name": "Probe",
                "position": [138.025, 154.374],
                "is_on_screen": True,
                "is_visible": True,
            }
        ],
        "known_own": [
            {
                "tag": 101,
                "owner": 1,
                "type_name": "Probe",
                "position": [138.025, 154.374],
                "last_seen_loop": 2588,
            }
        ],
        "known_neutral": [],
        "selection": [101],
        "selection_complete": True,
        "available_abilities": [{"ability_id": i} for i in (881, 882, 883, 894, 880, 1006, 917, 3755, 23)],
        "spatial": {
            "screen_size": [128, 72],
            "minimap_size": [64, 64],
            "camera_width": 24,
            "camera_height": 13.5,
            "map_size": [184, 200],
            "screen_visibility": [[2] * 128 for _ in range(72)],
            "minimap_visibility": [[2] * 64 for _ in range(64)],
        },
    }


def catalog():
    abilities = {
        str(i): {
            "id": i,
            "name": "ProtossBuild",
            "available": True,
            "target": 3 if i == 882 else 2,
            "native": {"is_building": True, "button_name": name},
        }
        for i, name in {
            880: "Nexus",
            881: "Pylon",
            882: "Assimilator",
            883: "Gateway",
            894: "CyberneticsCore",
        }.items()
    }
    for i, name, target in [
        (1006, "NexusTrain", 1),
        (917, "GatewayTrain", 1),
        (3755, "ChronoBoostEnergyCost", 3),
        (23, "Attack", 4),
        (16, "Move", 4),
    ]:
        abilities[str(i)] = {"id": i, "name": name, "available": True, "target": target}
    return {"abilities": abilities}


def action(ability=894, target=(139.5, 159.5), pixel=(68, 0), tags=(101,), loop=2589, queued=False):
    command = raw.ActionRawUnitCommand(ability_id=ability, unit_tags=tags, queue_command=queued)
    feature = spatial.ActionSpatialUnitCommand(ability_id=ability, queue_command=queued)
    if isinstance(target, int):
        command.target_unit_tag = target
    elif target is not None:
        command.target_world_space_pos.CopyFrom(common.Point2D(x=target[0], y=target[1]))
    if pixel is not None:
        feature.target_screen_coord.CopyFrom(common.PointI(x=pixel[0], y=pixel[1]))
    return api.Action(
        game_loop=loop,
        action_raw=raw.ActionRaw(unit_command=command),
        action_feature_layer=spatial.ActionSpatial(unit_command=feature),
    )


def normalize(value, frame=None, public=None):
    frame = context() if frame is None else frame
    public = catalog() if public is None else public
    augmented = {**frame, "public_abilities": public["abilities"]}
    record = serialize_action(value, augmented)
    return normalize_intent(record, frame, public), record


def test_native_core_clipping_becomes_assisted_intent_not_exact_click():
    intent, original = normalize(action())
    assert not original["supervision"]["trainable"]
    assert intent["admitted"] and intent["supervision"]["execution_class"] == "assisted"
    assert intent["target"] == {"kind": "world_point", "point": [139.5, 159.5]}
    assert {"paid_camera_reframe", "fresh_placement_query", "fresh_target_visibility"} <= set(
        intent["decoder_requirements"]
    )
    assert base64.b64decode(intent["wire_base64"]) == action().SerializeToString(deterministic=True)
    assert not intent["evidence"]["raw_execution_authorized"]


def test_first_gas_requires_prior_permitted_neutral_and_retained_own_selection():
    frame = context()
    frame["camera"] = [143.5, 147.7578125]
    frame["entities"] = []
    frame["known_own"][0].update(position=[144.5087890625, 154.504150390625], last_seen_loop=2586)
    frame["known_neutral"] = [
        {
            "tag": 201,
            "owner": 3,
            "type_name": "VespeneGeyser",
            "position": [141.5, 156.5],
            "last_seen_loop": 1268,
        }
    ]
    intent, record = normalize(action(882, 201, (53, 0)), frame)
    assert intent["admitted"] and not record["supervision"]["trainable"]
    assert intent["target"] == {"kind": "unit", "tag": 201, "point": [141.5, 156.5]}
    assert intent["evidence"]["source_evidence"][0]["kind"] == "selected_known_own"
    assert intent["evidence"]["target_evidence"]["kind"] == "previously_seen_neutral"
    assert "fresh_neutral_identity" in intent["decoder_requirements"]


@pytest.mark.parametrize("change", ["missing", "future", "enemy", "wrong_type", "unselected", "incomplete"])
def test_gas_assistance_never_invents_memory_or_selection(change):
    frame = context()
    frame["camera"] = [143.5, 147.7578125]
    frame["entities"] = []
    frame["known_neutral"] = [
        {
            "tag": 201,
            "owner": 3,
            "type_name": "VespeneGeyser",
            "position": [141.5, 156.5],
            "last_seen_loop": 1200,
        }
    ]
    if change == "missing":
        frame["known_neutral"] = []
    elif change == "future":
        frame["known_neutral"][0]["last_seen_loop"] = 2590
    elif change == "enemy":
        frame["known_neutral"][0]["owner"] = 4
    elif change == "wrong_type":
        frame["known_neutral"][0]["type_name"] = "MineralField"
    elif change == "unselected":
        frame["selection"] = []
    else:
        frame["selection_complete"] = False
    assert not normalize(action(882, 201, (53, 0)), frame)[0]["admitted"]


def test_selected_offscreen_builder_visible_site_is_a_separate_assisted_label():
    frame = context()
    frame["entities"] = []
    intent, record = normalize(action(881, (140, 150), (71, 43)), frame)
    assert intent["admitted"] and not record["supervision"]["trainable"]
    assert "paid_source_reacquisition" in intent["decoder_requirements"]
    assert "paid_camera_reframe" not in intent["decoder_requirements"]


@pytest.mark.parametrize("ability", [880, 881, 883, 894])
def test_visible_opening_builds_keep_exact_world_targets(ability):
    intent, _ = normalize(action(ability, (140, 150), (71, 43)))
    assert intent["admitted"] and intent["supervision"]["execution_class"] == "immediate"
    assert intent["target"]["point"] == [140, 150]


@pytest.mark.parametrize("ability,producer", [(1006, "Nexus"), (917, "Gateway")])
def test_probe_and_stalker_targetless_labels_preserve_actor(ability, producer):
    frame = context()
    frame["entities"][0]["type_name"] = producer
    intent, _ = normalize(action(ability, None, None), frame)
    assert intent["admitted"] and intent["source_tags"] == [101] and intent["target"] is None


def test_chrono_keeps_current_friendly_recipient():
    frame = context()
    frame["entities"][0]["type_name"] = "Nexus"
    frame["entities"].append(
        {
            "tag": 202,
            "owner": 1,
            "type_name": "Gateway",
            "position": [140, 150],
            "is_visible": True,
            "is_on_screen": True,
        }
    )
    intent, _ = normalize(action(3755, 202, (71, 43)), frame)
    assert intent["admitted"] and intent["target"]["tag"] == 202


@pytest.mark.parametrize(
    "change", ["pixel", "ability", "queue", "not_building", "wrong_button", "unknown", "map", "source"]
)
def test_assistance_does_not_erase_real_mismatches(change):
    frame, public, native = context(), catalog(), action()
    if change == "pixel":
        native.action_feature_layer.unit_command.target_screen_coord.x = 90
    elif change == "ability":
        native.action_feature_layer.unit_command.ability_id = 881
    elif change == "queue":
        native.action_feature_layer.unit_command.queue_command = True
    elif change == "not_building":
        public["abilities"]["894"]["native"]["is_building"] = False
    elif change == "wrong_button":
        public["abilities"]["894"]["native"]["button_name"] = "Gateway"
    elif change == "unknown":
        public["abilities"].pop("894")
    elif change == "map":
        frame["spatial"].pop("map_size")
    else:
        frame["entities"][0]["type_name"] = "Stalker"
    assert not normalize(native, frame, public)[0]["admitted"]


@pytest.mark.parametrize("owner,visible", [(1, True), (4, False), (4, True)])
def test_attack_target_needs_visible_detected_enemy_and_never_friendly(owner, visible):
    frame = context()
    frame["entities"].append(
        {
            "tag": 202,
            "owner": owner,
            "type_name": "Stalker",
            "position": [140, 150],
            "is_visible": visible,
            "is_on_screen": visible,
            "cloak_state": raw.NotCloaked,
        }
    )
    intent, _ = normalize(action(23, 202, (71, 43)), frame)
    assert intent["admitted"] == (owner == 4 and visible)


def test_build_assistance_does_not_apply_to_blind_move():
    assert not normalize(action(16))[0]["admitted"]


def test_queue_preserved_and_timing_repeat_explicitly_unsupervised():
    intent, _ = normalize(action(queued=True))
    assert intent["queued"] and "preserve_queue_flag" in intent["decoder_requirements"]
    assert intent["supervision"]["timing"] is False and intent["supervision"]["repeat"] is False


def test_causal_wire_and_input_immutability():
    frame, public = context(), catalog()
    record = serialize_action(action(), {**frame, "public_abilities": public["abilities"]})
    before = deepcopy((record, frame, public))
    assert normalize_intent(record, frame, public)["admitted"]
    assert (record, frame, public) == before
    frame["game_loop"] += 1
    assert not normalize_intent(record, frame, public)["admitted"]
    frame["game_loop"] -= 1
    record["payload"]["game_loop"] += 1
    assert not normalize_intent(record, frame, public)["admitted"]


def test_gas_world_point_cannot_override_public_unit_target_kind():
    intent, _ = normalize(action(882))
    assert not intent["admitted"] and "public_ability_target_kind_mismatch" in intent["reasons"]


def test_camera_label_does_not_require_terrain_vision():
    frame = context()
    native = api.Action(
        game_loop=2589,
        action_raw=raw.ActionRaw(
            camera_move=raw.ActionRawCameraMove(center_world_space=common.Point(x=10, y=20))
        ),
    )
    intent, _ = normalize(native, frame)
    assert intent["admitted"] and intent["kind"] == "camera_move"
    assert intent["decoder_requirements"] == ["paid_camera"]
