"""Protoss-vs-Zerg user-build classification tree.

Pure function: given a :class:`DetectionContext` for a Protoss player in
a PvZ matchup, return the build-label string. The caller
(``UserBuildDetector.detect_my_build``) decides when to dispatch here
based on the matchup string.
"""

from __future__ import annotations

from typing import Optional

from .strategy_detector_helpers import DetectionContext


def detect_pvz(ctx: DetectionContext) -> Optional[str]:
    """Return the PvZ user-build label, or ``None`` if no rule matched."""
    has_building = ctx.has_building
    count_units = ctx.count_units
    has_upgrade_substr = ctx.has_upgrade_substr
    building_time = ctx.building_time
    upgrade_time = ctx.upgrade_time
    gate_count_6min = ctx.gate_count_6min
    gate_count_530 = ctx.gate_count_530
    buildings = ctx.buildings

    sg_count_10min = sum(1 for b in buildings if b["name"] == "Stargate" and b["time"] < 600)
    nexus_count_10min = sum(1 for b in buildings if b["name"] == "Nexus" and b["time"] < 600)

    # Carrier / Tempest both require Stargate + Fleet Beacon.
    # count_units already filters hallucinations, but document
    # the prerequisite so a future refactor can't drop it.
    if (
        has_building("Stargate", 600)
        and has_building("FleetBeacon", 600)
        and count_units("Carrier", 600) >= 1
    ):
        return "PvZ - Carrier Rush"
    if (
        has_building("Stargate", 600)
        and has_building("FleetBeacon", 600)
        and count_units("Tempest", 600) >= 1
    ):
        return "PvZ - Tempest Rush"
    if sg_count_10min >= 2 and nexus_count_10min >= 2 and count_units("VoidRay", 600) >= 4:
        return "PvZ - 2 Stargate Void Ray"
    if sg_count_10min >= 3 and nexus_count_10min >= 2 and count_units("Phoenix", 600) >= 4:
        return "PvZ - 3 Stargate Phoenix"
    # Strict exactly-2: the 3+ variant above catches the heavier
    # build, so anything still reaching here with 3+ Stargates
    # has already returned. The explicit equality guards against
    # someone reordering the rules later and accidentally letting
    # 3-Stargate replays fall through to the 2-Stargate label.
    if sg_count_10min == 2 and nexus_count_10min >= 2 and count_units("Phoenix", 600) >= 4:
        return "PvZ - 2 Stargate Phoenix"
    # Rail's Disruptor Drop: Disruptor needs Robo + Robo Bay,
    # Warp Prism needs Robo. Robo presence is implied by the
    # prereq filter; spell it out for clarity.
    if (
        has_building("RoboticsFacility", 480)
        and has_building("RoboticsBay", 480)
        and count_units("Disruptor", 480) >= 1
        and count_units("WarpPrism", 480) >= 1
    ):
        return "PvZ - Rail's Disruptor Drop"

    # Oracle (Stargate) + Robo + Forge composition.
    if (
        has_building("Stargate", 510)
        and count_units("Oracle", 510) >= 2
        and has_building("RoboticsFacility", 510)
        and has_building("Forge", 510)
        and sum(1 for b in buildings if b["name"] == "Nexus" and b["time"] < 510) >= 3
    ):
        return "PvZ - AlphaStar Style (Oracle/Robo)"

    # 7 Gate Glaive/Immortal all-in: Immortals require Robotics
    # Facility, Glaive research requires Twilight Council. The
    # sc2reader raw name for Resonating Glaives is
    # "AdeptPiercingAttack"; older callers used "Glaive" which
    # silently never matched. Allow both.
    if (
        (
            has_upgrade_substr("AdeptPiercing", 510)
            or has_upgrade_substr("Glaive", 510)
        )
        and has_building("RoboticsFacility", 510)
        and count_units("Sentry", 510) >= 2
        and count_units("Immortal", 510) >= 1
        and gate_count_6min >= 6
    ):
        return "PvZ - 7 Gate Glaive/Immortal All-in"

    if has_upgrade_substr("Blink", 480) and gate_count_530 >= 5:
        if not has_building("Stargate", 480) and not has_building("DarkShrine", 480):
            return "PvZ - Blink Stalker All-in (2 Base)"

    sg_time = building_time("Stargate")
    twilight_time = building_time("TwilightCouncil")
    # Identify WHICH upgrade is researched first out of the
    # Twilight Council — the signal that separates Adept Glaive
    # Timings (Glaives first) from Stargate-into-Blink (Blink
    # first) and Charge openers (Charge first). sc2reader emits
    # raw upgrade_type_name values, so "AdeptPiercingAttack" is
    # the Glaive event; "Blink" matches "BlinkTech"; "Charge"
    # matches itself. See ``upgrade_time`` at function scope.
    robo_time = building_time("RoboticsFacility")
    dark_shrine_time = building_time("DarkShrine")
    glaive_time = upgrade_time("AdeptPiercing", "Glaive")
    blink_time = upgrade_time("Blink")
    charge_time = upgrade_time("Charge")
    glaive_first_off_twilight = (
        glaive_time < 9999
        and glaive_time < blink_time
        and glaive_time < charge_time
    )
    # Twilight Council is the FIRST tech building after the
    # Cybernetics Core: no Stargate / Robotics Facility / Dark
    # Shrine has been started before it. (Templar Archives /
    # Fleet Beacon / Robotics Bay each REQUIRE one of those,
    # so they cannot be earlier and need no separate guard.)
    twilight_first_tech = (
        twilight_time < 480
        and twilight_time < sg_time
        and twilight_time < robo_time
        and twilight_time < dark_shrine_time
    )

    # Stargate into Glaives (refined): Stargate goes down first
    # as the tech building, Twilight comes after it, and the
    # FIRST upgrade out of Twilight is Glaives (NOT Blink — that
    # would be Stargate into Blink). 4-8 Gateways by 9:00 covers
    # both Phoenix-and-Glaive and Oracle-and-Glaive variants.
    if (
        sg_time < 420
        and twilight_time > sg_time
        and twilight_time < 9999
        and glaive_first_off_twilight
        and (4 <= gate_count_6min <= 8)
    ):
        return "PvZ - Stargate into Glaives"

    # Adept Glaives (Twilight First + Robo): Twilight is the
    # FIRST tech, Glaives is the FIRST upgrade out of Twilight,
    # 4-8 Gateways by 9:00, AND a Robotics Facility is in place
    # (Observer detection / Immortal armor support).
    if (
        twilight_first_tech
        and glaive_first_off_twilight
        and (4 <= gate_count_6min <= 8)
        and has_building("RoboticsFacility", 600)
    ):
        return "PvZ - Adept Glaives (Robo)"

    # Adept Glaives (Twilight First, No Robo): same opening +
    # upgrade signature as the Robo variant but no Robotics
    # Facility — a pure Gateway Adept Glaive Timing.
    if (
        twilight_first_tech
        and glaive_first_off_twilight
        and (4 <= gate_count_6min <= 8)
        and not has_building("RoboticsFacility", 600)
    ):
        return "PvZ - Adept Glaives (No Robo)"
    if (
        sg_time < twilight_time
        and has_building("TemplarArchive", 540)
        and count_units("Archon", 540) >= 2
    ):
        return "PvZ - Archon Drop"
    # DT drop into Archon: needs Dark Shrine for the DTs and a
    # Robotics Facility for the Warp Prism.
    if (
        twilight_time < building_time("DarkShrine")
        and has_building("DarkShrine", 540)
        and has_building("RoboticsFacility", 540)
        and count_units("DarkTemplar", 540) >= 3
        and count_units("WarpPrism", 540) >= 1
    ):
        return "PvZ - DT drop into Archon Drop"
    if (
        sg_time < twilight_time
        and has_upgrade_substr("Blink", 600)
        and sum(1 for b in buildings if b["name"] == "Nexus" and b["time"] < 540) >= 3
    ):
        return "PvZ - Standard Blink Macro"
    if (
        sg_time < twilight_time
        and has_upgrade_substr("Charge", 540)
        and sum(1 for b in buildings if b["name"] == "Nexus" and b["time"] < 540) >= 3
    ):
        return "PvZ - Standard charge Macro"

    if has_building("RoboticsFacility", 420):
        robo_t = building_time("RoboticsFacility")
        if robo_t < sg_time and robo_t < twilight_time:
            return "PvZ - Robo Opener"
    return "PvZ - Macro Transition (Unclassified)"
