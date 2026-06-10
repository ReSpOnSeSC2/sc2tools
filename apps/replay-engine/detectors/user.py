"""Detector for the user's own build.

`detect_my_build(matchup, my_events, my_race)` runs custom builds first.
Protoss then walks the matchup-specific decision trees below (PvZ / PvP
/ PvT); Zerg and Terran delegate to the shared perspective-agnostic
classifier in ``core.strategy_detector_race`` (matchup trees + generic
race trees + composition fallback) so both detector stacks label a
build identically.
"""

from typing import Dict, List

from .base import (
    BaseStrategyDetector,
    base_count_at,
    count_real_units,
    count_started_before,
    nth_base_start,
    start_times,
)


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

        # 2. Zerg / Terran: delegate to the shared perspective-agnostic
        # classifier in ``core`` — the same matchup trees + generic race
        # trees + composition fallback the cloud agent and the
        # opponent-side detector use. This replaced the Stage-8 stub
        # scan that returned 'Unclassified - <Race>' for every
        # non-Protoss replay; keeping the two stacks on one classifier
        # means a Zerg/Terran build labels identically whether it was
        # parsed by the agent, the bulk-import CLI, or the legacy SPA.
        if my_race in ("Zerg", "Terran"):
            vs_race = _matchup_to_vs_race(matchup)
            try:
                from core.strategy_detector_race import classify_by_race
            except ImportError:
                # The engine core isn't importable (stripped install).
                # Degrade to the old sentinel rather than crash parsing.
                return f"Unclassified - {my_race}"
            return classify_by_race(my_race, my_events, self, opp_race=vs_race)

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

        def upgrade_time(*sub_names):
            return min(
                (u['time'] for u in upgrades
                 if any(s in u['name'] for s in sub_names)),
                default=9999,
            )

        def building_time(name):
            times = [b['time'] for b in buildings if b['name'] == name]
            return min(times) if times else 9999

        gate_count_6min = count_started_before(buildings, "Gateway", 540)
        gate_count_530 = count_started_before(buildings, "Gateway", 480)

        # --- PvZ ---
        if "vs Zerg" in matchup:
            sg_count_10min = count_started_before(buildings, "Stargate", 600)
            nexus_count_10min = base_count_at(buildings, "Nexus", 600)
            # DT-path discriminators for the 2SG VR rule. A pure 2-Stargate
            # Void Ray opener never builds a Dark Shrine, never produces a
            # Dark Templar, and never adds a 3rd Stargate inside the 10:00
            # window. Any one of those signals means the game belongs in a
            # different bucket (typically the user's "DT into 3 Stargate
            # Void Ray" custom, which the loop above tries first).
            has_dark_shrine_10min = has_building("DarkShrine", 600)
            dt_count_10min        = count_units("DarkTemplar", 600)

            # OPENER ordering used by every Stargate-rush label below.
            # Pure ordering: a Stargate opener is one where Stargate is
            # the FIRST tech committed (before any Twilight Council /
            # Dark Shrine / Robotics Facility). If Twilight / Robo /
            # DarkShrine came first, it's a transition INTO Stargate
            # and must NOT mis-fire a "2 Stargate X" rush label. No
            # time threshold -- a slow Stargate opener with nothing
            # else built first is still a Stargate opener. Mirror of
            # reveal-sc2-opponent-main/core/strategy_detector_pvz.py.
            sg_time = building_time("Stargate")
            twilight_time = building_time("TwilightCouncil")
            robo_time = building_time("RoboticsFacility")
            dark_shrine_time = building_time("DarkShrine")
            stargate_first_tech = (
                sg_time < 9999
                and sg_time < twilight_time
                and sg_time < dark_shrine_time
                and sg_time < robo_time
            )

            # Hoisted Twilight-ordering signal: identifies WHICH upgrade
            # is researched first out of the Twilight Council. The
            # Stargate-rush rules below use this to disqualify themselves
            # on builds that researched Glaives first -- those are
            # fundamentally Glaives builds (Phoenix / Void Rays are
            # support for the Adept timing), not pure Stargate-tech
            # builds, and they should land on Stargate-into-Glaives
            # further down the tree. Mirror of canonical detector.
            glaive_time = upgrade_time("AdeptPiercing", "Glaive")
            blink_time = upgrade_time("Blink")
            charge_time = upgrade_time("Charge")
            glaive_first_off_twilight = (
                glaive_time < 9999
                and glaive_time < blink_time
                and glaive_time < charge_time
            )

            # Carrier / Tempest both require Stargate + Fleet Beacon.
            # count_units already filters hallucinations, but the
            # explicit head guard prevents a regression if count_units
            # is ever swapped for a raw count.
            if (stargate_first_tech and has_building("FleetBeacon", 600)
                    and count_units("Carrier", 600) >= 1):
                return "PvZ - Carrier Rush"
            if (stargate_first_tech and has_building("FleetBeacon", 600)
                    and count_units("Tempest", 600) >= 1):
                return "PvZ - Tempest Rush"
            # Pure-Phoenix / pure-VR disqualifiers: see canonical
            # detector. `not glaive_first_off_twilight` blocks
            # Glaives-hybrid; `not has_building("RoboticsFacility",
            # 600)` blocks Phoenix-into-Robo hybrid.
            if (stargate_first_tech
                    and sg_count_10min == 2
                    and nexus_count_10min >= 2
                    and count_units("VoidRay", 600) >= 4
                    and not has_dark_shrine_10min
                    and dt_count_10min == 0
                    and not glaive_first_off_twilight
                    and not has_building("RoboticsFacility", 600)):
                return "PvZ - 2 Stargate Void Ray"
            if (stargate_first_tech and sg_count_10min >= 3
                    and nexus_count_10min >= 2
                    and count_units("Phoenix", 600) >= 4
                    and not glaive_first_off_twilight
                    and not has_building("RoboticsFacility", 600)):
                return "PvZ - 3 Stargate Phoenix"
            if (stargate_first_tech and sg_count_10min >= 2
                    and nexus_count_10min >= 2
                    and count_units("Phoenix", 600) >= 4
                    and not glaive_first_off_twilight
                    and not has_building("RoboticsFacility", 600)):
                return "PvZ - 2 Stargate Phoenix"
            # Disruptor needs Robo + Robo Bay; Warp Prism needs Robo.
            if (has_building("RoboticsFacility", 480) and has_building("RoboticsBay", 480)
                    and count_units("Disruptor", 480) >= 1 and count_units("WarpPrism", 480) >= 1):
                return "PvZ - Rail's Disruptor Drop"

            # AlphaStar style is a STARGATE-first build -- guard with
            # ``stargate_first_tech`` so a Twilight-first build that
            # later picks up a Stargate + 2 Oracles + Robo + Forge by
            # 8:30 on 3 bases doesn't mis-fire here.
            if (stargate_first_tech and count_units("Oracle", 510) >= 2
                    and has_building("RoboticsFacility", 510) and has_building("Forge", 510)
                    and base_count_at(buildings, "Nexus", 510) >= 3):
                return "PvZ - AlphaStar Style (Oracle/Robo)"

            # Stargate into Robo: Stargate-first opener + Robo for
            # Immortal / Observer / Disruptor support. Mirror of
            # canonical detector. Accepts Phoenix / Oracle / VoidRay
            # as the Stargate-unit signal.
            if (stargate_first_tech
                    and has_building("RoboticsFacility", 600)
                    and (count_units("Phoenix", 600) >= 1
                         or count_units("Oracle", 600) >= 1
                         or count_units("VoidRay", 600) >= 1)):
                return "PvZ - Stargate into Robo"

            # 7 Gate Glaive/Immortal: Immortals require RoboticsFacility,
            # Glaives requires Twilight Council (covered by upgrade).
            if (has_upgrade_substr("Glaive", 510) and has_building("RoboticsFacility", 510)
                    and count_units("Sentry", 510) >= 2 and count_units("Immortal", 510) >= 1
                    and gate_count_6min >= 6):
                return "PvZ - 7 Gate Glaive/Immortal All-in"

            if has_upgrade_substr("Blink", 480) and gate_count_530 >= 5:
                if not has_building("Stargate", 480) and not has_building("DarkShrine", 480):
                    return "PvZ - Blink Stalker All-in (2 Base)"

            # ``sg_time`` / ``twilight_time`` / ``dark_shrine_time`` /
            # ``robo_time`` are hoisted to the top of the PvZ branch
            # for the Stargate-opener guard above.
            # Stargate into Glaives: Stargate is the first tech, Twilight
            # comes after it, and Glaives is the FIRST upgrade off the
            # Twilight (before Blink AND Charge). Classification is purely
            # order-based -- no Gateway-count window -- so a heavy 9+
            # Gateway mass-Adept timing or a light Gateway count both
            # classify the same. Mirror of canonical
            # reveal-sc2-opponent-main/core/strategy_detector_pvz.py: the
            # old ``has_upgrade_substr("Glaive", 600)`` existence check
            # (any Glaives, even AFTER Blink) plus the ``4 <=
            # gate_count_6min <= 6`` cap dropped real Glaive Adept builds
            # into Standard Blink Macro when Blink was researched second.
            if (sg_time < 9999 and twilight_time > sg_time
                    and twilight_time < 9999
                    and glaive_first_off_twilight):
                return "PvZ - Stargate into Glaives"
            if sg_time < twilight_time and has_building("TemplarArchive", 540) and count_units("Archon", 540) >= 2:
                return "PvZ - Archon Drop"
            # DT drop into Archon: needs Dark Shrine for the DTs and a
            # Robotics Facility for the Warp Prism.
            if (twilight_time < building_time("DarkShrine") and has_building("DarkShrine", 540)
                    and has_building("RoboticsFacility", 540)
                    and count_units("DarkTemplar", 540) >= 3 and count_units("WarpPrism", 540) >= 1):
                return "PvZ - DT drop into Archon Drop"
            # Standard DT Opener: Dark Shrine is built BEFORE any
            # Stargate / Robo (pure ordering, no time threshold) and at
            # least one real Dark Templar lands within the harass
            # window. Mirror of
            # reveal-sc2-opponent-main/core/strategy_detector_pvz.py.
            if (dark_shrine_time < 9999 and dark_shrine_time < sg_time
                    and dark_shrine_time < robo_time
                    and count_units("DarkTemplar", 540) >= 1):
                return "PvZ - DT Opener"
            if sg_time < twilight_time and has_upgrade_substr("Blink", 600) and base_count_at(buildings, "Nexus", 540) >= 3:
                return "PvZ - Standard Blink Macro"
            if sg_time < twilight_time and has_upgrade_substr("Charge", 540) and base_count_at(buildings, "Nexus", 540) >= 3:
                return "PvZ - Standard charge Macro"

            # Robo Opener: Robotics Facility is the FIRST tech building
            # (pure ordering, no time threshold). Mirror of canonical.
            robo_t = building_time("RoboticsFacility")
            if (robo_t < 9999 and robo_t < sg_time and robo_t < twilight_time
                    and robo_t < dark_shrine_time):
                return "PvZ - Robo Opener"
            # Stargate Opener catch-all: any Stargate-first build that
            # didn't match a more specific Stargate-prefixed rule.
            # Mirror of canonical detector.
            if stargate_first_tech:
                return "PvZ - Stargate Opener"
            return "PvZ - Macro Transition (Unclassified)"

        # --- PvP ---
        elif "vs Protoss" in matchup:
            if has_proxy("Gateway", 270, 50):
                return "PvP - Proxy 2 Gate"

            sec_nexus_time = nth_base_start(buildings, "Nexus", 2)
            total_nexuses = base_count_at(buildings, "Nexus")

            # Glaives-first ordering signal (mirror of canonical
            # reveal-sc2-opponent-main/core/strategy_detector_pvp.py).
            # Resonating Glaives being the FIRST upgrade off the
            # Twilight Council (before Blink AND Charge) marks an Adept
            # Glaive build. Computed up front so the two Glaive labels
            # below can override the generic 1/2 Gate Expand opener
            # labels and pre-empt the Blink-keyed rules.
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

            gate_times = start_times(buildings, "Gateway")
            # Count gateways STARTED before the second Nexus started --
            # this is what separates a 1-gate expand from a 2-gate
            # expand.
            if sec_nexus_time < 300:
                second_nexus = sec_nexus_time
                gates_before_expand = sum(1 for t in gate_times if t < second_nexus)
                first_unit = next((u['name'] for u in sorted(units, key=lambda x: x['time']) if u['name'] in ("Stalker", "Adept", "Sentry", "Zealot")), None)

                # 2 Gate Expand: 2+ gates started before the natural
                # goes down (the "safe" PvP opener). Falls through on a
                # Glaives-first transition so the Glaive labels below
                # can claim it.
                if gates_before_expand >= 2 and not glaive_first_off_twilight:
                    return "PvP - 2 Gate Expand"

                # Strange's 1 Gate Expand: exactly 1 gate before the natural
                # AND the first warp-in is a Sentry (the build's signature).
                if gates_before_expand == 1 and first_unit == "Sentry":
                    return "PvP - Strange's 1 Gate Expand"

                # Standard 1 Gate Expand: exactly 1 gate before the natural,
                # first unit is anything other than a Sentry. Falls through
                # on a Glaives-first transition (a Glaive Adept build that
                # opened 1-gate-expand is still a Glaive build).
                if (gates_before_expand == 1
                        and first_unit in ("Stalker", "Adept", "Zealot")
                        and not glaive_first_off_twilight):
                    return "PvP - 1 Gate Expand"

            # AlphaStar 4 Adept / Oracle: Oracle requires Stargate.
            if (has_building("Stargate", 390) and count_units("Adept", 360) >= 4
                    and count_units("Oracle", 390) >= 1):
                return "PvP - AlphaStar (4 Adept/Oracle)"
            if (has_building("Stargate", 450) and count_units("Stalker", 390) >= 3
                    and count_units("Oracle", 450) >= 1 and has_building("DarkShrine", 540)):
                return "PvP - 4 Stalker Oracle into DT"

            # Robo into Glaives: Robo built BEFORE Twilight, Glaives is
            # the FIRST upgrade off that Twilight. A common PvP Robo
            # (Immortal / Observer) opening into a Glaive Adept timing.
            # Sits ABOVE Rail's Blink Stalker (Robo 1st) -- also
            # Robo-first but with no upgrade check -- so a Robo-first
            # Glaives build isn't mis-tagged as Blink. Mirror of canonical.
            if (robo_time < 9999 and robo_time < twilight_time
                    and twilight_time < 9999 and glaive_first_off_twilight):
                return "PvP - Robo into Glaives"
            # Adept Glaives: Twilight is the FIRST tech (before Robo AND
            # Stargate) and Glaives is the first upgrade off it. Pure
            # Gateway Adept Glaive timing; sits ABOVE Blink Stalker Style
            # (which keys on Blink merely existing). Mirror of canonical.
            if (twilight_time < 9999 and twilight_time < robo_time
                    and twilight_time < sg_time and glaive_first_off_twilight):
                return "PvP - Adept Glaives"
            if robo_time < twilight_time and twilight_time < sec_nexus_time:
                return "PvP - Rail's Blink Stalker (Robo 1st)"
            if has_building("Stargate", 510) and count_units("Phoenix", 510) >= 3:
                return "PvP - Phoenix Style"
            if has_upgrade_substr("Blink", 540) and total_nexuses >= 2 and (2 <= gate_count_6min <= 4):
                return "PvP - Blink Stalker Style"
            if has_proxy("RoboticsFacility", 390):
                return "PvP - Proxy Robo Opener"
            if has_building("Stargate", 390) and not has_proxy("Stargate", 390):
                return "PvP - Standard Stargate Opener"
            return "PvP - Macro Transition (Unclassified)"

        # --- PvT ---
        elif "vs Terran" in matchup:
            sec_nexus_time = nth_base_start(buildings, "Nexus", 2)
            third_nexus_time = nth_base_start(buildings, "Nexus", 3)
            total_nexuses = base_count_at(buildings, "Nexus")

            robo_time = building_time("RoboticsFacility")
            sg_time = building_time("Stargate")
            twilight_time = building_time("TwilightCouncil")
            ta_time = building_time("TemplarArchive")
            gate_count_730 = count_started_before(buildings, "Gateway", 450)

            # First-Twilight-upgrade hoist: needed by Standard Charge
            # Macro / 7-Gate Blink / 8-Gate Charge / 3-Gate Charge Opener
            # to enforce "which upgrade was started FIRST" rather than
            # the loose "exists by 9:00" pattern that mistagged
            # Blink-first / Charge-later macro games as Standard Charge
            # Macro. Keep in sync with reveal-sc2-opponent-main's
            # strategy_detector_pvt.detect_pvt.
            pvt_glaive_time = upgrade_time("AdeptPiercing", "Glaive")
            pvt_blink_time = upgrade_time("Blink")
            pvt_charge_time = upgrade_time("Charge")
            pvt_first_twilight_upgrade = min(
                pvt_glaive_time, pvt_blink_time, pvt_charge_time,
            )

            if has_proxy("Stargate", sec_nexus_time, 50):
                return "PvT - Proxy Void Ray/Stargate"
            # Phoenix builds: require an actual Stargate. A Sentry can
            # hallucinate Phoenix off Cyber + Twilight tech, so a 2-base
            # Charge / Templar build will register a "Phoenix" event
            # without any Stargate ever going down.
            #
            # OPENER ordering (mirrors Robo First / Standard Charge
            # Macro): Phoenix into Robo and Phoenix Opener describe
            # STARGATE-FIRST openers. Without ``sg_time < robo_time``
            # AND ``sg_time < twilight_time`` a Robo-first opener that
            # added a Stargate later and got a real Phoenix on the
            # field by 7:00 would mis-fire here, stealing the replay
            # from Robo First.
            if (has_building("Stargate", 420) and count_units("Phoenix", 420) >= 1
                    and has_building("RoboticsFacility", 480)
                    and sg_time < robo_time
                    and sg_time < twilight_time):
                return "PvT - Phoenix into Robo"
            if (has_building("Stargate", 420) and count_units("Phoenix", 420) >= 1
                    and sg_time < robo_time
                    and sg_time < twilight_time):
                gate_starts = start_times(buildings, "Gateway")
                if len(gate_starts) >= 2 and gate_starts[1] < robo_time:
                    return "PvT - Phoenix Opener"

            # DT Drop: fast tactical opener calibrated against a real
            # PvT DT Drop replay (Peruano, Taito Citadel LE 2026-05-11)
            # with ~60s buffer per signal. Observed timings: Dark
            # Shrine 3:13, Robo 3:32, first DT 3:51, Warp Prism 4:11.
            # Cutoffs (4:15 / 4:30 / 5:00 / 5:15) are observed + ~60s.
            #
            # Checked BEFORE the Gateway-count blink rules below: a DT
            # drop is a Twilight-first opener that often picks up Blink
            # and keeps adding Gateways as the game goes long, so a
            # DT-drop game that transitioned into a macro Blink-Stalker
            # composition can satisfy the 7-Gate Blink All-in signature
            # by 9:00 and steal the replay. The opener was a DT drop, so
            # its tight (all signals by ~5:15) window gets priority; no
            # genuine Blink all-in builds Dark Shrine + Robo + DT + Warp
            # Prism inside 5:15.
            if (has_building("DarkShrine", 255)
                    and has_building("RoboticsFacility", 270)
                    and count_units("WarpPrism", 315) >= 1
                    and count_units("DarkTemplar", 300) >= 1):
                return "PvT - DT Drop"

            # 7-Gate Blink All-in vs 3-base Blink macro: the 5th
            # Gateway must be STARTED before the 3rd Nexus is STARTED.
            # "Taken" the 3rd Nexus means construction was initiated,
            # not finished -- a player can drop the 3rd Nexus and
            # keep adding Gateways while it is still building (~100s
            # Nexus build time) and those Gateways are still macro
            # reinforcement, not all-in production. Blink must also be
            # the FIRST Twilight upgrade -- a Charge-first / Glaives-
            # first build that later picks up Blink with 6+ Gates on
            # 2 bases is a hybrid, not a Blink all-in.
            #
            # OPENER ordering: 7 Gate Blink is a TWILIGHT-FIRST all-in;
            # a Robo-first opener that ends up with 6+ Gateways and
            # researches Blink late is NOT a Blink all-in. Mirror of
            # the OPENER guards on Standard Charge Macro / Robo First.
            gateway_starts = start_times(buildings, "Gateway")
            fifth_gateway_started = (
                gateway_starts[4] if len(gateway_starts) >= 5 else 9999
            )
            # Fast-3rd-Nexus guard: a 3rd Nexus STARTED before 6:00
            # (360s) is a macro decision, never an all-in. The
            # ``fifth_gateway_started < third_nexus_time`` check is the
            # primary discriminator, but it leaks when a build adds its
            # extra Gateways FAST around an already-early 3rd Nexus.
            # Excluding any sub-6:00 3rd Nexus keeps a fast-expand macro
            # 3-Gate Blink out of the all-in bucket; it falls through to
            # the 3 Gate Blink (Macro) rule. A LATE 3rd Nexus (>= 6:00)
            # added after a 2-base Gateway commitment still classifies.
            if (has_upgrade_substr("Blink", 540) and gate_count_6min >= 6
                    and fifth_gateway_started < third_nexus_time
                    and (total_nexuses < 3 or third_nexus_time >= 360)
                    and pvt_blink_time == pvt_first_twilight_upgrade
                    and twilight_time < robo_time
                    and twilight_time < sg_time):
                return "PvT - 7 Gate Blink All-in"
            # 8 Gate Charge All-in: same Twilight-first OPENER guard.
            if (has_upgrade_substr("Charge", 540) and gate_count_730 >= 7
                    and total_nexuses < 3
                    and pvt_charge_time == pvt_first_twilight_upgrade
                    and twilight_time < robo_time
                    and twilight_time < sg_time):
                return "PvT - 8 Gate Charge All-in"
            # 2 Base Templar requires an actual Templar Archives.
            # OPENER ordering: TA requires Twilight, so this is a
            # Twilight-first opener. Robo-first builds that add a
            # late TA for storm support correctly fall to Robo First.
            if (has_building("TemplarArchive", 9999) and ta_time < third_nexus_time
                    and (4 <= gate_count_730 <= 6)
                    and twilight_time < robo_time
                    and twilight_time < sg_time):
                return "PvT - 2 Base Templar (Reactive/Delayed 3rd)"
            # Standard Charge Macro is a Twilight-opener 3-base
            # Charge macro game. "Twilight opener" means the
            # Twilight Council is the FIRST tech building -- built
            # before any Stargate AND before any Robotics Facility.
            # Both ordering checks are required, mirroring the
            # symmetric Robo First rule below which requires Robo
            # before Twilight AND before Stargate. Without the
            # ``twilight_time < robo_time`` check, a Robo-first
            # opener that adds a Twilight Council later for Charge
            # support on 3 bases would mis-fire this rule before
            # the Robo First branch could claim the replay.
            # Charge must also be the FIRST Twilight upgrade --
            # a Blink-first / Charge-after 3-base build matches
            # on the Charge-existence + 3-Nexus signature alone
            # and gets mistagged here without the ordering guard.
            # Mirror of reveal-sc2-opponent-main's Standard Charge
            # Macro rule.
            if (has_upgrade_substr("Charge", 540)
                    and total_nexuses >= 3
                    and twilight_time < sg_time
                    and twilight_time < robo_time
                    and pvt_charge_time == pvt_first_twilight_upgrade):
                return "PvT - Standard Charge Macro"
            # Charge must be the FIRST Twilight upgrade. Without this
            # ordering guard, a Blink-first / Charge-after build with
            # Twilight before Robo+SG matches both this rule and the
            # Blink rule below, and the Charge rule wins by file order.
            if (has_upgrade_substr("Charge", 540)
                    and twilight_time < robo_time and twilight_time < sg_time
                    and pvt_charge_time == pvt_first_twilight_upgrade):
                return "PvT - 3 Gate Charge Opener"

            # X Gate Blink rules: gate count is the number of Gateways
            # STARTED BEFORE the 3rd Nexus -- macro-vs-aggression
            # commitment, not arbitrary 7:30 threshold. third_nexus_time
            # defaults to 9999 so 2-base Blink builds still classify
            # against their total Gateway count.
            gates_before_third_nexus = count_started_before(
                buildings, "Gateway", third_nexus_time,
            )
            if twilight_time < robo_time and twilight_time < sg_time and has_upgrade_substr("Blink", 540):
                if gates_before_third_nexus >= 4:
                    return "PvT - 4 Gate Blink"
                if gates_before_third_nexus == 3:
                    return "PvT - 3 Gate Blink (Macro)"

            # 2 Gate Blink (Fast 3rd Nexus): Twilight-first opener
            # with Robo follow-up for Observer / Immortal support.
            # Mirror of the OPENER guards on 4 / 3 Gate Blink Macro
            # above (they already have ``twilight_time < robo_time``
            # AND ``twilight_time < sg_time``).
            if (has_upgrade_substr("Blink", 480) and total_nexuses >= 3
                    and gates_before_third_nexus == 2
                    and has_building("RoboticsFacility", 480)
                    and twilight_time < robo_time
                    and twilight_time < sg_time):
                return "PvT - 2 Gate Blink (Fast 3rd Nexus)"

            if has_building("RoboticsFacility", 390):
                if robo_time < sg_time and robo_time < twilight_time:
                    return "PvT - Robo First"
            return "PvT - Macro Transition (Unclassified)"

        return f"Unclassified - {my_race}"
