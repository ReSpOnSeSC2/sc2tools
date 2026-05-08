"""Detector for the user's own build (currently Protoss-only matchup trees).

`detect_my_build(matchup, my_events, my_race)` runs custom builds first, then
walks the matchup-specific decision tree (PvZ / PvP / PvT). Adding a new
matchup or expanding to other races should be done by extending the
appropriate branch here.
"""

from typing import Dict, List

from .base import BaseStrategyDetector, count_real_units
from .definitions import candidate_signatures_for


# Map a 'vs <Race>' matchup string to the bare race name. Used by the
# race-aware classifier in UserBuildDetector.detect_my_build to look up
# the BUILD_SIGNATURES candidate set keyed by (my_race, vs_race).
_MATCHUP_TO_VS_RACE = {
    "vs Zerg": "Zerg",
    "vs Protoss": "Protoss",
    "vs Terran": "Terran",
}


def _matchup_to_vs_race(matchup: str) -> str:
    """Return the opponent's race name for a "vs X" matchup string.

    Falls back to "Unknown" so callers can still iterate the (empty)
    candidate set without raising.

    Example:
        >>> _matchup_to_vs_race("vs Terran")
        'Terran'
    """
    for key, race in _MATCHUP_TO_VS_RACE.items():
        if key in matchup:
            return race
    return "Unknown"


class UserBuildDetector(BaseStrategyDetector):
    def detect_my_build(self, matchup: str, my_events: List[Dict], my_race: str = "Protoss") -> str:
        buildings = [e for e in my_events if e['type'] == 'building']
        units = [e for e in my_events if e['type'] == 'unit']
        upgrades = [e for e in my_events if e['type'] == 'upgrade']
        main_loc = self._get_main_base_loc(buildings)

        # 1. Custom JSON Build Evaluation
        # Custom builds win over the built-in tree so a user-authored
        # signature (e.g. "PvZ - DT into 3 Stargate Void Ray") tags a game
        # before any broader catch-all (like the 2 Stargate Void Ray rule
        # below) gets a chance. Two on-disk schemas are accepted:
        #   Legacy (Stage 7.4-): {race, matchup: "vs Zerg" | "vs Any"}
        #   v3     (Stage 7.5+): {race, vs_race: "Zerg" | "Any"}
        for cb in self.custom_builds:
            cb_race = cb.get("race", "Any")
            if cb_race != "Any" and cb_race != my_race:
                continue
            cb_matchup = cb.get("matchup")
            cb_vs_race = cb.get("vs_race")
            if cb_matchup is not None:
                if cb_matchup != "vs Any" and cb_matchup != matchup:
                    continue
            elif cb_vs_race not in (None, "Any"):
                if f"vs {cb_vs_race}" != matchup:
                    continue
            if self.check_custom_rules(cb.get("rules", []), buildings, units, upgrades, main_loc):
                return cb["name"]

        # 2. Race-aware structured signature scan (Zerg / Terran).
        # Stage 8 will populate BUILD_SIGNATURES with real opening rules;
        # for now any non-Protoss replay flows through here and ends up
        # tagged 'Unclassified - <Race>' so the UI can show a 'we don't
        # have definitions for this matchup yet' hint instead of a
        # misleading Protoss-tree label.
        if my_race in ("Zerg", "Terran"):
            vs_race = _matchup_to_vs_race(matchup)
            for name, meta in candidate_signatures_for(my_race, vs_race).items():
                signature = meta.get("signature") or []
                if not signature:
                    # TODO(stage-8): skip stubs until real signatures land.
                    continue
                if self.check_custom_rules(
                    signature, buildings, units, upgrades, main_loc,
                ):
                    return name
            return f"Unclassified - {my_race}"

        def has_building(name, time_limit=9999):
            return any(b['name'] == name and b['time'] <= time_limit for b in buildings)

        def has_proxy(name, time_limit=9999, dist=50):
            return any(b['name'] == name and b['time'] <= time_limit and self._is_proxy(b, main_loc, dist) for b in buildings)

        def count_units(name, time_limit=9999):
            # Prereq-aware: a unit only counts toward classification when
            # its tech-structure prerequisite was started before the
            # unit appeared. Filters Sentry hallucinations (Phoenix /
            # VoidRay / HighTemplar / Archon / Immortal / Colossus /
            # WarpPrism) that would otherwise flag the wrong build.
            return count_real_units(name, time_limit, units, buildings)

        def has_upgrade_substr(sub_name, time_limit=9999):
            return any(sub_name in u['name'] and u['time'] <= time_limit for u in upgrades)

        def building_time(name):
            times = [b['time'] for b in buildings if b['name'] == name]
            return min(times) if times else 9999

        gate_count_6min = sum(1 for b in buildings if b['name'] == "Gateway" and b['time'] < 540)
        gate_count_530 = sum(1 for b in buildings if b['name'] == "Gateway" and b['time'] < 480)

        # --- PvZ ---
        if "vs Zerg" in matchup:
            sg_count_10min     = sum(1 for b in buildings if b['name'] == "Stargate" and b['time'] < 600)
            nexus_count_10min  = sum(1 for b in buildings if b['name'] == "Nexus"    and b['time'] < 600)
            # DT-path discriminators for the 2SG VR rule. A pure 2-Stargate
            # Void Ray opener never builds a Dark Shrine, never produces a
            # Dark Templar, and never adds a 3rd Stargate inside the 10:00
            # window. Any one of those signals means the game belongs in a
            # different bucket (typically the user's "DT into 3 Stargate
            # Void Ray" custom, which the loop above tries first).
            has_dark_shrine_10min = has_building("DarkShrine", 600)
            dt_count_10min        = count_units("DarkTemplar", 600)

            # Carrier / Tempest both require Stargate + Fleet Beacon.
            # count_units already filters hallucinations, but the
            # explicit head guard prevents a regression if count_units
            # is ever swapped for a raw count.
            if (has_building("Stargate", 600) and has_building("FleetBeacon", 600)
                    and count_units("Carrier", 600) >= 1):
                return "PvZ - Carrier Rush"
            if (has_building("Stargate", 600) and has_building("FleetBeacon", 600)
                    and count_units("Tempest", 600) >= 1):
                return "PvZ - Tempest Rush"
            if (sg_count_10min == 2
                    and nexus_count_10min >= 2
                    and count_units("VoidRay", 600) >= 4
                    and not has_dark_shrine_10min
                    and dt_count_10min == 0):
                return "PvZ - 2 Stargate Void Ray"
            if sg_count_10min >= 3 and nexus_count_10min >= 2 and count_units("Phoenix", 600) >= 4:
                return "PvZ - 3 Stargate Phoenix"
            if sg_count_10min >= 2 and nexus_count_10min >= 2 and count_units("Phoenix", 600) >= 4:
                return "PvZ - 2 Stargate Phoenix"
            # Disruptor needs Robo + Robo Bay; Warp Prism needs Robo.
            if (has_building("RoboticsFacility", 480) and has_building("RoboticsBay", 480)
                    and count_units("Disruptor", 480) >= 1 and count_units("WarpPrism", 480) >= 1):
                return "PvZ - Rail's Disruptor Drop"

            if (has_building("Stargate", 510) and count_units("Oracle", 510) >= 2
                    and has_building("RoboticsFacility", 510) and has_building("Forge", 510)
                    and sum(1 for b in buildings if b['name'] == "Nexus" and b['time'] < 510) >= 3):
                return "PvZ - AlphaStar Style (Oracle/Robo)"

            # 7 Gate Glaive/Immortal: Immortals require RoboticsFacility,
            # Glaives requires Twilight Council (covered by upgrade).
            if (has_upgrade_substr("Glaive", 510) and has_building("RoboticsFacility", 510)
                    and count_units("Sentry", 510) >= 2 and count_units("Immortal", 510) >= 1
                    and gate_count_6min >= 6):
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
            # DT drop into Archon: needs Dark Shrine for the DTs and a
            # Robotics Facility for the Warp Prism.
            if (twilight_time < building_time("DarkShrine") and has_building("DarkShrine", 540)
                    and has_building("RoboticsFacility", 540)
                    and count_units("DarkTemplar", 540) >= 3 and count_units("WarpPrism", 540) >= 1):
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
            # Count gateways FINISHED before the second Nexus -- this is what
            # separates a 1-gate expand from a 2-gate expand. The previous
            # rule only required len(gate_times) >= 1, which let any 2+ gate
            # expand fall into Strange's bucket whenever the first warp-in
            # happened to be a Sentry.
            if len(nexus_times) >= 2 and nexus_times[1] < 300:
                second_nexus = nexus_times[1]
                gates_before_expand = sum(1 for t in gate_times if t < second_nexus)
                first_unit = next((u['name'] for u in sorted(units, key=lambda x: x['time']) if u['name'] in ("Stalker", "Adept", "Sentry", "Zealot")), None)

                # 2 Gate Expand: 2+ gates finished before the natural goes
                # down (the "safe" PvP opener).
                if gates_before_expand >= 2:
                    return "PvP - 2 Gate Expand"

                # Strange's 1 Gate Expand: exactly 1 gate before the natural
                # AND the first warp-in is a Sentry (the build's signature).
                if gates_before_expand == 1 and first_unit == "Sentry":
                    return "PvP - Strange's 1 Gate Expand"

                # Standard 1 Gate Expand: exactly 1 gate before the natural,
                # first unit is anything other than a Sentry.
                if gates_before_expand == 1 and first_unit in ("Stalker", "Adept", "Zealot"):
                    return "PvP - 1 Gate Expand"

            # AlphaStar 4 Adept / Oracle: Oracle requires Stargate.
            if (has_building("Stargate", 390) and count_units("Adept", 360) >= 4
                    and count_units("Oracle", 390) >= 1):
                return "PvP - AlphaStar (4 Adept/Oracle)"
            if (has_building("Stargate", 450) and count_units("Stalker", 390) >= 3
                    and count_units("Oracle", 450) >= 1 and has_building("DarkShrine", 540)):
                return "PvP - 4 Stalker Oracle into DT"

            robo_time = building_time("RoboticsFacility")
            twilight_time = building_time("TwilightCouncil")
            sec_nexus_time = nexus_times[1] if len(nexus_times) >= 2 else 9999
            if robo_time < twilight_time and twilight_time < sec_nexus_time:
                return "PvP - Rail's Blink Stalker (Robo 1st)"
            if has_building("Stargate", 510) and count_units("Phoenix", 510) >= 3:
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
            # Phoenix builds: require an actual Stargate. A Sentry can
            # hallucinate Phoenix off Cyber + Twilight tech, so a 2-base
            # Charge / Templar build will register a "Phoenix" event
            # without any Stargate ever going down. count_units already
            # filters hallucinations via the prereq table; the explicit
            # has_building guard documents the intent and makes the
            # rule robust to count_units regressions.
            if (has_building("Stargate", 420) and count_units("Phoenix", 420) >= 1
                    and has_building("RoboticsFacility", 480)):
                return "PvT - Phoenix into Robo"
            if has_building("Stargate", 420) and count_units("Phoenix", 420) >= 1:
                gate_times = sorted([b['time'] for b in buildings if b['name'] == "Gateway"])
                if len(gate_times) >= 2 and gate_times[1] < robo_time:
                    return "PvT - Phoenix Opener"

            if has_upgrade_substr("Blink", 540) and gate_count_6min >= 6:
                return "PvT - 7 Gate Blink All-in"
            if has_upgrade_substr("Charge", 540) and gate_count_730 >= 7 and len(nexus_times) < 3:
                return "PvT - 8 Gate Charge All-in"
            # 2 Base Templar requires an actual Templar Archives
            # (HighTemplar / Storm). Without this guard, a replay where
            # neither a Templar Archives nor a 3rd Nexus was ever built
            # would compare 9999 < 9999 (False), but a replay where only
            # the 3rd Nexus is missing would compare ta_time < 9999
            # which is True even when ta_time itself is 9999 only when
            # both are missing - so anchor explicitly to has_building.
            if (has_building("TemplarArchive", 9999) and ta_time < third_nexus_time
                    and (4 <= gate_count_730 <= 6)):
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

            # DT Drop: needs Dark Shrine for the DTs and Robotics
            # Facility for the Warp Prism.
            if (has_building("DarkShrine", 540) and has_building("RoboticsFacility", 600)
                    and count_units("WarpPrism", 600) >= 1):
                return "PvT - DT Drop"
            if has_building("RoboticsFacility", 390):
                if robo_time < sg_time and robo_time < twilight_time:
                    return "PvT - Robo First"
            return "PvT - Macro Transition (Unclassified)"

        return f"Unclassified - {my_race}"
