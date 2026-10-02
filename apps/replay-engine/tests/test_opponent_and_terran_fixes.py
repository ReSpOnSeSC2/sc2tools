"""Regressions for the generic Protoss opponent tree and the Terran
trees found in the 12-worker detection audit.
"""

from __future__ import annotations

import os
import re
import sys
from typing import Any, Dict, List, Tuple

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from core.build_definitions import BUILD_DEFINITIONS  # noqa: E402
from core.strategy_detector_base import BaseStrategyDetector  # noqa: E402
from core.strategy_detector_race import classify_by_race  # noqa: E402

MAIN: Tuple[float, float] = (10.0, 10.0)
NATURAL: Tuple[float, float] = (40.0, 10.0)
NATURAL_EDGE: Tuple[float, float] = (55.0, 10.0)   # 45 units from the main
PROXY: Tuple[float, float] = (120.0, 120.0)

DET = BaseStrategyDetector(custom_builds=[])


def _b(name: str, t: int, loc: Tuple[float, float] = MAIN, subtype: str = "init") -> Dict[str, Any]:
    return {"type": "building", "name": name, "time": t, "x": loc[0], "y": loc[1], "subtype": subtype}


def _u(name: str, t: int) -> Dict[str, Any]:
    return {"type": "unit", "name": name, "time": t, "x": 0.0, "y": 0.0}


def _n(name: str, t: int, n: int, step: int = 10) -> List[Dict[str, Any]]:
    return [_u(name, t + i * step) for i in range(n)]


def _classify(race: str, opp_race, events: List[Dict[str, Any]]) -> str:
    return classify_by_race(race, events, DET, opp_race=opp_race)


# --------------------------------------------------------------------------
# Protoss opponent proxies
# --------------------------------------------------------------------------
def test_opponent_proxy_two_gate_has_its_own_label():
    ev = [
        _b("Nexus", 0, MAIN, "born"), _b("Pylon", 20), _b("Pylon", 45, PROXY),
        _b("Gateway", 60, PROXY), _b("Gateway", 75, PROXY),
        *_n("Zealot", 100, 4, 15),
    ]
    assert _classify("Protoss", "Protoss", ev) == "Protoss - Proxy 2 Gate"


def test_opponent_forward_gateway_at_proxy_robo_timing_is_not_a_proxy_two_gate():
    ev = [
        _b("Nexus", 0, MAIN, "born"), _b("Pylon", 19), _b("Gateway", 38),
        _b("Gateway", 71), _b("CyberneticsCore", 85), _b("Pylon", 114, PROXY),
        _b("RoboticsFacility", 136, PROXY), _b("Gateway", 142, PROXY),
        *_n("Stalker", 150, 3, 15), _u("Immortal", 214),
    ]
    assert _classify("Protoss", "Protoss", ev) == "Protoss - Proxy Robo Opener"


def test_opponent_natural_wall_is_not_a_proxy_four_gate():
    ev = [
        _b("Nexus", 0, MAIN, "born"), _b("Gateway", 80, NATURAL_EDGE),
        _b("Gateway", 100, NATURAL_EDGE), _b("Gateway", 120, NATURAL_EDGE),
        _b("Nexus", 90, NATURAL), _b("CyberneticsCore", 120), *_n("Stalker", 160, 3),
    ]
    assert _classify("Protoss", "Protoss", ev) != "Protoss - Proxy 4 Gate"


def test_opponent_proxy_four_gate_still_fires():
    ev = [
        _b("Nexus", 0, MAIN, "born"), _b("Pylon", 45, PROXY),
        _b("Gateway", 70, PROXY), _b("Gateway", 90, PROXY), _b("Gateway", 110, PROXY),
        _b("CyberneticsCore", 120), *_n("Stalker", 160, 6),
    ]
    assert _classify("Protoss", "Protoss", ev) == "Protoss - Proxy 4 Gate"


# --------------------------------------------------------------------------
# Terran base counting (the main is a born-only event on real replays)
# --------------------------------------------------------------------------
def _terran_one_base() -> List[Dict[str, Any]]:
    return [
        _b("CommandCenter", 0, MAIN, "born"), _b("SupplyDepot", 20),
        _b("Barracks", 60), _b("Barracks", 120), _b("Barracks", 150),
    ]


# The generic tree is reached directly with no opponent race (the matchup
# trees have their own "3 Rax Marine" labels that would claim these first).
def test_three_four_rax_marine_rush_fires_on_one_base():
    ev = _terran_one_base() + _n("Marine", 150, 12, 12)
    assert _classify("Terran", None, ev) == "Terran - 3-4 Rax Marine rush"


def test_two_three_rax_reaper_rush_fires_on_one_base():
    ev = _terran_one_base() + [_b("Refinery", 50)] + _n("Reaper", 150, 3, 20)
    assert _classify("Terran", None, ev) == "Terran - 2-3 Rax Reaper rush"


def test_three_rax_fires_on_two_bases_and_reapers_do_not_make_it_a_rush():
    ev = [
        _b("CommandCenter", 0, MAIN, "born"), _b("Refinery", 50), _b("Barracks", 60),
        _b("CommandCenter", 100, NATURAL), _b("Barracks", 180), _b("Barracks", 200),
        *_n("Reaper", 150, 2, 20), *_n("Marine", 220, 8, 12),
    ]
    assert _classify("Terran", None, ev) == "Terran - 3 Rax"


# --------------------------------------------------------------------------
# Terran matchup trees: two-base labels need two bases, proxies fall to
# the generic tree
# --------------------------------------------------------------------------
def test_one_base_marine_tank_is_not_a_two_one_one():
    ev = [
        _b("CommandCenter", 0, MAIN, "born"), _b("Barracks", 60), _b("Refinery", 70),
        _b("Factory", 130), _b("Starport", 200), _u("SiegeTank", 300),
        *_n("Marine", 120, 10, 20),
    ]
    assert _classify("Terran", "Terran", ev) != "TvT - 2-1-1 Marine Tank"


def test_two_base_marine_tank_is_a_two_one_one():
    ev = [
        _b("CommandCenter", 0, MAIN, "born"), _b("Barracks", 60), _b("Refinery", 70),
        _b("CommandCenter", 110, NATURAL), _b("Factory", 160), _b("Starport", 230),
        _u("SiegeTank", 330), *_n("Marine", 120, 10, 20),
    ]
    assert _classify("Terran", "Terran", ev) == "TvT - 2-1-1 Marine Tank"


def test_proxied_factory_and_starport_reach_the_generic_proxy_label():
    ev = [
        _b("CommandCenter", 0, MAIN, "born"), _b("Barracks", 60), _b("Refinery", 70),
        _b("Factory", 130, PROXY), _b("Starport", 200, PROXY), _u("SiegeTank", 300),
        *_n("Marine", 120, 10, 20),
    ]
    assert _classify("Terran", "Terran", ev) == "Terran - Proxy 1-1-1"


# --------------------------------------------------------------------------
# Catalog completeness for the generic and matchup trees
# --------------------------------------------------------------------------
@pytest.mark.parametrize("module", ["strategy_detector_race", "strategy_detector_matchups"])
def test_every_emitted_label_is_in_the_engine_catalog(module):
    with open(os.path.join(_ROOT, "core", module + ".py"), encoding="utf-8") as src:
        emitted = set(re.findall(r'"((?:Protoss|Terran|Zerg|[TZ]v[TZP]) - [^"\n]+)"', src.read()))
    assert emitted
    assert sorted(label for label in emitted if label not in BUILD_DEFINITIONS) == []
