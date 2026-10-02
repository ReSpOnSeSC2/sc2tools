"""Base detector with shared geometry and custom-rule evaluation.

Both :class:`OpponentStrategyDetector` and :class:`UserBuildDetector`
inherit from this class. The base layer owns:

  * proxy-distance geometry helpers (``_get_main_base_loc`` /
    ``_is_proxy`` / ``_is_far_proxy``) and the canonical per-structure
    proxy test (``_is_canonical_proxy``) the agent's spatial stamp shares
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

from .build_definitions import PROXY_ELIGIBLE_BUILDINGS, proxy_distance_for
from .build_durations import to_start_seconds
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

    def _is_canonical_proxy(self, building: Dict, main_loc: Tuple[float, float]) -> bool:
        """The one proxy test custom rules and the agent's spatial stamp share.

        The radius depends on the structure: 80 units for town halls, gas
        and Spine / Spore Crawlers (a standard third base is 50-80 units
        from the main), 50 for everything else. See
        ``build_definitions.proxy_distance_for``.
        """
        return self._is_proxy(
            building, main_loc, proxy_distance_for(building.get("name")),
        )

    # ---------- start-time view for v3 rules ----------
    @staticmethod
    def _at_start_times(
        events: List[Dict], kind: str, eight_worker: bool,
    ) -> List[Dict]:
        """Copy ``events`` with finish times rewound to start times.

        ``kind`` is the list's event type: "building", "unit" or "upgrade".
        Events whose time is missing or not a finite number are passed
        through untouched so the callers' own malformed-time handling
        still sees them.
        """
        out: List[Dict] = []
        for ev in events:
            recorded = ev.get("time")
            if (
                isinstance(recorded, (int, float))
                and not isinstance(recorded, bool)
                and math.isfinite(recorded)
            ):
                start = to_start_seconds(
                    ev.get("name"),
                    recorded,
                    is_building=kind == "building",
                    is_upgrade=kind == "upgrade",
                    eight_worker=eight_worker,
                )
                if start != recorded:
                    ev = {**ev, "time": start}
            out.append(ev)
        return out

    # ---------- custom rules ----------
    # Module-level: v3 rule.name format prepends the source verb to the
    # bare unit/building/upgrade name (e.g. 'BuildStargate', 'TrainPhoenix',
    # 'ResearchBlink', 'MorphLair'). Live event_extractor emits the bare
    # name ('Stargate', 'Phoenix', 'Blink', 'Lair'). To match v3 rules
    # against live events we strip a recognised verb prefix.
    #
    # The noun is the event's own name and need not start with a capital:
    # sc2reader reports a few upgrades in lower case, and the cloud's token
    # for them is verb + raw name ('Buildzerglingmovementspeed',
    # 'Buildoverlordspeed', 'Researchzerglingattackspeed'), which is what
    # the SPA saves. Requiring 'Build<Capital>' here made those rules
    # unmatchable on the desktop.
    _V3_NAME_PREFIXES = ("Build", "Train", "Research", "Morph")

    @staticmethod
    def _normalize_rule_name(name):
        """Strip the verb prefix from a v3 rule name; pass-through for v1.

        Example:
            >>> BaseStrategyDetector._normalize_rule_name('BuildStargate')
            'Stargate'
            >>> BaseStrategyDetector._normalize_rule_name('Stargate')
            'Stargate'
            >>> BaseStrategyDetector._normalize_rule_name('Buildoverlordspeed')
            'overlordspeed'
        """
        if not isinstance(name, str):
            return name
        for prefix in BaseStrategyDetector._V3_NAME_PREFIXES:
            if name.startswith(prefix) and len(name) > len(prefix):
                return name[len(prefix):]
        return name

    def check_custom_rules(
        self,
        rules: List[Dict],
        buildings: List[Dict],
        units: List[Dict],
        upgrades: List[Dict],
        main_loc: Tuple[float, float],
        eight_worker: bool = False,
    ) -> bool:
        """Return True if every rule passes.

        Supports both schemas:
          v1: ``building`` / ``unit`` / ``unit_max`` / ``upgrade`` / ``proxy``
              (legacy Spawning-Tool style). Names are bare ('Stargate'),
              cutoff is inclusive (``time <= time_lt``) and compared with
              the RECORDED event time, as those rules were authored.
              ``proxy`` honours an explicit ``dist`` and otherwise uses the
              canonical per-structure radius.
          v3: ``before`` / ``not_before`` / ``count_max`` / ``count_exact``
              / ``count_min`` (rule-engine schema written by the SPA).
              Names are prefixed ('BuildStargate'); we strip the verb so
              the live ``event_extractor`` events match. Cutoff is strict
              (``time < time_lt``) per the v3 contract in
              ``stream-overlay-backend/routes/custom_builds_helpers.js``.
              ``proxy: true`` restricts the rule to structures that pass
              the canonical :meth:`_is_canonical_proxy` test.

        v3 thresholds are saved off the website's START-time timeline, and
        the cloud evaluator (``apps/api/src/services/buildRulesEvaluator.js``
        fed by ``eventsToStartTime``) compares start times. The extractor
        records units, structure morphs and upgrades when they FINISH, so
        v3 rules are evaluated here against the same start-time view:
        ``build_durations.to_start_seconds`` rewinds those events, with the
        8-worker patch 5.0.16's durations when ``eight_worker`` is set.
        Keep the two evaluators in agreement --
        ``tests/test_custom_rule_parity.py`` and the API's
        ``customRuleParity.test.js`` run the same cases through both.

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

        # Start-time copies of the three event lists, built on the first
        # v3 rule so v1-only rule sets never pay for them.
        v3_view = None

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
                dist = rule.get("dist")
                if dist is None:
                    dist = proxy_distance_for(raw_name)
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
                if v3_view is None:
                    v3_view = (
                        self._at_start_times(buildings, "building", eight_worker),
                        # Worker births reach ``units`` for the built-in
                        # trees' Drone / Probe / SCV counts, but they are
                        # never written to the build log, so the cloud
                        # cannot count them. v3 rules do not see them here
                        # either.
                        self._at_start_times(
                            [u for u in units if u.get("type") != "worker"],
                            "unit",
                            eight_worker,
                        ),
                        self._at_start_times(upgrades, "upgrade", eight_worker),
                    )
                s_buildings, s_units, s_upgrades = v3_view
                norm_name = self._normalize_rule_name(raw_name)
                proxy_only = rule.get("proxy") is True
                if proxy_only and not (
                    isinstance(raw_name, str)
                    and raw_name.startswith("Build")
                    and raw_name[len("Build"):] in PROXY_ELIGIBLE_BUILDINGS
                ):
                    return False
                if proxy_only and (
                    main_loc == (0.0, 0.0)
                    or not all(
                        isinstance(coord, (int, float))
                        and not isinstance(coord, bool)
                        and math.isfinite(float(coord))
                        and float(coord) != 0.0
                        for coord in main_loc
                    )
                ):
                    # Missing owner-main geometry is unknown, not proof that
                    # no proxy occurred. Fail closed for negative/count-zero
                    # rules just as the cloud evaluator does for legacy rows.
                    return False
                if proxy_only:
                    tol = rule.get("tol") if rtype == "before" else None
                    for building in s_buildings:
                        if building.get("name") != norm_name:
                            continue
                        event_time = building.get("time")
                        if (
                            not isinstance(event_time, (int, float))
                            or isinstance(event_time, bool)
                            or not math.isfinite(float(event_time))
                        ):
                            # Without a time we cannot prove the malformed
                            # structure lies outside this rule's window.
                            return False
                        if isinstance(tol, (int, float)) and tol > 0:
                            relevant = abs(event_time - time_lt) <= tol
                        else:
                            relevant = event_time < time_lt
                        if relevant and not all(
                            isinstance(building.get(axis), (int, float))
                            and not isinstance(building.get(axis), bool)
                            and math.isfinite(float(building[axis]))
                            and float(building[axis]) != 0.0
                            for axis in ("x", "y")
                        ):
                            # A missing coordinate is unknown, not evidence
                            # that no matching proxy existed. This matters most
                            # for negative/count-zero rules, which would
                            # otherwise pass vacuously through _is_proxy's 0s.
                            return False
                # v3 events flatten buildings + units + upgrades into one
                # stream. For unit events whose tech prerequisite is
                # known, drop hallucinated occurrences (events whose
                # prerequisite structure was never started by the
                # event's own start time).
                is_unit_with_prereq = norm_name in UNIT_TECH_PREREQUISITES

                def _v3_event_passes(ev) -> bool:
                    name_ok = ev.get("name") == norm_name
                    if not name_ok:
                        return False
                    if proxy_only:
                        if ev not in s_buildings:
                            return False
                        if not self._is_canonical_proxy(ev, main_loc):
                            return False
                    if is_unit_with_prereq and ev in s_units:
                        if ev.get("hallucinated") is True:
                            return False
                        if not unit_prereq_met(
                            norm_name, ev.get("time", 9999), s_buildings,
                        ):
                            return False
                    return True

                merged_events = s_buildings + s_units + s_upgrades
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
