"""Oracle-first PvT openings retain their identity after later air units.

Exercise the canonical detector and the agent compatibility entry point,
including the fast-third Oracle/Robo/Twilight AlphaStar variant.
"""

from __future__ import annotations

import os
import sys

import pytest

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from core.strategy_detector_user import UserBuildDetector  # noqa: E402
from detectors.user import UserBuildDetector as AgentUserBuildDetector  # noqa: E402


def building(name, time, subtype="init", **extra):
    return {
        "type": "building", "name": name, "time": time,
        "x": 10.0, "y": 10.0, "subtype": subtype, **extra,
    }


def unit(name, time, **extra):
    return {"type": "unit", "name": name, "time": time, **extra}


def opening():
    return [
        building("Nexus", 0, "born"), building("Pylon", 18),
        building("Gateway", 40), building("Gateway", 86, "born"),
        building("Assimilator", 50), building("CyberneticsCore", 90),
        building("Nexus", 85), building("Nexus", 156, "born"),
        building("Stargate", 150), building("Stargate", 193, "born"),
    ]


def alphastar():
    return opening() + [
        unit("Oracle", 230), building("Gateway", 240),
        building("Nexus", 270), building("RoboticsFacility", 300),
        building("TwilightCouncil", 340),
    ]


@pytest.fixture(params=[UserBuildDetector, AgentUserBuildDetector])
def detector(request):
    return request.param(custom_builds=[])


def classify(detector, events):
    return detector.detect_my_build(
        "vs Terran", events, my_race="Protoss", game_length_seconds=1230,
    )


@pytest.mark.parametrize("later_phoenix", [None, False, True])
def test_oracle_first_with_robo_is_not_a_phoenix_opener(detector, later_phoenix):
    events = opening() + [
        unit("Oracle", 230), building("Gateway", 240),
        building("RoboticsFacility", 280), building("TwilightCouncil", 320),
    ]
    if later_phoenix is not None:
        events.append(unit("Phoenix", 260, hallucinated=later_phoenix))
    assert classify(detector, events) == "PvT - Oracle Opener"


def test_oracle_first_without_robo_remains_oracle_after_later_phoenix(detector):
    events = opening() + [
        unit("Oracle", 230), building("Gateway", 240), unit("Phoenix", 260),
    ]
    assert classify(detector, events) == "PvT - Oracle Opener"


@pytest.mark.parametrize("later_air", ["Phoenix", "VoidRay", "Oracle"])
def test_fast_third_before_robo_then_twilight_is_alphastar(detector, later_air):
    events = alphastar() + [
        unit(later_air, 280), building("Gateway", 286, "born"),
        building("Nexus", 341, "born"), building("Gateway", 380),
        building("Gateway", 400),
        {"type": "upgrade", "name": "Charge", "time": 470},
    ]
    assert classify(detector, events) == "PvT - AlphaStar Style (Oracle/Robo)"


def test_second_gateway_can_start_during_oracle_production(detector):
    events = [
        building("Gateway", 210) if e["name"] == "Gateway" and e["time"] == 240
        else e for e in alphastar()
    ]
    assert classify(detector, events) == "PvT - AlphaStar Style (Oracle/Robo)"


@pytest.mark.parametrize("robo_time,expected", [
    (330, "PvT - AlphaStar Style (Oracle/Robo)"),
    (331, "PvT - Oracle Opener"),
])
def test_alphastar_robo_deadline(detector, robo_time, expected):
    events = [
        building("RoboticsFacility", robo_time) if e["name"] == "RoboticsFacility"
        else e for e in alphastar()
    ]
    assert classify(detector, events) == expected


@pytest.mark.parametrize("changed_name,new_time", [
    ("RoboticsFacility", 239),  # Robo over 30 seconds before third.
    ("Nexus", 331),  # Third over 30 seconds after Robo.
    ("Gateway", 140),  # Second Gateway precedes Stargate.
    ("TwilightCouncil", 481),  # Midgame Twilight is not the opener's follow-up.
])
def test_alphastar_requires_the_opening_sequence(detector, changed_name, new_time):
    events = [
        building(changed_name, new_time)
        if e["name"] == changed_name and e["time"] in (240, 270, 300, 340)
        else e for e in alphastar()
    ]
    assert classify(detector, events) == "PvT - Oracle Opener"


@pytest.mark.parametrize("robo_time", [240, 263, 270, 300])
def test_alphastar_allows_concurrent_robo_and_third_investment(detector, robo_time):
    events = [
        building("RoboticsFacility", robo_time) if e["name"] == "RoboticsFacility"
        else e for e in alphastar()
    ]
    assert classify(detector, events) == "PvT - AlphaStar Style (Oracle/Robo)"


def test_rainfall_oracle_opening_20261014(detector):
    # Tracker start/birth times from the reported 20:30 Rainfall LE replay.
    events = [
        building("Nexus", 0, "born"), building("Gateway", 38),
        building("Nexus", 82), building("Stargate", 143),
        building("Gateway", 219), unit("Oracle", 225), unit("Oracle", 271),
        building("RoboticsFacility", 272), building("Nexus", 279),
        building("TwilightCouncil", 281), building("Gateway", 286),
        building("Gateway", 313), unit("Phoenix", 337),
        building("Gateway", 348), building("Gateway", 386),
        unit("Phoenix", 393), building("Nexus", 438),
    ]
    assert classify(detector, events) == "PvT - AlphaStar Style (Oracle/Robo)"


def test_alphastar_requires_only_two_gateways_before_third(detector):
    assert classify(detector, alphastar() + [building("Gateway", 250)]) == "PvT - Oracle Opener"


def test_alphastar_requires_twilight_follow_up(detector):
    events = [e for e in alphastar() if e["name"] != "TwilightCouncil"]
    assert classify(detector, events) == "PvT - Oracle Opener"


@pytest.mark.parametrize("with_robo,expected", [
    (False, "PvT - Phoenix Opener"), (True, "PvT - Phoenix into Robo"),
])
def test_genuine_phoenix_first_remains_phoenix(detector, with_robo, expected):
    events = opening() + [
        unit("Phoenix", 220), unit("Oracle", 260), building("Gateway", 240),
    ]
    if with_robo:
        events.append(building("RoboticsFacility", 280))
    assert classify(detector, events) == expected


@pytest.mark.parametrize("fake_phoenix", [
    unit("Phoenix", 140),  # No Stargate yet.
    unit("Phoenix", 220, hallucinated=True),  # Explicit illusion after Stargate.
])
def test_hallucinated_phoenix_before_oracle_does_not_set_opener(detector, fake_phoenix):
    events = opening() + [
        fake_phoenix, unit("Oracle", 230), building("Gateway", 240),
        building("RoboticsFacility", 280),
    ]
    assert classify(detector, events) == "PvT - Oracle Opener"


def test_void_ray_first_with_later_phoenix_is_not_phoenix(detector):
    events = opening() + [
        unit("VoidRay", 220), unit("Phoenix", 260), building("Gateway", 240),
        building("RoboticsFacility", 280),
    ]
    assert classify(detector, events) == "PvT - Stargate Opener"


@pytest.mark.parametrize("capital", ["Carrier", "Tempest"])
@pytest.mark.parametrize("later_unit", ["Oracle", "Phoenix"])
def test_capital_first_with_later_harassment_unit_keeps_stargate_label(
    detector, capital, later_unit,
):
    events = opening() + [
        building("FleetBeacon", 180), unit(capital, 300),
        unit(later_unit, 350), building("Gateway", 240),
        building("RoboticsFacility", 380),
    ]
    assert classify(detector, events) == "PvT - Stargate Opener"


@pytest.mark.parametrize("capital", ["Carrier", "Tempest"])
def test_capital_unit_without_required_fleet_beacon_does_not_override_oracle(
    detector, capital,
):
    events = opening() + [unit(capital, 220), unit("Oracle", 230)]
    assert classify(detector, events) == "PvT - Oracle Opener"


def test_simultaneous_oracle_and_phoenix_does_not_invent_a_first_unit(detector):
    events = opening() + [
        unit("Oracle", 230), unit("Phoenix", 230), building("Gateway", 240),
        building("RoboticsFacility", 280),
    ]
    assert classify(detector, events) == "PvT - Stargate Opener"


def test_robo_first_with_later_oracle_stays_robo_first(detector):
    events = opening() + [
        building("RoboticsFacility", 140), unit("Oracle", 230),
        building("Gateway", 240), building("Nexus", 270),
        building("TwilightCouncil", 340),
    ]
    assert classify(detector, events) == "PvT - Robo First"


def test_twilight_first_with_later_oracle_stays_charge_first(detector):
    events = opening() + [
        building("TwilightCouncil", 140), unit("Oracle", 230),
        building("Gateway", 240), building("Nexus", 270),
        building("RoboticsFacility", 300),
        {"type": "upgrade", "name": "Charge", "time": 410},
    ]
    assert classify(detector, events) == "PvT - Charge First (Fast 3rd Nexus)"


def test_twilight_led_transition_keeps_existing_specific_label(detector):
    events = opening() + [
        unit("Oracle", 230), building("Gateway", 240),
        building("TwilightCouncil", 250), building("Nexus", 270),
        building("RoboticsFacility", 300),
        {"type": "upgrade", "name": "BlinkTech", "time": 410},
    ]
    assert classify(detector, events) == "PvT - Stargate into Blink"


def test_flagged_oracle_does_not_classify_as_oracle_opener(detector):
    events = opening() + [unit("Oracle", 230, hallucinated=True)]
    assert classify(detector, events) == "PvT - Stargate Opener"
