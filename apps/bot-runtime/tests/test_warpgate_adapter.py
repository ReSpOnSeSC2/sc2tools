"""Warp Gate legality using the installed SC2 ability tables, without a game."""
import asyncio

import pytest
from sc2.dicts.unit_research_abilities import RESEARCH_INFO
from sc2.dicts.unit_train_build_abilities import TRAIN_INFO
from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.ids.upgrade_id import UpgradeId as G
from sc2.position import Point2

from pluto_sc2.sc2_adapter import _visible_footprint, legal_action_mask
from pluto_sc2.schema import ACTION_TO_INDEX
from test_adapter import Unit, scene


def warp_scene(kind=U.STALKER, *, abilities=None, idle=True, position=(50, 50)):
    bot = scene()
    ability = TRAIN_INFO[U.WARPGATE][kind]["ability"]
    gate = Unit(U.WARPGATE, position=position, is_structure=True, is_idle=idle,
                abilities=[ability] if abilities is None else abilities)
    bot.structures = [gate]
    bot.can_afford = lambda requested: requested == kind
    bot.placement_queries = []
    bot.ability_query_options = []

    async def available(units, **options):
        bot.queried.extend(units)
        bot.ability_query_options.append(options)
        return [unit.abilities for unit in units]

    async def placement(requested, points):
        bot.placement_queries.append((requested, list(points)))
        return [True] * len(points)

    bot.get_available_abilities = available
    bot.can_place = placement
    return bot, gate


def mask_for(bot):
    return asyncio.run(legal_action_mask(bot))


@pytest.mark.parametrize("kind,ability,number", [
    (U.ZEALOT, A.WARPGATETRAIN_ZEALOT, 1413),
    (U.STALKER, A.WARPGATETRAIN_STALKER, 1414),
    (U.HIGHTEMPLAR, A.WARPGATETRAIN_HIGHTEMPLAR, 1416),
    (U.DARKTEMPLAR, A.WARPGATETRAIN_DARKTEMPLAR, 1417),
    (U.SENTRY, A.WARPGATETRAIN_SENTRY, 1418),
    (U.ADEPT, A.TRAINWARP_ADEPT, 1419),
])
def test_each_gateway_unit_uses_exact_warp_ability_and_placement(kind, ability, number):
    bot, gate = warp_scene(kind)
    index = ACTION_TO_INDEX["train_" + kind.name.lower()]
    info = TRAIN_INFO[U.WARPGATE][kind]
    assert info["ability"] == ability and ability.value == number
    assert info["requires_placement_position"] and info["requires_power"]
    assert mask_for(bot)[index]
    intent = bot._pluto_action_context[index]
    assert intent.sources == (gate,)
    assert intent.ability == ability
    assert isinstance(intent.target, Point2)
    assert bot.placement_queries
    assert all(requested == ability for requested, _ in bot.placement_queries)
    assert bot.ability_query_options == [{"ignore_resource_requirements": False}]


@pytest.mark.parametrize("restriction", ["resources", "supply", "cooldown", "busy"])
def test_warp_in_mask_blocks_missing_resources_supply_cooldown_or_busy_gate(restriction):
    bot, gate = warp_scene()
    if restriction == "resources":
        bot.can_afford = lambda _: False
    elif restriction == "supply":
        bot.can_feed = lambda _: False
    elif restriction == "cooldown":
        # A cooled-down Warp Gate can report idle; current ability availability
        # remains authoritative. We never invent a timer to unlock the ability.
        gate.abilities = []
    else:
        gate.is_idle = False
    index = ACTION_TO_INDEX["train_stalker"]
    assert not mask_for(bot)[index]
    assert index not in bot._pluto_action_context
    assert not bot.placement_queries


def test_ready_gate_is_selected_when_lower_tag_gate_is_on_cooldown():
    bot, cooling = warp_scene(abilities=[])
    ready = Unit(U.WARPGATE, tag=2, is_structure=True, abilities=[A.WARPGATETRAIN_STALKER])
    bot.structures.append(ready)
    index = ACTION_TO_INDEX["train_stalker"]
    assert cooling.is_idle
    assert mask_for(bot)[index]
    assert bot._pluto_action_context[index].sources == (ready,)


def test_offscreen_warp_gate_is_not_queried_or_used():
    bot, gate = warp_scene(position=(140, 140))
    assert not mask_for(bot)[ACTION_TO_INDEX["train_stalker"]]
    assert gate not in bot.queried
    assert not bot.placement_queries


def test_entirely_fogged_warp_destinations_do_not_trigger_placement_queries():
    bot, _ = warp_scene()
    bot.is_visible = lambda _: False
    assert not mask_for(bot)[ACTION_TO_INDEX["train_stalker"]]
    assert not bot.placement_queries


def test_partial_fog_queries_only_fully_visible_camera_footprints():
    bot, _ = warp_scene()
    bot.is_visible = lambda point: point.x < 50
    assert mask_for(bot)[ACTION_TO_INDEX["train_stalker"]]
    queried = [point for _, points in bot.placement_queries for point in points]
    assert queried
    assert Point2((50, 50)) not in queried
    assert all(_visible_footprint(bot, point, 1.0) for point in queried)
    target = bot._pluto_action_context[ACTION_TO_INDEX["train_stalker"]].target
    assert target in queried and bot.fairplay.on_screen(target)


def test_engine_rejected_warp_placement_does_not_create_an_intent():
    bot, _ = warp_scene()

    async def reject(ability, points):
        return [False] * len(points)

    bot.can_place = reject
    index = ACTION_TO_INDEX["train_stalker"]
    assert not mask_for(bot)[index]
    assert index not in bot._pluto_action_context


def test_ordinary_gateway_uses_gateway_train_without_warp_placement():
    bot, gate = warp_scene()
    gate.type_id = U.GATEWAY
    gate.abilities = [A.GATEWAYTRAIN_STALKER]
    index = ACTION_TO_INDEX["train_stalker"]
    assert mask_for(bot)[index]
    intent = bot._pluto_action_context[index]
    assert intent.ability == A.GATEWAYTRAIN_STALKER
    assert intent.target is None
    assert not bot.placement_queries


@pytest.mark.parametrize("restriction", [None, "busy", "resources", "unavailable", "completed", "offscreen"])
def test_warpgate_research_uses_available_idle_affordable_visible_core(restriction):
    bot = scene()
    core = Unit(U.CYBERNETICSCORE, is_structure=True, abilities=[A.RESEARCH_WARPGATE])
    bot.structures = [core]
    bot.can_afford = lambda kind: kind == G.WARPGATERESEARCH
    assert RESEARCH_INFO[U.CYBERNETICSCORE][G.WARPGATERESEARCH]["ability"] == A.RESEARCH_WARPGATE
    if restriction == "busy":
        core.is_idle = False
    elif restriction == "resources":
        bot.can_afford = lambda _: False
    elif restriction == "unavailable":
        core.abilities = []
    elif restriction == "completed":
        bot.state.upgrades.add(G.WARPGATERESEARCH)
    elif restriction == "offscreen":
        core.position = Point2((140, 140))
    index = ACTION_TO_INDEX["research_warpgateresearch"]
    assert bool(mask_for(bot)[index]) is (restriction is None)
    if restriction is None:
        intent = bot._pluto_action_context[index]
        assert intent.sources == (core,)
        assert intent.ability == A.RESEARCH_WARPGATE
    if restriction == "offscreen":
        assert core not in bot.queried


@pytest.mark.parametrize("restriction", [None, "unavailable", "offscreen"])
def test_opt_in_warpgate_morph_requires_current_available_visible_source(restriction):
    bot = scene()
    gate = Unit(U.GATEWAY, is_structure=True, abilities=[A.MORPH_WARPGATE])
    bot.structures = [gate]
    if restriction == "unavailable":
        gate.abilities = []
    elif restriction == "offscreen":
        gate.position = Point2((140, 140))
    index = ACTION_TO_INDEX["morph_warpgate"]
    assert bool(mask_for(bot)[index]) is (restriction is None)
    if restriction is None:
        intent = bot._pluto_action_context[index]
        assert intent.sources == (gate,)
        assert intent.ability == A.MORPH_WARPGATE
