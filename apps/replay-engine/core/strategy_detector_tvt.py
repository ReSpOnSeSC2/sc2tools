"""Terran-vs-Terran user-build classification tree.

Pure function: given a :class:`DetectionContext` for a Terran player in
a TvT matchup, return the build-label string. The caller
(``UserBuildDetector.detect_my_build``) decides when to dispatch here
based on the matchup string.

This module is a forward-looking scaffold — no TvT-specific rules
exist today. Future rules can land here without further restructuring
the dispatcher; :func:`detect_tvt` is already wired into
:meth:`UserBuildDetector.detect_my_build` as a post-signature-scan
fallback.
"""

from __future__ import annotations

from typing import Optional

from .strategy_detector_helpers import DetectionContext


def detect_tvt(ctx: DetectionContext) -> Optional[str]:
    """Return the TvT user-build label, or ``None`` if no rule matched.

    ``ctx`` is unused today because no rules are wired up; the parameter
    is kept to lock the function signature in place so future rules
    don't have to change every call site.
    """
    del ctx  # explicitly unused — keeps the signature stable for future rules
    return None
