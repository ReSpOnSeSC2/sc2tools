"""Cohort box preflight and asynchronous engine-selection receipts."""
import asyncio
from types import SimpleNamespace as NS

import pytest
from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.position import Point2
from s2clientprotocol import raw_pb2 as raw

from test_coach_bot import Unit, order, world
from test_fairplay import screen_layers


def cohort(tmp_path, own):
    bot = world(tmp_path)
    bot.in_pathing_grid = lambda _: True
    bot.game_data.abilities[A.ATTACK_ATTACK.value] = NS(id=A.ATTACK_ATTACK)
    bot.all_units = own
    bot.supply_army = sum(4 if unit.type_id == U.IMMORTAL else 2 for unit in own)

    async def available(units, **_):
        return [[A.ATTACK_ATTACK] for _ in units]

    async def no_global_group(*_, **__):
        return False  # A protected scouting/raid lease can prohibit F2.

    bot.get_available_abilities = available
    bot._group_army_step = no_global_group
    bot.cohesion.update([{"tag": unit.tag, "position": list(unit.position),
                         "supply": 4 if unit.type_id == U.IMMORTAL else 2}
                         for unit in own], bot.supply_army, (48, 50), (80, 50), bot.time)
    assert bot.cohesion.phase == "advancing"
    assert bot.cohesion.waypoint == (56, 50)
    screen_layers(bot)
    return bot


def army(tag, kind=U.STALKER, position=(47, 48), **kwargs):
    return Unit(kind, tag=tag, position=position, can_attack=True, radius=.625, **kwargs)


def confirm_selection(bot, selected):
    bot.state.game_loop += 16
    bot.state.observation_raw.units.clear()
    bot.state.observation_raw.units.extend(raw.Unit(tag=tag, alliance=1, is_selected=True) for tag in selected)
    asyncio.run(bot.fairplay.advance(bot))


def test_v20_ten_pending_members_among_27_uses_safe_single_and_real_confirmation(tmp_path):
    pending = [army(tag, U.STALKER if tag % 2 else U.IMMORTAL,
                    position=(46 + tag % 4, 48 + tag % 5)) for tag in range(1, 11)]
    dispatched = [army(tag, U.STALKER if tag % 2 else U.IMMORTAL,
                       position=(46.5 + tag % 3, 48.5 + tag % 3)) for tag in range(11, 28)]
    bot = cohort(tmp_path, pending + dispatched)
    bot.cohesion.confirm("cohort_advance", [unit.tag for unit in dispatched], bot.cohesion.epoch, True)
    assert asyncio.run(bot._cohesion_step(pending + dispatched, order(stance="attack")))
    event = bot.fairplay.audit[-1]
    assert event["selection_mode"] == "point" and len(event["source_tags"]) == 1
    assert set(event["source_tags"]).issubset({unit.tag for unit in pending})
    assert bot.client.requests[-1].actions[0].action_feature_layer.unit_selection_point.type == 1
    assert "command_confirmation" not in event
    confirm_selection(bot, event["source_tags"])
    assert event["command_confirmation"] == "accepted"
    bot._confirm_commands(pending + dispatched)
    assert bot.cohesion.dispatched == {unit.tag for unit in dispatched} | set(event["source_tags"])
    assert len(bot.client.requests) == 2  # One paid selection and one paid command.
    assert all(not action.HasField("action_raw") for request in bot.client.requests for action in request.actions)


@pytest.mark.parametrize("role", ["worker", "protected", "scout", "hallucination", "loaded_prism",
                                  "dispatched", "other_job", "not_ready"])
def test_box_does_not_borrow_excluded_or_differently_assigned_units(tmp_path, role):
    own = [army(1), army(2, U.IMMORTAL, (49, 52))]
    extra = army(3, position=(48, 50))
    if role == "worker":
        extra.type_id, extra.can_attack = U.PROBE, False
    elif role == "hallucination":
        extra.is_hallucination = True
    elif role == "loaded_prism":
        extra.type_id, extra.cargo_used = U.WARPPRISM, 2
    elif role == "not_ready":
        extra.is_ready = False
    own.append(extra)
    bot = cohort(tmp_path, own)
    if role == "protected":
        bot.prism.protected_tags[3] = bot.time + 10
    elif role == "scout":
        bot._nonworker_scout_tags.add(3)
    elif role == "dispatched":
        bot.cohesion.confirm("cohort_advance", [3], bot.cohesion.epoch, True)
    elif role == "other_job":
        del bot.cohesion.members[3]
    assert asyncio.run(bot._cohesion_step(own, order(stance="attack")))
    event = bot.fairplay.audit[-1]
    assert event["selection_mode"] == "point"
    assert 3 not in event["source_tags"]


def test_unrequested_unit_footprint_intersecting_box_from_outside_is_not_safe(tmp_path):
    own = [army(1), army(2, U.IMMORTAL, (49, 52)), army(3, position=(48, 52.75))]
    bot = cohort(tmp_path, own)
    bot.cohesion.confirm("cohort_advance", [3], bot.cohesion.epoch, True)
    extra_pixel = bot.fairplay.screen_point(own[2])
    assert extra_pixel.y < min(bot.fairplay.screen_point(unit).y for unit in own[:2]) - 1
    assert asyncio.run(bot._cohesion_step(own, order(stance="attack")))
    assert bot.fairplay.audit[-1]["selection_mode"] == "point"


def test_clear_mixed_box_keeps_real_spatial_selection_and_actual_confirmed_subset(tmp_path):
    own = [army(1), army(2, U.IMMORTAL, (49, 52))]
    bot = cohort(tmp_path, own)
    assert asyncio.run(bot._cohesion_step(own, order(stance="attack")))
    event = bot.fairplay.audit[-1]
    assert event["selection_mode"] == "rectangle" and event["source_tags"] == [1, 2]
    assert bot.client.requests[-1].actions[0].action_feature_layer.HasField("unit_selection_rect")
    confirm_selection(bot, [2])
    assert event["command_confirmation"] == "accepted"
    assert event["command_source_tags"] == [2]
    bot._confirm_commands(own)
    assert bot.cohesion.dispatched == {2}


def test_actual_larger_selection_still_rejected_and_same_layout_falls_back(tmp_path):
    own = [army(1, position=(44, 48)), army(2, U.IMMORTAL, (49, 52)), army(3, position=(49, 49)),
           army(4, U.IMMORTAL, (48, 51))]
    bot = cohort(tmp_path, own)
    assert asyncio.run(bot._cohesion_step(own, order(stance="attack")))
    first = bot.fairplay.audit[-1]
    assert first["selection_mode"] == "rectangle"
    # An unexpected engine selection (e.g. movement between observations)
    # remains rejected. No command may adopt its unrequested tag.
    confirm_selection(bot, [1, 2, 3, 4, 999])
    assert first["command_confirmation"] == "source_not_selected"
    assert len(bot.client.requests) == 1 and not bot.cohesion.dispatched
    bot._confirm_commands(own)
    bot.state.game_loop += 16
    # The cooled first source is outside the next rectangle. Suppression must
    # therefore use the failed receipt, not merely its occupancy preflight.
    assert asyncio.run(bot._cohesion_step(own, order(stance="attack")))
    assert bot.fairplay.audit[-1]["selection_mode"] == "point"
    assert 999 not in bot.fairplay.audit[-1]["source_tags"]


def test_failed_box_can_retry_after_material_visible_layout_change(tmp_path):
    own = [army(1), army(2, U.IMMORTAL, (49, 52)), army(3, position=(49, 49))]
    bot = cohort(tmp_path, own)
    assert asyncio.run(bot._cohesion_step(own, order(stance="attack")))
    confirm_selection(bot, [1, 2, 3, 999])
    bot._confirm_commands(own)
    bot.state.game_loop += 16
    own[2].position = Point2((50, 49))
    assert asyncio.run(bot._cohesion_step(own, order(stance="attack")))
    # Source 1 is temporarily cooling down; its footprint must be outside
    # the new two-unit rectangle, independently of the old failure receipt.
    assert bot.fairplay.audit[-1]["selection_mode"] == "rectangle"
