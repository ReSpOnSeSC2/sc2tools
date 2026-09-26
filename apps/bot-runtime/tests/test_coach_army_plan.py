import math

from pluto_sc2.coach_army_plan import defense_plan


def base(tag, point, **kwargs):
    return dict(tag=tag, position=point, type="NEXUS", is_ready=True, **kwargs)


def test_guard_exposed_ready_base_with_separated_roles():
    bases = [base(1, (10, 10)), base(2, (30, 10)),
             dict(tag=3, position=(60, 10), type="NEXUS", is_ready=False)]
    melee = defense_plan(bases, (90, 10), "ZEALOT")
    ranged = defense_plan(bases, (90, 10), "STALKER")
    support = defense_plan(bases, (90, 10), "SENTRY")
    assert melee.base_tag == ranged.base_tag == support.base_tag == 2
    assert melee.candidates[0] == (40, 10)
    assert ranged.candidates[0] == (38, 10)
    assert support.candidates[0] == (36.5, 10)
    assert melee.job == "guard_base"


def test_observed_attack_redirects_defense_to_threatened_main_and_direction():
    bases = [base(1, (10, 10)), base(2, (30, 10))]
    plan = defense_plan(bases, (90, 10), "IMMORTAL", alert_position=(10, 10),
                        threat_position=(10, 0))
    assert plan.base_tag == 1
    assert plan.candidates[0] == (10, 2)
    assert plan.job == "defend_base"


def test_candidates_are_bounded_and_do_not_depend_on_enemy_memory():
    plan = defense_plan([base(1, (140, 150))], (40, 40), "HIGHTEMPLAR")
    assert plan.role == "support"
    assert len(set(plan.candidates)) >= 3
    assert all(6.5 - 1e-9 <= math.dist(plan.base_position, p) <= 7 for p in plan.candidates)
    assert plan.to_dict()["base_tag"] == 1


def test_no_base_or_invalid_coordinates_produce_no_plan():
    assert defense_plan([], (90, 10), "ZEALOT") is None
    assert defense_plan([base(1, (10, 10))], (float("nan"), 10), "ZEALOT") is None
    assert defense_plan([base(1, (True, 10))], (90, 10), "ZEALOT") is None
    assert defense_plan([base(1, (10, 10))], (10, 10), "ZEALOT") is None


def test_alert_at_base_center_uses_public_direction_and_stable_ties():
    plan = defense_plan([base(2, (10, 10)), base(1, (10, 10))], (90, 10), "ZEALOT",
                        alert_position=(10, 10), threat_position=(10, 10))
    assert plan.base_tag == 1
    assert plan.candidates[0] == (20, 10)


def test_every_support_fallback_stays_clear_of_nexus_click_area():
    for kind in ('SENTRY', 'HIGHTEMPLAR', 'WARPPRISM', 'OBSERVER', 'DISRUPTOR'):
        for enemy in ((0, 0), (100, 50), (50, 100), (100, 100)):
            plan = defense_plan([base(1, (50, 50))], enemy, kind)
            assert all(math.dist(plan.base_position, p) >= 6.5 - 1e-9 for p in plan.candidates)
