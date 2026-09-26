"""Regressions for v21's explicit-opening spending and lost Chrono window."""
import asyncio

import pytest
from sc2.ids.ability_id import AbilityId as A

from pluto_sc2.coach_executor import CoachExecutor
from pluto_sc2.coach_opening import OpeningPlan, OpeningStep
from test_coach_chrono_integration import chrono_world
from test_coach_executor import order, report, unit


OPTIONAL = {"build_gateway", "build_shieldbattery", "build_roboticsfacility", "build_forge",
            "build_twilightcouncil", "research_warpgateresearch", "train_sentry", "train_zealot"}


def first_stalker_state(**changes):
    return report(unit("NEXUS", 1), unit("GATEWAY", 2), unit("CYBERNETICSCORE", 3),
                  explicit_supply_opening=True, **changes)


def opening_order(**changes):
    return order(composition={"SENTRY": 1, "STALKER": 2},
                 production_targets={"GATEWAY": 2, "SHIELDBATTERY": 1}, **changes)


def test_first_stalker_precedes_every_v21_optional_spend_without_mutating_mask():
    executor = CoachExecutor()
    legal = OPTIONAL | {"train_stalker", "no_op"}
    original = legal.copy()
    assert executor.choose_action(opening_order(), first_stalker_state(), legal, 166) == "train_stalker"
    assert legal == original
    assert executor.opening_army_priority["held_actions"] == sorted(OPTIONAL)
    assert not executor.opening_army_priority["worker_production_paused"]


@pytest.mark.parametrize("reason", ["core_unfinished", "mineral_shortfall", "screen_queue_unavailable"])
def test_unavailable_stalker_does_not_spend_its_budget_on_cheaper_optional_items(reason):
    executor = CoachExecutor()
    state = first_stalker_state()
    if reason == "core_unfinished":
        for field in ("current_own", "own_memory"):
            state[field][-1] = dict(state[field][-1], is_ready=False)
    if reason == "mineral_shortfall":
        state["hud"].update(minerals=100, vespene=100)
    assert executor.choose_action(opening_order(), state, OPTIONAL | {"no_op"}, 161) == "no_op"
    assert executor.opening_army_priority["active"]


@pytest.mark.parametrize("urgent", ["train_probe", "build_pylon", "harvest_gas"])
def test_workers_supply_and_gas_remain_ahead_of_first_stalker(urgent):
    executor = CoachExecutor()
    state = first_stalker_state()
    command = opening_order(worker_target=32, gas_workers_per_base=3)
    if urgent == "train_probe":
        state["current_own"][0]["is_idle"] = True
    elif urgent == "build_pylon":
        state["hud"]["supply_left"] = 0
    else:
        state["current_own"].append(unit("ASSIMILATOR", 4, assigned_harvesters=0))
    assert executor.choose_action(command, state, {urgent, "train_stalker", "no_op"}, 166) == urgent


def test_due_original_gas_construction_is_preserved_before_first_stalker():
    plan = OpeningPlan("", "PvT", "test", (OpeningStep("ASSIMILATOR", 1, 130),))
    executor = CoachExecutor(plan)
    assert executor.choose_action(opening_order(), first_stalker_state(),
        {"build_assimilator", "train_stalker", "no_op"}, 140) == "build_assimilator"


@pytest.mark.parametrize("evidence", ["accepted", "current_queue", "observed_unit"])
def test_first_stalker_commitment_releases_optional_actions(evidence):
    executor = CoachExecutor()
    state = first_stalker_state()
    if evidence == "accepted":
        executor.record_action("train_stalker", 210, True)
    elif evidence == "current_queue":
        state["current_own"][1]["orders"] = [{"ability_id": A.GATEWAYTRAIN_STALKER.value, "progress": .1}]
    else:
        state["current_own"].append(unit("STALKER", 4))
    assert executor.choose_action(opening_order(), state, {"research_warpgateresearch"}, 215) == "research_warpgateresearch"
    assert not executor.opening_army_priority["active"]
    assert executor.opening_army_priority["first_stalker_evidence"] is not None


def test_rejected_stalker_command_does_not_release_optional_spending():
    executor = CoachExecutor()
    executor.record_action("train_stalker", 210, False)
    assert executor.choose_action(opening_order(), first_stalker_state(), OPTIONAL | {"no_op"}, 215) == "no_op"


@pytest.mark.parametrize("override", ["nonexplicit", "base_defense", "retreat", "deadline"])
def test_first_stalker_hold_is_explicit_and_bounded_with_real_defense_override(override):
    executor = CoachExecutor()
    state = first_stalker_state()
    command = opening_order(stance="retreat" if override == "retreat" else "defend")
    if override == "nonexplicit":
        state["explicit_supply_opening"] = False
    if override == "base_defense":
        state["defense_alert"] = {"base_tag": 1, "last_seen_seconds": 180}
    name = executor.choose_action(command, state, {"train_sentry", "no_op"},
                                  300 if override == "deadline" else 180)
    assert name == "train_sentry"
    assert not executor.opening_army_priority["active"]


def test_enemy_seen_by_distant_scout_does_not_waive_first_stalker_spending_hold():
    executor = CoachExecutor()
    state = first_stalker_state(current_enemies=[unit("MARINE", 99, position=[150, 150])])
    assert executor.choose_action(opening_order(), state, OPTIONAL | {"no_op"}, 180) == "no_op"
    assert not executor.opening_army_priority["base_defense_override"]


@pytest.mark.parametrize("priority,expected", [(True, "chrono_boost"), (False, "train_stalker")])
def test_eligible_explicit_chrono_precedes_optional_army_but_ordinary_chrono_does_not(priority, expected):
    executor = CoachExecutor()
    state = first_stalker_state(opening_chrono_priority=priority)
    assert executor.choose_action(opening_order(), state, {"train_stalker", "chrono_boost"}, 166) == expected


@pytest.mark.parametrize("accepted_chronos,target_tag", [(0, 1), (1, 2)])
def test_real_step_issues_eligible_opening_chrono_before_elective_scout_reservation_or_spells(
        tmp_path, accepted_chronos, target_tag):
    bot, *_ = chrono_world(tmp_path, accepted_chronos=accepted_chronos)

    async def no_action(*_args, **_kwargs):
        return False

    def reservation_forbidden(*_args):
        pytest.fail("Elective first-Sentry reservation must not suppress an eligible explicit Chrono")

    async def spell_forbidden(*_args, **_kwargs):
        pytest.fail("Elective spell/harassment must not preempt the eligible opening Chrono")

    bot._expansion_step = bot._transfer_worker = bot._camera_schedule = bot._army_intents = no_action
    bot.scout_spells.reserve_for_first_recharge = reservation_forbidden
    bot.scout_spells.step = bot._harassment_step = spell_forbidden
    asyncio.run(bot._step(0))
    assert len(bot.client.requests) == 1
    assert bot.fairplay.audit[0]["source_tags"] == [9]
    assert bot.fairplay.audit[0]["unit_target_tag"] == target_tag
    assert bot.fairplay.audit[0]["ability"] == A.EFFECT_CHRONOBOOSTENERGYCOST.value
    assert bot._selected_actions[0]["name"] == "chrono_boost"
    assert bot.chrono.accepted_chronos == accepted_chronos  # Selection is not a cast receipt.


def test_full_step_keeps_recharge_reservation_after_first_two_chronos(tmp_path):
    bot, *_ = chrono_world(tmp_path, accepted_chronos=2)
    called = []

    async def no_action(*_args, **_kwargs):
        return False

    def reserve(*_args):
        called.append("reserve")
        return True

    async def spell(*_args, **_kwargs):
        called.append("spell")
        return True

    bot._expansion_step = bot._transfer_worker = bot._camera_schedule = bot._army_intents = no_action
    bot.scout_spells.reserve_for_first_recharge = reserve
    bot.scout_spells.step = spell
    asyncio.run(bot._step(0))
    assert called == ["reserve", "spell"]
    assert not bot.client.requests
