"""An established air opening survives later Fleet Beacon tech switches."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core.strategy_detector_user import UserBuildDetector
from detectors.user import UserBuildDetector as ImporterUserBuildDetector


def building(name, time, subtype="init"):
    return {"type": "building", "name": name, "time": time,
            "subtype": subtype, "x": 0, "y": 0}


def unit(name, time, **extra):
    return {"type": "unit", "name": name, "time": time, **extra}


def opening():
    return [building("Nexus", 0, "born"), building("Gateway", 38),
            building("Nexus", 83), building("CyberneticsCore", 93),
            unit("Adept", 133), building("Stargate", 143)]


@pytest.fixture(params=[UserBuildDetector, ImporterUserBuildDetector])
def detector(request):
    return request.param(custom_builds=[])


@pytest.mark.parametrize("capital", ["Carrier", "Tempest"])
@pytest.mark.parametrize("support_robo", [None, 450])
def test_void_ray_opening_survives_capital_transition(detector, capital, support_robo):
    events = opening() + [building("Stargate", 223)]
    events += [unit("VoidRay", t) for t in (290, 335, 380, 425)]
    events += [building("FleetBeacon", 500), unit(capital, 580)]
    if support_robo is not None:
        events.append(building("RoboticsFacility", support_robo))
    assert detector.detect_my_build("vs Zerg", events) == "PvZ - 2 Stargate Void Ray"


@pytest.mark.parametrize("capital", ["Carrier", "Tempest"])
@pytest.mark.parametrize("stargates", [2, 3])
def test_phoenix_opening_survives_capital_transition(detector, capital, stargates):
    events = opening() + [building("Stargate", 223)]
    if stargates == 3:
        events.append(building("Stargate", 260))
    events += [unit("Phoenix", t) for t in (290, 315, 340, 365)]
    events += [building("FleetBeacon", 500), unit(capital, 580)]
    assert detector.detect_my_build("vs Zerg", events) == f"PvZ - {stargates} Stargate Phoenix"


def test_stargate_added_after_capital_ship_does_not_inflate_phoenix_opener(detector):
    events = opening() + [building("Stargate", 223)]
    events += [unit("Phoenix", t) for t in (290, 315, 340, 365)]
    events += [building("FleetBeacon", 400), unit("Carrier", 500), building("Stargate", 550)]
    assert detector.detect_my_build("vs Zerg", events) == "PvZ - 2 Stargate Phoenix"


@pytest.mark.parametrize("capital", ["Carrier", "Tempest"])
def test_capital_rush_is_not_stolen_by_later_void_rays(detector, capital):
    events = opening() + [building("Stargate", 223), building("FleetBeacon", 260),
                          unit(capital, 400)]
    events += [unit("VoidRay", t) for t in (420, 450, 480, 510)]
    assert detector.detect_my_build("vs Zerg", events) == f"PvZ - {capital} Rush"


@pytest.mark.parametrize("first,second", [("Carrier", "Tempest"), ("Tempest", "Carrier")])
def test_first_real_capital_unit_decides_rush(detector, first, second):
    events = opening() + [building("FleetBeacon", 260), unit(second, 550), unit(first, 400)]
    assert detector.detect_my_build("vs Zerg", events) == f"PvZ - {first} Rush"


def test_hallucinated_capital_unit_cannot_decide_rush(detector):
    events = opening() + [unit("Carrier", 200), building("FleetBeacon", 260),
                          unit("Carrier", 350, hallucinated=True), unit("Tempest", 400)]
    assert detector.detect_my_build("vs Zerg", events) == "PvZ - Tempest Rush"


def test_single_support_void_ray_keeps_carrier_rush(detector):
    events = opening() + [unit("VoidRay", 220), building("FleetBeacon", 260), unit("Carrier", 400)]
    assert detector.detect_my_build("vs Zerg", events) == "PvZ - Carrier Rush"


def test_reported_replay_void_rays_finish_during_beacon_construction(detector):
    events = opening() + [building("Stargate", 266)]
    events += [unit("VoidRay", t) for t in (238, 327, 351, 370, 386, 421)]
    events += [unit("Oracle", 267), building("FleetBeacon", 364),
               unit("Tempest", 441), unit("Tempest", 486),
               building("TwilightCouncil", 523), building("RoboticsFacility", 525),
               unit("Carrier", 553), unit("Carrier", 564)]
    assert detector.detect_my_build("vs Zerg", events) == "PvZ - 2 Stargate Void Ray"


def test_air_and_capital_in_same_recorded_second_preserve_opening(detector):
    events = opening() + [building("Stargate", 223), building("FleetBeacon", 260)]
    events += [unit("VoidRay", t) for t in (290, 315, 340, 400)]
    events += [unit("Carrier", 400)]
    assert detector.detect_my_build("vs Zerg", events) == "PvZ - 2 Stargate Void Ray"


@pytest.mark.parametrize("capital", ["Carrier", "Tempest"])
def test_robo_transition_is_not_relabelled_as_capital_rush(detector, capital):
    events = opening() + [unit("Oracle", 220), building("RoboticsFacility", 300),
                          building("FleetBeacon", 450), unit(capital, 580)]
    assert detector.detect_my_build("vs Zerg", events) == "PvZ - Stargate into Robo"


def test_glaives_transition_is_not_relabelled_as_carrier_rush(detector):
    events = opening() + [unit("Oracle", 220), building("TwilightCouncil", 300),
                          {"type": "upgrade", "name": "AdeptPiercingAttack", "time": 410},
                          building("FleetBeacon", 450), unit("Carrier", 580)]
    assert detector.detect_my_build("vs Zerg", events) == "PvZ - Stargate into Glaives"


@pytest.mark.parametrize("capital_time,expected", [(600, "PvZ - Carrier Rush"),
                                                  (601, "PvZ - Stargate Opener")])
def test_capital_rush_unit_deadline(detector, capital_time, expected):
    events = opening() + [building("FleetBeacon", 260), unit("Carrier", capital_time)]
    assert detector.detect_my_build("vs Zerg", events) == expected
