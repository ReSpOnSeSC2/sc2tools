"""Base detector with shared geometry and custom-rule evaluation.

Both :class:`OpponentStrategyDetector` and :class:`UserBuildDetector`
inherit from this class. The base layer owns:

  * proxy-distance geometry helpers (``_get_main_base_loc`` /
    ``_is_proxy`` / ``_is_far_proxy``)
  * the schema-aware custom-rule evaluator (:meth:`check_custom_rules`)
    that accepts both the legacy v1 and the rules-engine v3 schemas

Race-specific decision trees live in
``strategy_detector_opponent.py`` and the per-matchup Protoss modules
(``strategy_detector_pvz`` / ``..._pvp`` / ``..._pvt``); Zerg/Terran
user builds live in ``strategy_detector_user.py``.
"""

from __future__ import annotations

import math
from typing import Dict, List, Tuple

from .strategy_detector_helpers import (
    UNIT_TECH_PREREQUISITES,
    count_real_units,
    unit_prereq_met,
)


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
