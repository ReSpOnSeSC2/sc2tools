"""Strategy detection engine — facade module.

The implementation is split across sibling modules to keep each file
under the project's 800-line cap and to organise the detection trees
per-matchup. External callers should keep importing from
``core.strategy_detector`` — this module re-exports the same public
surface area the monolith used to ship.

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

from .strategy_detector_base import BaseStrategyDetector
from .strategy_detector_helpers import (
    GAME_TOO_SHORT_THRESHOLD_SECONDS,
    UNIT_TECH_PREREQUISITES,
    count_real_units,
    too_short_label,
    unit_prereq_met,
)
from .strategy_detector_opponent import OpponentStrategyDetector
from .strategy_detector_user import UserBuildDetector

__all__ = [
    "BaseStrategyDetector",
    "OpponentStrategyDetector",
    "UserBuildDetector",
    "UNIT_TECH_PREREQUISITES",
    "GAME_TOO_SHORT_THRESHOLD_SECONDS",
    "too_short_label",
    "unit_prereq_met",
    "count_real_units",
]
