from __future__ import annotations

import asyncio
from types import SimpleNamespace

import numpy as np
import pytest
from sc2.data import Race, Result
from sc2.ids.ability_id import AbilityId
from sc2.ids.unit_typeid import UnitTypeId
from sc2.position import Point2

from pluto_sc2.fairplay import FairPlayController
from pluto_sc2.schema import (
    ACTION_NAMES, ACTION_TO_INDEX, BASE_OBSERVATION_SIZE, HISTORY_LENGTH,
    OBSERVATION_SIZE, ObservationStack, replay_action_for_ability,
)
from pluto_sc2.sc2_adapter import NeuralBot, _placement, encode_observation, legal_action_mask


class Unit(SimpleNamespace):
    def __init__(self, kind=UnitTypeId.ZEALOT, tag=1, position=(50, 50), **kwargs):
        defaults = dict(
            type_id=kind, tag=tag, position=Point2(position), is_structure=False,
            is_visible=True, is_on_screen=True, is_snapshot=False, is_cloaked=False, is_revealed=False,
            is_flying=False, is_ready=True, is_idle=True, health=100, health_max=100,
            shield=50, shield_max=50, assigned_harvesters=0, ideal_harvesters=0,
            orders=[], is_detector=False, ground_dps=10, air_dps=0,
            can_attack=True, can_attack_ground=True, can_attack_air=False,
            can_be_attacked=True, energy=0,
        )
        defaults.update(kwargs)
        super().__init__(**defaults)

    def distance_to(self, other):
        return self.position.distance_to(other.position if hasattr(other, "position") else other)


def scene():
    bot = SimpleNamespace(
        units=[], structures=[], enemy_units=[], enemy_structures=[], mineral_field=[], vespene_geyser=[],
        time=1.0, minerals=50, vespene=0, supply_used=8, supply_cap=15,
        supply_army=0, supply_workers=8, supply_left=7,
        start_location=Point2((50, 50)), enemy_start_locations=[Point2((150, 150))],
        enemy_race=Race.Terran,
        game_info=SimpleNamespace(playable_area=SimpleNamespace(x=0, y=0, width=200, height=200),
                                  map_center=Point2((100, 100)), map_size=Point2((200, 200))),
        game_data=SimpleNamespace(units={}, abilities={}), state=SimpleNamespace(upgrades=set()),
        fairplay=FairPlayController(camera_center=(50, 50)),
        can_afford=lambda _: False, can_feed=lambda _: True, is_visible=lambda _: True,
    )
    bot.queried = []

    async def abilities(units, **kwargs):
        bot.queried.extend(units)
        return [getattr(u, "abilities", []) for u in units]

    bot.get_available_abilities = abilities
    return bot


def placement_scene():
    bot = scene()
    bot._pluto_replay_mode = True
    bot.game_info.placement_grid = np.ones((200, 200), dtype=np.uint8)
    bot.game_info.pathing_grid = np.ones((200, 200), dtype=np.uint8)
    bot.game_info.terrain_height = np.ones((200, 200), dtype=np.uint8)
    bot.state.creep = np.zeros((200, 200), dtype=np.uint8)
    bot.state.psionic_matrix = SimpleNamespace(sources=[])
    return bot


def test_schema_and_history_are_fixed_finite_and_copy_frames():
    stack = ObservationStack()
    frame = np.ones(BASE_OBSERVATION_SIZE, dtype=np.float32)
    stacked = stack.push(frame)
    assert stacked.shape == (OBSERVATION_SIZE,)
    assert np.all(stacked[:BASE_OBSERVATION_SIZE * (HISTORY_LENGTH - 1)] == 0)
    frame[:] = 2
    assert np.all(stacked[-BASE_OBSERVATION_SIZE:] == 1)
    stack.reset()
    assert np.count_nonzero(stack.push(np.zeros(BASE_OBSERVATION_SIZE))) == 0
    with pytest.raises(ValueError):
        stack.push(np.full(BASE_OBSERVATION_SIZE, np.nan))
    assert len(ACTION_NAMES) == len(set(ACTION_NAMES))


def test_encoder_never_reads_offscreen_or_hidden_enemy_details():
    bot = scene()
    baseline = encode_observation(bot)
    bot.units = [Unit(tag=1, position=(120, 120), health=float("nan"))]
    bot.enemy_units = [
        Unit(tag=2, is_visible=False, health=float("nan")),
        Unit(tag=3, is_snapshot=True, health=float("nan")),
        Unit(tag=4, is_cloaked=True, is_revealed=False, health=float("nan")),
        Unit(tag=5, position=(130, 130), health=float("nan")),
    ]
    np.testing.assert_array_equal(encode_observation(bot), baseline)
    bot.enemy_units.append(Unit(tag=6))
    assert not np.array_equal(encode_observation(bot), baseline)


def test_encoder_excludes_global_upgrade_set():
    from sc2.ids.upgrade_id import UpgradeId
    bot = scene()
    baseline = encode_observation(bot)
    bot.state.upgrades = {UpgradeId.BLINKTECH}
    np.testing.assert_array_equal(encode_observation(bot), baseline)


def test_random_opponent_race_is_not_revealed_by_offscreen_raw_data():
    from pluto_sc2.schema import SCALAR_NAMES
    bot = scene()
    bot.player_id = 1
    bot.game_info.players = [SimpleNamespace(id=2, race=Race.Random, actual_race=Race.Zerg)]
    bot.enemy_race = Race.Zerg  # Burnysc2 may learn this from an offscreen sighting.
    bot.enemy_units = [Unit(UnitTypeId.ZERGLING, tag=2, position=(140, 140), race=Race.Zerg)]
    first = encode_observation(bot)
    assert first[SCALAR_NAMES.index("enemy_random")] == 1
    assert first[SCALAR_NAMES.index("enemy_zerg")] == 0
    bot.enemy_units[0].position = Point2((50, 50))
    second = encode_observation(bot)
    assert second[SCALAR_NAMES.index("enemy_zerg")] == 1


def test_empty_camera_still_allows_camera_navigation():
    bot = scene()
    mask = asyncio.run(legal_action_mask(bot))
    assert mask.dtype == np.bool_
    assert mask[ACTION_TO_INDEX["no_op"]]
    assert mask[ACTION_TO_INDEX["camera_enemy_start"]]
    assert not mask[ACTION_TO_INDEX["train_probe"]]
    assert not mask[ACTION_TO_INDEX["attack_enemy_base"]]


def test_camera_mask_compares_minimap_pixels_instead_of_world_distance():
    bot = scene()
    bot.fairplay.camera_center = Point2((142.1875, 148.4375))
    bot.start_location = Point2((143.5, 149.5))
    bot._pluto_last_army_position = Point2((143.0, 149.0))
    mask = asyncio.run(legal_action_mask(bot))
    assert not mask[ACTION_TO_INDEX["camera_home"]]
    assert not mask[ACTION_TO_INDEX["camera_army"]]
    assert mask[ACTION_TO_INDEX["camera_east"]]
    assert mask[ACTION_TO_INDEX["camera_enemy_start"]]


def test_mask_never_queries_offscreen_units_or_attacks_illegal_air_target():
    bot = scene()
    zealot = Unit(abilities=[AbilityId.ATTACK_ATTACK, AbilityId.MOVE_MOVE])
    bot.units = [zealot, Unit(tag=2, position=(140, 140))]
    bot.enemy_units = [Unit(UnitTypeId.MUTALISK, tag=3, is_flying=True)]
    mask = asyncio.run(legal_action_mask(bot))
    assert bot.queried == [zealot]
    assert mask[ACTION_TO_INDEX["attack_enemy_base"]]
    assert not mask[ACTION_TO_INDEX["attack_visible_enemy"]]
    bot.enemy_units[0].is_flying = False
    mask = asyncio.run(legal_action_mask(bot))
    assert mask[ACTION_TO_INDEX["attack_visible_enemy"]]


def test_blink_mask_never_reads_pathing_inside_fog_even_when_on_screen():
    bot = scene()
    bot.units = [Unit(UnitTypeId.STALKER, position=(55, 50),
                      abilities=[AbilityId.EFFECT_BLINK_STALKER])]
    bot.is_visible = lambda _: False

    def forbidden_pathing(_):
        raise AssertionError("Fogged destination pathing must not be queried")

    bot.in_pathing_grid = forbidden_pathing
    mask = asyncio.run(legal_action_mask(bot))
    assert not mask[ACTION_TO_INDEX["blink_retreat"]]
    bot.is_visible = lambda _: True
    bot.in_pathing_grid = lambda _: True
    assert asyncio.run(legal_action_mask(bot))[ACTION_TO_INDEX["blink_retreat"]]


def test_budget_exhaustion_allows_only_no_op():
    bot = scene()
    assert bot.fairplay.budget.consume(bot.time)
    mask = asyncio.run(legal_action_mask(bot))
    assert np.flatnonzero(mask).tolist() == [ACTION_TO_INDEX["no_op"]]
    assert bot.queried == []


def test_placement_queries_stay_inside_camera():
    bot = scene()
    checked = []

    async def can_place(ability, points):
        checked.extend(points)
        return [True] * len(points)

    bot.can_place = can_place
    assert asyncio.run(_placement(bot, AbilityId.PROTOSSBUILD_PYLON)) is not None
    assert checked and all(bot.fairplay.on_screen(p) for p in checked)


def test_live_placement_queries_never_probe_fog_or_partially_hidden_footprints():
    from pluto_sc2.sc2_adapter import _footprint_points
    bot = scene()
    bot.is_visible = lambda p: p.x < 50
    checked = []

    async def can_place(ability, points):
        checked.extend(points)
        return [True] * len(points)

    bot.can_place = can_place
    assert asyncio.run(_placement(bot, AbilityId.PROTOSSBUILD_PYLON)) is not None
    assert checked
    assert all(bot.is_visible(p) for center in checked for p in _footprint_points(center, 2))


def test_replay_placement_avoids_unsupported_rpc_and_checks_visible_obstacles():
    from pluto_sc2.sc2_adapter import _replay_placement_allowed
    bot = placement_scene()
    point = Point2((50, 50))
    assert _replay_placement_allowed(bot, point, UnitTypeId.PYLON)
    assert asyncio.run(_placement(bot, AbilityId.PROTOSSBUILD_PYLON)) is not None
    bot.units = [Unit(position=(50, 50))]
    assert not _replay_placement_allowed(bot, point, UnitTypeId.PYLON)
    bot.units[0].position = Point2((150, 150))
    assert _replay_placement_allowed(bot, point, UnitTypeId.PYLON)
    bot.state.creep[50, 50] = 1
    assert not _replay_placement_allowed(bot, point, UnitTypeId.PYLON)
    bot.state.creep[50, 50] = 0
    bot.game_info.placement_grid[50, 50] = 0
    assert not _replay_placement_allowed(bot, point, UnitTypeId.PYLON)


def test_replay_power_fallback_requires_current_visible_source():
    from pluto_sc2.sc2_adapter import _replay_placement_allowed
    from sc2.power_source import PowerSource
    bot = placement_scene()
    point = Point2((50.5, 50.5))
    assert not _replay_placement_allowed(bot, point, UnitTypeId.GATEWAY)
    # Offscreen source information must not make the placement legal.
    bot.state.psionic_matrix.sources = [PowerSource(Point2((48, 50)), 6.5, 99)]
    assert not _replay_placement_allowed(bot, point, UnitTypeId.GATEWAY)
    bot.structures = [Unit(UnitTypeId.PYLON, tag=99, position=(46, 50), is_structure=True)]
    bot.state.psionic_matrix.sources = [PowerSource(Point2((46, 50)), 6.5, 99)]
    assert _replay_placement_allowed(bot, point, UnitTypeId.GATEWAY)
    bot.game_info.terrain_height[50, 50] = 2
    assert not _replay_placement_allowed(bot, point, UnitTypeId.GATEWAY)


def test_replay_gas_uses_only_visible_unoccupied_geyser_footprint():
    from pluto_sc2.sc2_adapter import _replay_placement_allowed
    bot = placement_scene()
    geyser = Unit(UnitTypeId.VESPENEGEYSER, tag=99, position=(50.5, 50.5))
    bot.vespene_geyser = [geyser]
    # Resource tiles aren't ordinarily buildable; assimilators explicitly target
    # that current visible geyser, while occupied gas structures still block.
    bot.game_info.placement_grid[:] = 0
    assert _replay_placement_allowed(bot, geyser.position, UnitTypeId.ASSIMILATOR, geyser=geyser)
    bot.structures = [Unit(UnitTypeId.ASSIMILATOR, position=(50.5, 50.5), is_structure=True)]
    assert not _replay_placement_allowed(bot, geyser.position, UnitTypeId.ASSIMILATOR, geyser=geyser)
    bot.structures = []
    bot.is_visible = lambda p: p.x < 51
    assert not _replay_placement_allowed(bot, geyser.position, UnitTypeId.ASSIMILATOR, geyser=geyser)


def test_replay_hidden_footprint_never_reads_terrain_or_creep():
    from pluto_sc2.sc2_adapter import _replay_placement_allowed
    bot = placement_scene()

    class UnreadableGrid:
        def __getitem__(self, _):
            raise AssertionError("Hidden map data must not be read")

    bot.game_info.placement_grid = UnreadableGrid()
    bot.state.creep = UnreadableGrid()
    bot.is_visible = lambda _: False
    assert not _replay_placement_allowed(bot, Point2((50, 50)), UnitTypeId.PYLON)


def test_replay_hidden_power_source_geometry_is_never_read():
    from pluto_sc2.sc2_adapter import _replay_placement_allowed
    bot = placement_scene()

    class HiddenPower:
        unit_tag = 999

        @property
        def position(self):
            raise AssertionError("Hidden source geometry must not be read")

        def covers(self, _):
            raise AssertionError("Hidden source radius must not be read")

    bot.state.psionic_matrix.sources = [HiddenPower()]
    assert not _replay_placement_allowed(bot, Point2((50.5, 50.5)), UnitTypeId.GATEWAY)


def test_unknown_real_worker_order_stays_busy_and_is_never_retasked():
    from s2clientprotocol import raw_pb2
    from sc2.unit import Unit as SC2Unit
    from pluto_sc2.sc2_adapter import _harvest_assignment, _harvest_worker
    owner = SimpleNamespace(state=SimpleNamespace(game_loop=0), game_data=SimpleNamespace(abilities={}))
    worker = SC2Unit(raw_pb2.Unit(tag=77, unit_type=UnitTypeId.PROBE.value,
        orders=[raw_pb2.UnitOrder(ability_id=4135, target_unit_tag=99)]), owner)
    # This is the exact failure in the real replay: Burnysc2 cannot construct
    # UnitOrder for an ability missing from the game-data response.
    with pytest.raises(KeyError, match="4135"):
        _ = worker.orders
    assert not worker.is_idle
    assignment = _harvest_assignment(worker, {99}, set())
    assert assignment is None
    assert _harvest_worker([worker], "minerals", [Unit(tag=99)], {77: assignment}) is None


def test_unknown_structure_orders_do_not_crash_encoding_or_enable_chrono():
    from s2clientprotocol import raw_pb2
    bot = scene()

    class RawOrdersOnly:
        def __init__(self):
            self.unit = Unit(UnitTypeId.CYBERNETICSCORE, is_structure=True, is_idle=False)
            self._proto = raw_pb2.Unit(orders=[raw_pb2.UnitOrder(ability_id=4135)])

        def __getattr__(self, name):
            return getattr(self.unit, name)

        @property
        def orders(self):
            raise KeyError(4135)

    bot.structures = [RawOrdersOnly(), Unit(UnitTypeId.NEXUS, tag=2, is_structure=True,
        abilities=[AbilityId.EFFECT_CHRONOBOOSTENERGYCOST])]
    assert np.isfinite(encode_observation(bot)).all()
    mask = asyncio.run(legal_action_mask(bot))
    assert not mask[ACTION_TO_INDEX["chrono_boost"]]


def harvest_scene():
    bot = scene()
    mineral = Unit(UnitTypeId.MINERALFIELD, tag=100, position=(51, 50), mineral_contents=1500)
    gas = Unit(UnitTypeId.ASSIMILATOR, tag=101, position=(53, 50), is_structure=True,
               vespene_contents=2250, assigned_harvesters=1, ideal_harvesters=3)
    bot.mineral_field = [mineral]
    bot.structures = [gas]
    return bot, mineral, gas


def harvest_order(target):
    return SimpleNamespace(ability=SimpleNamespace(id=AbilityId.HARVEST_GATHER_PROBE,
                                                   exact_id=AbilityId.HARVEST_GATHER_PROBE),
                           target=target, progress=0.0)


def test_repeated_gas_assignment_selects_distinct_mineral_workers():
    bot, mineral, gas = harvest_scene()
    workers = [Unit(UnitTypeId.PROBE, tag=index, is_idle=False,
                    abilities=[AbilityId.HARVEST_GATHER], orders=[harvest_order(mineral.tag)])
               for index in (1, 2, 3)]
    bot.units = workers
    gas_action = ACTION_TO_INDEX["harvest_gas"]
    for expected in workers:
        mask = asyncio.run(legal_action_mask(bot))
        assert mask[gas_action]
        intent = bot._pluto_action_context[gas_action]
        assert intent.sources == (expected,)
        assert intent.target is gas
        # Emulate the next observed gather order after the spatial command.
        expected.orders = [harvest_order(gas.tag)]
    mask = asyncio.run(legal_action_mask(bot))
    assert not mask[gas_action]


def test_failed_source_is_skipped_without_removing_it_from_the_observation():
    from pluto_sc2.fairplay import SELECTION_RETRY_SECONDS
    bot, mineral, gas = harvest_scene()
    first = Unit(UnitTypeId.PROBE, tag=1, abilities=[AbilityId.HARVEST_GATHER])
    second = Unit(UnitTypeId.PROBE, tag=2, position=(49, 50), abilities=[AbilityId.HARVEST_GATHER])
    bot.units = [first, second]
    observation = encode_observation(bot)
    bot.fairplay._remember_selection_failure(first.tag, bot.time)
    mask = asyncio.run(legal_action_mask(bot))
    gas_action = ACTION_TO_INDEX["harvest_gas"]
    assert mask[gas_action]
    assert bot._pluto_action_context[gas_action].sources == (second,)
    assert bot.queried == [second, gas]
    np.testing.assert_array_equal(encode_observation(bot), observation)
    bot.time += SELECTION_RETRY_SECONDS
    asyncio.run(legal_action_mask(bot))
    assert bot._pluto_action_context[gas_action].sources == (first,)


def test_resource_return_trip_does_not_reselect_same_gas_worker():
    bot, mineral, gas = harvest_scene()
    returning_gas = Unit(UnitTypeId.PROBE, tag=1, is_idle=False, is_carrying_vespene=True,
                         abilities=[AbilityId.HARVEST_GATHER], orders=[harvest_order(999)])
    mineral_worker = Unit(UnitTypeId.PROBE, tag=2, is_idle=False,
                          abilities=[AbilityId.HARVEST_GATHER], orders=[harvest_order(mineral.tag)])
    bot.units = [returning_gas, mineral_worker]
    asyncio.run(legal_action_mask(bot))
    assert bot._pluto_action_context[ACTION_TO_INDEX["harvest_gas"]].sources == (mineral_worker,)
    assert bot._pluto_action_context[ACTION_TO_INDEX["harvest_minerals"]].sources == (returning_gas,)


def building_source_scene(kind):
    bot = scene()
    ability = AbilityId.PROTOSSBUILD_ASSIMILATOR if kind == UnitTypeId.ASSIMILATOR else AbilityId.PROTOSSBUILD_PYLON
    bot.game_data.units[kind.value] = SimpleNamespace(
        creation_ability=SimpleNamespace(id=ability), footprint_radius=1.5 if kind == UnitTypeId.ASSIMILATOR else 1)
    bot.can_afford = lambda candidate: candidate == kind
    first = Unit(UnitTypeId.PROBE, tag=1, position=(50, 50),
                 abilities=[ability, AbilityId.HARVEST_GATHER])
    second = Unit(UnitTypeId.PROBE, tag=2, position=(52, 50),
                  abilities=[ability, AbilityId.HARVEST_GATHER])
    bot.units = [first, second, Unit(UnitTypeId.PROBE, tag=3, position=(140, 140), abilities=[ability])]
    bot.vespene_geyser = [Unit(UnitTypeId.VESPENEGEYSER, tag=100, position=(50, 50))]
    bot.placement_queries = []

    async def can_place(_ability, points):
        bot.placement_queries.extend(points)
        return [True] * len(points)

    async def can_place_single(_ability, point):
        bot.placement_queries.append(point)
        return True

    bot.can_place = can_place
    bot.can_place_single = can_place_single
    return bot, first, second


@pytest.mark.parametrize("kind", [UnitTypeId.PYLON, UnitTypeId.ASSIMILATOR])
def test_building_source_hook_skips_reserved_nearest_worker_before_placement_query(kind):
    bot, first, second = building_source_scene(kind)
    inspected = []

    def allowed(unit):
        assert not bot.placement_queries
        assert unit in (first, second)  # Hidden workers never reach the hook.
        inspected.append(unit)
        return unit is second

    bot.placement_source_allowed = allowed
    action = ACTION_TO_INDEX["build_" + kind.name.lower()]
    mask = asyncio.run(legal_action_mask(bot))
    assert inspected == [first, second] and bot.placement_queries
    assert mask[action] and bot._pluto_action_context[action].sources == (second,)


@pytest.mark.parametrize("kind", [UnitTypeId.PYLON, UnitTypeId.ASSIMILATOR])
def test_building_source_hook_with_no_eligible_worker_never_queries_placement(kind):
    bot, _, _ = building_source_scene(kind)
    bot.placement_source_allowed = lambda _: False
    mask = asyncio.run(legal_action_mask(bot))
    assert not mask[ACTION_TO_INDEX["build_" + kind.name.lower()]]
    assert not bot.placement_queries


@pytest.mark.parametrize("kind", [UnitTypeId.PYLON, UnitTypeId.ASSIMILATOR])
def test_building_source_without_hook_retains_nearest_visible_worker(kind):
    bot, first, _ = building_source_scene(kind)
    action = ACTION_TO_INDEX["build_" + kind.name.lower()]
    mask = asyncio.run(legal_action_mask(bot))
    assert mask[action] and bot._pluto_action_context[action].sources == (first,)


def test_building_source_hook_does_not_change_harvesting_sources():
    bot, first, _ = building_source_scene(UnitTypeId.PYLON)
    bot.mineral_field = [Unit(UnitTypeId.MINERALFIELD, tag=101, position=(51, 50), mineral_contents=1500)]
    bot.placement_source_allowed = lambda _: False
    mask = asyncio.run(legal_action_mask(bot))
    assert mask[ACTION_TO_INDEX["harvest_minerals"]]
    assert bot._pluto_action_context[ACTION_TO_INDEX["harvest_minerals"]].sources == (first,)
    assert not mask[ACTION_TO_INDEX["build_pylon"]]


def test_harvesting_prefers_idle_workers_and_preserves_build_or_scout_orders():
    bot, mineral, gas = harvest_scene()
    busy = Unit(UnitTypeId.PROBE, tag=1, is_idle=False, abilities=[AbilityId.HARVEST_GATHER],
                orders=[harvest_order(999)])
    mineral_worker = Unit(UnitTypeId.PROBE, tag=2, is_idle=False,
                          abilities=[AbilityId.HARVEST_GATHER], orders=[harvest_order(mineral.tag)])
    idle = Unit(UnitTypeId.PROBE, tag=3, abilities=[AbilityId.HARVEST_GATHER])
    bot.units = [busy, mineral_worker, idle]
    asyncio.run(legal_action_mask(bot))
    assert bot._pluto_action_context[ACTION_TO_INDEX["harvest_gas"]].sources == (idle,)
    assert bot._pluto_action_context[ACTION_TO_INDEX["harvest_minerals"]].sources == (idle,)
    bot.units = [busy]
    mask = asyncio.run(legal_action_mask(bot))
    assert not mask[ACTION_TO_INDEX["harvest_gas"]]
    assert not mask[ACTION_TO_INDEX["harvest_minerals"]]


@pytest.mark.parametrize("ability,action", [
    ("PROTOSSBUILD_CYBERNETICSCORE", "build_cyberneticscore"),
    ("WARPGATETRAIN_STALKER", "train_stalker"),
    ("TRAINWARP_ADEPT", "train_adept"),
    ("FORGERESEARCH_PROTOSSGROUNDARMORLEVEL1", "research_protossgroundarmorslevel1"),
    ("CYBERNETICSCORERESEARCH_PROTOSSAIRARMORLEVEL2", "research_protossairarmorslevel2"),
])
def test_replay_labels_match_macro_contract(ability, action):
    assert replay_action_for_ability(ability) == ACTION_TO_INDEX[action]


def test_unknown_or_ambiguous_replay_actions_are_not_no_op():
    assert replay_action_for_ability("STOP_STOP") is None
    assert replay_action_for_ability("SMART") is None
    assert replay_action_for_ability("HARVEST_GATHER") is None
    assert replay_action_for_ability("NOT_AN_ABILITY") is None


class FakePolicy:
    def value(self, observation):
        return 0.75


def pending_bot():
    bot = NeuralBot(FakePolicy(), fairplay=FairPlayController())
    bot.state = SimpleNamespace(game_loop=224, upgrades=set())
    bot._pending_transition = (
        np.zeros(OBSERVATION_SIZE, dtype=np.float32), np.ones(len(ACTION_NAMES), dtype=np.bool_),
        0, -0.5, 0.25, 0.0,
    )
    return bot


def test_terminal_reward_zeroes_bootstrap():
    bot = pending_bot()
    bot._finish_transition(np.zeros(OBSERVATION_SIZE), terminated=True, truncated=False, outcome=1)
    transition = bot.transitions[0]
    assert transition.reward == 1
    assert transition.next_value == 0
    assert transition.terminated and not transition.truncated
    bot._finish_transition(np.zeros(OBSERVATION_SIZE), terminated=True, truncated=False, outcome=1)
    assert len(bot.transitions) == 1


def test_timeout_bootstraps_instead_of_teaching_defeat():
    bot = pending_bot()
    bot._finish_transition(np.zeros(OBSERVATION_SIZE), terminated=False, truncated=True)
    transition = bot.transitions[0]
    assert transition.reward == 0
    assert transition.next_value == 0.75
    assert transition.truncated and not transition.terminated


def test_tie_from_runner_cap_truncates_even_when_last_state_is_earlier(monkeypatch):
    bot = pending_bot()
    monkeypatch.setattr("pluto_sc2.sc2_adapter.encode_observation", lambda _: np.zeros(BASE_OBSERVATION_SIZE, dtype=np.float32))
    assert bot.time < bot.max_game_seconds
    asyncio.run(bot.on_end(Result.Tie))
    asyncio.run(bot.on_end(Result.Tie))
    assert len(bot.transitions) == 1
    assert bot.transitions[0].truncated
    assert bot.transitions[0].next_value == 0.75


def test_observation_history_updates_once_per_engine_loop(monkeypatch):
    bot = pending_bot()
    calls = []

    def encode(_):
        calls.append(1)
        return np.full(BASE_OBSERVATION_SIZE, len(calls), dtype=np.float32)

    monkeypatch.setattr("pluto_sc2.sc2_adapter.encode_observation", encode)
    first = bot._observe()
    np.testing.assert_array_equal(bot._observe(), first)
    assert len(calls) == 1
    bot.state.game_loop += 8
    second = bot._observe()
    assert len(calls) == 2
    assert np.all(second[-BASE_OBSERVATION_SIZE:] == 2)
    assert np.all(second[-2 * BASE_OBSERVATION_SIZE:-BASE_OBSERVATION_SIZE] == 1)


def test_wrong_worker_start_fails_before_learning():
    bot = pending_bot()
    bot.race = Race.Protoss
    bot.workers = [object()] * 12
    bot.townhalls = [object()]
    with pytest.raises(ValueError, match="Eight-worker Protoss scenario required"):
        asyncio.run(bot.on_start())
    assert not bot.transitions
    assert "workers=12" in bot.error


def test_eight_worker_start_resets_controller_without_modifying_units():
    bot = pending_bot()
    bot.race = Race.Protoss
    bot.workers = [object()] * 8
    bot.townhalls = [object()]
    bot.client = SimpleNamespace(game_step=1)
    bot.game_info = SimpleNamespace(player_start_location=Point2((50, 50)))
    asyncio.run(bot.on_start())
    assert len(bot.workers) == 8
    assert bot.client.game_step == 8
    assert bot.fairplay.camera_center == Point2((50, 50))
