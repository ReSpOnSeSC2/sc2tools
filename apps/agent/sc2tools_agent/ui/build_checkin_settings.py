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
HINT_READY = "Saved to your sc2tools.com account. Changes apply right away."
HINT_SAVE_FAILED = "Couldn't save that change. Check your connection and try again."

INTRO = (
    "Tell sc2tools which build you were going for. A game where the plan "
    "went sideways still counts toward that build's record."
)

REVERT_WINDOW_SEC = 15.0
"""A different value arriving this soon after a click is a failed save."""
RECHECK_MS = 4000


class CheckinSettingsGroup(QtWidgets.QFrame):
    """The Settings card. ``controller()`` returns the bound controller
    or ``None``; ``available`` is ``False`` under ``--no-live``."""

    def __init__(
        self,
        *,
        controller: Callable[[], Optional[Any]],
        available: bool,
        clock: Callable[[], float] = time.monotonic,
        parent: Optional[QtWidgets.QWidget] = None,
    ) -> None:
        super().__init__(parent)
        self.setObjectName("card")
        self._controller = controller
        self._available = bool(available)
        self._clock = clock
        self._prefs: Optional[Any] = None
        self._expected: Optional[Any] = None
        self._changed_at = 0.0

        layout = QtWidgets.QVBoxLayout(self)
        layout.setContentsMargins(20, 18, 20, 18)
        layout.setSpacing(10)

        title = QtWidgets.QLabel("Build check-in")
        title.setObjectName("h2")
        layout.addWidget(title)
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
        self.after_box.setToolTip(
            "A card after the match: confirm the build you went for and "
            "note what threw it off.",
        )
        layout.addWidget(self.enabled_box)
        for box in (self.loading_box, self.after_box):
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

        self._paint(None)

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
            (self.enabled_box, getattr(prefs, "enabled", True)),
            (self.loading_box, getattr(prefs, "ask_at_loading", True)),
            (self.after_box, getattr(prefs, "ask_after_game", True)),
        ):
            box.blockSignals(True)
            box.setChecked(bool(value))
            box.blockSignals(False)
        self.enabled_box.setEnabled(ready)
        children_enabled = ready and self.enabled_box.isChecked()
        self.loading_box.setEnabled(children_enabled)
        self.after_box.setEnabled(children_enabled)
        hint = override_hint or {
            "no_live": HINT_NO_LIVE,
            "connecting": HINT_CONNECTING,
            "loading": HINT_LOADING,
            "unsupported": HINT_UNSUPPORTED,
            "ready": HINT_READY,
        }[state]
        self.hint.setText(hint)

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
        self.hint.setText(HINT_READY)
        controller.set_prefs(**change)

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
]
