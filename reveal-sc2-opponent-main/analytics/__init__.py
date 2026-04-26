"""Cross-replay analytics for the SC2 Meta Analyzer.

This package houses pure-Python analytics that consume the structured event
bundles produced by `core.event_extractor`. The macro-efficiency engine
(`macro_score.py`) is the first module to land here; future engines
(win-probability, build clustering) should live alongside it.
"""
