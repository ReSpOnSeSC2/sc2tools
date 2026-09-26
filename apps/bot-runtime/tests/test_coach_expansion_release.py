import asyncio
from types import SimpleNamespace as NS

import pytest
from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.position import Point2

from pluto_sc2.sc2_adapter import legal_action_mask
from pluto_sc2.schema import ACTION_TO_INDEX
from test_adapter import Unit
from test_coach_bot import known_base, order, world


def pending_expansion(tmp_path):
    bot = world(tmp_path)
    bot.memory.own[99] = known_base()
    bot._opening_decision = NS(active=True, allow_expansion=False)
    bot._expansion = dict(position=[80, 50], source_tag=7, started=5,
                          move_confirmed=True, wait_reason="build_selection_pending")
    return bot


@pytest.mark.parametrize("ready", [False, True])
def test_observed_nexus_releases_builder_before_opening_expansion_gate(tmp_path, ready):
    bot = pending_expansion(tmp_path)
    bot.memory.own[100] = dict(known_base(position=(80, 50), tag=100),
                               is_ready=ready, build_progress=1 if ready else .01)
    worker = Unit(U.PROBE, tag=7, position=(78.5, 52.5))
    assert not bot.placement_source_allowed(worker)
    assert not asyncio.run(bot._expansion_step([worker], order(base_target=4)))
    assert bot._expansion is None and bot.placement_source_allowed(worker)
    assert not bot.client.requests  # Retirement cannot create a new expansion.
    assert not asyncio.run(bot._expansion_step([worker], order(base_target=4)))
    assert bot._expansion is None and not bot.client.requests


@pytest.mark.parametrize("evidence", ["none", "reservation", "worker_order", "other_structure", "other_site"])
def test_unobserved_or_wrong_site_nexus_cannot_release_reserved_builder(tmp_path, evidence):
    bot = pending_expansion(tmp_path)
    if evidence == "reservation":
        bot._construction = [dict(type="NEXUS", position=[80, 50], source_tag=7)]
    elif evidence == "worker_order":
        bot.memory.own[7] = dict(type="PROBE", position=[80, 50], orders=[
            dict(produces="NEXUS", target=[80, 50])])
    elif evidence == "other_structure":
        bot.memory.own[100] = dict(known_base(position=(80, 50), tag=100), type="PYLON")
    elif evidence == "other_site":
        bot.memory.own[100] = known_base(position=(83, 50), tag=100)
    task = dict(bot._expansion)
    assert not asyncio.run(bot._expansion_step([], order()))
    assert bot._expansion == task
    assert not bot.placement_source_allowed(Unit(U.PROBE, tag=7))
    assert not bot.client.requests


def test_unseen_inactive_task_remains_reserved_without_new_expansion_authorization(tmp_path):
    bot = pending_expansion(tmp_path)
    bot._opening_decision = NS(active=False)
    bot.minerals = 0
    assert not asyncio.run(bot._expansion_step([], order(base_target=1)))
    assert bot._expansion is not None
    assert not bot.placement_source_allowed(Unit(U.PROBE, tag=7))
    assert not bot.client.requests


def test_released_idle_natural_builder_becomes_legal_pylon_source(tmp_path):
    bot = pending_expansion(tmp_path)
    bot.memory.own[100] = dict(known_base(position=(80, 50), tag=100), is_ready=False)
    worker = Unit(U.PROBE, tag=7, position=(78.5, 52.5), abilities=[A.PROTOSSBUILD_PYLON], is_idle=True)
    bot.units = [worker]
    bot.structures = [Unit(U.NEXUS, tag=100, position=(80, 50), is_structure=True, is_ready=False)]
    bot.fairplay.camera_center = Point2((80, 50))
    bot._worker_scout_lease.choose = lambda _: None
    bot.can_afford = lambda kind: kind == U.PYLON
    bot.can_feed = lambda _: False
    bot.game_data.units[U.PYLON.value] = NS(creation_ability=NS(id=A.PROTOSSBUILD_PYLON), footprint_radius=1)

    async def abilities(units, **kwargs):
        return [getattr(unit, "abilities", []) for unit in units]

    async def can_place(_ability, points):
        return [True] * len(points)

    bot.get_available_abilities = abilities
    bot.can_place = can_place
    action = ACTION_TO_INDEX["build_pylon"]
    assert not asyncio.run(legal_action_mask(bot))[action]
    assert not asyncio.run(bot._expansion_step([worker], order()))
    assert asyncio.run(legal_action_mask(bot))[action]
    assert bot._pluto_action_context[action].sources == (worker,)
    assert not bot.client.requests  # A legal intent is not a sent native action.


def test_foundation_retirement_runs_before_any_macro_input_priority(tmp_path):
    bot = pending_expansion(tmp_path)
    bot.memory.own[100] = dict(known_base(position=(80, 50), tag=100), is_ready=False)
    bot._confirm_commands([])
    assert bot._expansion is None
    assert bot.placement_source_allowed(Unit(U.PROBE, tag=7))
    assert not bot.client.requests
