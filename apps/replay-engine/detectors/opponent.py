"""Compatibility shim over the canonical opponent-strategy detector.

The inlined opponent tree that used to live here stopped at generic
race-prefixed labels ("Zerg - …"); the canonical detector first runs
the matchup-specific trees via ``classify_by_race`` (e.g. "ZvT - Ling
Bane Bust") before falling back to the generic tree. Bulk-imported
replays therefore now receive the same (richer) labels the agent path
has produced all along — an intentional relabel, not an accident.
"""

from core.strategy_detector_opponent import OpponentStrategyDetector

__all__ = ["OpponentStrategyDetector"]
