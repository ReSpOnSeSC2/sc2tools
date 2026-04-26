"""Detector for the user's own build (currently Protoss-only matchup trees).

`detect_my_build(matchup, my_events, my_race)` runs custom builds first, then
walks the matchup-specific decision tree (PvZ / PvP / PvT). Adding a new
matchup or expanding to other races should be done by extending the
appropriate branch here.
"""

from typing import Dict, List

from .base import BaseStrategyDetector


class UserBuildDetector(BaseStrategyDetector):
    def detect_my_build(self, matchup: str, my_events: List[Dict], my_race: str = "Protoss") -> str:
        buildings = [e for e in my_events if e['type'] == 'building']
        units = [e for e in my_events if e['type'] == 'unit']
        upgrades = [e for e in my_events if e['type'] == 'upgrade']
        main_loc = self._get_main_base_loc(buildings)

        # 1. Custom JSON Build Evaluation
        for cb in self.custom_builds:
            if cb.get("race") == my_race or cb.get("race") == "Any":
                cb_matchup = cb.get("matchup", "vs Any")
                if cb_matchup == "vs Any" or cb_matchup == matchup:
                    if self.check_custom_rules(cb.get("rules", []), buildings, units, upgrades, main_loc):
                        return cb["name"]

        def has_building(name, time_limit=9999):
            return any(b['name'] == name and b['time'] <= time_limit for b in buildings)

        def has_proxy(name, time_limit=9999, dist=50):
            return any(b['name'] == name and b['time'] <= time_limit and self._is_proxy(b, main_loc, dist) for b in buildings)

        def count_units(name, time_limit=9999):
            return sum(1 for u in units if u['name'] == name and u['time'] <= time_limit)

        def has_upgrade_substr(sub_name, time_limit=9999):
            return any(sub_name in u['name'] and u['time'] <= time_limit for u in upgrades)

        def building_time(name):
            times = [b['time'] for b in buildings if b['name'] == name]
            return min(times) if times else 9999

        gate_count_6min = sum(1 for b in buildings if b['name'] == "Gateway" and b['time'] < 540)
        gate_count_530 = sum(1 for b in buildings if b['name'] == "Gateway" and b['time'] < 480)

        # --- PvZ ---
        if "vs Zerg" in matchup:
            sg_count_10min = sum(1 for b in buildings if b['name'] == "Stargate" and b['time'] < 600)
            nexus_count_10min = sum(1 for b in buildings if b['name'] == "Nexus" and b['time'] < 600)

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

            if (count_units("Oracle", 510) >= 2 and has_building("RoboticsFacility", 510) and has_building("Forge", 510)
                    and sum(1 for b in buildings if b['name'] == "Nexus" and b['time'] < 510) >= 3):
                return "PvZ - AlphaStar Style (Oracle/Robo)"

            if has_upgrade_substr("Glaive", 510) and count_units("Sentry", 510) >= 2 and count_units("Immortal", 510) >= 1 and gate_count_6min >= 6:
                return "PvZ - 7 Gate Glaive/Immortal All-in"

            if has_upgrade_substr("Blink", 480) and gate_count_530 >= 5:
                if not has_building("Stargate", 480) and not has_building("DarkShrine", 480):
                    return "PvZ - Blink Stalker All-in (2 Base)"

            sg_time = building_time("Stargate")
            twilight_time = building_time("TwilightCouncil")
            if sg_time < 420 and twilight_time > sg_time and has_upgrade_substr("Glaive", 600) and (4 <= gate_count_6min <= 6):
                return "PvZ - Stargate into Glaives"
            if sg_time < twilight_time and has_building("TemplarArchive", 540) and count_units("Archon", 540) >= 2:
                return "PvZ - Archon Drop"
            if twilight_time < building_time("DarkShrine") and has_building("DarkShrine", 540) and count_units("DarkTemplar", 540) >= 3 and count_units("WarpPrism", 540) >= 1:
                return "PvZ - DT drop into Archon Drop"
            if sg_time < twilight_time and has_upgrade_substr("Blink", 600) and sum(1 for b in buildings if b['name'] == "Nexus" and b['time'] < 540) >= 3:
                return "PvZ - Standard Blink Macro"
            if sg_time < twilight_time and has_upgrade_substr("Charge", 540) and sum(1 for b in buildings if b['name'] == "Nexus" and b['time'] < 540) >= 3:
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

            nexus_times = sorted([b['time'] for b in buildings if b['name'] == 'Nexus'])
            gate_times = sorted([b['time'] for b in buildings if b['name'] == 'Gateway'])
            if len(nexus_times) >= 2 and nexus_times[1] < 300 and len(gate_times) >= 1 and gate_times[0] < nexus_times[1]:
                first_unit = next((u['name'] for u in sorted(units, key=lambda x: x['time']) if u['name'] in ("Stalker", "Adept", "Sentry", "Zealot")), None)
                if first_unit == "Sentry":
                    return "PvP - Strange's 1 Gate Expand"

            if count_units("Adept", 360) >= 4 and count_units("Oracle", 390) >= 1:
                return "PvP - AlphaStar (4 Adept/Oracle)"
            if count_units("Stalker", 390) >= 3 and count_units("Oracle", 450) >= 1 and has_building("DarkShrine", 540):
                return "PvP - 4 Stalker Oracle into DT"

            robo_time = building_time("RoboticsFacility")
            twilight_time = building_time("TwilightCouncil")
            sec_nexus_time = nexus_times[1] if len(nexus_times) >= 2 else 9999
            if robo_time < twilight_time and twilight_time < sec_nexus_time:
                return "PvP - Rail's Blink Stalker (Robo 1st)"
            if count_units("Phoenix", 510) >= 3:
                return "PvP - Phoenix Style"
            if has_upgrade_substr("Blink", 540) and len(nexus_times) >= 2 and (2 <= gate_count_6min <= 4):
                return "PvP - Blink Stalker Style"
            if has_proxy("RoboticsFacility", 390):
                return "PvP - Proxy Robo Opener"
            if has_building("Stargate", 390) and not has_proxy("Stargate", 390):
                return "PvP - Standard Stargate Opener"
            return "PvP - Macro Transition (Unclassified)"

        # --- PvT ---
        elif "vs Terran" in matchup:
            nexus_times = sorted([b['time'] for b in buildings if b['name'] == 'Nexus'])
            sec_nexus_time = nexus_times[1] if len(nexus_times) >= 2 else 9999
            third_nexus_time = nexus_times[2] if len(nexus_times) >= 3 else 9999

            robo_time = building_time("RoboticsFacility")
            sg_time = building_time("Stargate")
            twilight_time = building_time("TwilightCouncil")
            ta_time = building_time("TemplarArchive")
            gate_count_730 = sum(1 for b in buildings if b['name'] == "Gateway" and b['time'] < 450)

            if has_proxy("Stargate", sec_nexus_time, 50):
                return "PvT - Proxy Void Ray/Stargate"
            if count_units("Phoenix", 420) >= 1 and has_building("RoboticsFacility", 480):
                return "PvT - Phoenix into Robo"
            if count_units("Phoenix", 420) >= 1:
                gate_times = sorted([b['time'] for b in buildings if b['name'] == "Gateway"])
                if len(gate_times) >= 2 and gate_times[1] < robo_time:
                    return "PvT - Phoenix Opener"

            if has_upgrade_substr("Blink", 540) and gate_count_6min >= 6:
                return "PvT - 7 Gate Blink All-in"
            if has_upgrade_substr("Charge", 540) and gate_count_730 >= 7 and len(nexus_times) < 3:
                return "PvT - 8 Gate Charge All-in"
            if ta_time < third_nexus_time and (4 <= gate_count_730 <= 6):
                return "PvT - 2 Base Templar (Reactive/Delayed 3rd)"
            if has_upgrade_substr("Charge", 540) and len(nexus_times) >= 3:
                return "PvT - Standard Charge Macro"
            if has_upgrade_substr("Charge", 540) and twilight_time < robo_time and twilight_time < sg_time:
                return "PvT - 3 Gate Charge Opener"

            if twilight_time < robo_time and twilight_time < sg_time and has_upgrade_substr("Blink", 540):
                if gate_count_730 >= 4:
                    return "PvT - 4 Gate Blink"
                else:
                    return "PvT - 3 Gate Blink (Macro)"

            if (has_upgrade_substr("Blink", 480) and len(nexus_times) >= 3
                    and sum(1 for b in buildings if b['name'] == "Gateway" and b['time'] < 480) == 2
                    and has_building("RoboticsFacility", 480)):
                return "PvT - 2 Gate Blink (Fast 3rd Nexus)"

            if has_building("DarkShrine", 540) and count_units("WarpPrism", 600) >= 1:
                return "PvT - DT Drop"
            if has_building("RoboticsFacility", 390):
                if robo_time < sg_time and robo_time < twilight_time:
                    return "PvT - Robo First"
            return "PvT - Macro Transition (Unclassified)"

        return f"Standard / Unknown ({matchup})"
