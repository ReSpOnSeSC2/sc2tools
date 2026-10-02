"""Protoss-vs-Protoss user-build classification tree.

Pure function: given a :class:`DetectionContext` for a Protoss player in
a PvP matchup, return the build-label string. The caller
(``UserBuildDetector.detect_my_build``) decides when to dispatch here
based on the matchup string.

Ordering principle (shared with the PvZ / PvT trees): an opener is
defined by the tech the player committed to first.

  1. A proxy 2-Gate -- told apart from the other proxies by TIMING:
     its Gateways go down around 1:00-1:30, long before the forward
     Gateway a proxy Robo drops beside its Robotics Facility (~2:20).
  2. Expand openers -- but only when NO tech building was started
     before the natural. A Stargate / Robo / Twilight before the
     natural makes the game a tech-first opener, so the tech rules
     below get first claim; the expand label is kept as the fallback
     when none of them recognises the game, so it never degrades to
     "Macro Transition (Unclassified)".
  3. Tech / style rules, most specific first; the proxied Robotics
     Facility / Stargate openers sit here, in their original place,
     ahead of the Standard Stargate Opener and Robo Opener catch-alls.
"""

from __future__ import annotations

from typing import Optional

from .strategy_detector_helpers import (
    PROXY_2_GATE_GATEWAY_DEADLINE_SECONDS,
    DetectionContext,
    base_count_at,
    count_started_before,
    nth_base_start,
    start_times,
)


# Tech buildings that turn an expand into a tech-first opener when they
# are started before the natural Nexus.
_PVP_EXPAND_TECH = ("Stargate", "RoboticsFacility", "TwilightCouncil")

# The proxy 2-Gate Gateway deadline (PROXY_2_GATE_GATEWAY_DEADLINE_SECONDS,
# 1:45) is shared with the PvT / PvZ trees and the opponent tree; see
# strategy_detector_helpers for the timing rationale.


def detect_pvp(ctx: DetectionContext) -> Optional[str]:
    """Return the PvP user-build label, or ``None`` if no rule matched."""
    has_building = ctx.has_building
    has_proxy = ctx.has_proxy
    count_units = ctx.count_units
    has_upgrade_substr = ctx.has_upgrade_substr
    building_time = ctx.building_time
    upgrade_time = ctx.upgrade_time
    gate_count_6min = ctx.gate_count_6min
    buildings = ctx.buildings
    units = ctx.units
    upgrades = ctx.upgrades

    sec_nexus_time = nth_base_start(buildings, "Nexus", 2)
    total_nexuses = base_count_at(buildings, "Nexus")

    # Glaives-first ordering signal (mirror of the PvZ / PvT trees).
    # Resonating Glaives being the FIRST upgrade researched out of the
    # Twilight Council -- BEFORE Blink and BEFORE Charge -- is what
    # marks an Adept Glaive build. Computed up front because the two
    # Glaive labels below need to (a) override the generic 1/2 Gate
    # Expand opener labels in the early-expand block and (b) pre-empt
    # the Blink-keyed rules (Rail's Blink Stalker / Blink Stalker
    # Style) further down. sc2reader emits "AdeptPiercingAttack" for
    # Glaives, "BlinkTech" for Blink, "Charge" for Charge.
    robo_time = building_time("RoboticsFacility")
    twilight_time = building_time("TwilightCouncil")
    sg_time = building_time("Stargate")
    glaive_time = upgrade_time("AdeptPiercing", "Glaive")
    blink_time = upgrade_time("Blink")
    charge_time = upgrade_time("Charge")
    glaive_first_off_twilight = (
        glaive_time < 9999
        and glaive_time < blink_time
        and glaive_time < charge_time
    )

    # ------------------------------------------------------------------
    # 1. Proxy 2 Gate
    # ------------------------------------------------------------------
    # A proxy is a structure more than 50 world units from the player's
    # OWN main (see BaseStrategyDetector._is_proxy); every proxy rule in
    # this tree shares that test.
    #
    # Timing is what separates a proxy 2-Gate from a proxy Robo. The
    # rule used to accept ANY proxied Gateway started before 4:30, so
    # the forward Gateway a proxy Robo drops beside its Robotics
    # Facility at ~2:20 (the Gateways at home went down at the normal
    # 0:40 / 1:10) labelled every proxy Robo "PvP - Proxy 2 Gate", and
    # the Proxy Robo rule further down never saw those games. A real
    # proxy 2-Gate / 3-Gate has its Gateways down by ~1:15, so the
    # Gateway must start by PROXY_2_GATE_GATEWAY_DEADLINE_SECONDS (1:45,
    # with margin); a forward Gateway in the 2:00-3:00 band (proxy Robo,
    # 3-4 Gate with a proxy Gateway) is not one.
    #
    # Tightened: a real proxy 2-Gate is committed -- no early
    # natural. Without this guard, ANY gateway that registers
    # far from the player's own main (forward gate during a 4-Gate
    # timing, mis-tagged distance, etc.) was being mis-classified as
    # "Proxy 2 Gate" even on FE-into-X games.
    if (
        has_proxy("Gateway", PROXY_2_GATE_GATEWAY_DEADLINE_SECONDS, 50)
        and not (sec_nexus_time < 270)
    ):
        return "PvP - Proxy 2 Gate"

    # Proxied tech, used by the proxy openers below and as guards on
    # the home-Stargate / home-Robo catch-alls.
    proxy_robo = has_proxy("RoboticsFacility", 390)
    proxy_stargate = has_proxy("Stargate", 390)

    # ------------------------------------------------------------------
    # 2. Expand openers
    # ------------------------------------------------------------------
    # A tech building STARTED before the natural makes the game a
    # tech-first opener: the 2 Gate Expand rule always said so, but the
    # 1 Gate Expand / Strange's rules returned unconditionally, so in
    # the 12-worker game -- where a 1-gate Stargate / Robo / Twilight
    # opener routinely takes its natural before 5:00 -- "PvP - 1 Gate
    # Expand" swallowed the Standard Stargate Opener, Phoenix Style,
    # Blink Stalker Style, AlphaStar, 4 Stalker Oracle into DT and
    # Rail's Blink Stalker games (and the Robo-first games that had no
    # label at all). The expand label is now only returned outright
    # when nothing was tech'd before the natural; otherwise it is kept
    # as ``expand_fallback`` and returned only when no tech rule below
    # recognises the game.
    tech_before_natural = any(
        b["name"] in _PVP_EXPAND_TECH and b["time"] < sec_nexus_time
        for b in buildings
    )
    expand_fallback: Optional[str] = None

    gate_times = start_times(buildings, "Gateway")
    # Count gateways that were started BEFORE the second Nexus
    # started warping in. This is what distinguishes the
    # 1-gate expand (Strange's / standard) from the 2-gate expand
    # (which is a separate, well-known PvP opener). Previously we
    # only required `len(gate_times) >= 1`, which let any 2+ gate
    # expand fall into the Strange's bucket as long as the first
    # produced unit happened to be a Sentry.
    if sec_nexus_time < 300:
        second_nexus = sec_nexus_time
        gates_before_expand = sum(1 for t in gate_times if t < second_nexus)

        first_unit = next(
            (u["name"] for u in sorted(units, key=lambda x: x["time"])
             if u["name"] in ("Stalker", "Adept", "Sentry", "Zealot")),
            None,
        )

        # 2 Gate Expand: 2 (or more) gateways started before the
        # natural goes down. This is the "safe" PvP opener that
        # protects against proxy 2-gate / early aggression while still
        # taking the natural early. Falls through on a Glaives-first
        # transition so the Glaive labels below can claim it.
        if gates_before_expand >= 2 and not glaive_first_off_twilight:
            if not tech_before_natural:
                return "PvP - 2 Gate Expand"
            expand_fallback = "PvP - 2 Gate Expand"

        # Strange's 1 Gate Expand: exactly 1 gateway before the
        # natural, AND the first warp-in is a Sentry (the
        # signature of the build).
        elif gates_before_expand == 1 and first_unit == "Sentry":
            if not tech_before_natural:
                return "PvP - Strange's 1 Gate Expand"
            expand_fallback = "PvP - Strange's 1 Gate Expand"

        elif gates_before_expand == 1 and first_unit in ("Stalker", "Adept", "Zealot"):
            # 1 Gate Nexus into 4 Gate: standard 1-gate FE that
            # transitions into a 4-Gate Stalker timing. Checked BEFORE
            # the generic "1 Gate Expand" so the 4-Gate signal upgrades
            # the classification. Its own guard (no tech before the 4th
            # Gateway) already rules out tech-first games.
            _gate_count_6min = count_started_before(buildings, "Gateway", 360)
            _fourth_gate_time = (
                gate_times[3] if len(gate_times) >= 4 else 9999
            )
            _PVP_4G_TECH = (
                "Stargate", "RoboticsFacility",
                "TwilightCouncil", "TemplarArchive", "DarkShrine",
            )
            _tech_before_4th_gate = any(
                b["name"] in _PVP_4G_TECH and b["time"] < _fourth_gate_time
                for b in buildings
            )
            # Upgrade events carry the research COMPLETION time, so this
            # is "Warp Gate finishes by 5:30".
            _warpgate_research_time = next(
                (u["time"] for u in upgrades if "WarpGate" in u["name"]),
                9999,
            )
            if (
                _gate_count_6min >= 4
                and not _tech_before_4th_gate
                and _warpgate_research_time <= 330
            ):
                return "PvP - 1 Gate Nexus into 4 Gate"

            # Standard 1 Gate Expand: exactly 1 gateway before the
            # natural, first unit is something other than a Sentry.
            # Falls through on a Glaives-first transition so the Robo
            # into Glaives / Adept Glaives labels below can claim it --
            # a Glaive Adept build that opened 1-gate-expand is still a
            # Glaive build, not a generic expand.
            if not glaive_first_off_twilight:
                if not tech_before_natural:
                    return "PvP - 1 Gate Expand"
                expand_fallback = "PvP - 1 Gate Expand"

    # ------------------------------------------------------------------
    # 3. Tech / style rules
    # ------------------------------------------------------------------
    # AlphaStar 4 Adept / Oracle requires both a Cyber Core path
    # and a Stargate. The Oracle prereq is enforced by count_units
    # but the explicit has_building guard documents the intent.
    if (
        has_building("Stargate", 390)
        and count_units("Adept", 360) >= 4
        and count_units("Oracle", 390) >= 1
    ):
        return "PvP - AlphaStar (4 Adept/Oracle)"
    if (
        has_building("Stargate", 450)
        and count_units("Stalker", 390) >= 3
        and count_units("Oracle", 450) >= 1
        and has_building("DarkShrine", 540)
    ):
        return "PvP - 4 Stalker Oracle into DT"

    # Robo into Glaives: Robotics Facility is built BEFORE the Twilight
    # Council and Glaives is the FIRST upgrade off that Twilight (before
    # Blink AND Charge). A common PvP transition -- a Robo (Immortal /
    # Observer) opening into a Glaive Adept timing. Sits ABOVE Rail's
    # Blink Stalker (Robo 1st), which is also Robo-first but checks no
    # upgrade at all; without this guard a Robo-first build that
    # researched Glaives first would mis-tag as a Blink Stalker style.
    if (
        robo_time < 9999
        and robo_time < twilight_time
        and twilight_time < 9999
        and glaive_first_off_twilight
    ):
        return "PvP - Robo into Glaives"
    # Adept Glaives: Twilight Council is the FIRST tech building (before
    # any Robotics Facility AND any Stargate -- pure ordering) and
    # Glaives is the FIRST upgrade off it. The pure Gateway Adept Glaive
    # timing. Sits ABOVE Blink Stalker Style, which keys on Blink merely
    # existing; the Glaives-first signal separates the two so a
    # Glaives-then-Blink build is not demoted to Blink Stalker Style.
    if (
        twilight_time < 9999
        and twilight_time < robo_time
        and twilight_time < sg_time
        and glaive_first_off_twilight
    ):
        return "PvP - Adept Glaives"
    # Rail's Blink Stalker (Robo 1st): Robo, then Twilight, BOTH before
    # the natural, and Blink actually researched (by 9:00, the Blink
    # Stalker Style window). The rule used to compare the three times
    # alone, so a Robo-first game that never took a natural
    # (``sec_nexus_time`` = 9999) and never researched Blink -- a
    # Robo -> Twilight -> Charge game, or a 1-base Immortal push --
    # was still called a Blink Stalker style.
    if (
        robo_time < twilight_time
        and twilight_time < sec_nexus_time < 9999
        and has_upgrade_substr("Blink", 540)
    ):
        return "PvP - Rail's Blink Stalker (Robo 1st)"
    if has_building("Stargate", 510) and count_units("Phoenix", 510) >= 3:
        return "PvP - Phoenix Style"
    if (
        has_upgrade_substr("Blink", 540)
        and total_nexuses >= 2
        and (2 <= gate_count_6min <= 4)
    ):
        return "PvP - Blink Stalker Style"
    # Proxied tech openers (their original place in the tree): a
    # Robotics Facility / Stargate started before 6:30 far from the
    # player's own main.
    if proxy_robo:
        return "PvP - Proxy Robo Opener"
    if proxy_stargate:
        return "PvP - Proxy Stargate Opener"
    # Standard Stargate Opener: a home Stargate that is the FIRST tech
    # building -- a Robo- or Twilight-first game that adds a Stargate
    # later is that opener, not a Stargate opener.
    if (
        has_building("Stargate", 390)
        and not proxy_stargate
        and sg_time < robo_time
        and sg_time < twilight_time
    ):
        return "PvP - Standard Stargate Opener"
    # Robo Opener: a home Robotics Facility is the FIRST tech building
    # (before any Stargate and Twilight Council) and no more specific
    # Robo label applied above (Proxy Robo Opener, Robo into Glaives,
    # Rail's Blink Stalker). Pure ordering, no time threshold, like the
    # PvZ Robo Opener. This is the standard Robo-first (Immortal /
    # Observer) PvP opener -- the most common tech-first PvP opening --
    # which previously had no label of its own: it was "1 Gate Expand"
    # when the natural came before 5:00 and "Macro Transition
    # (Unclassified)" otherwise.
    if (
        robo_time < 9999
        and robo_time < sg_time
        and robo_time < twilight_time
        and not proxy_robo
    ):
        return "PvP - Robo Opener"
    if expand_fallback is not None:
        return expand_fallback
    return "PvP - Macro Transition (Unclassified)"
