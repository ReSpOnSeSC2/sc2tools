"""Opening Chrono gates preserve the real adapter's queried casting source."""
import asyncio
from types import SimpleNamespace as NS

import pytest
from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.position import Point2

from pluto_sc2.coach_chrono import CoachChrono
from pluto_sc2.sc2_adapter import execute_action, legal_action_mask
from pluto_sc2.schema import ACTION_NAMES, ACTION_TO_INDEX
from pluto_sc2.worker_scout import WorkerScoutLease
from test_coach_bot import Unit, world


def chrono_world(tmp_path, *, accepted_chronos=0):
    bot = world(tmp_path)
    bot.chrono = CoachChrono(enabled=True)
    bot._worker_scout_lease = WorkerScoutLease()
    probe_ability = NS(id=A.NEXUSTRAIN_PROBE, exact_id=A.NEXUSTRAIN_PROBE)
    stalker_ability = NS(id=A.GATEWAYTRAIN_STALKER, exact_id=A.GATEWAYTRAIN_STALKER)
    chrono_ability = NS(id=A.EFFECT_CHRONOBOOSTENERGYCOST, exact_id=A.EFFECT_CHRONOBOOSTENERGYCOST)
    bot.game_data.abilities.update({ability.id.value: ability for ability in
        (probe_ability, stalker_ability, chrono_ability)})
    nexus = Unit(U.NEXUS, tag=1, position=(50, 50),
        orders=[NS(ability=probe_ability, target=None, progress=.2)])
    gateway = Unit(U.GATEWAY, tag=2, position=(54, 50), is_structure=True,
        orders=[NS(ability=stalker_ability, target=None, progress=.2)])
    caster = Unit(U.NEXUS, tag=9, position=(48, 50), orders=[])
    bot.structures = [nexus, gateway, caster]
    bot.can_afford = lambda _: False
    bot.can_feed = lambda _: True
    bot.queried = []

    async def abilities(units, *, ignore_resource_requirements):
        bot.queried.append(([unit.tag for unit in units], ignore_resource_requirements))
        return [[A.EFFECT_CHRONOBOOSTENERGYCOST] if unit.tag == 9 else [] for unit in units]

    bot.get_available_abilities = abilities
    for index in range(accepted_chronos):
        bot.chrono.record_command("chrono_boost", True, index + 1, audit_index=90 + index, source_tags=[9])
    return bot, nexus, gateway, caster


def legal_chrono(bot):
    mask = asyncio.run(legal_action_mask(bot))
    legal = {ACTION_NAMES[i] for i, allowed in enumerate(mask) if allowed}
    assert "chrono_boost" in legal
    return legal


def test_second_chrono_replaces_adapter_nexus_target_with_current_stalker_gateway_preserving_queried_caster(tmp_path):
    bot, nexus, gateway, caster = chrono_world(tmp_path, accepted_chronos=1)
    legal = legal_chrono(bot)
    index = ACTION_TO_INDEX["chrono_boost"]
    original = bot._pluto_action_context[index]
    assert original.target is nexus and original.sources == (caster,)
    assert bot.queried == [([1, 2, 9], False)]
    bot.chrono.observe(bot.structures, float(bot.time))
    bot._apply_chrono_gate(bot.structures, legal)
    updated = bot._pluto_action_context[index]
    assert "chrono_boost" in legal and updated.target is gateway
    assert updated.sources is original.sources and updated.ability is original.ability
    assert updated.minimap is original.minimap
    assert bot.queried == [([1, 2, 9], False)]  # Retargeting never queries an unseen caster.
    assert not bot.client.requests
    assert asyncio.run(execute_action(bot, index))
    assert bot.fairplay.audit[0]["source_tags"] == [9]
    assert bot.fairplay.audit[0]["unit_target_tag"] == 2
    assert bot.fairplay.audit[0]["ability"] == A.EFFECT_CHRONOBOOSTENERGYCOST.value


@pytest.mark.parametrize("minerals,allowed", [(39, False), (40, True)])
def test_first_chrono_gate_filters_current_bank_and_retains_producing_nexus(tmp_path, minerals, allowed):
    bot, nexus, _gateway, caster = chrono_world(tmp_path)
    bot.minerals = minerals
    legal = legal_chrono(bot)
    bot.chrono.observe(bot.structures, float(bot.time))
    bot._apply_chrono_gate(bot.structures, legal)
    assert ("chrono_boost" in legal) is allowed
    intent = bot._pluto_action_context[ACTION_TO_INDEX["chrono_boost"]]
    assert intent.target is nexus and intent.sources == (caster,)
    assert not bot.client.requests and bot.chrono.accepted_chronos == 0


def test_first_gate_recheck_catches_spending_below_40_before_issue(tmp_path):
    bot, *_ = chrono_world(tmp_path)
    bot.minerals = 40
    legal = legal_chrono(bot)
    bot.chrono.observe(bot.structures, float(bot.time))
    bot._apply_chrono_gate(bot.structures, legal)
    assert "chrono_boost" in legal
    bot.minerals = 35
    bot._apply_chrono_gate(bot.structures, legal)
    assert "chrono_boost" not in legal and not bot.client.requests


@pytest.mark.parametrize("changed", ["offscreen", "fog", "removed", "finished_queue", "stale_frame"])
def test_second_chrono_cannot_fall_back_to_nexus_when_stalker_producer_disappears(tmp_path, changed):
    bot, _nexus, gateway, _caster = chrono_world(tmp_path, accepted_chronos=1)
    legal = legal_chrono(bot)
    bot.chrono.observe(bot.structures, float(bot.time))
    own = bot.structures
    if changed == "offscreen":
        gateway.position = Point2((150, 150))
    elif changed == "fog":
        bot.is_visible = lambda point: point != gateway.position
    elif changed == "removed":
        own = [unit for unit in bot.structures if unit.tag != gateway.tag]
    elif changed == "finished_queue":
        gateway.orders.clear()
        bot.chrono.observe(bot.structures, float(bot.time))
    else:
        bot.state.game_loop += 8
    bot._apply_chrono_gate(own, legal)
    assert "chrono_boost" not in legal and not bot.client.requests


def test_third_chrono_does_not_override_normal_adapter_target(tmp_path):
    bot, nexus, _gateway, _caster = chrono_world(tmp_path, accepted_chronos=2)
    legal = legal_chrono(bot)
    original = bot._pluto_action_context[ACTION_TO_INDEX["chrono_boost"]]
    bot.chrono.observe([], float(bot.time))
    bot.minerals = 0
    bot._apply_chrono_gate(bot.structures, legal)
    assert "chrono_boost" in legal
    assert bot._pluto_action_context[ACTION_TO_INDEX["chrono_boost"]] is original
    assert original.target is nexus and bot.chrono.last_decision["target_tags"] is None


def test_disabled_explicit_opening_gate_preserves_adapter_intent(tmp_path):
    bot, *_ = chrono_world(tmp_path)
    bot.chrono = CoachChrono(enabled=False)
    legal = legal_chrono(bot)
    original = bot._pluto_action_context[ACTION_TO_INDEX["chrono_boost"]]
    bot.minerals = 0
    bot._apply_chrono_gate(bot.structures, legal)
    assert "chrono_boost" in legal and bot._pluto_action_context[ACTION_TO_INDEX["chrono_boost"]] is original


@pytest.mark.parametrize("confirmation,count", [(None, 0), ("source_not_selected", 0), ("engine_rejected", 0), ("accepted", 1)])
def test_only_final_accepted_chrono_command_increments_once(tmp_path, confirmation, count):
    bot, _nexus, _gateway, _caster = chrono_world(tmp_path)
    bot.fairplay.audit.append({"kind": "selection", "source_tags": [9], "result": [1],
        **({"command_confirmation": confirmation, "command_source_tags": [9]} if confirmation else {})})
    bot._selected_actions[0] = {"name": "chrono_boost", "position": [50, 50], "revision": 1}
    bot._confirm_commands(bot.structures)
    assert bot.chrono.accepted_chronos == count
    bot._confirm_commands(bot.structures)
    assert bot.chrono.accepted_chronos == count


def test_confirmed_production_uses_actual_selected_single_source_receipt(tmp_path):
    bot, *_ = chrono_world(tmp_path)
    bot.fairplay.audit.append({"kind": "selection", "source_tags": [1, 9], "result": [1],
        "command_confirmation": "accepted", "command_source_tags": [9]})
    bot._selected_actions[0] = {"name": "train_probe", "position": None, "revision": 1}
    bot._confirm_commands(bot.structures)
    assert bot.chrono.first_probe_order["source_tag"] == 9
    assert bot.chrono.first_probe_order["selection_audit_index"] == 0
