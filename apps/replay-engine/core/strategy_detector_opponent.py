"""Opponent-side strategy classifier.

Given the opponent's extracted events (buildings / units / upgrades),
emit the human-readable strategy label that the dashboard, opponent
profile, and replay drill-down all display. Custom JSON rules are
evaluated first; the hardcoded race-specific decision tree below is
the fallback.
"""

from __future__ import annotations

from typing import Dict, List

from .strategy_detector_base import BaseStrategyDetector
from .strategy_detector_helpers import (
    GAME_TOO_SHORT_THRESHOLD_SECONDS,
    _composition_fallback_name,
    _is_start_event,
    base_count_at,
    count_real_units,
    count_started_before,
    nth_base_start,
    start_times,
    start_times_excluding_main,
    too_short_label,
)
from .strategy_detector_race import classify_by_race


class OpponentStrategyDetector(BaseStrategyDetector):
    """Classifies the OPPONENT's strategy from extracted events."""

    def get_strategy_name(
        self,
        race: str,
        enemy_events: List[Dict],
        matchup: str = "vs Any",
        game_length_seconds: float = None,
        my_race: str = None,
    ) -> str:
        # Short-circuit: a replay that ended before 30 seconds has no
        # build order to classify. Emit the matchup-prefixed
        # "Game Too Short" bucket so the dashboard groups these
        # replays together instead of mis-tagging them with the
        # macro-phase catch-all (e.g. "Macro Transition (Unclassified)")
        # or a stub label. ``my_race`` is required to build the
        # matchup prefix from the user's perspective; without it we
        # fall back to a race-prefixed variant so the bucket stays
        # consistent.
        if (
            game_length_seconds is not None
            and game_length_seconds < GAME_TOO_SHORT_THRESHOLD_SECONDS
        ):
            if my_race:
                return too_short_label(my_race, race)
            return f"{race} - Game Too Short"

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

        # 2. Hardcoded race decision tree -- shared with the user-side
        # detector via classify_by_race so a build classifies the same
        # way regardless of who built it. ``my_race`` is the opponent's
        # matchup partner (the user), so the Terran/Zerg per-matchup
        # detectors fire correctly.
        return classify_by_race(race, enemy_events, self, opp_race=my_race)
