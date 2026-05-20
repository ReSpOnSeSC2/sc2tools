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


def test_blink_first_then_charge_on_three_bases_classifies_as_blink_not_charge_macro():
    """Reported bug (Taito Citadel / Ruby Rock screenshots, 2026-05-19):
    a 3-base macro game where Blink is researched FIRST and Charge is
    researched later (both before 9:00) used to fall through to the
    Standard Charge Macro rule because that rule only checked
    ``has_upgrade_substr("Charge", 540) + 3+ Nexuses + no Stargate``,
    ignoring which upgrade was started first. The first-Twilight-
    upgrade guard added to Standard Charge Macro must keep the build
    from mistagging -- Blink-first on 3 bases must classify as one of
    the Blink labels, mirroring the Charge-vs-Blink ordering enforced
    on the 3 Gate Charge Opener rule below it.
    """
    events = _twilight_first_base()
    events.append(_building("Nexus", 380))      # 3rd Nexus -- macro signal
    events.append(_upgrade("BlinkTech", 340))   # Blink FIRST
    events.append(_upgrade("Charge", 500))      # Charge later, still by 9:00
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert "Blink" in result, (
        f"Blink-first on 3 bases must classify as a Blink build, not "
        f"Standard Charge Macro; got {result!r}"
    )
    assert result != "PvT - Standard Charge Macro", (
        f"Standard Charge Macro must require Charge to be the first "
        f"Twilight upgrade; got {result!r}"
    )


# -----------------------------------------------------------------------------
# All-in rules must require the matching upgrade to be the FIRST Twilight upgrade
# -----------------------------------------------------------------------------
def test_seven_gate_blink_allin_requires_blink_to_be_first_upgrade():
    """7 Gate Blink All-in keys on a 2-base 6+ Gateway + Blink commitment.
    A player who researched Charge or Glaives first and only researched
    Blink LATER is not committing to a Blink all-in -- the upgrade
    ordering identifies the build. Without this guard, an Adept-Glaives
    push that picked up Blink late used to flip the label to a Blink
    all-in.
    """
    events = [
        _building("Nexus", 0),
        _building("Pylon", 18),
        _building("Gateway", 60),
        _building("Assimilator", 72),
        _building("CyberneticsCore", 115),
        _building("Nexus", 130),                # natural -- no 3rd
        _building("Assimilator", 150),
        _building("Pylon", 170),
        _building("Gateway", 240),
        _building("TwilightCouncil", 260),
        _building("Gateway", 300),
        _building("Gateway", 340),
        _building("Gateway", 380),
        _building("Gateway", 420),
        _building("Gateway", 460),              # 7 Gateways by 9:00
        _upgrade("Charge", 320),                # Charge FIRST off Twilight
        _upgrade("BlinkTech", 500),             # Blink later
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result != "PvT - 7 Gate Blink All-in", (
        f"Charge-first build must NOT classify as 7 Gate Blink All-in; "
        f"got {result!r}"
    )


def test_eight_gate_charge_allin_requires_charge_to_be_first_upgrade():
    """8 Gate Charge All-in keys on a 2-base 7+ Gateway + Charge
    commitment. A Blink-first / Charge-later build with the same
    Gateway count is not a Chargelot all-in -- the player committed to
    Stalkers first.
    """
    events = [
        _building("Nexus", 0),
        _building("Pylon", 18),
        _building("Gateway", 60),
        _building("Assimilator", 72),
        _building("CyberneticsCore", 115),
        _building("Nexus", 130),                # natural -- no 3rd
        _building("Assimilator", 150),
        _building("Pylon", 170),
        _building("Gateway", 200),
        _building("TwilightCouncil", 230),
        _building("Gateway", 280),
        _building("Gateway", 320),
        _building("Gateway", 360),
        _building("Gateway", 400),
        _building("Gateway", 440),              # 8 Gateways by 7:30
        _upgrade("BlinkTech", 280),             # Blink FIRST off Twilight
        _upgrade("Charge", 470),                # Charge later
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result != "PvT - 8 Gate Charge All-in", (
        f"Blink-first build must NOT classify as 8 Gate Charge All-in; "
        f"got {result!r}"
    )


# -----------------------------------------------------------------------------
# 7 Gate Blink All-in vs 3-base Blink Macro discrimination
# -----------------------------------------------------------------------------
def test_seven_gate_blink_allin_blocked_when_third_nexus_before_fifth_gateway():
    """A 3-base Blink macro game that adds mass Gateways (6+ by 9:00)
    used to get mistagged as 'PvT - 7 Gate Blink All-in' because the
    rule only checked Blink + Gateway count. The fix disqualifies any
    replay where the 3rd Nexus was taken BEFORE the 5th Gateway -- the
    economy commitment marks it as macro, not all-in. Regression for
    https://github.com/responsesc2/sc2tools/issues report: macro 3-Nexus
    Blink into 8 Gateways lumping into the 7-Gate All-in bucket."""
    events = [
        _building("Nexus", 0),
        _building("Pylon", 18),
        _building("Gateway", 60),               # Gate 1
        _building("Assimilator", 72),
        _building("CyberneticsCore", 115),
        _building("Nexus", 130),                # Natural
        _building("Assimilator", 150),
        _building("Pylon", 170),
        _building("Gateway", 240),              # Gate 2
        _building("TwilightCouncil", 260),
        _building("Nexus", 310),                # 3rd Nexus BEFORE 5th Gate
        _building("Gateway", 360),              # Gate 3
        _building("Gateway", 400),              # Gate 4
        _building("Gateway", 440),              # Gate 5 (after 3rd Nexus)
        _building("Gateway", 470),              # Gate 6
        _upgrade("BlinkTech", 460),
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result != "PvT - 7 Gate Blink All-in", (
        f"3rd Nexus before 5th Gateway must NOT classify as 7-Gate Blink "
        f"All-in; got {result!r}"
    )


def test_seven_gate_blink_allin_still_fires_for_two_base_mass_gates():
    """The canonical 2-base 7-Gate Blink All-in must still classify
    correctly: Blink by 9:00, 6+ Gateways by 9:00, and NO 3rd Nexus
    before the 5th Gateway (here, no 3rd Nexus at all)."""
    events = [
        _building("Nexus", 0),
        _building("Pylon", 18),
        _building("Gateway", 60),               # Gate 1
        _building("Assimilator", 72),
        _building("CyberneticsCore", 115),
        _building("Nexus", 130),                # Natural -- no 3rd
        _building("Assimilator", 150),
        _building("Pylon", 170),
        _building("Gateway", 240),              # Gate 2
        _building("TwilightCouncil", 260),
        _building("Gateway", 300),              # Gate 3
        _building("Gateway", 340),              # Gate 4
        _building("Gateway", 380),              # Gate 5
        _building("Gateway", 420),              # Gate 6
        _building("Gateway", 460),              # Gate 7
        _upgrade("BlinkTech", 460),
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result == "PvT - 7 Gate Blink All-in", (
        f"2-base 6+ Gateway Blink build must classify as 7-Gate Blink "
        f"All-in; got {result!r}"
    )


# -----------------------------------------------------------------------------
# Production-style event flow: each building emits subtype="init" at
# construction start AND subtype="born" ~build_time later when complete.
# The detectors must read START times and ignore later born events.
# -----------------------------------------------------------------------------
def _building_born(name: str, time: int):
    """Production-style construction-COMPLETED event. Real sc2reader
    replays emit one of these per building ~build_time after the init
    event. Detectors must NOT count these toward Gateway / Nexus
    tallies."""
    return {
        "type": "building", "name": name, "time": time, "x": 0.0, "y": 0.0,
        "subtype": "born",
    }


def test_seven_gate_blink_allin_ignores_born_events_for_count_and_index():
    """Production-realistic event stream: each Protoss building emits
    BOTH an "init" (construction-start) and a "born" (construction-
    complete) event. A naive `sum(1 for b in ... if name == X)` would
    double-count, and a naive `sorted([b["time"] ... ])[2]` for Nexuses
    can resolve to a 2nd Nexus's BORN time instead of the 3rd Nexus's
    INIT time.

    Scenario: 2-base 6-Gate Blink that adds the 3rd Nexus LATE (after
    Gateways 5-6 are already underway). The build IS a 7-Gate Blink
    all-in -- player committed mass Gates before taking the 3rd. Born
    events for early Gateways and the 2nd Nexus must not push the rule
    into the macro bucket."""
    events = [
        _building("Nexus", 0),                          # main (init at 0)
        _building_born("Nexus", 0),                     # main born too
        _building("Pylon", 18),
        _building("Gateway", 60),                       # Gate 1 init
        _building_born("Gateway", 125),                 # Gate 1 born
        _building("Assimilator", 72),
        _building("CyberneticsCore", 115),
        _building("Nexus", 270),                        # 2nd Nexus init
        _building_born("Nexus", 370),                   # 2nd Nexus born
        _building("Gateway", 240),                      # Gate 2 init
        _building_born("Gateway", 305),                 # Gate 2 born
        _building("TwilightCouncil", 260),
        _building("Gateway", 300),                      # Gate 3
        _building("Gateway", 340),                      # Gate 4
        _building("Gateway", 380),                      # Gate 5 -- BEFORE 3rd
        _building("Gateway", 420),                      # Gate 6 -- BEFORE 3rd
        _building("Nexus", 500),                        # 3rd Nexus LATE
        _building_born("Nexus", 600),                   # 3rd Nexus born
        _building("Gateway", 460),                      # Gate 7
        _upgrade("BlinkTech", 460),
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result == "PvT - 7 Gate Blink All-in", (
        f"5 Gateways started BEFORE the 3rd Nexus must classify as "
        f"7-Gate Blink All-in even when production-style \"born\" "
        f"events are present; got {result!r}"
    )


def test_seven_gate_blink_allin_blocked_when_gateways_added_during_third_nexus_build():
    """The 3rd Nexus is taken at 6:00 (= 360s) and takes ~100s to
    finish (born at 460). The player keeps adding Gateways DURING the
    3rd Nexus's construction (Gates 5-7 init at 380, 420, 460). The
    build is macro, not all-in: \"taken\" the 3rd Nexus means
    construction STARTED (at 360), not finished. The 5th Gateway
    (init at 380) is AFTER the 3rd Nexus broke ground (360), so the
    rule must NOT classify this as 7-Gate Blink All-in.

    Without the start-time-only semantic, the 3rd Nexus's BORN event
    at 460 would slip into the sorted Nexus list as the 3rd-indexed
    entry, the rule would compare 5th Gateway (380) < 460 (=2nd
    Nexus born time, NOT 3rd init time), and mis-classify as all-in.
    """
    events = [
        _building("Nexus", 0),
        _building_born("Nexus", 0),
        _building("Pylon", 18),
        _building("Gateway", 60),
        _building_born("Gateway", 125),
        _building("Assimilator", 72),
        _building("CyberneticsCore", 115),
        _building("Nexus", 270),                        # 2nd Nexus init
        _building_born("Nexus", 370),                   # 2nd Nexus born
        _building("Gateway", 240),
        _building_born("Gateway", 305),
        _building("TwilightCouncil", 260),
        _building("Gateway", 300),                      # Gate 3
        _building("Gateway", 340),                      # Gate 4
        _building("Nexus", 360),                        # 3rd Nexus STARTED at 6:00
        _building("Gateway", 380),                      # Gate 5 -- AFTER 3rd start
        _building("Gateway", 420),                      # Gate 6 (3rd still building)
        _building_born("Nexus", 460),                   # 3rd Nexus born
        _building("Gateway", 460),                      # Gate 7
        _upgrade("BlinkTech", 470),
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result != "PvT - 7 Gate Blink All-in", (
        f"Gateways added DURING 3rd Nexus construction must NOT "
        f"classify as 7-Gate Blink All-in -- the 3rd Nexus STARTED "
        f"before the 5th Gateway, which marks the build as macro; "
        f"got {result!r}"
    )
