"""Protoss-vs-Protoss user-build classification tree.

Pure function: given a :class:`DetectionContext` for a Protoss player in
a PvP matchup, return the build-label string. The caller
(``UserBuildDetector.detect_my_build``) decides when to dispatch here
based on the matchup string.
"""

from __future__ import annotations

from typing import Optional

from .strategy_detector_helpers import DetectionContext


def detect_pvp(ctx: DetectionContext) -> Optional[str]:
    """Return the PvP user-build label, or ``None`` if no rule matched."""
    has_building = ctx.has_building
    has_proxy = ctx.has_proxy
    count_units = ctx.count_units
    has_upgrade_substr = ctx.has_upgrade_substr
    building_time = ctx.building_time
    gate_count_6min = ctx.gate_count_6min
    buildings = ctx.buildings
    units = ctx.units
    upgrades = ctx.upgrades

    # Tightened: a real proxy 2-Gate is committed -- no early
    # natural. Without this guard, ANY gateway that registers
    # near the opponent's main before 4:30 (forward gate during
    # a 4-Gate timing, mis-tagged distance, etc.) was being
    # mis-classified as "Proxy 2 Gate" even on FE-into-X games.
    _pvp_nexus_times_proxy = sorted(
        b["time"] for b in buildings if b["name"] == "Nexus"
    )
    _pvp_has_early_natural = (
        len(_pvp_nexus_times_proxy) >= 2
        and _pvp_nexus_times_proxy[1] < 270
    )
    if has_proxy("Gateway", 270, 50) and not _pvp_has_early_natural:
        return "PvP - Proxy 2 Gate"

    nexus_times = sorted([b["time"] for b in buildings if b["name"] == "Nexus"])
    gate_times = sorted([b["time"] for b in buildings if b["name"] == "Gateway"])
    # Count gateways that were finished BEFORE the second Nexus
    # started warping in. This is what distinguishes the
    # 1-gate expand (Strange's / standard) from the 2-gate expand
    # (which is a separate, well-known PvP opener). Previously we
    # only required `len(gate_times) >= 1`, which let any 2+ gate
    # expand fall into the Strange's bucket as long as the first
    # produced unit happened to be a Sentry.
    if len(nexus_times) >= 2 and nexus_times[1] < 300:
        second_nexus = nexus_times[1]
        gates_before_expand = sum(1 for t in gate_times if t < second_nexus)

        first_unit = next(
            (u["name"] for u in sorted(units, key=lambda x: x["time"])
             if u["name"] in ("Stalker", "Adept", "Sentry", "Zealot")),
            None,
        )

        # 2 Gate Expand: 2 (or more) gateways finished before the
        # natural goes down AND no tech building (Stargate, Robo,
        # or Twilight Council) is started before the natural Nexus.
        # If tech is dropped before the natural, it is a tech-first
        # opener (Stargate / Robo / Twilight expand), not a pure
        # 2-gate expand. This is the "safe" PvP opener that protects
        # against proxy 2-gate / early aggression while still taking
        # the natural early.
        _PURE_2GATE_TECH_DISQUALIFIERS = (
            "Stargate",
            "RoboticsFacility",
            "TwilightCouncil",
        )
        tech_before_expand = any(
            b["name"] in _PURE_2GATE_TECH_DISQUALIFIERS
            and b["time"] < second_nexus
            for b in buildings
        )
        if gates_before_expand >= 2 and not tech_before_expand:
            return "PvP - 2 Gate Expand"

        # Strange's 1 Gate Expand: exactly 1 gateway before the
        # natural, AND the first warp-in is a Sentry (the
        # signature of the build).
        if gates_before_expand == 1 and first_unit == "Sentry":
            return "PvP - Strange's 1 Gate Expand"

        # 1 Gate Nexus into 4 Gate: standard 1-gate FE that
        # transitions into a 4-Gate Stalker timing. Must be
        # checked BEFORE the generic "1 Gate Expand" so the
        # 4-Gate signal upgrades the classification.
        _gate_times_pvp = sorted(
            b["time"] for b in buildings if b["name"] == "Gateway"
        )
        _gate_count_6min = sum(
            1 for t in _gate_times_pvp if t < 360
        )
        _fourth_gate_time = (
            _gate_times_pvp[3] if len(_gate_times_pvp) >= 4 else 9999
        )
        _PVP_4G_TECH = (
            "Stargate", "RoboticsFacility",
            "TwilightCouncil", "TemplarArchive", "DarkShrine",
        )
        _tech_before_4th_gate = any(
            b["name"] in _PVP_4G_TECH and b["time"] < _fourth_gate_time
            for b in buildings
        )
        _warpgate_research_time = next(
            (u["time"] for u in upgrades if "WarpGate" in u["name"]),
            9999,
        )
        if (
            gates_before_expand == 1
            and first_unit in ("Stalker", "Adept", "Zealot")
            and _gate_count_6min >= 4
            and not _tech_before_4th_gate
            and _warpgate_research_time <= 330
        ):
            return "PvP - 1 Gate Nexus into 4 Gate"

        # Standard 1 Gate Expand: exactly 1 gateway before the
        # natural, first unit is something other than a Sentry.
        if gates_before_expand == 1 and first_unit in ("Stalker", "Adept", "Zealot"):
            return "PvP - 1 Gate Expand"

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

    robo_time = building_time("RoboticsFacility")
    twilight_time = building_time("TwilightCouncil")
    sec_nexus_time = nexus_times[1] if len(nexus_times) >= 2 else 9999
    if robo_time < twilight_time and twilight_time < sec_nexus_time:
        return "PvP - Rail's Blink Stalker (Robo 1st)"
    if has_building("Stargate", 510) and count_units("Phoenix", 510) >= 3:
        return "PvP - Phoenix Style"
    if (
        has_upgrade_substr("Blink", 540)
        and len(nexus_times) >= 2
        and (2 <= gate_count_6min <= 4)
    ):
        return "PvP - Blink Stalker Style"
    if has_proxy("RoboticsFacility", 390):
        return "PvP - Proxy Robo Opener"
    if has_building("Stargate", 390) and not has_proxy("Stargate", 390):
        return "PvP - Standard Stargate Opener"
    return "PvP - Macro Transition (Unclassified)"
