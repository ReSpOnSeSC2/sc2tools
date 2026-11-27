"""Paint and wake-up budget of the build check-in cards over a game.

A card is a see-through window over StarCraft II: each repaint redraws
all of it, so a card paints when its content changes and otherwise only
wakes for the once-a-second topmost re-assert. Measured offscreen before
this budget: an animated "checking the replay" bar painted the end card
about 10,800 times a minute.
"""

from __future__ import annotations

import os
import time
from dataclasses import replace
from typing import Any, Callable, Dict

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest  # noqa: E402

pytest.importorskip("PySide6")
from PySide6 import QtCore, QtWidgets  # noqa: E402

from sc2tools_agent.build_checkin.models import (  # noqa: E402
    CHECKING_REPLAY,
    LOCKED_IN,
    RANDOMIZER_ROLLED,
    RandomizerStripModel,
)
from sc2tools_agent.build_checkin.randomizer_draw import DrawStep, RandomizerDraw  # noqa: E402
from sc2tools_agent.ui.build_checkin_cards import TOPMOST_INTERVAL_MS  # noqa: E402
from sc2tools_agent.ui.build_checkin_window import LOADING, POSTGAME, BuildCheckinHost  # noqa: E402
from tests.test_build_checkin_ui_cards import KEY, Recorder, loading_model, postgame_model  # noqa: E402
from tests.test_build_checkin_ui_cards import app, w32  # noqa: E402,F401 - pytest fixtures

REPAINTS_PER_MINUTE = 0
"""After its content settles, a card does not repaint at all."""
WAKEUPS_PER_MINUTE = 60_000 // TOPMOST_INTERVAL_MS
"""The topmost re-assert is the only timer a shown card runs."""
SETTLE_S = 0.3
MEASURE_S = 2.0

PICK = "pvp-2-gate-expand"
ROLLED = RandomizerStripModel(
    label=RANDOMIZER_ROLLED.format(name="PvP - 2 Gate Expand"), rolled_key=PICK,
    rolled_name="PvP - 2 Gate Expand", can_play=True, can_reroll=True,
)
DRAW = RandomizerDraw(
    game_key=KEY, build_key=PICK,
    steps=(DrawStep("Pylon", "0:18", "14"), DrawStep("Gateway", "0:40", "16")),
    units=("Adept", "Stalker"),
)


class CardEvents(QtCore.QObject):
    """Counts paints and timer wake-ups delivered to one card window."""

    def __init__(self, card: QtWidgets.QWidget) -> None:
        super().__init__()
        self.card = card
        self.paints = 0
        self.wakeups = 0

    def _owned(self, receiver: QtCore.QObject) -> bool:
        while receiver is not None:
            if isinstance(receiver, QtWidgets.QWidget):
                return receiver.window() is self.card
            receiver = receiver.parent()
        return False

    def eventFilter(self, receiver: QtCore.QObject, event: QtCore.QEvent) -> bool:  # noqa: N802
        kind = event.type()
        if kind in (QtCore.QEvent.Paint, QtCore.QEvent.Timer) and self._owned(receiver):
            if kind == QtCore.QEvent.Paint:
                self.paints += 1
            else:
                self.wakeups += 1
        return False


def run_for(app: QtWidgets.QApplication, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        app.processEvents(QtCore.QEventLoop.AllEvents, 20)
        time.sleep(0.005)


def shown_without_activating(app: QtWidgets.QApplication, window: QtWidgets.QWidget) -> None:
    """Offscreen Qt activates every window it shows. On Windows a card shows
    without activating, so no field of it has focus and no cursor blinks
    until the player clicks into it."""
    assert window.testAttribute(QtCore.Qt.WA_ShowWithoutActivating)
    focus = app.focusWidget()
    if focus is not None and focus.window() is window:
        focus.clearFocus()


def per_minute_allowance(per_minute: int) -> int:
    """The budget over the measured window, plus one tick of phase."""
    return int(per_minute * MEASURE_S / 60) + (1 if per_minute else 0)


def loading_with_draw(host: BuildCheckinHost) -> QtWidgets.QWidget:
    host.dispatch("show_loading", (loading_model(matchup="PvP", randomizer=ROLLED),))
    host.dispatch("show_randomizer_draw", (DRAW,))
    return host.window(LOADING)


def locked_in_with_draw(host: BuildCheckinHost) -> QtWidgets.QWidget:
    window = loading_with_draw(host)
    host.dispatch("update_loading", (loading_model(
        matchup="PvP", randomizer=None, collapsed=True, locked_key=PICK,
        locked_label=LOCKED_IN.format(name="PvP - 2 Gate Expand"),
    ),))
    return window


def desktop_roll_only(host: BuildCheckinHost) -> QtWidgets.QWidget:
    host.dispatch("show_loading", (loading_model(matchup="PvP", randomizer=ROLLED, randomizer_only=True),))
    host.dispatch("show_randomizer_draw", (DRAW,))
    return host.window(LOADING)


def end_card(**changes: Any) -> Callable[[BuildCheckinHost], QtWidgets.QWidget]:
    def show(host: BuildCheckinHost) -> QtWidgets.QWidget:
        host.dispatch("show_postgame", (replace(postgame_model(), **changes),))
        return host.window(POSTGAME)
    return show


SCENARIOS: Dict[str, Callable[[BuildCheckinHost], QtWidgets.QWidget]] = {
    "loading card with the Randomizer draw": loading_with_draw,
    "locked-in bar with the Randomizer draw": locked_in_with_draw,
    "desktop roll without check-in": desktop_roll_only,
    "end card": end_card(),
    "end card checking the replay": end_card(status=CHECKING_REPLAY, featured=(), more=(), options_loading=True,
                                             selection=None, reason=None, reason_label=None),
}


@pytest.mark.parametrize("show", SCENARIOS.values(), ids=SCENARIOS.keys())
def test_a_shown_card_stays_within_its_paint_and_wakeup_budget(app, w32, show) -> None:
    host = BuildCheckinHost(controller=lambda: Recorder())
    window = show(host)
    assert window.isVisible()
    run_for(app, SETTLE_S)
    shown_without_activating(app, window)
    run_for(app, SETTLE_S)
    events = CardEvents(window)
    app.installEventFilter(events)
    try:
        run_for(app, MEASURE_S)
    finally:
        app.removeEventFilter(events)
        host.close()
    assert events.paints <= per_minute_allowance(REPAINTS_PER_MINUTE), f"{events.paints} paints in {MEASURE_S} s"
    assert events.wakeups <= per_minute_allowance(WAKEUPS_PER_MINUTE), f"{events.wakeups} wake-ups in {MEASURE_S} s"


def test_the_draw_arriving_repaints_the_card_once_and_then_never(app, w32) -> None:
    host = BuildCheckinHost(controller=lambda: Recorder())
    host.dispatch("show_loading", (loading_model(matchup="PvP", randomizer=ROLLED),))
    window = host.window(LOADING)
    run_for(app, SETTLE_S)
    shown_without_activating(app, window)
    run_for(app, SETTLE_S)
    events = CardEvents(window)
    app.installEventFilter(events)
    try:
        host.dispatch("show_randomizer_draw", (DRAW,))
        run_for(app, SETTLE_S)
        arrival = events.paints
        run_for(app, MEASURE_S)
    finally:
        app.removeEventFilter(events)
        host.close()
    assert window.strip_draw.isVisibleTo(window)
    assert arrival > 0
    assert events.paints == arrival
