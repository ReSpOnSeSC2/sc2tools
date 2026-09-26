import asyncio
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock

import pytest
from sc2.ids.ability_id import AbilityId as A
from sc2.position import Point2
from s2clientprotocol import raw_pb2 as raw

from pluto_sc2.sc2_adapter import NeuralBot


def scene(target_visible=True, attack=A.ATTACK_ATTACK):
    bot = NeuralBot(None)
    bot.state = NS(game_loop=224)
    bot.game_data = NS(abilities={})
    source = NS(tag=1, position=Point2((50, 50)), is_ready=True,
                _proto=raw.Unit(orders=[raw.UnitOrder(ability_id=attack.value, target_unit_tag=2)]))
    target = NS(tag=2, position=Point2((52, 50)), is_ready=True, _proto=raw.Unit())
    bot.units, bot.structures = [source], [target]
    bot.enemy_units, bot.enemy_structures = [], []
    bot.get_available_abilities = AsyncMock(return_value=[[A.STOP_STOP]])
    issued = []

    async def issue(bot, sources, ability):
        issued.append((sources, ability))
        bot.fairplay.audit.append({"kind": "selection"})
        return True

    bot.fairplay = NS(on_screen=lambda unit: unit.tag == 1 or target_visible,
                       source_available=lambda *args: True, issue=issue, audit=[])
    return bot, source, issued


def test_current_screen_friendly_attack_gets_paced_stop_without_policy_transition():
    bot, source, issued = scene()
    assert asyncio.run(bot._recover_friendly_attack())
    assert issued == [([source], A.STOP_STOP)]
    assert not bot.transitions
    assert bot.action_counts['safety_stop_friendly_attack'] == 1
    assert not asyncio.run(bot._recover_friendly_attack())  # Wait for current Stop.
    assert bot.control_summary['friendly_fire_recoveries'][0]['target_tag'] == 2
    bot.fairplay.audit[0]['command_confirmation'] = 'accepted'
    assert bot.control_summary['friendly_fire_recoveries'][0]['command_confirmation'] == 'accepted'


@pytest.mark.parametrize('target_visible,attack', [(False, A.ATTACK_ATTACK), (True, A.MOVE_MOVE)])
def test_unknown_offscreen_target_or_non_attack_never_triggers_recovery(target_visible, attack):
    bot, _, issued = scene(target_visible, attack)
    assert not asyncio.run(bot._recover_friendly_attack())
    assert not issued
    bot.get_available_abilities.assert_not_called()


def test_unavailable_stop_does_not_issue_unqueried_command():
    bot, _, issued = scene()
    bot.get_available_abilities.return_value = [[]]
    assert not asyncio.run(bot._recover_friendly_attack())
    assert not issued
