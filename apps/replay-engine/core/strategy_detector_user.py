"""User-side build classifier.

Given the user's own extracted events, emit the build-label string the
dashboard / builds page / opponent profile attaches to the player's
side of the matchup. Custom JSON rules run first; Zerg/Terran replays
flow through the structured signature scan, and Protoss replays
dispatch to the per-matchup decision trees in
``strategy_detector_pvz`` / ``..._pvp`` / ``..._pvt``.
"""

from __future__ import annotations

from typing import Dict, List

from .strategy_detector_base import BaseStrategyDetector
from .strategy_detector_helpers import (
    GAME_TOO_SHORT_THRESHOLD_SECONDS,
    DetectionContext,
    _matchup_to_vs_race,
    too_short_label,
)
from .strategy_detector_pvp import detect_pvp
from .strategy_detector_pvt import detect_pvt
from .strategy_detector_pvz import detect_pvz
from .strategy_detector_race import classify_by_race


class UserBuildDetector(BaseStrategyDetector):
    """Classifies the USER's own build (PvZ / PvP / PvT)."""

    def detect_my_build(
        self,
        matchup: str,
        my_events: List[Dict],
        my_race: str = "Protoss",
        game_length_seconds: float = None,
    ) -> str:
        # Short-circuit: a replay that ended before 30 seconds has no
        # build order to classify. Emit the matchup-prefixed
        # "Game Too Short" bucket so it groups with the opponent-side
        # equivalent emitted from OpponentStrategyDetector. The macro
        # rule tree below would otherwise tag these as "Macro
        # Transition (Unclassified)" or "Unclassified - <Race>" which
        # makes the no-build-order cohort impossible to filter.
        if (
            game_length_seconds is not None
            and game_length_seconds < GAME_TOO_SHORT_THRESHOLD_SECONDS
        ):
            vs_race = _matchup_to_vs_race(matchup)
            return too_short_label(my_race, vs_race)

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

        # 2. Zerg / Terran: delegate to the shared race classifier so the
        # user's own build classifies exactly like the opponent's would,
        # off the same build_definitions catalog (a fast-3-CC Terran ->
        # "Terran - Fast 3 CC" instead of "Unclassified - Terran"). The
        # opponent detector runs the same classify_by_race trees.
        if my_race in ("Zerg", "Terran"):
            return classify_by_race(my_race, my_events, self)

        # 3. Protoss matchups dispatch to per-matchup decision trees.
        ctx = DetectionContext(
            buildings=buildings,
            units=units,
            upgrades=upgrades,
            main_loc=main_loc,
            detector=self,
        )
        if "vs Zerg" in matchup:
            label = detect_pvz(ctx)
            if label is not None:
                return label
        elif "vs Protoss" in matchup:
            label = detect_pvp(ctx)
            if label is not None:
                return label
        elif "vs Terran" in matchup:
            label = detect_pvt(ctx)
            if label is not None:
                return label

        return f"Unclassified - {my_race}"
