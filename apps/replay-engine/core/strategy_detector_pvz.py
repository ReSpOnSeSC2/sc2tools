"""Protoss-vs-Zerg user-build classification tree.

Pure function: given a :class:`DetectionContext` for a Protoss player in
a PvZ matchup, return the build-label string. The caller
(``UserBuildDetector.detect_my_build``) decides when to dispatch here
based on the matchup string.
"""

from __future__ import annotations

from typing import Optional

from .strategy_detector_helpers import (
    DetectionContext,
    base_count_at,
    count_started_before,
    nth_base_start,
)


ALPHASTAR_ROBO_DEADLINE_SECONDS = 5 * 60 + 30
STANDARD_MACRO_THIRD_FOLLOW_WINDOW_SECONDS = 4 * 60


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

    sg_count_10min = count_started_before(buildings, "Stargate", 600)
    nexus_count_10min = base_count_at(buildings, "Nexus", 600)

    # OPENER ordering used by every Stargate-rush label below. A build
    # only counts as a "Stargate opener" when the Stargate is the
    # FIRST tech committed -- built before any Twilight Council / Dark
    # Shrine / Robotics Facility. Pure ordering, no time threshold:
    # if NOTHING else was built first, the build IS a Stargate opener
    # even if the Stargate went down late (slow openers still count).
    # If Twilight / Robo / DarkShrine came first, the build is a
    # transition INTO Stargate from that tech path and should land on
    # the correct opener label (Adept Glaives / Robo Opener / DT
    # Opener) further down the tree -- never on a "2 Stargate X" rush
    # label.
    #
    # ``sg_time < 9999`` keeps the sentinel-only case (no Stargate
    # built at all) from satisfying the comparison trio via the 9999
    # default on every side.
    sg_time = building_time("Stargate")
    twilight_time = building_time("TwilightCouncil")
    robo_time = building_time("RoboticsFacility")
    dark_shrine_time = building_time("DarkShrine")
    stargate_first_tech = (
        sg_time < 9999
        and sg_time < twilight_time
        and sg_time < dark_shrine_time
        and sg_time < robo_time
    )

    # Hoisted from below: identifies WHICH upgrade is researched first
    # out of the Twilight Council. The Stargate-rush rules below use
    # this to disqualify themselves on builds that researched Glaives
    # as the first Twilight upgrade -- those are fundamentally Glaives
    # builds (the Phoenix / Void Rays are scouting / harass support),
    # not pure Stargate-tech builds, and they should land on the
    # Stargate-into-Glaives label further down the tree even when the
    # late Phoenix count crosses the 2 SG Phoenix headline threshold.
    glaive_time = upgrade_time("AdeptPiercing", "Glaive")
    blink_time = upgrade_time("Blink")
    charge_time = upgrade_time("Charge")
    glaive_first_off_twilight = (
        glaive_time < 9999
        and glaive_time < blink_time
        and glaive_time < charge_time
    )
    blink_first_off_twilight = (
        blink_time < 9999
        and blink_time < glaive_time
        and blink_time < charge_time
    )
    charge_first_off_twilight = (
        charge_time < 9999
        and charge_time < glaive_time
        and charge_time < blink_time
    )
    third_nexus_time = nth_base_start(buildings, "Nexus", 3)
    third_nexus_supports_macro = (
        sg_time < third_nexus_time <= 540
        and third_nexus_time
        <= twilight_time + STANDARD_MACRO_THIRD_FOLLOW_WINDOW_SECONDS
    )
    stargate_into_glaives = (
        stargate_first_tech
        and twilight_time < robo_time
        and glaive_first_off_twilight
    )

    # These three-base Twilight transitions are intentionally computed before
    # the generic Stargate-into-Robo rule. Twilight must precede any support
    # Robo: a genuinely early Robo remains a Robo transition even if Blink or
    # Charge is researched later. The third follows the Stargate, but may
    # precede Twilight or follow it within four minutes; a much later third is
    # not retroactively called macro.
    standard_blink_macro = (
        stargate_first_tech
        and sg_time < twilight_time < robo_time
        and third_nexus_supports_macro
        and blink_time <= 600
        and blink_first_off_twilight
    )
    standard_charge_macro = (
        stargate_first_tech
        and sg_time < twilight_time < robo_time
        and third_nexus_supports_macro
        and charge_time <= 540
        and charge_first_off_twilight
    )

    # Carrier / Tempest both require Stargate + Fleet Beacon.
    # count_units already filters hallucinations, but document
    # the prerequisite so a future refactor can't drop it.
    if (
        stargate_first_tech
        and has_building("FleetBeacon", 600)
        and count_units("Carrier", 600) >= 1
    ):
        return "PvZ - Carrier Rush"
    if (
        stargate_first_tech
        and has_building("FleetBeacon", 600)
        and count_units("Tempest", 600) >= 1
    ):
        return "PvZ - Tempest Rush"
    # Pure-Phoenix / pure-VR disqualifiers: a Stargate opener that
    # ALSO commits to a tech-switch (Glaives off Twilight, or an
    # EARLY Robotics Facility for Immortal / Observer / Disruptor) is
    # a hybrid build (Stargate into Robo, Stargate into Glaives), NOT
    # a pure 2/3 SG Phoenix or 2 SG VR opener. The "pure" labels here
    # require the Phoenix / VRs to BE the build -- not Stargate-tech
    # support for a Robo / Twilight follow-up.
    #
    # `not glaive_first_off_twilight` blocks Glaives-first hybrids
    # (those fall through to PvZ - Stargate into Glaives). The Robo
    # guard blocks Robo hybrids (those fall through to PvZ - Stargate
    # into Robo below). NOTE the windows differ: the 2 SG Void Ray
    # rule rejects only an EARLY Robo (before 6:00) -- a heavy 4+ Void
    # Ray commitment that adds a LATER Robo is air-first with Observer
    # / Immortal support, not a Robo transition, so a late Robo must
    # not steal it. The Phoenix rules keep the full 10:00 window:
    # lighter Phoenix harass that picks up any Robo really is a
    # Stargate-into-Robo transition.
    if (
        stargate_first_tech
        and sg_count_10min >= 2
        and nexus_count_10min >= 2
        and count_units("VoidRay", 600) >= 4
        and not glaive_first_off_twilight
        and not has_building("RoboticsFacility", 360)
    ):
        return "PvZ - 2 Stargate Void Ray"
    if (
        stargate_first_tech
        and sg_count_10min >= 3
        and nexus_count_10min >= 2
        and count_units("Phoenix", 600) >= 4
        and not glaive_first_off_twilight
        and not has_building("RoboticsFacility", 600)
    ):
        return "PvZ - 3 Stargate Phoenix"
    # Strict exactly-2: the 3+ variant above catches the heavier
    # build, so anything still reaching here with 3+ Stargates
    # has already returned. The explicit equality guards against
    # someone reordering the rules later and accidentally letting
    # 3-Stargate replays fall through to the 2-Stargate label.
    if (
        stargate_first_tech
        and sg_count_10min == 2
        and nexus_count_10min >= 2
        and count_units("Phoenix", 600) >= 4
        and not glaive_first_off_twilight
        and not has_building("RoboticsFacility", 600)
    ):
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

    # AlphaStar's PvZ sequence is specifically Stargate -> fast third -> fast
    # Robo. The third Nexus must already be started when the Robo begins, and
    # that Robo must start by 5:30 and precede any Twilight Council. Two Oracles
    # + a Forge still confirm the eventual Oracle/Robo composition, but a late
    # or Twilight-following Robo is a normal three-base Stargate transition
    # (Blink, Charge, or Glaives), not AlphaStar.
    if (
        stargate_first_tech
        and count_units("Oracle", 510) >= 2
        and sg_time < third_nexus_time
        < robo_time <= ALPHASTAR_ROBO_DEADLINE_SECONDS
        and robo_time < twilight_time
        and has_building("Forge", 510)
    ):
        return "PvZ - AlphaStar Style (Oracle/Robo)"

    # Stargate into Robo: Stargate-first opener (Phoenix / Oracle / VR
    # harass) that adds a Robotics Facility for Immortal / Observer /
    # Disruptor support. The classic Stargate-into-Robo transition
    # style. Counterpart of PvT - Phoenix into Robo. Without this rule a
    # Stargate-first build with both Phoenix and Robo mis-fires the
    # 2/3 SG Phoenix rules above on the Phoenix-count signature alone
    # (now blocked by the `not has_building("RoboticsFacility", 600)`
    # guard those rules picked up) and would otherwise fall through
    # to "PvZ - Macro Transition (Unclassified)".
    #
    # Accepts Phoenix / Oracle / VoidRay as the Stargate-unit signal
    # (any one suffices) so a Stargate-Oracle into Robo build (without
    # 2 Oracles + Forge + 3 bases needed for AlphaStar Style) lands
    # here too.
    #
    # `not stargate_into_glaives` guards the transition order: Stargate
    # -> Twilight/Glaives -> Robo uses the Glaives label because the Robo
    # is support, while Stargate -> Robo -> later Twilight/Glaives remains
    # a Robo-first transition. The standard macro booleans apply the same
    # ordering rule for Blink and Charge.
    if (
        stargate_first_tech
        and has_building("RoboticsFacility", 600)
        and not stargate_into_glaives
        and not standard_blink_macro
        and not standard_charge_macro
        and (
            count_units("Phoenix", 600) >= 1
            or count_units("Oracle", 600) >= 1
            or count_units("VoidRay", 600) >= 1
        )
    ):
        return "PvZ - Stargate into Robo"

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

    # ``glaive_time`` / ``blink_time`` / ``charge_time`` / the
    # ``glaive_first_off_twilight`` flag, plus ``sg_time`` /
    # ``twilight_time`` / ``robo_time`` / ``dark_shrine_time`` are all
    # hoisted to the top of the function so the Stargate-opener guard
    # AND the Glaives-disqualifier guard on the 2/3 SG Phoenix and 2 SG
    # Void Ray rules can use them above. sc2reader emits raw
    # upgrade_type_name values: "AdeptPiercingAttack" is the Glaive
    # event; "Blink" matches "BlinkTech"; "Charge" matches itself.
    # Twilight Council is the FIRST tech building after the
    # Cybernetics Core: no Stargate / Robotics Facility / Dark
    # Shrine has been started before it. (Templar Archives /
    # Fleet Beacon / Robotics Bay each REQUIRE one of those,
    # so they cannot be earlier and need no separate guard.)
    # Pure ordering, no time threshold -- same principle as
    # ``stargate_first_tech``: if NOTHING else was tech'd first,
    # the build IS a Twilight opener even if Twilight went down late.
    # Downstream constraints (gate count, glaive_first_off_twilight)
    # filter out non-Glaives Twilight openers.
    twilight_first_tech = (
        twilight_time < 9999
        and twilight_time < sg_time
        and twilight_time < robo_time
        and twilight_time < dark_shrine_time
    )

    # Stargate into Glaives (refined): Stargate goes down first
    # as the tech building, Twilight comes after it, and the
    # FIRST upgrade out of Twilight is Glaives (NOT Blink — that
    # would be Stargate into Blink). Classification is purely
    # order-based -- the build IS a Stargate-into-Glaives the
    # moment Glaives is the first Twilight upgrade off a Twilight
    # that followed the Stargate, regardless of how many Gateways
    # back it. The old ``4 <= gate_count_6min <= 8`` window was an
    # artificial cap that dropped legitimate Glaive Adept builds:
    # heavier timings / all-ins routinely warp 9+ Gateways (mass
    # Adepts ARE the build) and so fell through to Standard Blink
    # Macro whenever Blink was researched second and a 3rd Nexus
    # was taken. The PvT - Stargate into Glaives rule has no gate
    # window for exactly this reason; this mirrors it. The
    # ``stargate_into_glaives`` requires Stargate as the first tech,
    # Twilight before any Robo, and Glaives as the first upgrade (before
    # Blink AND Charge). A later support Robo therefore cannot steal an
    # otherwise clear Glaive Adept transition, while Robo-before-Twilight
    # remains a genuine Stargate-into-Robo / AlphaStar path.
    if stargate_into_glaives:
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
    # Standard DT Opener: Dark Shrine is built BEFORE any Stargate /
    # Robotics Facility (pure ordering -- no time threshold) and at
    # least one real Dark Templar lands within the harass window. This
    # is the catch-all for DT openers that transition into mid- or
    # late-game tech (Skytoss, Templar, Mothership). Without this rule
    # a DT build that later picks up a Stargate + Fleet Beacon +
    # Carrier used to mis-fire as "PvZ - Carrier Rush" or fall through
    # to "PvZ - Macro Transition (Unclassified)". DarkShrine requires
    # Twilight Council as prereq, so a Twilight-first ordering is
    # implicit and isn't checked separately -- DT Opener means
    # "DarkShrine is the primary AlternaTIVE-tech committed", i.e.
    # before Stargate / Robo.
    if (
        dark_shrine_time < 9999
        and dark_shrine_time < sg_time
        and dark_shrine_time < robo_time
        and count_units("DarkTemplar", 540) >= 1
    ):
        return "PvZ - DT Opener"
    if standard_blink_macro:
        return "PvZ - Standard Blink Macro"
    if standard_charge_macro:
        return "PvZ - Standard charge Macro"

    # Robo Opener: Robotics Facility is the FIRST tech building (before
    # any Stargate / Twilight Council / Dark Shrine). Pure ordering --
    # no time threshold -- so a slow Robo opener with no other tech
    # before it still classifies. Dark Shrine requires Twilight as
    # prereq, so ``robo_time < dark_shrine_time`` is implied by
    # ``robo_time < twilight_time`` but spelled out for symmetry with
    # the other opener rules.
    if (
        robo_time < 9999
        and robo_time < sg_time
        and robo_time < twilight_time
        and robo_time < dark_shrine_time
    ):
        return "PvZ - Robo Opener"
    # Stargate Opener (catch-all): a Stargate-first opener that didn't
    # match any of the more specific Stargate-prefixed rules above
    # (Carrier Rush, Tempest Rush, 2/3 SG Phoenix, 2 SG VR, AlphaStar,
    # Stargate into Robo, Stargate into Glaives, Standard Blink /
    # Charge Macro). Without this catch-all, a Stargate-first build
    # with no Phoenix / Oracle / VR (e.g. Stargate was harassed off
    # before producing) or with an unusual transition (Stargate into
    # Templar Archive without 2 Archons by 9:00, etc.) used to fall
    # through to "Macro Transition (Unclassified)". Mirror of PvT -
    # Stargate Opener.
    if stargate_first_tech:
        return "PvZ - Stargate Opener"
    return "PvZ - Macro Transition (Unclassified)"
