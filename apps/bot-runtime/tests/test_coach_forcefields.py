import asyncio
from collections import Counter
from types import SimpleNamespace as NS

import pytest
from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.position import Point2

from pluto_sc2.coach_forcefields import ACTION_NAME, CoachForceFields


def unit(kind, tag, point, **kwargs):
    values = dict(type_id=kind, tag=tag, position=Point2(point), is_ready=True,
                  is_structure=False, is_flying=False, is_visible=True, is_snapshot=False,
                  is_mine=True, can_attack_ground=True, ground_range=6,
                  is_hallucination=False, is_massive=False, radius=.5, orders=[])
    values.update(kwargs)
    return NS(**values)


def battle():
    return ([unit(U.SENTRY, 1, (50, 49.5)), unit(U.STALKER, 2, (50, 50.5))],
            [unit(U.ZERGLING, 3, (58, 50), is_mine=False, ground_range=.1),
             unit(U.ZERGLING, 4, (59, 51), is_mine=False, ground_range=.1)])


def setup_bot(*, cast_range=9.0, available=True, accepted=True):
    calls = []

    async def abilities(sources, **kwargs):
        calls.append(("query", sources, kwargs))
        return [[A.FORCEFIELD_FORCEFIELD] if available else [] for _ in sources]

    async def issue(bot, sources, ability, target, **kwargs):
        calls.append(("issue", sources, ability, target, kwargs))
        return accepted

    def pathing(point):
        calls.append(("terrain", point))
        return abs(point.y - 50) < 1.9

    bot = NS(time=10.0, game_data=NS(abilities={A.FORCEFIELD_FORCEFIELD.value:
             NS(id=A.FORCEFIELD_FORCEFIELD, _proto=NS(cast_range=cast_range))}),
             fairplay=NS(on_screen=lambda _: True, source_available=lambda *_: True, issue=issue),
             get_available_abilities=abilities, in_pathing_grid=pathing, is_visible=lambda _: True,
             action_counts=Counter(), _record_selection=lambda *args: calls.append(("record", args)))
    return bot, calls


def issued(calls):
    return [call for call in calls if call[0] == "issue"]


def test_verified_local_choke_selects_one_sentry_through_engine_and_fairplay():
    bot, calls = setup_bot()
    own, enemies = battle()
    controller = CoachForceFields()
    assert asyncio.run(controller.step(bot, own, enemies))
    command = issued(calls)[0]
    assert command[1] == [own[0]] and command[2] == A.FORCEFIELD_FORCEFIELD
    assert command[3] == Point2((53.5, 50)) and command[4] == {"minimap": False}
    query = next(call for call in calls if call[0] == "query")
    assert query[2] == {"ignore_resource_requirements": False}
    assert controller.pending and controller.status == "selection_pending"
    assert not controller.recent_targets and controller.confirmed_commands == 0
    assert controller.protected_tags == {1: 13}


def test_only_matching_command_confirmation_creates_recent_target_memory():
    bot, calls = setup_bot()
    own, enemies = battle()
    controller = CoachForceFields()
    assert asyncio.run(controller.step(bot, own, enemies))
    target = issued(calls)[0][3]
    controller.confirm("combat_other", True, 11, [1], target)
    controller.confirm(ACTION_NAME, True, 11, [999], target)
    controller.confirm(ACTION_NAME, True, 11, [1], (70, 70))
    assert controller.pending and not controller.recent_targets
    controller.confirm(ACTION_NAME, True, 11, [1], list(target))
    assert controller.pending is None and controller.confirmed_commands == 1
    assert controller.recent_targets == [(target, 26)]
    assert controller.summary(11)["status"] == "command_confirmed"
    # A duplicate completion event must not double-count the command.
    controller.confirm(ACTION_NAME, True, 12, [1], list(target))
    assert controller.confirmed_commands == 1


@pytest.mark.parametrize("case", ["open", "one_wall", "blocked_center", "blocked_retreat"])
def test_refuses_open_unverified_or_trapping_terrain(case):
    bot, calls = setup_bot()
    own, enemies = battle()
    if case == "open":
        bot.in_pathing_grid = lambda _: True
    elif case == "one_wall":
        bot.in_pathing_grid = lambda point: point.y < 51.9
    elif case == "blocked_center":
        bot.in_pathing_grid = lambda _: False
    else:
        bot.in_pathing_grid = lambda point: point.x > 49 and abs(point.y - 50) < 1.9
    assert not asyncio.run(CoachForceFields().step(bot, own, enemies))
    assert not issued(calls)


@pytest.mark.parametrize("case", ["fog_wall", "fog_retreat", "offscreen_wall"])
def test_all_terrain_sampling_waits_for_complete_current_visibility(case):
    bot, calls = setup_bot()
    own, enemies = battle()
    if case == "fog_wall":
        bot.is_visible = lambda point: point.y < 51.9
    elif case == "fog_retreat":
        bot.is_visible = lambda point: point.x > 49
    else:
        bot.fairplay.on_screen = lambda obj: hasattr(obj, "tag") or obj.y < 51.9
    bot.in_pathing_grid = lambda _: pytest.fail("Queried terrain before complete visibility")
    assert not asyncio.run(CoachForceFields().step(bot, own, enemies))
    assert not issued(calls)


@pytest.mark.parametrize("case", ["friendly_front", "friendly_footprint", "friendly_move_route",
                                    "massive_enemy", "massive_ally"])
def test_does_not_trap_friendly_units_cross_retreat_routes_or_waste_field_on_massive(case):
    bot, calls = setup_bot()
    own, enemies = battle()
    if case == "friendly_front":
        own.append(unit(U.ZEALOT, 5, (59, 50), ground_range=.1))
    elif case == "friendly_footprint":
        own.append(unit(U.PROBE, 5, (54.5, 50), ground_range=.1))
    elif case == "friendly_move_route":
        own[1].orders = [NS(ability=NS(id=A.MOVE_MOVE), target=Point2((60, 50)))]
    elif case == "massive_enemy":
        enemies.append(unit(U.ULTRALISK, 5, (60, 50), is_mine=False, ground_range=1, is_massive=True))
    else:
        own.append(unit(U.COLOSSUS, 5, (46, 50), ground_range=7, is_massive=True))
    assert not asyncio.run(CoachForceFields().step(bot, own, enemies))
    assert not issued(calls)


@pytest.mark.parametrize("case", ["one_enemy", "one_friend", "enemy_hidden", "enemy_flying",
                                    "enemy_worker", "enemy_ranged", "enemy_snapshot", "surrounded",
                                    "own_hallucination", "sentry_offscreen", "sentry_leased"])
def test_requires_actual_current_local_melee_pressure_and_ranged_group(case):
    bot, calls = setup_bot()
    own, enemies = battle()
    if case == "one_enemy":
        enemies = enemies[:1]
    elif case == "one_friend":
        own = own[:1]
    elif case == "enemy_hidden":
        enemies[0].is_visible = False
    elif case == "enemy_flying":
        enemies[0].is_flying = True
    elif case == "enemy_worker":
        enemies[0].type_id = U.DRONE
    elif case == "enemy_ranged":
        enemies[0].ground_range = 6
    elif case == "enemy_snapshot":
        enemies[0].is_snapshot = True
    elif case == "surrounded":
        enemies[0].position = Point2((52, 50))
    elif case == "own_hallucination":
        own[1].is_hallucination = True
    elif case == "sentry_offscreen":
        bot.fairplay.on_screen = lambda obj: getattr(obj, "tag", None) != own[0].tag
    else:
        bot.fairplay.source_available = lambda *_: False
    assert not asyncio.run(CoachForceFields().step(bot, own, enemies))
    assert not issued(calls)


@pytest.mark.parametrize("cast_range", [0, -1, float("nan"), 1])
def test_uses_installed_public_cast_range_instead_of_chasing_out_of_range(cast_range):
    bot, calls = setup_bot(cast_range=cast_range)
    own, enemies = battle()
    controller = CoachForceFields()
    assert not asyncio.run(controller.step(bot, own, enemies))
    assert not issued(calls)
    if cast_range != 1:
        assert controller.status == "cast_range_unknown"


def test_ability_and_input_gate_failure_never_create_cast_or_zone():
    for options in ({"available": False}, {"accepted": False}):
        bot, calls = setup_bot(**options)
        own, enemies = battle()
        controller = CoachForceFields()
        assert not asyncio.run(controller.step(bot, own, enemies))
        assert controller.pending is None and not controller.recent_targets
        assert not controller.protected_tags and controller.confirmed_commands == 0


def test_rejected_or_missing_confirmation_releases_source_without_field_memory():
    for result in (False, None):
        bot, calls = setup_bot()
        own, enemies = battle()
        controller = CoachForceFields()
        assert asyncio.run(controller.step(bot, own, enemies))
        if result is False:
            controller.confirm(ACTION_NAME, False, 11, [1], issued(calls)[0][3])
            bot.time = 12
        else:
            bot.time = 14
        assert not asyncio.run(controller.step(bot, own, enemies))
        assert controller.pending is None and not controller.protected_tags
        assert not controller.recent_targets and controller.confirmed_commands == 0
        assert len(issued(calls)) == 1


def test_recent_confirmed_zone_prevents_spam_but_expires_conservatively():
    bot, calls = setup_bot()
    own, enemies = battle()
    controller = CoachForceFields()
    assert asyncio.run(controller.step(bot, own, enemies))
    controller.confirm(ACTION_NAME, True, 11, [1], issued(calls)[0][3])
    bot.time = 15
    assert not asyncio.run(controller.step(bot, own, enemies))
    assert len(issued(calls)) == 1
    bot.time = 27
    assert asyncio.run(controller.step(bot, own, enemies))
    assert len(issued(calls)) == 2


def test_duplicate_current_order_is_not_overwritten(monkeypatch):
    monkeypatch.setattr("pluto_sc2.coach_forcefields.duplicate_order", lambda *_: True)
    bot, calls = setup_bot()
    own, enemies = battle()
    assert not asyncio.run(CoachForceFields().step(bot, own, enemies))
    assert not issued(calls)


def test_barrier_can_cover_explicit_retreat_without_changing_order_schema():
    bot, calls = setup_bot()
    own, enemies = battle()
    own[1].orders = [NS(ability=NS(id=A.MOVE_MOVE), target=Point2((45, 50)))]
    assert asyncio.run(CoachForceFields().step(bot, own, enemies, NS(stance="retreat")))
    assert issued(calls)[0][3].x > own[1].position.x


def test_protected_source_is_not_selected_but_protected_friend_still_blocks_geometry():
    bot, calls = setup_bot()
    own, enemies = battle()
    assert not asyncio.run(CoachForceFields().step(bot, own, enemies, protected_tags={1}))
    assert not issued(calls)
    own.append(unit(U.ZEALOT, 5, (59, 50), ground_range=.1))
    assert not asyncio.run(CoachForceFields().step(bot, own, enemies, protected_tags={5}))
    assert not issued(calls)


def test_owned_cloaked_unit_remains_in_field_safety_geometry():
    bot, calls = setup_bot()
    own, enemies = battle()
    own.append(unit(U.DARKTEMPLAR, 5, (59, 50), ground_range=.1, is_cloaked=True, is_revealed=False))
    assert not asyncio.run(CoachForceFields().step(bot, own, enemies))
    assert not issued(calls)


def test_owned_cloaked_sentry_can_cast_but_undetected_enemy_cannot_justify_cast():
    bot, calls = setup_bot()
    own, enemies = battle()
    own[0].is_cloaked, own[0].is_revealed = True, False
    assert asyncio.run(CoachForceFields().step(bot, own, enemies))
    calls.clear()
    enemies[0].is_cloaked, enemies[0].is_revealed = True, False
    assert not asyncio.run(CoachForceFields().step(bot, own, enemies))
    assert not issued(calls)
