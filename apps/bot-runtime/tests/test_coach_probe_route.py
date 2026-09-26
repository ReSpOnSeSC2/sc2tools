import math
from types import SimpleNamespace

import pytest
from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.position import Point2
from sc2.unit import Unit as SC2Unit
from s2clientprotocol import common_pb2 as common, raw_pb2 as raw

from pluto_sc2.coach_probe_route import CoachProbeRoute, _visible


def unit(tag=1, position=(90, 100), kind=U.PROBE, *, own=True, **changes):
    fields = dict(tag=tag, type_id=kind, position=Point2(position), is_mine=own,
        is_on_screen=True, is_visible=True, is_snapshot=False, health=20, health_max=20,
        shield=20, shield_max=20, is_structure=False, can_attack_ground=False,
        ground_range=0, is_attacking=False)
    fields.update(changes)
    return SimpleNamespace(**fields)


def route():
    planner = CoachProbeRoute()
    assert planner.start(1, (20, 20), (100, 100), 0, position=(20, 20))
    return planner


def reserved_order_worker(tag, kind, position, *, own):
    weapon = SimpleNamespace(type=1, damage=5, attacks=1, speed=1, range=.1)
    data = SimpleNamespace(_proto=SimpleNamespace(weapons=[weapon], attributes=[]))
    bot = SimpleNamespace(state=SimpleNamespace(game_loop=1120),
        game_data=SimpleNamespace(abilities={}, units={kind.value: data}))
    return SC2Unit(raw.Unit(tag=tag, unit_type=kind.value, alliance=1 if own else 4,
        display_type=1, is_on_screen=True, build_progress=1, health=20, health_max=20,
        shield=20, shield_max=20, pos=common.Point(x=position[0], y=position[1]),
        orders=[raw.UnitOrder(ability_id=4135)]), bot, base_build=99999)


def test_native_probe_unknown_patch_order_does_not_crash_look_planning():
    planner = route()
    probe = reserved_order_worker(1, U.PROBE, (90, 100), own=True)
    with pytest.raises(KeyError, match="4135"):
        _ = probe.is_attacking
    candidates = planner.candidate_waypoints(probe)
    assert planner.plan(probe, (), 50, safe_points=candidates)["name"] == "probe_scout_look"


def test_native_enemy_scv_unknown_patch_order_is_possible_threat_not_assumed_mining():
    planner = route()
    worker = reserved_order_worker(20, U.SCV, (93, 100), own=False)
    with pytest.raises(KeyError, match="4135"):
        _ = worker.is_attacking
    assert _visible(worker, own=False)["attacking"] is None
    probe = unit()
    intent = planner.plan(probe, [worker], 50, safe_points=planner.candidate_waypoints(probe))
    assert intent["name"] == "probe_scout_evade"
    assert planner.mission["return_reason"] == "visible_enemy_threat"


def planned(planner=None, probe=None, enemies=(), now=50, **kwargs):
    planner = planner or route()
    probe = probe or unit()
    return planner, planner.plan(probe, enemies, now,
        safe_points=planner.candidate_waypoints(probe, enemies, now), **kwargs)


def test_started_only_once_and_no_second_probe_even_after_completion():
    planner = route()
    assert not planner.start(2, (20, 20), (100, 100), 1, position=(20, 20))
    intent = planner.plan(unit(position=(20, 20)), (), 121)
    assert intent["name"] == "probe_scout_release"
    assert planner.confirm(intent, True, 121.5, actual_source_tags=[])
    assert not planner.start(1, (20, 20), (100, 100), 122, position=(20, 20))


@pytest.mark.parametrize("bad", [None, float("nan"), True, -1])
def test_invalid_time_is_rejected(bad):
    with pytest.raises(ValueError):
        CoachProbeRoute().start(1, (1, 1), (2, 2), bad, position=(1, 1))


@pytest.mark.parametrize("tag,home,destination,position", [
    (True, (1, 1), (2, 2), (1, 1)), (0, (1, 1), (2, 2), (1, 1)),
    (1, None, (2, 2), (1, 1)), (1, (1, 1), (float("nan"), 2), (1, 1)),
    (1, (1, 1), (2, 2), None),
])
def test_initial_route_requires_confirmed_origin_and_known_home(tag, home, destination, position):
    with pytest.raises(ValueError):
        CoachProbeRoute().start(tag, home, destination, 0, position=position)


def test_local_inspection_is_single_probe_move_and_current_terrain_only():
    planner, intent = planned()
    assert intent["name"] == "probe_scout_look"
    assert intent["ability_id"] == A.MOVE_MOVE.value and intent["source_tags"] == [1]
    assert intent["target_tag"] is None and not intent["minimap"]
    assert intent["selection_mode"] == "point" and intent["requires_current_visible_ground"]
    assert math.dist(intent["position"], (90, 100)) <= 3.01
    assert planner.mission["looks"] == 0  # Requested input is not a receipt.
    assert planner.confirm(intent, True, 50.5, actual_source_tags=[1])
    assert planner.mission["looks"] == 1


def test_no_local_command_without_filtered_current_visible_terrain():
    assert route().plan(unit(), (), 50) is None


def test_supplied_distant_waypoint_cannot_be_used_as_hidden_route():
    assert route().plan(unit(), (), 50, safe_points=[(200, 200)]) is None


@pytest.mark.parametrize("field,value", [("is_on_screen", False), ("is_visible", False),
    ("is_snapshot", True), ("is_mine", False)])
def test_source_requires_current_owned_screen_observation(field, value):
    planner = route()
    source = unit(**{field: value})
    assert planner.candidate_waypoints(source) == []
    assert planner.plan(source, (), 50, safe_points=[(93, 100)]) is None


@pytest.mark.parametrize("source", [unit(2), unit(kind=U.SCV), unit(kind=U.ZEALOT)])
def test_different_tag_and_nonprobe_cannot_be_selected(source):
    planner = route()
    assert planner.candidate_waypoints(source) == []
    assert planner.plan(source, (), 50, safe_points=[(93, 100)]) is None


def test_hidden_positions_are_never_accessed():
    class Hidden:
        is_on_screen = False

        @property
        def position(self):
            raise AssertionError("Read hidden position")

    planner = route()
    assert planner.candidate_waypoints(Hidden()) == []
    assert planner.plan(Hidden(), [Hidden()], 50) is None
    _, intent = planned(planner, enemies=[Hidden()])
    assert intent["name"] == "probe_scout_look"


def test_waits_for_outbound_arrival_without_altering_original_move():
    planner = route()
    source = unit(position=(40, 40))
    assert planner.plan(source, (), 20, safe_points=planner.candidate_waypoints(source)) is None
    assert planner.mission["status"] == "outbound"


def test_actual_visible_base_can_start_look_before_spawn_location():
    planner = route()
    source = unit(position=(75, 70))
    base = unit(30, (81, 70), U.NEXUS, own=False, is_structure=True)
    _, intent = planned(planner, source, [base], now=40)
    assert intent["name"] == "probe_scout_look"
    assert planner.mission["enemy_types"] == ["NEXUS"]


def test_current_visible_combat_threat_triggers_local_evade_then_home():
    planner = route()
    probe = unit()
    marine = unit(20, (94, 100), U.MARINE, own=False, can_attack_ground=True, ground_range=5)
    _, evade = planned(planner, probe, [marine])
    assert evade["name"] == "probe_scout_evade" and evade["position"][0] < 90
    assert planner.confirm(evade, True, 50.5, actual_source_tags=[1])
    home = planner.plan(unit(position=(87, 100)), (), 53)
    assert home["name"] == "probe_scout_home" and home["minimap"]
    assert home["position"] == [20, 20] and home["ability_id"] == A.MOVE_MOVE.value


def test_mining_worker_at_distance_does_not_end_safe_inspection():
    worker = unit(20, (94, 100), U.SCV, own=False, can_attack_ground=True, ground_range=.1)
    _, intent = planned(enemies=[worker])
    assert intent["name"] == "probe_scout_look"


@pytest.mark.parametrize("attacking,distance", [(True, 3), (False, 1.5)])
def test_attacking_or_contact_worker_triggers_return(attacking, distance):
    worker = unit(20, (90 + distance, 100), U.SCV, own=False,
        can_attack_ground=True, ground_range=.1, is_attacking=attacking)
    planner, intent = planned(enemies=[worker])
    assert planner.mission["return_reason"] == "visible_enemy_threat"
    assert intent["name"] == "probe_scout_evade"


def test_damage_observation_ends_scouting_without_guessing_attacker():
    planner = route()
    assert planner.plan(unit(), (), 50) is None
    home = planner.plan(unit(shield=15), (), 51)
    assert home["name"] == "probe_scout_home" and home["reason"] == "observed_probe_damage"


def test_defense_request_returns_same_probe_immediately():
    planner, intent = planned(retreat=True)
    assert intent["name"] == "probe_scout_home"
    assert planner.mission["return_reason"] == "defense_requested_return"


def test_35_second_inspection_limit_returns_home():
    planner = route()
    assert planner.plan(unit(), (), 50) is None
    home = planner.plan(unit(), (), 85)
    assert home["name"] == "probe_scout_home" and home["reason"] == "bounded_base_inspection_complete"


def test_six_confirmed_different_looks_return_home():
    planner = route()
    probe = unit()
    targets = []
    for i in range(6):
        now = 50 + i * 3
        _, intent = planned(planner, probe, now=now)
        assert intent["name"] == "probe_scout_look"
        targets.append(tuple(intent["position"]))
        assert planner.confirm(intent, True, now + .5, actual_source_tags=[1])
        probe = unit(position=intent["position"])
    assert len(set(targets)) == 6
    assert planner.plan(probe, (), 68)["name"] == "probe_scout_home"


def test_failed_and_wrong_source_receipts_do_not_advance_inspection():
    planner, intent = planned()
    assert not planner.confirm(intent, True, 50.5, actual_source_tags=[2])
    assert planner.mission["looks"] == 0
    assert planner.plan(unit(), (), 51, safe_points=[(93, 100)]) is None
    _, intent = planned(planner, now=53)
    assert not planner.confirm(intent, False, 53.5, actual_source_tags=[])
    assert planner.mission["looks"] == 0


def test_pending_command_is_not_duplicated_or_overridden():
    planner, intent = planned()
    assert planner.plan(unit(), (), 50.5, safe_points=[(93, 100)], retreat=True) is None
    assert planner.pending["id"] == intent["id"]


def test_expired_confirmation_does_not_claim_look():
    planner, intent = planned()
    assert not planner.confirm(intent, True, 53, actual_source_tags=[1])
    assert planner.mission["looks"] == 0


def test_no_new_look_until_observed_arrival_or_bounded_stall_timeout():
    planner, intent = planned()
    assert planner.confirm(intent, True, 50.5, actual_source_tags=[1])
    assert planner.plan(unit(), (), 54, safe_points=[(93, 100)]) is None
    assert planner.plan(unit(), (), 59, safe_points=[(93, 100)])["name"] == "probe_scout_look"


def test_trip_120_second_deadline_returns_even_without_reaching_enemy():
    planner = route()
    intent = planner.plan(unit(position=(50, 50)), (), 120)
    assert intent["name"] == "probe_scout_home" and intent["reason"] == "trip_time_limit"


def test_observed_home_arrival_releases_and_requests_real_mining():
    planner = route()
    home = planner.plan(unit(), (), 120)
    assert planner.confirm(home, True, 120.5, actual_source_tags=[1])
    intent = planner.plan(unit(position=(22, 22)), (), 125)
    assert intent["kind"] == "release" and intent["resume_mining"] and intent["observed_home"]
    assert planner.confirm(intent, True, 125, actual_source_tags=[])
    assert planner.protected_tags(125) == {}
    assert planner.designated_tag == 1
    assert planner.plan(unit(), (), 126) is None


def test_home_move_is_not_repeated_every_input():
    planner = route()
    home = planner.plan(unit(), (), 120)
    assert planner.confirm(home, True, 120.5, actual_source_tags=[1])
    assert planner.plan(unit(), (), 123) is None
    assert planner.plan(unit(), (), 129)["name"] == "probe_scout_home"


def test_offscreen_expiry_is_not_a_death_or_home_claim():
    planner = route()
    assert planner.plan(None, (), 120, camera=(50, 50)) is None
    finish = planner.plan(None, (), 135, camera=(50, 50))
    assert finish["reason"] == "unobserved_trip_expired"
    assert not finish["resume_mining"] and not finish["observed_home"]
    assert planner.confirm(finish, True, 135, actual_source_tags=[])
    assert planner.mission["status"] == "finished"
    assert planner.protected_tags(135) == {}


def test_only_recent_actual_probe_position_can_request_bounded_camera():
    planner = route()
    assert planner.plan(unit(), (), 118) is None
    camera = planner.plan(None, (), 120, camera=(20, 20))
    assert camera["name"] == "probe_scout_camera" and camera["position"] == [90, 100]
    assert planner.confirm(camera, True, 120.5, actual_source_tags=[])
    assert planner.plan(None, (), 121, camera=(20, 20)) is None
    assert planner.plan(None, (), 130, camera=(20, 20)) is None  # Stale own position.


def test_protection_deadline_bounded_without_authorizing_replacement_probe():
    planner = route()
    assert planner.protected_tags(50) == {1: 135}
    assert planner.protected_tags(135) == {}
    assert planner.designated_tag == 1


def test_backward_clock_rejected():
    planner = route()
    planner.plan(unit(), (), 50)
    with pytest.raises(ValueError):
        planner.plan(unit(), (), 49)
