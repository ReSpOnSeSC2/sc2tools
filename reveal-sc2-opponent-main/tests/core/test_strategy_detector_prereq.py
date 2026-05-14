"""Anti-hallucination prerequisite tests for the strategy detector.

The strategy_detector module is shared by the live overlay backend
(opponent classification) and the reclassify CLI (user-build
classification). A Sentry's Hallucination ability spawns Phoenix /
HighTemplar / Archon / VoidRay events that look identical to real
production in the event log. These tests assert that the prereq
filter strips those events before any rule fires.

Pure-function tests — no replay parsing — so this runs without
sc2reader installed.
"""
from __future__ import annotations

import os
import sys
import types
from typing import Any, Dict, List

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(os.path.dirname(_HERE))  # reveal-sc2-opponent-main/
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

# Build a minimal `core` package with just the modules the detector
# actually needs. The full `core/__init__.py` eagerly imports modules
# that require optional dependencies (sc2reader, etc.) which are not
# present in the test environment.
import importlib.util  # noqa: E402


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


# -----------------------------------------------------------------------------
# Event helpers (mirror the dict shape produced by core.event_extractor)
# -----------------------------------------------------------------------------
def _building(name: str, time: int, x: float = 0.0, y: float = 0.0) -> Dict[str, Any]:
    return {
        "type": "building", "name": name, "time": time, "x": x, "y": y,
        "subtype": "init",
    }


def _unit(name: str, time: int) -> Dict[str, Any]:
    return {"type": "unit", "name": name, "time": time, "x": 0.0, "y": 0.0}


# -----------------------------------------------------------------------------
# unit_prereq_met / count_real_units
# -----------------------------------------------------------------------------
def test_phoenix_without_stargate_is_hallucination():
    buildings = [
        _building("Nexus", 0),
        _building("CyberneticsCore", 100),
        _building("TwilightCouncil", 200),
    ]
    assert sd.unit_prereq_met("Phoenix", 240, buildings) is False


def test_phoenix_with_stargate_is_real():
    buildings = [_building("Stargate", 220)]
    assert sd.unit_prereq_met("Phoenix", 240, buildings) is True


def test_destroyed_stargate_still_qualifies_later_phoenix():
    # The construction event is recorded permanently; user's clarified
    # rule is "structure must have been built at some point".
    buildings = [_building("Stargate", 240)]
    assert sd.unit_prereq_met("Phoenix", 420, buildings) is True


def test_archon_passes_via_dark_shrine_only():
    buildings = [_building("DarkShrine", 360)]
    assert sd.unit_prereq_met("Archon", 420, buildings) is True


def test_archon_passes_via_templar_archives_only():
    buildings = [_building("TemplarArchive", 360)]
    assert sd.unit_prereq_met("Archon", 420, buildings) is True


def test_archon_without_either_is_hallucination():
    buildings = [_building("Gateway", 60)]
    assert sd.unit_prereq_met("Archon", 420, buildings) is False


def test_count_real_units_drops_hallucinations():
    buildings = [_building("CyberneticsCore", 100)]
    units = [_unit("Phoenix", 200), _unit("Phoenix", 300)]
    assert sd.count_real_units("Phoenix", 420, units, buildings) == 0


def test_count_real_units_keeps_real_phoenix():
    buildings = [_building("Stargate", 200)]
    units = [_unit("Phoenix", 280), _unit("Phoenix", 320)]
    assert sd.count_real_units("Phoenix", 420, units, buildings) == 2


# -----------------------------------------------------------------------------
# UserBuildDetector regression: PvT screenshot scenario
# -----------------------------------------------------------------------------
def _pvt_hallucination_events() -> List[Dict[str, Any]]:
    return [
        _building("Nexus", 0),
        _building("Pylon", 18),
        _building("Gateway", 75),
        _building("Assimilator", 92),
        _building("CyberneticsCore", 115),
        _building("Nexus", 130),
        _building("Pylon", 165),
        _building("Assimilator", 180),
        _building("Gateway", 240),
        _building("TwilightCouncil", 270),
        _building("RoboticsFacility", 320),
        # NO Stargate ever built.
        _unit("Stalker", 200),
        _unit("Sentry", 230),
        _unit("Phoenix", 239),  # Sentry hallucination
        _unit("Stalker", 280),
    ]


def test_pvt_hallucinated_phoenix_does_not_classify_as_phoenix_opener():
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", _pvt_hallucination_events(), my_race="Protoss")
    assert result != "PvT - Phoenix Opener"
    assert result != "PvT - Phoenix into Robo"


def test_pvt_real_stargate_phoenix_classifies_as_phoenix_build():
    events = [
        _building("Nexus", 0),
        _building("Pylon", 18),
        _building("Gateway", 75),
        _building("Assimilator", 92),
        _building("CyberneticsCore", 115),
        _building("Nexus", 130),
        _building("Stargate", 200),
        _building("Gateway", 260),
        _unit("Phoenix", 360),
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert "Phoenix" in result, f"Expected a Phoenix-build classification, got {result!r}"


# -----------------------------------------------------------------------------
# OpponentStrategyDetector composition fallbacks must not flip on hallucinations
# -----------------------------------------------------------------------------
def test_opponent_hallucinated_phoenix_does_not_flip_to_skytoss():
    enemy_events = [
        _building("Nexus", 0),
        _building("Gateway", 75),
        _building("CyberneticsCore", 115),
        _building("TwilightCouncil", 200),
        _building("Forge", 250),
        _building("Nexus", 130),
        # No Stargate, no Carrier-tech path.
        _unit("Sentry", 280),
        _unit("Phoenix", 290),  # hallucination
        _unit("Stalker", 320),
    ]
    detector = sd.OpponentStrategyDetector(custom_builds=[])
    result = detector.get_strategy_name("Protoss", enemy_events, matchup="vs Protoss")
    assert "Skytoss" not in result, (
        f"Hallucinated Phoenix should not classify as Skytoss; got {result!r}"
    )


# -----------------------------------------------------------------------------
# check_custom_rules honours the hallucination filter
# -----------------------------------------------------------------------------
def test_custom_rule_unit_count_drops_hallucinated_phoenix():
    detector = sd.OpponentStrategyDetector(custom_builds=[])
    buildings = [
        _building("Nexus", 0),
        _building("CyberneticsCore", 115),
    ]  # No Stargate.
    units = [_unit("Sentry", 230), _unit("Phoenix", 239)]
    upgrades: List[Dict[str, Any]] = []
    rules_v1 = [{"type": "unit", "name": "Phoenix", "count": 1, "time_lt": 420}]
    assert detector.check_custom_rules(rules_v1, buildings, units, upgrades, (0.0, 0.0)) is False
    rules_v3 = [{"type": "count_min", "name": "BuildPhoenix", "count": 1, "time_lt": 420}]
    assert detector.check_custom_rules(rules_v3, buildings, units, upgrades, (0.0, 0.0)) is False


def test_custom_rule_unit_count_passes_with_real_phoenix():
    detector = sd.OpponentStrategyDetector(custom_builds=[])
    buildings = [_building("Stargate", 200)]
    units = [_unit("Phoenix", 280)]
    upgrades: List[Dict[str, Any]] = []
    rules_v1 = [{"type": "unit", "name": "Phoenix", "count": 1, "time_lt": 420}]
    assert detector.check_custom_rules(rules_v1, buildings, units, upgrades, (0.0, 0.0)) is True
    rules_v3 = [{"type": "count_min", "name": "BuildPhoenix", "count": 1, "time_lt": 420}]
    assert detector.check_custom_rules(rules_v3, buildings, units, upgrades, (0.0, 0.0)) is True


# -----------------------------------------------------------------------------
# Prereq table sanity — keep the catalog in sync across code paths.
# -----------------------------------------------------------------------------
def test_unit_tech_prerequisites_table_is_well_formed():
    table = sd.UNIT_TECH_PREREQUISITES
    assert table, "table cannot be empty"
    for unit_name, alternatives in table.items():
        assert isinstance(unit_name, str) and unit_name
        assert isinstance(alternatives, list) and alternatives
        for req_set in alternatives:
            assert isinstance(req_set, list) and req_set
            for req in req_set:
                assert isinstance(req, str) and req


def test_phoenix_prereq_is_stargate():
    assert sd.UNIT_TECH_PREREQUISITES["Phoenix"] == [["Stargate"]]


def test_carrier_prereq_includes_fleet_beacon():
    flat = [s for alt in sd.UNIT_TECH_PREREQUISITES["Carrier"] for s in alt]
    assert "Stargate" in flat
    assert "FleetBeacon" in flat
