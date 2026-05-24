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
    Cutoffs (4:15 / 4:30 / 5:00 / 5:15) are observed + ~60s buffer,
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


def test_slower_dt_drop_still_classifies_within_60s_buffer():
    """A DT drop that lands ~30s slower than the canonical Peruano
    replay (Dark Shrine at 3:45, Robo at 4:00, first DT at 4:30, Warp
    Prism at 4:45) must still classify -- it sits right inside the
    +60s buffer the rule allows. This catches genuine DT drops that
    are a notch slower than the reference replay (different map, a
    delayed start, etc.) without re-opening the old 8-10 minute
    window that let mid-game DT support builds through.
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
        _building("TwilightCouncil", 148),
        _unit("Sentry", 149),
        _building("DarkShrine", 225),            # 3:45 -- 32s slower than Peruano
        _building("Gateway", 235),
        _building("RoboticsFacility", 240),      # 4:00 -- 28s slower
        _building("Gateway", 250),
        _unit("DarkTemplar", 270),               # 4:30 -- 39s slower
        _unit("WarpPrism", 285),                 # 4:45 -- 34s slower
        _unit("DarkTemplar", 295),
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result == "PvT - DT Drop", (
        f"A slightly slower DT Drop (~30s behind the Peruano replay) "
        f"must still classify within the 60s buffer; got {result!r}"
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


# -----------------------------------------------------------------------------
# Robo First opener with a midgame Stargate transition
# -----------------------------------------------------------------------------
# Reported by the user on the Tourmaline LE 2026-05-20 16:48 replay:
# Gateway → Cyber → Robo at 2:43, then later in the midgame a Stargate
# went down. The previous strict "any Stargate disqualifies Robo First"
# rule shunted this game into the Macro Transition (Unclassified)
# catch-all even though the OPENER was a textbook Robo First. The rule
# now matches the user's mental model: Robo First describes the opener,
# not the entire composition, so a later Stargate transition is a
# tech-switch on top of a Robo First opener — not a different label.
def test_robo_first_opener_with_late_stargate_classifies_as_robo_first():
    """Tourmaline LE 2026-05-20 16:48 replay shape:

        0:19  Pylon
        0:38  Gateway
        0:42  Assimilator
        1:19  Nexus (natural)
        1:30  CyberneticsCore
        1:37  Assimilator
        1:47  Pylon
        1:55  Stalker (unit, from Gateway)
        2:07  WarpGateResearch (upgrade)
        2:20  Sentry (unit, from Gateway)
        2:43  RoboticsFacility       <-- first tech building
        2:53  Phoenix (Sentry hallucination -- no Stargate up yet)
        ...
       ~9:00  Stargate (midgame Skytoss tech-switch on top of Robo)

    The visible build-order timeline in the SPA shows Robo as the
    only tech building inside the opener window. The Stargate goes
    down well after the Robo path is established. Classification
    must reflect the OPENER — Robo First.
    """
    events = [
        _building("Nexus", 0),
        _building("Pylon", 19),
        _building("Gateway", 38),
        _building("Assimilator", 42),
        _building("Nexus", 79),
        _building("CyberneticsCore", 90),
        _building("Assimilator", 97),
        _building("Pylon", 107),
        _unit("Stalker", 115),
        _upgrade("WarpGate", 127),
        _unit("Sentry", 140),
        _building("RoboticsFacility", 163),   # 2:43 -- Robo FIRST
        # Sentry hallucination, not a real Phoenix (no Stargate yet).
        # count_units filters it out via the prereq table, but the
        # event is in the unit log either way.
        _unit("Phoenix", 173),
        _unit("Immortal", 240),
        _unit("WarpPrism", 280),
        _building("Gateway", 300),
        # Midgame Stargate tech-switch (well after Robo path is set)
        _building("Stargate", 540),           # 9:00
        _unit("Phoenix", 600),
        _unit("VoidRay", 720),
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result == "PvT - Robo First", (
        f"Tourmaline LE Robo-opener + midgame Stargate transition "
        f"must classify as PvT - Robo First (the opener was Robo); "
        f"got {result!r}"
    )


def test_robo_first_opener_with_stargate_added_inside_opener_window_still_robo_first():
    """Even a Stargate that lands well inside the opener window
    (e.g. 5:30) does NOT change a Robo-first opener's label as long
    as Robo went down first AND no Phoenix is on the field by 7:00
    (which would route the replay to Phoenix into Robo earlier in
    the chain). The OPENER ordering is what counts.
    """
    events = [
        _building("Nexus", 0),
        _building("Pylon", 18),
        _building("Gateway", 60),
        _building("Assimilator", 72),
        _building("CyberneticsCore", 115),
        _building("Nexus", 130),
        _building("RoboticsFacility", 200),   # Robo FIRST at 3:20
        _building("Stargate", 330),           # Stargate at 5:30 -- still after Robo
        _building("Gateway", 280),
        _unit("Oracle", 380),                  # no Phoenix
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result == "PvT - Robo First", (
        f"Robo-first opener with an early-midgame Stargate addition "
        f"(no Phoenix on the field) must still classify as Robo "
        f"First; got {result!r}"
    )


def test_robo_first_opener_with_later_twilight_and_charge_is_robo_first_not_standard_charge_macro():
    """0.8.0 regression: a Robo-first opener (Robo at 2:43 — first
    tech building) that later adds a Twilight Council for Charge
    support on 3 bases was mis-firing PvT - Standard Charge Macro
    even though the OPENER was Robo. The 0.8.0 Standard Charge Macro
    fix replaced the strict ``not has_building("Stargate", 9999)``
    guard with ``twilight_time < sg_time`` but never required
    ``twilight_time < robo_time``. So a Robo-first build that later
    researched Charge satisfied the rule (sg_time defaults to 9999
    when no Stargate, twilight_time < 9999 trivially) and stole the
    replay before the Robo First branch below could claim it.

    The fix adds the ``twilight_time < robo_time`` ordering check
    so Standard Charge Macro means what its label says: the OPENER
    was Twilight (Twilight before Robo AND before Stargate).
    Robo-first openers fall through to Robo First instead, which
    is the correct label for them — the Charge upgrade is a
    midgame tech-switch on top of a Robo-first opener, not a
    reclassification of it.
    """
    events = [
        _building("Nexus", 0),
        _building("Pylon", 19),
        _building("Gateway", 38),
        _building("Assimilator", 42),
        _building("Nexus", 79),
        _building("CyberneticsCore", 90),
        _building("Assimilator", 97),
        _building("Pylon", 107),
        _unit("Stalker", 115),
        _upgrade("WarpGate", 127),
        _unit("Sentry", 140),
        _building("RoboticsFacility", 163),   # 2:43 -- Robo FIRST
        _unit("Phoenix", 173),                 # Sentry hallucination
        _unit("Immortal", 240),                # Robo path
        _unit("WarpPrism", 280),               # Robo path
        _building("Gateway", 300),
        # Twilight added LATER (after Robo was already the opener)
        _building("TwilightCouncil", 360),     # 6:00 -- well after Robo
        _building("Gateway", 380),
        _upgrade("Charge", 420),               # 7:00
        # 3rd Nexus for the macro game
        _building("Nexus", 450),               # 7:30
        # No Stargate at all -- the 0.8.0 regression case
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result == "PvT - Robo First", (
        f"Robo-first opener with a midgame Twilight + Charge tech-"
        f"switch on 3 bases must classify as Robo First (the OPENER "
        f"was Robo, not Twilight). Standard Charge Macro requires "
        f"Twilight to be the FIRST tech building. Got {result!r}"
    )


# -----------------------------------------------------------------------------
# OPENER semantics sweep — every Twilight-led / Stargate-led label
# requires the labelled tech to be the FIRST tech building. Robo-first
# openers that ADD that tech later in the midgame fall through to
# Robo First, which is the correct label for them.
# -----------------------------------------------------------------------------
def test_robo_first_opener_with_late_blink_and_seven_gates_is_robo_first_not_blink_allin():
    """A Robo-first opener (Robo at 2:43 — first tech building) that
    ends up with 6+ Gateways and researches Blink LATE off a
    midgame Twilight Council is NOT a 7 Gate Blink All-in -- the
    OPENER was Robo. The 7 Gate Blink All-in label is reserved for
    Twilight-FIRST mass-gate commitments. Robo-first builds that
    add 6+ Gateways and Blink fall through to Robo First.
    """
    events = [
        _building("Nexus", 0),
        _building("Pylon", 19),
        _building("Gateway", 38),                # Gate 1
        _building("Assimilator", 42),
        _building("Nexus", 79),                  # natural
        _building("CyberneticsCore", 90),
        _building("Assimilator", 97),
        _building("Pylon", 107),
        _building("RoboticsFacility", 163),      # 2:43 -- Robo FIRST
        _unit("Immortal", 240),
        _building("Gateway", 250),               # Gate 2
        _building("TwilightCouncil", 300),       # 5:00 -- WELL after Robo
        _building("Gateway", 320),               # Gate 3
        _building("Gateway", 360),               # Gate 4
        _building("Gateway", 400),               # Gate 5
        _building("Gateway", 440),               # Gate 6
        _building("Gateway", 480),               # Gate 7
        _upgrade("BlinkTech", 500),              # Blink LATE (8:20)
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result != "PvT - 7 Gate Blink All-in", (
        f"Robo-first opener with late Blink + 7 gates must NOT "
        f"classify as 7 Gate Blink All-in (the OPENER was Robo, "
        f"not Twilight). Got {result!r}"
    )
    assert result == "PvT - Robo First", (
        f"Robo-first opener with a midgame Blink + 7-Gate tech-"
        f"switch must classify as Robo First; got {result!r}"
    )


def test_robo_first_opener_with_late_charge_and_eight_gates_is_robo_first_not_charge_allin():
    """A Robo-first opener that ends up with 7+ Gateways on 2 bases
    and researches Charge LATE is NOT an 8 Gate Charge All-in --
    that label is for Twilight-FIRST 2-base Chargelot commitments.
    """
    events = [
        _building("Nexus", 0),
        _building("Pylon", 19),
        _building("Gateway", 38),                # Gate 1
        _building("Assimilator", 42),
        _building("Nexus", 79),                  # natural -- no 3rd
        _building("CyberneticsCore", 90),
        _building("RoboticsFacility", 163),      # Robo FIRST at 2:43
        _unit("Immortal", 240),
        _building("Gateway", 240),               # Gate 2
        _building("TwilightCouncil", 280),       # WELL after Robo
        _building("Gateway", 300),               # Gate 3
        _building("Gateway", 340),               # Gate 4
        _building("Gateway", 380),               # Gate 5
        _building("Gateway", 420),               # Gate 6
        _building("Gateway", 440),               # Gate 7
        _building("Gateway", 450),               # Gate 8
        _upgrade("Charge", 450),                 # Charge LATE
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result != "PvT - 8 Gate Charge All-in", (
        f"Robo-first opener with 8 gates and late Charge must NOT "
        f"classify as 8 Gate Charge All-in; got {result!r}"
    )
    assert result == "PvT - Robo First", (
        f"Robo-first opener with a midgame Charge + 8-Gate tech-"
        f"switch must classify as Robo First; got {result!r}"
    )


def test_robo_first_opener_with_late_templar_archive_is_robo_first_not_2base_templar():
    """A Robo-first opener that adds a Templar Archives later in
    the midgame for Storm support is NOT a 2 Base Templar build --
    that label is reserved for Twilight-FIRST reactive Storm
    openers with 4-6 gates and a delayed 3rd Nexus.
    """
    events = [
        _building("Nexus", 0),
        _building("Pylon", 19),
        _building("Gateway", 38),                # Gate 1
        _building("Assimilator", 42),
        _building("Nexus", 79),                  # natural -- no 3rd
        _building("CyberneticsCore", 90),
        _building("Assimilator", 97),
        _building("Pylon", 107),
        _building("RoboticsFacility", 163),      # Robo FIRST at 2:43
        _unit("Immortal", 240),
        _building("Gateway", 250),               # Gate 2
        _building("Gateway", 280),               # Gate 3
        _building("Gateway", 320),               # Gate 4
        _building("TwilightCouncil", 360),       # 6:00 -- well after Robo
        _building("TemplarArchive", 420),        # TA at 7:00
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result != "PvT - 2 Base Templar (Reactive/Delayed 3rd)", (
        f"Robo-first opener with a late TA must NOT classify as "
        f"2 Base Templar; got {result!r}"
    )
    assert result == "PvT - Robo First", (
        f"Robo-first opener with a midgame TA tech-switch must "
        f"classify as Robo First; got {result!r}"
    )


def test_robo_first_opener_with_late_blink_and_two_gates_pre_third_is_robo_first_not_2gate_blink():
    """A Robo-first opener (Robo as first tech) with 3+ bases, 2
    Gateways before 3rd Nexus, and a LATE Blink upgrade is NOT a
    "PvT - 2 Gate Blink (Fast 3rd Nexus)" -- that label is for
    Twilight-FIRST 2-Gate Blink openers with Robo as the SECOND
    tech (Observer / Immortal support). Robo-first openers fall
    through to Robo First.
    """
    events = [
        _building("Nexus", 0),
        _building("Pylon", 19),
        _building("Gateway", 38),                # Gate 1 (pre-3rd)
        _building("Assimilator", 42),
        _building("Nexus", 79),                  # natural
        _building("CyberneticsCore", 90),
        _building("Assimilator", 97),
        _building("Pylon", 107),
        _building("RoboticsFacility", 163),      # 2:43 -- Robo FIRST
        _unit("Immortal", 240),
        _building("Gateway", 250),               # Gate 2 (pre-3rd)
        _building("Nexus", 280),                 # 3rd Nexus at 4:40
        # Twilight added LATER, Blink LATE
        _building("TwilightCouncil", 360),       # 6:00 -- after Robo
        _upgrade("BlinkTech", 460),              # Blink at 7:40
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result != "PvT - 2 Gate Blink (Fast 3rd Nexus)", (
        f"Robo-first opener with late Blink must NOT classify as "
        f"2 Gate Blink (Fast 3rd Nexus); got {result!r}"
    )
    assert result == "PvT - Robo First", (
        f"Robo-first opener with a midgame Blink tech-switch must "
        f"classify as Robo First; got {result!r}"
    )


def test_robo_first_opener_with_late_stargate_and_real_phoenix_is_robo_first_not_phoenix_into_robo():
    """A Robo-first opener (Robo at 2:43) that ADDS a Stargate later
    in the midgame and gets a real Phoenix on the field by 7:00 is
    NOT a "Phoenix into Robo" build -- that label is for STARGATE-
    FIRST Phoenix openers that transition into Robo tech. The
    user's Robo-first openers fall through to Robo First instead.
    """
    events = [
        _building("Nexus", 0),
        _building("Pylon", 19),
        _building("Gateway", 38),
        _building("Assimilator", 42),
        _building("Nexus", 79),                  # natural
        _building("CyberneticsCore", 90),
        _building("Assimilator", 97),
        _building("Pylon", 107),
        _building("RoboticsFacility", 163),      # 2:43 -- Robo FIRST
        _unit("Immortal", 240),
        # Stargate added LATER (after Robo was already the opener)
        _building("Stargate", 300),              # 5:00 -- AFTER Robo
        # Real Phoenix from the (real) Stargate
        _unit("Phoenix", 360),                   # 6:00
        _building("Gateway", 380),
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result != "PvT - Phoenix into Robo", (
        f"Robo-first opener with a midgame Stargate + Phoenix must "
        f"NOT classify as Phoenix into Robo (the OPENER was Robo, "
        f"not Stargate). Got {result!r}"
    )
    assert result == "PvT - Robo First", (
        f"Robo-first opener with a midgame Stargate + Phoenix harass "
        f"tech-switch must classify as Robo First; got {result!r}"
    )


def test_robo_first_opener_with_late_stargate_and_phoenix_only_is_robo_first_not_phoenix_opener():
    """Same shape as above but without the Robo follow-up matching
    Phoenix into Robo's signature -- a Robo-first opener with a
    late Stargate must NOT mis-fire Phoenix Opener either. The
    OPENER ordering keeps Stargate-led labels reserved for
    Stargate-first openers.
    """
    events = [
        _building("Nexus", 0),
        _building("Pylon", 19),
        _building("Gateway", 38),                # Gate 1
        _building("Assimilator", 42),
        _building("Nexus", 79),                  # natural
        _building("CyberneticsCore", 90),
        _building("Assimilator", 97),
        _building("Pylon", 107),
        _building("Gateway", 130),               # Gate 2 (early, before Robo)
        _building("RoboticsFacility", 163),      # 2:43 -- Robo FIRST
        _unit("Immortal", 240),
        # Stargate added LATER for Phoenix harass
        _building("Stargate", 300),              # 5:00 -- AFTER Robo
        _unit("Phoenix", 360),                   # 6:00 -- real Phoenix
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result != "PvT - Phoenix Opener", (
        f"Robo-first opener with a midgame Stargate must NOT "
        f"classify as Phoenix Opener (the OPENER was Robo, not "
        f"Stargate). Got {result!r}"
    )


def test_stargate_first_phoenix_into_robo_still_classifies():
    """Positive case: Stargate is the FIRST tech building, Phoenix is
    on the field by 7:00, Robo comes second as a tech follow-up. The
    new ``sg_time < robo_time AND sg_time < twilight_time`` guards
    are satisfied (Stargate at 220, no Twilight, Robo at 320) so
    this canonical Stargate-into-Robo replay still classifies as
    Phoenix into Robo.
    """
    events = [
        _building("Nexus", 0),
        _building("Pylon", 18),
        _building("Gateway", 60),
        _building("Assimilator", 72),
        _building("CyberneticsCore", 115),
        _building("Nexus", 130),
        _building("Assimilator", 150),
        _building("Pylon", 170),
        _building("Stargate", 220),              # Stargate FIRST
        _unit("Phoenix", 280),                    # real Phoenix by 7:00
        _building("RoboticsFacility", 320),      # Robo SECOND
        _building("Gateway", 280),
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result == "PvT - Phoenix into Robo", (
        f"Stargate-first opener with Phoenix + Robo follow-up must "
        f"still classify as Phoenix into Robo; got {result!r}"
    )



# -----------------------------------------------------------------------------
# Reported bug (2026-05-24): two PvT replays mis-tagged "7 Gate Blink All-in"
#   * Old Republic LE  (8:03) -- a macro 3-Gate Blink: fast 3rd Nexus taken
#     BEFORE the extra Gateways were added. Must be "3 Gate Blink (Macro)".
#   * White Rabbit LE (13:43) -- a DT Drop opener that macroed into a
#     multi-Gate Blink composition. Must be "DT Drop".
# -----------------------------------------------------------------------------
def test_fast_third_nexus_macro_blink_is_not_seven_gate_allin():
    """A fast-expand macro Blink build: the player takes a quick 3rd
    Nexus before 6:00 and rallies up to 6+ Gateways by 9:00. Some of
    those Gateways warp in just before the (fast) 3rd Nexus, so the old
    ``fifth_gateway_started < third_nexus_time`` guard alone classified
    it as a 7-Gate Blink All-in. But a sub-6:00 3rd Nexus is a macro
    commitment, never an all-in -- the build must fall through to a
    macro Blink label, not the all-in bucket.
    """
    events = [
        _building("Nexus", 0),
        _building("Pylon", 18),
        _building("Gateway", 60),               # Gate 1
        _building("Assimilator", 72),
        _building("CyberneticsCore", 115),
        _building("Nexus", 130),                # natural
        _building("Gateway", 200),              # Gate 2
        _building("TwilightCouncil", 220),      # FIRST tech building
        _building("Gateway", 260),              # Gate 3
        _building("Gateway", 320),              # Gate 4
        _building("Gateway", 340),              # Gate 5 (before the fast 3rd)
        _building("Nexus", 350),                # 3rd Nexus FAST (5:50, < 6:00)
        _building("Gateway", 460),              # Gate 6 -- 6 Gates by 9:00
        _upgrade("BlinkTech", 300),             # Blink first + by 9:00
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result != "PvT - 7 Gate Blink All-in", (
        f"A fast (sub-6:00) 3rd Nexus marks a macro build, not a "
        f"7-Gate Blink All-in; got {result!r}"
    )
    assert "Blink" in result, (
        f"A Twilight-first Blink build with a fast 3rd Nexus must "
        f"classify as a macro Blink label; got {result!r}"
    )


def test_dt_drop_that_macros_into_blink_is_not_seven_gate_allin():
    """A DT Drop opener (Dark Shrine + Robo + DT + Warp Prism inside
    ~5:15) that transitions into a long macro game with 6+ Gateways and
    Blink by 9:00 must keep its opener label. Before the fix the
    7-Gate Blink All-in rule sat above DT Drop and stole the replay
    because the late-game composition matched the all-in signature.
    """
    events = [
        _building("Nexus", 0),
        _building("Pylon", 19),
        _building("Gateway", 37),               # Gate 1
        _building("Assimilator", 46),
        _building("Nexus", 78),                 # natural
        _building("CyberneticsCore", 90),
        _building("TwilightCouncil", 148),      # FIRST tech building
        _building("DarkShrine", 193),           # 3:13 -- DT-drop signal
        _building("Gateway", 203),              # Gate 2
        _building("RoboticsFacility", 212),     # 3:32
        _unit("DarkTemplar", 231),              # 3:51 -- real DT
        _unit("WarpPrism", 251),                # 4:11 -- the DT taxi
        # ...game goes long: macros into a multi-Gate Blink composition
        _building("Gateway", 300),              # Gate 3
        _building("Gateway", 360),              # Gate 4
        _building("Gateway", 420),              # Gate 5
        _building("Gateway", 480),              # Gate 6 -- 6 Gates by 9:00
        _upgrade("BlinkTech", 460),             # Blink by 9:00
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result == "PvT - DT Drop", (
        f"A DT Drop opener that macroed into a Blink composition must "
        f"keep the DT Drop label, not flip to 7 Gate Blink All-in; "
        f"got {result!r}"
    )
