"""Shared, perspective-agnostic build-order classifier.

The hardcoded race decision trees (Zerg / Protoss / Terran) that map a
single player's extracted events to a build-order label from the
``build_definitions`` catalog. Extracted from the opponent detector so
BOTH the user side and the opponent side run the *same* classifier --
a 3-CC Terran is labelled ``"Terran - Fast 3 CC"`` whether it's the user
or the opponent who built it. Custom-build rules are evaluated by each
detector before delegating here; this module is the hardcoded fallback.
"""

from __future__ import annotations

from typing import Dict, List

from .strategy_detector_helpers import (
    DetectionContext,
    _composition_fallback_name,
    _is_start_event,
    base_count_at,
    count_real_units,
    count_started_before,
    nth_base_start,
    start_times,
    start_times_excluding_main,
)
from .strategy_detector_matchups import (
    detect_tvp,
    detect_tvt,
    detect_tvz,
    detect_zvp,
    detect_zvt,
    detect_zvz,
)

# Terran/Zerg per-matchup detailed detectors, keyed by
# (player_race, opponent_race). Protoss matchups are handled by the
# detailed detect_pvX trees in the user detector, so they are not
# duplicated here.
_MATCHUP_DETECTORS = {
    ("Terran", "Terran"): detect_tvt,
    ("Terran", "Zerg"): detect_tvz,
    ("Terran", "Protoss"): detect_tvp,
    ("Zerg", "Terran"): detect_zvt,
    ("Zerg", "Protoss"): detect_zvp,
    ("Zerg", "Zerg"): detect_zvz,
}


def classify_by_race(race, events: List[Dict], detector, opp_race=None) -> str:
    """Return the catalog build-order label for ``race``'s ``events``.

    ``detector`` is any ``BaseStrategyDetector`` (used for ``_is_proxy``
    spatial checks). Perspective-agnostic: pass the user's events to
    classify the user's build, or the opponent's events for theirs.
    When ``opp_race`` is supplied, the Terran/Zerg per-matchup detectors
    run first and a precise matchup label (e.g. ``"TvZ - 3 CC Bio"``)
    takes precedence over the generic race tree.
    """
    buildings = [e for e in events if e["type"] == "building"]
    units = [e for e in events if e["type"] == "unit"]
    upgrades = [e for e in events if e["type"] == "upgrade"]
    main_loc = detector._get_main_base_loc(buildings)

    # Matchup-specific pro builds take precedence over the generic race
    # tree, mirroring how the user side dispatches to detect_pvX. A None
    # result falls through to the generic race tree below.
    if opp_race:
        matchup_fn = _MATCHUP_DETECTORS.get((race, opp_race))
        if matchup_fn is not None:
            matchup_label = matchup_fn(
                DetectionContext(buildings, units, upgrades, main_loc, detector)
            )
            if matchup_label is not None:
                return matchup_label

    def get_times(name):
        return start_times(buildings, name)

    def has_building(name, time_limit=9999):
        return any(b["name"] == name and b["time"] <= time_limit for b in buildings)

    def has_proxy_building(name, time_limit=9999, dist=50):
        return any(
            b["name"] == name and b["time"] <= time_limit and detector._is_proxy(b, main_loc, dist)
            for b in buildings
        )

    def count_units(name, time_limit=9999):
        # Prereq-aware: hallucinations from Sentry never count toward
        # opponent strategy classification (e.g. a hallucinated
        # Phoenix from a Sentry should not flag Skytoss).
        return count_real_units(name, time_limit, units, buildings)

    def count_buildings(name, time_limit=9999):
        return count_started_before(buildings, name, time_limit + 1)

    def has_upgrade_substr(sub_name, time_limit=9999):
        return any(sub_name in u["name"] and u["time"] <= time_limit for u in upgrades)

    # --- ZERG ---
    if race == "Zerg":
        pool_times = get_times("SpawningPool")
        gas_times = get_times("Extractor")

        pool_time = pool_times[0] if pool_times else 9999
        # 2nd base (natural) Hatchery start. nth_base_start counts the
        # pre-placed main as base #1, so this resolves to the first
        # EXPANSION for both real-replay (main = born-only event) and
        # test-fixture (main = init at t=0) shapes. A raw
        # ``hatch_times[1]`` missed the main on real replays and made
        # every Hatch-First opening look Pool-First.
        first_hatch_time = nth_base_start(buildings, "Hatchery", 2)
        first_gas_time = gas_times[0] if gas_times else 9999

        # Proxy & extreme aggression
        if has_proxy_building("Hatchery", 270, 80):
            return "Zerg - Proxy Hatch"
        if pool_time < 50:
            if count_units("Drone", pool_time) <= 13:
                return "Zerg - 12 Pool"

        # Early Pool
        if pool_time < 70:
            if first_gas_time < 75:
                if has_building("BanelingNest", 200) or count_units("Baneling", 240) > 0:
                    return "Zerg - 13/12 Baneling Bust"
                return "Zerg - 13/12 Speedling Aggression"
            if has_building("RoachWarren", 220):
                return "Zerg - 1 Base Roach Rush"
            return "Zerg - Early Pool (14/14 or 15 Pool)"

        # Hatch First trees
        if first_hatch_time < pool_time:
            base_name = (
                "Zerg - 17 Hatch 18 Gas 17 Pool"
                if first_gas_time < first_hatch_time + 15
                else "Zerg - Hatch First"
            )
            if base_count_at(buildings, "Hatchery", 200) >= 3:
                return "Zerg - 3 Hatch Before Pool"

            if (
                has_building("RoachWarren", 300)
                and count_units("Drone", 360) < 40
                and (count_units("Roach", 360) + count_units("Ravager", 360) > 8)
            ):
                return "Zerg - 2 Base Roach/Ravager All-in"
            # Nydus check comes BEFORE the Muta-rush check: a Nydus
            # opener that also adds a Spire (for late air follow-up
            # or Brood Lord prep) used to mis-fire as "2 Base Muta
            # Rush" because the Muta rule only required a Spire by
            # 7:00 with low drones. A Nydus Network by 7:00 is a
            # stronger signal -- the build's whole purpose is a
            # Nydus drop, regardless of secondary tech.
            if has_building("NydusNetwork", 420):
                return "Zerg - 2 Base Nydus"
            if has_building("Spire", 420) and count_units("Drone", 420) < 45:
                return "Zerg - 2 Base Muta Rush"

            if base_count_at(buildings, "Hatchery", 390) >= 3:
                if count_units("Zergling", 300) > 20 and count_units("Drone", 300) < 30:
                    return "Zerg - 3 Hatch Ling Flood"
                return "Zerg - 3 Base Macro (Hatch First)"
            return base_name
        else:
            # Pool First macro trees
            base_name = "Zerg - Pool First Opener"
            if (
                has_building("RoachWarren", 300)
                and count_units("Drone", 360) < 40
                and (count_units("Roach", 360) + count_units("Ravager", 360) > 8)
            ):
                return "Zerg - 2 Base Roach/Ravager All-in"
            # Nydus check comes BEFORE Muta -- same reasoning as the
            # Hatch-First branch. The original Pool-First branch had
            # NO Nydus check at all so a Pool-First Nydus opener
            # always either mis-fired as 2 Base Muta Rush (if a Spire
            # was up) or fell through to "Pool First Opener" (a
            # macro-flavored catch-all that obscures the all-in).
            if has_building("NydusNetwork", 420):
                return "Zerg - 2 Base Nydus"
            if has_building("Spire", 420) and count_units("Drone", 420) < 45:
                return "Zerg - 2 Base Muta Rush"
            if base_count_at(buildings, "Hatchery", 390) >= 3:
                return "Zerg - 3 Base Macro (Pool First)"
            return base_name

    # --- PROTOSS ---
    elif race == "Protoss":
        # Base counting that includes the pre-placed main: real
        # replays fire only a "born" event (no init) for the
        # game-start Nexus, so a raw ``nexus_times[1]`` / ``len(...)``
        # missed the main and pointed one base too far. nth_base_start
        # counts the main as base #1, so n=2 is the natural; base_count_at
        # totals all bases including the main.
        second_nexus_time = nth_base_start(buildings, "Nexus", 2)
        total_nexuses = base_count_at(buildings, "Nexus")

        if has_proxy_building("PhotonCannon", 270):
            return "Protoss - Cannon Rush"
        proxied_gates_3m = sum(
            1 for b in buildings
            if b["name"] == "Gateway"
            and _is_start_event(b)
            and b["time"] < 270
            and detector._is_proxy(b, main_loc, 40)
        )
        if proxied_gates_3m >= 3:
            return "Protoss - Proxy 4 Gate"
        # DT Rush: a real DT rush has the Dark Shrine going down by
        # ~4:30-5:00 and at least one DT on the field by ~6:00 for
        # the harass. The old "Dark Shrine by 7:30" check fired on
        # any build that added a Shrine as a mid-game DT-tech
        # transition (post-Stargate harass, late-game DT support
        # off a macro game, etc.). Require an actual real (non-
        # hallucinated) Dark Templar to land within the rush window
        # so the label means what it says.
        if has_building("DarkShrine", 300) and count_units("DarkTemplar", 360) >= 1:
            return "Protoss - DT Rush"

        gateway_times = get_times("Gateway")
        if len(gateway_times) >= 4 and gateway_times[3] < 360 and second_nexus_time > 390:
            return "Protoss - 4 Gate Rush"

        if (
            has_building("TwilightCouncil", 360)
            and (
                has_upgrade_substr("AdeptPiercing", 400)
                or has_upgrade_substr("Glaive", 400)
            )
            and count_units("Adept", 400) >= 6
        ):
            return "Protoss - Glaive Adept Timing"
        if (
            has_upgrade_substr("Charge", 420)
            and count_buildings("Gateway", 450) >= 7
            and count_buildings("Assimilator", 420) <= 3
        ):
            return "Protoss - Chargelot All-in"
        if has_proxy_building("Stargate", 390, 50):
            return "Protoss - Proxy Stargate Opener"
        if has_building("Stargate", 390):
            return "Protoss - Stargate Opener"
        if has_proxy_building("RoboticsFacility", 390, 50):
            return "Protoss - Proxy Robo Opener"
        if has_building("RoboticsFacility", 390):
            # Robo Opener requires the Robo to be the FIRST tech
            # building. A 2-Gate Expand Blink build with a later
            # Robo (Twilight Council goes down first) is not a
            # Robo Opener -- mis-labelling it as one drops the
            # Blink/Twilight context the user needs to react.
            _robo_times = get_times("RoboticsFacility")
            _twilight_times = get_times("TwilightCouncil")
            _robo_t = _robo_times[0] if _robo_times else 9999
            _twilight_t = _twilight_times[0] if _twilight_times else 9999
            if _robo_t < _twilight_t:
                return "Protoss - Robo Opener"

        has_blink = has_upgrade_substr("Blink", 390)
        if (3 <= count_buildings("Gateway", 390) <= 5) and has_blink and second_nexus_time > 390:
            return "Protoss - Blink All-In"

        if total_nexuses >= 3 and count_units("Probe", 400) > 40:
            return "Protoss - Standard Macro (CIA)"
        if second_nexus_time < 390:
            return "Protoss - Standard Expand"

        # Composition fallbacks. count_units is prereq-aware
        # (`count_real_units`), so a Sentry hallucination of a
        # Carrier / Colossus / High Templar / Archon never tips a
        # game into the wrong fallback bucket here.
        if count_buildings("Stargate", 600) >= 2 or count_units("Carrier", 600) > 0:
            return "Protoss - Skytoss Transition"
        if count_units("Colossus", 600) > 0 or count_units("Disruptor", 600) > 0:
            return "Protoss - Robo Comp"
        if (
            count_units("Archon", 600) > 0
            or count_units("HighTemplar", 600) > 0
            or has_upgrade_substr("Charge", 600)
        ):
            return "Protoss - Chargelot/Archon Comp"
        return _composition_fallback_name("Protoss", events)

    # --- TERRAN ---
    elif race == "Terran":
        # ``second_cc_time`` is the start time of the opponent's
        # SECOND base (the natural expansion); the 1-1-1 / Standard
        # Bio Tank / Bio Comp branches below all key off it to
        # distinguish 1-base all-ins from expanding macro games.
        # Exclude the pre-placed main: real replays fire only a
        # "born" event (no init) for the game-start CC, so indexing
        # raw start times as cc_starts[1] pointed one base too far
        # (the 3rd base, or 9999) and mislabelled 2-base macro games
        # as "1-1-1 One Base". Morphs of the main to OrbitalCommand /
        # PlanetaryFortress carry their own names, so they never
        # masquerade as a 2nd CC here.
        expansion_cc_starts = start_times_excluding_main(buildings, "CommandCenter")
        second_cc_time = expansion_cc_starts[0] if expansion_cc_starts else 9999

        gas_count_4min = count_buildings("Refinery", 330)
        reaper_count = count_units("Reaper", 330)
        hellion_count = count_units("Hellion", 330)

        if has_proxy_building("Barracks", 270, 50):
            return "Terran - Proxy Rax"
        if gas_count_4min >= 2 and reaper_count >= 3 and hellion_count >= 2:
            return "Terran - 2 Gas 3 Reaper 2 Hellion"
        if has_building("Factory", 300) and count_units("Cyclone", 330) >= 1:
            return "Terran - Cyclone Rush"
        if has_building("Armory", 300) and count_units("Hellion", 330) > 4:
            return "Terran - Hellbat All-in"
        # Ghost Rush: a true Ghost rush commits to the Academy by
        # ~5:00-5:30 on a 1-base / 2-base economy and uses Ghosts
        # for early snipes / EMPs. The old 6:30 cutoff caught any
        # macro game that built a Ghost Academy mid-game for
        # standard Bio + Ghost composition.
        if has_building("GhostAcademy", 330):
            return "Terran - Ghost Rush"

        mines_5m = count_units("WidowMine", 390)
        medivac_5m = count_units("Medivac", 390)
        if medivac_5m >= 1 and mines_5m >= 2:
            first_medivac_time = next((u["time"] for u in units if u["name"] == "Medivac"), 9999)
            if first_medivac_time > second_cc_time:
                if count_units("Thor", 490) > 0:
                    return "Terran - Widow Mine Drop into Thor Rush"
                return "Terran - Widow Mine Drop"
            return "Terran - Widow Upgraded Mine Cheese"

        # BC Rush: requires an actual Battlecruiser on the field
        # within the rush window. A Fusion Core alone fires for any
        # mech-into-BC macro game that took FC late for end-game
        # composition. A real BC rush commits the Fusion Core by
        # ~5:30 (off a fast Starport) and lands the first BC by
        # ~7:30.
        if has_building("FusionCore", 330) and count_units("Battlecruiser", 450) >= 1:
            return "Terran - BC Rush"
        if count_units("Banshee", 450) > 0 and (
            has_upgrade_substr("Cloak", 450) or has_upgrade_substr("Banshee", 450)
        ):
            return "Terran - Banshee Rush"
        # Count the pre-placed main too: real replays fire only a
        # "born" event (no init) for the game-start CC, so the raw
        # start-event count misses it and a true fast-3-CC (main +
        # 2 expansions = 2 init events) read as only 2 and fell
        # through to "Standard Bio Tank". base_count_at adds the
        # main, matching the "3 Command Centers exist" definition
        # and the Nexus/Hatchery counting in the other detectors.
        if base_count_at(buildings, "CommandCenter", 420) >= 3:
            return "Terran - Fast 3 CC"

        rax_count = count_buildings("Barracks", 390)
        if rax_count >= 3:
            cc_count = count_buildings("CommandCenter", 390)
            refinery_count = count_buildings("Refinery", 390)
            if cc_count == 1 and refinery_count == 0:
                return "Terran - 3-4 Rax Marine rush"
            if cc_count == 1 and count_units("Reaper", 390) >= 2:
                return "Terran - 2-3 Rax Reaper rush"
            if cc_count >= 2 and count_buildings("Factory", 390) == 0 and count_buildings("Starport", 390) == 0:
                return "Terran - 3 Rax"

        has_fact = has_building("Factory", 390)
        has_star = has_building("Starport", 490)
        if has_fact and has_star:
            if has_proxy_building("Factory", 390) or has_proxy_building("Starport", 490):
                # Proxy Factory + Starport off a Reaper-Expand. Distinct
                # from the 1-base Proxy 1-1-1 (Banshee/Liberator pressure)
                # because the player took a 2nd CC and the FIRST Starport
                # unit is a Medivac, used as a bus for early Hellions
                # (Yoon's proxy Starport Hellion drop). Without those
                # signals the build is the older 1-base proxy 1-1-1.
                starport_units = sorted(
                    (
                        u for u in units
                        if u["name"] in (
                            "Medivac",
                            "Banshee",
                            "Liberator",
                            "Raven",
                            "VikingFighter",
                        )
                    ),
                    key=lambda u: u["time"],
                )
                first_sp_unit = starport_units[0]["name"] if starport_units else None
                if (
                    second_cc_time < 9999
                    and first_sp_unit == "Medivac"
                    and count_units("Hellion", 360) >= 2
                ):
                    return "Terran - Proxy Starport Hellion Drop"
                return "Terran - Proxy 1-1-1"
            fact_starts = start_times(buildings, "Factory")
            star_starts = start_times(buildings, "Starport")
            fact_time = fact_starts[0] if fact_starts else 9999
            star_time = star_starts[0] if star_starts else 9999
            if fact_time < second_cc_time and star_time < second_cc_time:
                return "Terran - 1-1-1 One Base"
            if fact_time > second_cc_time:
                if count_buildings("EngineeringBay", 450) >= 1 and count_units("SiegeTank", 450) >= 1:
                    return "Terran - Standard Bio Tank"
                return "Terran - 1-1-1 Standard"

        # Composition fallbacks
        if count_buildings("Factory", 600) >= 3 or count_units("SiegeTank", 600) + count_units("Thor", 600) > 6:
            return "Terran - Mech Comp"
        if count_buildings("Barracks", 600) >= 4 or count_units("Marine", 600) + count_units("Marauder", 600) > 30:
            return "Terran - Bio Comp"
        if count_buildings("Starport", 600) >= 3 or count_units("Battlecruiser", 600) > 2:
            return "Terran - SkyTerran"
        return _composition_fallback_name("Terran", events)

    return _composition_fallback_name(race or "Unknown", events)
