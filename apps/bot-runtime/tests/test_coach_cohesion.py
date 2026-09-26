import math

from pluto_sc2.coach_cohesion import CoachCohesion


def unit(tag, x, supply=2):
    return {"tag": tag, "position": (x, 50), "supply": supply}


def test_current_group_can_depart_from_main_without_returning_to_old_natural():
    plan = CoachCohesion()
    group = [unit(i, 50 + i, 10) for i in range(5)]
    plan.update(group, 60, (90, 50), (150, 50), 0)
    assert plan.phase == "advancing" and plan.wave_supply == 50
    assert math.dist(plan.rally, plan.waypoint) == 8
    assert plan.rally[0] < 60


def test_cluster_readiness_cannot_accumulate_different_camera_views():
    plan = CoachCohesion()
    plan.update([unit(1, 50, 20)], 60, (90, 50), (150, 50), 0)
    plan.update([unit(2, 50, 30)], 60, (90, 50), (150, 50), 1)
    assert plan.phase == "assembling" and plan.rally == (90, 50)


def test_spread_army_assembles_instead_of_releasing_single_type_pack():
    plan = CoachCohesion()
    plan.update([unit(1, 50), unit(2, 50), unit(3, 80), unit(4, 80)], 8, (50, 50), (150, 50), 0)
    assert plan.phase == "assembling" and plan.required_supply == 6
    assert plan.job(3)["target"] == (50, 50)
    assert plan.job(1)["name"] == "cohort_assemble"


def test_majority_releases_shared_short_waypoint_but_waits_for_confirmation_and_arrival():
    plan = CoachCohesion()
    group = [unit(1, 50), unit(2, 51), unit(3, 52)]
    plan.update(group, 8, (50, 50), (150, 50), 0)
    assert plan.phase == "advancing"
    assert plan.waypoint == (58, 50)
    assert plan.job(1)["target"] == plan.job(3)["target"]
    plan.confirm("cohort_advance", [1, 2], plan.epoch, True)
    plan.update([unit(1, 58), unit(2, 58), unit(3, 54)], 8, (50, 50), (150, 50), 10)
    assert plan.waypoint == (58, 50)  # Third type has not received its order.
    plan.confirm("cohort_advance", [3], plan.epoch, True)
    plan.update([], 8, (50, 50), (150, 50), 11)
    assert plan.waypoint == (58, 50)  # No off-screen location inference.
    plan.update([unit(1, 58), unit(2, 58), unit(3, 58)], 8, (50, 50), (150, 50), 12)
    assert plan.rally == (58, 50) and plan.waypoint == (66, 50)


def test_reinforcements_rally_before_joining_forward_wave_and_failures_do_not_count():
    plan = CoachCohesion()
    plan.update([unit(1, 50, 6)], 6, (50, 50), (150, 50), 0)
    assert plan.job(9)["target"] == (50, 50)
    plan.confirm("cohort_advance", [1], plan.epoch, False)
    assert plan.job(1) is not None
    plan.confirm("cohort_advance", [1], plan.epoch - 1, True)
    assert plan.job(1) is not None
    plan.confirm("cohort_advance", [1], plan.epoch, True)
    assert plan.job(1) is None


def test_hud_and_hallucinations_cannot_allow_tiny_group_to_launch():
    plan = CoachCohesion()
    plan.update([unit(1, 50, 4), {**unit(2, 50, 100), "is_hallucination": True}], 20,
                (50, 50), (150, 50), 0)
    assert plan.phase == "assembling" and plan.required_supply == 15
    plan.update([unit(1, 50, 4)], 4, (50, 50), (150, 50), 1)
    assert plan.phase == "assembling" and plan.required_supply == 6


def test_short_final_waypoint_and_inactive_orders_reset_the_cohort():
    plan = CoachCohesion()
    plan.update([unit(1, 50, 6)], 6, (50, 50), (54, 50), 0)
    assert math.dist(plan.rally, plan.waypoint) == 4
    plan.update([], 0, None, None, 1, active=False)
    assert plan.phase == "inactive" and plan.job(1) is None


def test_physical_arrival_can_complete_wave_without_forging_command_receipts():
    plan = CoachCohesion()
    plan.update([unit(1, 50), unit(2, 51), unit(3, 52)], 8, (50, 50), (150, 50), 0)
    assert plan.dispatched == set()
    plan.update([unit(1, 58), unit(2, 58), unit(3, 58)], 8, (50, 50), (150, 50), 10)
    assert plan.rally == (58, 50) and plan.waypoint == (66, 50)
    assert plan.dispatched == set()  # Next wave still needs actual orders.


def test_current_arrivals_replace_stale_members_without_inventing_their_deaths():
    plan = CoachCohesion()
    plan.update([unit(1, 50, 6)], 6, (50, 50), (150, 50), 0)
    plan.update([unit(9, 58, 6)], 6, (50, 50), (150, 50), 10)
    assert plan.rally == (58, 50) and plan.waypoint == (66, 50)
    assert plan.members == {9: 6}
    assert plan.job(1)["name"] == "cohort_assemble"  # Can regroup if observed again.


def test_fresh_reinforcement_at_old_anchor_joins_shared_advance():
    plan = CoachCohesion()
    plan.update([unit(1, 50, 6)], 6, (50, 50), (150, 50), 0)
    plan.confirm("cohort_advance", [1], plan.epoch, True)
    plan.update([unit(9, 50, 2)], 8, (50, 50), (150, 50), 5)
    assert plan.job(9)["name"] == "cohort_advance"
    assert plan.job(9)["target"] == (58, 50)
    assert plan.waypoint == (58, 50)  # No inferred arrival for old members.


def test_overridden_receipt_can_be_reissued_without_resetting_other_members():
    plan = CoachCohesion()
    plan.update([unit(1, 50), unit(2, 50), unit(3, 50)], 6, (50, 50), (150, 50), 0)
    plan.confirm("cohort_advance", [1, 2, 3], plan.epoch, True)
    epoch, waypoint = plan.epoch, plan.waypoint
    plan.release([1, 999])
    assert plan.job(1)["target"] == waypoint
    assert plan.job(2) is None and plan.dispatched == {2, 3}
    assert plan.epoch == epoch and plan.members == {1: 2, 2: 2, 3: 2}
    plan.confirm("cohort_advance", [1], epoch, True)
    assert plan.job(1) is None


def test_offscreen_time_alone_never_completes_advance_but_production_does_not_move_wave_quorum():
    plan = CoachCohesion()
    plan.update([unit(1, 50, 6)], 6, (50, 50), (150, 50), 0)
    plan.confirm("cohort_advance", [1], plan.epoch, True)
    plan.update([], 6, (50, 50), (150, 50), 1000)
    assert plan.phase == "advancing" and plan.waypoint == (58, 50)
    plan.update([unit(2, 58, 6)], 20, (50, 50), (150, 50), 1001)
    assert plan.waypoint == (66, 50) and plan.required_supply == 6


def test_v10_departing_wave_quorum_is_frozen_and_arrival_allows_real_unit_packing():
    plan = CoachCohesion()
    army = [unit(tag, 50) for tag in range(1, 25)]
    plan.update(army, 59, (50, 50), (150, 50), 670)
    assert plan.wave_supply == 48 and plan.epoch == 1
    plan.confirm("cohort_advance", list(range(1, 25)), plan.epoch, True)
    # New production raises totalHUD, but does not demand >51 supply from the
    # original48-supply wave. Eighteen large collision bodies can be within6
    # tiles while fewer fit within the old four-tile threshold.
    arrived = [unit(tag, 63) for tag in range(1, 19)]
    plan.update(arrived, 69, (50, 50), (150, 50), 675)
    assert plan.required_supply == 36
    assert plan.epoch == 2 and plan.rally == (58, 50)
    assert plan.wave_supply == 36


def test_confirmed_minimap_projection_controls_arrival_without_claiming_unit_location():
    plan = CoachCohesion()
    plan.update([unit(1, 50, 8)], 8, (50, 50), (150, 50), 0)
    plan.confirm("cohort_advance", [1], plan.epoch, True, (59.375, 50))
    assert plan.waypoint == (58, 50) and plan.arrival_point == (59.375, 50)
    plan.update([], 8, (50, 50), (150, 50), 100)
    assert plan.epoch == 1
    plan.update([unit(1, 59.375, 8)], 8, (50, 50), (150, 50), 101)
    assert plan.rally == (59.375, 50) and plan.waypoint == (67.375, 50)


def test_defend_or_retreat_stance_reset_releases_frozen_wave_for_next_assembly():
    plan = CoachCohesion()
    plan.update([unit(1, 50, 48)], 59, (50, 50), (150, 50), 0)
    plan.update([], 69, (50, 50), (150, 50), 1, active=False)
    assert plan.wave_supply == 0 and plan.effective_waypoint is None
    plan.update([unit(1, 50, 48)], 69, (50, 50), (150, 50), 2)
    assert plan.phase == "assembling" and plan.required_supply == 51.75


def test_objective_hold_does_not_create_endless_new_advance_epochs():
    plan = CoachCohesion()
    plan.update([unit(1, 50, 6)], 6, (50, 50), (54, 50), 0)
    plan.update([unit(1, 54, 6)], 6, (50, 50), (54, 50), 1)
    assert plan.phase == "holding_objective" and plan.rally == (54, 50)
    epoch = plan.epoch
    plan.update([unit(1, 54, 6)], 6, (50, 50), (54, 50), 10)
    assert plan.phase == "holding_objective" and plan.epoch == epoch
    plan.update([unit(1, 54, 6)], 6, (50, 50), (70, 50), 11)
    assert plan.phase == "advancing" and plan.epoch == epoch + 1
    assert plan.waypoint == (62, 50)


def test_observed_arrival_receipt_does_not_persist_after_unit_leaves_current_view():
    plan = CoachCohesion()
    plan.update([unit(1, 50), unit(2, 50), unit(3, 50)], 8, (50, 50), (150, 50), 0)
    plan.update([unit(1, 58)], 8, (50, 50), (150, 50), 1)
    assert plan.observed_arrivals == {1}
    plan.update([], 8, (50, 50), (150, 50), 2)
    assert not plan.observed_arrivals and not plan.dispatched


def test_live_v1_assembly_quorum_does_not_chase_continued_production():
    plan = CoachCohesion()
    # At500s the observed group was24 of49 army supply. At520s it grew to38,
    # but the former moving quota became39.75 as total army supply rose to53.
    plan.update([unit(tag, 50) for tag in range(1, 13)], 49,
                (50, 50), (150, 50), 500)
    assert plan.phase == "assembling" and plan.required_supply == 36.75
    plan.update([], 51, (50, 50), (150, 50), 505)
    assert plan.phase == "assembling" and plan.local_supply == 0
    assert plan.required_supply == 36.75
    plan.update([unit(tag, 50) for tag in range(1, 20)], 53,
                (50, 50), (150, 50), 520)
    assert plan.phase == "advancing" and plan.epoch == 1
    assert plan.wave_supply == 38 and len(plan.members) == 19
    assert plan.summary()["assembly_supply_reference"] == 49
    assert plan.summary()["assembly_started_game_seconds"] == 500


def test_frozen_assembly_still_requires_one_fresh_observed_majority():
    plan = CoachCohesion()
    plan.update([unit(1, 50, 24)], 48, (50, 50), (150, 50), 0)
    plan.update([unit(2, 50, 24)], 107, (50, 50), (150, 50), 100)
    assert plan.phase == "assembling" and plan.required_supply == 36
    assert plan.local_supply == 24 and not plan.members
    # Neither a long offscreen interval nor separate partial sightings count.
    plan.update([], 107, (50, 50), (150, 50), 1000)
    assert plan.phase == "assembling" and plan.epoch == 0
    assert plan.local_supply == 0 and plan.required_supply == 36


def test_assembly_reference_can_shrink_after_losses_but_replacements_cannot_raise_it():
    plan = CoachCohesion()
    plan.update([], 48, (50, 50), (150, 50), 0)
    plan.update([], 24, (50, 50), (150, 50), 1)
    assert plan.required_supply == 18
    plan.update([unit(1, 50, 16)], 48, (50, 50), (150, 50), 2)
    assert plan.phase == "assembling" and plan.required_supply == 18
    plan.update([unit(1, 50, 16), unit(2, 50, 2)], 48, (50, 50), (150, 50), 3)
    assert plan.phase == "advancing" and plan.wave_supply == 18


def test_new_assembly_after_defense_or_completed_objective_uses_new_hud_reference():
    plan = CoachCohesion()
    plan.update([], 48, (50, 50), (150, 50), 0)
    plan.update([], 80, (50, 50), (150, 50), 1, active=False)
    assert plan.assembly_supply == 0 and plan.assembly_started_at is None
    plan.update([unit(1, 50, 38)], 80, (50, 50), (150, 50), 2)
    assert plan.phase == "assembling" and plan.required_supply == 60
    assert plan.assembly_started_at == 2
    other = CoachCohesion()
    other.update([unit(1, 50, 6)], 6, (50, 50), (54, 50), 0)
    other.update([unit(1, 54, 6)], 6, (50, 50), (54, 50), 1)
    assert other.phase == "holding_objective"
    other.update([unit(1, 54, 6)], 48, (50, 50), (80, 50), 2)
    assert other.phase == "assembling" and other.required_supply == 36
    assert other.assembly_started_at == 2


def test_v14_redirected_click_receipts_allow_fresh_substantial_wave_to_advance():
    plan = CoachCohesion()
    plan.update([unit(tag, 50) for tag in range(1, 20)], 46,
                (50, 50), (150, 50), 470)
    assert plan.wave_supply == 38 and plan.epoch == 1
    plan.confirm("cohort_advance", [1], plan.epoch, True, (58, 50))
    plan.confirm("cohort_advance", range(2, 16), plan.epoch, True, (60.5, 50))
    # Later safe clicks can be over 1.5 tiles from the first click. The old
    # integration erased their receipts even after units reached those clicks.
    arrived = [unit(1, 58)] + [unit(tag, 60.5) for tag in range(2, 16)]
    for row in arrived:
        if plan.needs_redispatch(row["tag"], row["position"]):
            plan.release([row["tag"]])
    assert len(plan.dispatched) == 15
    plan.update([], 83, (50, 50), (150, 50), 600)
    assert plan.epoch == 1  # Commands never imply offscreen arrival.
    plan.update(arrived[:-1], 83, (50, 50), (150, 50), 601)
    assert plan.epoch == 1 and plan.local_supply == 28  # Still below 28.5.
    plan.update(arrived, 83, (50, 50), (150, 50), 602)
    assert plan.epoch == 2 and plan.wave_supply == 30
    assert not plan.dispatch_targets  # Next waypoint needs its own receipts.


def test_formation_completion_uses_bounded_fresh_arrival_region_and_forward_progress():
    plan = CoachCohesion()
    plan.update([unit(1, 50, 8)], 8, (50, 50), (150, 50), 0)
    plan.confirm("cohort_advance", [1], plan.epoch, True, (58, 50))
    assert not plan.needs_redispatch(1, (61, 50))  # Legal three-tile formation offset.
    assert not plan.needs_redispatch(1, (52, 50))  # Existing six-tile arrival boundary.
    assert plan.needs_redispatch(1, (51.9, 50))
    assert plan.needs_redispatch(1, (64.1, 50))
    # A short redirected waypoint must not credit an idle body at the old
    # rally just because both six-tile circles overlap it.
    other = CoachCohesion()
    other.update([unit(1, 50, 8)], 8, (50, 50), (150, 50), 0)
    other.confirm("cohort_advance", [1], other.epoch, True, (53, 50))
    assert other.needs_redispatch(1, (50, 50))
    assert other.needs_redispatch(1, (50.25, 50))
    assert not other.needs_redispatch(1, (50.5, 50))


def test_real_override_clears_only_affected_confirmed_source_target():
    plan = CoachCohesion()
    plan.update([unit(1, 50), unit(2, 50), unit(3, 50)], 6, (50, 50), (150, 50), 0)
    plan.confirm("cohort_advance", [1], plan.epoch, True, (58, 50))
    plan.confirm("cohort_advance", [2, 3], plan.epoch, True, (60.5, 50))
    assert plan.summary()["confirmed_source_targets"]["2"] == (60.5, 50)
    plan.release([2])  # Confirmed combat/defense/Stop replaces this order.
    assert plan.dispatched == {1, 3}
    assert plan.dispatch_targets == {1: (58, 50), 3: (60.5, 50)}
    assert plan.job(2)["name"] == "cohort_advance"
    plan.confirm("cohort_advance", [2], plan.epoch, False, (62, 50))
    assert 2 not in plan.dispatch_targets
    plan.confirm("cohort_advance", [2], plan.epoch - 1, True, (62, 50))
    assert 2 not in plan.dispatch_targets
    plan.confirm("cohort_advance", [2], plan.epoch, True, (59, 50))
    assert plan.dispatch_targets[2] == (59, 50)


def test_inactive_reset_rejects_late_receipts_and_clears_source_destinations():
    plan = CoachCohesion()
    plan.update([unit(1, 50, 8)], 8, (50, 50), (150, 50), 0)
    plan.confirm("cohort_advance", [1], plan.epoch, True, (58, 50))
    epoch = plan.epoch
    plan.update([], 8, (50, 50), (150, 50), 1, active=False)
    assert not plan.dispatch_targets
    plan.confirm("cohort_advance", [1], epoch, True, (58, 50))
    assert not plan.dispatched and not plan.dispatch_targets
    assert not plan.needs_redispatch(1, (50, 50))


def test_receipt_without_projection_uses_requested_waypoint_and_ignores_unknown_sources():
    plan = CoachCohesion()
    plan.update([unit(1, 50, 8)], 8, (50, 50), (150, 50), 0)
    plan.confirm("cohort_advance", [999], plan.epoch, True, (40, 50))
    assert plan.effective_waypoint is None
    plan.confirm("cohort_advance", [1], plan.epoch, True)
    assert plan.dispatch_targets[1] == (58, 50)
    assert plan.needs_redispatch(1, (50, 50))
