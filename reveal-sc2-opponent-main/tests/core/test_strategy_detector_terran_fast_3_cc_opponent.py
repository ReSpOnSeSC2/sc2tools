"""Regression: opponent-side Terran "Fast 3 CC" must count the
pre-placed main Command Center.

A real PvT replay reported by the user: the Terran opponent took a
fast third base (main + two expansions, all started before 7:00) but
the game was tagged ``Terran - Standard Bio Tank`` instead of
``Terran - Fast 3 CC``.

Root cause: the Fast 3 CC check counted only construction-START
(init / morph) events. In a REAL replay the game-placed main town hall
fires only a ``born`` event at t=0 (no init), so the start-event count
saw just the two expansions (= 2) and the ``>= 3`` test failed. The
rule chain then fell through to the Bio/Tank macro branch. The unit
tests never caught this because their fixtures model the main as a t=0
``init`` event, which the buggy count happened to include.

The fix: count the main via ``base_count_at`` (which adds the
pre-placed main when any town-hall event exists), matching the
"3 Command Centers exist before 7:00" definition and the Nexus /
Hatchery base counting already used by the other detectors.
"""
from __future__ import annotations

import importlib.util
import os
import sys
import types
from typing import Any, Dict, List

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
_load("core.strategy_detector_opponent", "strategy_detector_opponent.py")
_load("core.strategy_detector_pvz", "strategy_detector_pvz.py")
_load("core.strategy_detector_pvp", "strategy_detector_pvp.py")
_load("core.strategy_detector_pvt", "strategy_detector_pvt.py")
_load("core.strategy_detector_tvp", "strategy_detector_tvp.py")
_load("core.strategy_detector_tvt", "strategy_detector_tvt.py")
_load("core.strategy_detector_tvz", "strategy_detector_tvz.py")
_load("core.strategy_detector_zvp", "strategy_detector_zvp.py")
_load("core.strategy_detector_zvt", "strategy_detector_zvt.py")
_load("core.strategy_detector_zvz", "strategy_detector_zvz.py")
_load("core.strategy_detector_user", "strategy_detector_user.py")
sd = _load("core.strategy_detector", "strategy_detector.py")


def _building(name: str, time: int, subtype: str = "init") -> Dict[str, Any]:
    return {
        "type": "building", "name": name, "time": time, "x": 0.0, "y": 0.0,
        "subtype": subtype,
    }


def _unit(name: str, time: int) -> Dict[str, Any]:
    return {"type": "unit", "name": name, "time": time, "x": 0.0, "y": 0.0}


def test_fast_3_cc_real_replay_main_is_born_event():
    """Real-replay shape: the main CC fires only a ``born`` event at
    t=0. With two expansions started before 7:00 that is three bases,
    so the build must classify as ``Terran - Fast 3 CC`` -- even though
    only two CC *init* events exist."""
    detector = sd.OpponentStrategyDetector(custom_builds=[])
    events = [
        # Pre-placed main: real replays emit ONLY a born event (no init).
        _building("CommandCenter", 0, subtype="born"),
        _building("OrbitalCommand", 130, subtype="morph"),
        _building("Barracks", 60),
        _building("Refinery", 70),
        # Two genuine expansions, both before 7:00 (420 s).
        _building("CommandCenter", 200),
        _building("CommandCenter", 380),
        # Bio + tank tech that previously stole the classification.
        _building("Factory", 250),
        _building("EngineeringBay", 300),
        _unit("SiegeTank", 400),
        _unit("Marine", 320),
    ]
    result = detector.get_strategy_name(
        "Terran", events, matchup="vs Protoss",
    )
    assert result == "Terran - Fast 3 CC", (
        f"main (born) + 2 expansions before 7:00 must be Fast 3 CC; "
        f"got {result!r}"
    )


def test_standard_bio_tank_two_bases_not_fast_3_cc():
    """A two-base macro game (main + one expansion before 7:00, no
    third) must NOT be promoted to Fast 3 CC -- it stays
    ``Terran - Standard Bio Tank``."""
    detector = sd.OpponentStrategyDetector(custom_builds=[])
    events = [
        _building("CommandCenter", 0, subtype="born"),
        _building("OrbitalCommand", 130, subtype="morph"),
        _building("Barracks", 60),
        _building("Refinery", 70),
        # Only one expansion -> two bases total.
        _building("CommandCenter", 200),
        # Factory AFTER the 2nd CC -> macro expand, not a 1-base all-in.
        _building("Factory", 260),
        _building("Starport", 300),
        _building("EngineeringBay", 280),
        _unit("SiegeTank", 400),
        _unit("Marine", 320),
        _unit("Medivac", 360),
    ]
    result = detector.get_strategy_name(
        "Terran", events, matchup="vs Protoss",
    )
    assert result == "Terran - Standard Bio Tank", (
        f"main + 1 expansion (2 bases) must stay Standard Bio Tank; "
        f"got {result!r}"
    )


def test_fast_3_cc_fixture_main_as_init_still_works():
    """Fixtures that model the main as a t=0 ``init`` event (the older
    test convention) must keep classifying as Fast 3 CC -- the fix is
    robust to both event shapes."""
    detector = sd.OpponentStrategyDetector(custom_builds=[])
    events = [
        _building("CommandCenter", 0),  # init at t=0 (fixture style)
        _building("CommandCenter", 200),
        _building("CommandCenter", 380),
        _building("Barracks", 60),
    ]
    result = detector.get_strategy_name(
        "Terran", events, matchup="vs Protoss",
    )
    assert result == "Terran - Fast 3 CC", (
        f"fixture-style main (init at t=0) + 2 expansions must be "
        f"Fast 3 CC; got {result!r}"
    )
