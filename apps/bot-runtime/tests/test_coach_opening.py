"""Pure replay-opening planner validation; no game or model is launched."""
from copy import deepcopy

import pytest
from sc2.ids.ability_id import AbilityId as A

from pluto_sc2.coach_opening import OpeningPlan, opening_base_index


REPLAY = "a" * 64
HELDOUT = "b" * 64


def event(kind, seconds, **changes):
    return dict(name=kind, seconds=seconds, meaning="construction_started") | changes


def candidate(events=None, **changes):
    return dict(replay_id=REPLAY, source_sha256=REPLAY, partition="train", starting_workers=8,
                matchup="PvT", site_build_label="Verified opening",
                milestone_events_first_10_minutes=events if events is not None else [
                    event("Pylon", 33, base_index=0), event("Gateway", 55, base_index=0),
                    event("Nexus", 100, base_index=1), event("Assimilator", 104, base_index=0),
                    event("CyberneticsCore", 116, base_index=0),
                    event("Assimilator", 124, base_index=0), event("Pylon", 145, base_index=1),
                ]) | changes


def plan(events=None, **options):
    return OpeningPlan.from_candidate(candidate(events), {REPLAY}, {HELDOUT}, "PvT", **options)


def unit(kind, tag, **changes):
    return dict(type=kind, tag=tag, is_ready=True, position=[tag * 5, 10], orders=[]) | changes


def report(*units, **changes):
    return dict(own_memory=list(units), current_own=list(units),
                opening_bases=[dict(base_index=0, position=[5, 10], tag=1),
                               dict(base_index=1, position=[100, 100], tag=9)]) | changes


@pytest.mark.parametrize("change", [
    {"replay_id": "bad"}, {"replay_id": "A" * 64}, {"source_sha256": HELDOUT},
    {"partition": "validation"}, {"partition": None}, {"starting_workers": 12},
    {"starting_workers": 8.0}, {"starting_workers": True}, {"matchup": "PvZ"},
])
def test_candidate_requires_matching_verified_train_eight_worker_metadata(change):
    with pytest.raises(ValueError):
        OpeningPlan.from_candidate(candidate(**change), {REPLAY}, {HELDOUT}, "PvT")


@pytest.mark.parametrize("train,validation,matchup", [
    (set(), {HELDOUT}, "PvT"), ({REPLAY}, {REPLAY}, "PvT"),
    ({REPLAY, HELDOUT}, {HELDOUT}, "PvT"), ({REPLAY}, set(), "TvP"),
])
def test_train_membership_whole_replay_split_and_requested_matchup_are_enforced(train, validation, matchup):
    with pytest.raises(ValueError):
        OpeningPlan.from_candidate(candidate(), train, validation, matchup)


@pytest.mark.parametrize("matchup", ["PvT", "PvP", "PvZ"])
def test_each_protoss_matchup_can_use_its_matching_training_candidate(matchup):
    opening = OpeningPlan.from_candidate(candidate(matchup=matchup), {REPLAY}, {HELDOUT}, matchup)
    assert opening.matchup == matchup


def test_requested_horizon_cannot_exceed_verified_base_enrichment():
    source = candidate(opening_enrichment={"horizon_seconds": 240})
    with pytest.raises(ValueError, match="exceeds verified"):
        OpeningPlan.from_candidate(source, {REPLAY}, {HELDOUT}, "PvT", horizon_seconds=270)


def test_enriched_gas_must_have_base_index_through_entire_requested_horizon():
    source = candidate([event("Pylon", 33, base_index=0), event("Assimilator", 255)],
                       opening_enrichment={"horizon_seconds": 600})
    with pytest.raises(ValueError, match="missing its verified base"):
        OpeningPlan.from_candidate(source, {REPLAY}, {HELDOUT}, "PvT", horizon_seconds=270)
    source["milestone_events_first_10_minutes"][1]["base_index"] = 1
    opening = OpeningPlan.from_candidate(source, {REPLAY}, {HELDOUT}, "PvT", horizon_seconds=270)
    assert opening.steps[-1].base_index == 1


@pytest.mark.parametrize("events", [None, {}, [], [None], ["Pylon"],
    [event("PROBE", 33)], [event("PYLON", -1)], [event("PYLON", True)],
    [event("PYLON", float("nan"))], [event("PYLON", float("inf"))],
    [event("PYLON", 33, game_loop=800)], [event("PYLON", 33, base_index=-1)],
    [event("PYLON", 33, base_index=True)], [event("PYLON", 33, base_index=1.0)],
    [event("PYLON", 50), event("GATEWAY", 49)],
])
def test_invalid_construction_event_metadata_is_rejected(events):
    source = candidate(milestone_events_first_10_minutes=events)
    with pytest.raises(ValueError):
        OpeningPlan.from_candidate(source, {REPLAY}, {HELDOUT}, "PvT")


def test_only_construction_starts_inside_horizon_become_commands():
    opening = plan([
        event("Nexus", 0), event("PROBE", 10, meaning="unit_completed"),
        event("WARPGATERESEARCH", 20, meaning="upgrade_completed"),
        event("Pylon", 33), event("Pylon", 51, meaning="construction_completed"),
        event("Gateway", 240, game_loop=5376), event("Nexus", 241),
    ])
    assert [(s.action, s.seconds) for s in opening.steps] == [("build_pylon", 33), ("build_gateway", 240)]


def test_repeated_structures_increment_targets_and_first_expansion_requires_second_nexus():
    opening = plan()
    assert [(s.kind, s.target_count) for s in opening.steps] == [
        ("PYLON", 1), ("GATEWAY", 1), ("NEXUS", 2), ("ASSIMILATOR", 1),
        ("CYBERNETICSCORE", 1), ("ASSIMILATOR", 2), ("PYLON", 2),
    ]
    state = report(unit("NEXUS", 1), unit("PYLON", 2), unit("GATEWAY", 3))
    decision = opening.decide(state, {"build_nexus", "build_assimilator"}, 100)
    assert decision.action == "build_nexus" and decision.step == 2
    assert decision.structure_quotas["NEXUS"] == 2
    assert decision.allow_expansion and decision.next_base_index == 1


def test_candidate_is_frozen_and_input_reports_are_not_mutated():
    source = candidate()
    opening = OpeningPlan.from_candidate(source, {REPLAY}, {HELDOUT}, "PvT")
    source["milestone_events_first_10_minutes"][0]["seconds"] = 999
    assert opening.steps[0].seconds == 33
    state = report(unit("NEXUS", 1))
    before = deepcopy(state)
    opening.decide(state, {"build_pylon"}, 33)
    assert state == before


def test_next_action_is_visible_before_due_but_not_executable_until_due_and_legal():
    opening = plan()
    before = opening.decide({}, {"build_pylon"}, 20)
    assert before.active and before.status == "waiting"
    assert before.action is None and before.next_action == "build_pylon" and before.due_at == 33
    assert not before.reserve and before.delay_seconds == 0
    due_illegal = opening.decide({}, set(), 33)
    assert due_illegal.status == "active" and due_illegal.action is None and due_illegal.reserve
    due_legal = opening.decide({}, {"build_pylon"}, 35)
    assert due_legal.action == "build_pylon" and due_legal.delay_seconds == 2
    assert due_legal.to_dict()["active"] is True


def test_reserve_begins_at_lead_window_and_can_be_configured():
    opening = plan()
    assert not opening.decide({}, set(), 22.99).reserve
    assert opening.decide({}, set(), 23).reserve
    configured = plan(reserve_lead_seconds=3)
    assert not configured.decide({}, set(), 29.99).reserve
    assert configured.decide({}, set(), 30).reserve


def test_rejected_or_unrelated_action_never_advances_and_duplicate_callback_is_ignored():
    opening = plan()
    opening.decide({}, {"build_pylon"}, 40)
    opening.record_action("build_pylon", 40, False)
    opening.record_action("train_probe", 40, True)
    assert opening.summary()["completed_steps"] == 0
    assert opening.decide({}, {"build_pylon"}, 41).action == "build_pylon"
    opening.record_action("build_pylon", 41, True, base_index=0)
    opening.record_action("build_pylon", 41, True, base_index=0)
    assert opening.summary()["completed_steps"] == 1


def test_delayed_acceptance_preserves_original_deadlines_and_reports_actual_delay():
    opening = plan()
    opening.decide({}, {"build_pylon"}, 60)
    opening.record_action("build_pylon", 60, True, base_index=0)
    gateway = opening.decide({}, {"build_gateway"}, 60)
    assert gateway.action == "build_gateway" and gateway.due_at == 55 and gateway.delay_seconds == 5
    opening.record_action("build_gateway", 60, True, base_index=0)
    nexus = opening.decide({}, {"build_nexus"}, 60)
    assert nexus.action is None and nexus.due_at == 100
    assert opening.summary()["history"] == [
        dict(step=0, action="build_pylon", original_due_at=33, observed_or_accepted_at=60,
             delay_seconds=27, via="accepted_input", base_index=0, target_count_at_base=1),
        dict(step=1, action="build_gateway", original_due_at=55, observed_or_accepted_at=60,
             delay_seconds=5, via="accepted_input", base_index=0, target_count_at_base=1),
    ]


def test_observed_and_unfinished_assets_satisfy_steps_with_warpgate_alias():
    opening = plan()
    state = report(unit("NEXUS", 1), unit("PYLON", 2, is_ready=False), unit("WARPGATE", 3))
    decision = opening.decide(state, {"build_nexus"}, 90)
    assert decision.step == 2 and decision.next_action == "build_nexus"
    assert decision.structure_quotas == {"NEXUS": 1, "PYLON": 1, "GATEWAY": 1}


@pytest.mark.parametrize("mode", ["visible_asset", "reservation", "build_order"])
def test_observation_memory_reservation_and_worker_order_deduplicate_one_pylon(mode):
    opening = plan([event("PYLON", 33), event("PYLON", 55)])
    position = [20, 20]
    worker = unit("PROBE", 3, orders=[dict(ability_id=A.PROTOSSBUILD_PYLON.value, target=position)])
    reservation = dict(type="PYLON", position=position, source_tag=3)
    state = report(worker)
    if mode in {"reservation", "visible_asset"}:
        state["pending_construction"] = [reservation]
    if mode == "visible_asset":
        pylon = unit("PYLON", 2, position=position, is_ready=False)
        state["own_memory"].append(pylon)
        state["current_own"].append(pylon)
    decision = opening.decide(state, {"build_pylon"}, 55)
    assert decision.step == 1 and decision.action == "build_pylon"
    assert opening.summary()["completed_steps"] == 1


def test_current_observation_overrides_same_tag_old_memory_and_mapping_records_work():
    opening = plan([event("GATEWAY", 33), event("GATEWAY", 55)])
    state = dict(own_memory={"2": unit("GATEWAY", 2)},
                 current_own=[unit("WARPGATE", 2)])
    assert opening.decide(state, {"build_gateway"}, 55).step == 1


def test_nonrecord_inventory_items_are_ignored_without_creating_structures():
    opening = plan()
    state = dict(own_memory=[None, "PYLON", 7], current_own=[None, False],
                 pending_construction=[None, "PYLON", 12])
    assert opening.decide(state, {"build_pylon"}, 33).step == 0


def test_suspension_never_advances_observations_or_accepted_actions_and_never_reserves():
    opening = plan()
    state = report(unit("PYLON", 2), unit("GATEWAY", 3))
    suspended = opening.decide(state, {"build_pylon"}, 40, suspended=True)
    assert suspended.status == "suspended" and not suspended.active
    assert suspended.action is None and not suspended.reserve and not suspended.allow_expansion
    assert suspended.step == 0 and opening.summary()["history"] == []
    opening.record_action("build_pylon", 40, True)
    assert opening.summary()["completed_steps"] == 0
    resumed = opening.decide(state, set(), 41)
    assert resumed.step == 2 and resumed.next_action == "build_nexus"


def test_fallback_is_bounded_strictly_after_max_delay_and_stays_inactive():
    opening = plan()
    boundary = opening.decide({}, {"build_pylon"}, 123)
    assert boundary.active and boundary.action == "build_pylon" and boundary.delay_seconds == 90
    fallback = opening.decide({}, {"build_pylon"}, 123.01)
    assert fallback.status == "fallback" and not fallback.active
    assert fallback.action is None and not fallback.reserve and fallback.reason
    opening.record_action("build_pylon", 124, True)
    assert opening.decide(report(unit("PYLON", 2)), set(), 125).status == "fallback"
    assert opening.summary()["completed_steps"] == 0


def test_a_late_prefix_is_not_forced_complete_at_the_horizon():
    opening = plan([event("PYLON", 200), event("GATEWAY", 230)])
    assert opening.decide({}, {"build_pylon"}, 250).action == "build_pylon"
    opening.record_action("build_pylon", 250, True)
    decision = opening.decide({}, {"build_gateway"}, 250)
    assert decision.active and decision.action == "build_gateway" and decision.due_at == 230
    opening.record_action("build_gateway", 250, True)
    assert opening.decide({}, set(), 250).status == "complete"


def test_gas_quotas_are_zero_based_and_only_unlock_in_order_when_due():
    opening = plan([event("ASSIMILATOR", 30, base_index=0),
                    event("NEXUS", 50, base_index=1),
                    event("ASSIMILATOR", 60, base_index=1),
                    event("ASSIMILATOR", 70, base_index=0)])
    before = opening.decide({}, {"build_assimilator"}, 29)
    assert before.desired_gas_count == 0 and before.desired_gas_by_base == {}
    main = opening.decide({}, {"build_assimilator"}, 30)
    assert main.desired_gas_count == 1 and main.desired_gas_by_base == {0: 1}
    assert main.next_base_index == 0
    opening.record_action("build_assimilator", 30, True, base_index=0)
    expansion = opening.decide(report(unit("NEXUS", 1)), {"build_nexus"}, 50)
    assert expansion.allow_expansion and expansion.next_base_index == 1
    assert expansion.desired_gas_by_base == {0: 1}
    opening.record_action("build_nexus", 50, True, base_index=1)
    natural = opening.decide({}, {"build_assimilator"}, 60)
    assert natural.desired_gas_count == 2 and natural.desired_gas_by_base == {0: 1, 1: 1}
    opening.record_action("build_assimilator", 60, True, base_index=1)
    third = opening.decide({}, {"build_assimilator"}, 70)
    assert third.desired_gas_count == 3 and third.desired_gas_by_base == {0: 2, 1: 1}


def test_completed_prefix_holds_structure_quotas_until_horizon():
    opening = plan([event("PYLON", 33), event("GATEWAY", 55)])
    state = report(unit("NEXUS", 1), unit("PYLON", 2), unit("WARPGATE", 3))
    held = opening.decide(state, {"build_gateway", "build_assimilator", "build_nexus"}, 60)
    assert held.status == "waiting" and held.active and held.step == 2
    assert held.action is None and held.next_action is None and held.due_at == 240
    assert not held.reserve and not held.allow_expansion and held.desired_gas_count == 0
    assert held.structure_quotas == {"NEXUS": 1, "PYLON": 1, "GATEWAY": 1}
    assert opening.decide(state, set(), 239.99).active
    complete = opening.decide(state, set(), 240)
    assert complete.status == "complete" and not complete.active and complete.due_at is None
    assert opening.summary()["horizon_seconds"] == 240


@pytest.mark.parametrize("value", [-1, True, float("nan"), float("inf")])
def test_invalid_time_is_rejected(value):
    with pytest.raises(ValueError):
        plan().decide({}, set(), value)


def test_time_must_be_monotonic_and_history_summary_is_not_mutable_state():
    opening = plan()
    opening.decide({}, {"build_pylon"}, 33)
    opening.record_action("build_pylon", 33, True, base_index=0)
    history = opening.summary()["history"]
    history[0]["delay_seconds"] = 999
    assert opening.summary()["history"][0]["delay_seconds"] == 0
    with pytest.raises(ValueError, match="backwards"):
        opening.decide({}, set(), 32)


def test_main_pylons_cannot_satisfy_natural_pylon_or_its_second_local_count():
    opening = plan([event("Pylon", 33, base_index=0), event("Pylon", 55, base_index=1),
                    event("Pylon", 70, base_index=1)])
    state = report(unit("PYLON", 2), unit("PYLON", 3), unit("PYLON", 4, position=[10, 12]))
    assert opening.decide(state, {"build_pylon"}, 55).step == 1
    state["current_own"].append(unit("PYLON", 5, position=[101, 100], is_ready=False))
    assert opening.decide(state, {"build_pylon"}, 70).step == 2
    assert opening.summary()["history"][-1]["target_count_at_base"] == 1
    state["pending_construction"] = [dict(type="PYLON", position=[105, 100])]
    assert opening.decide(state, set(), 71).step == 3
    assert opening.summary()["history"][-1]["target_count_at_base"] == 2


@pytest.mark.parametrize("kind", ["SHIELDBATTERY", "ASSIMILATOR", "ROBOTICSFACILITY"])
def test_indexed_structure_requires_its_own_base_even_if_global_count_is_sufficient(kind):
    opening = plan([event(kind, 33, base_index=1)])
    state = report(unit(kind, 2), unit(kind, 3))
    assert opening.decide(state, {"build_" + kind.lower()}, 33).step == 0
    state["current_own"].append(unit(kind, 4, position=[105, 105]))
    assert opening.decide(state, set(), 34).step == 1


def test_natural_nexus_has_local_target_one_and_main_rebuild_has_target_two():
    natural = plan([event("NEXUS", 33, base_index=1)])
    state = report(unit("NEXUS", 1), unit("NEXUS", 2, position=[100, 100]))
    assert natural.decide(state, set(), 33).step == 1
    assert natural.summary()["history"][0]["target_count_at_base"] == 1
    main = plan([event("NEXUS", 33, base_index=0)])
    assert main.decide(state, {"build_nexus"}, 33).step == 0


@pytest.mark.parametrize("base_index", [None, 0, True, 1.0, -1])
def test_wrong_or_unknown_callback_base_never_credits_indexed_step(base_index):
    opening = plan([event("PYLON", 33, base_index=1)])
    opening.decide({}, {"build_pylon"}, 33)
    opening.record_action("build_pylon", 33, True, base_index=base_index)
    assert opening.summary()["completed_steps"] == 0
    opening.record_action("build_pylon", 34, True, base_index=1)
    assert opening.summary()["completed_steps"] == 1


def test_missing_base_evidence_is_not_global_credit_and_keeps_bounded_fallback():
    opening = plan([event("PYLON", 33, base_index=1)])
    state = report(unit("PYLON", 2, position=[100, 100]), opening_bases=[])
    assert opening.decide(state, {"build_pylon"}, 123).step == 0
    assert opening.decide(state, {"build_pylon"}, 123.01).status == "fallback"
    assert opening.summary()["completed_steps"] == 0


@pytest.mark.parametrize("mode", ["order", "reservation", "asset"])
def test_natural_construction_order_uses_target_not_worker_position_and_deduplicates(mode):
    opening = plan([event("PYLON", 33, base_index=1), event("PYLON", 55, base_index=1)])
    worker = unit("PROBE", 2, position=[6, 10], orders=[
        dict(ability_id=A.PROTOSSBUILD_PYLON.value, target=[101, 100])])
    state = report(worker)
    if mode in {"reservation", "asset"}:
        state["pending_construction"] = [dict(type="PYLON", position=[101, 100], source_tag=2)]
    if mode == "asset":
        state["current_own"].append(unit("PYLON", 3, position=[101, 100], is_ready=False))
    before = deepcopy(state)
    assert opening.decide(state, {"build_pylon"}, 55).step == 1
    assert state == before


def test_current_position_and_orders_remove_stale_same_tag_base_evidence():
    opening = plan([event("PYLON", 33, base_index=1)])
    stale = unit("PROBE", 2, orders=[dict(produces="PYLON", target=[101, 100])])
    state = report(own_memory={"2": stale, "3": unit("PYLON", 3, position=[101, 100])},
                   current_own=[unit("PROBE", 2), unit("PYLON", 3, position=[10, 10])])
    assert opening.decide(state, {"build_pylon"}, 33).step == 0


def test_unknown_positions_hallucinations_and_ambiguous_base_roles_do_not_count():
    opening = plan([event("PYLON", 33, base_index=1)])
    state = report(unit("PYLON", 2, position=None),
                   unit("PYLON", 3, position=[101, 100], is_hallucination=True),
                   pending_construction=[dict(type="PYLON"), dict(type="PYLON", position=[200, 200])])
    assert opening.decide(state, {"build_pylon"}, 33).step == 0
    state["current_own"].append(unit("PYLON", 4, position=[101, 100]))
    state["opening_bases"].append(dict(base_index=1, position=[110, 110]))
    assert opening.decide(state, {"build_pylon"}, 34).step == 0


def test_nearest_base_radius_tie_and_malformed_metadata_are_conservative():
    state = report(opening_bases=[dict(base_index=0, position=[0, 0]),
                                 dict(base_index=1, position=[20, 0]),
                                 dict(base_index=True, position=[2, 2]),
                                 dict(base_index=4, position=[float("nan"), 0])])
    assert opening_base_index(state, [20, 14]) == 1
    assert opening_base_index(state, [20, 14.01]) is None
    assert opening_base_index(state, [10, 0]) is None
    assert opening_base_index(state, [11, 0]) == 1
    assert opening_base_index(state, None) is None


def test_unindexed_prefix_does_not_inflate_indexed_local_target():
    opening = plan([event("PYLON", 33), event("PYLON", 55, base_index=1)])
    state = report(unit("PYLON", 2, position=[101, 100]))
    assert opening.decide(state, set(), 55).step == 2
    assert opening.summary()["history"][-1]["target_count_at_base"] == 1
