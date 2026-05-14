"""Protoss-vs-Terran user-build classification tree.

Pure function: given a :class:`DetectionContext` for a Protoss player in
a PvT matchup, return the build-label string. The caller
(``UserBuildDetector.detect_my_build``) decides when to dispatch here
based on the matchup string.

The Terran-user "TvP - 1-1-1 One Base" rule (which fires when the
*player* is Terran in a PvT-from-Terran's-perspective matchup) does not
live here — it stays in ``strategy_detector_user.py`` next to the
race-aware signature loop because it does not need a Protoss
:class:`DetectionContext`.
"""

from __future__ import annotations

from typing import Optional

from .strategy_detector_helpers import DetectionContext


def detect_pvt(ctx: DetectionContext) -> Optional[str]:
    """Return the PvT user-build label, or ``None`` if no rule matched."""
    has_building = ctx.has_building
    has_proxy = ctx.has_proxy
    count_units = ctx.count_units
    has_upgrade_substr = ctx.has_upgrade_substr
    building_time = ctx.building_time
    upgrade_time = ctx.upgrade_time
    gate_count_6min = ctx.gate_count_6min
    buildings = ctx.buildings
    units = ctx.units

    nexus_times = sorted([b["time"] for b in buildings if b["name"] == "Nexus"])
    sec_nexus_time = nexus_times[1] if len(nexus_times) >= 2 else 9999
    third_nexus_time = nexus_times[2] if len(nexus_times) >= 3 else 9999

    robo_time = building_time("RoboticsFacility")
    sg_time = building_time("Stargate")
    twilight_time = building_time("TwilightCouncil")
    ta_time = building_time("TemplarArchive")
    gate_count_730 = sum(1 for b in buildings if b["name"] == "Gateway" and b["time"] < 450)

    if has_proxy("Stargate", sec_nexus_time, 50):
        return "PvT - Proxy Void Ray/Stargate"

    # Stargate-into-X variants: a Stargate goes down first as
    # the tech building (the unit produced from it — Phoenix /
    # Oracle / Void Ray — does NOT matter), then a Twilight
    # Council, and the FIRST upgrade researched out of the
    # Twilight is Charge / Glaives / Blink. The three labels
    # are mutually exclusive on the first-upgrade signal and
    # sit above Phoenix Opener / Phoenix into Robo so a
    # Stargate-Phoenix opener that researches Glaives first gets
    # the more informative "Stargate into Glaives" tag instead
    # of the generic Phoenix Opener.
    #
    # Robo-tech guard: if a Robotics Facility (or anything that
    # requires it — an Immortal / Robotics Bay) lands BEFORE
    # the Twilight Council, the build committed to a Robo path
    # before any Twilight upgrade could be the "first" one in
    # spirit. Those replays are Phoenix into Robo (or Robo
    # First / Standard Charge Macro) — Twilight-Council-led
    # labels like Stargate-into-Charge would mis-tag them.
    # Immortal & RoboBay both transitively imply Robo, so the
    # presence of EITHER signal before Twilight is enough; we
    # check all three explicitly so the rule is self-documenting
    # and future event-extractor changes can't silently break it.
    pvt_first_immortal_time = min(
        (u["time"] for u in units if u["name"] == "Immortal"),
        default=9999,
    )
    pvt_robobay_time = building_time("RoboticsBay")
    pvt_robo_tech_before_twilight = (
        robo_time < twilight_time
        or pvt_first_immortal_time < twilight_time
        or pvt_robobay_time < twilight_time
    )
    pvt_glaive_time = upgrade_time("AdeptPiercing", "Glaive")
    pvt_blink_time = upgrade_time("Blink")
    pvt_charge_time = upgrade_time("Charge")
    pvt_first_twilight_upgrade = min(
        pvt_glaive_time, pvt_blink_time, pvt_charge_time,
    )
    if (
        has_building("Stargate", 480)
        and sg_time < twilight_time
        and twilight_time < 9999
        and pvt_first_twilight_upgrade < 9999
        and not pvt_robo_tech_before_twilight
    ):
        if pvt_charge_time == pvt_first_twilight_upgrade:
            return "PvT - Stargate into Charge"
        if pvt_glaive_time == pvt_first_twilight_upgrade:
            return "PvT - Stargate into Glaives"
        if pvt_blink_time == pvt_first_twilight_upgrade:
            return "PvT - Stargate into Blink"

    # Phoenix builds: require an actual Stargate. Sentry can
    # hallucinate Phoenix off Cyber + Twilight tech, so a
    # 2-base Charge / Templar build can register a "Phoenix"
    # event without any Stargate ever going down. count_units
    # already filters hallucinations via the prereq table, but
    # the explicit guard makes the requirement self-documenting
    # and prevents a regression if count_units is ever swapped
    # for a raw count again.
    if (
        has_building("Stargate", 420)
        and count_units("Phoenix", 420) >= 1
        and has_building("RoboticsFacility", 480)
    ):
        return "PvT - Phoenix into Robo"
    if has_building("Stargate", 420) and count_units("Phoenix", 420) >= 1:
        gate_t = sorted([b["time"] for b in buildings if b["name"] == "Gateway"])
        if len(gate_t) >= 2 and gate_t[1] < robo_time:
            return "PvT - Phoenix Opener"

    if has_upgrade_substr("Blink", 540) and gate_count_6min >= 6:
        return "PvT - 7 Gate Blink All-in"
    if has_upgrade_substr("Charge", 540) and gate_count_730 >= 7 and len(nexus_times) < 3:
        return "PvT - 8 Gate Charge All-in"
    # 2 Base Templar requires a Templar Archives: HT / Storm play
    # is impossible without it. building_time returns 9999 when
    # the structure was never built, so the < third_nexus_time
    # comparison alone is not enough on a replay where the user
    # never finished a 3rd Nexus -- both sides of the inequality
    # could be infinity. Anchor the check to a real cutoff.
    if (
        has_building("TemplarArchive", 9999)
        and ta_time < third_nexus_time
        and (4 <= gate_count_730 <= 6)
    ):
        return "PvT - 2 Base Templar (Reactive/Delayed 3rd)"
    # Standard Charge Macro is a pure Gateway / Twilight macro
    # game — any Stargate at all means the build is a hybrid
    # composition (Stargate-into-Charge / Phoenix-into-Robo /
    # Stargate Opener) and should NOT collapse into this label.
    # The earlier Stargate-into-X / Phoenix-into-Robo branches
    # already catch the Stargate cases when their signatures
    # match, but a Stargate replay that misses both (e.g. Oracle
    # harass with no Phoenix + Robo-AFTER-Twilight + Charge) used
    # to fall through to this rule. Explicit guard keeps the
    # label honest.
    if (
        has_upgrade_substr("Charge", 540)
        and len(nexus_times) >= 3
        and not has_building("Stargate", 9999)
    ):
        return "PvT - Standard Charge Macro"
    if (
        has_upgrade_substr("Charge", 540)
        and twilight_time < robo_time
        and twilight_time < sg_time
    ):
        return "PvT - 3 Gate Charge Opener"

    if (
        twilight_time < robo_time
        and twilight_time < sg_time
        and has_upgrade_substr("Blink", 540)
    ):
        if gate_count_730 >= 4:
            return "PvT - 4 Gate Blink"
        else:
            return "PvT - 3 Gate Blink (Macro)"

    if (
        has_upgrade_substr("Blink", 480)
        and len(nexus_times) >= 3
        and sum(1 for b in buildings if b["name"] == "Gateway" and b["time"] < 480) == 2
        and has_building("RoboticsFacility", 480)
    ):
        return "PvT - 2 Gate Blink (Fast 3rd Nexus)"

    # DT Drop: needs Dark Shrine for the DTs and Robotics
    # Facility for the Warp Prism. count_units already enforces
    # the Robo prereq for WarpPrism, but spelling it out keeps
    # the rule self-contained.
    if (
        has_building("DarkShrine", 540)
        and has_building("RoboticsFacility", 600)
        and count_units("WarpPrism", 600) >= 1
    ):
        return "PvT - DT Drop"
    # Robo First is a Stargate-free opener — Robotics Facility
    # goes down before Twilight Council and no Stargate is ever
    # built. A Stargate (even one built AFTER the Robo) makes
    # the build a Robo+Sg hybrid; Phoenix-into-Robo / Stargate
    # Opener handle those cases above and below.
    if (
        has_building("RoboticsFacility", 390)
        and robo_time < sg_time
        and robo_time < twilight_time
        and not has_building("Stargate", 9999)
    ):
        return "PvT - Robo First"
    # Catch-all: a Stargate was the FIRST tech building after
    # the Cybernetics Core (before Twilight Council and before
    # Robotics Facility) but the build didn't match any of the
    # more specific Stargate-prefixed variants above (Proxy
    # Void Ray, Stargate into Charge/Glaives/Blink, Phoenix
    # into Robo, Phoenix Opener). Surface it as a generic
    # "Stargate Opener" rather than the unhelpful Macro
    # Transition (Unclassified) bucket — custom builds can
    # refine it from there.
    if (
        has_building("Stargate", 480)
        and sg_time < twilight_time
        and sg_time < robo_time
    ):
        return "PvT - Stargate Opener"
    return "PvT - Macro Transition (Unclassified)"
