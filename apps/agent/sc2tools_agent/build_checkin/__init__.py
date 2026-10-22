"""Build check-in: ask the player which build they went for.

A confirmed check-in makes a game count toward the declared build's
record even when the replay classifier labelled it differently. The
desktop agent asks twice: a loading-screen card ("What's the plan?") and
an end-of-game card ("Which build were you going for?").

This package is Qt-free:

* ``models`` — API parsers and the immutable card view models.
* ``view`` — the protocol the Qt windows implement, plus a no-op view.
* ``controller`` — the single-threaded actor that owns every policy.
* ``matching`` / ``render`` / ``records`` — its pure helpers and state.
* ``wiring`` — the one call ``runner`` makes to start it.
"""

from __future__ import annotations

from .controller import BuildCheckinController
from .models import (
    BuildOptionModel,
    CheckinPrefs,
    LoadingCardModel,
    PostgameCardModel,
    RandomizerStripModel,
)
from .view import BuildCheckinView, NullView
from .wiring import build_checkin_view_for, start_build_checkin

__all__ = [
    "BuildCheckinController",
    "BuildCheckinView",
    "BuildOptionModel",
    "CheckinPrefs",
    "LoadingCardModel",
    "NullView",
    "PostgameCardModel",
    "RandomizerStripModel",
    "build_checkin_view_for",
    "start_build_checkin",
]
