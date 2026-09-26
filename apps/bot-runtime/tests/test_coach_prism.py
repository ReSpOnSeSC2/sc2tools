import asyncio
from collections import Counter
from types import SimpleNamespace as NS

import pytest
from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.position import Point2

from pluto_sc2.coach_prism import CoachPrism


def unit(kind, tag, point=(50, 50), **kwargs):
    values = dict(type_id=kind, tag=tag, position=Point2(point), is_ready=True,
                  is_structure=False, is_flying=False, is_visible=True, is_snapshot=False,
                  is_mine=True, can_attack_ground=True, can_attack_air=False,
                  health=100, health_max=100, shield=80, shield_max=80,
                  ground_range=4, air_range=4, radius=.5, ground_dps=8, air_dps=8,
                  cargo_size=2, cargo_used=0, cargo_max=8, passengers=())
    if kind == U.WARPPRISM:
        values.update(is_flying=True, can_attack_ground=False, cargo_size=0)
    values.update(kwargs)
    return NS(**values)


def setup_bot(*, abilities=None, accepted=True, cast_range=5.0):
    calls = []
    abilities = ({A.LOAD_WARPPRISM, A.UNLOADALLAT_WARPPRISM, A.MOVE_MOVE}
                 if abilities is None else set(abilities))

    async def query(sources, **kwargs):
        calls.append(("query", sources, kwargs))
        return [list(abilities) for _ in sources]

    async def issue(bot, sources, ability, target, **kwargs):
        calls.append(("issue", sources, ability, target, kwargs))
        return accepted

    bot = NS(time=10.0, game_data=NS(abilities={A.LOAD_WARPPRISM.value:
             NS(id=A.LOAD_WARPPRISM, _proto=NS(cast_range=cast_range))}),
             fairplay=NS(on_screen=lambda _: True, source_available=lambda *_: True, issue=issue),
             get_available_abilities=query, is_visible=lambda _: True, in_pathing_grid=lambda _: True,
             action_counts=Counter(), _record_selection=lambda *args: calls.append(("record", args)))
    return bot, calls


def battle():
    prism = unit(U.WARPPRISM, 1)
    immortal = unit(U.IMMORTAL, 2, (52, 50), health=20, shield=0, cargo_size=4)
    enemy = unit(U.MARAUDER, 3, (55, 50), is_mine=False)
    return prism, immortal, enemy


def commands(calls):
    return [call for call in calls if call[0] == "issue"]


def test_pickup_one_damaged_unit_with_single_prism_selection_and_real_gate():
    bot, calls = setup_bot()
    prism, immortal, enemy = battle()
    second_prism = unit(U.WARPPRISM, 4)
    controller = CoachPrism()
    assert asyncio.run(controller.step(bot, [prism, second_prism, immortal], [enemy]))
    command = commands(calls)[0]
    assert command[1] == [prism]
    assert command[2] == A.LOAD_WARPPRISM and command[3] is immortal
    assert command[4] == {"minimap": False}
    assert calls[0][0] == "query" and calls[0][2] == {"ignore_resource_requirements": False}
    assert controller.protected_tags == {1: 13, 2: 13}
    assert controller.status == "selection_pending"
    # Accepted selection is not treated as evidence that the passenger loaded.
    bot.time = 11
    assert not asyncio.run(controller.step(bot, [prism, immortal], [enemy]))
    assert controller.status == "awaiting_observed_pickup" and len(commands(calls)) == 1


@pytest.mark.parametrize("changed", [
    {"type_id": U.PROBE}, {"type_id": U.OBSERVER}, {"is_structure": True},
    {"is_flying": True}, {"is_hallucination": True}, {"is_burrowed": True},
    {"is_visible": False}, {"is_snapshot": True}, {"is_mine": False},
    {"health": 100, "shield": 80}, {"cargo_size": 9}, {"cargo_size": 0},
    {"position": Point2((56, 50))},
])
def test_refuses_ineligible_pickups(changed):
    bot, calls = setup_bot()
    prism, target, enemy = battle()
    for key, value in changed.items():
        setattr(target, key, value)
    assert not asyncio.run(CoachPrism().step(bot, [prism, target], [enemy]))
    assert not commands(calls)


@pytest.mark.parametrize("cast_range", [0, -1, float("nan")])
def test_unknown_public_load_range_fails_closed(cast_range):
    bot, calls = setup_bot(cast_range=cast_range)
    prism, target, enemy = battle()
    controller = CoachPrism()
    assert not asyncio.run(controller.step(bot, [prism, target], [enemy]))
    assert not calls
    assert controller.status == "load_range_unknown"
    assert controller.summary(bot.time)["load_range_status"] == "missing_or_zero"
    assert controller.summary(bot.time)["public_load_range"] == 0


def test_no_pickup_without_visible_pressure_or_with_scout_or_unavailable_target():
    for excluded in ("no_pressure", "scout", "source_unavailable", "offscreen_target"):
        bot, calls = setup_bot()
        prism, target, enemy = battle()
        if excluded == "no_pressure":
            enemy.is_visible = False
        if excluded == "scout":
            bot._nonworker_scout_tags = {target.tag}
        if excluded == "source_unavailable":
            bot.fairplay.source_available = lambda unit, _: unit.tag != target.tag
        if excluded == "offscreen_target":
            bot.fairplay.on_screen = lambda obj: getattr(obj, "tag", None) != target.tag
        assert not asyncio.run(CoachPrism().step(bot, [prism, target], [enemy]))
        assert not calls


def test_unavailable_ability_or_rejected_gate_does_not_claim_rescue():
    for options in ({"abilities": []}, {"accepted": False}):
        bot, calls = setup_bot(**options)
        prism, target, enemy = battle()
        controller = CoachPrism()
        assert not asyncio.run(controller.step(bot, [prism, target], [enemy]))
        assert controller.last_input == -100 and not controller.protected_tags
        assert not bot.action_counts


def test_observed_cargo_retreats_then_unloads_immediately_at_safe_spot():
    bot, calls = setup_bot()
    prism, target, enemy = battle()
    prism.cargo_used = 4
    prism.passengers = (NS(tag=target.tag),)  # Cargo has no world-position data.
    controller = CoachPrism()
    assert asyncio.run(controller.step(bot, [prism], [enemy]))
    command = commands(calls)[0]
    assert command[2] == A.MOVE_MOVE and command[3].x < prism.position.x
    assert controller.last_reason == "cargo_retreat"
    prism.position = command[3]
    bot.time = 12
    assert asyncio.run(controller.step(bot, [prism], [enemy]))
    command = commands(calls)[1]
    assert command[2] == A.UNLOADALLAT_WARPPRISM and command[3] == prism.position
    assert controller.last_reason == "safe_unload"


def test_safe_cargo_is_not_hoarded_or_replaced_with_more_pickups():
    bot, calls = setup_bot()
    prism = unit(U.WARPPRISM, 1, cargo_used=4)
    assert asyncio.run(CoachPrism().step(bot, [prism], []))
    assert commands(calls)[0][2] == A.UNLOADALLAT_WARPPRISM


def test_does_not_unload_cargo_into_ground_threat_or_higher_air_threat():
    bot, calls = setup_bot()
    prism = unit(U.WARPPRISM, 1, cargo_used=4)
    ground_enemy = unit(U.MARAUDER, 2, (55, 50), is_mine=False)
    air_enemy = unit(U.VIKINGFIGHTER, 3, (44, 50), is_mine=False,
                     can_attack_ground=False, can_attack_air=True, air_range=3, air_dps=30)
    assert asyncio.run(CoachPrism().step(bot, [prism], [ground_enemy, air_enemy]))
    command = commands(calls)[0]
    assert command[2] == A.MOVE_MOVE
    # Straight west away from the Marauder is unsafe because of the Viking.
    assert abs(command[3].y - 50) > 2


def test_no_fog_or_offscreen_pathing_queries_and_no_unsafe_unload():
    bot, calls = setup_bot()
    prism = unit(U.WARPPRISM, 1, cargo_used=4)
    enemy = unit(U.MARAUDER, 2, (55, 50), is_mine=False)
    bot.is_visible = lambda _: False
    bot.in_pathing_grid = lambda _: pytest.fail("Queried pathing behind fog")
    controller = CoachPrism()
    assert not asyncio.run(controller.step(bot, [prism], [enemy]))
    assert controller.status == "no_legal_local_escape" and not calls
    bot.is_visible = lambda _: True
    bot.fairplay.on_screen = lambda obj: hasattr(obj, "tag")
    assert not asyncio.run(controller.step(bot, [prism], [enemy]))
    assert not calls


def test_phased_offscreen_or_unavailable_prism_cannot_issue_or_query():
    for case in ("phased", "offscreen", "unavailable"):
        bot, calls = setup_bot()
        prism, target, enemy = battle()
        if case == "phased":
            prism.type_id = U.WARPPRISMPHASING
        if case == "offscreen":
            bot.fairplay.on_screen = lambda obj: getattr(obj, "tag", None) != prism.tag
        if case == "unavailable":
            bot.fairplay.source_available = lambda unit, _: unit.tag != prism.tag
        assert not asyncio.run(CoachPrism().step(bot, [prism, target], [enemy]))
        assert not calls


def test_cannot_unload_above_a_building_or_blocked_terrain():
    bot, calls = setup_bot()
    prism = unit(U.WARPPRISM, 1, cargo_used=4)
    nexus = unit(U.NEXUS, 2, is_structure=True, radius=2.75)
    controller = CoachPrism()
    assert asyncio.run(controller.step(bot, [prism, nexus], []))
    assert commands(calls)[0][2] == A.MOVE_MOVE
    assert commands(calls)[0][3].distance_to(nexus.position) >= 3.75
    calls.clear()
    bot.time = 12
    bot.in_pathing_grid = lambda _: False
    assert not asyncio.run(controller.step(bot, [prism], []))
    assert not commands(calls)


def test_duplicate_move_is_not_spammed(monkeypatch):
    monkeypatch.setattr("pluto_sc2.coach_prism.duplicate_order", lambda *_: True)
    bot, calls = setup_bot()
    prism = unit(U.WARPPRISM, 1, cargo_used=4)
    assert not asyncio.run(CoachPrism().step(bot, [prism], []))
    assert not commands(calls)


def test_rescue_can_run_during_coach_retreat_stance():
    bot, calls = setup_bot()
    prism, target, enemy = battle()
    assert asyncio.run(CoachPrism().step(bot, [prism, target], [enemy], NS(stance="retreat")))
    assert commands(calls)[0][2] == A.LOAD_WARPPRISM


def test_failed_pickup_times_out_without_assuming_passenger_or_holding_target_forever():
    bot, calls = setup_bot()
    prism, target, enemy = battle()
    controller = CoachPrism()
    assert asyncio.run(controller.step(bot, [prism, target], [enemy]))
    bot.time = 14
    # No passenger appeared and the target has left view. No global roster read.
    assert not asyncio.run(controller.step(bot, [prism], []))
    assert not controller._pending_pickups and not controller.protected_tags
    assert controller.summary(bot.time)["last_pickup_result"] == "not_observed_by_timeout"
    assert len(commands(calls)) == 1


def test_owned_cloaked_prism_and_army_can_rescue_but_enemy_cloak_still_requires_detection():
    bot, calls = setup_bot()
    prism, target, enemy = battle()
    prism.is_cloaked = target.is_cloaked = True
    prism.is_revealed = target.is_revealed = False
    assert asyncio.run(CoachPrism().step(bot, [prism, target], [enemy]))
    assert commands(calls)[0][3] is target
    calls.clear()
    enemy.is_cloaked, enemy.is_revealed = True, False
    assert not asyncio.run(CoachPrism().step(bot, [prism, target], [enemy]))
    assert not commands(calls)
