"""Regression tests for the two PvP Adept Glaive classifiers.

    * "PvP - Robo into Glaives" -- Robotics Facility built BEFORE the
      Twilight Council, Glaives is the FIRST upgrade off that Twilight.
    * "PvP - Adept Glaives"     -- Twilight is the FIRST tech (before
      Robo and Stargate), Glaives is the FIRST upgrade off it.

The shared signal is that Resonating Glaives is the FIRST upgrade
researched out of the Twilight Council -- BEFORE Blink and BEFORE
Charge. That ordering separates these builds from the Blink-keyed PvP
labels (Rail's Blink Stalker (Robo 1st), Blink Stalker Style) that
previously absorbed them on the Blink-exists signal alone.

Pure-function tests -- no replay parsing -- so they run without
sc2reader installed.
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


def _base_opener() -> List[Dict[str, Any]]:
    """1-gate-FE-ish PvP opener: main Nexus, Pylon, Gateway, gas, Cyber,
    then the natural a touch later so the early-expand block engages."""
    return [
        _building("Nexus", 0),
        _building("Pylon", 18),
        _building("Gateway", 60),
        _building("Assimilator", 72),
        _building("CyberneticsCore", 115),
        _building("Nexus", 250),  # natural before 5:00
        _unit("Stalker", 150),    # first warp-in
    ]


def _classify(events: List[Dict[str, Any]]) -> str:
    detector = sd.UserBuildDetector(custom_builds=[])
    return detector.detect_my_build("vs Protoss", events, my_race="Protoss")


# -----------------------------------------------------------------------------
# Robo into Glaives -- Robo before Twilight, Glaives first off Twilight
# -----------------------------------------------------------------------------
def test_robo_into_glaives_classifies():
    events = _base_opener()
    events.append(_building("RoboticsFacility", 200))  # Robo FIRST tech
    events.append(_building("TwilightCouncil", 300))   # Twilight after Robo
    events.append(_upgrade("AdeptPiercingAttack", 340))  # Glaives first
    events.append(_unit("Immortal", 380))
    events.append(_unit("Adept", 360))
    result = _classify(events)
    assert result == "PvP - Robo into Glaives", (
        f"Robo-first + Glaives-first must be Robo into Glaives; got {result!r}"
    )


def test_robo_into_glaives_classifies_even_with_later_blink():
    """Glaives first, Blink researched LATER -- still Robo into Glaives,
    not Rail's Blink Stalker / Blink Stalker Style."""
    events = _base_opener()
    events.append(_building("RoboticsFacility", 200))
    events.append(_building("TwilightCouncil", 300))
    events.append(_upgrade("AdeptPiercingAttack", 340))  # Glaives first
    events.append(_upgrade("BlinkTech", 520))            # Blink later
    events.append(_building("Nexus", 360))               # 3rd base macro
    result = _classify(events)
    assert result == "PvP - Robo into Glaives", (
        f"Glaives-first must win over a later Blink; got {result!r}"
    )


def test_robo_first_blink_first_is_not_robo_into_glaives():
    """Robo-first but Blink is the FIRST upgrade -- must NOT tag as Robo
    into Glaives (it is a Blink build)."""
    events = _base_opener()
    events.append(_building("RoboticsFacility", 200))
    events.append(_building("TwilightCouncil", 300))
    events.append(_upgrade("BlinkTech", 320))            # Blink first
    events.append(_upgrade("AdeptPiercingAttack", 480))  # Glaives later
    result = _classify(events)
    assert result != "PvP - Robo into Glaives", (
        f"Blink-first must NOT tag as Robo into Glaives; got {result!r}"
    )


# -----------------------------------------------------------------------------
# Adept Glaives -- Twilight first, Glaives first off it
# -----------------------------------------------------------------------------
def test_adept_glaives_classifies():
    events = _base_opener()
    events.append(_building("TwilightCouncil", 200))   # Twilight FIRST tech
    events.append(_upgrade("AdeptPiercingAttack", 240))  # Glaives first
    events.append(_unit("Adept", 260))
    result = _classify(events)
    assert result == "PvP - Adept Glaives", (
        f"Twilight-first + Glaives-first must be Adept Glaives; got {result!r}"
    )


def test_adept_glaives_classifies_even_with_later_blink():
    events = _base_opener()
    events.append(_building("TwilightCouncil", 200))
    events.append(_upgrade("AdeptPiercingAttack", 240))  # Glaives first
    events.append(_upgrade("BlinkTech", 460))            # Blink later
    events.append(_building("Nexus", 360))
    result = _classify(events)
    assert result == "PvP - Adept Glaives", (
        f"Glaives-first must win over a later Blink; got {result!r}"
    )


def test_adept_glaives_negative_when_blink_first():
    """Blink researched before Glaives off a Twilight-first opener -- a
    Blink build, not Adept Glaives."""
    events = _base_opener()
    events.append(_building("TwilightCouncil", 200))
    events.append(_upgrade("BlinkTech", 240))            # Blink first
    events.append(_upgrade("AdeptPiercingAttack", 460))  # Glaives later
    result = _classify(events)
    assert result != "PvP - Adept Glaives", (
        f"Blink-first must NOT tag as Adept Glaives; got {result!r}"
    )


def test_adept_glaives_negative_when_robo_first():
    """Robo before Twilight -- this is the Robo into Glaives branch, NOT
    the pure Twilight-first Adept Glaives label."""
    events = _base_opener()
    events.append(_building("RoboticsFacility", 180))  # Robo before Twilight
    events.append(_building("TwilightCouncil", 260))
    events.append(_upgrade("AdeptPiercingAttack", 300))
    result = _classify(events)
    assert result == "PvP - Robo into Glaives", (
        f"Robo-before-Twilight Glaives is Robo into Glaives; got {result!r}"
    )


# -----------------------------------------------------------------------------
# Catalog presence
# -----------------------------------------------------------------------------
def test_new_pvp_glaives_definitions_present_in_catalog():
    import json
    with open(
        os.path.join(_ROOT, "data", "build_definitions.json"),
        "r",
        encoding="utf-8",
    ) as fh:
        defs = json.load(fh)
    for name in ("PvP - Robo into Glaives", "PvP - Adept Glaives"):
        assert name in defs, f"Missing definition prose for {name!r}"
        desc = defs[name]
        assert isinstance(desc, str) and len(desc) > 60
        lc = desc.lower()
        assert "first" in lc and "glaive" in lc and "twilight" in lc, (
            f"Definition for {name!r} should describe Glaives-first-off-Twilight"
        )
