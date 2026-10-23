"""Archon drops require a real transport completed by six minutes.

These are raw extractor/build-log appearance timestamps, not the API's
construction-start display timestamps. Both agent compatibility imports and
personal/opponent perspectives stay covered without changing generic labels.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from core.strategy_detector_opponent import OpponentStrategyDetector
from core.strategy_detector_user import UserBuildDetector
from detectors.opponent import OpponentStrategyDetector as AgentOpponentDetector
from detectors.user import UserBuildDetector as AgentUserDetector

PARITY = json.loads((Path(__file__).parent / "fixtures" / "archon_drop_parity.json").read_text())


def _u(name, time):
    return {"type": "unit", "name": name, "time": time, "x": 10, "y": 10}


def opening(kind, prism=360, archons=None):
    base = PARITY["openings"][kind]
    events = copy.deepcopy(base["events"])
    count = base["archons"] if archons is None else archons
    events += [_u("Archon", 430 + index * 20) for index in range(count)]
    if prism is not None:
        events.append(_u("WarpPrism", prism))
    return events


def classify(detector, events):
    return detector(custom_builds=[]).detect_my_build(
        "vs Zerg", events, my_race="Protoss", game_length_seconds=900,
    )


@pytest.fixture(params=[UserBuildDetector, AgentUserDetector], ids=["canonical", "agent"])
def detector(request):
    return request.param


@pytest.mark.parametrize("kind,expected", [("stargate", "PvZ - Archon Drop"), ("dt", "PvZ - DT drop into Archon Drop")])
@pytest.mark.parametrize("completion", [330, 359.99, 360])
def test_real_early_transport_and_archons_preserve_both_drop_openings(detector, kind, expected, completion):
    assert classify(detector, opening(kind, completion)) == expected


@pytest.mark.parametrize("kind", ["stargate", "dt"])
@pytest.mark.parametrize("completion", [None, 360.01, 390, 539, 600])
def test_missing_or_late_prism_never_counts_as_an_archon_drop(detector, kind, completion):
    # A 6:30 completion has a pre-6:00 training-start display row. That is
    # still late: the recorded raw appearance/completion time is the gate.
    assert "Archon Drop" not in classify(detector, opening(kind, completion))


@pytest.mark.parametrize("kind", ["stargate", "dt"])
def test_dark_templar_or_templar_tech_without_a_real_archon_is_not_an_archon_drop(detector, kind):
    assert "Archon Drop" not in classify(detector, opening(kind, archons=0))


def test_stargate_drop_still_requires_two_real_archons(detector):
    assert "Archon Drop" not in classify(detector, opening("stargate", archons=1))


@pytest.mark.parametrize("kind", ["stargate", "dt"])
@pytest.mark.parametrize("illusion", ["WarpPrism", "Archon"])
def test_hallucinated_transport_or_archons_do_not_supply_drop_proof(detector, kind, illusion):
    events = opening(kind)
    for row in events:
        if row["name"] == illusion:
            row["hallucinated"] = True
    assert "Archon Drop" not in classify(detector, events)


@pytest.mark.parametrize("kind,missing", [("stargate", "TemplarArchive"), ("dt", "DarkShrine"),
                                          ("stargate", "RoboticsFacility"), ("dt", "RoboticsFacility")])
def test_illusory_unit_rows_without_real_prerequisite_tech_do_not_match(detector, kind, missing):
    assert "Archon Drop" not in classify(detector, [row for row in opening(kind) if row["name"] != missing])


def test_robo_first_game_is_not_a_stargate_archon_drop(detector):
    events = opening("stargate")
    next(row for row in events if row["name"] == "RoboticsFacility")["time"] = 140
    assert classify(detector, events) != "PvZ - Archon Drop"


@pytest.mark.parametrize("opponent", [OpponentStrategyDetector, AgentOpponentDetector], ids=["canonical", "agent"])
@pytest.mark.parametrize("kind,expected", [("stargate", "Protoss - Stargate Opener"), ("dt", "Protoss - DT Rush")])
@pytest.mark.parametrize("completion", [None, 360, 390])
def test_existing_opponent_taxonomy_is_stable_and_agent_matches_canonical(opponent, kind, expected, completion):
    assert opponent(custom_builds=[]).get_strategy_name(
        "Protoss", opening(kind, completion), matchup="vs Protoss", my_race="Zerg", game_length_seconds=900,
    ) == expected


@pytest.mark.parametrize("kind", PARITY["openings"])
@pytest.mark.parametrize("case", PARITY["cases"], ids=lambda case: case["id"])
def test_shared_browser_matrix_matches_canonical_and_agent(detector, kind, case):
    events = opening(kind, case["prism"], case.get("archons"))
    for event in events:
        if event["name"] == case.get("hallucinated"):
            event["hallucinated"] = True
    actual = classify(detector, events)
    if case["matches"]:
        assert actual == PARITY["openings"][kind]["personal"]
    else:
        assert "Archon Drop" not in actual
