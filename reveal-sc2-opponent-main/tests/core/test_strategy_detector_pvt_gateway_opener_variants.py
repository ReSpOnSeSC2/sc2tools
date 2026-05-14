"""Regression tests for the PvT gateway-opener (Twilight-first) labels.

The detector distinguishes three Twilight-first openers by which
upgrade is researched FIRST out of the Twilight Council:

    * "PvT - 3 Gate Charge Opener"  -- Charge first off Twilight
    * "PvT - 3 Gate Blink (Macro)"  -- Blink first, <4 Gateways by 7:30
    * "PvT - 4 Gate Blink"          -- Blink first, 4+ Gateways by 7:30

Before the fix, the Charge rule fired on a boolean ``has_upgrade_substr``
check that did not compare against Blink timing, so a Blink-first /
Charge-after build matched both rules and the Charge rule won by file
order -- mistagging Blink openers as "3 Gate Charge Opener".

Pure-function tests -- no replay parsing required.
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


def _building(name: str, time: int) -> Dict[str, Any]:
    return {
        "type": "building", "name": name, "time": time, "x": 0.0, "y": 0.0,
        "subtype": "init",
    }


def _unit(name: str, time: int) -> Dict[str, Any]:
    return {"type": "unit", "name": name, "time": time, "x": 0.0, "y": 0.0}


def _upgrade(name: str, time: int) -> Dict[str, Any]:
    return {"type": "upgrade", "name": name, "time": time}


def _twilight_first_base() -> List[Dict[str, Any]]:
    """Shared prefix: standard two-base opener with Twilight Council as
    the FIRST tech building (before any Robo and any Stargate)."""
    return [
        _building("Nexus", 0),
        _building("Pylon", 18),
        _building("Gateway", 60),
        _building("Assimilator", 72),
        _building("CyberneticsCore", 115),
        _building("Nexus", 130),
        _building("Assimilator", 150),
        _building("Pylon", 170),
        _building("Gateway", 240),
        _building("TwilightCouncil", 260),  # FIRST tech building
        _building("Gateway", 300),
    ]


# -----------------------------------------------------------------------------
# 3 Gate Charge Opener -- positive case
# -----------------------------------------------------------------------------
def test_charge_first_classifies_as_three_gate_charge_opener():
    events = _twilight_first_base()
    events.append(_upgrade("Charge", 360))
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result == "PvT - 3 Gate Charge Opener", (
        f"Charge-first off Twilight must classify as 3 Gate Charge Opener; "
        f"got {result!r}"
    )


# -----------------------------------------------------------------------------
# Bug regression: Blink-first must NOT be tagged 3 Gate Charge Opener
# -----------------------------------------------------------------------------
def test_blink_first_then_charge_classifies_as_blink_not_charge():
    """The reported bug: a player opens Blink, then adds Charge later.
    Before the fix, the Charge rule fired because it only checked
    ``has_upgrade_substr("Charge", 540)`` and Twilight-first ordering,
    not which upgrade started first. The Blink rule sat below it and
    was never reached. After the fix, Blink-first must beat Charge-later
    and the 3 Gate Blink (Macro) label must win."""
    events = _twilight_first_base()
    events.append(_upgrade("BlinkTech", 340))   # Blink FIRST
    events.append(_upgrade("Charge", 500))      # Charge later, still by 9:00
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result == "PvT - 3 Gate Blink (Macro)", (
        f"Blink-first must beat Charge-later; got {result!r}"
    )


def test_blink_only_classifies_as_three_gate_blink_macro():
    """Plain Blink-only opener with <4 Gateways by 7:30 -- the
    canonical 3 Gate Blink (Macro). The Charge rule must not fire when
    no Charge upgrade exists at all."""
    events = _twilight_first_base()
    events.append(_upgrade("BlinkTech", 360))
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result == "PvT - 3 Gate Blink (Macro)", (
        f"Blink-only Twilight opener must classify as 3 Gate Blink (Macro); "
        f"got {result!r}"
    )


def test_blink_first_with_four_gates_classifies_as_four_gate_blink():
    """4+ Gateways by 7:30 (450s) with Blink first -- the canonical
    4 Gate Blink all-in. Same bug-class as above: a Charge-after build
    must not steal this label."""
    events = _twilight_first_base()
    events.append(_building("Gateway", 360))
    events.append(_building("Gateway", 400))
    events.append(_upgrade("BlinkTech", 340))   # Blink first
    events.append(_upgrade("Charge", 520))      # Charge later
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result == "PvT - 4 Gate Blink", (
        f"Blink-first with 4+ Gateways must classify as 4 Gate Blink; "
        f"got {result!r}"
    )


# -----------------------------------------------------------------------------
# Standard Charge Macro vs 3 Gate Charge Opener discrimination
# -----------------------------------------------------------------------------
def test_charge_with_third_nexus_graduates_to_standard_charge_macro():
    """Standard Charge Macro is checked BEFORE 3 Gate Charge Opener and
    requires 3+ Nexuses + no Stargate. Same opener as the Charge test
    above, but with a 3rd Nexus down, must promote to the macro label."""
    events = _twilight_first_base()
    events.append(_building("Nexus", 380))      # 3rd Nexus
    events.append(_upgrade("Charge", 420))
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result == "PvT - Standard Charge Macro", (
        f"Charge + 3rd Nexus + no Stargate must classify as Standard Charge "
        f"Macro; got {result!r}"
    )
