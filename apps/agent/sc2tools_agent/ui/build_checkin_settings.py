"""Settings tab group "Build check-in".

Three checkboxes over the cloud preference ``buildCheckin`` (contract
§1.1): **Enable build check-ins**, **Ask during the loading screen** and
**Ask after each game**. A click applies immediately: it goes to the
controller (``set_prefs``), which writes the preference and reports the
value back through ``update_prefs``, so the boxes always show what the
account holds — including changes made on the website or through the
cards' "don't ask" links.

The group is disabled with a hint while there is nothing to talk to:
under ``--no-live`` (no controller in this session), before the boot
worker attached the controller, until the preference first loads, and
when the server predates build check-in.
"""

from __future__ import annotations

import time
from dataclasses import replace
from typing import Any, Callable, Optional

from PySide6 import QtCore, QtWidgets

HINT_NO_LIVE = (
    "Build check-ins need live game detection, which is turned off for "
    "this session (--no-live). You can still check in on sc2tools.com."
)
HINT_CONNECTING = "Available once the agent is connected to sc2tools.com."
HINT_LOADING = "Loading your check-in settings…"
HINT_UNSUPPORTED = "Your sc2tools server doesn't support build check-ins yet."
HINT_READY = "Check-in choices are saved to your account. Scouting visibility is saved on this PC."
HINT_SAVE_FAILED = "Couldn't save that change. Check your connection and try again."

PREVIEW_CARD_OPEN = "Your current check-in is already open."
PREVIEW_ASSISTANCE_OFF = "Turn on In-game assistance in Companion → Assistance to preview cards."
PREVIEW_UNPAIRED = "Pair your agent on Dashboard to preview cards."
PREVIEW_CONNECTING = "Companion is still connecting. Try the preview again in a moment."
PREVIEW_UNAVAILABLE = "Card previews aren't available right now."
PREVIEW_REFUSALS = {
    "card_open": PREVIEW_CARD_OPEN,
    "assistance_off": PREVIEW_ASSISTANCE_OFF,
    "unpaired": PREVIEW_UNPAIRED,
    "connecting": PREVIEW_CONNECTING,
}
"""Copy for each reason ``BuildCheckinHost.show_preview`` refuses; others get ``PREVIEW_UNAVAILABLE``."""

INTRO = (
    "Game-screen prompts start off. Enable only the prompts you want. "
    "Tell sc2tools which build you were going for. A game where the plan "
    "went sideways still counts toward that build's record."
)

REVERT_WINDOW_SEC = 15.0
"""A different value arriving this soon after a click is a failed save."""
RECHECK_MS = 4000


class CheckinSettingsGroup(QtWidgets.QFrame):
    """The Settings card. ``controller()`` returns the bound controller
    or ``None``; ``available`` is ``False`` under ``--no-live``.
    ``on_preview(kind)`` returns ``None`` once a sample card is up, else
    a refusal reason (``PREVIEW_REFUSALS``)."""

    def __init__(
        self,
        *,
        controller: Callable[[], Optional[Any]],
        available: bool,
        clock: Callable[[], float] = time.monotonic,
        parent: Optional[QtWidgets.QWidget] = None,
        on_help: Optional[Callable[[], None]] = None,
        on_preview: Optional[Callable[[str], Optional[str]]] = None,
        on_reset_positions: Optional[Callable[[], None]] = None,
        on_open_queue: Optional[Callable[[], None]] = None,
    ) -> None:
        super().__init__(parent)
        self.setObjectName("card")
        self._controller = controller
        self._available = bool(available)
        self._clock = clock
        self._prefs: Optional[Any] = None
        self._expected: Optional[Any] = None
        self._changed_at = 0.0
        self._on_preview = on_preview
        self._on_reset_positions = on_reset_positions

        layout = QtWidgets.QVBoxLayout(self)
        layout.setContentsMargins(20, 18, 20, 18)
        layout.setSpacing(10)

        title = QtWidgets.QLabel("Build check-in")
        title.setObjectName("h2")
        title_row = QtWidgets.QHBoxLayout()
        title_row.addWidget(title)
        if on_help is not None:
            from .help_links import help_button
            title_row.addWidget(help_button(QtWidgets, "Build check-in", on_help))
        title_row.addStretch(1)
        layout.addLayout(title_row)
        intro = QtWidgets.QLabel(INTRO)
        intro.setObjectName("muted")
        intro.setWordWrap(True)
        layout.addWidget(intro)

        self.enabled_box = QtWidgets.QCheckBox("Enable build check-ins")
        self.loading_box = QtWidgets.QCheckBox("Ask during the loading screen")
        self.loading_box.setToolTip(
            "A small card over the loading screen: pick your plan with one "
            "click. It never takes focus from the game.",
        )
        self.after_box = QtWidgets.QCheckBox("Ask after each game")
        self.scouting_box = QtWidgets.QCheckBox("Show scouting at loading")
        self.scouting_box.setToolTip("Private scouting on this PC, including a slim card when loading check-ins are off.")
        self.after_box.setToolTip(
            "A card after the match: confirm the build you went for and "
            "note what threw it off.",
        )
        layout.addWidget(self.enabled_box)
        for box in (self.loading_box, self.after_box, self.scouting_box):
            row = QtWidgets.QHBoxLayout()
            row.setContentsMargins(24, 0, 0, 0)
            row.addWidget(box)
            row.addStretch(1)
            layout.addLayout(row)

        self.hint = QtWidgets.QLabel("")
        self.hint.setObjectName("muted")
        self.hint.setWordWrap(True)
        self.hint.setTextFormat(QtCore.Qt.PlainText)
        layout.addWidget(self.hint)

        self.enabled_box.toggled.connect(
            lambda checked: self._changed(enabled=checked),
        )
        self.loading_box.toggled.connect(
            lambda checked: self._changed(ask_at_loading=checked),
        )
        self.after_box.toggled.connect(
            lambda checked: self._changed(ask_after_game=checked),
        )
        self.scouting_box.toggled.connect(self._scouting_changed)

        cards_title = QtWidgets.QLabel("Cards")
        cards_title.setObjectName("h2")
        layout.addWidget(cards_title)
        previews = QtWidgets.QHBoxLayout()
        self.preview_loading = QtWidgets.QPushButton("Preview loading card")
        self.preview_postgame = QtWidgets.QPushButton("Preview after-game card")
        for widget, kind in ((self.preview_loading, "loading"), (self.preview_postgame, "postgame")):
            widget.setEnabled(on_preview is not None)
            widget.clicked.connect(lambda _checked=False, kind=kind: self._preview(kind))
            previews.addWidget(widget)
        previews.addStretch(1)
        layout.addLayout(previews)
        positions = QtWidgets.QHBoxLayout()
        self.reset_positions = QtWidgets.QPushButton("Reset card positions")
        self.reset_positions.setEnabled(on_reset_positions is not None)
        self.reset_positions.clicked.connect(self._reset_positions)
        positions.addWidget(self.reset_positions)
        self.positions_status = QtWidgets.QLabel("")
        self.positions_status.setObjectName("muted")
        positions.addWidget(self.positions_status); positions.addStretch(1)
        layout.addLayout(positions)
        self._position_feedback = QtCore.QTimer(self)
        self._position_feedback.setSingleShot(True)
        self._position_feedback.setInterval(3000)
        self._position_feedback.timeout.connect(lambda: self.positions_status.clear())
        self.queue_link = QtWidgets.QPushButton("Open check-in queue on sc2tools.com")
        self.queue_link.setObjectName("checkinLink")
        self.queue_link.setFlat(True)
        self.queue_link.setEnabled(on_open_queue is not None)
        if on_open_queue is not None:
            self.queue_link.clicked.connect(on_open_queue)
        layout.addWidget(self.queue_link, 0, QtCore.Qt.AlignLeft)
        self.preview_hint = QtWidgets.QLabel("")
        self.preview_hint.setObjectName("muted")
        self.preview_hint.setWordWrap(True)
        self.preview_hint.setTextFormat(QtCore.Qt.PlainText)
        layout.addWidget(self.preview_hint)
        self._paint(None)

    def _preview(self, kind: str) -> None:
        if self._on_preview is None:
            return
        refused = self._on_preview(kind)
        self.preview_hint.setText(PREVIEW_REFUSALS.get(refused, PREVIEW_UNAVAILABLE) if refused else self._preview_note())

    def _preview_note(self) -> str:
        off = self._prefs is not None and not getattr(self._prefs, "enabled", False)
        return "Check-ins are off; this is only a preview" if off else "Previews do not save a build or contact the server. Dragging remembers the card position."

    def _reset_positions(self) -> None:
        if self._on_reset_positions is not None:
            self._on_reset_positions()
            self.positions_status.setText("Positions reset")
            self._position_feedback.start()

    # ------------------------------------------------------ host in

    def controller_bound(self) -> None:
        """The boot worker attached the controller."""
        if self._prefs is None:
            self._paint(None)

    def apply_prefs(self, prefs: Any) -> None:
        """The preference the controller now holds (GUI thread)."""
        if (
            self._expected is not None
            and prefs != self._expected
            and self._clock() - self._changed_at < REVERT_WINDOW_SEC
        ):
            self._expected = None
            self._prefs = prefs
            self._paint(HINT_SAVE_FAILED)
            return
        self._prefs = prefs
        self._paint(None)

    # ------------------------------------------------------ state

    @property
    def state(self) -> str:
        """``no_live`` | ``connecting`` | ``loading`` | ``unsupported`` |
        ``ready`` (for tests and the hint)."""
        if not self._available:
            return "no_live"
        controller = self._controller()
        if controller is None:
            return "connecting"
        if getattr(controller, "available", None) is False:
            return "unsupported"
        if self._prefs is None:
            return "loading"
        return "ready"

    def _paint(self, override_hint: Optional[str]) -> None:
        state = self.state
        ready = state == "ready"
        prefs = self._prefs
        for box, value in (
            (self.enabled_box, getattr(prefs, "enabled", False)),
            (self.loading_box, getattr(prefs, "ask_at_loading", False)),
            (self.after_box, getattr(prefs, "ask_after_game", False)),
            (self.scouting_box, getattr(self._controller(), "scouting_enabled", False)),
        ):
            box.blockSignals(True)
            box.setChecked(bool(value))
            box.blockSignals(False)
        self.enabled_box.setEnabled(ready)
        children_enabled = ready and self.enabled_box.isChecked()
        self.loading_box.setEnabled(children_enabled)
        self.after_box.setEnabled(children_enabled)
        self.scouting_box.setEnabled(children_enabled)
        hint = override_hint or {
            "no_live": HINT_NO_LIVE,
            "connecting": HINT_CONNECTING,
            "loading": HINT_LOADING,
            "unsupported": HINT_UNSUPPORTED,
            "ready": HINT_READY,
        }[state]
        self.hint.setText(hint)
        self.preview_hint.setText(self._preview_note())

    # ------------------------------------------------------ player out

    def _changed(self, **change: bool) -> None:
        controller = self._controller()
        if controller is None or self._prefs is None:
            self._paint(None)
            return
        self._expected = replace(self._prefs, **change)
        self._changed_at = self._clock()
        children_enabled = self.enabled_box.isChecked()
        self.loading_box.setEnabled(children_enabled)
        self.after_box.setEnabled(children_enabled)
        self.scouting_box.setEnabled(children_enabled)
        self.hint.setText(HINT_READY)
        controller.set_prefs(**change)

    def _scouting_changed(self, checked: bool) -> None:
        controller = self._controller()
        if controller is not None:
            change = getattr(controller, "set_scouting_enabled", None)
            if callable(change):
                change(bool(checked))

    # ------------------------------------------------------ retries

    def showEvent(self, event: Any) -> None:  # noqa: N802 — Qt API
        super().showEvent(event)
        self.refresh()

    def refresh(self) -> None:
        """Retry a preference that never loaded (offline at boot), and
        notice a server without build check-in."""
        controller = self._controller()
        if controller is None or self._prefs is not None:
            self._paint(None)
            return
        if getattr(controller, "available", None) is not False:
            refresh = getattr(controller, "refresh_prefs", None)
            if callable(refresh):
                refresh()
            QtCore.QTimer.singleShot(RECHECK_MS, self, self._recheck)
        self._paint(None)

    def _recheck(self) -> None:
        if self._prefs is None:
            self._paint(None)


__all__ = [
    "CheckinSettingsGroup",
    "HINT_CONNECTING",
    "HINT_LOADING",
    "HINT_NO_LIVE",
    "HINT_READY",
    "HINT_SAVE_FAILED",
    "HINT_UNSUPPORTED",
    "PREVIEW_ASSISTANCE_OFF",
    "PREVIEW_CARD_OPEN",
    "PREVIEW_CONNECTING",
    "PREVIEW_REFUSALS",
    "PREVIEW_UNAVAILABLE",
    "PREVIEW_UNPAIRED",
]
