"""Compatibility shim over the canonical user-build detector.

The ~500-line inlined PvZ/PvP/PvT rule fork that used to live here had
already drifted behind ``core/strategy_detector_user.py`` (missing the
two "PvZ - Adept Glaives" labels, and its 7-Gate rule matched only the
"Glaive" upgrade-name spelling that sc2reader never emits, so the rule
was dead on real replays). One implementation now serves the agent
deep-parse path AND the bulk importer; the canonical signature's extra
parameters (``game_length_seconds``) are optional, so 3-arg callers are
unaffected.
"""

from core.strategy_detector_user import UserBuildDetector

__all__ = ["UserBuildDetector"]
