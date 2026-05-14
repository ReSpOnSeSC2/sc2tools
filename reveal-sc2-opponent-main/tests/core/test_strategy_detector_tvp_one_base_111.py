"""Regression tests for the TvP 1-base 1-1-1 all-in classifier.

The detector now emits "TvP - 1-1-1 One Base" from `detect_my_build`
when the player is Terran in TvP and a Barracks + Factory + Starport
are all built BEFORE the 2nd Command Center, with none of the three
proxied (i.e. they sit inside the main base). This is the classic
Terran 1-base 1-1-1 all-in vs Protoss.

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


MAIN_X, MAIN_Y = 0.0, 0.0
PROXY_X, PROXY_Y = 200.0, 0.0  # beyond the 50-unit proxy threshold


def _building(name: str, time: int, *, x: float = MAIN_X, y: float = MAIN_Y) -> Dict[str, Any]:
    return {
        "type": "building", "name": name, "time": time, "x": x, "y": y,
        "subtype": "init",
    }


def test_tvp_one_base_111_classifies():
    """All three production buildings before the 2nd CC, no proxies."""
    events = [
        _building("CommandCenter", 0),
        _building("SupplyDepot", 50),
        _building("Barracks", 60),
        _building("Refinery", 65),
        _building("Refinery", 80),
        _building("OrbitalCommand", 130),
        _building("Factory", 200),    # in main
        _building("Starport", 290),   # in main
        # No 2nd CC at any point during the all-in window
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Protoss", events, my_race="Terran")
    assert result == "TvP - 1-1-1 One Base", (
        f"Expected TvP 1-base 1-1-1; got {result!r}"
    )


def test_tvp_one_base_111_negative_with_second_cc_before_starport():
    """If the 2nd CC goes down before the Starport, this is not a 1-base
    all-in — the player has expanded. Must NOT tag as one-base 1-1-1."""
    events = [
        _building("CommandCenter", 0),
        _building("Barracks", 60),
        _building("OrbitalCommand", 130),
        _building("Factory", 200),
        _building("CommandCenter", 140),  # 2nd CC EARLY (expanded)
        _building("Starport", 320),       # Starport AFTER 2nd CC
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Protoss", events, my_race="Terran")
    assert result != "TvP - 1-1-1 One Base", (
        f"Expanding 1-1-1 must NOT tag as one-base 1-1-1; got {result!r}"
    )


def test_tvp_one_base_111_negative_when_factory_is_proxied():
    """If Factory is built far from the main (proxied), this is a
    proxy 1-1-1 not the one-base in-main variant. Must NOT match."""
    events = [
        _building("CommandCenter", 0),
        _building("Barracks", 60),
        _building("OrbitalCommand", 130),
        # Factory is PROXIED (far from main)
        _building("Factory", 200, x=PROXY_X, y=PROXY_Y),
        _building("Starport", 290, x=PROXY_X, y=PROXY_Y),
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Protoss", events, my_race="Terran")
    assert result != "TvP - 1-1-1 One Base", (
        f"Proxy 1-1-1 must NOT tag as one-base 1-1-1; got {result!r}"
    )


def test_tvp_one_base_111_only_fires_for_vs_protoss():
    """The rule is TvP-specific. The same building sequence in TvT or
    TvZ must NOT emit "TvP - 1-1-1 One Base"."""
    events = [
        _building("CommandCenter", 0),
        _building("Barracks", 60),
        _building("OrbitalCommand", 130),
        _building("Factory", 200),
        _building("Starport", 290),
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result_tvz = detector.detect_my_build("vs Zerg", events, my_race="Terran")
    assert result_tvz != "TvP - 1-1-1 One Base", (
        f"TvZ must NOT tag as TvP one-base 1-1-1; got {result_tvz!r}"
    )
    result_tvt = detector.detect_my_build("vs Terran", events, my_race="Terran")
    assert result_tvt != "TvP - 1-1-1 One Base", (
        f"TvT must NOT tag as TvP one-base 1-1-1; got {result_tvt!r}"
    )


def test_tvp_one_base_111_definition_present_in_catalog():
    import json
    with open(
        os.path.join(_ROOT, "data", "build_definitions.json"),
        "r",
        encoding="utf-8",
    ) as fh:
        defs = json.load(fh)
    assert "TvP - 1-1-1 One Base" in defs
    lc = defs["TvP - 1-1-1 One Base"].lower()
    for token in ("barracks", "factory", "starport", "command center", "all-in"):
        assert token in lc, f"Definition missing key token: {token!r}"
