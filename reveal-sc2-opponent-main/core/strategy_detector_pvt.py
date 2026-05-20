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

from .strategy_detector_helpers import (
    DetectionContext,
    base_count_at,
    count_started_before,
    nth_base_start,
    start_times,
)


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

    sec_nexus_time = nth_base_start(buildings, "Nexus", 2)
    third_nexus_time = nth_base_start(buildings, "Nexus", 3)
    total_nexuses = base_count_at(buildings, "Nexus")

    robo_time = building_time("RoboticsFacility")
    sg_time = building_time("Stargate")
    twilight_time = building_time("TwilightCouncil")
    ta_time = building_time("TemplarArchive")
    gate_count_730 = count_started_before(buildings, "Gateway", 450)

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
        gate_starts = start_times(buildings, "Gateway")
        if len(gate_starts) >= 2 and gate_starts[1] < robo_time:
            return "PvT - Phoenix Opener"

    # 7-Gate Blink All-in vs 3-base Blink macro: the 5th Gateway must
    # be STARTED before the 3rd Nexus is STARTED. "Taken" the 3rd
    # Nexus means construction was initiated, not finished -- a player
    # can drop the 3rd Nexus and keep adding Gateways while it is
    # still building (~100s Nexus build time) and those Gateways are
    # still macro reinforcement, not all-in production. Without this
    # guard, a 3-base Blink macro that ends up with 6-8 Gateways gets
    # mistagged as a 7-Gate Blink All-in.
    #
    # Blink-FIRST ordering guard: an "all-in" label should hinge on
    # which upgrade was committed to first, not on whether Blink ever
    # finished researching. A Charge-first or Glaives-first build that
    # later picks up Blink with 6+ Gates on 2 bases is a hybrid timing
    # / Adept push, not a Blink all-in. Mirror the same first-upgrade
    # pattern Standard Charge Macro / 3 Gate Charge Opener use.
    gateway_starts = start_times(buildings, "Gateway")
    fifth_gateway_started = (
        gateway_starts[4] if len(gateway_starts) >= 5 else 9999
    )
    if (
        has_upgrade_substr("Blink", 540)
        and gate_count_6min >= 6
        and fifth_gateway_started < third_nexus_time
        and pvt_blink_time == pvt_first_twilight_upgrade
    ):
        return "PvT - 7 Gate Blink All-in"
    # Charge-FIRST ordering guard mirrors the 7-Gate-Blink rule above:
    # a Blink-first / Glaives-first build that later researches Charge
    # with 7+ Gateways on 2 bases is not a Charge all-in -- it is a
    # hybrid that committed to Stalkers / Adepts first. Require Charge
    # to be the first Twilight upgrade.
    if (
        has_upgrade_substr("Charge", 540)
        and gate_count_730 >= 7
        and total_nexuses < 3
        and pvt_charge_time == pvt_first_twilight_upgrade
    ):
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
    #
    # Charge must also be the FIRST Twilight upgrade. Without
    # this ordering guard, a Blink-first / Charge-after 3-base
    # build matches on the Charge-existence + 3-Nexus + no-SG
    # signature alone and gets mistagged here -- it is really a
    # 3 Gate Blink (Macro) game that happened to research Charge
    # second. Mirror the same first-upgrade pattern the
    # Stargate-into-X and 3 Gate Charge Opener rules use.
    if (
        has_upgrade_substr("Charge", 540)
        and total_nexuses >= 3
        and not has_building("Stargate", 9999)
        and pvt_charge_time == pvt_first_twilight_upgrade
    ):
        return "PvT - Standard Charge Macro"
    # Charge must be the FIRST Twilight upgrade for this label. Without
    # the ordering guard, a Blink-first / Charge-after build with
    # Twilight before Robo+SG matches both this rule and the Blink rule
    # below — and the Charge rule wins by file order, mistagging the
    # game. Mirror the Stargate-into-X ordering pattern from L82-97.
    if (
        has_upgrade_substr("Charge", 540)
        and twilight_time < robo_time
        and twilight_time < sg_time
        and pvt_charge_time == pvt_first_twilight_upgrade
    ):
        return "PvT - 3 Gate Charge Opener"

    # X Gate Blink rules: the gate count that names each label is the
    # number of Gateways the player STARTED BEFORE their 3rd Nexus
    # went down. That's the macro-vs-aggression signal -- a player
    # who committed to 4 Gateways before taking the 3rd is doing a
    # heavier 4-Gate Blink, while a 2-Gate / fast-3rd-Nexus opener
    # delays the extra Gateways until after the economy is secured.
    # Counting "Gateways by 7:30" got the right answer most of the
    # time but mistagged builds where the player took the 3rd Nexus
    # FAST (e.g. 3rd Nexus at 5:30) and then added Gateways during
    # the 3rd Nexus's build -- those gates are macro reinforcement,
    # not all-in commitment.
    #
    # When the player never took a 3rd Nexus, third_nexus_time is
    # 9999 and gates_before_third_nexus collapses to the total
    # Gateway count, so a 2-base 4-Gate Blink still classifies.
    # The 7-Gate Blink All-in rule above keys on 6+ Gateways with
    # 5th gate before 3rd Nexus, so it fires first for mass-gate
    # aggression and the 4 Gate Blink branch only sees 4-5 gate
    # builds.
    gates_before_third_nexus = count_started_before(
        buildings, "Gateway", third_nexus_time,
    )

    if (
        twilight_time < robo_time
        and twilight_time < sg_time
        and has_upgrade_substr("Blink", 540)
    ):
        if gates_before_third_nexus >= 4:
            return "PvT - 4 Gate Blink"
        if gates_before_third_nexus == 3:
            return "PvT - 3 Gate Blink (Macro)"

    if (
        has_upgrade_substr("Blink", 480)
        and total_nexuses >= 3
        and gates_before_third_nexus == 2
        and has_building("RoboticsFacility", 480)
    ):
        return "PvT - 2 Gate Blink (Fast 3rd Nexus)"

    # DT Drop: a fast tactical opener where the player commits to Dark
    # Shrine EARLY, warps in a Dark Templar, and ferries it across the
    # map in a Warp Prism for a 4-5 minute mark drop.
    #
    # Cutoffs are calibrated against a real PvT DT Drop replay
    # (Peruano, Taito Citadel LE, 2026-05-11) with ~60s of buffer per
    # signal so slower variants still classify. The reference replay's
    # actual timings:
    #   * Dark Shrine started 3:13 -> cutoff 4:15 (255s)
    #   * Robotics Facility   3:32 -> cutoff 4:30 (270s)
    #   * First Dark Templar  3:51 -> cutoff 5:00 (300s)
    #   * Warp Prism on field 4:11 -> cutoff 5:15 (315s)
    #
    # The earlier version of this rule fired on Dark Shrine by 9:00 +
    # Robo by 10:00 + Warp Prism by 10:00 + (>=1 DT by 10:00) -- the
    # DarkTemplar guard fixed the no-DT misfire (Tourmaline LE
    # 2026-05-20 Robo First with late Dark Shrine), but the 8-10
    # minute windows still let in any build with a mid-game Dark
    # Shrine that warped in a single DT for harass. Tightening to the
    # observed-plus-buffer window matches the *opener's* intent: if
    # the Shrine isn't up by 4:15 and the DT isn't on the field by
    # 5:00, the build is something else (Robo First with late tech, a
    # delayed DT-counter, etc.).
    #
    # count_units is prereq-aware so a Sentry-hallucinated DarkTemplar
    # (DarkTemplar event with no Dark Shrine built yet) still cannot
    # satisfy the unit guard.
    if (
        has_building("DarkShrine", 255)
        and has_building("RoboticsFacility", 270)
        and count_units("WarpPrism", 315) >= 1
        and count_units("DarkTemplar", 300) >= 1
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
