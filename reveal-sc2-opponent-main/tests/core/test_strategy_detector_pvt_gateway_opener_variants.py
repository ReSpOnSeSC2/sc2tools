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


# -----------------------------------------------------------------------------
# DT Drop must require an actual Dark Templar, not just the tech buildings
# -----------------------------------------------------------------------------
def _robo_first_base() -> List[Dict[str, Any]]:
    """Standard Robo First opener: Robo is the FIRST tech building, no
    Twilight, no Stargate. The Warp Prism is for Immortal / Observer
    drops -- a Robo First's signature unit, not a DT taxi.
    """
    return [
        _building("Nexus", 0),
        _building("Pylon", 18),
        _building("Gateway", 60),
        _building("Assimilator", 72),
        _building("CyberneticsCore", 115),
        _building("Nexus", 130),
        _building("Assimilator", 150),
        _building("Pylon", 170),
        _building("RoboticsFacility", 230),       # Robo FIRST
        _building("Gateway", 280),
        _unit("Immortal", 360),                   # the Robo's first unit
        _unit("WarpPrism", 420),                  # for Immortal drops
        _unit("Immortal", 440),
    ]


def test_robo_first_with_late_dark_shrine_and_warp_prism_is_not_dt_drop():
    """Reported bug (Tourmaline LE, 2026-05-20, 16:48 game): a normal
    Robo First build that added a Dark Shrine for late-game DT support
    and made a Warp Prism for Immortal drops was getting tagged as
    "PvT - DT Drop." The old rule fired on the three buildings/units
    combo alone -- without ever checking that an actual DarkTemplar
    existed. The fix requires a real (non-hallucinated) DT by 10:00
    AND tightens the Dark Shrine window to 8:00, so a late-game DT
    tech addition (Shrine started after 8:00) is excluded too.
    """
    events = _robo_first_base()
    events.append(_building("DarkShrine", 530))   # added at 8:50 -- too late
    # No DarkTemplar units exist anywhere in the events list.
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result != "PvT - DT Drop", (
        f"Robo-First + late Dark Shrine + Warp Prism (for Immortal "
        f"drops) + 0 DTs must NOT classify as PvT - DT Drop; "
        f"got {result!r}"
    )
    assert result == "PvT - Robo First", (
        f"Robo-First should be the natural fall-through label here; "
        f"got {result!r}"
    )


def test_robo_first_with_early_shrine_but_no_dt_is_not_dt_drop():
    """Even if the Dark Shrine lands within the 8:00 window, an
    actual DarkTemplar unit must be on the field by 10:00 for the
    rule to fire. Without the unit-count guard a build that opened
    Robo + WarpPrism + (planned-but-cancelled) DT Shrine would still
    misfire.
    """
    events = _robo_first_base()
    events.append(_building("DarkShrine", 460))   # 7:40 -- within 8:00 window
    # Still 0 DarkTemplar units -- the player committed but never warped one in.
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result != "PvT - DT Drop", (
        f"No DarkTemplar unit exists; build must NOT classify as DT "
        f"Drop on the tech buildings alone; got {result!r}"
    )


def test_canonical_dt_drop_still_classifies():
    """Canonical PvT DT Drop opener calibrated against a real replay
    (Peruano, Taito Citadel LE 2026-05-11). The actual observed
    timings, used as the basis for the rule's cutoffs:
        Dark Shrine started   3:13 (193s)
        RoboticsFacility      3:32 (212s)
        First DarkTemplar     3:51 (231s)
        WarpPrism on field    4:11 (251s)
    Cutoffs (3:45 / 4:00 / 4:30 / 4:45) are observed + ~30s buffer,
    so this canonical replay must still classify with room to spare.
    """
    events = [
        _building("Nexus", 0),
        _building("Pylon", 19),
        _building("Gateway", 37),
        _building("Assimilator", 46),
        _building("Nexus", 78),
        _building("CyberneticsCore", 90),
        _building("Assimilator", 95),
        _building("Pylon", 107),
        _unit("Stalker", 114),
        _building("TwilightCouncil", 148),       # 2:28
        _unit("Sentry", 149),
        _building("DarkShrine", 193),            # 3:13
        _building("Gateway", 203),
        _building("RoboticsFacility", 212),      # 3:32
        _building("Gateway", 220),
        _building("Pylon", 226),
        _building("Assimilator", 231),
        _unit("DarkTemplar", 231),               # 3:51
        _unit("DarkTemplar", 236),
        _unit("WarpPrism", 251),                 # 4:11
        _unit("DarkTemplar", 263),
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result == "PvT - DT Drop", (
        f"Canonical DT Drop opener (Peruano replay timings) must "
        f"still classify as PvT - DT Drop; got "
        f"{result!r}"
    )


def test_dt_drop_rejects_sentry_hallucinated_dark_templar():
    """count_units uses the prereq-aware count_real_units helper, so
    a 'DarkTemplar' event without a Dark Shrine in the buildings list
    is treated as a Sentry hallucination and doesn't satisfy the
    >= 1 DT requirement. Without this guard, a Sentry hallucinated DT
    plus the Dark Shrine + Robo + Prism combo could still misfire."""
    events = _robo_first_base()
    events.append(_building("DarkShrine", 460))   # 7:40 -- within window
    # A "DarkTemplar" event without the prereq being met EARLIER is a
    # hallucination by definition: the unit appeared before the
    # required Dark Shrine existed.
    hallucinated_dt = {
        "type": "unit", "name": "DarkTemplar", "time": 300,  # 5:00 -- before Shrine
        "x": 0.0, "y": 0.0,
    }
    events.append(hallucinated_dt)
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result != "PvT - DT Drop", (
        f"Sentry-hallucinated DarkTemplar must NOT satisfy the DT Drop "
        f"unit-count guard; got {result!r}"
    )


# -----------------------------------------------------------------------------
# X Gate Blink labels count Gateways STARTED BEFORE the 3rd Nexus
# -----------------------------------------------------------------------------
def test_blink_gates_counted_before_third_nexus_not_by_730():
    """The X Gate Blink labels (2/3/4 Gate) name themselves after the
    number of Gateways the player committed to BEFORE taking the 3rd
    Nexus -- the macro-vs-aggression signal -- not the gate count at
    a fixed 7:30 timer. A player who takes a fast 3rd Nexus and then
    pads to 5 Gateways post-expansion is a 3 Gate Blink macro game
    (only 3 Gateways pre-3rd), NOT a 4 Gate Blink (which would imply
    they delayed the 3rd to push out a 4th Gateway).
    """
    events = [
        _building("Nexus", 0),
        _building("Pylon", 18),
        _building("Gateway", 60),                  # Gate 1
        _building("Assimilator", 72),
        _building("CyberneticsCore", 115),
        _building("Nexus", 130),                   # natural at 2:10
        _building("Assimilator", 150),
        _building("Pylon", 170),
        _building("Gateway", 240),                 # Gate 2 -- BEFORE 3rd
        _building("TwilightCouncil", 260),
        _building("Gateway", 300),                 # Gate 3 -- BEFORE 3rd
        _building("Nexus", 340),                   # 3rd Nexus FAST at 5:40
        _building("Gateway", 380),                 # Gate 4 -- AFTER 3rd
        _building("Gateway", 430),                 # Gate 5 -- AFTER 3rd (5 by 7:30)
        _upgrade("BlinkTech", 410),
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    # Old rule: gate_count_730 >= 4 (5 gates by 7:30) -> would be 4 Gate Blink.
    # New rule: gates_before_third_nexus == 3 -> 3 Gate Blink (Macro).
    assert result == "PvT - 3 Gate Blink (Macro)", (
        f"3 Gateways before the 3rd Nexus must classify as 3 Gate "
        f"Blink (Macro), regardless of how many Gateways are added "
        f"after the 3rd; got {result!r}"
    )


def test_blink_four_gates_before_third_nexus_classifies_as_four_gate_blink():
    """Inverse case: a player who delays the 3rd Nexus to push out a
    4th Gateway IS a 4 Gate Blink, even if they only have 4 Gateways
    total (no extra pad after the 3rd lands).
    """
    events = [
        _building("Nexus", 0),
        _building("Pylon", 18),
        _building("Gateway", 60),                  # Gate 1
        _building("Assimilator", 72),
        _building("CyberneticsCore", 115),
        _building("Nexus", 130),                   # natural
        _building("Assimilator", 150),
        _building("Pylon", 170),
        _building("Gateway", 240),                 # Gate 2 -- BEFORE 3rd
        _building("TwilightCouncil", 260),
        _building("Gateway", 300),                 # Gate 3 -- BEFORE 3rd
        _building("Gateway", 360),                 # Gate 4 -- BEFORE 3rd
        _building("Nexus", 420),                   # 3rd Nexus DELAYED to 7:00
        _upgrade("BlinkTech", 400),
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result == "PvT - 4 Gate Blink", (
        f"4 Gateways committed before the 3rd Nexus must classify "
        f"as 4 Gate Blink; got {result!r}"
    )


def test_blink_two_gates_before_third_nexus_with_robo_classifies_as_two_gate():
    """A canonical 2 Gate Blink (Fast 3rd Nexus): exactly 2 Gateways
    are committed before the 3rd Nexus, a Robo is up for Warp Prism
    / Immortal support, Blink lands by 8:00.
    """
    events = [
        _building("Nexus", 0),
        _building("Pylon", 18),
        _building("Gateway", 60),                  # Gate 1
        _building("Assimilator", 72),
        _building("CyberneticsCore", 115),
        _building("Nexus", 130),                   # natural
        _building("Assimilator", 150),
        _building("Pylon", 170),
        _building("Gateway", 240),                 # Gate 2 -- BEFORE 3rd
        _building("TwilightCouncil", 260),
        _building("Nexus", 310),                   # 3rd Nexus at 5:10
        _building("RoboticsFacility", 350),        # Robo by 8:00 ✓
        _building("Gateway", 400),                 # Gate 3 -- AFTER 3rd
        _upgrade("BlinkTech", 420),                # Blink by 8:00 ✓
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result == "PvT - 2 Gate Blink (Fast 3rd Nexus)", (
        f"2 Gateways before 3rd Nexus + Robo + Blink + 3 Nexuses "
        f"must classify as 2 Gate Blink (Fast 3rd Nexus); got "
        f"{result!r}"
    )
