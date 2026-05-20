"""Regression tests for the four PvT Stargate-prefixed classifiers.

The detector in core/strategy_detector.py now distinguishes the
specific Stargate paths by WHICH upgrade is researched first out of
the Twilight Council:

    * "PvT - Stargate into Charge"   -- Charge first off Twilight
    * "PvT - Stargate into Glaives"  -- Resonating Glaives first
    * "PvT - Stargate into Blink"    -- Blink first
    * "PvT - Stargate Opener"        -- catch-all: Stargate is the
                                        first tech building, no other
                                        more specific Stargate variant
                                        matched

The Stargate unit produced (Phoenix / Oracle / Void Ray) does NOT
matter for the three "Stargate into X" labels — only the upgrade
order does. The three specific rules sit ABOVE Phoenix Opener /
Phoenix into Robo so a Stargate-Phoenix opener that researches
Glaives first gets the more informative tag.

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


def _upgrade(name: str, time: int) -> Dict[str, Any]:
    return {"type": "upgrade", "name": name, "time": time}


def _stargate_opener_base() -> List[Dict[str, Any]]:
    """Shared prefix: Nexus, Pylon, Gateway, Assim, Cyber, natural
    Nexus, Stargate as the FIRST tech building."""
    return [
        _building("Nexus", 0),
        _building("Pylon", 18),
        _building("Gateway", 60),
        _building("Assimilator", 72),
        _building("CyberneticsCore", 115),
        _building("Nexus", 130),
        _building("Assimilator", 150),
        _building("Pylon", 170),
        _building("Stargate", 220),       # FIRST tech building
    ]


# -----------------------------------------------------------------------------
# Stargate into Charge
# -----------------------------------------------------------------------------
def test_stargate_into_charge_classifies():
    events = _stargate_opener_base()
    events.append(_building("TwilightCouncil", 320))  # AFTER Stargate
    events.append(_building("Gateway", 280))
    events.append(_building("Gateway", 340))
    # FIRST upgrade out of Twilight is Charge
    events.append(_upgrade("Charge", 360))
    # Stargate unit (any) — the rule must not depend on it
    events.append(_unit("Oracle", 280))
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result == "PvT - Stargate into Charge", (
        f"Expected Stargate into Charge; got {result!r}"
    )


# -----------------------------------------------------------------------------
# Stargate into Glaives
# -----------------------------------------------------------------------------
def test_stargate_into_glaives_classifies_with_phoenix():
    """The user explicitly noted Stargate into Glaives is often
    accompanied by Phoenix. The presence of Phoenix MUST NOT push it
    into the older "Phoenix Opener" tag; the Glaives-first signal wins."""
    events = _stargate_opener_base()
    events.append(_building("TwilightCouncil", 320))
    events.append(_building("Gateway", 280))
    events.append(_building("Gateway", 340))
    events.append(_upgrade("AdeptPiercingAttack", 360))  # raw sc2reader name
    # Phoenix on the field — should NOT flip the label to Phoenix Opener
    events.append(_unit("Phoenix", 340))
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result == "PvT - Stargate into Glaives", (
        f"Phoenix-and-Glaives must classify as Stargate into Glaives; "
        f"got {result!r}"
    )


def test_stargate_into_glaives_with_oracle_also_classifies():
    """Stargate unit doesn't matter — Oracle path also lands on the
    Glaives label as long as Glaives is the first upgrade."""
    events = _stargate_opener_base()
    events.append(_building("TwilightCouncil", 320))
    events.append(_building("Gateway", 280))
    events.append(_upgrade("AdeptPiercingAttack", 360))
    events.append(_unit("Oracle", 280))
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result == "PvT - Stargate into Glaives", (
        f"Oracle-and-Glaives must classify as Stargate into Glaives; "
        f"got {result!r}"
    )


# -----------------------------------------------------------------------------
# Stargate into Blink
# -----------------------------------------------------------------------------
def test_stargate_into_blink_classifies():
    events = _stargate_opener_base()
    events.append(_building("TwilightCouncil", 320))
    events.append(_building("Gateway", 280))
    events.append(_building("Gateway", 340))
    # Blink is first upgrade
    events.append(_upgrade("BlinkTech", 360))
    events.append(_unit("Phoenix", 280))
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result == "PvT - Stargate into Blink", (
        f"Expected Stargate into Blink; got {result!r}"
    )


def test_stargate_into_blink_loses_if_glaives_starts_first():
    """If Glaives starts before Blink, the build is Stargate into
    Glaives — the upgrade-order signal is what differentiates the
    three Stargate variants."""
    events = _stargate_opener_base()
    events.append(_building("TwilightCouncil", 320))
    events.append(_building("Gateway", 280))
    events.append(_upgrade("AdeptPiercingAttack", 350))
    events.append(_upgrade("BlinkTech", 420))  # Blink LATER
    events.append(_unit("Phoenix", 280))
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result == "PvT - Stargate into Glaives", (
        f"Glaives-first must win over Blink-later; got {result!r}"
    )


# -----------------------------------------------------------------------------
# Stargate Opener (catch-all)
# -----------------------------------------------------------------------------
def test_stargate_opener_fires_when_no_specific_match():
    """Stargate is first tech, no Twilight upgrade ever, no Phoenix in
    play, no Proxy. Must fall to the generic Stargate Opener catch-all
    rather than the Macro Transition (Unclassified) bucket."""
    events = _stargate_opener_base()
    # No Twilight, no Robo, no upgrades, no Phoenix.
    events.append(_building("Gateway", 280))
    events.append(_unit("Oracle", 280))
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result == "PvT - Stargate Opener", (
        f"Expected Stargate Opener catch-all; got {result!r}"
    )


def test_robo_first_pure_path_with_no_stargate_classifies():
    """Robo built first AND no Stargate ever — the canonical Robo
    First opener. The Stargate Opener catch-all must NOT clobber it.
    (Mixed Robo+Sg cases are covered separately by
    ``test_robo_first_does_not_fire_when_stargate_exists`` below — the
    user's rule is "any Stargate disqualifies Robo First".)"""
    events = [
        _building("Nexus", 0),
        _building("Pylon", 18),
        _building("Gateway", 60),
        _building("Assimilator", 72),
        _building("CyberneticsCore", 115),
        _building("Nexus", 130),
        # Robotics Facility — first AND only tech building
        _building("RoboticsFacility", 200),
        _building("Gateway", 280),
        # No Stargate ever
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result == "PvT - Robo First", (
        f"Pure Robo opener (no Stargate) must classify as Robo First; got {result!r}"
    )


def test_stargate_opener_does_not_fire_when_twilight_first():
    """If Twilight is the first tech building, this is not a Stargate
    Opener even if a Stargate comes later. Must NOT mis-label."""
    events = [
        _building("Nexus", 0),
        _building("Pylon", 18),
        _building("Gateway", 60),
        _building("Assimilator", 72),
        _building("CyberneticsCore", 115),
        _building("Nexus", 130),
        # Twilight FIRST
        _building("TwilightCouncil", 200),
        # Stargate LATER
        _building("Stargate", 320),
        _building("Gateway", 280),
        _upgrade("Charge", 240),
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result != "PvT - Stargate Opener", (
        f"Twilight-first must NOT classify as Stargate Opener; got {result!r}"
    )


# -----------------------------------------------------------------------------
# Robo-tech-before-Twilight guard
# -----------------------------------------------------------------------------
# If a Robotics Facility / Immortal / Robotics Bay lands BEFORE the
# Twilight Council, the build committed to a Robo path — those replays
# are Phoenix into Robo (or Robo First / Standard Charge Macro), NOT
# Twilight-led Stargate-into-X. Verified end-to-end against the actual
# rule chain: the disqualified replays should reach the Phoenix into
# Robo branch (or a later catch-all) instead of stealing the
# Stargate-into-X label.
def test_stargate_then_robo_then_twilight_charge_is_phoenix_into_robo():
    """The bug the user reported: Stargate -> Phoenix -> Robo -> Immortal
    -> Twilight -> Charge was getting tagged as "Stargate into Charge"
    because the Twilight + Charge signal fired before Phoenix-into-Robo
    got a chance to. With the Robo-tech guard, the Stargate-into-X
    rule is skipped and Phoenix-into-Robo correctly takes the replay."""
    events = _stargate_opener_base()
    # Phoenix harass off the Stargate
    events.append(_unit("Phoenix", 280))
    # Robotics Facility BEFORE the Twilight Council
    events.append(_building("RoboticsFacility", 290))
    events.append(_unit("Immortal", 340))  # Immortal also lands first
    # Twilight Council, THEN Charge research
    events.append(_building("TwilightCouncil", 360))
    events.append(_building("Gateway", 280))
    events.append(_building("Gateway", 340))
    events.append(_upgrade("Charge", 400))
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result == "PvT - Phoenix into Robo", (
        f"Stargate -> Robo -> Twilight -> Charge must tag as Phoenix into "
        f"Robo, not Stargate into Charge; got {result!r}"
    )


def test_stargate_then_immortal_blocks_stargate_into_glaives():
    """An Immortal lands before the Twilight Council means a Robo was up
    first (Immortal requires Robotics Facility). Disqualifies all three
    Stargate-into-X labels even when Glaives is the first Twilight
    upgrade."""
    events = _stargate_opener_base()
    events.append(_unit("Phoenix", 280))
    events.append(_building("RoboticsFacility", 290))
    events.append(_unit("Immortal", 330))  # Immortal before Twilight
    events.append(_building("TwilightCouncil", 360))
    events.append(_building("Gateway", 320))
    events.append(_upgrade("AdeptPiercingAttack", 400))  # Glaives first
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert "Stargate into" not in result, (
        f"Immortal-before-Twilight must NOT classify as Stargate-into-X; "
        f"got {result!r}"
    )


def test_stargate_then_robobay_blocks_stargate_into_blink():
    """A Robotics Bay (Colossus / Disruptor tech) before the Twilight
    Council is an even stronger commitment to a Robo path than a bare
    Robotics Facility. Disqualifies Stargate-into-Blink even if Blink
    research is the first Twilight upgrade."""
    events = _stargate_opener_base()
    events.append(_unit("Phoenix", 280))
    events.append(_building("RoboticsFacility", 290))
    events.append(_building("RoboticsBay", 330))  # RoboBay before Twilight
    events.append(_building("TwilightCouncil", 360))
    events.append(_building("Gateway", 320))
    events.append(_upgrade("BlinkTech", 400))
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert "Stargate into" not in result, (
        f"RoboBay-before-Twilight must NOT classify as Stargate-into-X; "
        f"got {result!r}"
    )


def test_robo_after_twilight_still_allows_stargate_into_x():
    """The guard fires on Robo-tech BEFORE Twilight only. A Robo that
    lands AFTER the Twilight Council does NOT disqualify Stargate-
    into-X — that's a legitimate Twilight-led macro game with Robo
    follow-up tech."""
    events = _stargate_opener_base()
    events.append(_unit("Phoenix", 280))
    events.append(_building("TwilightCouncil", 320))  # Twilight FIRST
    events.append(_building("Gateway", 280))
    events.append(_upgrade("Charge", 360))            # Charge first
    events.append(_building("RoboticsFacility", 400))  # Robo AFTER
    events.append(_unit("Immortal", 460))
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result == "PvT - Stargate into Charge", (
        f"Robo AFTER Twilight should still tag as Stargate into Charge; "
        f"got {result!r}"
    )


# -----------------------------------------------------------------------------
# Robo First describes the OPENER, not the entire composition
# -----------------------------------------------------------------------------
# Robo First fires whenever Robotics Facility is the first tech building
# (before any Twilight Council AND before any Stargate). A later Stargate
# transition does NOT retroactively change the OPENER — once the player
# has committed to Robo as the first tech, any midgame Stargate addition
# (Skytoss tech-switch, end-game Tempests, late Phoenix harass) is a
# transition out of Robo First, not a reclassification of it.
#
# Stargate-led hybrids never reach this rule because they're caught
# earlier: Phoenix into Robo fires on Stargate + real Phoenix by 7:00 +
# Robo by 8:00, and the Stargate Opener catch-all fires on Stargate as
# the first tech building (``sg_time < robo_time``). Both of those run
# BEFORE Robo First in the detector chain.
def test_robo_first_fires_when_stargate_added_later():
    """Robo built first, then Stargate added later, no Phoenix on the
    field (so Phoenix-into-Robo doesn't catch it either). The opener
    is Robo, so the label IS Robo First — the later Stargate is a
    transition, not a reclassification of the opener.

    Reported scenario (Tourmaline LE, 2026-05-20, 16:48 game): the
    player opened Gateway → Cyber → Robo at 2:43, then added a
    Stargate later in the midgame. The previous strict "any Stargate
    disqualifies Robo First" rule pushed this into the Macro
    Transition (Unclassified) catch-all even though the OPENER was
    textbook Robo First. The rule now matches the user's mental
    model: Robo First describes the opener.
    """
    events = [
        _building("Nexus", 0),
        _building("Pylon", 18),
        _building("Gateway", 60),
        _building("Assimilator", 72),
        _building("CyberneticsCore", 115),
        _building("Nexus", 130),
        # Robotics Facility FIRST
        _building("RoboticsFacility", 200),
        # Stargate LATER (still exists at any time)
        _building("Stargate", 320),
        _building("Gateway", 280),
        _unit("Oracle", 360),  # Oracle, not Phoenix
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result == "PvT - Robo First", (
        f"Robo-first opener with a later Stargate transition must "
        f"classify as Robo First (the OPENER is Robo); got {result!r}"
    )


def test_stargate_first_then_robo_is_not_robo_first():
    """Stargate as the FIRST tech building, Robo added later. The
    opener is Stargate, so the label is NOT Robo First. With no
    Phoenix on the field (Phoenix-into-Robo can't catch it) this
    lands on the Stargate Opener catch-all instead.

    This is the rule that keeps Stargate-led hybrids out of the
    Robo First bucket — ``robo_time < sg_time`` fails so the Robo
    First branch is skipped, and ``sg_time < robo_time`` lets the
    Stargate Opener catch-all pick the replay up.
    """
    events = [
        _building("Nexus", 0),
        _building("Pylon", 18),
        _building("Gateway", 60),
        _building("Assimilator", 72),
        _building("CyberneticsCore", 115),
        _building("Nexus", 130),
        # Stargate FIRST
        _building("Stargate", 200),
        # Robo LATER
        _building("RoboticsFacility", 320),
        _building("Gateway", 280),
        _unit("Oracle", 260),  # Oracle, not Phoenix
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result != "PvT - Robo First", (
        f"Stargate-first opener must NOT classify as Robo First; "
        f"got {result!r}"
    )
    assert result == "PvT - Stargate Opener", (
        f"Stargate-first with no Phoenix and a later Robo must land "
        f"on the Stargate Opener catch-all; got {result!r}"
    )


def test_robo_first_still_fires_when_no_stargate():
    """Pure Robo opener — no Stargate ever — keeps the Robo First
    label."""
    events = [
        _building("Nexus", 0),
        _building("Pylon", 18),
        _building("Gateway", 60),
        _building("Assimilator", 72),
        _building("CyberneticsCore", 115),
        _building("Nexus", 130),
        _building("RoboticsFacility", 200),
        # No Stargate ever
        _building("Gateway", 280),
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result == "PvT - Robo First", (
        f"Pure Robo opener must still classify as Robo First; got {result!r}"
    )


def test_standard_charge_macro_does_not_fire_when_stargate_is_first_tech():
    """Stargate is the FIRST tech building (sg_time < twilight_time):
    the OPENER is Stargate, not Twilight, so the label is NOT
    Standard Charge Macro. The build is correctly stolen by
    Stargate-into-Charge earlier in the chain (Charge as the first
    Twilight upgrade off a Stargate-first opener)."""
    events = [
        _building("Nexus", 0),
        _building("Pylon", 18),
        _building("Gateway", 60),
        _building("Assimilator", 72),
        _building("CyberneticsCore", 115),
        _building("Nexus", 130),
        _building("Nexus", 300),
        # Stargate FIRST
        _building("Stargate", 200),
        _unit("Oracle", 260),
        # Twilight + Charge research come AFTER the Stargate
        _building("TwilightCouncil", 320),
        # Robo built AFTER Twilight so the Robo guard above doesn't
        # disqualify Stargate-into-Charge — we want to verify the
        # Standard-Charge-Macro ordering guard.
        _building("RoboticsFacility", 400),
        _upgrade("Charge", 380),
        _building("Gateway", 360),
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result != "PvT - Standard Charge Macro", (
        f"Stargate-first opener must NOT classify as Standard Charge Macro; "
        f"got {result!r}"
    )
    assert result == "PvT - Stargate into Charge", (
        f"Stargate-first opener with Charge as first Twilight upgrade "
        f"must classify as Stargate into Charge; got {result!r}"
    )


def test_standard_charge_macro_still_fires_with_no_stargate():
    """Pure Twilight+Charge+3nex (no Stargate at any point) keeps the
    Standard Charge Macro label."""
    events = [
        _building("Nexus", 0),
        _building("Pylon", 18),
        _building("Gateway", 60),
        _building("Assimilator", 72),
        _building("CyberneticsCore", 115),
        _building("Nexus", 130),
        _building("Nexus", 300),
        _building("TwilightCouncil", 220),
        _upgrade("Charge", 280),
        _building("Gateway", 240),
        _building("Gateway", 320),
        # No Stargate ever
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result == "PvT - Standard Charge Macro", (
        f"Pure Twilight macro must still classify as Standard Charge Macro; "
        f"got {result!r}"
    )


def test_standard_charge_macro_fires_with_twilight_opener_and_late_stargate():
    """Twilight is the FIRST tech building, Charge is the first
    Twilight upgrade, 3+ Nexuses, and a Stargate is added LATER in
    the midgame (Skytoss tech-switch / late-game Tempests / Phoenix
    harass). The OPENER was Twilight + Charge, so the label is
    still Standard Charge Macro. Mirrors the Robo First fix: the
    label describes the opener, not the entire composition.

    Before the fix, ``not has_building("Stargate", 9999)`` excluded
    any build with a Stargate at any point and shunted these
    Twilight-opener replays into ``Macro Transition
    (Unclassified)`` even though the opening was textbook
    Standard Charge Macro.
    """
    events = [
        _building("Nexus", 0),
        _building("Pylon", 18),
        _building("Gateway", 60),
        _building("Assimilator", 72),
        _building("CyberneticsCore", 115),
        _building("Nexus", 130),
        _building("Nexus", 300),
        _building("TwilightCouncil", 220),    # Twilight FIRST
        _upgrade("Charge", 280),               # Charge first Twilight upgrade
        _building("Gateway", 240),
        _building("Gateway", 320),
        # Stargate added LATER in the midgame -- well after the
        # opener committed to Twilight + Charge macro
        _building("Stargate", 600),            # 10:00
        _unit("Phoenix", 660),
        _unit("Tempest", 900),
    ]
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
    assert result == "PvT - Standard Charge Macro", (
        f"Twilight-opener Charge macro with a midgame Stargate "
        f"transition must classify as Standard Charge Macro (the "
        f"OPENER was Twilight); got {result!r}"
    )


# -----------------------------------------------------------------------------
# Catalog presence
# -----------------------------------------------------------------------------
def test_new_pvt_definitions_present_in_catalog():
    import json
    with open(
        os.path.join(_ROOT, "data", "build_definitions.json"),
        "r",
        encoding="utf-8",
    ) as fh:
        defs = json.load(fh)
    for name in (
        "PvT - Stargate into Charge",
        "PvT - Stargate into Glaives",
        "PvT - Stargate into Blink",
        "PvT - Stargate Opener",
    ):
        assert name in defs, f"Missing definition prose for {name!r}"
        assert len(defs[name]) > 60
