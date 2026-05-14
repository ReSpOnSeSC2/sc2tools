"""Regression: opponent-side Terran 1-base 1-1-1 must not be lumped
into the composition fallback (Bio / Mech / Sky / etc.).

A real PvT replay reported by the user: opponent built a single
CommandCenter, morphed it to OrbitalCommand at 2:11, then went
Barracks (in main) -> Factory (in main, 2:21) -> Starport (in main,
3:28) and held with 1 base for a full 13-minute game. The agent was
tagging this as ``Terran - Bio / Mech / Sky / Stargate Comp``
because:

    1. ``cc_events`` lumped the OrbitalCommand MORPH together with
       the original CommandCenter, so ``second_cc_time`` resolved to
       the OC morph time (131 s) rather than 9999 (= no real 2nd CC).
    2. With ``second_cc_time = 131``, ``fact_time (141) <
       second_cc_time (131)`` was False, so the
       "Terran - 1-1-1 One Base" branch was skipped.
    3. ``fact_time > second_cc_time`` was True, so the rule jumped
       into the "Terran - 1-1-1 Standard" / "Standard Bio Tank"
       branch. With no Engineering Bay on the field by 7:30, the
       chain fell through entirely to the composition fallback.

The fix: count ONLY ``name == "CommandCenter"`` events when
computing ``second_cc_time``. Morphs (OrbitalCommand /
PlanetaryFortress) carry their own name from the event extractor
and represent the same physical building, not a 2nd base. Mirrored
in both detector trees (``reveal-sc2-opponent-main`` is the live
agent; SC2Replay-Analyzer keeps a legacy copy in lockstep).
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


def _one_base_111_replay() -> List[Dict[str, Any]]:
    """Mirror the user-reported replay: 1 Barracks -> 1 Factory ->
    1 Starport, all in the main, OrbitalCommand morph at 2:11, no
    2nd Command Center for the whole 13-minute game."""
    return [
        _building("CommandCenter", 0),
        _building("Barracks", 56),
        _building("Refinery", 61),
        _building("Refinery", 73),
        # Morph (NOT a 2nd CC) — the fix hinges on excluding this.
        _building("OrbitalCommand", 131, subtype="morph"),
        _unit("Reaper", 134),
        _building("Factory", 141),
        _building("SupplyDepot", 153),
        _building("BarracksReactor", 166),
        _building("FactoryTechLab", 206),
        _building("Starport", 208),
        _upgrade("KD8Charge", 221),
        _unit("Marine", 249),
        _unit("Marine", 274),
        _unit("Marine", 274),
        _unit("Medivac", 276),
        _unit("SiegeTank", 291),
        _unit("Marine", 299),
        _unit("Marine", 299),
        _unit("Marine", 324),
        _unit("VikingFighter", 353),
    ]


def test_opponent_one_base_111_classifies_correctly():
    """The canonical bug: the user-reported 1-base 1-1-1 replay must
    classify as ``Terran - 1-1-1 One Base`` and NOT fall through to
    the Bio / Mech / Sky composition fallback."""
    detector = sd.OpponentStrategyDetector(custom_builds=[])
    result = detector.get_strategy_name(
        "Terran", _one_base_111_replay(), matchup="vs Terran",
    )
    assert result == "Terran - 1-1-1 One Base", (
        f"1-base 1-1-1 must classify as Terran - 1-1-1 One Base; "
        f"got {result!r}"
    )


def test_orbital_morph_alone_does_not_count_as_second_cc():
    """A bare Command Center + Orbital morph must leave
    ``second_cc_time`` at 9999 — there is no 2nd base."""
    detector = sd.OpponentStrategyDetector(custom_builds=[])
    # A replay that would ONLY be "1-1-1 One Base" if the morph is
    # ignored — fact_time < second_cc_time only holds when
    # second_cc_time is 9999.
    events = [
        _building("CommandCenter", 0),
        _building("Barracks", 60),
        _building("Refinery", 70),
        _building("OrbitalCommand", 130, subtype="morph"),
        _building("Factory", 140),
        _building("Starport", 200),
        _unit("Marine", 250),
        _unit("Medivac", 300),
    ]
    result = detector.get_strategy_name(
        "Terran", events, matchup="vs Terran",
    )
    assert result == "Terran - 1-1-1 One Base", (
        f"OC morph alone must not be treated as a 2nd CC; got {result!r}"
    )


def test_real_second_cc_still_triggers_one_one_one_standard():
    """A genuine expand (a NEW CommandCenter at the natural) must
    still resolve to ``Terran - 1-1-1 Standard`` — the fix only
    excludes morphs, not real 2nd bases."""
    detector = sd.OpponentStrategyDetector(custom_builds=[])
    events = [
        _building("CommandCenter", 0),
        _building("Barracks", 60),
        _building("Refinery", 70),
        _building("OrbitalCommand", 130, subtype="morph"),
        # GENUINE 2nd CC at the natural (NOT a morph).
        _building("CommandCenter", 140),
        _building("Factory", 200),
        _building("Starport", 280),
        _unit("Marine", 320),
        _unit("Medivac", 360),
    ]
    result = detector.get_strategy_name(
        "Terran", events, matchup="vs Terran",
    )
    assert result == "Terran - 1-1-1 Standard", (
        f"Real 2nd CC + Factory after the expand must classify as "
        f"Terran - 1-1-1 Standard; got {result!r}"
    )


def test_one_base_111_does_not_fall_through_to_comp_fallback():
    """Independent check: the composition fallback must NEVER catch
    a 1-base 1-1-1 replay. Even if the player's late-game tech tree
    blooms into Bio + Mech + Sky units, the 1-base 1-1-1 label fires
    first and the rule chain returns there."""
    detector = sd.OpponentStrategyDetector(custom_builds=[])
    events = _one_base_111_replay()
    # Add late-game units that would otherwise trigger the comp
    # fallback (bio + mech + sky tags).
    events.extend([
        _unit("Marauder", 420),
        _unit("Hellion", 480),
        _unit("Battlecruiser", 720),
    ])
    result = detector.get_strategy_name(
        "Terran", events, matchup="vs Terran",
    )
    assert result == "Terran - 1-1-1 One Base", (
        f"Late-game comp must not override 1-base 1-1-1; got {result!r}"
    )
    assert "Comp" not in result, (
        f"1-base build must not collapse to a composition fallback; "
        f"got {result!r}"
    )
