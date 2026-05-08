"""Base class shared by `OpponentStrategyDetector` and `UserBuildDetector`.

Provides geometric helpers (`_is_proxy`, `_is_far_proxy`) and a generic
custom-rule evaluator so user-authored builds in `custom_builds.json` can be
matched without writing Python.

Two rule-list schemas are supported, side-by-side:

  Legacy (Stage 7.4 and earlier):
      {"type": "building"|"unit"|"unit_max"|"upgrade"|"proxy",
       "name": "<bare>", "time_lt": <int>, "count": <int>}
      Names are bare event tokens ("Stargate", "DarkShrine") drawn straight
      from `core.event_extractor`.

  v3 (Stage 7.5+, what the SPA's build editor authors):
      {"type": "before"|"not_before"|"count_min"|"count_max"|"count_exact",
       "name": "Build<Bare>" (or Train/Research/Morph), "time_lt": <int>,
       "count": <int>}
      Mirrors `RULE_TYPES` in
      `reveal-sc2-opponent-main/stream-overlay-backend/routes/custom_builds_helpers.js`
      so a single rule list behaves identically at ingest (this module)
      and at `/reclassify` (the JS evaluator).
"""

import math
from typing import Dict, List, Optional, Tuple


# v3 rule type names — must stay in sync with RULE_TYPES in
# stream-overlay-backend/routes/custom_builds_helpers.js. Kept as a
# frozenset for O(1) membership test inside the per-rule hot loop.
_V3_RULE_TYPES = frozenset({
    "before", "not_before", "count_min", "count_max", "count_exact",
})


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
# Mirror of UNIT_TECH_PREREQUISITES in
# reveal-sc2-opponent-main/core/strategy_detector.py -- keep both in
# sync.
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

# Verb prefix prepended to bare event names when serialising the
# in-memory event lists into the v3 token vocabulary. Matches the
# parseLogLine fallback in custom_builds_helpers.js, which prepends
# "Build" to every bare-noun token so the user's `build_log` on disk
# speaks one consistent vocabulary regardless of source category.
_V3_DEFAULT_VERB = "Build"

# Default fallback time used when a legacy rule omits `time_lt`. Set to a
# value larger than any realistic SC2 game so "anywhere in the game"
# semantics are preserved.
_LEGACY_TIME_LT_DEFAULT = 9999


class BaseStrategyDetector:
    # Re-exported as a class attribute so subclasses and external callers
    # have a single place to look without having to import the
    # module-level table directly.
    UNIT_TECH_PREREQUISITES = UNIT_TECH_PREREQUISITES

    def __init__(self, custom_builds: List[Dict]):
        self.custom_builds = custom_builds

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

    def _get_main_base_loc(self, buildings: List[Dict]) -> Tuple[float, float]:
        town_halls = [b for b in buildings if b['name'] in (
            "Nexus", "Hatchery", "CommandCenter", "OrbitalCommand", "PlanetaryFortress"
        )]
        if not town_halls:
            return (0, 0)
        town_halls.sort(key=lambda x: x['time'])
        return (town_halls[0].get('x', 0), town_halls[0].get('y', 0))

    def _is_proxy(self, building: Dict, main_loc: Tuple[float, float], threshold: float = 50.0) -> bool:
        x, y = building.get('x', 0), building.get('y', 0)
        dist = math.sqrt((x - main_loc[0]) ** 2 + (y - main_loc[1]) ** 2)
        return dist > threshold

    def _is_far_proxy(self, unit_or_building: Dict, main_loc: Tuple[float, float], threshold: float = 80.0) -> bool:
        x, y = unit_or_building.get('x', 0), unit_or_building.get('y', 0)
        dist = math.sqrt((x - main_loc[0]) ** 2 + (y - main_loc[1]) ** 2)
        return dist > threshold

    def _build_v3_events(
        self,
        buildings: List[Dict],
        units: List[Dict],
        upgrades: List[Dict],
    ) -> List[Dict]:
        """Flatten categorised events into the {t, what} shape v3 rules expect.

        The JS evaluator reads `build_log` from meta_database.json -- a flat
        string list parsed by `parseLogLine` into {t, what} where `what` is
        verb-prefixed (BuildStargate, BuildVoidRay, ResearchBlink). Mirroring
        that here lets a single v3 rule list evaluate identically against
        in-memory replay events at ingest time.

        Example:
            >>> det = BaseStrategyDetector([])
            >>> det._build_v3_events(
            ...     [{"name": "Stargate", "time": 420}], [], [],
            ... )
            [{'t': 420, 'what': 'BuildStargate'}]
        """
        out: List[Dict] = []
        for b in buildings:
            out.append({"t": b["time"], "what": _V3_DEFAULT_VERB + b["name"]})
        for u in units:
            out.append({"t": u["time"], "what": _V3_DEFAULT_VERB + u["name"]})
        for up in upgrades:
            out.append({"t": up["time"], "what": _V3_DEFAULT_VERB + up["name"]})
        return out

    def _drop_hallucinated_v3_events(
        self,
        events: List[Dict],
        unit_event_lookup: Dict[Tuple[float, str], Dict],
        buildings: List[Dict],
    ) -> List[Dict]:
        """Filter v3 events whose `what` token is a unit lacking its prereq.

        v3 events are flat ``{"t", "what"}`` records; the original unit
        event with full ``name`` / ``time`` fields lives in
        `unit_event_lookup` keyed by ``(time, name)``. For each event,
        if the bare unit-name has a prerequisite in
        UNIT_TECH_PREREQUISITES that wasn't satisfied by `t`, drop it.
        """
        kept: List[Dict] = []
        for ev in events:
            what = ev.get("what", "")
            t = ev.get("t", 9999)
            # v3 prepends "Build" to every event token; strip it to
            # recover the bare unit/structure/upgrade name.
            bare = what[len(_V3_DEFAULT_VERB):] if what.startswith(_V3_DEFAULT_VERB) else what
            if bare in UNIT_TECH_PREREQUISITES and unit_event_lookup.get((t, bare)) is not None:
                if not unit_prereq_met(bare, t, buildings):
                    continue
            kept.append(ev)
        return kept

    def _eval_v3_rule(self, events: List[Dict], rule: Dict) -> bool:
        """Evaluate one v3 rule against a flat (t, what) event list.

        Mirrors `evaluateRule` in
        `reveal-sc2-opponent-main/stream-overlay-backend/routes/custom_builds_helpers.js`
        so the two engines stay byte-for-byte compatible. A malformed rule
        (missing time_lt, unknown type) returns False -- consistent with the
        JS evaluator's `{ ok: false, reason: 'malformed rule' }` path.

        Example:
            >>> det = BaseStrategyDetector([])
            >>> det._eval_v3_rule(
            ...     [{"t": 200, "what": "BuildDarkShrine"}],
            ...     {"type": "before", "name": "BuildDarkShrine", "time_lt": 360},
            ... )
            True
        """
        rtype = rule.get("type")
        name = rule.get("name")
        cutoff = rule.get("time_lt")
        if cutoff is None or name is None:
            return False
        if rtype == "before":
            return any(e["what"] == name and e["t"] < cutoff for e in events)
        if rtype == "not_before":
            return not any(e["what"] == name and e["t"] < cutoff for e in events)
        cnt = sum(1 for e in events if e["what"] == name and e["t"] < cutoff)
        if rtype == "count_min":
            return cnt >= rule.get("count", 1)
        if rtype == "count_max":
            return cnt <= rule.get("count", 0)
        if rtype == "count_exact":
            return cnt == rule.get("count", 0)
        return False

    def check_custom_rules(
        self,
        rules: List[Dict],
        buildings: List[Dict],
        units: List[Dict],
        upgrades: List[Dict],
        main_loc: Tuple[float, float],
    ) -> bool:
        """Return True iff every rule in `rules` matches the supplied events.

        Supports the legacy schema (building / unit / unit_max / upgrade /
        proxy) and the v3 schema (before / not_before / count_min /
        count_max / count_exact) in the same list. The v3 event view is
        built lazily on first encounter so legacy-only rule lists pay zero
        construction cost.
        """
        v3_events: Optional[List[Dict]] = None
        # Lookup table for the v3 hallucination filter: maps a flat
        # (time, bare-name) pair back to whether the source row was a
        # unit event. Built lazily alongside `v3_events`.
        v3_unit_lookup: Optional[Dict[Tuple[float, str], Dict]] = None

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
            if rtype in _V3_RULE_TYPES:
                if v3_events is None:
                    v3_events = self._build_v3_events(buildings, units, upgrades)
                    v3_unit_lookup = {
                        (u.get("time", 9999), u.get("name", "")): u for u in units
                    }
                    v3_events = self._drop_hallucinated_v3_events(
                        v3_events, v3_unit_lookup, buildings,
                    )
                if not self._eval_v3_rule(v3_events, rule):
                    return False
                continue
            # ---- Legacy rule schema ----
            name = rule.get("name")
            time_lt = rule.get("time_lt", _LEGACY_TIME_LT_DEFAULT)
            if rtype == "building":
                count = sum(1 for b in buildings if b['name'] == name and b['time'] <= time_lt)
                if count < rule.get("count", 1):
                    return False
            elif rtype == "unit":
                count = _count_unit_events_with_prereq(name, time_lt)
                if count < rule.get("count", 1):
                    return False
            elif rtype == "unit_max":
                count = _count_unit_events_with_prereq(name, time_lt)
                if count > rule.get("count", 999):
                    return False
            elif rtype == "upgrade":
                if not any(name in u['name'] and u['time'] <= time_lt for u in upgrades):
                    return False
            elif rtype == "proxy":
                dist = rule.get("dist", 50)
                if not any(
                    b['name'] == name and b['time'] <= time_lt and self._is_proxy(b, main_loc, dist)
                    for b in buildings
                ):
                    return False
            # Unknown rule type: silently no-op for legacy compatibility
            # (pre-7.5 behaviour; loop continues to the next rule).
        return True
