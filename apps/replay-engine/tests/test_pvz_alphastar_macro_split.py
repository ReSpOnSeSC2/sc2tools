"""Regression coverage for the four Stargate-first three-base PvZ paths.

AlphaStar is distinguished by a Robotics Facility started after the third
Nexus and no later than 5:30.  Without that fast Robo, a three-base path's
first Twilight upgrade decides Blink, Charge, or Resonating Glaives instead.
Both public detector entry points are exercised because the agent imports the
mirror.
"""

import os
import sys
from typing import Any, Dict, Iterable, List
from unittest.mock import MagicMock

import pytest

sys.modules.setdefault("sc2reader", MagicMock())
sys.modules.setdefault("sc2reader.events", MagicMock())
sys.modules.setdefault("sc2reader.events.tracker", MagicMock())
sys.modules.setdefault("sc2reader.events.game", MagicMock())

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from core.strategy_detector_user import (  # noqa: E402
    UserBuildDetector as CanonicalUserBuildDetector,
)
from detectors.user import (  # noqa: E402
    UserBuildDetector as MirrorUserBuildDetector,
)


def _building(name: str, time: int) -> Dict[str, Any]:
    return {
        "type": "building",
        "name": name,
        "time": time,
        "x": 0.0,
        "y": 0.0,
        "subtype": "init",
    }


def _unit(name: str, time: int) -> Dict[str, Any]:
    return {"type": "unit", "name": name, "time": time, "x": 0.0, "y": 0.0}


def _upgrade(name: str, time: int) -> Dict[str, Any]:
    return {"type": "upgrade", "name": name, "time": time}


def _stargate_three_base_opening() -> List[Dict[str, Any]]:
    return [
        _building("Nexus", 0),
        _building("Pylon", 18),
        _building("Gateway", 60),
        _building("Assimilator", 75),
        _building("CyberneticsCore", 100),
        _building("Nexus", 140),
        _building("Stargate", 180),
        _unit("Oracle", 220),
        _building("Nexus", 250),
        _unit("Oracle", 280),
    ]


def _detectors() -> Iterable[Any]:
    return (
        CanonicalUserBuildDetector(custom_builds=[]),
        MirrorUserBuildDetector(custom_builds=[]),
    )


def _assert_detects(events: List[Dict[str, Any]], expected: str) -> None:
    for detector in _detectors():
        result = detector.detect_my_build("vs Zerg", events, my_race="Protoss")
        assert result == expected, result


def test_alphastar_requires_third_then_robo_by_530_inclusive():
    events = _stargate_three_base_opening() + [
        _building("RoboticsFacility", 330),
        _building("Forge", 360),
    ]

    _assert_detects(events, "PvZ - AlphaStar Style (Oracle/Robo)")


def test_robo_one_second_after_530_is_blink_macro_not_alphastar():
    events = _stargate_three_base_opening() + [
        _building("TwilightCouncil", 300),
        _building("RoboticsFacility", 331),
        _building("Forge", 350),
        _upgrade("BlinkTech", 390),
    ]

    _assert_detects(events, "PvZ - Standard Blink Macro")


def test_no_robo_with_charge_first_is_standard_charge_macro():
    events = _stargate_three_base_opening() + [
        _building("TwilightCouncil", 300),
        _building("Forge", 340),
        _upgrade("Charge", 390),
        _upgrade("BlinkTech", 450),
    ]

    _assert_detects(events, "PvZ - Standard charge Macro")


def test_no_robo_with_blink_first_stays_blink_when_charge_is_added_later():
    events = _stargate_three_base_opening() + [
        _building("TwilightCouncil", 300),
        _building("Forge", 340),
        _upgrade("BlinkTech", 390),
        _upgrade("Charge", 450),
    ]

    _assert_detects(events, "PvZ - Standard Blink Macro")


@pytest.mark.parametrize(
    ("third_nexus_time", "expected"),
    [
        (490, "PvZ - Standard Blink Macro"),
        (491, "PvZ - Stargate Opener"),
    ],
)
def test_twilight_first_requires_third_within_four_minutes(
    third_nexus_time,
    expected,
):
    events = [
        event.copy() if event.get("name") != "Nexus" or event["time"] != 250
        else _building("Nexus", third_nexus_time)
        for event in _stargate_three_base_opening()
    ] + [
        _building("TwilightCouncil", 250),
        _building("Forge", 360),
        _upgrade("BlinkTech", 420),
    ]

    _assert_detects(events, expected)


@pytest.mark.parametrize("robo_time", [None, 420])
def test_resonating_glaives_first_uses_existing_glaives_build(robo_time):
    events = _stargate_three_base_opening() + [
        _building("TwilightCouncil", 300),
        _building("Forge", 340),
        _upgrade("AdeptPiercingAttack", 390),
        _upgrade("BlinkTech", 450),
    ]
    if robo_time is not None:
        events.append(_building("RoboticsFacility", robo_time))

    _assert_detects(events, "PvZ - Stargate into Glaives")


def test_robo_before_third_is_not_alphastar_even_at_fast_timing():
    events = _stargate_three_base_opening() + [
        _building("RoboticsFacility", 240),
        _building("Forge", 300),
    ]

    _assert_detects(events, "PvZ - Stargate into Robo")


def test_third_before_stargate_is_not_alphastar():
    events = [
        event.copy() if event.get("name") != "Nexus" or event["time"] != 250
        else _building("Nexus", 150)
        for event in _stargate_three_base_opening()
    ] + [
        _building("RoboticsFacility", 300),
        _building("Forge", 320),
    ]

    _assert_detects(events, "PvZ - Stargate into Robo")


@pytest.mark.parametrize("upgrade_name", ["BlinkTech", "Charge"])
def test_standard_macro_requires_stargate_before_third(upgrade_name):
    events = [
        event.copy() if event.get("name") != "Nexus" or event["time"] != 250
        else _building("Nexus", 150)
        for event in _stargate_three_base_opening()
    ] + [
        _building("TwilightCouncil", 300),
        _upgrade(upgrade_name, 390),
    ]

    _assert_detects(events, "PvZ - Stargate Opener")


def test_fast_robo_before_twilight_remains_alphastar_after_later_glaives():
    events = _stargate_three_base_opening() + [
        _building("RoboticsFacility", 300),
        _building("Forge", 320),
        _building("TwilightCouncil", 340),
        _upgrade("AdeptPiercingAttack", 400),
    ]

    _assert_detects(events, "PvZ - AlphaStar Style (Oracle/Robo)")


def test_twilight_glaives_before_fast_robo_uses_glaives_build():
    events = _stargate_three_base_opening() + [
        _building("TwilightCouncil", 270),
        _building("RoboticsFacility", 300),
        _building("Forge", 320),
        _upgrade("AdeptPiercingAttack", 400),
    ]

    _assert_detects(events, "PvZ - Stargate into Glaives")


def test_robo_before_twilight_without_full_alphastar_signal_is_robo_transition():
    events = [
        event for event in _stargate_three_base_opening()
        if not (event.get("name") == "Oracle" and event["time"] == 280)
    ] + [
        _building("RoboticsFacility", 300),
        _building("TwilightCouncil", 340),
        _upgrade("AdeptPiercingAttack", 400),
    ]

    _assert_detects(events, "PvZ - Stargate into Robo")


def test_robo_first_replay_is_not_stargate_into_glaives():
    events = [
        _building("Nexus", 0),
        _building("Gateway", 60),
        _building("CyberneticsCore", 100),
        _building("Nexus", 140),
        _building("RoboticsFacility", 170),
        _building("Stargate", 220),
        _unit("Oracle", 270),
        _building("TwilightCouncil", 300),
        _upgrade("AdeptPiercingAttack", 390),
    ]

    _assert_detects(events, "PvZ - Robo Opener")
