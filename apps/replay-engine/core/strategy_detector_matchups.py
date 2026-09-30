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
    """Terran-vs-Terran: recognizable openings, specific -> general.

    Returns ``None`` when none match so the generic Terran race tree in
    ``classify_by_race`` provides the fallback label.
    """
    cc_at_6 = base_count_at(ctx.buildings, "CommandCenter", 360)
    cc450 = base_count_at(ctx.buildings, "CommandCenter", 450)

    # 1. Proxy 4 Rax Reaper: 4 Barracks (at least one proxied near the
    # enemy) flooding Reapers -- the all-in proxy reaper rush.
    if (
        ctx.has_proxy("Barracks", 300)
        and count_started_before(ctx.buildings, "Barracks", 330) >= 4
        and ctx.count_units("Reaper", 390) >= 4
    ):
        return "TvT - Proxy 4 Rax Reaper"

    # 2. Proxy Marauder: proxied Barracks pumping Marauders -- the
    # proxy Marauder rush.
    if ctx.has_proxy("Barracks", 270) and ctx.count_units("Marauder", 360) >= 2:
        return "TvT - Proxy Marauder"

    # 3. Cyclone Push: an early Factory producing Cyclones off <=2 bases.
    if (
        ctx.has_building("Factory", 300)
        and ctx.count_units("Cyclone", 390) >= 2
        and cc450 <= 2
    ):
        return "TvT - Cyclone Push"

    # 4. 1-base Cloak Banshee: Factory + Starport before any expansion
    # with a Banshee on the field.
    if (
        ctx.has_building("Factory", 330)
        and ctx.has_building("Starport", 390)
        and ctx.count_units("Banshee", 450) >= 1
        and cc_at_6 <= 1
    ):
        return "TvT - 1-1-1 Cloak Banshee"

    # 5. Banshee into Raven: cloak Banshees backed by a Raven for
    # detection/anti-air control.
    if ctx.count_units("Banshee", 450) >= 1 and ctx.count_units("Raven", 540) >= 1:
        return "TvT - Banshee into Raven"

    # 6. Battlecruiser Rush: a fast Fusion Core into Battlecruisers.
    if (
        ctx.has_building("FusionCore", 420)
        and ctx.count_units("Battlecruiser", 540) >= 1
    ):
        return "TvT - Battlecruiser Rush"

    # 7. Tank/Thor Mech: Armory-backed Thors and Siege Tanks -- the
    # positional mech composition.
    if (
        ctx.has_building("Armory", 420)
        and ctx.count_units("Thor", 540) >= 1
        and ctx.count_units("SiegeTank", 540) >= 1
    ):
        return "TvT - Tank/Thor Mech"

    # 8. Reaper Expand into Tank/Viking: Reaper-first scout, expand, then
    # Siege Tanks behind Vikings for air control.
    if (
        ctx.count_units("Reaper", 210) >= 1
        and base_count_at(ctx.buildings, "CommandCenter", 240) >= 2
        and ctx.count_units("SiegeTank", 540) >= 1
        and ctx.count_units("VikingFighter", 540) >= 1
    ):
        return "TvT - Reaper Expand into Tank/Viking"

    # 9. 2-1-1 Marine Tank: a Starport build with Siege Tanks and Marines
    # off two bases (no Viking -- that is the build above).
    if (
        ctx.has_building("Starport", 420)
        and ctx.count_units("SiegeTank", 540) >= 1
        and ctx.count_units("Marine", 480) >= 8
        and cc450 <= 2
    ):
        return "TvT - 2-1-1 Marine Tank"

    # 10. 3 Rax Marine: 3+ Barracks off one base with a Marine flood and
    # no Factory -- a gas-light Marine all-in.
    if (
        count_started_before(ctx.buildings, "Barracks", 420) >= 3
        and base_count_at(ctx.buildings, "CommandCenter", 420) <= 1
        and ctx.count_units("Marine", 450) >= 10
        and not ctx.has_building("Factory", 360)
    ):
        return "TvT - 3 Rax Marine"

    # 11. Mass Viking Air: a Viking-heavy air-control composition.
    if ctx.count_units("VikingFighter", 600) >= 6:
        return "TvT - Mass Viking Air"

    return None


def detect_tvz(ctx: DetectionContext) -> Optional[str]:
    """Terran-vs-Zerg: recognizable openings, specific -> general.

    Returns ``None`` when none match so the generic Terran race tree in
    ``classify_by_race`` provides the fallback label.
    """
    cc2 = base_count_at(ctx.buildings, "CommandCenter", 360)
    cc450 = base_count_at(ctx.buildings, "CommandCenter", 450)

    # 0. Proxy 4 Rax Reaper: 4 Barracks (at least one proxied near the
    # enemy) flooding Reapers -- the all-in proxy reaper rush.
    if (
        ctx.has_proxy("Barracks", 300)
        and count_started_before(ctx.buildings, "Barracks", 330) >= 4
        and ctx.count_units("Reaper", 390) >= 4
    ):
        return "TvZ - Proxy 4 Rax Reaper"

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
    """Terran-vs-Protoss: recognizable openings, specific -> general.

    Thresholds for builds shared with other Terran matchups are cloned
    from the proven ``detect_tvt`` / ``detect_tvz`` siblings (proxy rax,
    Cyclone, 1-1-1 Banshee, 3 Rax, BC rush, mech) — the player's own
    event signature for those openings is matchup-independent; only the
    label prefix differs. Returns ``None`` when none match so the
    generic Terran race tree provides the fallback label.
    """
    cc_at_6 = base_count_at(ctx.buildings, "CommandCenter", 360)
    cc450 = base_count_at(ctx.buildings, "CommandCenter", 450)

    # 1. Proxy 4 Rax Reaper: 4 Barracks (at least one proxied near the
    # enemy) flooding Reapers -- the all-in proxy reaper rush.
    if (
        ctx.has_proxy("Barracks", 300)
        and count_started_before(ctx.buildings, "Barracks", 330) >= 4
        and ctx.count_units("Reaper", 390) >= 4
    ):
        return "TvP - Proxy 4 Rax Reaper"

    # 2. Proxy Marauder: proxied Barracks pumping Marauders into the
    # Protoss wall -- the proxy Marauder rush.
    if ctx.has_proxy("Barracks", 270) and ctx.count_units("Marauder", 360) >= 2:
        return "TvP - Proxy Marauder"

    # 3. Cyclone Push: an early Factory producing Cyclones off <=2
    # bases -- the lock-on pressure opening.
    if (
        ctx.has_building("Factory", 300)
        and ctx.count_units("Cyclone", 390) >= 2
        and cc450 <= 2
    ):
        return "TvP - Cyclone Push"

    # 4. 1-base Cloak Banshee: Factory + Starport before any expansion
    # with a Banshee on the field.
    if (
        ctx.has_building("Factory", 330)
        and ctx.has_building("Starport", 390)
        and ctx.count_units("Banshee", 450) >= 1
        and cc_at_6 <= 1
    ):
        return "TvP - 1-1-1 Cloak Banshee"

    # 5. 3 Rax Marine: 3+ Barracks off one base with a Marine flood and
    # no Factory -- a gas-light Marine all-in.
    if (
        count_started_before(ctx.buildings, "Barracks", 420) >= 3
        and base_count_at(ctx.buildings, "CommandCenter", 420) <= 1
        and ctx.count_units("Marine", 450) >= 10
        and not ctx.has_building("Factory", 360)
    ):
        return "TvP - 3 Rax Marine"

    # 6. Battlecruiser Rush: a fast Fusion Core into Battlecruisers.
    if (
        ctx.has_building("FusionCore", 420)
        and ctx.count_units("Battlecruiser", 540) >= 1
    ):
        return "TvP - Battlecruiser Rush"

    # 7. Tank/Thor Mech: Armory-backed Thors and Siege Tanks -- the
    # positional mech composition. Checked before the 2-base timing
    # rules below so a mech game with incidental Marines doesn't get
    # claimed by the Tank Push label.
    if (
        ctx.has_building("Armory", 420)
        and ctx.count_units("Thor", 540) >= 1
        and ctx.count_units("SiegeTank", 540) >= 1
    ):
        return "TvP - Tank/Thor Mech"

    # 8. Widow Mine Drop: 2+ Widow Mines with a Medivac behind a Marine
    # ball -- the mine-drop harass opening. Checked before the 2-1-1
    # Reaper Expand so the mine signature wins over the generic
    # Medivac-timing shape.
    if (
        ctx.count_units("WidowMine", 480) >= 2
        and ctx.count_units("Marine", 480) >= 8
        and ctx.count_units("Medivac", 480) >= 1
    ):
        return "TvP - Widow Mine Drop"

    # 9. 2-1-1 Reaper Expand: Reaper-first scout, a single expansion,
    # then a Factory + Starport for the Medivac drop / Stim bio timing
    # off TWO bases. The ``<= 2`` base cap keeps a greedy fast-3-CC
    # macro opening off this label and reserves it for the committed
    # 2-base bio timing.
    if (
        ctx.count_units("Reaper", 210) >= 1
        and base_count_at(ctx.buildings, "CommandCenter", 240) >= 2
        and base_count_at(ctx.buildings, "CommandCenter", 360) <= 2
        and ctx.has_building("Factory", 360)
        and ctx.has_building("Starport", 420)
        and ctx.count_units("Medivac", 540) >= 1
    ):
        return "TvP - 2-1-1 Reaper Expand"

    # 10. 2 Base Tank Push: a Starport build with Siege Tanks behind a
    # Marine ball off two bases -- the classic tank-push timing.
    if (
        ctx.has_building("Starport", 420)
        and ctx.count_units("SiegeTank", 540) >= 1
        and ctx.count_units("Marine", 480) >= 8
        and cc450 <= 2
    ):
        return "TvP - 2 Base Tank Push"

    # 11. Fast 3 CC Bio: three Command Centers behind 3+ Barracks of
    # Marine/Marauder with no mech tech -- the greedy macro bio game.
    if (
        base_count_at(ctx.buildings, "CommandCenter", 360) >= 3
        and count_started_before(ctx.buildings, "Barracks", 450) >= 3
        and ctx.count_units("Marine", 480) >= 8
        and not ctx.has_building("Armory", 450)
        and not ctx.has_building("FusionCore", 450)
    ):
        return "TvP - Fast 3 CC Bio"

    return None


# --------------------------------------------------------------------------
# Zerg matchups
# --------------------------------------------------------------------------
def detect_zvt(ctx: DetectionContext) -> Optional[str]:
    """Zerg-vs-Terran: recognizable openings, specific -> general.

    Returns ``None`` when none match so the generic Zerg race tree in
    ``classify_by_race`` provides the fallback label.
    """
    hatch3 = base_count_at(ctx.buildings, "Hatchery", 300)

    # 1. Ling Bane Bust: an early Pool + Baneling Nest flooding Banelings
    # and Zerglings off <=2 bases -- the all-in ling/bane bust.
    if (
        ctx.building_time("SpawningPool") < 75
        and ctx.has_building("BanelingNest", 210)
        and ctx.count_units("Baneling", 330) >= 4
        and ctx.count_units("Zergling", 330) >= 12
        and base_count_at(ctx.buildings, "Hatchery", 330) <= 2
    ):
        return "ZvT - Ling Bane Bust"

    # 2. 2-base Roach/Ravager timing: a Roach Warren with a wall of
    # Roaches and Ravagers off two bases on a low drone count.
    if (
        ctx.has_building("RoachWarren", 240)
        and (ctx.count_units("Roach", 450) + ctx.count_units("Ravager", 450)) >= 8
        and ctx.count_units("Drone", 450) < 42
        and base_count_at(ctx.buildings, "Hatchery", 450) <= 2
    ):
        return "ZvT - 2 Base Roach Ravager Timing"

    # 3. 2 Base Nydus: a Nydus Network off two bases for a drop into the
    # Terran's base.
    if (
        ctx.has_building("NydusNetwork", 450)
        and base_count_at(ctx.buildings, "Hatchery", 450) <= 2
    ):
        return "ZvT - 2 Base Nydus"

    # 4. Mass Queen Defensive: a queen-walk / queen-heavy defence with no
    # Roach/Baneling/Spire aggression tech.
    if (
        ctx.count_units("Queen", 420) >= 6
        and base_count_at(ctx.buildings, "Hatchery", 420) >= 2
        and not ctx.has_building("RoachWarren", 360)
        and not ctx.has_building("BanelingNest", 360)
        and not ctx.has_building("Spire", 420)
    ):
        return "ZvT - Mass Queen Defensive"

    # 5. Lurker Contain: a Lurker Den for a positional Lurker contain.
    if ctx.has_building("LurkerDen", 510):
        return "ZvT - Lurker Contain"

    # 6. 3-Hatch Ling Bane Muta: three bases, a Baneling Nest and Spire,
    # defending bio with Banelings/Zerglings while teching to Mutas.
    if (
        hatch3 >= 3
        and ctx.has_building("BanelingNest", 330)
        and ctx.has_building("Spire", 480)
        and ctx.count_units("Baneling", 480) >= 1
        and ctx.count_units("Zergling", 420) >= 6
    ):
        return "ZvT - 3 Hatch Ling Bane Muta"

    # 7. Mass Muta Harass: a Spire into a flock of Mutalisks with no
    # Baneling Nest -- pure muta harass.
    if (
        ctx.has_building("Spire", 480)
        and ctx.count_units("Mutalisk", 540) >= 6
        and not ctx.has_building("BanelingNest", 420)
    ):
        return "ZvT - Mass Muta Harass"

    # 8. Roach Hydra: a Roach Warren + Hydralisk Den producing a
    # roach/hydra ground army.
    if (
        ctx.has_building("RoachWarren", 360)
        and ctx.has_building("HydraliskDen", 480)
        and ctx.count_units("Hydralisk", 540) >= 4
    ):
        return "ZvT - Roach Hydra"

    # 9. 3 Base Ling Flood: three bases pumping 20+ Zerglings on a low
    # drone count -- a ling-flood timing.
    if (
        base_count_at(ctx.buildings, "Hatchery", 390) >= 3
        and ctx.count_units("Zergling", 360) >= 20
        and ctx.count_units("Drone", 360) < 35
    ):
        return "ZvT - 3 Base Ling Flood"

    # 10. Hatch First Macro: a greedy three-base economy (40+ Drones).
    if (
        base_count_at(ctx.buildings, "Hatchery", 420) >= 3
        and ctx.count_units("Drone", 420) >= 40
    ):
        return "ZvT - Hatch First Macro"

    return None


def detect_zvp(ctx: DetectionContext) -> Optional[str]:
    """Zerg-vs-Protoss: recognizable openings, specific -> general.

    Thresholds for builds shared with other Zerg matchups are cloned
    from the proven ``detect_zvt`` / ``detect_zvz`` siblings (pool rush,
    ling/bane bust, roach timing, Nydus, muta, macro shapes) — the
    Hydralisk Timing is the one genuinely ZvP-specific addition (the
    standard answer to Stargate openers). Returns ``None`` when none
    match so the generic Zerg race tree provides the fallback label.
    """
    pool = ctx.building_time("SpawningPool")

    # 1. 12 Pool Rush: a sub-55s Pool into a wall of Zerglings on one
    # base -- the cheese rush.
    if (
        pool < 55
        and ctx.count_units("Zergling", 240) >= 6
        and base_count_at(ctx.buildings, "Hatchery", 240) <= 1
    ):
        return "ZvP - 12 Pool Rush"

    # 2. Ling Bane Bust: an early Pool + Baneling Nest flooding
    # Banelings and Zerglings off <=2 bases -- the all-in bust through
    # the Protoss wall.
    if (
        pool < 75
        and ctx.has_building("BanelingNest", 210)
        and ctx.count_units("Baneling", 330) >= 4
        and ctx.count_units("Zergling", 330) >= 12
        and base_count_at(ctx.buildings, "Hatchery", 330) <= 2
    ):
        return "ZvP - Ling Bane Bust"

    # 3. 2-base Roach/Ravager all-in: a Roach Warren with a wall of
    # Roaches and Ravagers off two bases on a low drone count.
    if (
        ctx.has_building("RoachWarren", 240)
        and (ctx.count_units("Roach", 450) + ctx.count_units("Ravager", 450)) >= 8
        and ctx.count_units("Drone", 450) < 42
        and base_count_at(ctx.buildings, "Hatchery", 450) <= 2
    ):
        return "ZvP - 2 Base Roach Ravager All-in"

    # 4. 2 Base Nydus: a Nydus Network off two bases for a worm into
    # the Protoss main.
    if (
        ctx.has_building("NydusNetwork", 450)
        and base_count_at(ctx.buildings, "Hatchery", 450) <= 2
    ):
        return "ZvP - 2 Base Nydus"

    # 5. Hydra Timing (3 Base): a Hydralisk Den into a hydra wave off
    # three bases -- the standard answer to Stargate openers. The
    # LurkerDen guard hands lurker-tech games to the contain label
    # below instead of mislabelling the (transitional) hydra count.
    if (
        ctx.has_building("HydraliskDen", 420)
        and ctx.count_units("Hydralisk", 510) >= 8
        and base_count_at(ctx.buildings, "Hatchery", 480) >= 3
        and not ctx.has_building("LurkerDen", 510)
    ):
        return "ZvP - Hydra Timing (3 Base)"

    # 6. Lurker Contain: a Lurker Den for a positional Lurker contain
    # (slightly later window than ZvT -- the ZvP version comes off a
    # hydra mid-game rather than a bio-defence opening).
    if ctx.has_building("LurkerDen", 540):
        return "ZvP - Lurker Contain"

    # 7. Ling Bane Muta: Baneling Nest + Spire with Banelings and a
    # wall of Zerglings -- the muta/ling/bane harass style vs Protoss.
    if (
        ctx.has_building("BanelingNest", 330)
        and ctx.has_building("Spire", 480)
        and ctx.count_units("Baneling", 480) >= 1
        and ctx.count_units("Zergling", 420) >= 6
    ):
        return "ZvP - Ling Bane Muta"

    # 8. Mutalisk Harass: a Spire into a flock of Mutalisks with no
    # Baneling Nest -- pure muta harass into the Protoss mineral lines.
    if (
        ctx.has_building("Spire", 480)
        and ctx.count_units("Mutalisk", 540) >= 6
        and not ctx.has_building("BanelingNest", 420)
    ):
        return "ZvP - Mutalisk Harass"

    # 9. Speedling Flood: three bases pumping 20+ Zerglings on a low
    # drone count -- the ling-flood timing against a greedy third.
    if (
        base_count_at(ctx.buildings, "Hatchery", 390) >= 3
        and ctx.count_units("Zergling", 360) >= 20
        and ctx.count_units("Drone", 360) < 35
    ):
        return "ZvP - Speedling Flood"

    # 10. Hatch First Macro: a greedy three-base economy (40+ Drones).
    if (
        base_count_at(ctx.buildings, "Hatchery", 420) >= 3
        and ctx.count_units("Drone", 420) >= 40
    ):
        return "ZvP - Hatch First Macro"

    return None


def detect_zvz(ctx: DetectionContext) -> Optional[str]:
    """Zerg-vs-Zerg: recognizable openings, specific -> general.

    Returns ``None`` when none match so the generic Zerg race tree in
    ``classify_by_race`` provides the fallback label.
    """
    pool = ctx.building_time("SpawningPool")

    # 1. 12 Pool into Baneling: a sub-55s Pool straight into a Baneling
    # Nest and Banelings -- the early ZvZ baneling all-in.
    if (
        pool < 55
        and ctx.has_building("BanelingNest", 240)
        and ctx.count_units("Baneling", 330) >= 2
    ):
        return "ZvZ - 12 Pool into Baneling"

    # 2. 12 Pool Speedling: a sub-55s Pool into a wall of Zerglings on
    # one base.
    if (
        pool < 55
        and ctx.count_units("Zergling", 240) >= 6
        and base_count_at(ctx.buildings, "Hatchery", 240) <= 1
    ):
        return "ZvZ - 12 Pool Speedling"

    # 3. Ling Bane All-in: a Baneling Nest flooding Banelings + Zerglings
    # off <=2 bases.
    if (
        ctx.has_building("BanelingNest", 180)
        and ctx.count_units("Baneling", 300) >= 4
        and ctx.count_units("Zergling", 300) >= 10
        and base_count_at(ctx.buildings, "Hatchery", 300) <= 2
    ):
        return "ZvZ - Ling Bane All-in"

    # 4. Roach Ravager: a Roach Warren with Roaches and Ravagers.
    if (
        ctx.has_building("RoachWarren", 240)
        and ctx.count_units("Ravager", 420) >= 3
        and ctx.count_units("Roach", 420) >= 4
    ):
        return "ZvZ - Roach Ravager"

    # 5. Roach Aggression: a Roach Warren with a wall of Roaches off
    # <=2 bases.
    if (
        ctx.has_building("RoachWarren", 240)
        and ctx.count_units("Roach", 360) >= 6
        and base_count_at(ctx.buildings, "Hatchery", 360) <= 2
    ):
        return "ZvZ - Roach Aggression"

    # 6. 2 Base Nydus: a Nydus Network off two bases.
    if (
        ctx.has_building("NydusNetwork", 450)
        and base_count_at(ctx.buildings, "Hatchery", 450) <= 2
    ):
        return "ZvZ - 2 Base Nydus"

    # 7. Mutalisk vs Mutalisk: a Spire into a flock of Mutalisks -- the
    # ZvZ muta war.
    if ctx.has_building("Spire", 420) and ctx.count_units("Mutalisk", 510) >= 6:
        return "ZvZ - Mutalisk vs Mutalisk"

    # 8. Hatch First Muta: a hatch-first economy (slow Pool) teching to a
    # Spire.
    if (
        ctx.has_building("Spire", 480)
        and base_count_at(ctx.buildings, "Hatchery", 300) >= 2
        and pool > 60
    ):
        return "ZvZ - Hatch First Muta"

    # 9. Zergling Flood: 20+ Zerglings on a low drone count.
    if ctx.count_units("Zergling", 360) >= 20 and ctx.count_units("Drone", 360) < 25:
        return "ZvZ - Zergling Flood"

    # 10. Drone Macro (Hatch First): a greedy hatch-first economy
    # (30+ Drones, slow Pool).
    if (
        base_count_at(ctx.buildings, "Hatchery", 360) >= 2
        and ctx.count_units("Drone", 360) >= 30
        and pool > 60
    ):
        return "ZvZ - Drone Macro (Hatch First)"

    return None
