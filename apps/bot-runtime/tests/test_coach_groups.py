from types import SimpleNamespace as NS

import pytest
from sc2.ids.unit_typeid import UnitTypeId as U

from pluto_sc2.coach_groups import CoachGroups


def producer(tag, kind=U.NEXUS, *, ready=True, mine=True):
    return NS(tag=tag, type_id=kind, is_structure=True, is_ready=ready, is_mine=mine)


def register(plan, group, units, now=0):
    plan.observe(units, now)
    pending = plan.plan_registration(group, [u.tag for u in units], now)
    assert pending is not None
    return plan.confirm_registration(True, now + .3)


def test_registration_requires_current_matching_confirmed_visible_selection():
    plan = CoachGroups()
    plan.observe([producer(1)], 1)
    assert plan.plan_registration("nexus", [1, 2], 1) is None
    assert plan.plan_registration("gateway", [1], 1) is None
    assert plan.plan_registration("nexus", [1], 2) is None
    request = plan.plan_registration("NEXUS", [1], 1)
    assert request["group"] == 2 and not request["append"]
    assert not plan.registered[2]  # A plan is not a paid group-store receipt.
    assert plan.recall_plan(2, 1) is None
    plan.confirm_registration(True, 1.3)
    assert plan.recall_plan(2, 2)["registered_source_tags"] == [1]


def test_observation_never_reads_unit_positions_or_global_state():
    class RestrictedProducer:
        tag, type_id, is_structure, is_ready, is_mine = 1, U.NEXUS, True, True, True

        @property
        def position(self):
            pytest.fail("Control-group registry must not read a unit position")

    plan = CoachGroups()
    plan.observe([RestrictedProducer()], 0)
    assert plan.registration_candidate(0)["source_tags"] == [1]
    assert plan.plan_registration("nexus", [1], 0)
    plan.confirm_registration(True, .3)
    plan.observe([], 10)
    # Absence from a later camera is not a death, hidden queue, or live roster.
    recall = plan.recall_plan("nexus", 10)
    assert recall["registered_source_tags"] == [1]
    assert recall["requires_selected_ui_ability"]


def test_producer_groups_append_new_bases_without_replacing_previous_base():
    plan = CoachGroups()
    register(plan, 2, [producer(1)])
    plan.observe([producer(2)], 10)
    request = plan.plan_registration("nexus", [2], 10)
    assert request["append"]
    plan.confirm_registration(True, 10.3)
    assert plan.registered[2] == {1, 2}
    plan.observe([producer(1), producer(2)], 11)
    assert plan.plan_registration(2, [1, 2], 11) is None


def test_registration_queue_prevents_interleaved_store_or_recall():
    plan = CoachGroups()
    plan.observe([producer(1), producer(2, U.GATEWAY)], 0)
    plan.plan_registration(2, [1], 0)
    assert plan.plan_registration(3, [2], 0) is None
    assert plan.registration_candidate(0) is None
    assert plan.main_army_refresh_due(0, 12) is None
    copied = plan.pending_registration
    copied["source_tags"].append(999)
    assert plan.pending_registration["source_tags"] == [1]


def test_rejected_store_preserves_prior_membership_and_has_bounded_retry():
    plan = CoachGroups()
    register(plan, 2, [producer(1)])
    plan.observe([producer(2)], 10)
    plan.plan_registration(2, [2], 10)
    plan.confirm_registration(False, 10.3)
    assert plan.registered[2] == {1} and plan.pending_registration is None
    plan.observe([producer(2)], 13)
    assert plan.registration_candidate(13) is None
    plan.observe([producer(2)], 13.3)
    assert plan.registration_candidate(13.3)["source_tags"] == [2]


def test_registration_candidate_is_current_and_does_not_claim_a_selection():
    plan = CoachGroups()
    plan.observe([producer(1), producer(2, U.GATEWAY), producer(3, U.ROBOTICSFACILITY),
                  producer(4, U.STARGATE), producer(5, ready=False), producer(6, mine=False)], 0)
    assert plan.registration_candidate(0)["group"] == 2
    assert plan.pending_registration is None
    assert plan.registration_candidate(1) is None
    plan.plan_registration(2, [1], 0)
    plan.confirm_registration(True, .3)
    plan.observe([producer(2, U.GATEWAY), producer(3, U.ROBOTICSFACILITY), producer(4, U.STARGATE)], 1)
    assert plan.registration_candidate(1)["group"] == 3


def test_gateway_and_warpgate_registry_candidate_requires_mixed_selection():
    plan = CoachGroups()
    plan.observe([producer(1, U.GATEWAY), producer(2, U.WARPGATE)], 0)
    candidate = plan.registration_candidate(0)
    assert candidate["group"] == 3 and candidate["selection_mode"] == "rectangle"
    assert plan.plan_registration(3, [1, 2], 0)


@pytest.mark.parametrize("action,group", [
    ("train_probe", 2), ("train_zealot", 3), ("train_stalker", 3), ("train_sentry", 3),
    ("train_immortal", 4), ("train_observer", 4), ("train_warpprism", 4),
    ("train_voidray", 5), ("train_carrier", 5), ("train_oracle", 5),
    ("research_warpgateresearch", None), ("research_charge", None),
    ("build_gateway", None), ("chrono_boost", None), ("harvest_minerals", None),
])
def test_action_groups_map_only_registered_production_roles(action, group):
    assert CoachGroups.group_for_action(action) == group


@pytest.mark.parametrize("accepted", [False, True])
def test_production_recall_uses_three_second_group_cooldown_without_hidden_queues(accepted):
    plan = CoachGroups()
    register(plan, 4, [producer(1, U.ROBOTICSFACILITY)])
    plan.record_production_attempt("train_immortal", 10, accepted)
    assert plan.recall_plan(4, 12.9) is None
    assert plan.recall_plan(4, 13)["requires_selected_ui_ability"]
    assert plan.group_for_action("train_observer") == 4
    assert "positions" not in plan.summary()


def test_main_army_f2_refresh_and_group_one_replace_are_separate_paid_results():
    plan = CoachGroups()
    request = plan.main_army_refresh_due(0, 12)
    assert request["selection_mode"] == "army" and request["save_group"] == 1
    assert request["requires_visible_leader"] and request["requires_current_visible_ground_target"]
    plan.record_army_refresh(0, 12, True)
    assert not plan.registered[1]  # F2 itself did not save a group.
    # Controller-confirmed F2 tags are opaque; no offscreen position is needed.
    store = plan.plan_registration("army", [10, 20, 30], 0)
    assert not store["append"]
    plan.confirm_registration(True, .3)
    assert plan.recall_plan(1, 1)["registered_source_tags"] == [10, 20, 30]
    assert plan.main_army_refresh_due(3, 17) is None
    assert plan.main_army_refresh_due(3, 18)["reason"] == "reinforcements"
    plan.record_army_refresh(3, 18, True)
    plan.plan_registration("army", [10, 30, 40], 3)
    plan.confirm_registration(True, 3.3)
    assert plan.registered[1] == {10, 30, 40}
    assert plan.main_army_refresh_due(17.9, 18) is None
    assert plan.main_army_refresh_due(18, 18)["reason"] == "periodic_refresh"


@pytest.mark.parametrize("protection", ["protected_until", "scout_until", "rescue_until"])
def test_f2_refresh_defers_to_bounded_micro_scout_and_rescue_leases(protection):
    plan = CoachGroups()
    assert plan.main_army_refresh_due(10, 20, **{protection: 11}) is None
    assert plan.main_army_refresh_due(11, 20, **{protection: 11}) is not None
    assert plan.main_army_refresh_due(11, 20, active=False) is None
    assert plan.main_army_refresh_due(11, 4) is None


def test_failed_f2_does_not_register_or_refresh_membership_and_retries_after_three_seconds():
    plan = CoachGroups()
    plan.record_army_refresh(10, 20, False)
    assert plan.main_army_refresh_due(12.9, 20) is None
    assert plan.main_army_refresh_due(13, 20)["reason"] == "initial_army"
    assert not plan.registered[1] and plan.summary()["last_army_refresh_game_seconds"] is None


def test_expired_negative_lease_sentinel_does_not_block_refresh():
    plan = CoachGroups()
    assert plan.main_army_refresh_due(10, 20, protected_until=-100, scout_until=-100, rescue_until=-100)


def test_engine_hidden_flag_prevents_producer_registration():
    plan = CoachGroups()
    hidden = producer(1)
    hidden.is_on_screen = False
    plan.observe([hidden], 0)
    assert plan.registration_candidate(0) is None


def test_stale_dictionary_memory_rows_cannot_register_producers():
    plan = CoachGroups()
    plan.observe([{"tag": 1, "type": "NEXUS", "is_structure": True, "is_ready": True, "current": False}], 0)
    assert plan.registration_candidate(0) is None
    assert plan.plan_registration(2, [1], 0) is None


def test_invalid_registration_or_action_input_fails_before_changing_registry():
    plan = CoachGroups()
    for group in (0, 6, True, "forge"):
        with pytest.raises(ValueError):
            plan.recall_plan(group, 0)
    with pytest.raises(ValueError):
        plan.plan_registration(1, [True], 0)
    with pytest.raises(ValueError):
        plan.record_production_attempt("research_charge", 0, True)
    with pytest.raises(ValueError):
        plan.main_army_refresh_due(0, float("nan"))
