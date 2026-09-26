"""Native observation regressions for the per-game learned-policy boundary."""
from copy import deepcopy

import numpy as np
import pytest
from s2clientprotocol import raw_pb2 as raw

from pluto_sc2.policy_observation import LivePolicyObservation
from pluto_sc2.alphastar_tensor import MINIMAP_MAX, TensorConfig, tensorize_observation
from pluto_sc2.policy_intents import bind_observation
from pluto_sc2.replays import ReplayError
from test_rich_intents import catalog
from test_rich_replays import _image, _observation, _single_panel, _unit


def observer(**changes):
    return LivePolicyObservation(**{
        "session_id": "native-game-unique", "player_id": 1, "map_size": [200, 200],
        "unit_names": {59: "Nexus", 84: "Probe", 342: "VespeneGeyser", 48: "Marine"}, **changes})


def test_offscreen_units_never_refresh_memory_and_enemy_state_is_not_remembered():
    builder = observer()
    obs = _observation(loop=1)
    _unit(obs, tag=11, selected=True)
    _unit(obs, tag=12, alliance=raw.Neutral, unit_type=342)
    _unit(obs, tag=13, alliance=raw.Enemy, unit_type=48)
    _single_panel(obs)
    first = builder.observe(obs)
    remembered = deepcopy(first)
    # Mutating returned data must not alter the builder's causal history.
    first["known_own"][0]["position"][0] = 999
    first["known_neutral"][0]["position"][0] = 999
    obs.game_loop = 2
    for unit in obs.raw_data.units:
        unit.pos.x, unit.pos.y, unit.health = 160, 160, 17
        unit.is_on_screen = False
    _unit(obs, tag=14, unit_type=84, position=(160, 160), on_screen=False)
    second = builder.observe(obs)
    assert second["entities"] == []
    assert second["known_own"] == remembered["known_own"]
    assert second["known_neutral"] == remembered["known_neutral"]
    assert second["selection"] == [11] and second["selection_complete"]
    assert all(r["tag"] not in (13, 14) for r in second["known_own"] + second["known_neutral"])
    assert set(second["known_neutral"][0]) == {
        "tag", "owner", "type_id", "type_name", "position", "last_seen_loop"}


@pytest.mark.parametrize("change", ["same_loop", "earlier_loop", "different_player"])
def test_rejects_reused_or_cross_player_observations_without_advancing_memory(change):
    builder = observer()
    obs = _observation(loop=10)
    _unit(obs)
    builder.observe(obs)
    if change == "earlier_loop":
        obs.game_loop = 9
    elif change == "different_player":
        obs.game_loop, obs.player_common.player_id = 11, 2
    with pytest.raises(ReplayError):
        builder.observe(obs)
    obs.game_loop, obs.player_common.player_id = 11, 1
    assert builder.observe(obs)["game_loop"] == 11


def test_failed_encoding_does_not_poison_memory_or_consume_game_loop():
    builder = observer()
    obs = _observation(loop=10)
    _unit(obs, tag=10)
    _unit(obs, tag=20, unit_type=9999)
    with pytest.raises(ReplayError, match="metadata"):
        builder.observe(obs)
    obs.raw_data.ClearField("units")
    assert builder.observe(obs)["known_own"] == []


def test_new_session_starts_without_previous_game_memory():
    old = observer()
    obs = _observation(loop=10)
    _unit(obs)
    old.observe(obs)
    obs.game_loop = 0
    obs.raw_data.ClearField("units")
    new = observer(session_id="second-game")
    frame = new.observe(obs)
    assert frame["known_own"] == frame["known_neutral"] == []
    assert frame["spatial"]["map_size"] == [200, 200]
    assert frame["camera"] == [50, 50]


@pytest.mark.parametrize("changes", [
    {"session_id": ""}, {"player_id": True}, {"player_id": 0},
    {"map_size": [0, 200]}, {"map_size": [True, 200]},
    {"unit_names": {}}, {"unit_names": {"59": "Nexus"}},
])
def test_explicit_native_identity_and_public_metadata_required(changes):
    with pytest.raises(ReplayError):
        observer(**changes)


def test_native_current_observation_to_label_free_tensors_and_bound_pointer_sidecar():
    """Use real protobufs and all seven native planes; no engine or expert action."""
    builder = observer()
    obs = _observation(loop=1)
    values = dict(height_map=64, visibility_map=2, creep=0, player_relative=1,
                  alerts=0, pathable=1, buildable=1)
    for name, value in values.items():
        getattr(obs.feature_layer_data.minimap_renders, name).CopyFrom(
            _image(np.full((64, 64), value, np.uint8)))
    _unit(obs, tag=11, selected=True)
    _unit(obs, tag=12, alliance=raw.Neutral, unit_type=342, position=(51, 50))
    enemy = _unit(obs, tag=13, alliance=raw.Enemy, unit_type=48, position=(49, 50))
    enemy.energy = 199  # Native enemy-only private fields must not become model inputs.
    enemy.orders.add(ability_id=23)
    _single_panel(obs)
    registry = [{"id": 64, "name": "Train_Probe_quick", "ability_id": 1006, "general_id": 0,
                 "args": ["queued", "unit_tags"], "camera_only_pt": False, "planned_build": False}]
    mapping, config = {59: 1, 84: 2, 342: 3, 48: 4}, TensorConfig(max_entities=8, max_selected=4)

    first = builder.observe(obs)
    encoded = tensorize_observation(first, registry, mapping, config, step_type=0)
    assert encoded["metadata"]["entity_tags"] == [11, 12, 13]
    assert all(("observation", "minimap_" + name) in encoded["inputs"] for name in MINIMAP_MAX)
    assert not any(isinstance(key, tuple) and key[0] == "behaviour_features" for key in encoded["inputs"])
    assert not {"orders", "energy"} & set(next(row for row in first["entities"] if row["tag"] == 13))
    bind = bind_observation(first, encoded["metadata"]["entity_tags"], registry, catalog(),
                            session_id=builder.session_id, max_entities=8, max_selected=4)
    assert bind["game_loop"] == 1 and bind["session_id"] == builder.session_id

    obs.game_loop = 2
    for unit in obs.raw_data.units:
        unit.is_on_screen, unit.is_selected = False, False
        unit.pos.x, unit.pos.y = 160, 160
    _unit(obs, tag=15, unit_type=84, selected=True, position=(52, 50))
    _single_panel(obs, kind=84)
    second = builder.observe(obs)
    encoded = tensorize_observation(second, registry, mapping, config)
    assert encoded["metadata"]["entity_tags"] == [15, 11, 12]
    assert encoded["inputs"]["observation", "current_target_mask"].tolist() == [True] + [False] * 7
    assert encoded["metadata"]["remembered_own_count"] == encoded["metadata"]["remembered_neutral_count"] == 1
    assert next(row for row in second["known_own"] if row["tag"] == 11)["position"] == [50, 50]
    assert second["known_neutral"][0]["position"] == [51, 50]
    bind = bind_observation(second, encoded["metadata"]["entity_tags"], registry, catalog(),
                            session_id=builder.session_id, max_entities=8, max_selected=4)
    assert bind["entity_tags"] == [15, 11, 12] and bind["game_loop"] == 2
