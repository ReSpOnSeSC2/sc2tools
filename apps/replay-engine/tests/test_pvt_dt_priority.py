"""An observed early DT opening must beat its later Charge/Blink follow-up."""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from core.build_definitions import BUILD_DEFINITIONS, PRESET_SURFACES
from core.strategy_detector_opponent import OpponentStrategyDetector
from core.strategy_detector_user import UserBuildDetector
from detectors.user import UserBuildDetector as AgentUserDetector

PARITY = json.loads((Path(__file__).parent / "fixtures/pvt_dt_priority.json").read_text())


def building(name, time, x=10, y=10):
    return {"type": "building", "name": name, "time": time, "x": x, "y": y, "subtype": "init"}


def unit(name, time, **flags):
    return {"type": "unit", "name": name, "time": time, **flags}


def opening(shrine=197, dt=273):
    # Synthetic reproduction of the reported proxy-Shrine/DT -> Charge +
    # fast-third pattern, not a claim to contain the unavailable raw replay.
    # All times below are recorded engine clocks, not display-row rewinds.
    events = [copy.deepcopy(event) for event in PARITY["events"] if event["name"] not in ("DarkShrine", "DarkTemplar")]
    if shrine is not None:
        events.append(building("DarkShrine", shrine, 120, 120))
    if dt is not None:
        events.append(unit("DarkTemplar", dt))
    return events


@pytest.fixture(params=[UserBuildDetector, AgentUserDetector], ids=["canonical", "agent-bridge"])
def classify(request):
    return lambda events: request.param(custom_builds=[]).detect_my_build(
        "vs Terran", events, my_race="Protoss", game_length_seconds=900,
    )


@pytest.mark.parametrize("upgrade", ["Charge", "BlinkTech"])
@pytest.mark.parametrize("third", [270, 380])
def test_real_ground_dt_opening_wins_over_later_upgrade_and_third(classify, upgrade, third):
    events = opening()
    next(event for event in events if event["type"] == "upgrade")["name"] = upgrade
    [event for event in events if event["name"] == "Nexus"][2]["time"] = third
    assert classify(events) == "PvT - DT Rush"


def test_real_drop_keeps_its_more_specific_priority(classify):
    events = opening() + [building("RoboticsFacility", 212), unit("WarpPrism", 251)]
    assert classify(events) == "PvT - DT Drop"


@pytest.mark.parametrize("prism", [None, 315.01, 351])
def test_missing_or_late_transport_does_not_turn_a_ground_rush_into_a_drop(classify, prism):
    events = opening() + [building("RoboticsFacility", 212)]
    if prism is not None:
        events.append(unit("WarpPrism", prism))
    assert classify(events) == "PvT - DT Rush"


def test_hallucinated_or_prerequisite_missing_prism_is_not_drop_proof(classify):
    assert classify(opening() + [building("RoboticsFacility", 212), unit("WarpPrism", 251, hallucinated=True)]) == "PvT - DT Rush"
    assert classify(opening() + [unit("WarpPrism", 251)]) == "PvT - DT Rush"


@pytest.mark.parametrize("shrine,dt", [(300, 360), (299.99, 359.99)])
def test_rush_boundary_uses_recorded_shrine_start_and_real_unit_appearance(classify, shrine, dt):
    assert classify(opening(shrine, dt)) == "PvT - DT Rush"


@pytest.mark.parametrize("shrine,dt", [(300.01, 360), (450, 530), (None, 273)])
def test_late_shrine_transition_or_missing_tech_keeps_charge(classify, shrine, dt):
    assert classify(opening(shrine, dt)) == "PvT - Charge First (Fast 3rd Nexus)"


@pytest.mark.parametrize("dt", [None, 360.01, 530])
def test_early_shrine_without_a_real_rush_is_not_invented_as_charge_or_dt(classify, dt):
    assert classify(opening(dt=dt)) == "PvT - Macro Transition (Unclassified)"


def test_hallucinated_dt_does_not_manufacture_a_rush_or_erase_early_shrine(classify):
    events = opening()
    next(event for event in events if event["name"] == "DarkTemplar")["hallucinated"] = True
    assert classify(events) == "PvT - Macro Transition (Unclassified)"


@pytest.mark.parametrize("gates,third", [(3, None), (7, None), (2, 270), (2, 380)])
@pytest.mark.parametrize("real_dt", [False, True])
def test_early_shrine_cannot_be_stolen_by_any_twilight_charge_variant(classify, gates, third, real_dt):
    events = opening(dt=273 if real_dt else None)
    events = [event for event in events if not (event["name"] == "Nexus" and event["time"] == 270)]
    if third is not None:
        events.append(building("Nexus", third, 70))
    events += [building("Gateway", 200 + index * 5) for index in range(gates - 2)]
    assert classify(events) == ("PvT - DT Rush" if real_dt else "PvT - Macro Transition (Unclassified)")


@pytest.mark.parametrize("first_tech,expected", [("RoboticsFacility", "PvT - Robo First"), ("Stargate", "PvT - Stargate into Charge")])
def test_existing_robo_and_stargate_openers_keep_their_semantics(classify, first_tech, expected):
    assert classify(opening() + [building(first_tech, 140)]) == expected


def test_shrine_cannot_precede_its_twilight_path(classify):
    assert classify(opening(130)) == "PvT - Charge First (Fast 3rd Nexus)"


def test_personal_catalog_and_opponent_taxonomy_are_distinct():
    assert "PvT - DT Rush" in BUILD_DEFINITIONS
    assert PRESET_SURFACES["PvT - DT Rush"] == ["you"]
    assert PRESET_SURFACES["Protoss - DT Rush"] == ["opponent"]
    assert OpponentStrategyDetector(custom_builds=[]).get_strategy_name(
        "Protoss", copy.deepcopy(opening()), my_race="Terran", game_length_seconds=900,
    ) == "Protoss - DT Rush"


@pytest.mark.parametrize("case", PARITY["cases"], ids=lambda case: case["id"])
def test_shared_browser_matrix_matches_native_bridge(classify, case):
    events = copy.deepcopy(PARITY["events"]) + copy.deepcopy(case.get("append", []))
    events = [event for event in events if event["name"] not in case.get("remove", [])]
    for event in events:
        event["time"] = case.get("times", {}).get(event["name"], event["time"])
        if event["name"] == case.get("hallucinated"):
            event["hallucinated"] = True
    assert classify(events) == case["expected"]


def test_private_custom_rules_and_active_global_policy_keep_precedence():
    from core.preset_policy import validate_policy
    custom = [{"name": "Private DT plan", "race": "Protoss", "vs_race": "Terran",
               "rules": [{"type": "building", "name": "DarkShrine", "time_lt": 300}]}]
    policy = validate_policy({"schemaVersion": 1, "evaluatorVersion": 1, "revision": 1, "entries": [
        {"name": "PvT - DT Rush", "enabled": False, "priority": 0, "anyOf": []},
    ]}, verify_hash=False)
    assert UserBuildDetector(custom, preset_policy=policy).detect_my_build("vs Terran", opening()) == "Private DT plan"
    assert UserBuildDetector([], preset_policy=policy).detect_my_build("vs Terran", opening()) == "Unclassified - Protoss"
