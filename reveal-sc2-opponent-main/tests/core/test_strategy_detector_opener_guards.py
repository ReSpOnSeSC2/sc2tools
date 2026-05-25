"""Regression tests for opener-ordering guards in the strategy detector.

Three real user-reported mis-classifications motivated these guards:

  1. A PvZ DT build that transitioned into Carriers/Mothership was
     labelled "PvZ - Carrier Rush" because the Carrier rule only
     required a Stargate + Fleet Beacon + 1 Carrier by 10:00 with no
     opener-ordering check.

  2. A PvZ Glaive Adept opener that added 2 Stargates around 7:00 to
     counter Lurkers was labelled "PvZ - 2 Stargate Phoenix" for the
     same reason -- the rule counted Stargates by 10:00 without
     checking whether the Stargate was the FIRST tech committed.

  3. A Zerg opponent Nydus build was labelled "Zerg - 2 Base Muta
     Rush" because the Muta-rush check fired on any Spire by 7:00
     with low drones and ran BEFORE the Nydus check. The Pool-First
     branch had NO Nydus check at all.

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


def _gates(starts: List[int]) -> List[Dict[str, Any]]:
    return [_building("Gateway", t) for t in starts]


def _base_protoss_opener() -> List[Dict[str, Any]]:
    """Standard Protoss opener shared by every PvZ test below."""
    return [
        _building("Nexus", 0),
        _building("Pylon", 18),
        _building("Gateway", 60),
        _building("Assimilator", 72),
        _building("CyberneticsCore", 115),
        _building("Nexus", 130),       # 2nd Nexus
        _building("Assimilator", 150),
        _building("Pylon", 170),
    ]


# =============================================================================
# Issue 1: DT-into-Carrier must not mis-fire as "PvZ - Carrier Rush"
# =============================================================================
def test_dt_into_carrier_does_not_classify_as_carrier_rush():
    """DT opener that later builds a Stargate + Fleet Beacon + Carrier
    (a tech-switch into Skytoss) used to mis-fire as Carrier Rush.

    With the stargate_first_tech opener guard, Carrier Rush only fires
    when the Stargate is the FIRST tech building; here the Dark Shrine
    comes first, so the build correctly tags as PvZ - DT Opener.
    """
    events = _base_protoss_opener()
    events.extend(_gates([240, 280, 320]))
    # Twilight + Dark Shrine come FIRST -- this is a DT opener.
    events.append(_building("TwilightCouncil", 200))
    events.append(_building("DarkShrine", 240))
    # Real Dark Templar lands within the harass window.
    events.append(_unit("DarkTemplar", 360))
    events.append(_unit("DarkTemplar", 380))
    # Late tech-switch: Stargate + Fleet Beacon + Carrier all show up
    # WELL after the Dark Shrine.
    events.append(_building("Stargate", 420))
    events.append(_building("FleetBeacon", 480))
    events.append(_unit("Carrier", 580))

    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Zerg", events, my_race="Protoss")
    assert result != "PvZ - Carrier Rush", (
        f"DT opener with late Carrier transition must NOT tag as "
        f"Carrier Rush; got {result!r}"
    )
    assert result == "PvZ - DT Opener", (
        f"DT opener with late Carrier transition should tag as "
        f"DT Opener; got {result!r}"
    )


def test_true_carrier_rush_still_classifies_as_carrier_rush():
    """Positive control: a real Stargate-first Carrier rush -- Stargate
    is the FIRST tech building (no Twilight / Dark Shrine / Robo before
    it), Fleet Beacon goes up, Carrier on the field by 10:00 -- still
    classifies as Carrier Rush."""
    events = _base_protoss_opener()
    events.extend(_gates([240]))
    # Stargate is the ONLY tech building before 6:00.
    events.append(_building("Stargate", 220))
    events.append(_building("FleetBeacon", 330))
    events.append(_unit("Carrier", 470))

    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Zerg", events, my_race="Protoss")
    assert result == "PvZ - Carrier Rush", (
        f"True Stargate-first Carrier rush must classify as "
        f"Carrier Rush; got {result!r}"
    )


# =============================================================================
# Issue 2: Glaives + late 2-Stargate Phoenix must not mis-fire as
# "PvZ - 2 Stargate Phoenix"
# =============================================================================
def test_glaives_with_late_2_stargate_phoenix_does_not_mis_fire():
    """Glaive Adept opener (Twilight FIRST) that adds 2 Stargates and 4
    Phoenix around 7:00 to counter Lurkers used to mis-fire as 2
    Stargate Phoenix because the rule counted Stargates by 10:00 with
    no opener-ordering check.

    With the stargate_first_tech guard the Stargates added at 7:00 do
    NOT count as the "Stargate opener" (Twilight was built first), and
    the build correctly lands on PvZ - Adept Glaives (No Robo).
    """
    events = _base_protoss_opener()
    # Twilight is the FIRST tech building (well before any Stargate).
    events.append(_building("TwilightCouncil", 200))
    events.extend(_gates([240, 260, 280, 300, 320]))
    # Glaives is the FIRST upgrade out of Twilight.
    events.append(_upgrade("AdeptPiercingAttack", 260))
    events.append(_unit("Adept", 280))
    events.append(_unit("Adept", 310))
    # Late tech-switch to counter Lurkers: 2 Stargates around 7:00 with
    # enough production time to land 4+ Phoenix before 10:00.
    events.append(_building("Stargate", 420))
    events.append(_building("Stargate", 450))
    for t in (500, 530, 560, 590):
        events.append(_unit("Phoenix", t))

    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Zerg", events, my_race="Protoss")
    assert result != "PvZ - 2 Stargate Phoenix", (
        f"Twilight-first Glaives opener with late 2 Stargates must "
        f"NOT tag as 2 Stargate Phoenix; got {result!r}"
    )
    assert result == "PvZ - Adept Glaives (No Robo)", (
        f"Glaives opener with late Stargate transition should tag as "
        f"Adept Glaives (No Robo); got {result!r}"
    )


def test_stargate_first_into_glaives_does_not_mis_fire_as_2_stargate_phoenix():
    """User-reported regression (Taito Citadel LE 2026-05-25 10:05:36).

    A Stargate-FIRST opener that adds a Twilight Council after the
    Stargate, researches Glaives FIRST off Twilight, and produces a
    handful of Phoenix off 2 Stargates while pumping Adepts was
    mis-labelled as PvZ - 2 Stargate Phoenix. The stargate_first_tech
    guard does NOT catch this (Stargate IS first here), so the rule
    needs an additional "AND not glaive_first_off_twilight" guard --
    the Glaives-first signal is a strong intent marker that means
    this is a Stargate-into-Glaives build, NOT a pure Stargate
    Phoenix one (the Phoenix are scouting / harass support).
    """
    events = _base_protoss_opener()
    # Stargate is the FIRST tech building (~3:30).
    events.append(_building("Stargate", 210))
    # 2nd Stargate stays before 10:00 so the 2 SG Phoenix headline
    # count check still wants to fire.
    events.append(_building("Stargate", 280))
    # Twilight comes AFTER Stargate -- this is "Stargate into X".
    events.append(_building("TwilightCouncil", 250))
    # 4-8 Gateways by 6:00 (canonical Stargate-into-Glaives range).
    events.extend(_gates([240, 260, 300, 320, 340]))
    # Glaives is the FIRST upgrade out of Twilight, BEFORE Blink /
    # Charge -- the signal that marks intent.
    events.append(_upgrade("AdeptPiercingAttack", 320))
    # Plenty of Phoenix off 2 Stargates by 10:00 (the trigger that
    # used to mis-fire the rule).
    for t in (300, 340, 380, 420, 460, 500):
        events.append(_unit("Phoenix", t))
    # Adept production to fill out the gateway count and match the
    # reported replay shape.
    for t in (340, 370, 400, 430, 460):
        events.append(_unit("Adept", t))

    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Zerg", events, my_race="Protoss")
    assert result != "PvZ - 2 Stargate Phoenix", (
        f"Stargate opener with Glaives-first upgrade must NOT tag as "
        f"2 Stargate Phoenix even with 4+ Phoenix by 10:00; got {result!r}"
    )
    assert result == "PvZ - Stargate into Glaives", (
        f"Stargate-first into Glaives should tag as Stargate into "
        f"Glaives; got {result!r}"
    )


def test_pure_2_stargate_phoenix_without_glaives_still_classifies():
    """Positive control: a TRUE 2 Stargate Phoenix build -- 2 Stargates,
    4+ Phoenix, NO Twilight Council / NO Glaives research -- must still
    classify as 2 Stargate Phoenix under the new Glaives-disqualifier
    guard."""
    events = _base_protoss_opener()
    events.append(_building("Stargate", 220))
    events.append(_building("Stargate", 260))
    for t in (260, 300, 340, 380):
        events.append(_unit("Phoenix", t))
    # Deliberately NO Twilight Council, NO Glaives upgrade.

    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Zerg", events, my_race="Protoss")
    assert result == "PvZ - 2 Stargate Phoenix", (
        f"True 2 Stargate Phoenix (no Twilight, no Glaives) must still "
        f"tag as 2 Stargate Phoenix; got {result!r}"
    )


def test_slow_dt_opener_with_no_earlier_tech_still_classifies():
    """Vice-versa of the slow-Stargate refinement: a Dark Shrine that
    goes down "late" (e.g. 7:30) but BEFORE any Stargate / Robotics
    Facility is still a DT Opener -- pure tech-ordering, no time
    threshold. Twilight Council is implicit (required as Dark Shrine's
    prereq). Before this refinement the old `dark_shrine_time < 480`
    clause wrongly excluded slow-but-pure DT openers."""
    events = _base_protoss_opener()
    events.extend(_gates([240, 280, 320]))
    # Twilight goes down at 3:30 (required as Dark Shrine prereq).
    events.append(_building("TwilightCouncil", 210))
    # Slow Dark Shrine -- past the old 8:00 threshold but NOTHING else
    # (Stargate / Robo) was built before it.
    events.append(_building("DarkShrine", 450))
    # Real Dark Templar lands within the harass window (by 9:00 = 540s).
    events.append(_unit("DarkTemplar", 530))

    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Zerg", events, my_race="Protoss")
    assert result == "PvZ - DT Opener", (
        f"Slow-but-pure DT opener (no earlier Stargate / Robo) should "
        f"still classify as DT Opener; got {result!r}"
    )


def test_slow_robo_opener_with_no_earlier_tech_still_classifies():
    """Vice-versa of the slow-Stargate refinement: a Robotics Facility
    that goes down "late" (e.g. 7:30) but BEFORE any Stargate /
    Twilight Council / Dark Shrine is still a Robo Opener -- pure
    tech-ordering, no time threshold. Before this refinement the old
    `has_building("RoboticsFacility", 420)` clause wrongly excluded
    slow-but-pure Robo openers."""
    events = _base_protoss_opener()
    events.extend(_gates([240, 280, 320]))
    # Slow Robo -- past the old 7:00 threshold, NOTHING else built first.
    events.append(_building("RoboticsFacility", 450))
    # Deliberately NO Stargate, NO Twilight, NO DarkShrine.

    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Zerg", events, my_race="Protoss")
    assert result == "PvZ - Robo Opener", (
        f"Slow-but-pure Robo opener (no earlier Stargate / Twilight / "
        f"DT) should still classify as Robo Opener; got {result!r}"
    )


def test_slow_twilight_first_glaives_still_classifies():
    """Vice-versa: the Twilight-first guard is now pure ordering too.
    A Twilight Council that goes down "late" (e.g. 8:00) but BEFORE
    any Stargate / Robo / DarkShrine, with Glaives researched first
    and 4-8 Gateways by 6:00, still classifies as Adept Glaives. The
    old `twilight_time < 480` clause used to refuse to call this a
    Twilight opener."""
    events = _base_protoss_opener()
    # 4-8 Gateways by 6:00 (the rule's pre-existing constraint).
    events.extend(_gates([240, 260, 300, 320, 340]))
    # Slow Twilight -- past the old 8:00 threshold, nothing else first.
    events.append(_building("TwilightCouncil", 490))
    # Glaives is the FIRST (and only) Twilight upgrade.
    events.append(_upgrade("AdeptPiercingAttack", 540))

    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Zerg", events, my_race="Protoss")
    assert result == "PvZ - Adept Glaives (No Robo)", (
        f"Slow-but-pure Twilight-first Adept Glaives (no earlier "
        f"Stargate / Robo / DT) should still classify as Adept Glaives "
        f"(No Robo); got {result!r}"
    )


def test_slow_2_stargate_phoenix_with_no_earlier_tech_still_classifies():
    """User-feedback refinement: the stargate_first_tech guard is pure
    ordering -- a Stargate that goes down "late" (e.g. 7:00) but with
    NOTHING else built first (no Twilight / Robo / DarkShrine) is
    still a Stargate opener, just a slow one. The earlier `sg_time <
    360` time-threshold version of the guard wrongly excluded these
    slow-but-pure Phoenix openers from the 2 SG Phoenix label.

    Concretely: 2 Stargates starting at 7:00 / 7:40, no other tech,
    4+ Phoenix by 10:00 -- this is fundamentally a 2 Stargate Phoenix
    build (the only "intent" the player showed was Stargate). Without
    the time-threshold drop it used to fall through to "PvZ - Macro
    Transition (Unclassified)".
    """
    events = _base_protoss_opener()
    # Slow first Stargate -- past the old 6:00 threshold, but NOTHING
    # else was built before it.
    events.append(_building("Stargate", 420))
    events.append(_building("Stargate", 460))
    # Phoenix produced after Stargates land (prereq must be satisfied).
    for t in (470, 500, 530, 560):
        events.append(_unit("Phoenix", t))
    # Deliberately NO TwilightCouncil, NO RoboticsFacility, NO DarkShrine.

    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Zerg", events, my_race="Protoss")
    assert result == "PvZ - 2 Stargate Phoenix", (
        f"Slow-but-pure 2 SG Phoenix (no earlier tech) should still "
        f"classify as 2 Stargate Phoenix; got {result!r}"
    )


def test_stargate_first_into_blink_still_classifies_as_blink_macro():
    """Positive control on the discriminator: a Stargate-FIRST opener
    with 4+ Phoenix + Twilight that researches BLINK first (not
    Glaives) must NOT be caught by the new Glaives guard -- it should
    still resolve to a Phoenix or Blink-related label, not be falsely
    blocked out of the 2 SG Phoenix bucket on a different upgrade
    signal."""
    events = _base_protoss_opener()
    events.append(_building("Stargate", 220))
    events.append(_building("Stargate", 280))
    events.append(_building("TwilightCouncil", 260))
    # Blink is FIRST off Twilight, NOT Glaives.
    events.append(_upgrade("BlinkTech", 320))
    for t in (260, 300, 340, 380):
        events.append(_unit("Phoenix", t))

    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Zerg", events, my_race="Protoss")
    # The Glaives-disqualifier guard MUST NOT fire here (Blink, not
    # Glaives), so 2 SG Phoenix is still the right headline.
    assert result == "PvZ - 2 Stargate Phoenix", (
        f"Stargate opener with Blink-first (NOT Glaives) and 4+ "
        f"Phoenix should still tag as 2 Stargate Phoenix; got {result!r}"
    )


def test_stargate_first_into_robo_classifies_as_stargate_into_robo():
    """User-reported regression (Ruby Rock LE 2026-04-01 10:39:06).
    A Stargate-FIRST opener (Stargate at 2:24) that produced Phoenix
    and added a Robotics Facility for Immortal / Observer / Disruptor
    support was mis-labelled "PvZ - 2 Stargate Phoenix" because the
    2 SG Phoenix rule fired on the count signature alone with no
    Robo-disqualifier guard. The build is a classic Stargate-into-
    Robo transition -- it should land on the new PvZ - Phoenix into
    Robo label, mirroring the existing PvT - Phoenix into Robo
    rule."""
    events = _base_protoss_opener()
    # Stargate is the FIRST tech (~3:40).
    events.append(_building("Stargate", 220))
    events.append(_building("Stargate", 280))
    events.extend(_gates([240, 280]))
    # Real Phoenix on the field (Stargate prereq satisfied).
    for t in (270, 320, 380, 440):
        events.append(_unit("Phoenix", t))
    # Robo for Immortal / Observer follow-up.
    events.append(_building("RoboticsFacility", 360))
    events.append(_unit("Immortal", 500))
    events.append(_unit("Observer", 480))

    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Zerg", events, my_race="Protoss")
    assert result != "PvZ - 2 Stargate Phoenix", (
        f"Stargate-first opener with Robo must NOT tag as 2 Stargate "
        f"Phoenix even with 4+ Phoenix by 10:00; got {result!r}"
    )
    assert result == "PvZ - Stargate into Robo", (
        f"Stargate-first opener with Phoenix + Robo should tag as "
        f"Stargate into Robo; got {result!r}"
    )


def test_stargate_into_robo_accepts_oracle_or_voidray_as_stargate_unit():
    """The Stargate into Robo rule keys on `Phoenix OR Oracle OR
    VoidRay` so Stargate-Oracle into Robo and Stargate-VR into Robo
    builds both land here (rather than falling through to the
    Stargate Opener catch-all)."""
    # Oracle variant
    events = _base_protoss_opener()
    events.append(_building("Stargate", 220))
    events.extend(_gates([240, 280]))
    events.append(_unit("Oracle", 290))
    events.append(_building("RoboticsFacility", 360))
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Zerg", events, my_race="Protoss")
    assert result == "PvZ - Stargate into Robo", (
        f"Stargate-Oracle into Robo should tag as Stargate into Robo; "
        f"got {result!r}"
    )

    # Void Ray variant
    events = _base_protoss_opener()
    events.append(_building("Stargate", 220))
    events.extend(_gates([240, 280]))
    events.append(_unit("VoidRay", 320))
    events.append(_building("RoboticsFacility", 360))
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Zerg", events, my_race="Protoss")
    assert result == "PvZ - Stargate into Robo", (
        f"Stargate-VR into Robo should tag as Stargate into Robo; "
        f"got {result!r}"
    )


def test_pure_2_stargate_phoenix_without_robo_still_classifies():
    """Positive control on the new Robo-disqualifier guard: a TRUE
    pure 2 Stargate Phoenix build (no Twilight, no Robo, no
    DarkShrine, just Stargates + Phoenix) still classifies as 2 SG
    Phoenix. The Robo-disqualifier must NOT over-fire."""
    events = _base_protoss_opener()
    events.append(_building("Stargate", 220))
    events.append(_building("Stargate", 260))
    for t in (260, 300, 340, 380):
        events.append(_unit("Phoenix", t))
    # Deliberately NO Twilight, NO Robo, NO DarkShrine.

    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Zerg", events, my_race="Protoss")
    assert result == "PvZ - 2 Stargate Phoenix", (
        f"Pure 2 SG Phoenix (no tech-switch) must still classify; "
        f"got {result!r}"
    )


def test_stargate_opener_catch_all_when_no_specific_rule_matches():
    """A Stargate-first build that produced no real Phoenix / Oracle /
    VR (e.g. Stargate was harassed off mid-construction) and has no
    Fleet Beacon / Robo / Twilight / DarkShrine commitment used to
    fall through to "PvZ - Macro Transition (Unclassified)". The new
    PvZ - Stargate Opener catch-all picks these up so the opener is
    visible in the user's analytics even when the midgame composition
    is unusual."""
    events = _base_protoss_opener()
    events.append(_building("Stargate", 220))
    events.extend(_gates([240, 280, 320]))
    # Deliberately NO Phoenix / Oracle / VR produced (Stargate was
    # killed before producing). NO Fleet Beacon. NO Robo. NO Twilight.
    # NO DarkShrine.

    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Zerg", events, my_race="Protoss")
    assert result == "PvZ - Stargate Opener", (
        f"Stargate-first build with no specific rule match should tag "
        f"as Stargate Opener (catch-all), not fall through to Macro "
        f"Transition; got {result!r}"
    )


def test_stargate_opener_present_in_catalog():
    """Catalog presence check for the new PvZ - Stargate Opener and
    PvZ - Stargate into Robo entries."""
    import json
    with open(
        os.path.join(_ROOT, "data", "build_definitions.json"),
        "r",
        encoding="utf-8",
    ) as fh:
        defs = json.load(fh)
    for name in ("PvZ - Stargate into Robo", "PvZ - Stargate Opener"):
        assert name in defs, f"Missing definition prose for {name!r}"
        desc = defs[name]
        assert isinstance(desc, str) and len(desc) > 80, (
            f"{name!r} description too short: {desc!r}"
        )


def test_dt_into_2_stargate_phoenix_does_not_mis_fire():
    """A DT opener (Dark Shrine FIRST) that picks up 2 Stargates + 4
    Phoenix late must NOT mis-fire as 2 Stargate Phoenix."""
    events = _base_protoss_opener()
    events.extend(_gates([240, 280]))
    events.append(_building("TwilightCouncil", 200))
    events.append(_building("DarkShrine", 240))
    events.append(_unit("DarkTemplar", 360))
    # Late Stargates + Phoenix.
    events.append(_building("Stargate", 420))
    events.append(_building("Stargate", 450))
    for t in (500, 530, 560, 590):
        events.append(_unit("Phoenix", t))

    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Zerg", events, my_race="Protoss")
    assert result != "PvZ - 2 Stargate Phoenix", (
        f"DT opener with late 2 Stargates must NOT tag as 2 Stargate "
        f"Phoenix; got {result!r}"
    )


# =============================================================================
# Issue 3: Nydus build must not mis-fire as "Zerg - 2 Base Muta Rush"
# =============================================================================
def _hatch_first_zerg_opener() -> List[Dict[str, Any]]:
    """Hatch-First Zerg opener: 2nd Hatch before Pool."""
    return [
        _building("Hatchery", 0),
        _building("Extractor", 15),
        _building("Hatchery", 46),  # 2nd hatch BEFORE Pool
        _building("Extractor", 66),
        _building("SpawningPool", 72),
        _building("Queen", 118),
        _building("Queen", 119),
    ]


def _pool_first_zerg_opener() -> List[Dict[str, Any]]:
    """Pool-First Zerg opener: Pool before 2nd Hatch, but not so early
    that the "12 Pool" / "Early Pool" rules higher up the tree fire
    first (pool_time must be >= 70 to reach the Pool-First branch).
    """
    return [
        _building("Hatchery", 0),
        _building("Extractor", 90),
        _building("SpawningPool", 100),  # ~17 Pool; > 70 so we skip 12-Pool / Early Pool
        _building("Hatchery", 150),       # 2nd hatch AFTER pool
        _building("Extractor", 160),
        _building("Queen", 200),
        _building("Queen", 205),
    ]


def _drones(n: int, by_time: int) -> List[Dict[str, Any]]:
    """Spread n Drones evenly between 30s and by_time."""
    if n == 0:
        return []
    step = max(1, (by_time - 30) // n)
    return [_unit("Drone", 30 + i * step) for i in range(n)]


def test_hatch_first_nydus_with_spire_does_not_mis_fire_as_muta_rush():
    """Hatch-First Nydus build that also adds a Spire (for late air
    follow-up) used to mis-fire as 2 Base Muta Rush because the Muta
    rule fired on any Spire by 7:00 with low drones and ran BEFORE the
    Nydus check."""
    events = _hatch_first_zerg_opener()
    events.append(_building("NydusNetwork", 380))  # Nydus is the build
    events.append(_building("Spire", 400))         # Spire for late air
    events.extend(_drones(35, 420))  # < 45 drones at 7:00 -> Muta rule
                                     # used to fire here.

    detector = sd.OpponentStrategyDetector(custom_builds=[])
    result = detector.get_strategy_name(
        "Zerg", events, matchup="vs Zerg", my_race="Protoss",
    )
    assert result != "Zerg - 2 Base Muta Rush", (
        f"Nydus opener with a Spire must NOT tag as 2 Base Muta Rush; "
        f"got {result!r}"
    )
    assert result == "Zerg - 2 Base Nydus", (
        f"Nydus opener should tag as 2 Base Nydus; got {result!r}"
    )


def test_pool_first_nydus_now_classifies_as_2_base_nydus():
    """Pool-First branch had NO Nydus check at all -- a Pool-First
    Nydus opener used to fall through to "Zerg - Pool First Opener"
    (a macro-flavored catch-all that hid the all-in)."""
    events = _pool_first_zerg_opener()
    events.append(_building("NydusNetwork", 380))
    events.extend(_drones(35, 420))

    detector = sd.OpponentStrategyDetector(custom_builds=[])
    result = detector.get_strategy_name(
        "Zerg", events, matchup="vs Zerg", my_race="Protoss",
    )
    assert result == "Zerg - 2 Base Nydus", (
        f"Pool-First Nydus opener should now classify as 2 Base Nydus; "
        f"got {result!r}"
    )


def test_true_muta_rush_still_classifies_as_muta_rush():
    """Positive control: a real Muta rush (Spire by 7:00, no Nydus,
    drone count under 45) still classifies as 2 Base Muta Rush."""
    events = _hatch_first_zerg_opener()
    events.append(_building("Spire", 400))
    events.extend(_drones(35, 420))

    detector = sd.OpponentStrategyDetector(custom_builds=[])
    result = detector.get_strategy_name(
        "Zerg", events, matchup="vs Zerg", my_race="Protoss",
    )
    assert result == "Zerg - 2 Base Muta Rush", (
        f"True Muta rush (Spire + low drones, no Nydus) must classify "
        f"as 2 Base Muta Rush; got {result!r}"
    )


# =============================================================================
# Issue 4: new PvZ - DT Opener path catches DT openers that fell
# through to "Macro Transition (Unclassified)"
# =============================================================================
def test_dt_opener_without_transition_classifies_as_dt_opener():
    """A clean DT opener (Dark Shrine first, DT lands, no further tech
    switch) used to fall through to "Macro Transition (Unclassified)"
    because the only DT rule (PvZ - DT drop into Archon Drop) required
    a Warp Prism."""
    events = _base_protoss_opener()
    events.extend(_gates([240, 280, 320]))
    events.append(_building("TwilightCouncil", 200))
    events.append(_building("DarkShrine", 240))
    events.append(_unit("DarkTemplar", 360))
    events.append(_unit("DarkTemplar", 400))
    events.append(_unit("DarkTemplar", 440))

    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build("vs Zerg", events, my_race="Protoss")
    assert result == "PvZ - DT Opener", (
        f"A clean DT opener should classify as PvZ - DT Opener; "
        f"got {result!r}"
    )


def test_dt_opener_present_in_catalog():
    """The new label needs prose in the public build_definitions
    catalog or the /definitions page silently drops it."""
    import json
    with open(
        os.path.join(_ROOT, "data", "build_definitions.json"),
        "r",
        encoding="utf-8",
    ) as fh:
        defs = json.load(fh)
    assert "PvZ - DT Opener" in defs, (
        "Missing definition prose for 'PvZ - DT Opener'"
    )
    desc = defs["PvZ - DT Opener"]
    assert isinstance(desc, str) and len(desc) > 60
    assert "dark shrine" in desc.lower()
