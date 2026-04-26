"""
Strategy detection engine.

Three classes:
    BaseStrategyDetector       -- shared helpers (proxy distance, custom rules)
    OpponentStrategyDetector   -- classifies the opponent's strategy
    UserBuildDetector          -- classifies the user's own build (PvZ/PvP/PvT)

All three accept a list of custom JSON rules at construction time;
those rules are evaluated *first*, and the hardcoded race-specific
logic acts as the fallback.

The detection trees are intentionally thorough: they are the same
trees that ship with SC2Replay-Analyzer and have been tuned against
the user's actual replay history.
"""

import math
from typing import Dict, List, Tuple

try:
    from .sc2_catalog import composition_summary
except ImportError:  # pragma: no cover - optional during transitional builds
    composition_summary = None  # type: ignore


# Composition-tag -> human-readable phrase used for derived fallback names.
_COMPOSITION_PHRASES = {
    "ling": "Ling-heavy", "bane": "Ling/Bane", "roach": "Roach/Ravager",
    "hydra": "Hydralisk", "lurker": "Lurker", "muta": "Mutalisk",
    "swarm": "Swarm Host", "broodlord": "Brood Lord", "ultra": "Ultralisk",
    "corruptor": "Corruptor", "caster": "Caster (Infestor/Viper)",
    "gateway": "Gateway", "templar": "High Templar / Archon",
    "dt": "Dark Templar", "robo": "Robo (Immortal/Colossus)",
    "sky": "Sky / Stargate",
    "bio": "Bio", "mech": "Mech",
}


def _composition_fallback_name(race: str, enemy_events: List[Dict]) -> str:
    """Derive a meaningful name from the dominant unit composition.

    Used as the very last fallback so a game never ends up labelled
    "Unclassified" — the catalog's composition tags get aggregated and
    the top three become the strategy phrase.
    """
    if composition_summary is None:
        return f"{race} - Standard Play (Unclassified)"
    tags = composition_summary(enemy_events)
    if tags:
        phrases = [_COMPOSITION_PHRASES.get(t, t.title()) for t in tags]
        return f"{race} - {' / '.join(phrases)} Comp"
    return f"{race} - Standard Play (Unclassified)"


class BaseStrategyDetector:
    """Shared helpers used by both opponent and user detectors."""

    def __init__(self, custom_builds: List[Dict]):
        self.custom_builds = custom_builds or []

    # ---------- geometry ----------
    def _get_main_base_loc(self, buildings: List[Dict]) -> Tuple[float, float]:
        town_halls = [
            b for b in buildings
            if b["name"] in ("Nexus", "Hatchery", "CommandCenter", "OrbitalCommand", "PlanetaryFortress")
        ]
        if not town_halls:
            return (0.0, 0.0)
        town_halls.sort(key=lambda x: x["time"])
        return (town_halls[0].get("x", 0), town_halls[0].get("y", 0))

    def _is_proxy(self, building: Dict, main_loc: Tuple[float, float], threshold: float = 50.0) -> bool:
        x, y = building.get("x", 0), building.get("y", 0)
        dist = math.sqrt((x - main_loc[0]) ** 2 + (y - main_loc[1]) ** 2)
        return dist > threshold

    def _is_far_proxy(self, item: Dict, main_loc: Tuple[float, float], threshold: float = 80.0) -> bool:
        x, y = item.get("x", 0), item.get("y", 0)
        dist = math.sqrt((x - main_loc[0]) ** 2 + (y - main_loc[1]) ** 2)
        return dist > threshold

    # ---------- custom rules ----------
    def check_custom_rules(
        self,
        rules: List[Dict],
        buildings: List[Dict],
        units: List[Dict],
        upgrades: List[Dict],
        main_loc: Tuple[float, float],
    ) -> bool:
        """Return True if every rule passes."""
        for rule in rules:
            rtype = rule.get("type")
            name = rule.get("name")
            time_lt = rule.get("time_lt", 9999)

            if rtype == "building":
                count = sum(1 for b in buildings if b["name"] == name and b["time"] <= time_lt)
                if count < rule.get("count", 1):
                    return False
            elif rtype == "unit":
                count = sum(1 for u in units if u["name"] == name and u["time"] <= time_lt)
                if count < rule.get("count", 1):
                    return False
            elif rtype == "unit_max":
                count = sum(1 for u in units if u["name"] == name and u["time"] <= time_lt)
                if count > rule.get("count", 999):
                    return False
            elif rtype == "upgrade":
                if not any(name in u["name"] and u["time"] <= time_lt for u in upgrades):
                    return False
            elif rtype == "proxy":
                dist = rule.get("dist", 50)
                if not any(
                    b["name"] == name and b["time"] <= time_lt and self._is_proxy(b, main_loc, dist)
                    for b in buildings
                ):
                    return False
        return True


class OpponentStrategyDetector(BaseStrategyDetector):
    """Classifies the OPPONENT's strategy from extracted events."""

    def get_strategy_name(self, race: str, enemy_events: List[Dict], matchup: str = "vs Any") -> str:
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
            return sum(1 for u in units if u["name"] == name and u["time"] <= time_limit)

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
                and has_upgrade_substr("Glaive", 400)
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

            # Composition fallbacks
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


class UserBuildDetector(BaseStrategyDetector):
    """Classifies the USER's own build (PvZ / PvP / PvT)."""

    def detect_my_build(self, matchup: str, my_events: List[Dict], my_race: str = "Protoss") -> str:
        buildings = [e for e in my_events if e["type"] == "building"]
        units = [e for e in my_events if e["type"] == "unit"]
        upgrades = [e for e in my_events if e["type"] == "upgrade"]
        main_loc = self._get_main_base_loc(buildings)

        # 1. Custom JSON evaluation
        for cb in self.custom_builds:
            if cb.get("race") == my_race or cb.get("race") == "Any":
                cb_matchup = cb.get("matchup", "vs Any")
                if cb_matchup == "vs Any" or cb_matchup == matchup:
                    if self.check_custom_rules(cb.get("rules", []), buildings, units, upgrades, main_loc):
                        return cb["name"]

        def has_building(name, time_limit=9999):
            return any(b["name"] == name and b["time"] <= time_limit for b in buildings)

        def has_proxy(name, time_limit=9999, dist=50):
            return any(
                b["name"] == name and b["time"] <= time_limit and self._is_proxy(b, main_loc, dist)
                for b in buildings
            )

        def count_units(name, time_limit=9999):
            return sum(1 for u in units if u["name"] == name and u["time"] <= time_limit)

        def has_upgrade_substr(sub_name, time_limit=9999):
            return any(sub_name in u["name"] and u["time"] <= time_limit for u in upgrades)

        def building_time(name):
            times = [b["time"] for b in buildings if b["name"] == name]
            return min(times) if times else 9999

        gate_count_6min = sum(1 for b in buildings if b["name"] == "Gateway" and b["time"] < 540)
        gate_count_530 = sum(1 for b in buildings if b["name"] == "Gateway" and b["time"] < 480)

        # --- PvZ ---
        if "vs Zerg" in matchup:
            sg_count_10min = sum(1 for b in buildings if b["name"] == "Stargate" and b["time"] < 600)
            nexus_count_10min = sum(1 for b in buildings if b["name"] == "Nexus" and b["time"] < 600)

            if count_units("Carrier", 600) >= 1:
                return "PvZ - Carrier Rush"
            if count_units("Tempest", 600) >= 1:
                return "PvZ - Tempest Rush"
            if sg_count_10min >= 2 and nexus_count_10min >= 2 and count_units("VoidRay", 600) >= 4:
                return "PvZ - 2 Stargate Void Ray"
            if sg_count_10min >= 3 and nexus_count_10min >= 2 and count_units("Phoenix", 600) >= 4:
                return "PvZ - 3 Stargate Phoenix"
            if sg_count_10min >= 2 and nexus_count_10min >= 2 and count_units("Phoenix", 600) >= 4:
                return "PvZ - 2 Stargate Phoenix"
            if count_units("Disruptor", 480) >= 1 and count_units("WarpPrism", 480) >= 1:
                return "PvZ - Rail's Disruptor Drop"

            if (
                count_units("Oracle", 510) >= 2
                and has_building("RoboticsFacility", 510)
                and has_building("Forge", 510)
                and sum(1 for b in buildings if b["name"] == "Nexus" and b["time"] < 510) >= 3
            ):
                return "PvZ - AlphaStar Style (Oracle/Robo)"

            if (
                has_upgrade_substr("Glaive", 510)
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
            if (
                sg_time < 420
                and twilight_time > sg_time
                and has_upgrade_substr("Glaive", 600)
                and (4 <= gate_count_6min <= 6)
            ):
                return "PvZ - Stargate into Glaives"
            if (
                sg_time < twilight_time
                and has_building("TemplarArchive", 540)
                and count_units("Archon", 540) >= 2
            ):
                return "PvZ - Archon Drop"
            if (
                twilight_time < building_time("DarkShrine")
                and has_building("DarkShrine", 540)
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

        # --- PvP ---
        elif "vs Protoss" in matchup:
            if has_proxy("Gateway", 270, 50):
                return "PvP - Proxy 2 Gate"

            nexus_times = sorted([b["time"] for b in buildings if b["name"] == "Nexus"])
            gate_times = sorted([b["time"] for b in buildings if b["name"] == "Gateway"])
            if (
                len(nexus_times) >= 2
                and nexus_times[1] < 300
                and len(gate_times) >= 1
                and gate_times[0] < nexus_times[1]
            ):
                first_unit = next(
                    (u["name"] for u in sorted(units, key=lambda x: x["time"])
                     if u["name"] in ("Stalker", "Adept", "Sentry", "Zealot")),
                    None,
                )
                if first_unit == "Sentry":
                    return "PvP - Strange's 1 Gate Expand"

            if count_units("Adept", 360) >= 4 and count_units("Oracle", 390) >= 1:
                return "PvP - AlphaStar (4 Adept/Oracle)"
            if (
                count_units("Stalker", 390) >= 3
                and count_units("Oracle", 450) >= 1
                and has_building("DarkShrine", 540)
            ):
                return "PvP - 4 Stalker Oracle into DT"

            robo_time = building_time("RoboticsFacility")
            twilight_time = building_time("TwilightCouncil")
            sec_nexus_time = nexus_times[1] if len(nexus_times) >= 2 else 9999
            if robo_time < twilight_time and twilight_time < sec_nexus_time:
                return "PvP - Rail's Blink Stalker (Robo 1st)"
            if count_units("Phoenix", 510) >= 3:
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

        # --- PvT ---
        elif "vs Terran" in matchup:
            nexus_times = sorted([b["time"] for b in buildings if b["name"] == "Nexus"])
            sec_nexus_time = nexus_times[1] if len(nexus_times) >= 2 else 9999
            third_nexus_time = nexus_times[2] if len(nexus_times) >= 3 else 9999

            robo_time = building_time("RoboticsFacility")
            sg_time = building_time("Stargate")
            twilight_time = building_time("TwilightCouncil")
            ta_time = building_time("TemplarArchive")
            gate_count_730 = sum(1 for b in buildings if b["name"] == "Gateway" and b["time"] < 450)

            if has_proxy("Stargate", sec_nexus_time, 50):
                return "PvT - Proxy Void Ray/Stargate"
            if count_units("Phoenix", 420) >= 1 and has_building("RoboticsFacility", 480):
                return "PvT - Phoenix into Robo"
            if count_units("Phoenix", 420) >= 1:
                gate_t = sorted([b["time"] for b in buildings if b["name"] == "Gateway"])
                if len(gate_t) >= 2 and gate_t[1] < robo_time:
                    return "PvT - Phoenix Opener"

            if has_upgrade_substr("Blink", 540) and gate_count_6min >= 6:
                return "PvT - 7 Gate Blink All-in"
            if has_upgrade_substr("Charge", 540) and gate_count_730 >= 7 and len(nexus_times) < 3:
                return "PvT - 8 Gate Charge All-in"
            if ta_time < third_nexus_time and (4 <= gate_count_730 <= 6):
                return "PvT - 2 Base Templar (Reactive/Delayed 3rd)"
            if has_upgrade_substr("Charge", 540) and len(nexus_times) >= 3:
                return "PvT - Standard Charge Macro"
            if (
                has_upgrade_substr("Charge", 540)
                and twilight_time < robo_time
                and twilight_time < sg_time
            ):
                return "PvT - 3 Gate Charge Opener"

            if (
                twilight_time < robo_time
                and twilight_time < sg_time
                and has_upgrade_substr("Blink", 540)
            ):
                if gate_count_730 >= 4:
                    return "PvT - 4 Gate Blink"
                else:
                    return "PvT - 3 Gate Blink (Macro)"

            if (
                has_upgrade_substr("Blink", 480)
                and len(nexus_times) >= 3
                and sum(1 for b in buildings if b["name"] == "Gateway" and b["time"] < 480) == 2
                and has_building("RoboticsFacility", 480)
            ):
                return "PvT - 2 Gate Blink (Fast 3rd Nexus)"

            if has_building("DarkShrine", 540) and count_units("WarpPrism", 600) >= 1:
                return "PvT - DT Drop"
            if has_building("RoboticsFacility", 390):
                if robo_time < sg_time and robo_time < twilight_time:
                    return "PvT - Robo First"
            return "PvT - Macro Transition (Unclassified)"

        return f"Standard / Unknown ({matchup})"
