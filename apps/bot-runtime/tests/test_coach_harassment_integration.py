"""Raid planner receipts must not bypass selection, fog or army leases."""
import asyncio
from types import SimpleNamespace as NS

import pytest
from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U

from test_coach_bot import Unit, world, order


class Planner:
    def __init__(self, intent):
        self.intent, self.receipts, self.observation = intent, [], None

    def plan(self, own, enemies, now, army, **kwargs):
        self.observation = own, enemies, kwargs
        return self.intent

    def confirm(self, intent, accepted, now, **kwargs):
        self.receipts.append((accepted, kwargs.get("actual_source_tags")))
        return accepted

    def protected_tags(self, now):
        return {}


def raid_world(tmp_path, *, name="harass_workers", kind="command", target=9, position=(55, 50)):
    bot = world(tmp_path)
    bot.supply_army = 30
    bot.in_pathing_grid = lambda _: True
    bot.harassment = Planner(dict(id=1, name=name, kind=kind, source_tags=[7], target_tag=target,
        position=position, selection_mode="point", ability_id=23 if target else 16, expires_at=12))

    async def abilities(units, **kwargs):
        return [[A.ATTACK_ATTACK, A.MOVE_MOVE] for _ in units]

    bot.get_available_abilities = abilities
    own = [Unit(U.ADEPT, tag=7, is_flying=False)]
    enemies = [Unit(U.SCV, tag=9, position=(55, 50), is_mine=False, is_enemy=True, is_flying=False)]
    return bot, own, enemies


def test_raid_selection_does_not_count_as_command_acceptance(tmp_path):
    bot, own, enemies = raid_world(tmp_path)
    assert asyncio.run(bot._harassment_step(own, enemies, order(), production_due=False))
    assert not bot.harassment.receipts
    assert len(bot.client.requests) == 1
    assert not bot.client.requests[0].actions[0].HasField("action_raw")
    bot.fairplay.audit[0].update(command_confirmation="accepted", command_source_tags=[7])
    bot._confirm_commands(own)
    assert bot.harassment.receipts == [(True, [7])]


@pytest.mark.parametrize("case", ["enemy_fog", "enemy_snapshot", "enemy_offscreen", "source_offscreen", "source_missing"])
def test_raid_cannot_turn_memory_or_missing_units_into_targets(tmp_path, case):
    bot, own, enemies = raid_world(tmp_path)
    if case == "enemy_fog":
        enemies[0].is_visible = False
    elif case == "enemy_snapshot":
        enemies[0].is_snapshot = True
    elif case == "enemy_offscreen":
        enemies[0].position = type(enemies[0].position)((150, 150))
    elif case == "source_offscreen":
        own[0].position = type(own[0].position)((150, 150))
    else:
        own.clear()
    assert not asyncio.run(bot._harassment_step(own, enemies, order(), production_due=False))
    assert not bot.client.requests and bot.harassment.receipts == [(False, [])]


@pytest.mark.parametrize("case", ["fog", "blocked", "offscreen", "hidden_route"])
def test_retreat_requires_visible_route_and_permitted_destination(tmp_path, case):
    bot, own, enemies = raid_world(tmp_path, name="harass_retreat", target=None)
    if case == "fog":
        bot.is_visible = lambda _: False
    elif case == "blocked":
        bot.in_pathing_grid = lambda _: False
    elif case == "offscreen":
        bot.harassment.intent["position"] = (150, 150)
    else:
        bot.is_visible = lambda p: not 51 < p.x < 54
    assert not asyncio.run(bot._harassment_step(own, enemies, order(), production_due=False))
    assert not bot.client.requests


def test_unavailable_ability_cannot_be_issued(tmp_path):
    bot, own, enemies = raid_world(tmp_path)

    async def absent(units, **kwargs):
        return [[] for _ in units]

    bot.get_available_abilities = absent
    assert not asyncio.run(bot._harassment_step(own, enemies, order(), production_due=False))
    assert bot.harassment.receipts == [(False, [])] and not bot.client.requests


def test_camera_does_not_revisit_fogged_economy(tmp_path):
    bot, own, enemies = raid_world(tmp_path, name="harass_camera", kind="camera", target=None, position=(100, 50))
    bot.is_visible = lambda _: False
    assert not asyncio.run(bot._harassment_step(own, enemies, order(), production_due=False))
    assert not bot.client.requests


def test_active_raid_prevents_global_army_recall(tmp_path):
    bot = world(tmp_path)
    bot.supply_army = 30
    bot.harassment.mission = {"tags": [7, 8], "until": 30}
    assert bot._combat_protected_tags() == {7, 8}
    assert not bot._global_army_allowed([])


def test_actual_subset_is_passed_to_raid_confirmation(tmp_path):
    bot, own, enemies = raid_world(tmp_path)
    intent = bot.harassment.intent
    intent["source_tags"] = [7, 8]
    bot.fairplay.audit.append(dict(kind="selection", source_tags=[7, 8], command_source_tags=[7],
                                  command_confirmation="accepted", result=[1]))
    bot._selected_actions[0] = dict(name="harass_workers", position=[55, 50], harassment=intent, revision=1)
    bot._confirm_commands(own)
    assert bot.harassment.receipts == [(True, [7])]


def test_oracle_toggle_is_targetless_and_uses_live_ability_query(tmp_path):
    bot, own, enemies = raid_world(tmp_path, name="harass_oracle_beam_on", target=None, position=None)
    own[0].type_id = U.ORACLE
    own[0].is_flying = True
    bot.harassment.intent["ability_id"] = 2375
    bot.game_data.abilities[2375] = NS(id=A(2375), _proto=NS(target=1))
    calls = []

    async def available(units, **kwargs):
        calls.append([unit.tag for unit in units])
        return [[A(2375)] for _ in units]

    bot.get_available_abilities = available
    assert asyncio.run(bot._harassment_step(own, enemies, order(), production_due=False))
    assert calls == [[7], [7]]
    assert bot._selected_actions[0]["position"] is None
    assert bot.harassment.observation[2]["abilities_by_tag"] == {7: [A(2375)]}


def test_oracle_attack_cannot_cross_a_hole_in_current_vision(tmp_path):
    bot, own, enemies = raid_world(tmp_path)
    own[0].type_id, own[0].is_flying = U.ORACLE, True
    bot.is_visible = lambda p: not 51 < p.x < 54
    assert not asyncio.run(bot._harassment_step(own, enemies, order(), production_due=False))
    assert not bot.client.requests and bot.harassment.receipts == [(False, [])]
