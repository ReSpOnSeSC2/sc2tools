"""Regression: opponent-side Protoss "Robo Opener" must require the
Robotics Facility to be the FIRST tech building.

User-reported replay: opponent went a standard 2-Gate Expand Blink
build with a later Robotics Facility for Immortal support. The
Twilight Council went down BEFORE the Robo. The agent was tagging
this as ``Protoss - Robo Opener`` because the rule only checked
``has_building("RoboticsFacility", 390)`` without considering that
Twilight had already been started.

The fix: gate the Robo Opener branch on
``earliest_robo_time < earliest_twilight_time``. A Twilight-first
build with a later Robo falls through to the Blink All-In /
Standard Expand / Standard Macro branches instead, preserving the
Blink context.
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


def _upgrade(name: str, time: int) -> Dict[str, Any]:
    return {"type": "upgrade", "name": name, "time": time}


def _two_gate_expand_blink_with_robo() -> List[Dict[str, Any]]:
    """Standard 2-Gate Expand Blink build with a follow-up Robo.

    Twilight Council goes down BEFORE the Robotics Facility -- this
    is the canonical user-reported false positive.
    """
    return [
        _building("Nexus", 0),
        _building("Pylon", 25),
        _building("Gateway", 65),
        _building("Assimilator", 80),
        _building("Gateway", 130),
        _building("CyberneticsCore", 180),
        _building("Nexus", 260),
        _building("TwilightCouncil", 280),  # Twilight FIRST tech building
        _building("RoboticsFacility", 360),  # Robo LATER for support
        _upgrade("BlinkTech", 380),
        _unit("Stalker", 250),
        _unit("Stalker", 300),
    ]


def test_twilight_first_with_later_robo_is_not_robo_opener():
    """The canonical user bug: a Twilight-first 2-Gate Expand Blink
    build with a later Robo must NOT classify as Robo Opener."""
    detector = sd.OpponentStrategyDetector(custom_builds=[])
    result = detector.get_strategy_name(
        "Protoss", _two_gate_expand_blink_with_robo(), matchup="vs Protoss",
    )
    assert result != "Protoss - Robo Opener", (
        f"Twilight-first build with later Robo must NOT classify as "
        f"Robo Opener; got {result!r}"
    )


def test_robo_first_still_classifies_as_robo_opener():
    """Sanity check: a true Robo-first opener (Robo before Twilight,
    or no Twilight at all) must still classify as Robo Opener."""
    detector = sd.OpponentStrategyDetector(custom_builds=[])
    events = [
        _building("Nexus", 0),
        _building("Pylon", 25),
        _building("Gateway", 65),
        _building("Assimilator", 80),
        _building("CyberneticsCore", 180),
        _building("RoboticsFacility", 280),  # Robo FIRST tech building
        _unit("Stalker", 250),
    ]
    result = detector.get_strategy_name(
        "Protoss", events, matchup="vs Protoss",
    )
    assert result == "Protoss - Robo Opener", (
        f"Robo-first opener must classify as Robo Opener; got {result!r}"
    )


def test_robo_before_twilight_with_both_still_robo_opener():
    """A Robo built BEFORE a later Twilight (both by 6:30) is still
    a Robo Opener -- the rule only excludes Twilight-FIRST builds."""
    detector = sd.OpponentStrategyDetector(custom_builds=[])
    events = [
        _building("Nexus", 0),
        _building("Pylon", 25),
        _building("Gateway", 65),
        _building("Assimilator", 80),
        _building("CyberneticsCore", 180),
        _building("RoboticsFacility", 270),  # Robo FIRST
        _building("TwilightCouncil", 360),   # Twilight LATER
        _unit("Stalker", 250),
    ]
    result = detector.get_strategy_name(
        "Protoss", events, matchup="vs Protoss",
    )
    assert result == "Protoss - Robo Opener", (
        f"Robo-before-Twilight must still classify as Robo Opener; "
        f"got {result!r}"
    )
