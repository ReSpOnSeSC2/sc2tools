"""Desktop half of the custom-rule parity contract.

A v3 custom build is saved once (by the website's build editor) and
evaluated twice: here, by ``BaseStrategyDetector.check_custom_rules``
against the replay's own events, and in the cloud, by
``apps/api/src/services/buildRulesEvaluator.js`` against the uploaded
build log and the agent's proxy stamp. The two must agree, so both
suites read the same cases from ``fixtures/custom_rule_parity.json``:

  * this file feeds each case's ``events`` to ``check_custom_rules``;
  * ``apps/api/__tests__/customRuleParity.test.js`` feeds the case's
    ``build_log`` and ``proxies`` through the cloud pipeline.

Both assert the case's ``expected`` verdict. The fixture's ``build_log``
and ``proxies`` are what the agent uploads for ``events``; they are
re-derived here so the cloud side can never be testing stale inputs.

``fixtures/build_durations.json`` is the matching snapshot of the
build-duration tables behind the start-time rewind.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from typing import Any, Dict, List

import pytest


_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from core import build_durations  # noqa: E402
from core.build_definitions import (  # noqa: E402
    EXPANSION_PROXY_BUILDINGS,
    PROXY_DISTANCE_DEFAULT,
    PROXY_DISTANCE_EXPANSION,
    PROXY_ELIGIBLE_BUILDINGS,
    is_eight_worker_game,
    proxy_distance_for,
)
from core.event_extractor import (  # noqa: E402
    STRUCTURE_MORPH_SECONDS,
    UNIT_BUILD_SECONDS,
    UPGRADE_BUILD_SECONDS,
    build_log_lines,
)
from core.strategy_detector_base import BaseStrategyDetector  # noqa: E402
from core.strategy_detector_opponent import (  # noqa: E402
    OpponentStrategyDetector,
)
from core.strategy_detector_user import UserBuildDetector  # noqa: E402


def _fixture(name: str) -> Dict[str, Any]:
    with open(
        os.path.join(_HERE, "fixtures", name), "r", encoding="utf-8",
    ) as handle:
        return json.load(handle)


PARITY = _fixture("custom_rule_parity.json")
CASES: List[Dict[str, Any]] = PARITY["cases"]


def _split(events: List[Dict[str, Any]]):
    """Split events the way both detectors do before ``check_custom_rules``."""
    return (
        [e for e in events if e["type"] == "building"],
        # Worker births are handed over as units (strategy_detector_user /
        # _opponent) for the built-in worker-count rules.
        [e for e in events if e["type"] in ("unit", "worker")],
        [e for e in events if e["type"] == "upgrade"],
    )


def _verdict(case: Dict[str, Any], rules=None) -> bool:
    detector = BaseStrategyDetector([])
    buildings, units, upgrades = _split(case["events"])
    return detector.check_custom_rules(
        case["rules"] if rules is None else rules,
        buildings,
        units,
        upgrades,
        detector._get_main_base_loc(buildings),
        eight_worker=is_eight_worker_game(case["game_version"]),
    )


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_desktop_verdict_matches_the_shared_expectation(case):
    assert _verdict(case) is case["expected"], case["why"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_fixture_cloud_inputs_are_what_the_agent_uploads(case):
    """``build_log`` / ``proxies`` must be derived from ``events``.

    If this fails after an intentional engine change, copy the values
    from the assertion message into the fixture: the API's parity test
    then re-checks the cloud against the new upload.
    """
    events = case["events"]
    assert build_log_lines(events) == case["build_log"]

    detector = BaseStrategyDetector([])
    buildings, _units, _upgrades = _split(events)
    main_loc = detector._get_main_base_loc(buildings)
    # The agent's stamp: replay_pipeline._compute_spatial_extract.
    proxies = [
        {"name": b["name"], "time": b["time"], "x": b["x"], "y": b["y"]}
        for b in buildings
        if b["name"] in PROXY_ELIGIBLE_BUILDINGS
        and detector._is_canonical_proxy(b, main_loc)
    ]
    assert proxies == case["proxies"]


def test_parity_cases_cover_both_verdicts_and_both_patch_eras():
    assert {c["expected"] for c in CASES} == {True, False}
    assert {is_eight_worker_game(c["game_version"]) for c in CASES} == {
        True, False,
    }
    assert any(r.get("proxy") for c in CASES for r in c["rules"])


def test_proxy_geometry_matches_the_shared_snapshot():
    proxy = PARITY["proxy"]
    assert PROXY_DISTANCE_DEFAULT == proxy["default_distance"]
    assert PROXY_DISTANCE_EXPANSION == proxy["expansion_distance"]
    assert sorted(EXPANSION_PROXY_BUILDINGS) == proxy["expansion_buildings"]
    for name in PROXY_ELIGIBLE_BUILDINGS:
        expected = (
            PROXY_DISTANCE_EXPANSION
            if name in EXPANSION_PROXY_BUILDINGS
            else PROXY_DISTANCE_DEFAULT
        )
        assert proxy_distance_for(name) == expected


def test_build_duration_tables_match_the_shared_snapshot():
    snapshot = _fixture("build_durations.json")
    assert build_durations.STRUCTURE_MORPH_SECONDS == snapshot[
        "structure_morph_seconds"]
    assert build_durations.STRUCTURE_BUILD_SECONDS == snapshot[
        "structure_build_seconds"]
    assert build_durations.UNIT_BUILD_SECONDS == snapshot["unit_build_seconds"]
    assert build_durations.UPGRADE_BUILD_SECONDS == snapshot[
        "upgrade_build_seconds"]
    assert build_durations.EIGHT_WORKER_BUILD_SECONDS == snapshot[
        "eight_worker_build_seconds"]
    # event_extractor re-exports the same objects, not copies.
    assert STRUCTURE_MORPH_SECONDS is build_durations.STRUCTURE_MORPH_SECONDS
    assert UNIT_BUILD_SECONDS is build_durations.UNIT_BUILD_SECONDS
    assert UPGRADE_BUILD_SECONDS is build_durations.UPGRADE_BUILD_SECONDS


@pytest.mark.parametrize(
    "name, recorded, kwargs, start",
    [
        # Plain structures are recorded at their start.
        ("Gateway", 100, {"is_building": True}, 100),
        ("Hatchery", 178, {"is_building": True}, 178),
        # Morphs, units and upgrades are recorded at their finish.
        ("Lair", 300, {"is_building": True}, 243),
        ("OrbitalCommand", 330, {"is_building": True}, 305),
        ("Stalker", 180, {}, 150),
        # The replay's own names for Viking, Swarm Host and Lurker.
        ("VikingFighter", 300, {}, 270),
        ("SwarmHostMP", 400, {}, 371),
        ("LurkerMP", 500, {}, 482),
        ("WarpGateResearch", 420, {"is_upgrade": True}, 320),
        # sc2reader's lower-case upgrade names resolve to the same row.
        ("zerglingmovementspeed", 301, {"is_upgrade": True}, 201),
        ("Spawning Pool", 75, {}, 75),
        # Unknown names and unknown upgrades are left alone.
        ("FlibbertyGibbet", 300, {}, 300),
        ("AdeptPiercingAttack", 400, {"is_upgrade": True}, 400),
        # 8-worker patch 5.0.16 overrides.
        ("Adept", 150, {"eight_worker": True}, 117),
        ("Adept", 150, {}, 123),
        ("WarpGate", 250, {"is_building": True, "eight_worker": True}, 246),
        ("WarpGate", 250, {"is_building": True}, 243),
        # An upgrade never takes an 8-worker unit override.
        ("Charge", 400, {"is_upgrade": True, "eight_worker": True}, 300),
        # Clamped at zero; negative recorded times read as zero.
        ("Overlord", 5, {}, 0),
        ("Zergling", -3, {}, 0),
    ],
)
def test_to_start_seconds(name, recorded, kwargs, start):
    assert build_durations.to_start_seconds(name, recorded, **kwargs) == start


@pytest.mark.parametrize(
    "version, build, expected",
    [
        ("5.0.16.97425", None, True),
        ("5.0.16.97364", 97364, True),
        ("5.0.15.96883", 96883, False),
        ("5.0.17.98000", 98000, False),
        # The release string outranks the build, as in the API's patchEra.
        ("5.0.15.96883", 97425, False),
        (None, 97364, True),
        (None, 97363, False),
        (None, None, False),
        ("", 97425, False),
    ],
)
def test_is_eight_worker_game(version, build, expected):
    assert is_eight_worker_game(version, build) is expected


def test_v1_rules_keep_recorded_times_and_honour_an_explicit_dist():
    """Legacy desktop-only rule types are not start-time rules."""
    detector = BaseStrategyDetector([])
    main = {"type": "building", "name": "Hatchery", "time": 0, "x": 60, "y": 48}
    third = {"type": "building", "name": "Hatchery", "time": 178, "x": 46, "y": 98}
    stalker = {"type": "unit", "name": "Stalker", "time": 250}
    main_loc = (60, 48)

    def check(rule, buildings=(main, third), units=()):
        return detector.check_custom_rules(
            [rule], list(buildings), list(units), [], main_loc,
        )

    # Finish time 250 is past an inclusive 240 cutoff; no rewind for v1.
    assert not check(
        {"type": "unit", "name": "Stalker", "time_lt": 240}, units=[stalker],
    )
    assert check(
        {"type": "unit", "name": "Stalker", "time_lt": 250}, units=[stalker],
    )
    # No ``dist``: the canonical radius, so the third base is not a proxy.
    assert not check({"type": "proxy", "name": "Hatchery", "time_lt": 240})
    # An explicit ``dist`` still wins.
    assert check(
        {"type": "proxy", "name": "Hatchery", "time_lt": 240, "dist": 50},
    )
    assert not check(
        {"type": "proxy", "name": "Hatchery", "time_lt": 240, "dist": 80},
    )


def test_v3_rules_default_to_the_twelve_worker_durations():
    """Callers that do not pass a patch era get the live game's balance."""
    adept = next(c for c in CASES if c["name"].startswith("Adept on the 8"))
    detector = BaseStrategyDetector([])
    buildings, units, upgrades = _split(adept["events"])
    main_loc = detector._get_main_base_loc(buildings)
    assert detector.check_custom_rules(
        adept["rules"], buildings, units, upgrades, main_loc,
        eight_worker=True,
    )
    assert not detector.check_custom_rules(
        adept["rules"], buildings, units, upgrades, main_loc,
    )


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_user_and_opponent_detectors_reach_the_same_verdict(case):
    """The real entry points, including their own event split."""
    build = {
        "id": "parity-build",
        "name": "Parity Build",
        "race": "Any",
        "vs_race": "Any",
        "rules": case["rules"],
    }
    eight_worker = is_eight_worker_game(case["game_version"])
    mine = UserBuildDetector([build]).detect_my_build(
        "vs Terran", case["events"], "Zerg", eight_worker=eight_worker,
    )
    theirs = OpponentStrategyDetector([build]).get_strategy_name(
        "Zerg", case["events"], "vs Zerg", my_race="Terran",
        eight_worker=eight_worker,
    )
    assert (mine == "Parity Build") is case["expected"]
    assert (theirs == "Parity Build") is case["expected"]


def test_v1_unit_rules_still_count_worker_births():
    """Only v3 rules are worker-blind; the legacy desktop types are not."""
    detector = BaseStrategyDetector([])
    drones = [
        {"type": "worker", "name": "Drone", "time": t} for t in (12, 24, 36)
    ]
    assert detector.check_custom_rules(
        [{"type": "unit", "name": "Drone", "count": 3, "time_lt": 60}],
        [], drones, [], (0.0, 0.0),
    )
    assert not detector.check_custom_rules(
        [{"type": "unit_max", "name": "Drone", "count": 2, "time_lt": 60}],
        [], drones, [], (0.0, 0.0),
    )


def test_detectors_pass_the_patch_era_to_custom_rules():
    adept = next(c for c in CASES if c["name"].startswith("Adept on the 8"))
    build = {
        "id": "early-adept",
        "name": "Early Adept",
        "race": "Protoss",
        "vs_race": "Any",
        "perspective": "you",
        "rules": adept["rules"],
    }
    detector = UserBuildDetector([build])
    assert detector.detect_my_build(
        "vs Zerg", adept["events"], "Protoss", eight_worker=True,
    ) == "Early Adept"
    assert detector.detect_my_build(
        "vs Zerg", adept["events"], "Protoss",
    ) != "Early Adept"


def test_third_base_on_a_real_replay_is_not_a_proxy():
    """The audit's reproduction: ``ladder_tvz_ever_dream_18min``.

    The Zerg's third Hatchery (2:58) is 51.9 units from the main and the
    Terran's third Command Center is inside 80 units too, so a "proxied
    town hall" rule must not match either side of this macro game.
    """
    path = os.path.join(
        _HERE, "fixtures", "replays", "ladder_tvz_ever_dream_18min.SC2Replay",
    )
    # A clean process, like the other real-replay tests: modules collected
    # earlier may have shimmed sc2reader, which breaks the extractor's
    # isinstance gates in-process.
    script = (
        "import sys, json; "
        "sys.path.insert(0, %r); "
        "import sc2reader; "
        "from core.event_extractor import extract_events; "
        "r = sc2reader.load_replay(%r, load_level=4, load_map=False); "
        "mine, theirs, _stats = extract_events(r, 1); "
        "json.dump([mine, theirs], sys.stdout)"
    ) % (_ROOT, path)
    result = subprocess.run(
        [sys.executable, "-c", script],
        check=True, capture_output=True, text=True, timeout=120,
    )
    terran_events, zerg_events = json.loads(result.stdout)
    detector = BaseStrategyDetector([])

    for events, town_hall in (
        (zerg_events, "Hatchery"), (terran_events, "CommandCenter"),
    ):
        buildings, units, upgrades = _split(events)
        main_loc = detector._get_main_base_loc(buildings)
        beyond_fifty = [
            b for b in buildings
            if b["name"] == town_hall and b["time"] < 600
            and detector._is_proxy(b, main_loc, 50.0)
        ]
        # Non-vacuous: the old flat 50-unit test did flag a town hall here.
        assert beyond_fifty
        assert not detector.check_custom_rules(
            [{
                "type": "before", "name": f"Build{town_hall}",
                "time_lt": 600, "proxy": True,
            }],
            buildings, units, upgrades, main_loc,
        )
        assert detector.check_custom_rules(
            [{
                "type": "not_before", "name": f"Build{town_hall}",
                "time_lt": 600, "proxy": True,
            }],
            buildings, units, upgrades, main_loc,
        )
