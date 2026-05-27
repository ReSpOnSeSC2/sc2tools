"""Regression: opponent classification must count the pre-placed main
town hall for every race.

Real replays emit only a ``born`` event (no ``init``) for the
game-start town hall (Command Center / Nexus / Hatchery), so any base
heuristic that counted construction-START events missed the main and
shifted by one base. This file pins the fixed behaviour on the
real-replay (born-event) shape for Zerg and Protoss; the Terran case
lives in ``test_strategy_detector_terran_fast_3_cc_opponent.py``.
"""
from __future__ import annotations

import importlib.util
import os
import sys
import types
from typing import Any, Dict

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(os.path.dirname(_HERE))  # reveal-sc2-opponent-main/
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)


def _load(mod_name: str, file_name: str):
    spec = importlib.util.spec_from_file_location(
        mod_name, os.path.join(_ROOT, "core", file_name),
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = module
    spec.loader.exec_module(module)
    return module


if "core" not in sys.modules:
    core_pkg = types.ModuleType("core")
    core_pkg.__path__ = [os.path.join(_ROOT, "core")]
    sys.modules["core"] = core_pkg
_load("core.atomic_io", "atomic_io.py")
_load("core.paths", "paths.py")
_load("core.custom_builds", "custom_builds.py")
_load("core.build_definitions", "build_definitions.py")
_load("core.strategy_detector_helpers", "strategy_detector_helpers.py")
_load("core.strategy_detector_base", "strategy_detector_base.py")
sd_opp = _load("core.strategy_detector_opponent", "strategy_detector_opponent.py")


def _b(name: str, time: int, subtype: str = "init") -> Dict[str, Any]:
    return {
        "type": "building", "name": name, "time": time, "x": 0.0, "y": 0.0,
        "subtype": subtype,
    }


def _u(name: str, time: int) -> Dict[str, Any]:
    return {"type": "unit", "name": name, "time": time, "x": 0.0, "y": 0.0}


def _detector():
    return sd_opp.OpponentStrategyDetector(custom_builds=[])


# --------------------------- ZERG ---------------------------

def test_zerg_hatch_first_real_replay_main_is_born():
    """Main Hatchery as a born-only event; the natural goes down before
    the pool. Must read as a Hatch-First opening, not Pool-First."""
    events = [
        _b("Hatchery", 0, subtype="born"),  # pre-placed main (born only)
        _b("Hatchery", 140),                # natural / 2nd base
        _b("SpawningPool", 180),
        _u("Drone", 200),
    ]
    result = _detector().get_strategy_name("Zerg", events, matchup="vs Protoss")
    assert result.startswith("Zerg - ") and "Pool First" not in result, (
        f"natural (140) before pool (180) must classify Hatch-First; "
        f"got {result!r}"
    )


def test_zerg_three_base_macro_counts_main():
    """Main + 2 expansion Hatcheries (born main) = 3 bases -> the
    3-base macro label, even though only 2 init events exist."""
    events = [
        _b("Hatchery", 0, subtype="born"),
        _b("SpawningPool", 80),   # pool before the natural -> Pool-First tree
        _b("Hatchery", 200),
        _b("Hatchery", 360),
        _u("Drone", 300),
    ]
    result = _detector().get_strategy_name("Zerg", events, matchup="vs Protoss")
    assert result == "Zerg - 3 Base Macro (Pool First)", (
        f"main + 2 expansions must count as 3 bases; got {result!r}"
    )


# -------------------------- PROTOSS -------------------------

def test_protoss_standard_expand_real_replay_main_is_born():
    """Main Nexus as a born-only event; natural at 5:00 (< 6:30) must
    classify as Standard Expand."""
    events = [
        _b("Nexus", 0, subtype="born"),
        _b("Gateway", 60),
        _b("Nexus", 300),  # natural / 2nd base
        _u("Probe", 200),
    ]
    result = _detector().get_strategy_name("Protoss", events, matchup="vs Terran")
    assert result == "Protoss - Standard Expand", (
        f"natural at 300 (<390) must be Standard Expand; got {result!r}"
    )


def test_protoss_three_base_macro_counts_main():
    """Main + 2 expansion Nexuses (born main) + heavy Probe count = the
    3-base macro label."""
    events = [
        _b("Nexus", 0, subtype="born"),
        _b("Gateway", 60),
        _b("Nexus", 280),
        _b("Nexus", 480),
    ] + [_u("Probe", 100 + i) for i in range(42)]
    result = _detector().get_strategy_name("Protoss", events, matchup="vs Terran")
    assert result == "Protoss - Standard Macro (CIA)", (
        f"main + 2 expansions + 40+ probes must be Standard Macro (CIA); "
        f"got {result!r}"
    )


def test_protoss_one_base_not_promoted_to_expand():
    """A single-base Protoss game (born main, no expansion) must NOT
    trip the Standard Expand / Macro branches."""
    events = [
        _b("Nexus", 0, subtype="born"),
        _b("Gateway", 60),
        _u("Probe", 200),
    ]
    result = _detector().get_strategy_name("Protoss", events, matchup="vs Terran")
    assert result not in ("Protoss - Standard Expand", "Protoss - Standard Macro (CIA)"), (
        f"one-base game must not be labelled an expand/macro build; "
        f"got {result!r}"
    )
