"""Terran-vs-Protoss user-build classification tree.

Pure function: given a :class:`DetectionContext` for a Terran player in
a TvP matchup, return the build-label string. The caller
(``UserBuildDetector.detect_my_build``) decides when to dispatch here
based on the matchup string.

This module is a forward-looking scaffold. The only TvP rule currently
in production — ``TvP - 1-1-1 One Base`` — lives in
``strategy_detector_user.py`` next to the race-aware signature scan
because it predates this per-matchup split and runs BEFORE the
signature scan. Future TvP rules can land here without further
restructuring the dispatcher; :func:`detect_tvp` is already wired into
:meth:`UserBuildDetector.detect_my_build` as a post-signature-scan
fallback.
"""

from __future__ import annotations

from typing import Optional

from .strategy_detector_helpers import DetectionContext


def detect_tvp(ctx: DetectionContext) -> Optional[str]:
    """Return the TvP user-build label, or ``None`` if no rule matched.

    ``ctx`` is unused today because no rules are wired up; the parameter
    is kept to lock the function signature in place so future rules
    don't have to change every call site.
    """
    del ctx  # explicitly unused — keeps the signature stable for future rules
    return None
