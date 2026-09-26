from copy import deepcopy
from types import SimpleNamespace

import pytest

from pluto_sc2.coach_executor import CoachExecutor
from pluto_sc2.coach_opening import OpeningPlan, OpeningStep
from pluto_sc2.coach_supply_opening import PROFILE, SupplyOpeningPlan


def plan():
    return SupplyOpeningPlan.from_config({"schema": 1, "profile": PROFILE})


def unit(kind, tag, position=(5, 10), **changes):
    return dict(type=kind, tag=tag, position=list(position), is_ready=True,
                is_idle=True, orders=[]) | changes


def report(supply=17, phase=0, **changes):
    own = [unit("NEXUS", 1)]
    kinds = [("PYLON", 2, (8, 10)), ("GATEWAY", 3, (10, 10)),
             ("NEXUS", 4, (100, 100)), ("ASSIMILATOR", 5, (4, 14)),
             ("CYBERNETICSCORE", 6, (10, 14)), ("ASSIMILATOR", 7, (4, 6)),
             ("PYLON", 8, (103, 100))]
    own += [unit(kind, tag, position) for kind, tag, position in kinds[:phase]]
    return dict(hud=dict(supply_used=supply, supply_workers=min(supply, 16), supply_army=0,
                         supply_cap=21, supply_left=21-supply, minerals=500, vespene=100),
                own_memory=own, current_own=own, current_enemies=[], upgrades=[],
                opening_bases=[dict(base_index=0, position=[5, 10], tag=1),
                               dict(base_index=1, position=[100, 100], tag=4)],
                action_costs={"train_probe": dict(minerals=50, vespene=0, supply=1),
                              "train_zealot": dict(minerals=100, vespene=0, supply=2)}) | changes


def order():
    return SimpleNamespace(stance="defend", composition={"ZEALOT": 6}, production_targets={},
                           research=(), worker_target=44, base_target=2, gas_workers_per_base=0)


@pytest.mark.parametrize("config", [None, {}, {"schema": True, "profile": PROFILE},
    {"schema": 2, "profile": PROFILE}, {"schema": 1, "profile": "replay"},
    {"schema": 1, "profile": PROFILE, "sequence": []},
    {"schema": 1, "profile": PROFILE, "max_delay_seconds": -1},
    {"schema": 1, "profile": PROFILE, "max_delay_seconds": float("nan")},
    {"schema": 1, "profile": PROFILE, "max_delay_seconds": 0}])
def test_invalid_explicit_config_is_rejected(config):
    with pytest.raises(ValueError):
        SupplyOpeningPlan.from_config(config)


@pytest.mark.parametrize("phase,below,at,action", [(0, 11, 12, "build_pylon"),
    (1, 13, 14, "build_gateway"), (2, 16, 17, "build_nexus")])
def test_supply_thresholds_trigger_without_waiting_replay_timestamps(phase, below, at, action):
    opening = plan()
    waiting = opening.decide(report(below, phase), {action}, 1)
    assert waiting.action is None and waiting.due_at is None
    due = opening.decide(report(at, phase), {action}, 2)
    assert due.action == action and due.due_at == 2 and due.reserve
    assert due.supply_threshold == at


def test_single_probe_pause_is_latched_at_seventeen_before_nexus_affordability():
    opening = plan()
    state = report(17, 2)
    state["hud"]["minerals"] = 200
    decision = opening.decide(state, {"train_probe"}, 50)
    assert decision.action is None and decision.allow_expansion
    assert decision.worker_supply_cap == 17 and decision.pause_probe_production
    assert decision.hold_optional_army
    # A lost scouting Probe does not cancel the planned Nexus/gas/Core cut.
    state["hud"].update(supply_used=16, supply_workers=16)
    assert opening.decide(state, set(), 51).pause_probe_production


def test_seventeen_latch_keeps_gas_and_core_due_after_scout_loss():
    opening = plan()
    state = report(17, 2)
    opening.decide(state, {"build_nexus"}, 1)
    opening.record_action("build_nexus", 1, True, base_index=1)
    state["hud"].update(supply_used=16, supply_workers=16)
    gas = opening.decide(state, {"build_assimilator"}, 2)
    assert gas.action == "build_assimilator" and gas.pause_probe_production
    opening.record_action("build_assimilator", 2, True, base_index=0)
    core = opening.decide(state, {"build_cyberneticscore"}, 3)
    assert core.action == "build_cyberneticscore" and core.pause_probe_production


@pytest.mark.parametrize("phase", [0, 1])
def test_pylon_and_gateway_are_triggers_not_worker_pauses(phase):
    decision = plan().decide(report(12 if phase == 0 else 14, phase), set(), 40)
    assert decision.worker_supply_cap == 17
    assert not decision.pause_probe_production
    assert decision.prioritize_due_construction


def test_correct_sequence_keeps_core_input_pending_until_actual_foundation():
    opening = plan()
    state = report(17, 2)
    legal = {"build_nexus", "build_assimilator", "build_cyberneticscore", "build_pylon"}
    assert opening.decide(state, legal, 40).action == "build_nexus"
    opening.record_action("build_nexus", 40, True, base_index=1)
    assert opening.decide(state, legal, 41).action == "build_assimilator"
    opening.record_action("build_assimilator", 41, True, base_index=0)
    assert opening.decide(state, legal, 42).action == "build_cyberneticscore"
    opening.record_action("build_cyberneticscore", 42, True, base_index=0)
    state["pending_construction"] = [dict(type="CYBERNETICSCORE", position=[10, 14])]
    state["current_own"].append(unit("PROBE", 9, orders=[dict(produces="CYBERNETICSCORE", target=[10, 14])]))
    waiting = opening.decide(state, set(), 43)
    assert waiting.pause_probe_production and waiting.step == 4
    assert not waiting.core_foundation_observed
    state["current_own"].append(unit("CYBERNETICSCORE", 6, (10, 14), is_ready=False))
    released = opening.decide(state, legal, 44)
    assert released.step == 5 and released.action == "build_assimilator"
    assert not released.pause_probe_production and released.worker_supply_cap is None
    assert not released.hold_optional_army and released.core_foundation_observed
    opening.record_action("build_assimilator", 44, True, base_index=0)
    last = opening.decide(state, legal, 45)
    assert last.action == "build_pylon" and last.next_base_index == 1
    opening.record_action("build_pylon", 45, True, base_index=0)
    assert opening.summary()["completed_steps"] == 6
    opening.record_action("build_pylon", 46, True, base_index=1)
    assert opening.decide(state, set(), 47).status == "complete"


def test_unknown_or_wrong_base_core_cannot_release_cut():
    for base in (None, 1, True):
        opening = plan()
        opening.decide(report(17, 4), {"build_cyberneticscore"}, 0)
        opening.record_action("build_cyberneticscore", 1, True, base_index=base)
        state = report(17, 4)
        state["current_own"].append(unit("CYBERNETICSCORE", 6, (100, 100), is_ready=False))
        assert opening.decide(state, set(), 2).pause_probe_production


def test_defense_suspends_builds_and_army_hold_but_not_planned_worker_cut():
    opening = plan()
    opening.decide(report(17, 2), set(), 0)
    decision = opening.decide(report(17, 2), {"build_nexus"}, 1, suspended=True)
    assert decision.status == "suspended" and decision.action is None
    assert decision.pause_probe_production and not decision.hold_optional_army


def test_ninety_second_stage_fallback_releases_worker_and_army_holds():
    opening = plan()
    opening.decide(report(17, 2), set(), 100)
    assert opening.decide(report(17, 2), set(), 190).pause_probe_production
    fallback = opening.decide(report(17, 2), set(), 190.01)
    assert fallback.status == "fallback"
    assert fallback.worker_supply_cap is None and not fallback.pause_probe_production
    assert not fallback.hold_optional_army and fallback.allow_emergency_pylon


def test_permitted_reports_and_replay_reference_are_unchanged():
    reference = OpeningPlan("a"*64, "PvZ", "Reference", (OpeningStep("PYLON", 1, 33, 0),))
    before = reference.summary()
    opening = SupplyOpeningPlan(reference=reference)
    state = report(12)
    snapshot = deepcopy(state)
    opening.decide(state, {"build_pylon"}, 1)
    opening.record_action("build_pylon", 2, True, base_index=0)
    assert state == snapshot and reference.summary() == before
    summary = opening.summary()
    assert summary["source"] == "explicit_user_instruction" and summary["reference_opening"] == before
    assert "original_due_at" not in summary["history"][0]
    assert summary["history"][0]["supply_threshold"] == 12


@pytest.mark.parametrize("supply,expected", [(15, "train_probe"), (16, "train_probe"),
                                          (16.5, "no_op"), (17, "no_op")])
def test_executor_counts_queued_hud_supply_not_only_completed_workers(supply, expected):
    executor = CoachExecutor(plan())
    state = report(supply, 2)
    state["hud"]["supply_workers"] = 15
    assert executor.choose_action(order(), state, {"train_probe", "train_zealot"}, 1) == expected


def test_executor_due_pylon_input_precedes_probe_without_pausing_production_at_twelve():
    executor = CoachExecutor(plan())
    state = report(12)
    assert executor.choose_action(order(), state, {"build_pylon", "train_probe"}, 1) == "build_pylon"
    # Unavailable construction never imposes a separate12-supply worker cut.
    assert executor.choose_action(order(), state, {"train_probe"}, 2) == "train_probe"


def test_executor_no_emergency_pylon_at_eleven_or_extra_main_pylon_before_core():
    executor = CoachExecutor(plan())
    state = report(11)
    state["hud"].update(supply_cap=13, supply_left=2)
    assert executor.choose_action(order(), state, {"build_pylon", "train_probe"}, 1) == "train_probe"
    state = report(17, 4)
    state["hud"].update(supply_cap=17, supply_left=0)
    assert executor.choose_action(order(), state, {"build_pylon", "train_probe", "train_zealot"}, 2) == "no_op"


def test_executor_probe_restarts_after_core_foundation_and_never_cuts_later_expansion():
    executor = CoachExecutor(plan())
    state = report(17, 5)
    state["current_own"][-1]["is_ready"] = False
    assert executor.choose_action(order(), state, {"train_probe", "build_assimilator"}, 1) == "train_probe"
    state = report(30, 7)
    state["hud"].update(supply_workers=25, minerals=350, supply_left=10)
    state["opening_next_cost"] = dict(action="build_nexus", minerals=400, vespene=0)
    assert executor.choose_action(order(), state, {"train_probe"}, 2) == "train_probe"


def test_emergency_pylon_cannot_skip_second_gas_or_natural_pylon_role_after_core():
    executor = CoachExecutor(plan())
    state = report(17, 5)
    state["hud"].update(supply_left=0, supply_cap=17)
    assert executor.choose_action(order(), state, {"build_pylon", "build_assimilator"}, 1) == "build_assimilator"
    assert not executor.opening_decision.allow_emergency_pylon
    executor.record_action("build_assimilator", 1, True, base_index=0)
    assert executor.choose_action(order(), state, {"build_pylon"}, 2) == "build_pylon"
    assert executor.opening_decision.next_base_index == 1
