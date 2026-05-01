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
    def __init__(self, custom_builds: List[Dict]):
        self.custom_builds = custom_builds

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
        for rule in rules:
            rtype = rule.get("type")
            if rtype in _V3_RULE_TYPES:
                if v3_events is None:
                    v3_events = self._build_v3_events(buildings, units, upgrades)
                if not self._eval_v3_rule(v3_events, rule):
                    return False
                continue
            # ---- Legacy rule schema (unchanged) ----
            name = rule.get("name")
            time_lt = rule.get("time_lt", _LEGACY_TIME_LT_DEFAULT)
            if rtype == "building":
                count = sum(1 for b in buildings if b['name'] == name and b['time'] <= time_lt)
                if count < rule.get("count", 1):
                    return False
            elif rtype == "unit":
                count = sum(1 for u in units if u['name'] == name and u['time'] <= time_lt)
                if count < rule.get("count", 1):
                    return False
            elif rtype == "unit_max":
                count = sum(1 for u in units if u['name'] == name and u['time'] <= time_lt)
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
