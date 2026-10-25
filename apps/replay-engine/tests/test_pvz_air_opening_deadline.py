"""Released two-Stargate Void Ray and two/three-Stargate Phoenix deadlines."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core.strategy_detector_user import UserBuildDetector
from detectors.user import UserBuildDetector as ImporterUserDetector


def building(name, time):
    return {"type": "building", "name": name, "time": time,
            "subtype": "init", "x": 0, "y": 0}


def unit(name, time):
    return {"type": "unit", "name": name, "time": time}


@pytest.fixture(params=[UserBuildDetector, ImporterUserDetector])
def classify(request):
    detector = request.param(custom_builds=[])
    return lambda events: detector.detect_my_build("vs Zerg", events)


def opening(second_stargate=230, second_nexus=83, fourth_void_ray=420):
    return [building("Nexus", 0), building("Gateway", 38),
            building("Nexus", second_nexus), building("CyberneticsCore", 93),
            building("Stargate", 143), building("Stargate", second_stargate),
            *[unit("VoidRay", time) for time in (290, 335, 380, fourth_void_ray)]]


@pytest.mark.parametrize("requirement", ["second_stargate", "second_nexus", "fourth_void_ray"])
@pytest.mark.parametrize("deadline", [419, 420, 420.01, 421, 600])
def test_each_void_ray_requirement_must_exist_by_seven_minutes(classify, requirement, deadline):
    events = opening(**{requirement: deadline})
    expected = "PvZ - 2 Stargate Void Ray" if deadline <= 420 else "PvZ - Stargate Opener"
    assert classify(events) == expected


@pytest.mark.parametrize("capital", ["Carrier", "Tempest"])
def test_late_fourth_void_ray_does_not_mask_capital_rush(classify, capital):
    events = opening(fourth_void_ray=421)
    events += [building("FleetBeacon", 400), unit(capital, 500)]
    assert classify(events) == f"PvZ - {capital} Rush"


@pytest.mark.parametrize("stargates", [2, 3])
@pytest.mark.parametrize("fourth_phoenix", [419, 420, 420.01, 421, 600, 601])
def test_phoenix_must_be_established_by_seven_minutes(classify, stargates, fourth_phoenix):
    events = [event for event in opening() if event["type"] != "unit"]
    if stargates == 3:
        events.append(building("Stargate", 260))
    events += [unit("Phoenix", time) for time in (290, 335, 380, fourth_phoenix)]
    expected = f"PvZ - {stargates} Stargate Phoenix" if fourth_phoenix <= 420 else "PvZ - Stargate Opener"
    assert classify(events) == expected


@pytest.mark.parametrize("requirement", ["second_stargate", "second_nexus"])
@pytest.mark.parametrize("deadline", [419, 420, 420.01, 421])
def test_phoenix_building_requirements_share_seven_minute_deadline(classify, requirement, deadline):
    events = opening(**{requirement: deadline})
    events = [{**event, "name": "Phoenix"} if event["type"] == "unit" else event
              for event in events]
    expected = "PvZ - 2 Stargate Phoenix" if deadline <= 420 else "PvZ - Stargate Opener"
    assert classify(events) == expected


@pytest.mark.parametrize("third_stargate,expected_count", [(419, 3), (420, 3), (420.01, 2), (421, 2)])
def test_third_stargate_after_deadline_does_not_inflate_phoenix_opener(classify, third_stargate, expected_count):
    events = [{**event, "name": "Phoenix"} if event["type"] == "unit" else event
              for event in opening()]
    events.append(building("Stargate", third_stargate))
    assert classify(events) == f"PvZ - {expected_count} Stargate Phoenix"


@pytest.mark.parametrize("capital", ["Carrier", "Tempest"])
def test_late_fourth_phoenix_does_not_mask_capital_rush(classify, capital):
    events = [{**event, "name": "Phoenix"} if event["type"] == "unit" else event
              for event in opening(fourth_void_ray=421)]
    events += [building("FleetBeacon", 400), unit(capital, 500)]
    assert classify(events) == f"PvZ - {capital} Rush"
