"""Opponent-side strategy classifier.

Given the opponent's extracted events (buildings / units / upgrades),
emit the human-readable strategy label that the dashboard, opponent
profile, and replay drill-down all display. Custom JSON rules are
evaluated first; the hardcoded race-specific decision tree below is
the fallback.
"""

from __future__ import annotations

from typing import Dict, List

from .strategy_detector_base import BaseStrategyDetector
from .strategy_detector_helpers import (
    GAME_TOO_SHORT_THRESHOLD_SECONDS,
    _composition_fallback_name,
    count_real_units,
    too_short_label,
)


class OpponentStrategyDetector(BaseStrategyDetector):
    """Classifies the OPPONENT's strategy from extracted events."""

    def get_strategy_name(
        self,
        race: str,
        enemy_events: List[Dict],
        matchup: str = "vs Any",
        game_length_seconds: float = None,
        my_race: str = None,
    ) -> str:
        # Short-circuit: a replay that ended before 30 seconds has no
        # build order to classify. Emit the matchup-prefixed
        # "Game Too Short" bucket so the dashboard groups these
        # replays together instead of mis-tagging them with the
        # macro-phase catch-all (e.g. "Macro Transition (Unclassified)")
        # or a stub label. ``my_race`` is required to build the
        # matchup prefix from the user's perspective; without it we
        # fall back to a race-prefixed variant so the bucket stays
        # consistent.
        if (
            game_length_seconds is not None
            and game_length_seconds < GAME_TOO_SHORT_THRESHOLD_SECONDS
        ):
            if my_race:
                return too_short_label(my_race, race)
            return f"{race} - Game Too Short"

        buildings = [e for e in enemy_events if e["type"] == "building"]
        units = [e for e in enemy_events if e["type"] == "unit"]
        upgrades = [e for e in enemy_events if e["type"] == "upgrade"]
        main_loc = self._get_main_base_loc(buildings)

        # 1. Custom JSON evaluation
        for cb in self.custom_builds:
            if cb.get("race") == race or cb.get("race") == "Any":
                cb_matchup = cb.get("matchup", "vs Any")
                if cb_matchup == "vs Any" or cb_matchup == matchup:
                    if self.check_custom_rules(cb.get("rules", []), buildings, units, upgrades, main_loc):
                        return cb["name"]

        # 2. Hardcoded helpers
        def get_times(name):
            return sorted([b["time"] for b in buildings if b["name"] == name])

        def has_building(name, time_limit=9999):
            return any(b["name"] == name and b["time"] <= time_limit for b in buildings)

        def has_proxy_building(name, time_limit=9999, dist=50):
            return any(
                b["name"] == name and b["time"] <= time_limit and self._is_proxy(b, main_loc, dist)
                for b in buildings
            )

        def count_units(name, time_limit=9999):
            # Prereq-aware: hallucinations from Sentry never count toward
            # opponent strategy classification (e.g. a hallucinated
            # Phoenix from a Sentry should not flag Skytoss).
            return count_real_units(name, time_limit, units, buildings)

        def count_buildings(name, time_limit=9999):
            return sum(1 for b in buildings if b["name"] == name and b["time"] <= time_limit)

        def count_buildings_strict(name, time_limit=9999):
            return sum(
                1 for b in buildings
                if b["name"] == name and b["time"] <= time_limit and b.get("subtype") in ("init", "born")
            )

        def has_upgrade_substr(sub_name, time_limit=9999):
            return any(sub_name in u["name"] and u["time"] <= time_limit for u in upgrades)

        # --- ZERG ---
        if race == "Zerg":
            hatch_times = get_times("Hatchery")
            pool_times = get_times("SpawningPool")
            gas_times = get_times("Extractor")

            pool_time = pool_times[0] if pool_times else 9999
            first_hatch_time = hatch_times[1] if len(hatch_times) >= 2 else 9999
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
                if count_buildings("Hatchery", 200) >= 3:
                    return "Zerg - 3 Hatch Before Pool"

                if (
                    has_building("RoachWarren", 300)
                    and count_units("Drone", 360) < 40
                    and (count_units("Roach", 360) + count_units("Ravager", 360) > 8)
                ):
                    return "Zerg - 2 Base Roach/Ravager All-in"
                if has_building("Spire", 420) and count_units("Drone", 420) < 45:
                    return "Zerg - 2 Base Muta Rush"
                if has_building("NydusNetwork", 420):
                    return "Zerg - 2 Base Nydus"

                if count_buildings("Hatchery", 390) >= 3:
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
                if has_building("Spire", 420) and count_units("Drone", 420) < 45:
                    return "Zerg - 2 Base Muta Rush"
                if count_buildings("Hatchery", 390) >= 3:
                    return "Zerg - 3 Base Macro (Pool First)"
                return base_name

        # --- PROTOSS ---
        elif race == "Protoss":
            nexus_times_local = get_times("Nexus")
            second_nexus_time = nexus_times_local[1] if len(nexus_times_local) >= 2 else 9999

            if has_proxy_building("PhotonCannon", 270):
                return "Protoss - Cannon Rush"
            proxied_gates_3m = sum(
                1 for b in buildings
                if b["name"] == "Gateway" and b["time"] < 270 and self._is_proxy(b, main_loc, 40)
            )
            if proxied_gates_3m >= 3:
                return "Protoss - Proxy 4 Gate"
            if has_building("DarkShrine", 450):
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
                return "Protoss - Robo Opener"

            has_blink = has_upgrade_substr("Blink", 390)
            if (3 <= count_buildings("Gateway", 390) <= 5) and has_blink and second_nexus_time > 390:
                return "Protoss - Blink All-In"

            if len(nexus_times_local) >= 3 and count_units("Probe", 400) > 40:
                return "Protoss - Standard Macro (CIA)"
            if len(nexus_times_local) >= 2 and nexus_times_local[1] < 390:
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
            return _composition_fallback_name("Protoss", enemy_events)

        # --- TERRAN ---
        elif race == "Terran":
            cc_names = {"CommandCenter", "OrbitalCommand", "PlanetaryFortress"}
            cc_events = sorted([b for b in buildings if b["name"] in cc_names], key=lambda x: x["time"])
            second_cc_time = cc_events[1]["time"] if len(cc_events) >= 2 else 9999

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
            if has_building("GhostAcademy", 390):
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

            if has_building("FusionCore", 390):
                return "Terran - BC Rush"
            if count_units("Banshee", 450) > 0 and (
                has_upgrade_substr("Cloak", 450) or has_upgrade_substr("Banshee", 450)
            ):
                return "Terran - Banshee Rush"
            if count_buildings_strict("CommandCenter", 420) >= 3:
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
                fact_time = next((b["time"] for b in buildings if b["name"] == "Factory"), 9999)
                star_time = next((b["time"] for b in buildings if b["name"] == "Starport"), 9999)
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
            return _composition_fallback_name("Terran", enemy_events)

        return _composition_fallback_name(race or "Unknown", enemy_events)
