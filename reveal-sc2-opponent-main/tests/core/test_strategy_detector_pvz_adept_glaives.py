"""Regression tests for the three PvZ Adept Glaive Timing classifiers.

The detector in core/strategy_detector.py now distinguishes:

    * "PvZ - Adept Glaives (No Robo)"  -- Twilight first, no Robo
    * "PvZ - Adept Glaives (Robo)"     -- Twilight first, with Robo
    * "PvZ - Stargate into Glaives"    -- Stargate first, then Twilight,
                                          Glaives is first off Twilight

The shared signal is that Resonating Glaives is the FIRST upgrade
researched out of the Twilight Council -- BEFORE Blink and BEFORE
Charge. That single ordering separates these builds from
Stargate-into-Blink and the Twilight-into-Charge macro variants.

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


def _base_protoss_opener(*, with_natural: bool = True) -> List[Dict[str, Any]]:
    """Standard Protoss FFE-ish opener: Nexus, Pylon, Gateway, Assim,
    Cybernetics Core, natural Nexus. Common prefix for the three
    Adept Glaive variants."""
    events: List[Dict[str, Any]] = [
        _building("Nexus", 0),
        _building("Pylon", 18),
        _building("Gateway", 60),
        _building("Assimilator", 72),
        _building("CyberneticsCore", 115),
        _building("Assimilator", 130),
        _building("Pylon", 150),
    ]
    if with_natural:
        events.append(_building("Nexus", 100))
    return events


def _gates(starts: List[int]) -> List[Dict[str, Any]]:
    return [_building("Gateway", t) for t in starts]


# -----------------------------------------------------------------------------
# Adept Glaives (No Robo) -- Twilight first, no Robo, no Stargate
# -----------------------------------------------------------------------------
def test_adept_glaives_no_robo_classifies():
    events = _base_protoss_opener()
    # Twilight is the FIRST tech building after Cyber Core
    events.append(_building("TwilightCouncil", 220))
    # 4-8 gateways by 9:00
    events.extend(_gates([240, 260, 280, 300, 320]))  # 5 more -> total 6
    # FIRST upgrade out of Twilight is Glaives -- well before any Blink / Charge
    events.append(_upgrade("AdeptPiercingAttack", 260))  # 'Glaive' name variant
    events.append(_unit("Adept", 280))
    events.append(_unit("Adept", 310))
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Zerg", events, my_race="Protoss")
    assert result == "PvZ - Adept Glaives (No Robo)", (
        f"Expected pure Gateway Adept Glaives; got {result!r}"
    )


def test_adept_glaives_no_robo_negative_when_blink_researched_first():
    """If Blink starts BEFORE Glaives, this is a Blink build, not Adept
    Glaives -- the classifier must NOT label it as Glaives."""
    events = _base_protoss_opener()
    events.append(_building("TwilightCouncil", 220))
    events.extend(_gates([240, 260, 280, 300]))
    # Blink RESEARCH starts FIRST out of Twilight, Glaive comes later.
    events.append(_upgrade("WarpGateResearch", 200))
    events.append(_upgrade("BlinkTech", 240))
    events.append(_upgrade("AdeptPiercingAttack", 320))
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Zerg", events, my_race="Protoss")
    assert "Adept Glaives" not in result, (
        f"Blink-first must NOT classify as Adept Glaives; got {result!r}"
    )


def test_adept_glaives_no_robo_negative_when_charge_researched_first():
    """Charge before Glaives is a Twilight-into-Charge build."""
    events = _base_protoss_opener()
    events.append(_building("TwilightCouncil", 220))
    events.extend(_gates([240, 260, 280, 300]))
    events.append(_upgrade("Charge", 240))
    events.append(_upgrade("AdeptPiercingAttack", 320))
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Zerg", events, my_race="Protoss")
    assert "Adept Glaives" not in result, (
        f"Charge-first must NOT classify as Adept Glaives; got {result!r}"
    )


# -----------------------------------------------------------------------------
# Adept Glaives (Robo) -- Twilight first, Robo built
# -----------------------------------------------------------------------------
def test_adept_glaives_robo_classifies():
    events = _base_protoss_opener()
    events.append(_building("TwilightCouncil", 220))
    events.extend(_gates([240, 260, 280, 300, 320]))
    events.append(_upgrade("AdeptPiercingAttack", 260))
    # Robotics Facility comes AFTER Twilight -- still Twilight-first
    # tech, but the Robo support distinguishes this variant.
    events.append(_building("RoboticsFacility", 360))
    events.append(_unit("Observer", 450))
    events.append(_unit("Immortal", 500))
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Zerg", events, my_race="Protoss")
    assert result == "PvZ - Adept Glaives (Robo)", (
        f"Expected Adept Glaives Robo variant; got {result!r}"
    )


def test_adept_glaives_robo_negative_when_robo_before_twilight():
    """Robo Opener -- Robotics Facility goes down BEFORE the Twilight
    Council. Must NOT classify as an Adept Glaives variant."""
    events = _base_protoss_opener()
    events.append(_building("RoboticsFacility", 200))  # Robo FIRST
    events.append(_building("TwilightCouncil", 260))   # Twilight LATER
    events.extend(_gates([240, 280, 320]))
    events.append(_upgrade("AdeptPiercingAttack", 300))
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Zerg", events, my_race="Protoss")
    assert "Adept Glaives" not in result, (
        f"Robo-before-Twilight must NOT tag as Adept Glaives; got {result!r}"
    )


# -----------------------------------------------------------------------------
# Stargate into Glaives -- Stargate first, then Twilight, Glaives first
# -----------------------------------------------------------------------------
def test_stargate_into_glaives_classifies():
    events = _base_protoss_opener()
    # Stargate is FIRST tech (before Twilight)
    events.append(_building("Stargate", 200))
    # Twilight comes AFTER Stargate
    events.append(_building("TwilightCouncil", 280))
    events.extend(_gates([240, 320, 360, 380, 420]))
    # First upgrade out of Twilight is Glaives (BEFORE Blink)
    events.append(_upgrade("AdeptPiercingAttack", 320))
    events.append(_unit("Phoenix", 280))  # Stargate unit
    events.append(_unit("Adept", 350))
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Zerg", events, my_race="Protoss")
    assert result == "PvZ - Stargate into Glaives", (
        f"Expected Stargate into Glaives; got {result!r}"
    )


def test_stargate_into_blink_does_not_match_stargate_into_glaives():
    """The key separator: Blink starts BEFORE Glaives out of the
    Twilight Council. The build must NOT be tagged as Stargate into
    Glaives -- this is the whole reason the refined rule exists."""
    events = _base_protoss_opener()
    events.append(_building("Stargate", 200))
    events.append(_building("TwilightCouncil", 280))
    events.extend(_gates([240, 320, 360, 380]))
    # Blink RESEARCH first, Glaive RESEARCH later (or never).
    events.append(_upgrade("BlinkTech", 320))
    events.append(_upgrade("AdeptPiercingAttack", 480))
    # Three Nexuses by 9:00 + Blink + Stargate-before-Twilight should
    # land this on "PvZ - Standard Blink Macro" instead.
    events.append(_building("Nexus", 360))
    events.append(_unit("Phoenix", 260))
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Zerg", events, my_race="Protoss")
    assert result != "PvZ - Stargate into Glaives", (
        f"Blink-first must NOT tag as Stargate into Glaives; got {result!r}"
    )


# -----------------------------------------------------------------------------
# Catalog presence
# -----------------------------------------------------------------------------
def test_new_pvz_definitions_present_in_catalog():
    import json
    with open(
        os.path.join(_ROOT, "data", "build_definitions.json"),
        "r",
        encoding="utf-8",
    ) as fh:
        defs = json.load(fh)
    for name in (
        "PvZ - Adept Glaives (No Robo)",
        "PvZ - Adept Glaives (Robo)",
        "PvZ - Stargate into Glaives",
    ):
        assert name in defs, f"Missing definition prose for {name!r}"
        desc = defs[name]
        assert isinstance(desc, str) and len(desc) > 60
        lc = desc.lower()
        # All three rules hinge on Glaives being the FIRST upgrade out
        # of the Twilight Council -- the prose must say so.
        assert "first" in lc and "glaive" in lc and "twilight" in lc, (
            f"Definition for {name!r} should describe Glaives-first-off-Twilight"
        )


def test_pvz_build_orders_present():
    """The three new PvZ reference build orders should be in
    build_orders.json under a "PvZ" matchup key."""
    import json
    with open(
        os.path.join(_ROOT, "data", "build_orders.json"),
        "r",
        encoding="utf-8",
    ) as fh:
        data = json.load(fh)
    assert "PvZ" in data["matchups"], "PvZ matchup key missing"
    names = {b["name"] for b in data["matchups"]["PvZ"]}
    assert "Adept Glaives (No Robo)" in names
    assert "Adept Glaives (Robo)" in names
    assert "Stargate into Glaives" in names
