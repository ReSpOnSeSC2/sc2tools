from types import SimpleNamespace

import pytest
from sc2.ids.ability_id import AbilityId as A
from sc2.ids.buff_id import BuffId as B
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.ids.upgrade_id import UpgradeId
from sc2.position import Point2
from sc2.unit import Unit as SC2Unit
from s2clientprotocol import common_pb2 as common, raw_pb2 as raw

from pluto_sc2.coach_harassment import CoachHarassment, _current


def unit(tag, kind=U.ADEPT, position=(50, 50), *, own=True, **changes):
    data = dict(tag=tag, type_id=kind, position=Point2(position), is_mine=own,
        is_on_screen=True, is_visible=True, is_snapshot=False, is_hallucination=False,
        is_flying=False, is_ready=True, is_structure=False, health=100, health_max=100,
        shield=50, shield_max=50, ground_dps=18.6, ground_range=.1, can_attack_ground=True,
        movement_speed=3.15, is_attacking=False)
    if kind == U.ADEPT:
        data.update(health=70, health_max=70, shield=70, shield_max=70, ground_dps=10, ground_range=4)
    if kind == U.SCV:
        data.update(health=45, health_max=45, shield=0, shield_max=0, ground_dps=5, ground_range=.1)
    data.update(changes)
    return SimpleNamespace(**data)


def reserved_order_worker(tag, kind, position, *, own):
    weapon = SimpleNamespace(type=1, damage=5, attacks=1, speed=1, range=.1)
    data = SimpleNamespace(_proto=SimpleNamespace(weapons=[weapon], movement_speed=3.94, attributes=[]))
    bot = SimpleNamespace(state=SimpleNamespace(game_loop=1120),
        game_data=SimpleNamespace(abilities={}, units={kind.value: data}))
    return SC2Unit(raw.Unit(tag=tag, unit_type=kind.value, alliance=1 if own else 4,
        display_type=1, is_on_screen=True, build_progress=1, health=45, health_max=45,
        pos=common.Point(x=position[0], y=position[1]),
        orders=[raw.UnitOrder(ability_id=4135)]), bot, base_build=99999)


@pytest.mark.parametrize("kind", [U.PROBE, U.SCV])
def test_native_reserved_order_own_workers_are_skipped_before_unsafe_order_decode(kind):
    worker = reserved_order_worker(99, kind, (50, 50), own=True)
    with pytest.raises(KeyError, match="4135"):
        _ = worker.is_attacking
    assert _current(worker, 100, own=True) is None
    ours, enemies = scene()
    assert CoachHarassment().plan([worker, *ours], enemies, 100, 40)["name"] == "harass_workers"


def test_native_reserved_enemy_worker_orders_remain_unknown_and_are_not_discounted_as_mining():
    workers = [reserved_order_worker(30 + i, U.SCV, (53, 50 + i * .05), own=False) for i in range(12)]
    with pytest.raises(KeyError, match="4135"):
        _ = workers[0].is_attacking
    assert _current(workers[0], 100, own=False)["is_attacking"] is None
    ours = [unit(1, U.ZEALOT), unit(2, U.ZEALOT, (51, 50))]
    assert CoachHarassment().plan(ours, workers, 100, 40) is None


def scene():
    return [unit(1), unit(2, position=(51, 50))], [unit(11, U.SCV, (56, 50), own=False)]


def started():
    planner = CoachHarassment()
    own, enemies = scene()
    intent = planner.plan(own, enemies, 100, 30)
    assert planner.confirm(intent, True, 100.5, actual_source_tags=intent["source_tags"])
    return planner, own, enemies


def test_small_visible_worker_raid_uses_rectangle_and_preserves_main_army_supply():
    planner = CoachHarassment()
    own, enemies = scene()
    intent = planner.plan(own, enemies, 100, 20)
    assert intent["name"] == "harass_workers" and intent["target_tag"] == 11
    assert intent["source_tags"] == [1, 2] and intent["selection_mode"] == "rectangle"
    assert intent["raid_supply"] == 4 and intent["army_fraction"] <= .2
    assert not planner.protected_tags(100)  # Intent alone reserves nothing.


@pytest.mark.parametrize("supply", [0, 4, 10, 19.9])
def test_small_army_is_not_split(supply):
    assert CoachHarassment().plan(*scene(), 100, supply) is None


@pytest.mark.parametrize("flag", ["defense_alert", "production_due"])
def test_defense_and_current_production_input_have_priority(flag):
    assert CoachHarassment().plan(*scene(), 100, 40, **{flag: True}) is None


def test_never_detaches_workers_expensive_robo_or_protected_members():
    own, enemies = scene()
    own.extend([unit(3, U.PROBE), unit(4, U.IMMORTAL), unit(5, U.OBSERVER)])
    assert CoachHarassment().plan(own, enemies, 100, 40, protected_tags={1}) is None


@pytest.mark.parametrize("field", ["is_hallucination", "is_flying", "is_snapshot"])
def test_ineligible_source_state_is_not_sent_on_raid(field):
    own, enemies = scene()
    setattr(own[0], field, True)
    assert CoachHarassment().plan(own, enemies, 100, 40) is None


def test_hidden_unit_positions_are_never_read():
    class Hidden:
        is_on_screen = False

        @property
        def position(self):
            raise AssertionError("Hidden position read")

    own, enemies = scene()
    assert CoachHarassment().plan([Hidden(), *own], [Hidden(), *enemies], 100, 40)["target_tag"] == 11


def test_two_zealots_can_raid_mining_line_without_assuming_all_workers_defend():
    own = [unit(1, U.ZEALOT), unit(2, U.ZEALOT, (51, 50))]
    miners = [unit(11 + i, U.SCV, (53 + i % 3 * .2, 50 + i // 3 * .2), own=False) for i in range(20)]
    assert CoachHarassment().plan(own, miners, 100, 30)["source_tags"] == [1, 2]
    for worker in miners:
        worker.is_attacking = True
    assert CoachHarassment().plan(own, miners, 100, 30) is None


@pytest.mark.parametrize("kind", [U.PHOTONCANNON, U.BUNKER, U.PLANETARYFORTRESS, U.SPINECRAWLER])
def test_known_static_defense_blocks_small_raid(kind):
    own, enemies = scene()
    enemies.append(unit(20, kind, (58, 50), own=False, is_structure=True))
    assert CoachHarassment().plan(own, enemies, 100, 40) is None


def test_visible_mobile_defending_army_and_approach_time_are_respected():
    own, enemies = scene()
    enemies.extend(unit(20 + i, U.MARINE, (57, 50 + i * .2), own=False,
                       health=45, health_max=45, shield=0, shield_max=0, ground_dps=10, ground_range=5)
                   for i in range(5))
    assert CoachHarassment().plan(own, enemies, 100, 40) is None


def test_missing_current_combat_stats_never_mean_safe():
    own, enemies = scene()
    own[0].ground_dps = None
    assert CoachHarassment().plan(own, enemies, 100, 40) is None


@pytest.mark.parametrize("accepted,actual", [(False, [1, 2]), (True, [1]), (True, [1, 2, 3])])
def test_only_exact_accepted_selection_creates_raid_lease(accepted, actual):
    planner = CoachHarassment()
    intent = planner.plan(*scene(), 100, 40)
    assert not planner.confirm(intent, accepted, 100.5, actual_source_tags=actual)
    assert not planner.blocks_global_army(101)


def test_accepted_raid_blocks_f2_but_cannot_extend_indefinitely():
    planner, own, enemies = started()
    assert set(planner.protected_tags(101)) == {1, 2}
    assert planner.plan(own, enemies, 101, 30) is None  # Input cooldown.
    intent = planner.plan(own, enemies, 103, 30)
    assert planner.confirm(intent, True, 103.5)
    release = planner.plan(own, enemies, 121, 30)
    assert release["name"] == "harass_release"
    assert not planner.blocks_global_army(121)
    assert planner.confirm(release, True, 121)
    assert planner.mission is None


def test_visible_damage_or_defense_emergency_retreats_even_when_production_due():
    planner, own, enemies = started()
    own[0].health, own[0].shield = 20, 0
    intent = planner.plan(own, enemies, 102, 30, production_due=True, retreat_anchor=(47, 50))
    assert intent["name"] == "harass_retreat" and intent["position"] == [47, 50]
    assert intent["requires_current_visible_ground"] is True
    assert planner.confirm(intent, True, 102.5)
    assert planner.mission["until"] <= 106.5


def test_raid_outside_view_does_not_turn_unknown_army_positions_into_commands():
    planner, _, enemies = started()
    intent = planner.plan([], enemies, 102, 30, production_due=True, camera=(50, 50))
    assert intent["name"] == "harass_release" and intent["source_tags"] == []


def test_offscreen_raid_reacquire_is_a_bounded_paid_camera_plan():
    planner, _, enemies = started()
    intent = planner.plan([], enemies, 102, 30, camera=(40, 40))
    assert intent["name"] == "harass_camera" and intent["source_tags"] == []
    assert planner.confirm(intent, True, 102.5)
    returning = planner.plan([], [], 104, 30, camera=(50, 50))
    assert returning["name"] == "harass_camera" and returning["position"] == [40, 40]
    assert planner.confirm(returning, True, 104)
    assert planner.next_camera >= 124


def test_remembered_base_is_only_a_bounded_reconnaissance_not_an_attack():
    planner = CoachHarassment()
    memory = [{"type": "COMMANDCENTER", "position": [100, 100], "last_seen_seconds": 95, "status": "stale"}]
    intent = planner.plan(*[scene()[0], []], 100, 30, enemy_memory=memory, camera=(50, 50))
    assert intent["name"] == "harass_camera" and intent["target_tag"] is None and intent["source_tags"] == []
    assert planner.confirm(intent, True, 100.5)
    returning = planner.plan([], [], 101.5, 30, enemy_memory=memory, camera=(100, 100))
    assert returning["position"] == [50, 50]
    assert not planner.blocks_global_army(101.5)


def test_stale_or_disproved_base_is_not_repeatedly_inspected():
    own, _ = scene()
    for record in ({"type": "NEXUS", "position": [100, 100], "last_seen_seconds": 1},
                   {"type": "NEXUS", "position": [100, 100], "last_seen_seconds": 95, "status": "destroyed"}):
        assert CoachHarassment().plan(own, [], 100, 30, enemy_memory=[record], camera=(50, 50)) is None


def test_observed_worker_health_declines_are_not_disappearance_kills_or_causal_claims():
    planner, own, enemies = started()
    enemies[0].health = 30
    planner.plan(own, enemies, 101, 30)
    assert planner.summary()["observed_target_worker_health_decline"] == 15
    planner.plan(own, [], 101.2, 30)
    assert planner.summary()["observed_target_worker_health_decline"] == 15
    assert "no kill inference or causal attribution" in planner.summary()["damage_scope"]


@pytest.mark.parametrize("age,current", [(10, True), (0, False), (-1, True)])
def test_stale_dictionary_observations_are_not_current_targets(age, current):
    own, enemies = scene()
    target = {"tag": 11, "type": "SCV", "position": [56, 50], "last_seen_seconds": 100 - age,
              "current": current, "is_ready": True, "health": 45, "health_max": 45,
              "can_attack_ground": True, "ground_dps": 5, "ground_range": .1}
    assert CoachHarassment().plan(own, [target], 100, 30) is None


def test_plan_does_not_duplicate_unconfirmed_request():
    planner = CoachHarassment()
    intent = planner.plan(*scene(), 100, 30)
    assert intent is not None
    assert planner.plan(*scene(), 100.5, 30) is None


@pytest.mark.parametrize("now,supply", [(float("nan"), 30), (10, -1), (10, float("inf")), (True, 30)])
def test_invalid_time_or_hud_is_rejected(now, supply):
    with pytest.raises(ValueError):
        CoachHarassment().plan(*scene(), now, supply)


def oracle_scene(*, active=False, energy=75):
    oracle = unit(3, U.ORACLE, is_flying=True, health=100, health_max=100,
                  shield=60, shield_max=60, energy=energy, ground_dps=0, ground_range=4,
                  buffs={B.ORACLEWEAPON} if active else set())
    public = {ability.value: {"target": 1, "available": True}
              for ability in (A.BEHAVIOR_PULSARBEAMON, A.BEHAVIOR_PULSARBEAMOFF)}
    abilities = {3: {A.ATTACK, A.BEHAVIOR_PULSARBEAMOFF if active else A.BEHAVIOR_PULSARBEAMON}}
    return [oracle], scene()[1], {"public_abilities": public, "abilities_by_tag": abilities}


def test_adepts_are_preferred_over_other_available_raid_types():
    own, enemies, kwargs = oracle_scene(active=True)
    own += scene()[0] + [unit(4, U.STALKER), unit(5, U.STALKER), unit(6, U.ZEALOT), unit(7, U.ZEALOT)]
    intent = CoachHarassment().plan(own, enemies, 100, 60, completed_upgrades={UpgradeId.BLINKTECH}, **kwargs)
    assert intent["source_tags"] == [1, 2]


def test_stalkers_require_completed_blink_and_are_not_preferred_to_oracle():
    stalkers = [unit(1, U.STALKER, ground_range=6), unit(2, U.STALKER, (51, 50), ground_range=6)]
    enemies = scene()[1]
    assert CoachHarassment().plan(stalkers, enemies, 100, 30) is None
    intent = CoachHarassment().plan(stalkers, enemies, 100, 30, completed_upgrades={"BlinkTech"})
    assert intent["name"] == "harass_workers"
    own, enemies, kwargs = oracle_scene(active=True)
    intent = CoachHarassment().plan([*stalkers, *own], enemies, 100, 30,
                                    completed_upgrades={UpgradeId.BLINKTECH}, **kwargs)
    assert intent["source_tags"] == [3]


def test_zealot_opportunity_must_be_nearby_and_have_no_observed_defender():
    zealots = [unit(1, U.ZEALOT), unit(2, U.ZEALOT, (51, 50))]
    assert CoachHarassment().plan(zealots, scene()[1], 100, 30) is None  # Six tiles away.
    worker = unit(11, U.SCV, (53, 50), own=False)
    assert CoachHarassment().plan(zealots, [worker], 100, 30)["name"] == "harass_workers"
    guard = unit(12, U.MARINE, (57, 50), own=False, health=1, shield=0, ground_dps=1)
    assert CoachHarassment().plan(zealots, [worker, guard], 100, 30) is None


def test_oracle_requires_real_activation_before_any_worker_attack():
    own, enemies, kwargs = oracle_scene()
    planner = CoachHarassment()
    on = planner.plan(own, enemies, 100, 20, **kwargs)
    assert on["name"] == "harass_oracle_beam_on" and on["ability_id"] == 2375
    assert on["target_tag"] is None and on["position"] is None
    assert on["raid_supply"] == 3 and on["army_fraction"] <= .2
    assert planner.confirm(on, True, 100.5)
    assert planner.blocks_global_army(101)
    assert planner.plan(own, enemies, 101, 20, **kwargs) is None  # No observed buff yet.
    own[0].buffs = {B.ORACLEWEAPON}
    kwargs["abilities_by_tag"][3] = {A.ATTACK, A.BEHAVIOR_PULSARBEAMOFF}
    attack = planner.plan(own, enemies, 102, 20, **kwargs)
    assert attack["name"] == "harass_workers" and attack["ability_id"] == 23
    assert planner.confirm(attack, True, 102.5)
    off = planner.plan(own, [], 104, 20, **kwargs)
    assert off["name"] == "harass_oracle_beam_off" and off["ability_id"] == 2376
    assert planner.confirm(off, True, 104.5)
    own[0].buffs = set()
    kwargs["abilities_by_tag"][3] = {A.BEHAVIOR_PULSARBEAMON}
    retreat = planner.plan(own, [], 106, 20, retreat_anchor=(30, 50), **kwargs)
    assert retreat["name"] == "harass_retreat" and retreat["movement_domain"] == "air_over_visible_ground"
    assert retreat["requires_current_visible_ground"] is True and retreat["position"] == [47, 50]


@pytest.mark.parametrize("case", ["energy", "no_off_support", "no_on_ability", "wrong_public_target", "no_public",
                                  "active_without_buff", "active_without_attack"])
def test_oracle_unsupported_or_disabled_weapon_never_autoattacks(case):
    own, enemies, kwargs = oracle_scene(active=case.startswith("active"))
    if case == "energy":
        own[0].energy = 20
    elif case == "no_off_support":
        kwargs["public_abilities"].pop(2376)
    elif case == "no_on_ability":
        kwargs["abilities_by_tag"][3] = {A.ATTACK}
    elif case == "wrong_public_target":
        kwargs["public_abilities"][2375]["target"] = 2
    elif case == "no_public":
        kwargs["public_abilities"] = {}
    elif case == "active_without_buff":
        own[0].buffs = set()
    else:
        kwargs["abilities_by_tag"][3] = {A.BEHAVIOR_PULSARBEAMOFF}
    assert CoachHarassment().plan(own, enemies, 100, 30, **kwargs) is None


@pytest.mark.parametrize("kind", [U.SPORECRAWLER, U.MISSILETURRET, U.PHOTONCANNON, U.MARINE, U.PHOENIX])
def test_oracle_avoids_actual_current_anti_air_including_flying_units(kind):
    own, enemies, kwargs = oracle_scene(active=True)
    enemies.append(unit(20, kind, (57, 50), own=False, can_attack_air=True,
                        air_dps=12, air_range=5, is_flying=kind == U.PHOENIX))
    assert CoachHarassment().plan(own, enemies, 100, 30, **kwargs) is None


def test_ground_only_defense_is_not_misrepresented_as_anti_air():
    own, enemies, kwargs = oracle_scene(active=True)
    enemies.append(unit(20, U.SPINECRAWLER, (57, 50), own=False, is_structure=True, can_attack_air=False))
    assert CoachHarassment().plan(own, enemies, 100, 30, **kwargs)["name"] == "harass_workers"


def test_oracle_urgent_air_retreat_precedes_energy_toggle_and_uses_no_cliff_assumption():
    own, enemies, kwargs = oracle_scene(active=True)
    planner = CoachHarassment()
    attack = planner.plan(own, enemies, 100, 20, **kwargs)
    assert planner.confirm(attack, True, 100.5)
    enemies.append(unit(20, U.MARINE, (54, 50), own=False, can_attack_air=True, air_dps=10, air_range=5))
    retreat = planner.plan(own, enemies, 102, 20, production_due=True, retreat_anchor=(20, 50), **kwargs)
    assert retreat["name"] == "harass_retreat" and retreat["position"] == [47, 50]
    assert retreat["ability_id"] == 16 and retreat["movement_domain"] == "air_over_visible_ground"
    assert planner.confirm(retreat, True, 102.5)
    off = planner.plan(own, enemies, 104, 20, production_due=True, **kwargs)
    assert off["name"] == "harass_oracle_beam_off"


def test_oracle_activation_timeout_does_not_claim_weapon_is_active():
    own, enemies, kwargs = oracle_scene()
    planner = CoachHarassment()
    assert planner.confirm(planner.plan(own, enemies, 100, 20, **kwargs), True, 100.5)
    retreat = planner.plan(own, enemies, 104, 20, retreat_anchor=(40, 50), **kwargs)
    assert retreat["name"] == "harass_retreat" and "not_observed" in retreat["reason"]


def test_public_ability_data_wrappers_and_numeric_buff_ids_are_supported():
    own, enemies, kwargs = oracle_scene(active=True)
    own[0].buffs = {99}
    kwargs["public_abilities"] = {key: SimpleNamespace(_proto=SimpleNamespace(**value))
                                 for key, value in kwargs["public_abilities"].items()}
    assert CoachHarassment().plan(own, enemies, 100, 20, **kwargs)["name"] == "harass_workers"
