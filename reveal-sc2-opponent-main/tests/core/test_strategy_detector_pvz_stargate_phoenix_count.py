"""Regression tests for the PvZ Stargate Phoenix Stargate-count split.

`PvZ - 2 Stargate Phoenix` must fire ONLY for exactly 2 Stargates;
`PvZ - 3 Stargate Phoenix` covers 3+ Stargates. The old rule wrote
the 2-Stargate condition as ``sg_count >= 2`` which was only correct
by accident (the 3+ check ran first and short-circuited 3-Stargate
replays). Locked in by these tests.

Pure-function tests — no replay parsing — so this runs without
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


def _base_pvz_opener_with_stargates(n_stargates: int) -> List[Dict[str, Any]]:
    """Two-base Stargate Phoenix shell with ``n_stargates`` Stargates."""
    events: List[Dict[str, Any]] = [
        _building("Nexus", 0),
        _building("Pylon", 18),
        _building("Gateway", 60),
        _building("Assimilator", 72),
        _building("CyberneticsCore", 115),
        _building("Nexus", 130),       # 2nd Nexus by 10:00
        _building("Assimilator", 150),
    ]
    # Stargates — staggered so they all land before 10:00 (600s).
    base_t = 220
    for i in range(n_stargates):
        events.append(_building("Stargate", base_t + i * 40))
    # 4+ Phoenix produced before 10:00 (Stargate prereq is satisfied).
    for t in (260, 300, 340, 380):
        events.append(_unit("Phoenix", t))
    return events


def test_exactly_two_stargates_classifies_as_2_stargate_phoenix():
    events = _base_pvz_opener_with_stargates(2)
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Zerg", events, my_race="Protoss")
    assert result == "PvZ - 2 Stargate Phoenix", (
        f"Exactly 2 Stargates must classify as 2 Stargate Phoenix; "
        f"got {result!r}"
    )


def test_three_stargates_classifies_as_3_stargate_phoenix_not_2():
    events = _base_pvz_opener_with_stargates(3)
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Zerg", events, my_race="Protoss")
    assert result == "PvZ - 3 Stargate Phoenix", (
        f"3 Stargates must classify as 3 Stargate Phoenix; got {result!r}"
    )


def test_four_stargates_also_classifies_as_3_stargate_phoenix():
    """4+ Stargates still falls under the 3+ rule — there's no 4-Stargate
    Phoenix label."""
    events = _base_pvz_opener_with_stargates(4)
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Zerg", events, my_race="Protoss")
    assert result == "PvZ - 3 Stargate Phoenix", (
        f"4 Stargates must classify as 3 Stargate Phoenix; got {result!r}"
    )


def test_one_stargate_does_not_classify_as_2_stargate_phoenix():
    """A single Stargate with Phoenix is a Stargate opener — NOT the
    2-Stargate Phoenix label. Must NOT mis-fire."""
    events = _base_pvz_opener_with_stargates(1)
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Zerg", events, my_race="Protoss")
    assert result != "PvZ - 2 Stargate Phoenix", (
        f"1 Stargate must NOT tag as 2 Stargate Phoenix; got {result!r}"
    )


def test_2_stargate_phoenix_definition_says_exactly_two():
    """The /definitions prose must say "EXACTLY 2 Stargates" so the
    catalog matches what the rule actually fires on."""
    import json
    with open(
        os.path.join(_ROOT, "data", "build_definitions.json"),
        "r",
        encoding="utf-8",
    ) as fh:
        defs = json.load(fh)
    desc = defs["PvZ - 2 Stargate Phoenix"]
    # Lower-case match so future capitalisation tweaks don't break the test.
    assert "exactly 2" in desc.lower(), (
        f"Description must specify exactly-2 Stargates; got {desc!r}"
    )
