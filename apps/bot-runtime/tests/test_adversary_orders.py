import asyncio
from copy import deepcopy
from types import SimpleNamespace as NS

from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.position import Point2
from s2clientprotocol import raw_pb2 as raw
import pytest

from pluto_sc2.adversary import legal_action_mask, validate_adversary_audit
from pluto_sc2.adversary_orders import StrategicOrders, duplicate_order, pressure_tags
from test_adversary import Unit, scene


def combat_scene():
    bot = scene()
    bot.units = [Unit(U.MARINE, tag=1, abilities=[A.ATTACK_ATTACK, A.MOVE_MOVE, A.EFFECT_STIM_MARINE],
                      can_attack_air=True, can_attack_ground=True),
                 Unit(U.MARINE, tag=2, position=(52, 50), abilities=[A.ATTACK_ATTACK, A.MOVE_MOVE],
                      can_attack_air=True, can_attack_ground=True)]
    return bot


def action(bot, name):
    return bot.spec.action_names.index(name)


def test_accepted_attack_cannot_be_reversed_immediately_but_policy_retains_choices():
    async def run():
        bot = combat_scene()
        first = await legal_action_mask(bot)
        assert all(first[action(bot, name)] for name in ("attack_enemy_base", "defend", "retreat"))
        intent = bot._action_context[action(bot, "attack_enemy_base")]
        assert await bot.fairplay.issue(bot, intent)
        bot.time = .2
        second = await legal_action_mask(bot)
        assert not any(second[action(bot, name)] for name in ("attack_enemy_base", "defend", "retreat"))
        assert second[action(bot, "no_op")] and second[action(bot, "stim")]
        bot.time = 5
        third = await legal_action_mask(bot)
        assert all(third[action(bot, name)] for name in ("attack_enemy_base", "defend", "retreat"))
        assert await bot.fairplay.issue(bot, bot._action_context[action(bot, "defend")])
        assert bot.fairplay.max_apm == 600
        assert validate_adversary_audit({"summary": bot.fairplay.summary(), "actions": bot.fairplay.audit})
    asyncio.run(run())


def test_rejected_command_does_not_start_strategic_cadence():
    async def run():
        bot = combat_scene()
        await legal_action_mask(bot)
        bot.client.codes = [2]
        assert not await bot.fairplay.issue(bot, bot._action_context[action(bot, "attack_enemy_base")])
        bot.time = .2
        assert (await legal_action_mask(bot))[action(bot, "defend")]
    asyncio.run(run())


def test_visible_combat_emergency_allows_one_second_override_without_hidden_bypass():
    async def run():
        bot = combat_scene()
        await legal_action_mask(bot)
        await bot.fairplay.issue(bot, bot._action_context[action(bot, "attack_enemy_base")])
        enemy = Unit(U.ZERGLING, tag=90, position=(51, 50), is_enemy=True, ground_range=.1,
                     can_attack_ground=True)
        bot.enemy_units = [enemy]
        bot.time = .9
        assert not (await legal_action_mask(bot))[action(bot, "retreat")]
        bot.time = 1
        mask = await legal_action_mask(bot)
        assert mask[action(bot, "retreat")] and mask[action(bot, "defend")]
        assert mask[action(bot, "attack_visible_enemy")]
        assert not mask[action(bot, "attack_enemy_base")]
        intent = bot._action_context[action(bot, "retreat")]
        assert intent.strategic_emergency and intent.visible_pressure_tags == (90,)
        await bot.fairplay.issue(bot, intent)
        audit = {"summary": bot.fairplay.summary(), "actions": bot.fairplay.audit}
        assert validate_adversary_audit(audit)
        bad = deepcopy(audit)
        bad["actions"][-1]["visible_pressure_tags"] = []
        with pytest.raises(ValueError, match="combat pressure"):
            validate_adversary_audit(bad)
        bot.time = 2
        enemy.is_visible = False
        assert not (await legal_action_mask(bot))[action(bot, "retreat")]
        enemy.is_visible, enemy.is_snapshot = True, True
        assert not (await legal_action_mask(bot))[action(bot, "retreat")]
        enemy.is_snapshot, enemy.is_cloaked = False, True
        assert not (await legal_action_mask(bot))[action(bot, "retreat")]
    asyncio.run(run())


def test_far_or_incompatible_enemy_does_not_create_emergency():
    own = [Unit(U.MARINE, position=(50, 50))]
    air_only = Unit(U.PHOENIX, tag=90, position=(50, 50), can_attack_air=True, can_attack_ground=False)
    far = Unit(U.MARINE, tag=91, position=(80, 50), can_attack_ground=True, ground_range=5)
    assert not pressure_tags(own, [air_only, far])


def test_duplicate_order_requires_all_units_same_current_ability_and_destination():
    bot = combat_scene()
    destination = Point2((150, 150))
    order = raw.UnitOrder(ability_id=A.ATTACK_ATTACK.value)
    order.target_world_space_pos.x, order.target_world_space_pos.y = destination
    bot.units[0]._proto = NS(orders=[order])
    assert not duplicate_order(bot.units, A.ATTACK_ATTACK, destination, bot.game_data)
    bot.units[1]._proto = NS(orders=[order])
    assert duplicate_order(bot.units, A.ATTACK_ATTACK, destination, bot.game_data)
    assert not duplicate_order(bot.units, A.MOVE_MOVE, destination, bot.game_data)
    mask = asyncio.run(legal_action_mask(bot))
    assert not mask[action(bot, "attack_enemy_base")]
    assert mask[action(bot, "defend")]
    order.target_world_space_pos.x = 140
    assert not duplicate_order(bot.units, A.ATTACK_ATTACK, destination, bot.game_data)


def test_observed_structure_memory_retargets_and_only_clears_visible_empty_locations():
    async def run():
        bot = combat_scene()
        main = Unit(U.NEXUS, tag=80, position=(150, 150), is_enemy=True, is_structure=True)
        expansion = Unit(U.NEXUS, tag=81, position=(100, 100), is_enemy=True, is_structure=True)
        hidden = Unit(U.NEXUS, tag=82, position=(55, 50), is_enemy=True, is_structure=True, is_visible=False)
        bot.enemy_structures = [main, expansion, hidden]
        await legal_action_mask(bot)
        assert bot._action_context[action(bot, "attack_enemy_base")].target == expansion.position
        bot.enemy_structures = []
        bot.is_visible = lambda _: False
        await legal_action_mask(bot)
        assert bot._action_context[action(bot, "attack_enemy_base")].target == expansion.position
        inspected = []

        def visible(point):
            inspected.append(point)
            return point == expansion.position

        bot.is_visible = visible
        await legal_action_mask(bot)
        assert bot._action_context[action(bot, "attack_enemy_base")].target == main.position
        assert hidden.position not in inspected
        bot.is_visible = lambda _: True
        await legal_action_mask(bot)
        assert bot._action_context[action(bot, "attack_enemy_base")].target == bot.enemy_start_locations[0]
    asyncio.run(run())


def test_flying_structure_objective_requires_compatible_army_and_moving_structure_updates_memory():
    controller = StrategicOrders()
    flying = Unit(U.BARRACKSFLYING, tag=90, position=(100, 100), is_structure=True, is_flying=True)
    ground_army = [Unit(U.MARAUDER, position=(50, 50), can_attack_air=False)]
    fallback = Point2((150, 150))
    controller.observe_structures([flying], lambda _: True)
    assert controller.objective(ground_army, fallback) == fallback
    ground_army[0].can_attack_air = True
    assert controller.objective(ground_army, fallback) == flying.position
    flying.position = Point2((110, 110))
    controller.observe_structures([flying], lambda _: True)
    assert controller.objective(ground_army, fallback) == flying.position
