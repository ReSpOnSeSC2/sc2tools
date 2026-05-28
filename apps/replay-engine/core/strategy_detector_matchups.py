"""Terran / Zerg per-matchup build-order detectors.

Mirror of the detailed Protoss matchup trees (``detect_pvz`` /
``detect_pvp`` / ``detect_pvt``): each ``detect_<matchup>`` is a pure
function that, given a :class:`DetectionContext` for the player's own
events, returns a precise matchup-prefixed build label from the
``build_definitions`` catalog, or ``None`` when no specific pro build
matched. ``None`` lets the caller fall back to the generic race tree in
``classify_by_race`` (e.g. ``"Terran - Fast 3 CC"``), so these detectors
are purely additive -- they refine well-known openings into a precise
matchup label and leave everything else on the generic race label.

``classify_by_race`` runs these for BOTH the user's and the opponent's
events (the detectors are perspective-agnostic), so a build classifies
the same way whoever executed it -- identical to how the Protoss trees
behave on the user side.

Signatures key off buildings / units / base counts (reliable across
sc2reader's patch-zoo) rather than upgrade names. ``ctx.count_units`` is
prerequisite-aware, so hallucinated units never trip a label.
"""

from __future__ import annotations

from typing import Optional

from .strategy_detector_helpers import (
    DetectionContext,
    base_count_at,
    count_started_before,
)


# --------------------------------------------------------------------------
# Terran matchups
# --------------------------------------------------------------------------
def detect_tvt(ctx: DetectionContext) -> Optional[str]:
    """Terran-vs-Terran: tank/viking positional and 1-base banshee."""
    cc_at_6 = base_count_at(ctx.buildings, "CommandCenter", 360)

    # Reaper FE into a 2-base Siege Tank / Viking contain -- the
    # defining TvT macro opener: scout with the Reaper, expand, then
    # mass Tanks behind Vikings for air control.
    if (
        ctx.count_units("Reaper", 210) >= 1
        and base_count_at(ctx.buildings, "CommandCenter", 240) >= 2
        and ctx.count_units("SiegeTank", 540) >= 1
        and ctx.count_units("VikingFighter", 540) >= 1
    ):
        return "TvT - Reaper Expand into Tank/Viking"

    # 1-base Cloak Banshee: Factory + Starport up before any expansion
    # and a Banshee on the field -- the classic 1-1-1 banshee harass.
    if (
        ctx.has_building("Factory", 330)
        and ctx.has_building("Starport", 390)
        and ctx.count_units("Banshee", 450) >= 1
        and cc_at_6 <= 1
    ):
        return "TvT - 1-1-1 Cloak Banshee"

    return None


def detect_tvz(ctx: DetectionContext) -> Optional[str]:
    """Terran-vs-Zerg: 10 recognizable openings, specific -> general.

    Returns ``None`` when none match so the generic Terran race tree in
    ``classify_by_race`` provides the fallback label.
    """
    cc2 = base_count_at(ctx.buildings, "CommandCenter", 360)
    cc450 = base_count_at(ctx.buildings, "CommandCenter", 450)

    # 1. 1-1-1 Banshee: Factory + Starport before any expansion and a
    # Banshee on the field -- 1-base cloak-Banshee harass.
    if (
        ctx.has_building("Factory", 360)
        and ctx.has_building("Starport", 420)
        and ctx.count_units("Banshee", 480) >= 1
        and base_count_at(ctx.buildings, "CommandCenter", 420) <= 1
    ):
        return "TvZ - 1-1-1 Banshee"

    # 2. 3 Rax Marine: 3+ Barracks off one base with a Marine flood and
    # no Factory -- a gas-light all-in vs Zerg.
    if (
        count_started_before(ctx.buildings, "Barracks", 420) >= 3
        and base_count_at(ctx.buildings, "CommandCenter", 420) <= 1
        and ctx.count_units("Marine", 450) >= 10
        and not ctx.has_building("Factory", 360)
    ):
        return "TvZ - 3 Rax Marine"

    # 3. Reaper Hellion Expand: Reaper-first + early Hellions on two
    # bases, before any air/mech-upgrade tech commitment.
    if (
        ctx.count_units("Reaper", 210) >= 1
        and ctx.count_units("Hellion", 360) >= 2
        and cc2 >= 2
        and not ctx.has_building("Armory", 420)
        and not ctx.has_building("Starport", 420)
    ):
        return "TvZ - Reaper Hellion Expand"

    # 4. 2-base Hellbat/Thor mech: Armory + 2 Factories producing a Thor
    # behind a wall of Hellions/Hellbats off two bases.
    if (
        ctx.has_building("Armory", 360)
        and count_started_before(ctx.buildings, "Factory", 450) >= 2
        and ctx.count_units("Thor", 540) >= 1
        and ctx.count_units("Hellion", 450) >= 4
        and cc450 <= 2
    ):
        return "TvZ - 2 Base Hellbat Thor"

    # 5. 2-1-1 Marine Hellbat Timing: Armory-backed Hellbats + Marines
    # off two bases (no Thor -- that is the mech build above).
    if (
        ctx.has_building("Armory", 480)
        and ctx.count_units("Hellion", 480) >= 4
        and ctx.count_units("Marine", 480) >= 8
        and cc450 <= 2
    ):
        return "TvZ - 2-1-1 Marine Hellbat Timing"

    # 6. Battlecruiser Mech: a Fusion Core into Battlecruisers as the
    # late-game mech finisher.
    if (
        ctx.has_building("FusionCore", 540)
        and ctx.count_units("Battlecruiser", 600) >= 1
    ):
        return "TvZ - Battlecruiser Mech"

    # 7. Hellion Liberator: early Hellions plus a Liberator for zone
    # control / mineral-line siege off two bases.
    if (
        ctx.count_units("Hellion", 360) >= 2
        and ctx.count_units("Liberator", 510) >= 1
        and cc2 >= 2
    ):
        return "TvZ - Hellion Liberator"

    # 8. Widow Mine Marine: a Marine ball with 2+ Widow Mines and a
    # Medivac for mobile mine drops (checked before the generic Medivac
    # drop so the mine signature wins).
    if (
        ctx.count_units("WidowMine", 480) >= 2
        and ctx.count_units("Marine", 480) >= 8
        and ctx.count_units("Medivac", 480) >= 1
    ):
        return "TvZ - Widow Mine Marine"

    # 9. 2-1-1 Marine Drop: a Starport Medivac drop with Marines off two
    # bases (the committed 2-base drop timing, not 3-CC macro).
    if (
        ctx.has_building("Starport", 420)
        and ctx.count_units("Medivac", 480) >= 1
        and ctx.count_units("Marine", 480) >= 8
        and cc450 <= 2
    ):
        return "TvZ - 2-1-1 Marine Drop"

    # 10. 3 CC Bio: three Command Centers behind 3+ Barracks of
    # Marine/Marauder with no mech tech -- the standard macro bio game.
    if (
        cc2 >= 3
        and count_started_before(ctx.buildings, "Barracks", 450) >= 3
        and ctx.count_units("Marine", 480) >= 8
        and not ctx.has_building("Armory", 450)
        and not ctx.has_building("FusionCore", 450)
    ):
        return "TvZ - 3 CC Bio"

    return None


def detect_tvp(ctx: DetectionContext) -> Optional[str]:
    """Terran-vs-Protoss: 2-base 2-1-1 reaper bio timing."""
    # 2-1-1 Reaper Expand: Reaper-first scout, a single expansion, then
    # a Factory + Starport for the Medivac drop / Stim bio timing off
    # TWO bases. The ``<= 2`` base cap keeps a greedy fast-3-CC macro
    # opening on the generic "Terran - Fast 3 CC" label and reserves
    # this label for the committed 2-base bio timing.
    if (
        ctx.count_units("Reaper", 210) >= 1
        and base_count_at(ctx.buildings, "CommandCenter", 240) >= 2
        and base_count_at(ctx.buildings, "CommandCenter", 360) <= 2
        and ctx.has_building("Factory", 360)
        and ctx.has_building("Starport", 420)
        and ctx.count_units("Medivac", 540) >= 1
    ):
        return "TvP - 2-1-1 Reaper Expand"

    return None


# --------------------------------------------------------------------------
# Zerg matchups
# --------------------------------------------------------------------------
def detect_zvt(ctx: DetectionContext) -> Optional[str]:
    """Zerg-vs-Terran: ling/bane/muta and 2-base roach/ravager."""
    # 3-Hatch Ling Bane Muta: the textbook ZvT defensive macro style --
    # three bases, a Baneling Nest and Spire, defending bio with
    # Banelings and Zerglings while teching to Mutas.
    if (
        base_count_at(ctx.buildings, "Hatchery", 300) >= 3
        and ctx.has_building("BanelingNest", 330)
        and ctx.has_building("Spire", 480)
        and ctx.count_units("Baneling", 480) >= 1
        and ctx.count_units("Zergling", 420) >= 6
    ):
        return "ZvT - 3 Hatch Ling Bane Muta"

    # 2-base Roach/Ravager timing: a Roach Warren with a wall of
    # Roaches and Ravagers off two bases on a low drone count -- the
    # classic ZvT roach/ravager pressure timing.
    if (
        ctx.has_building("RoachWarren", 240)
        and (ctx.count_units("Roach", 450) + ctx.count_units("Ravager", 450)) >= 8
        and ctx.count_units("Drone", 450) < 42
        and base_count_at(ctx.buildings, "Hatchery", 450) <= 2
    ):
        return "ZvT - 2 Base Roach Ravager Timing"

    return None


def detect_zvp(ctx: DetectionContext) -> Optional[str]:
    """Zerg-vs-Protoss: ling/bane/muta tech switch."""
    # Ling Bane Muta: Baneling Nest + Spire with Banelings and a wall of
    # Zerglings -- the muta/ling/bane harass style vs Protoss.
    if (
        ctx.has_building("BanelingNest", 330)
        and ctx.has_building("Spire", 480)
        and ctx.count_units("Baneling", 480) >= 1
        and ctx.count_units("Zergling", 420) >= 6
    ):
        return "ZvP - Ling Bane Muta"

    return None


def detect_zvz(ctx: DetectionContext) -> Optional[str]:
    """Zerg-vs-Zerg: 12-pool speedling and roach aggression."""
    # 12 Pool Speedling: an early Spawning Pool (sub-55s start) into a
    # wall of Zerglings on one base -- the aggressive ZvZ opener.
    if (
        ctx.building_time("SpawningPool") < 55
        and ctx.count_units("Zergling", 240) >= 6
        and base_count_at(ctx.buildings, "Hatchery", 240) <= 1
    ):
        return "ZvZ - 12 Pool Speedling"

    # Roach Aggression: a Roach Warren with a wall of Roaches off two
    # bases -- the standard ZvZ roach pressure / all-in.
    if (
        ctx.has_building("RoachWarren", 240)
        and ctx.count_units("Roach", 360) >= 6
        and base_count_at(ctx.buildings, "Hatchery", 360) <= 2
    ):
        return "ZvZ - Roach Aggression"

    return None
