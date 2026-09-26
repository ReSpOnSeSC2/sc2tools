"""Native-protocol fidelity and visibility checks for rich replay observations."""

import base64
from copy import deepcopy
from collections import deque

import numpy as np
import pytest
from s2clientprotocol import common_pb2 as common
from s2clientprotocol import raw_pb2 as raw
from s2clientprotocol import sc2api_pb2 as api

from pluto_sc2.fairplay import CAMERA_HEIGHT, CAMERA_WIDTH, MINIMAP_SIZE, SCREEN_SIZE
from pluto_sc2.replays import ReplayError
from pluto_sc2.rich_replays import encode_frame, image_array, preceding_frame


def _image(values, bits=8):
    array = np.asarray(values)
    data = (np.packbits(array.astype(np.uint8).reshape(-1)).tobytes() if bits == 1
            else array.astype({8: np.uint8, 16: "<u2", 32: "<u4"}[bits]).tobytes())
    return common.ImageData(bits_per_pixel=bits,
                            size=common.Size2DI(x=array.shape[1], y=array.shape[0]), data=data)


def _observation(loop=224):
    observation = api.Observation(game_loop=loop)
    observation.raw_data.player.camera.CopyFrom(common.Point(x=50, y=50))
    observation.player_common.player_id = 1
    observation.player_common.minerals = 237
    observation.player_common.vespene = 114
    observation.player_common.food_used = 17
    observation.player_common.food_cap = 21
    observation.feature_layer_data.renders.visibility_map.CopyFrom(
        _image(np.full(SCREEN_SIZE[::-1], 2)))
    observation.feature_layer_data.minimap_renders.visibility_map.CopyFrom(
        _image(np.full(MINIMAP_SIZE[::-1], 1)))
    return observation


def _unit(observation, tag=1001, *, alliance=raw.Self, unit_type=59,
          position=(50, 50), selected=False, on_screen=True, cloak=raw.NotCloaked):
    return observation.raw_data.units.add(
        tag=tag, alliance=alliance, unit_type=unit_type, display_type=raw.Visible,
        pos=common.Point(x=position[0], y=position[1]), is_on_screen=on_screen,
        is_selected=selected, cloak=cloak, radius=2.75, build_progress=1,
        health=1000, health_max=1000, shield=1000, shield_max=1000)


def _single_panel(observation, kind=59, owner=raw.Self):
    observation.ui_data.single.unit.unit_type = kind
    observation.ui_data.single.unit.player_relative = owner
    observation.ui_data.single.unit.build_progress = 1


def test_current_own_observation_keeps_resources_orders_energy_and_features():
    observation = _observation()
    unit = _unit(observation, selected=True)
    unit.energy, unit.energy_max = 78.5, 200
    unit.weapon_cooldown = 3.25
    unit.assigned_harvesters, unit.ideal_harvesters = 16, 16
    unit.buff_ids.append(99)
    unit.orders.add(ability_id=1006, progress=0.25)
    unit.orders.add(ability_id=16, target_world_space_pos=common.Point(x=54, y=51))
    observation.raw_data.player.upgrade_ids.extend([84, 87])
    observation.abilities.add(ability_id=1006, requires_point=False)
    observation.alerts.append(1)
    _single_panel(observation)
    terrain = np.arange(SCREEN_SIZE[0] * SCREEN_SIZE[1], dtype=np.uint16).reshape(SCREEN_SIZE[::-1])
    observation.feature_layer_data.renders.height_map.CopyFrom(_image(terrain, bits=16))

    frame = encode_frame(observation, {}, {59: "Nexus"})

    row = frame["entities"][0]
    assert row["owner"] == raw.Self
    assert row["position"] == [50, 50]
    assert row["energy"] == 78.5 and row["energy_max"] == 200
    assert row["weapon_cooldown"] == 3.25
    assert row["assigned_harvesters"] == row["ideal_harvesters"] == 16
    assert row["orders"][0] == {"ability_id": 1006, "progress": 0.25}
    assert row["orders"][1]["target_world_space_pos"] == {"x": 54.0, "y": 51.0}
    assert row["buffs"] == [99]
    assert frame["hud"]["minerals"] == 237 and frame["hud"]["vespene"] == 114
    assert frame["selection"] == [1001] and frame["selection_complete"] is True
    assert frame["own_upgrades"] == [84, 87]
    assert frame["available_abilities"][0]["ability_id"] == 1006
    assert frame["spatial"]["screen_visibility"][0] == [2] * SCREEN_SIZE[0]
    encoded = frame["feature_layers"]["renders"]["height_map"]
    assert base64.b64decode(encoded["data"]) == terrain.astype("<u2").tobytes()
    assert encoded["bits_per_pixel"] == 16


@pytest.mark.parametrize("cloak,allowed", [
    (raw.CloakedUnknown, False), (raw.Cloaked, False),
    (raw.CloakedDetected, True), (raw.NotCloaked, True), (raw.CloakedAllied, False),
])
def test_enemy_cloak_state_uses_native_enemy_alliance_and_detection(cloak, allowed):
    observation = _observation()
    _unit(observation, alliance=raw.Enemy, cloak=cloak, unit_type=144)
    frame = encode_frame(observation, {})
    assert bool(frame["entities"]) is allowed


def test_neutral_resource_is_not_mistaken_for_enemy_cloak_filter():
    observation = _observation()
    _unit(observation, alliance=raw.Neutral, cloak=raw.CloakedUnknown, unit_type=341)
    frame = encode_frame(observation, {})
    assert [(row["tag"], row["owner"]) for row in frame["entities"]] == [(1001, raw.Neutral)]


@pytest.mark.parametrize("change", ["offscreen", "snapshot", "hidden", "blip", "outside_camera"])
def test_enemy_requires_current_screen_entity_evidence(change):
    observation = _observation()
    unit = _unit(observation, alliance=raw.Enemy)
    if change == "offscreen":
        unit.is_on_screen = False
    elif change == "snapshot":
        unit.display_type = raw.Snapshot
    elif change == "hidden":
        unit.display_type = raw.Hidden
    elif change == "blip":
        unit.is_blip = True
    else:
        unit.pos.x = 50 + CAMERA_WIDTH
    assert encode_frame(observation, {})["entities"] == []


@pytest.mark.parametrize("visibility", [0, 1])
def test_on_screen_enemy_still_requires_visible_terrain_at_its_exact_pixel(visibility):
    observation = _observation()
    # A point above/right of camera center catches axis swaps and y inversion.
    position = (53, 52.25)
    _unit(observation, alliance=raw.Enemy, position=position)
    values = np.full(SCREEN_SIZE[::-1], 2, dtype=np.uint8)
    px = int(SCREEN_SIZE[0] / 2 + (position[0] - 50) * SCREEN_SIZE[0] / CAMERA_WIDTH)
    py = int(SCREEN_SIZE[1] / 2 - (position[1] - 50) * SCREEN_SIZE[0] / CAMERA_WIDTH)
    values[py, px] = visibility
    observation.feature_layer_data.renders.visibility_map.CopyFrom(_image(values))
    assert encode_frame(observation, {})["entities"] == []


def test_enemy_without_visibility_layer_has_no_positive_visibility_evidence():
    observation = _observation()
    _unit(observation, alliance=raw.Enemy)
    observation.feature_layer_data.renders.ClearField("visibility_map")
    assert encode_frame(observation, {})["entities"] == []


def test_visible_enemy_never_exports_orders_energy_harvesting_or_cargo():
    observation = _observation()
    enemy = _unit(observation, alliance=raw.Enemy, unit_type=27)
    enemy.energy = 173
    enemy.assigned_harvesters = 24
    enemy.weapon_cooldown = 91
    enemy.orders.add(ability_id=560, target_unit_tag=987654321)
    enemy.passengers.add(tag=777, unit_type=48, health=45)
    enemy.buff_ids.append(99)
    enemy.rally_targets.add(tag=87654321)
    row = encode_frame(observation, {})["entities"][0]
    assert row["owner"] == raw.Enemy and row["health"] == 1000
    assert not {"orders", "energy", "energy_max", "assigned_harvesters", "weapon_cooldown",
                "passengers", "cargo_space_taken", "rally_targets", "buffs"}.intersection(row)


def test_offscreen_raw_own_changes_never_refresh_remembered_location_or_state():
    known = {}
    observation = _observation(loop=10)
    _unit(observation, selected=True)
    _single_panel(observation)
    original = encode_frame(observation, known, {59: "Nexus"})
    remembered = deepcopy(known)
    observation.game_loop = 20
    unit = observation.raw_data.units[0]
    unit.is_on_screen = False
    unit.pos.CopyFrom(common.Point(x=150, y=160))
    unit.health, unit.energy, unit.build_progress = 17, 199, 0.125
    unit.unit_type = 133
    unit.orders.add(ability_id=777, target_unit_tag=88888888)

    frame = encode_frame(observation, known, {59: "Nexus", 133: "WarpGate"})

    assert frame["entities"] == []
    assert known == remembered
    assert frame["known_own"] == original["known_own"]
    assert frame["known_own"][0]["last_seen_loop"] == 10
    assert frame["selection"] == [1001] and frame["selection_complete"] is True
    unit.is_selected = False
    observation.ui_data.ClearField("single")
    assert encode_frame(observation, known)["selection"] == []


def test_unseen_offscreen_own_selection_does_not_invent_identity_or_completeness():
    observation = _observation()
    _unit(observation, selected=True)
    _unit(observation, tag=999, selected=True, on_screen=False, position=(145, 149))
    for _ in range(2):
        observation.ui_data.multi.units.add(unit_type=59, player_relative=raw.Self)
    known = {}
    frame = encode_frame(observation, known)
    assert frame["selection"] == [1001]
    assert frame["selection_complete"] is False
    assert set(known) == {1001}


@pytest.mark.parametrize("panel", ["none", "single", "multi", "production"])
def test_selection_completeness_requires_corresponding_actual_ui_panel(panel):
    observation = _observation()
    _unit(observation, selected=True)
    if panel == "single":
        _single_panel(observation)
    elif panel == "multi":
        observation.ui_data.multi.units.add(unit_type=59, player_relative=raw.Self)
    elif panel == "production":
        observation.ui_data.production.unit.unit_type = 59
        observation.ui_data.production.unit.player_relative = raw.Self
        observation.ui_data.production.build_queue.add(unit_type=84, player_relative=raw.Self)
        observation.ui_data.production.production_queue.add(ability_id=1006, build_progress=0.375)
    frame = encode_frame(observation, {})
    assert frame["selection_complete"] is (panel != "none")
    if panel == "production":
        assert frame["ui"]["production"]["production_queue"] == [
            {"ability_id": 1006, "build_progress": 0.375}]


@pytest.mark.parametrize("ui_owner,ui_type", [(raw.Enemy, 59), (raw.Self, 84), (0, 59)])
def test_selection_card_count_alone_does_not_prove_matching_own_selection(ui_owner, ui_type):
    observation = _observation()
    _unit(observation, selected=True, unit_type=59)
    _single_panel(observation, owner=ui_owner, kind=ui_type)
    frame = encode_frame(observation, {})
    assert frame["selection"] == [1001]
    assert frame["selection_complete"] is False


def test_preceding_frame_excludes_equal_and_future_frames_and_returns_latest_prior():
    frames = deque([{"game_loop": 10}, {"game_loop": 12}, {"game_loop": 14}])
    assert preceding_frame(frames, 14) is frames[1]
    assert preceding_frame(frames, 13) is frames[1]
    assert preceding_frame(frames, 15) is frames[2]
    assert preceding_frame(frames, 10) is None
    assert preceding_frame(frames, 9) is None
    assert preceding_frame([], 1) is None


@pytest.mark.parametrize("bits", [1, 8, 16, 32])
def test_native_image_bits_and_row_orientation_are_preserved(bits):
    values = [[1, 0, 0, 1], [0, 1, 1, 0]] if bits == 1 else [[1, 2, 3], [17, 18, 19]]
    assert image_array(_image(values, bits)).tolist() == values


@pytest.mark.parametrize("image", [
    common.ImageData(bits_per_pixel=8, size=common.Size2DI(x=0, y=2), data=b""),
    common.ImageData(bits_per_pixel=24, size=common.Size2DI(x=1, y=1), data=b"123"),
    common.ImageData(bits_per_pixel=8, size=common.Size2DI(x=2, y=2), data=b"123"),
    common.ImageData(bits_per_pixel=1, size=common.Size2DI(x=9, y=1), data=b"\xff"),
])
def test_malformed_feature_images_fail_closed(image):
    with pytest.raises(ReplayError):
        image_array(image)


@pytest.mark.parametrize("camera", [None, (float("nan"), 50), (50, float("inf"))])
def test_missing_or_nonfinite_camera_fails_closed(camera):
    observation = _observation()
    observation.raw_data.player.ClearField("camera")
    if camera:
        observation.raw_data.player.camera.CopyFrom(common.Point(x=camera[0], y=camera[1]))
    with pytest.raises(ReplayError):
        encode_frame(observation, {})


def test_encoder_provides_serializer_world_geometry_contract():
    from pluto_sc2.rich_actions import serialize_action

    observation = _observation(loop=20)
    _unit(observation, selected=True, unit_type=74)
    _single_panel(observation, kind=74)
    frame = encode_frame(observation, {}, {74: "Stalker"})
    assert frame["spatial"]["camera_width"] == CAMERA_WIDTH
    if "camera_height" in frame["spatial"]:
        assert frame["spatial"]["camera_height"] == CAMERA_HEIGHT
    frame["public_abilities"] = {"16": {"name": "Move", "available": True, "target": 2}}
    action = api.Action(game_loop=21)
    action.action_raw.unit_command.ability_id = 16
    action.action_raw.unit_command.unit_tags.append(1001)
    action.action_raw.unit_command.target_world_space_pos.CopyFrom(common.Point2D(x=54, y=51))
    record = serialize_action(action, frame)
    assert "world_target_visibility_unresolved" not in record["supervision"]["exclusion_reasons"]


def test_encoder_type_name_supports_selected_offscreen_producer_label():
    from pluto_sc2.rich_actions import serialize_action

    known = {}
    observation = _observation(loop=20)
    unit = _unit(observation, selected=True)
    _single_panel(observation)
    encode_frame(observation, known, {59: "Nexus"})
    observation.game_loop = 21
    unit.is_on_screen = False
    observation.abilities.add(ability_id=1006, requires_point=False)
    frame = encode_frame(observation, known, {59: "Nexus"})
    frame["public_abilities"] = {"1006": {"name": "NexusTrain", "available": True,
                                         "current_available": True, "target": 1}}
    action = api.Action(game_loop=22)
    action.action_raw.unit_command.ability_id = 1006
    action.action_raw.unit_command.unit_tags.append(1001)
    record = serialize_action(action, frame)
    assert "offscreen_source_without_confirmed_targetless_production" not in record["supervision"]["exclusion_reasons"]
