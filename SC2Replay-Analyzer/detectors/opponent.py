"""Detector for the opponent's race-specific strategy.

`get_strategy_name(race, enemy_events, matchup)` first walks any user-authored
custom builds (matched by race + matchup), then falls back to the hardcoded
race-specific decision trees below. The order matters: more aggressive/early
patterns are checked first so a real all-in isn't misclassified as a generic
macro game.

If no rule matches, a composition-derived fallback name is generated from the
unit catalog so games never end up labelled "Unknown" or "Unclassified".
"""

from typing import Dict, List

from core.sc2_catalog import composition_summary

from .base import BaseStrategyDetector, count_real_units


# Composition-tag -> human-readable phrase used by `_composition_fallback`.
_COMPOSITION_PHRASES = {
    "ling": "Ling-heavy",
    "bane": "Ling/Bane",
    "roach": "Roach/Ravager",
    "hydra": "Hydralisk",
    "lurker": "Lurker",
    "muta": "Mutalisk",
    "swarm": "Swarm Host",
    "broodlord": "Brood Lord",
    "ultra": "Ultralisk",
    "corruptor": "Corruptor",
    "caster": "Caster (Infestor/Viper)",

    "gateway": "Gateway",
    "templar": "High Templar / Archon",
    "dt": "Dark Templar",
    "robo": "Robo (Immortal/Colossus)",
    "sky": "Sky / Stargate",

    "bio": "Bio",
    "mech": "Mech",
}


class OpponentStrategyDetector(BaseStrategyDetector):
    @staticmethod
    def _composition_fallback(race: str, enemy_events: List[Dict]) -> str:
        """Derive a meaningful name from the dominant unit composition.

        Used as the very last fallback so a game never ends up labelled
        "Unclassified" — even an early-cancelled or freshly-extracted replay
        will get something like "Zerg - Roach/Ravager Comp" or "Terran - Mech".
        """
        tags = composition_summary(enemy_events)
        if tags:
            phrases = [_COMPOSITION_PHRASES.get(t, t.title()) for t in tags]
            return f"{race} - {' / '.join(phrases)} Comp"
        return f"{race} - Standard Play (Unclassified)"

    def get_strategy_name(self, race: str, enemy_events: List[Dict], matchup: str = "vs Any") -> str:
        buildings = [e for e in enemy_events if e['type'] == 'building']
        units = [e for e in enemy_events if e['type'] == 'unit']
        upgrades = [e for e in enemy_events if e['type'] == 'upgrade']
        main_loc = self._get_main_base_loc(buildings)

        # 1. Custom JSON Build Evaluation
        for cb in self.custom_builds:
            if cb.get("race") == race or cb.get("race") == "Any":
                cb_matchup = cb.get("matchup", "vs Any")
                if cb_matchup == "vs Any" or cb_matchup == matchup:
                    if self.check_custom_rules(cb.get("rules", []), buildings, units, upgrades, main_loc):
                        return cb["name"]

        # 2. Hardcoded Logic Functions
        def get_times(name):
            return sorted([b['time'] for b in buildings if b['name'] == name])

        def has_building(name, time_limit=9999):
            return any(b['name'] == name and b['time'] <= time_limit for b in buildings)

        def has_proxy_building(name, time_limit=9999, dist=50):
            return any(b['name'] == name and b['time'] <= time_limit and self._is_proxy(b, main_loc, dist) for b in buildings)

        def count_units(name, time_limit=9999):
            # Prereq-aware: hallucinations from a Sentry never count
            # toward opponent strategy classification (e.g. a hallucinated
            # Phoenix from a Sentry should not flag Skytoss).
            return count_real_units(name, time_limit, units, buildings)

        def count_buildings(name, time_limit=9999):
            return sum(1 for b in buildings if b['name'] == name and b['time'] <= time_limit)

        def count_buildings_strict(name, time_limit=9999):
            return sum(1 for b in buildings if b['name'] == name and b['time'] <= time_limit and b.get('subtype') in ('init', 'born'))

        def has_upgrade_substr(sub_name, time_limit=9999):
            return any(sub_name in u['name'] and u['time'] <= time_limit for u in upgrades)

        # --- ZERG ---
        if race == "Zerg":
            nexus_times = get_times("Nexus")
            hatch_times = get_times("Hatchery")
            pool_times = get_times("SpawningPool")
            gas_times = get_times("Extractor")

            pool_time = pool_times[0] if pool_times else 9999
            first_hatch_time = hatch_times[1] if len(hatch_times) >= 2 else 9999
            first_gas_time = gas_times[0] if gas_times else 9999

            # Proxy & Extreme Aggression
            if has_proxy_building("Hatchery", 270, 80):
                return "Zerg - Proxy Hatch"
            if pool_time < 50:
                if count_units("Drone", pool_time) <= 13:
                    return "Zerg - 12 Pool"

            # Early Pool Checks
            if pool_time < 70:
                if first_gas_time < 75:
                    if has_building("BanelingNest", 200) or count_units("Baneling", 240) > 0:
                        return "Zerg - 13/12 Baneling Bust"
                    return "Zerg - 13/12 Speedling Aggression"
                if has_building("RoachWarren", 220):
                    return "Zerg - 1 Base Roach Rush"
                return "Zerg - Early Pool (14/14 or 15 Pool)"

            # Hatch First Trees
            if first_hatch_time < pool_time:
                base_name = "Zerg - 17 Hatch 18 Gas 17 Pool" if first_gas_time < first_hatch_time + 15 else "Zerg - Hatch First"
                if count_buildings("Hatchery", 200) >= 3:
                    return "Zerg - 3 Hatch Before Pool"

                if has_building("RoachWarren", 300) and count_units("Drone", 360) < 40 and (count_units("Roach", 360) + count_units("Ravager", 360) > 8):
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
                # Pool First Macro Trees
                base_name = "Zerg - Pool First Opener"
                if has_building("RoachWarren", 300) and count_units("Drone", 360) < 40 and (count_units("Roach", 360) + count_units("Ravager", 360) > 8):
                    return "Zerg - 2 Base Roach/Ravager All-in"
                if has_building("Spire", 420) and count_units("Drone", 420) < 45:
                    return "Zerg - 2 Base Muta Rush"
                if count_buildings("Hatchery", 390) >= 3:
                    return "Zerg - 3 Base Macro (Pool First)"
                return base_name

            # Composition Fallbacks (only reachable on a path that didn't
            # already return above; this is preserved as a safety net even
            # though the existing if/else above almost always returns).
            if has_building("Spire", 600) or count_units("Mutalisk", 600) > 0:
                return "Zerg - Muta/Ling/Bane Comp"
            if count_units("Roach", 600) + count_units("Ravager", 600) > 15:
                return "Zerg - Roach/Ravager Comp"
            if count_units("Hydralisk", 600) > 5:
                return "Zerg - Hydra Comp"
            return self._composition_fallback("Zerg", enemy_events)

        # --- PROTOSS ---
        elif race == "Protoss":
            nexus_times_local = get_times("Nexus")
            second_nexus_time = nexus_times_local[1] if len(nexus_times_local) >= 2 else 9999

            if has_proxy_building("PhotonCannon", 270):
                return "Protoss - Cannon Rush"
            proxied_gates_3m = sum(1 for b in buildings if b['name'] == "Gateway" and b['time'] < 270 and self._is_proxy(b, main_loc, 40))
            if proxied_gates_3m >= 3:
                return "Protoss - Proxy 4 Gate"
            if has_building("DarkShrine", 450):
                return "Protoss - DT Rush"

            gateway_times = get_times("Gateway")
            if len(gateway_times) >= 4 and gateway_times[3] < 360 and second_nexus_time > 390:
                return "Protoss - 4 Gate Rush"

            if has_building("TwilightCouncil", 360) and has_upgrade_substr("Glaive", 400) and count_units("Adept", 400) >= 6:
                return "Protoss - Glaive Adept Timing"
            if has_upgrade_substr("Charge", 420) and count_buildings("Gateway", 450) >= 7 and count_buildings("Assimilator", 420) <= 3:
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

            # Composition Fallbacks
            if count_buildings("Stargate", 600) >= 2 or count_units("Carrier", 600) > 0:
                return "Protoss - Skytoss Transition"
            if count_units("Colossus", 600) > 0 or count_units("Disruptor", 600) > 0:
                return "Protoss - Robo Comp"
            if count_units("Archon", 600) > 0 or count_units("HighTemplar", 600) > 0 or has_upgrade_substr("Charge", 600):
                return "Protoss - Chargelot/Archon Comp"
            return self._composition_fallback("Protoss", enemy_events)

        # --- TERRAN ---
        elif race == "Terran":
            cc_names = {"CommandCenter", "OrbitalCommand", "PlanetaryFortress"}
            cc_events = sorted([b for b in buildings if b['name'] in cc_names], key=lambda x: x['time'])
            second_cc_time = cc_events[1]['time'] if len(cc_events) >= 2 else 9999

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
                first_medivac_time = next((u['time'] for u in units if u['name'] == "Medivac"), 9999)
                if first_medivac_time > second_cc_time:
                    if count_units("Thor", 490) > 0:
                        return "Terran - Widow Mine Drop into Thor Rush"
                    return "Terran - Widow Mine Drop"
                return "Terran - Widow Upgraded Mine Cheese"

            if has_building("FusionCore", 390):
                return "Terran - BC Rush"
            if count_units("Banshee", 450) > 0 and (has_upgrade_substr("Cloak", 450) or has_upgrade_substr("Banshee", 450)):
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
                    # Sub-classify Proxy 1-1-1 vs Proxy Starport Hellion Drop.
                    # The drop variant expands (2nd CC) and the FIRST Starport
                    # unit is a Medivac used to ferry early Hellions.
                    starport_units = sorted(
                        (
                            u for u in units
                            if u['name'] in (
                                "Medivac",
                                "Banshee",
                                "Liberator",
                                "Raven",
                                "VikingFighter",
                            )
                        ),
                        key=lambda u: u['time'],
                    )
                    first_sp_unit = starport_units[0]['name'] if starport_units else None
                    if (
                        second_cc_time < 9999
                        and first_sp_unit == "Medivac"
                        and count_units("Hellion", 360) >= 2
                    ):
                        return "Terran - Proxy Starport Hellion Drop"
                    return "Terran - Proxy 1-1-1"
                fact_time = next((b['time'] for b in buildings if b['name'] == "Factory"), 9999)
                star_time = next((b['time'] for b in buildings if b['name'] == "Starport"), 9999)
                if fact_time < second_cc_time and star_time < second_cc_time:
                    return "Terran - 1-1-1 One Base"
                if fact_time > second_cc_time:
                    if count_buildings("EngineeringBay", 450) >= 1 and count_units("SiegeTank", 450) >= 1:
                        return "Terran - Standard Bio Tank"
                    return "Terran - 1-1-1 Standard"

            # Composition Fallbacks
            if count_buildings("Factory", 600) >= 3 or count_units("SiegeTank", 600) + count_units("Thor", 600) > 6:
                return "Terran - Mech Comp"
            if count_buildings("Barracks", 600) >= 4 or count_units("Marine", 600) + count_units("Marauder", 600) > 30:
                return "Terran - Bio Comp"
            if count_buildings("Starport", 600) >= 3 or count_units("Battlecruiser", 600) > 2:
                return "Terran - SkyTerran"
            return self._composition_fallback("Terran", enemy_events)

        return self._composition_fallback(race or "Unknown", enemy_events)
