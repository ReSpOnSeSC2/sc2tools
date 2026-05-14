"""Regression tests for the Terran proxy-Starport-Hellion-drop classifier.

The classifier in core/strategy_detector.py was previously
mis-labelling Yoon-style "proxy Starport + Hellion drop" replays as
"Terran - Proxy 1-1-1". The actual signature is:

    * Reaper-expand (2nd Command Center is started)
    * Factory and Starport are built away from the main base
    * 2+ Hellions are produced before 6:00
    * The FIRST unit produced from the Starport is a Medivac (the bus)

These pure-function tests exercise the rule against the active detector
without requiring sc2reader or a real replay.
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


# Coords: main base sits at (0, 0). _is_proxy() flags > 50 units as a proxy.
MAIN_X, MAIN_Y = 0.0, 0.0
PROXY_X, PROXY_Y = 200.0, 0.0  # well beyond the 50-unit threshold


def _building(
    name: str, time: int, *, x: float = MAIN_X, y: float = MAIN_Y,
) -> Dict[str, Any]:
    return {
        "type": "building", "name": name, "time": time, "x": x, "y": y,
        "subtype": "init",
    }


def _unit(name: str, time: int) -> Dict[str, Any]:
    return {"type": "unit", "name": name, "time": time, "x": 0.0, "y": 0.0}


def _yoon_proxy_starport_hellion_drop_events() -> List[Dict[str, Any]]:
    """The replay sequence shown in the Yoon screenshots, mapped to events."""
    return [
        # Main base + standard reaper-expand opener
        _building("CommandCenter", 0),
        _building("SupplyDepot", 53),
        _building("Barracks", 56),
        _building("Refinery", 60),
        _building("OrbitalCommand", 132),
        _unit("Reaper", 134),
        _building("CommandCenter", 140),  # 2nd CC at natural -> expanded
        _unit("Marine", 176),
        # PROXY Factory + Starport built far from the main base
        _building("Factory", 200, x=PROXY_X, y=PROXY_Y),
        _building("Starport", 246, x=PROXY_X, y=PROXY_Y),
        _building("OrbitalCommand", 252),
        # Two Hellions early off the proxy Factory Reactor
        _unit("Hellion", 265),
        _unit("Hellion", 265),
        _building("BarracksTechLab", 289),
        _unit("Hellion", 295),
        _unit("Hellion", 295),
        # Critical: first Starport unit is a Medivac (the bus)
        _unit("Medivac", 310),
        _building("Barracks", 331),
        _unit("Marine", 335),
        _building("Bunker", 342),
        # Liberator follows AFTER the Medivac
        _unit("Liberator", 363),
        _unit("Marine", 388),
    ]


def test_yoon_proxy_starport_hellion_drop_classifies_correctly():
    detector = sd.OpponentStrategyDetector(custom_builds=[])
    result = detector.get_strategy_name(
        "Terran",
        _yoon_proxy_starport_hellion_drop_events(),
        matchup="vs Terran",
    )
    assert result == "Terran - Proxy Starport Hellion Drop", (
        f"Expected the Yoon proxy Starport Hellion drop label; got {result!r}"
    )


def test_one_base_proxy_111_still_classifies_as_proxy_111():
    """No 2nd CC -> still Proxy 1-1-1 (the original 1-base rule)."""
    events = [
        _building("CommandCenter", 0),
        _building("SupplyDepot", 50),
        _building("Barracks", 60),
        _building("Refinery", 65),
        _building("OrbitalCommand", 130),
        # PROXY Factory + Starport, no 2nd CC
        _building("Factory", 200, x=PROXY_X, y=PROXY_Y),
        _building("Starport", 260, x=PROXY_X, y=PROXY_Y),
        _unit("Hellion", 280),
        _unit("Medivac", 320),
    ]
    detector = sd.OpponentStrategyDetector(custom_builds=[])
    result = detector.get_strategy_name(
        "Terran", events, matchup="vs Terran",
    )
    assert result == "Terran - Proxy 1-1-1", (
        f"One-base proxy 1-1-1 should keep its label; got {result!r}"
    )


def test_proxy_starport_with_banshee_first_is_not_hellion_drop():
    """Proxy Starport opening with Banshee first is the cloak-Banshee
    pressure variant, not a Hellion drop. It must NOT pick up the new
    label even when the player expanded."""
    events = [
        _building("CommandCenter", 0),
        _building("SupplyDepot", 50),
        _building("Barracks", 60),
        _building("Refinery", 65),
        _building("OrbitalCommand", 130),
        _building("CommandCenter", 200),  # expanded
        _building("Factory", 200, x=PROXY_X, y=PROXY_Y),
        _building("Starport", 260, x=PROXY_X, y=PROXY_Y),
        _unit("Hellion", 280),
        _unit("Hellion", 285),
        # First Starport unit is a BANSHEE, not a Medivac
        _unit("Banshee", 300),
    ]
    detector = sd.OpponentStrategyDetector(custom_builds=[])
    result = detector.get_strategy_name(
        "Terran", events, matchup="vs Terran",
    )
    assert result != "Terran - Proxy Starport Hellion Drop", (
        f"Banshee-first proxy must not be tagged as Hellion drop; got {result!r}"
    )


def test_proxy_starport_without_hellions_is_not_hellion_drop():
    """Proxy Starport with Medivac first but NO Hellions is just a
    Medivac/Liberator opener — not a Hellion drop. Must fall back to
    the generic Proxy 1-1-1 label rather than the new one."""
    events = [
        _building("CommandCenter", 0),
        _building("SupplyDepot", 50),
        _building("Barracks", 60),
        _building("Refinery", 65),
        _building("OrbitalCommand", 130),
        _building("CommandCenter", 200),  # expanded
        _building("Factory", 200, x=PROXY_X, y=PROXY_Y),
        _building("Starport", 260, x=PROXY_X, y=PROXY_Y),
        # No Hellions at all
        _unit("Medivac", 310),
    ]
    detector = sd.OpponentStrategyDetector(custom_builds=[])
    result = detector.get_strategy_name(
        "Terran", events, matchup="vs Terran",
    )
    assert result != "Terran - Proxy Starport Hellion Drop", (
        f"No-Hellion case must not tag as Hellion drop; got {result!r}"
    )


def test_proxy_starport_hellion_drop_definition_present_in_catalog():
    """The new strategy must have a description in build_definitions.json
    so the /definitions catalog renders the rule prose for users."""
    import json
    with open(
        os.path.join(_ROOT, "data", "build_definitions.json"),
        "r",
        encoding="utf-8",
    ) as fh:
        defs = json.load(fh)
    assert "Terran - Proxy Starport Hellion Drop" in defs
    desc = defs["Terran - Proxy Starport Hellion Drop"]
    assert isinstance(desc, str) and len(desc) > 40
    # Sanity: description mentions the key signals so future edits don't
    # silently drift away from the detector's actual rule.
    lc = desc.lower()
    for token in ("proxy", "starport", "hellion", "medivac", "command center"):
        assert token in lc, f"Definition prose missing required token: {token!r}"
