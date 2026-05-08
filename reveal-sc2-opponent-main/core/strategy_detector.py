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

from .build_definitions import candidate_signatures_for

try:
    from .sc2_catalog import composition_summary
except ImportError:  # pragma: no cover - optional during transitional builds
    composition_summary = None  # type: ignore


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


# =========================================================
# UNIT TECH PREREQUISITES (anti-hallucination guard)
# =========================================================
# Maps a unit name to a list of alternative requirement-sets. A unit
# event is treated as "real" by build classification only when at least
# one alternative is fully satisfied: every structure listed in that
# alternative must have been STARTED before the unit's appearance time.
# The structure does NOT need to still be standing -- a Stargate that
# was killed at 5:00 still satisfies the Phoenix prerequisite at 7:00,
# because the construction event remains in the event log permanently.
#
# Why we need this:
#   A Sentry's Hallucination ability spawns illusory Phoenix / Void Ray /
#   High Templar / Archon / Immortal / Colossus / Warp Prism units that
#   show up in the replay events identically to real units. Without a
#   prerequisite filter, a single Sentry hallucination would let us
#   misclassify a 2-base Charge build as a Phoenix Opener, an Archon
#   Drop, etc. The build is only that build if the relevant tech
#   structure was actually built at some point.
#
# Keep this table in sync with the mirror in
# SC2Replay-Analyzer/detectors/base.py.
UNIT_TECH_PREREQUISITES: Dict[str, List[List[str]]] = {
    # --- Protoss: Stargate path ---
    "Phoenix":       [["Stargate"]],
    "Oracle":        [["Stargate"]],
    "VoidRay":       [["Stargate"]],
    "Carrier":       [["Stargate", "FleetBeacon"]],
    "Tempest":       [["Stargate", "FleetBeacon"]],
    "Mothership":    [["Stargate", "FleetBeacon"]],
    # --- Protoss: Robotics path ---
    "Immortal":      [["RoboticsFacility"]],
    "Observer":      [["RoboticsFacility"]],
    "WarpPrism":     [["RoboticsFacility"]],
    "Colossus":      [["RoboticsFacility", "RoboticsBay"]],
    "Disruptor":     [["RoboticsFacility", "RoboticsBay"]],
    # --- Protoss: Templar / Dark path ---
    "HighTemplar":   [["TemplarArchive"]],
    "DarkTemplar":   [["DarkShrine"]],
    # Archon morphs from 2x HT, 2x DT, or 1 HT + 1 DT, so either tech
    # structure is sufficient on its own.
    "Archon":        [["TemplarArchive"], ["DarkShrine"]],
    # --- Zerg ---
    "Zergling":      [["SpawningPool"]],
    "Queen":         [["SpawningPool"]],
    "Baneling":      [["BanelingNest"]],
    "Roach":         [["RoachWarren"]],
    "Ravager":       [["RoachWarren"]],
    "Hydralisk":     [["HydraliskDen"]],
    "Lurker":        [["LurkerDen"]],
    "LurkerMP":      [["LurkerDen"]],
    "Mutalisk":      [["Spire"]],
    "Corruptor":     [["Spire"]],
    "BroodLord":     [["GreaterSpire"]],
    "Infestor":      [["InfestationPit"]],
    "SwarmHostMP":   [["InfestationPit"]],
    "Viper":         [["Hive"]],
    "Ultralisk":     [["UltraliskCavern"]],
    # --- Terran ---
    "Marine":        [["Barracks"]],
    "Reaper":        [["Barracks"]],
    "Marauder":      [["Barracks"]],
    "Ghost":         [["Barracks", "GhostAcademy"]],
    "Hellion":       [["Factory"]],
    "Hellbat":       [["Factory", "Armory"]],
    "Cyclone":       [["Factory"]],
    "WidowMine":     [["Factory"]],
    "SiegeTank":     [["Factory"]],
    "Thor":          [["Factory", "Armory"]],
    "Medivac":       [["Starport"]],
    "Liberator":     [["Starport"]],
    "Banshee":       [["Starport"]],
    "Raven":         [["Starport"]],
    "VikingFighter": [["Starport"]],
    "Battlecruiser": [["Starport", "FusionCore"]],
}


def _structures_present_by(
    names: List[str], buildings: List[Dict], by_time: float
) -> bool:
    """All `names` have at least one start event with time <= by_time."""
    earliest: Dict[str, float] = {}
    for b in buildings:
        n = b.get("name")
        t = b.get("time", float("inf"))
        if n in names:
            cur = earliest.get(n)
            if cur is None or t < cur:
                earliest[n] = t
    return all(earliest.get(n, float("inf")) <= by_time for n in names)


def unit_prereq_met(
    unit_name: str, by_time: float, buildings: List[Dict]
) -> bool:
    """True if the tech prerequisite for `unit_name` was started by `by_time`.

    A unit not registered in UNIT_TECH_PREREQUISITES is allowed
    unconditionally (no known prereq -> trust the event).
    """
    alternatives = UNIT_TECH_PREREQUISITES.get(unit_name)
    if not alternatives:
        return True
    return any(
        _structures_present_by(req_set, buildings, by_time)
        for req_set in alternatives
    )


def count_real_units(
    unit_name: str,
    time_limit: float,
    units: List[Dict],
    buildings: List[Dict],
) -> int:
    """Count `unit_name` events with time <= time_limit, excluding hallucinations.

    A unit counts only when at least one prerequisite alternative for
    that unit type is satisfied at the unit's own appearance time. This
    is the function the build-classifier calls instead of a raw count to
    keep Sentry hallucinations from triggering false positives.
    """
    alternatives = UNIT_TECH_PREREQUISITES.get(unit_name)
    if not alternatives:
        return sum(
            1 for u in units
            if u.get("name") == unit_name and u.get("time", 9999) <= time_limit
        )
    valid = 0
    for u in units:
        if u.get("name") != unit_name:
            continue
        t = u.get("time", 9999)
        if t > time_limit:
            continue
        if any(
            _structures_present_by(req_set, buildings, t)
            for req_set in alternatives
        ):
            valid += 1
    return valid


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

    # Re-exported as class attributes so subclasses and external callers
    # have a single place to look without importing the module-level
    # functions directly.
    UNIT_TECH_PREREQUISITES = UNIT_TECH_PREREQUISITES

    def __init__(self, custom_builds: List[Dict]):
        self.custom_builds = custom_builds or []

    # ---------- prereq-aware unit accounting ----------
    @staticmethod
    def _unit_prereq_met(
        unit_name: str, by_time: float, buildings: List[Dict]
    ) -> bool:
        """See module-level :func:`unit_prereq_met`."""
        return unit_prereq_met(unit_name, by_time, buildings)

    @staticmethod
    def _count_real_units(
        unit_name: str,
        time_limit: float,
        units: List[Dict],
        buildings: List[Dict],
    ) -> int:
        """See module-level :func:`count_real_units`."""
        return count_real_units(unit_name, time_limit, units, buildings)

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
    # Module-level: v3 rule.name format prepends the source verb to the
    # bare unit/building/upgrade name (e.g. 'BuildStargate', 'TrainPhoenix',
    # 'ResearchBlink', 'MorphLair'). Live event_extractor emits the bare
    # name ('Stargate', 'Phoenix', 'Blink', 'Lair'). To match v3 rules
    # against live events we strip a recognised verb prefix when the
    # following character is uppercase (so 'Build' inside 'Builder' is
    # NOT stripped -- the name must look like 'Build<Capital>...').
    _V3_NAME_PREFIXES = ("Build", "Train", "Research", "Morph")

    @staticmethod
    def _normalize_rule_name(name):
        """Strip the verb prefix from a v3 rule name; pass-through for v1.

        Example:
            >>> BaseStrategyDetector._normalize_rule_name('BuildStargate')
            'Stargate'
            >>> BaseStrategyDetector._normalize_rule_name('Stargate')
            'Stargate'
        """
        if not isinstance(name, str):
            return name
        for prefix in BaseStrategyDetector._V3_NAME_PREFIXES:
            if (
                name.startswith(prefix)
                and len(name) > len(prefix)
                and name[len(prefix)].isupper()
            ):
                return name[len(prefix):]
        return name

    def check_custom_rules(
        self,
        rules: List[Dict],
        buildings: List[Dict],
        units: List[Dict],
        upgrades: List[Dict],
        main_loc: Tuple[float, float],
    ) -> bool:
        """Return True if every rule passes.

        Supports both schemas:
          v1: ``building`` / ``unit`` / ``unit_max`` / ``upgrade`` / ``proxy``
              (legacy Spawning-Tool style). Names are bare ('Stargate'),
              cutoff is inclusive (``time <= time_lt``).
          v3: ``before`` / ``not_before`` / ``count_max`` / ``count_exact``
              / ``count_min`` (rule-engine schema written by the SPA).
              Names are prefixed ('BuildStargate'); we strip the verb so
              the live ``event_extractor`` events match. Cutoff is strict
              (``time < time_lt``) per the v3 contract in
              ``stream-overlay-backend/routes/custom_builds_helpers.js``.

        Unknown rule types are treated as failures (NOT silently passed).
        Previously, an unknown type caused the for-loop to no-op and the
        function to return True, which let v3 rules slip through and made
        every PvZ build claim every PvZ game in the live pipeline.
        """
        def _count_unit_events_with_prereq(name: str, time_lt: float) -> int:
            """Count unit events for `name` <= time_lt, dropping hallucinations.

            Names not in UNIT_TECH_PREREQUISITES are counted unconditionally.
            """
            if name in UNIT_TECH_PREREQUISITES:
                return count_real_units(name, time_lt, units, buildings)
            return sum(
                1 for u in units
                if u.get("name") == name and u.get("time", 9999) <= time_lt
            )

        for rule in rules:
            rtype = rule.get("type")
            raw_name = rule.get("name")
            time_lt = rule.get("time_lt", 9999)

            # ---- v1 (inclusive cutoff, named on bare event names) ----
            if rtype == "building":
                count = sum(
                    1 for b in buildings
                    if b["name"] == raw_name and b["time"] <= time_lt
                )
                if count < rule.get("count", 1):
                    return False
            elif rtype == "unit":
                count = _count_unit_events_with_prereq(raw_name, time_lt)
                if count < rule.get("count", 1):
                    return False
            elif rtype == "unit_max":
                count = _count_unit_events_with_prereq(raw_name, time_lt)
                if count > rule.get("count", 999):
                    return False
            elif rtype == "upgrade":
                if not any(
                    raw_name in u["name"] and u["time"] <= time_lt
                    for u in upgrades
                ):
                    return False
            elif rtype == "proxy":
                dist = rule.get("dist", 50)
                if not any(
                    b["name"] == raw_name
                    and b["time"] <= time_lt
                    and self._is_proxy(b, main_loc, dist)
                    for b in buildings
                ):
                    return False

            # ---- v3 (strict cutoff, names use verb prefix) ----
            elif rtype in (
                "before",
                "not_before",
                "count_max",
                "count_exact",
                "count_min",
            ):
                norm_name = self._normalize_rule_name(raw_name)
                # v3 events flatten buildings + units + upgrades into one
                # stream. For unit events whose tech prerequisite is
                # known, drop hallucinated occurrences (events whose
                # prerequisite structure was never started by the
                # event's own time).
                is_unit_with_prereq = norm_name in UNIT_TECH_PREREQUISITES

                def _v3_event_passes(ev) -> bool:
                    name_ok = ev.get("name") == norm_name
                    if not name_ok:
                        return False
                    if is_unit_with_prereq and ev in units:
                        if not unit_prereq_met(
                            norm_name, ev.get("time", 9999), buildings,
                        ):
                            return False
                    return True

                merged_events = buildings + units + upgrades
                count = sum(
                    1 for ev in merged_events
                    if _v3_event_passes(ev)
                    and ev.get("time", 9999) < time_lt
                )
                target = rule.get("count", 1)
                if rtype == "before":
                    # tolerance band centred on time_lt (v3 spec)
                    tol = rule.get("tol")
                    if isinstance(tol, (int, float)) and tol > 0:
                        if not any(
                            _v3_event_passes(ev)
                            and abs(ev.get("time", 9999) - time_lt) <= tol
                            for ev in merged_events
                        ):
                            return False
                    else:
                        if count < 1:
                            return False
                elif rtype == "not_before":
                    if count >= 1:
                        return False
                elif rtype == "count_max":
                    if count > target:
                        return False
                elif rtype == "count_exact":
                    if count != target:
                        return False
                elif rtype == "count_min":
                    if count < target:
                        return False

            else:
                # Unknown rule type: refuse to claim a match. Better to
                # mis-classify as Unknown than to claim every game.
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

        # 1. Custom JSON evaluation -- supports both v1 'matchup'/'race'
        # legacy schema and v3 'vs_race'/'race' rules-engine schema. The
        # SPA writes v3, so this path is what classifies user-authored
        # builds against live replays.
        opp_race_word = matchup[3:].strip() if matchup.startswith("vs ") else matchup
        for cb in self.custom_builds:
            cb_race = cb.get("race")
            if cb_race not in (my_race, "Any", None):
                continue
            cb_vs_race = cb.get("vs_race")
            if cb_vs_race is not None:
                # v3 schema: vs_race in {Protoss, Terran, Zerg, Random, Any}
                if cb_vs_race not in ("Any", opp_race_word):
                    if not (cb_vs_race == "Random" and opp_race_word in ("Random", "")):
                        continue
            else:
                # v1 schema: matchup string "vs Zerg" / "vs Any"
                cb_matchup = cb.get("matchup", "vs Any")
                if cb_matchup not in ("vs Any", matchup):
                    continue
            rules = cb.get("rules", [])
            if not rules:
                continue  # an empty rule list cannot deterministically match
            if self.check_custom_rules(rules, buildings, units, upgrades, main_loc):
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
            return any(b["name"] == name and b["time"] <= time_limit for b in buildings)

        def has_proxy(name, time_limit=9999, dist=50):
            return any(
                b["name"] == name and b["time"] <= time_limit and self._is_proxy(b, main_loc, dist)
                for b in buildings
            )

        def count_units(name, time_limit=9999):
            # Prereq-aware: a unit only counts toward classification when
            # its tech-structure prerequisite was started before the
            # unit appeared. Filters Sentry hallucinations (Phoenix /
            # VoidRay / HighTemplar / Archon / Immortal / Colossus /
            # WarpPrism) that would otherwise flag the wrong build.
            return count_real_units(name, time_limit, units, buildings)

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

            # Carrier / Tempest both require Stargate + Fleet Beacon.
            # count_units already filters hallucinations, but document
            # the prerequisite so a future refactor can't drop it.
            if (
                has_building("Stargate", 600)
                and has_building("FleetBeacon", 600)
                and count_units("Carrier", 600) >= 1
            ):
                return "PvZ - Carrier Rush"
            if (
                has_building("Stargate", 600)
                and has_building("FleetBeacon", 600)
                and count_units("Tempest", 600) >= 1
            ):
                return "PvZ - Tempest Rush"
            if sg_count_10min >= 2 and nexus_count_10min >= 2 and count_units("VoidRay", 600) >= 4:
                return "PvZ - 2 Stargate Void Ray"
            if sg_count_10min >= 3 and nexus_count_10min >= 2 and count_units("Phoenix", 600) >= 4:
                return "PvZ - 3 Stargate Phoenix"
            if sg_count_10min >= 2 and nexus_count_10min >= 2 and count_units("Phoenix", 600) >= 4:
                return "PvZ - 2 Stargate Phoenix"
            # Rail's Disruptor Drop: Disruptor needs Robo + Robo Bay,
            # Warp Prism needs Robo. Robo presence is implied by the
            # prereq filter; spell it out for clarity.
            if (
                has_building("RoboticsFacility", 480)
                and has_building("RoboticsBay", 480)
                and count_units("Disruptor", 480) >= 1
                and count_units("WarpPrism", 480) >= 1
            ):
                return "PvZ - Rail's Disruptor Drop"

            # Oracle (Stargate) + Robo + Forge composition.
            if (
                has_building("Stargate", 510)
                and count_units("Oracle", 510) >= 2
                and has_building("RoboticsFacility", 510)
                and has_building("Forge", 510)
                and sum(1 for b in buildings if b["name"] == "Nexus" and b["time"] < 510) >= 3
            ):
                return "PvZ - AlphaStar Style (Oracle/Robo)"

            # 7 Gate Glaive/Immortal all-in: Immortals require Robotics
            # Facility, Glaive research requires Twilight Council.
            if (
                has_upgrade_substr("Glaive", 510)
                and has_building("RoboticsFacility", 510)
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
            # DT drop into Archon: needs Dark Shrine for the DTs and a
            # Robotics Facility for the Warp Prism.
            if (
                twilight_time < building_time("DarkShrine")
                and has_building("DarkShrine", 540)
                and has_building("RoboticsFacility", 540)
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
            # Phoenix builds: require an actual Stargate. Sentry can
            # hallucinate Phoenix off Cyber + Twilight tech, so a
            # 2-base Charge / Templar build can register a "Phoenix"
            # event without any Stargate ever going down. count_units
            # already filters hallucinations via the prereq table, but
            # the explicit guard makes the requirement self-documenting
            # and prevents a regression if count_units is ever swapped
            # for a raw count again.
            if (
                has_building("Stargate", 420)
                and count_units("Phoenix", 420) >= 1
                and has_building("RoboticsFacility", 480)
            ):
                return "PvT - Phoenix into Robo"
            if has_building("Stargate", 420) and count_units("Phoenix", 420) >= 1:
                gate_t = sorted([b["time"] for b in buildings if b["name"] == "Gateway"])
                if len(gate_t) >= 2 and gate_t[1] < robo_time:
                    return "PvT - Phoenix Opener"

            if has_upgrade_substr("Blink", 540) and gate_count_6min >= 6:
                return "PvT - 7 Gate Blink All-in"
            if has_upgrade_substr("Charge", 540) and gate_count_730 >= 7 and len(nexus_times) < 3:
                return "PvT - 8 Gate Charge All-in"
            # 2 Base Templar requires a Templar Archives: HT / Storm play
            # is impossible without it. building_time returns 9999 when
            # the structure was never built, so the < third_nexus_time
            # comparison alone is not enough on a replay where the user
            # never finished a 3rd Nexus -- both sides of the inequality
            # could be infinity. Anchor the check to a real cutoff.
            if (
                has_building("TemplarArchive", 9999)
                and ta_time < third_nexus_time
                and (4 <= gate_count_730 <= 6)
            ):
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

            # DT Drop: needs Dark Shrine for the DTs and Robotics
            # Facility for the Warp Prism. count_units already enforces
            # the Robo prereq for WarpPrism, but spelling it out keeps
            # the rule self-contained.
            if (
                has_building("DarkShrine", 540)
                and has_building("RoboticsFacility", 600)
                and count_units("WarpPrism", 600) >= 1
            ):
                return "PvT - DT Drop"
            if has_building("RoboticsFacility", 390):
                if robo_time < sg_time and robo_time < twilight_time:
                    return "PvT - Robo First"
            return "PvT - Macro Transition (Unclassified)"

        return f"Unclassified - {my_race}"
