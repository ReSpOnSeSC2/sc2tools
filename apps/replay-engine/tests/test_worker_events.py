"""Worker births reach the build classifiers.

``extract_events`` used to drop every Probe / SCV / Drone (they sit in
``SKIP_UNITS`` so they never clutter the build log), which meant every
``count_units("Drone", t)`` / ``count_units("Probe", t)`` predicate in
the Zerg and Protoss trees read 0 on real replays: "Zerg - 12 Pool"
fired on every sub-50 s Pool (a 14 Pool included), every Spire by 7:00
was a "2 Base Muta Rush", and "Hatch First Macro" / "Standard Macro
(CIA)" could never fire. Workers are now emitted as ``type: "worker"``
events that the detectors count and every display path skips.
"""

from __future__ import annotations

import os
import sys
from typing import Any, Dict, List

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from core.event_extractor import build_log_lines, extract_events  # noqa: E402
from core.strategy_detector_opponent import OpponentStrategyDetector  # noqa: E402
from core.strategy_detector_user import UserBuildDetector  # noqa: E402

sc2reader = pytest.importorskip("sc2reader")

_FIXTURE = os.path.join(
    _HERE, "fixtures", "replays", "ladder_zvt_winter_madness.SC2Replay",
)


def _load_sides():
    replay = sc2reader.load_replay(_FIXTURE, load_level=4, load_map=False)
    players = [
        p for p in getattr(replay, "players", [])
        if not getattr(p, "is_observer", False)
    ]
    if not players:
        pytest.skip("fixture replay exposes no players")
    return replay, players


@pytest.fixture(scope="module")
def extracted():
    if not os.path.exists(_FIXTURE):
        pytest.skip("fixture replay missing")
    replay, players = _load_sides()
    me = players[0]
    mine, theirs, stats = extract_events(replay, me.pid)
    return mine, theirs, stats


def test_real_replay_emits_worker_births_for_both_players(extracted):
    mine, theirs, stats = extracted
    my_workers = [e for e in mine if e["type"] == "worker"]
    opp_workers = [e for e in theirs if e["type"] == "worker"]
    assert my_workers and opp_workers
    assert stats["workers"] == len(my_workers) + len(opp_workers)
    assert {e["name"] for e in my_workers + opp_workers} <= {"Drone", "SCV", "Probe"}
    # The starting workers are born at t=0 (8 on patch 5.0.16, 12 elsewhere).
    assert sum(1 for e in my_workers if e["time"] == 0) >= 8
    # Workers keep being born as the game goes on.
    assert sum(1 for e in my_workers if e["time"] > 60) > 10


def test_workers_never_enter_the_build_log(extracted):
    mine, _theirs, _stats = extracted
    lines = build_log_lines(mine)
    assert lines
    assert not any(
        line.endswith(" Drone") or line.endswith(" SCV") or line.endswith(" Probe")
        for line in lines
    )
    assert len(lines) == len([e for e in mine if e["type"] != "worker"])


def test_processed_count_excludes_workers(extracted):
    mine, theirs, stats = extracted
    non_workers = [e for e in mine + theirs if e["type"] != "worker"]
    assert stats["processed"] == len(non_workers)


# --------------------------------------------------------------------------
# Synthetic: the worker counts now drive the Zerg / Protoss predicates
# --------------------------------------------------------------------------
def _b(name: str, time: int, x: float = 10.0, y: float = 10.0, subtype: str = "init") -> Dict[str, Any]:
    return {"type": "building", "name": name, "time": time, "x": x, "y": y, "subtype": subtype}


def _w(name: str, time: int) -> Dict[str, Any]:
    return {"type": "worker", "name": name, "time": time, "x": 10.0, "y": 10.0}


def _u(name: str, time: int) -> Dict[str, Any]:
    return {"type": "unit", "name": name, "time": time, "x": 0.0, "y": 0.0}


def _starting_workers(name: str, n: int = 12) -> List[Dict[str, Any]]:
    return [_w(name, 0) for _ in range(n)]


def _opp(race: str, events: List[Dict[str, Any]], my_race: str = "Protoss") -> str:
    return OpponentStrategyDetector(custom_builds=[]).get_strategy_name(
        race, events, f"vs {my_race}", game_length_seconds=900, my_race=my_race,
    )


def test_twelve_pool_counts_only_the_starting_drones():
    events = [
        _b("Hatchery", 0, subtype="born"), *_starting_workers("Drone"),
        _b("SpawningPool", 25), *[_u("Zergling", 90 + i) for i in range(6)],
    ]
    assert _opp("Zerg", events, my_race="Terran") == "Zerg - 12 Pool"


def test_fourteen_pool_is_an_early_pool_not_a_twelve_pool():
    # Two Drones built before the Pool (14 Pool) -- used to read as
    # "12 Pool" because no Drone was ever counted.
    events = [
        _b("Hatchery", 0, subtype="born"), *_starting_workers("Drone"),
        _w("Drone", 24), _w("Drone", 36), _b("SpawningPool", 45),
        _b("Hatchery", 110, 40.0, 10.0), _b("Extractor", 120),
        *[_u("Zergling", 120 + i) for i in range(6)],
    ]
    assert _opp("Zerg", events, my_race="Terran") == "Zerg - Early Pool (14/14 or 15 Pool)"


def test_spire_on_a_full_economy_is_not_a_two_base_muta_rush():
    events = [
        _b("Hatchery", 0, subtype="born"), *_starting_workers("Drone"),
        _b("Hatchery", 70, 40.0, 10.0), _b("Extractor", 80), _b("SpawningPool", 85),
        _b("Hatchery", 180, 70.0, 10.0), _b("Lair", 250, subtype="morph"),
        _b("Spire", 330),
        *[_w("Drone", 20 + i * 8) for i in range(45)],
    ]
    assert _opp("Zerg", events, my_race="Terran") != "Zerg - 2 Base Muta Rush"


def test_spire_on_a_starved_economy_is_a_two_base_muta_rush():
    events = [
        _b("Hatchery", 0, subtype="born"), *_starting_workers("Drone"),
        _b("Hatchery", 70, 40.0, 10.0), _b("Extractor", 80), _b("SpawningPool", 85),
        _b("Lair", 250, subtype="morph"), _b("Spire", 330),
        *[_w("Drone", 20 + i * 8) for i in range(12)],
    ]
    assert _opp("Zerg", events, my_race="Terran") == "Zerg - 2 Base Muta Rush"


def test_standard_macro_cia_fires_on_a_real_probe_count():
    # 3 Nexuses and 47 Probes by 6:40 with no early tech building that
    # an earlier rule would claim: the rule could never fire while the
    # Probe count read 0.
    events = [
        _b("Nexus", 0, subtype="born"), *_starting_workers("Probe"),
        _b("Pylon", 18), _b("Gateway", 40), _b("CyberneticsCore", 95),
        _b("Nexus", 110, 40.0, 10.0), _b("Nexus", 300, 70.0, 10.0),
        _b("Forge", 200), _b("Gateway", 250), _b("Gateway", 260),
        *[_w("Probe", 12 + i * 10) for i in range(35)],
        _u("Stalker", 150), _u("Stalker", 200),
    ]
    assert _opp("Protoss", events, my_race="Zerg") == "Protoss - Standard Macro (CIA)"


def test_user_side_counts_workers_too():
    events = [
        _b("Hatchery", 0, subtype="born"), *_starting_workers("Drone"),
        _w("Drone", 24), _w("Drone", 36), _b("SpawningPool", 45),
        _b("Hatchery", 110, 40.0, 10.0), _b("Extractor", 120),
        *[_u("Zergling", 120 + i) for i in range(6)],
    ]
    label = UserBuildDetector(custom_builds=[]).detect_my_build(
        "vs Terran", events, my_race="Zerg", game_length_seconds=900,
    )
    assert label != "Zerg - 12 Pool"
