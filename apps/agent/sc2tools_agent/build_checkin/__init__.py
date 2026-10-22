"""Build check-in: ask the player which build they went for.

A confirmed check-in makes a game count toward the declared build's
record even when the replay classifier labelled it differently. The
desktop agent asks twice: a loading-screen card ("What's the plan?") and
an end-of-game card ("Which build were you going for?"), which also
lets the player correct the opponent's build and open the game on
sc2tools.com to save a build they did not have yet.

This package is Qt-free:

* ``models`` — API parsers and the immutable card view models.
* ``view`` — the protocol the Qt windows implement, plus a no-op view.
* ``controller`` — the single-threaded actor that owns every policy.
* ``matching`` / ``render`` / ``records`` — its pure helpers and state.
* ``links`` — the sc2tools.com pages the cards open.
* ``wiring`` — the one call ``runner`` makes to start it.
"""

from __future__ import annotations

from .controller import BuildCheckinController
from .models import (
    BuildOptionModel,
    CheckinPrefs,
    LoadingCardModel,
    OpponentRowModel,
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
    "OpponentRowModel",
    "PostgameCardModel",
    "RandomizerStripModel",
    "build_checkin_view_for",
    "start_build_checkin",
]
