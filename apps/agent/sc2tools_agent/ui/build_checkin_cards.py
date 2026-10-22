"""The two build check-in card windows.

Both are parentless top-level windows (a window owned by the main
window would vanish when it is minimised to the tray), frameless and
always on top, with a translucent background around a rounded
``QFrame#card``. Their window flags are set once in ``__init__`` and
never changed: ``setWindowFlags`` on a live window re-creates the native
window and can activate it over the game.

* :class:`LoadingCardWindow` — "What's the plan?". Never takes focus
  (``WindowDoesNotAcceptFocus`` + ``WA_ShowWithoutActivating``) and has
  no text input, so clicking it never pulls focus from StarCraft II.
* :class:`PostgameCardWindow` — "Which build were you going for?". Shows
  without activating but can take focus once the player clicks into it
  (search, notes). When it closes while it is the foreground window and
  the window it took focus from is SC2, focus goes back to SC2.

On Windows each card is excluded from screen capture and re-asserts
topmost once a second while visible (``win32_window``). Placement: the
dragged position when it is still on a screen, else the right edge of
the screen SC2 is on (primary screen as fallback), ~12 % from the top.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Optional

from PySide6 import QtCore, QtGui, QtWidgets

from ..build_checkin.models import CHECKING_REPLAY, LoadingCardModel, PostgameCardModel
from . import win32_window
from .build_checkin_widgets import (
    BuildList,
    button,
    card_stylesheet,
    link,
    plain_label,
    set_tone,
)
from .build_checkin_window import (
    LOADING,
    POSTGAME,
    clamp_card_position,
    default_card_position,
    match_screen,
    rect_of,
    screen_rects,
)

log = logging.getLogger(__name__)

TOPMOST_INTERVAL_MS = 1000
LAYOUT_DEPTH = 5
"""Nesting depth of the card layouts (window → card → section → list)."""
INTERACTION_THROTTLE_SEC = 1.0
NOTES_WARN_AT = 0.9
"""Share of the notes limit at which the counter turns amber."""

LOADING_FLAGS = (
    QtCore.Qt.Tool
    | QtCore.Qt.WindowStaysOnTopHint
    | QtCore.Qt.FramelessWindowHint
    | QtCore.Qt.WindowDoesNotAcceptFocus
)
POSTGAME_FLAGS = (
    QtCore.Qt.Tool
    | QtCore.Qt.WindowStaysOnTopHint
    | QtCore.Qt.FramelessWindowHint
)

FULL_VARIANT = "full"
NOTES_FIRST_VARIANT = "notes_first"


def utf16_length(text: str) -> int:
    """Length as the API counts it (JavaScript strings are UTF-16)."""
    return len(text.encode("utf-16-le")) // 2


def truncate_utf16(text: str, limit: int) -> str:
    """``text`` cut to ``limit`` UTF-16 units, never inside a character."""
    if utf16_length(text) <= limit:
        return text
    used = 0
    for index, char in enumerate(text):
        used += 2 if ord(char) > 0xFFFF else 1
        if used > limit:
            return text[:index]
    return text


class CardWindow(QtWidgets.QWidget):
    """Shared chrome: flags, translucent rounded card, drag, placement,
    capture exclusion and the topmost timer."""

    KIND = ""
    WIDTH = 320
    FLAGS = LOADING_FLAGS

    def __init__(self, *, host: Any) -> None:
        super().__init__(None, self.FLAGS)
        self._host = host
        self._identity: Optional[str] = None
        self._native_ready = False
        self._drag_offset: Optional[QtCore.QPoint] = None
        self._dragged = False
        self._previous_foreground: Optional[int] = None

        self.setObjectName("checkinWindow")
        self.setWindowTitle("Build check-in")
        self.setAccessibleName("Build check-in")
        self.setAttribute(QtCore.Qt.WA_ShowWithoutActivating, True)
        self.setAttribute(QtCore.Qt.WA_TranslucentBackground, True)
        self.setAttribute(QtCore.Qt.WA_AlwaysShowToolTips, True)
        self.setStyleSheet(card_stylesheet())

        outer = QtWidgets.QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSizeConstraint(QtWidgets.QLayout.SetFixedSize)
        self.card = QtWidgets.QFrame()
        self.card.setObjectName("card")
        self.card.setFixedWidth(self.WIDTH)
        outer.addWidget(self.card)

        self._topmost_timer = QtCore.QTimer(self)
        self._topmost_timer.setInterval(TOPMOST_INTERVAL_MS)
        self._topmost_timer.timeout.connect(self._tick)

    # ------------------------------------------------------ identity

    def owns(self, identity: Optional[str]) -> bool:
        """This window currently paints ``identity`` and is up."""
        return identity is not None and identity == self._identity and self.isVisible()

    @property
    def identity(self) -> Optional[str]:
        return self._identity

    # ------------------------------------------------------ showing

    def settle(self) -> None:
        """Apply a content change to the window size now.

        Each nested layout passes a size change up one level per posted
        ``LayoutRequest``; flushing them keeps the fixed-size window in
        step with what the model just showed or hid.
        """
        for _ in range(LAYOUT_DEPTH):
            QtCore.QCoreApplication.sendPostedEvents(None, QtCore.QEvent.LayoutRequest)
        self.layout().activate()

    def _present(self) -> None:
        """Show (without activating) at the right spot."""
        self._ensure_native()
        was_visible = self.isVisible()
        self.settle()
        if not was_visible:
            self._place()
            self._previous_foreground = self._foreign_foreground()
        self.show()
        self._topmost_timer.start()
        win32_window.keep_topmost(self.native_handle())

    def dismiss(self, reason: str = "") -> None:
        """Hide the card (the controller decided it is done)."""
        del reason
        self._topmost_timer.stop()
        self._identity = None
        self.hide()

    def shutdown(self) -> None:
        self._topmost_timer.stop()
        self._identity = None
        self.hide()

    def _ensure_native(self) -> None:
        if self._native_ready:
            return
        self._native_ready = True
        # Creates the native window (flags and attributes are final by
        # now) so capture exclusion is in place before the first paint.
        self.winId()
        if win32_window.exclude_from_capture(self.native_handle()) is None:
            log.debug("build_checkin_capture_exclusion_unavailable kind=%s", self.KIND)

    def native_handle(self) -> Optional[int]:
        if not self._native_ready:
            return None
        try:
            return int(self.winId()) or None
        except (TypeError, ValueError, RuntimeError):
            return None

    def _foreign_foreground(self) -> Optional[int]:
        foreground = win32_window.foreground_window()
        return foreground if foreground and foreground != self.native_handle() else None

    def _tick(self) -> None:
        if not self.isVisible():
            self._topmost_timer.stop()
            return
        win32_window.keep_topmost(self.native_handle())

    # ------------------------------------------------------ placement

    def _target_screen(self) -> Optional[QtGui.QScreen]:
        screens = QtGui.QGuiApplication.screens()
        sc2 = win32_window.find_sc2_window()
        if sc2 is not None:
            monitor = win32_window.monitor_of_window(sc2)
            if monitor is not None:
                screen = match_screen(screens, monitor.device, monitor.bounds)
                if screen is not None:
                    return screen
        return QtGui.QGuiApplication.primaryScreen()

    def _place(self) -> None:
        size = (self.width(), self.height())
        saved = self._host.saved_position(self.KIND)
        if saved is not None:
            point = clamp_card_position(saved, size, screen_rects(QtGui.QGuiApplication.screens()))
            if point is not None:
                self.move(*point)
                return
        screen = self._target_screen()
        if screen is None:
            return
        handle = self.windowHandle()
        if handle is not None and handle.screen() is not screen:
            handle.setScreen(screen)
        self.move(*default_card_position(
            rect_of(screen.availableGeometry()), rect_of(screen.geometry()), size,
        ))

    # ------------------------------------------------------ dragging

    def make_drag_handle(self, widget: QtWidgets.QWidget) -> None:
        widget.setCursor(QtCore.Qt.OpenHandCursor)
        widget.installEventFilter(self)

    def eventFilter(self, watched: QtCore.QObject, event: QtCore.QEvent) -> bool:  # noqa: N802
        kind = event.type()
        if kind == QtCore.QEvent.MouseButtonPress and event.button() == QtCore.Qt.LeftButton:
            self._drag_offset = event.globalPosition().toPoint() - self.pos()
            self._dragged = False
            return True
        if (
            kind == QtCore.QEvent.MouseMove
            and self._drag_offset is not None
            and event.buttons() & QtCore.Qt.LeftButton
        ):
            self.move(event.globalPosition().toPoint() - self._drag_offset)
            self._dragged = True
            return True
        if kind == QtCore.QEvent.MouseButtonRelease and self._drag_offset is not None:
            self._drag_offset = None
            if self._dragged:
                self._dragged = False
                self._host.remember_position(self.KIND, self.x(), self.y())
            return True
        return super().eventFilter(watched, event)

    # ------------------------------------------------------ helpers

    def _act(self, action: str, *args: Any) -> None:
        self._host.act(action, *args)


def _header(
    eyebrow: QtWidgets.QLabel,
    title_row: QtWidgets.QWidget,
) -> QtWidgets.QWidget:
    header = QtWidgets.QWidget()
    row = QtWidgets.QHBoxLayout(header)
    row.setContentsMargins(0, 0, 0, 0)
    row.setSpacing(8)
    column = QtWidgets.QVBoxLayout()
    column.setContentsMargins(0, 0, 0, 0)
    column.setSpacing(2)
    column.addWidget(eyebrow)
    column.addWidget(title_row)
    row.addLayout(column, 1)
    grip = plain_label("⋮⋮", "checkinGrip")
    grip.setToolTip("Drag to move")
    grip.setAccessibleName("Drag to move the card")
    row.addWidget(grip, 0, QtCore.Qt.AlignTop)
    return header


def _intro_box(text_label: QtWidgets.QLabel, dismiss: QtWidgets.QPushButton) -> QtWidgets.QFrame:
    box = QtWidgets.QFrame()
    box.setObjectName("checkinIntroBox")
    row = QtWidgets.QHBoxLayout(box)
    row.setContentsMargins(10, 7, 10, 7)
    row.setSpacing(8)
    row.addWidget(text_label, 1)
    row.addWidget(dismiss, 0, QtCore.Qt.AlignTop)
    return box


def _busy_bar() -> QtWidgets.QProgressBar:
    bar = QtWidgets.QProgressBar()
    bar.setObjectName("checkinBusy")
    bar.setRange(0, 0)
    bar.setTextVisible(False)
    bar.setAccessibleName("Loading")
    return bar


class LoadingCardWindow(CardWindow):
    """"What's the plan?" — the loading-screen card. Mouse only."""

    KIND = LOADING
    WIDTH = 320
    FLAGS = LOADING_FLAGS

    def __init__(self, *, host: Any) -> None:
        super().__init__(host=host)
        self.model: Optional[LoadingCardModel] = None

        layout = QtWidgets.QVBoxLayout(self.card)
        layout.setContentsMargins(14, 12, 14, 12)
        layout.setSpacing(0)

        # ---- full card ----
        self.full = QtWidgets.QWidget()
        full = QtWidgets.QVBoxLayout(self.full)
        full.setContentsMargins(0, 0, 0, 0)
        full.setSpacing(8)

        self.eyebrow = plain_label("", "checkinEyebrow")
        self.title = plain_label("", "checkinTitle", wrap=True)
        self.header = _header(self.eyebrow, self.title)
        self.make_drag_handle(self.header)
        full.addWidget(self.header)

        self.intro_text = plain_label("", "checkinIntro", wrap=True)
        self.intro_dismiss = link("Got it", focusable=False)
        self.intro_dismiss.clicked.connect(lambda: self._act("dismiss_intro"))
        self.intro = _intro_box(self.intro_text, self.intro_dismiss)
        full.addWidget(self.intro)

        self.waiting = plain_label("", "checkinMuted", wrap=True)
        full.addWidget(self.waiting)

        self.strip = QtWidgets.QFrame()
        self.strip.setObjectName("checkinStrip")
        strip_row = QtWidgets.QHBoxLayout(self.strip)
        strip_row.setContentsMargins(10, 6, 6, 6)
        strip_row.setSpacing(8)
        self.strip_label = plain_label("", None, wrap=True)
        strip_row.addWidget(self.strip_label, 1)
        self.roll_now = button("Roll now", "checkinSmall", focusable=False)
        self.roll_now.setToolTip("Let the randomizer spin now")
        self.roll_now.clicked.connect(self._roll_now)
        strip_row.addWidget(self.roll_now, 0, QtCore.Qt.AlignVCenter)
        full.addWidget(self.strip)

        self.builds = BuildList(selectable=False, searchable=False, focusable=False)
        self.builds.picked.connect(self._declare)
        self.builds.expanded.connect(lambda _open: self.settle())
        full.addWidget(self.builds)

        self.loading = plain_label("Loading your builds…", "checkinMuted")
        full.addWidget(self.loading)
        self.empty = plain_label("No builds to pick for this matchup yet.", "checkinMuted", wrap=True)
        full.addWidget(self.empty)
        self.status = plain_label("", "checkinStatus", wrap=True)
        full.addWidget(self.status)

        footer = QtWidgets.QHBoxLayout()
        footer.setContentsMargins(0, 2, 0, 0)
        footer.setSpacing(8)
        self.not_now = button("Not now", "checkinQuiet", focusable=False)
        self.not_now.setToolTip("Skip this game's check-in at loading")
        self.not_now.clicked.connect(self._not_now)
        footer.addWidget(self.not_now)
        footer.addStretch(1)
        self.dont_ask = link("Don't ask at loading", focusable=False)
        self.dont_ask.setToolTip("Stop showing this card during loading screens")
        self.dont_ask.clicked.connect(lambda: self._act("disable", "loading"))
        footer.addWidget(self.dont_ask)
        full.addLayout(footer)
        layout.addWidget(self.full)

        # ---- slim "Locked in" bar ----
        self.bar = QtWidgets.QWidget()
        bar = QtWidgets.QVBoxLayout(self.bar)
        bar.setContentsMargins(0, 0, 0, 0)
        bar.setSpacing(4)
        bar_row = QtWidgets.QHBoxLayout()
        bar_row.setContentsMargins(0, 0, 0, 0)
        bar_row.setSpacing(6)
        self.locked = plain_label("", "checkinLocked")
        self.locked.setSizePolicy(QtWidgets.QSizePolicy.Ignored, QtWidgets.QSizePolicy.Preferred)
        bar_row.addWidget(self.locked, 1)
        self.saving = plain_label("Saving…", "checkinMuted")
        bar_row.addWidget(self.saving)
        self.change = link("Change", focusable=False)
        self.change.setToolTip("Pick a different build")
        self.change.clicked.connect(self._change)
        bar_row.addWidget(self.change)
        bar.addLayout(bar_row)
        self.bar_status = plain_label("", "checkinStatus", wrap=True)
        bar.addWidget(self.bar_status)
        self.make_drag_handle(self.bar)
        layout.addWidget(self.bar)

        self.bar.hide()

    # ---------------------------------------------------- controller in

    def show_model(self, model: LoadingCardModel) -> None:
        if model.game_key != self._identity:
            self.builds.reset()
        self._identity = model.game_key
        self._render(model)
        self._present()

    def update_model(self, model: LoadingCardModel) -> None:
        self._render(model)
        self.settle()

    def _render(self, model: LoadingCardModel) -> None:
        self.model = model
        collapsed = model.collapsed and bool(model.locked_label)
        self.full.setVisible(not collapsed)
        self.bar.setVisible(collapsed)
        if collapsed:
            self.locked.setText(model.locked_label or "")
            self.locked.setToolTip(model.locked_label or "")
            set_tone(self.locked, "saving", "true" if model.saving else "false")
            self.saving.setVisible(model.saving)
            self.change.setVisible(model.can_change)
            self.bar_status.setText(model.status)
            self.bar_status.setVisible(bool(model.status))
            set_tone(self.bar_status, "tone", "warning")
            return

        self.eyebrow.setText(model.heading.upper())
        self.title.setText(model.title)
        self.title.setVisible(bool(model.title))
        self.intro_text.setText(model.intro_text)
        self.intro.setVisible(model.show_intro)
        self.waiting.setText(model.waiting_label)
        self.waiting.setVisible(model.waiting_for_matchup)

        strip = model.randomizer
        self.strip.setVisible(strip is not None)
        if strip is not None:
            self.strip_label.setText(strip.label)
            self.roll_now.setVisible(strip.can_roll_now)

        has_rows = bool(model.featured or model.more)
        if has_rows:
            self.builds.set_rows(model.featured, model.more)
        self.builds.setVisible(not model.waiting_for_matchup and self.builds.has_rows())
        self.loading.setVisible(model.options_loading and not self.builds.has_rows())
        self.empty.setVisible(
            bool(model.matchup)
            and not model.options_loading
            and not self.builds.has_rows()
            and not model.status
        )
        self.status.setText(model.status)
        self.status.setVisible(bool(model.status))
        set_tone(self.status, "tone", "warning")

    # ---------------------------------------------------- player out

    def _declare(self, key: str) -> None:
        if self.model is not None:
            self._act("declare", self.model.game_key, key)

    def _change(self) -> None:
        if self.model is not None:
            self._act("undeclare", self.model.game_key)

    def _roll_now(self) -> None:
        if self.model is not None:
            self._act("roll_now", self.model.game_key)

    def _not_now(self) -> None:
        if self.model is not None:
            self._act("not_now", self.model.game_key)


class PostgameCardWindow(CardWindow):
    """"Which build were you going for?" — the end-of-game card."""

    KIND = POSTGAME
    WIDTH = 360
    FLAGS = POSTGAME_FLAGS

    def __init__(self, *, host: Any) -> None:
        super().__init__(host=host)
        self.model: Optional[PostgameCardModel] = None
        self._touched = False
        """The player changed the selection or notes in this showing."""
        self._changing = False
        """Notes-first card with the build list opened by Change build."""
        self._applying = False
        self._reason: Optional[tuple] = None
        self._planned: Optional[str] = None
        """The model's own selection from the last untouched render."""
        self._last_interaction = 0.0

        layout = QtWidgets.QVBoxLayout(self.card)
        layout.setContentsMargins(16, 14, 16, 14)
        layout.setSpacing(8)

        self.eyebrow = plain_label("", "checkinEyebrow")
        title_row = QtWidgets.QWidget()
        title = QtWidgets.QHBoxLayout(title_row)
        title.setContentsMargins(0, 0, 0, 0)
        title.setSpacing(0)
        self.result = plain_label("", "checkinResult")
        title.addWidget(self.result)
        self.title = plain_label("", "checkinTitle", wrap=True)
        title.addWidget(self.title, 1)
        self.header = _header(self.eyebrow, title_row)
        self.make_drag_handle(self.header)
        layout.addWidget(self.header)

        self.intro_text = plain_label("", "checkinIntro", wrap=True)
        self.intro_dismiss = link("Got it")
        self.intro_dismiss.clicked.connect(lambda: self._act("dismiss_intro"))
        self.intro = _intro_box(self.intro_text, self.intro_dismiss)
        layout.addWidget(self.intro)

        self.prompt = plain_label("", "checkinPrompt", wrap=True)
        layout.addWidget(self.prompt)
        self.detected = plain_label("", "checkinMuted", wrap=True)
        layout.addWidget(self.detected)

        self.status = plain_label("", "checkinStatus", wrap=True)
        layout.addWidget(self.status)
        self.busy_bar = _busy_bar()
        layout.addWidget(self.busy_bar)

        self.picker = QtWidgets.QWidget()
        picker = QtWidgets.QVBoxLayout(self.picker)
        picker.setContentsMargins(0, 0, 0, 0)
        picker.setSpacing(6)
        self.builds = BuildList(selectable=True, searchable=True, focusable=True)
        self.builds.picked.connect(self._picked)
        self.builds.searched.connect(self._searched)
        self.builds.expanded.connect(self._expanded)
        picker.addWidget(self.builds)
        self.loading = plain_label("Loading builds…", "checkinMuted")
        picker.addWidget(self.loading)
        self.empty = plain_label("", "checkinMuted", wrap=True)
        picker.addWidget(self.empty)
        layout.addWidget(self.picker)

        self.notes = QtWidgets.QPlainTextEdit()
        self.notes.setObjectName("checkinNotes")
        self.notes.setAccessibleName("Notes")
        self.notes.setTabChangesFocus(True)
        self.notes.setFixedHeight(66)
        self.notes.textChanged.connect(self._notes_changed)
        layout.addWidget(self.notes)
        self.counter = plain_label("", "checkinCounter")
        self.counter.setAlignment(QtCore.Qt.AlignRight)
        layout.addWidget(self.counter)

        actions = QtWidgets.QHBoxLayout()
        actions.setContentsMargins(0, 2, 0, 0)
        actions.setSpacing(8)
        self.primary = button("Confirm", "checkinPrimary")
        self.primary.setToolTip("Confirm (Ctrl+Enter)")
        self.primary.clicked.connect(self._primary_clicked)
        actions.addWidget(self.primary)
        self.secondary = button("No set build")
        self.secondary.clicked.connect(self._secondary_clicked)
        actions.addWidget(self.secondary)
        actions.addStretch(1)
        self.later = button("Later", "checkinQuiet")
        self.later.setToolTip("Decide later (Esc)")
        self.later.clicked.connect(self._later)
        actions.addWidget(self.later)
        layout.addLayout(actions)

        self.turn_off = link("Turn off check-ins after games")
        self.turn_off.setToolTip("Stop showing this card after games")
        self.turn_off.clicked.connect(lambda: self._act("disable", "postgame"))
        layout.addWidget(self.turn_off)

        for keys in ("Ctrl+Return", "Ctrl+Enter"):
            shortcut = QtGui.QShortcut(QtGui.QKeySequence(keys), self)
            shortcut.activated.connect(self._primary_clicked)
        escape = QtGui.QShortcut(QtGui.QKeySequence(QtCore.Qt.Key_Escape), self)
        escape.activated.connect(self._later)

    # ---------------------------------------------------- controller in

    def show_model(self, model: PostgameCardModel) -> None:
        fresh = model.card_id != self._identity or not self.isVisible()
        if model.card_id != self._identity:
            self.builds.reset()
            self._reason = None
            self._changing = False
        if fresh:
            self._touched = False
        self._identity = model.card_id
        self._render(model, apply_draft=fresh or not (model.touched or self._touched))
        self._present()

    def update_model(self, model: PostgameCardModel) -> None:
        self._render(model, apply_draft=not (model.touched or self._touched))
        self.settle()

    def dismiss(self, reason: str = "") -> None:
        win32_window.restore_foreground(self.native_handle(), self._previous_foreground)
        super().dismiss(reason)

    def _tick(self) -> None:
        super()._tick()
        if self.isVisible() and not self.isActiveWindow():
            # The window the player was in before clicking into the card.
            foreground = self._foreign_foreground()
            if foreground is not None:
                self._previous_foreground = foreground

    def _render(self, model: PostgameCardModel, *, apply_draft: bool) -> None:
        self.model = model
        self._applying = True
        try:
            self._render_picker(model, apply_draft=apply_draft)
            self._render_header(model)
            if apply_draft and self.notes.toPlainText() != model.notes:
                self.notes.setPlainText(model.notes)
            self.notes.setPlaceholderText(model.notes_placeholder)
            self._render_counter()
            self._render_actions(model)
        finally:
            self._applying = False

    def _render_header(self, model: PostgameCardModel) -> None:
        self.eyebrow.setText(model.heading.upper())
        result = model.result or ""
        rest = model.title
        if result and rest.startswith(result):
            rest = rest[len(result):].lstrip(" ·")
            self.result.setText(f"{result} · " if rest else result)
        else:
            self.result.setText("")
        self.result.setVisible(bool(self.result.text()))
        set_tone(self.result, "tone", model.result_tone)
        self.title.setText(rest)
        self.title.setVisible(bool(rest))
        self.intro_text.setText(model.intro_text)
        self.intro.setVisible(model.show_intro)
        notes_first = model.variant == NOTES_FIRST_VARIANT
        self.prompt.setText(model.prompt or "")
        self.prompt.setVisible(notes_first and bool(model.prompt))
        self.detected.setText(model.detected_label or "")
        self.detected.setVisible(bool(model.detected_label) and not notes_first)
        self.status.setText(model.status)
        self.status.setVisible(bool(model.status))
        set_tone(self.status, "tone", "muted" if model.status == CHECKING_REPLAY else "warning")
        self.busy_bar.setVisible(
            model.status == CHECKING_REPLAY or (model.options_loading and not self.builds.has_rows())
        )

    def _render_picker(self, model: PostgameCardModel, *, apply_draft: bool) -> None:
        if not (model.touched or self._touched) and model.reason_label and model.selection:
            self._reason = (model.selection, model.reason_label, model.reason)
        reason_key, reason_label, reason = self._reason or (None, None, None)
        if model.featured or model.more:
            self.builds.set_rows(
                model.featured, model.more,
                reason_key=reason_key, reason_label=reason_label, reason=reason,
            )
        if apply_draft:
            self._planned = model.selection
            self.builds.set_selection(model.selection)
            self.builds.ensure_visible(model.selection)
        show_picker = model.variant != NOTES_FIRST_VARIANT or self._changing
        has_rows = self.builds.has_rows()
        self.picker.setVisible(show_picker)
        self.builds.setVisible(has_rows)
        self.loading.setVisible(model.options_loading and not has_rows)
        if not has_rows and not model.options_loading:
            self.empty.setText(
                "No builds to pick for this matchup yet."
                if model.matchup
                else "Your builds appear once the replay shows the matchup."
            )
            self.empty.setVisible(True)
        else:
            self.empty.setVisible(False)
        self.builds.set_rows_enabled(not model.busy)

    def _render_actions(self, model: PostgameCardModel) -> None:
        notes_first = model.variant == NOTES_FIRST_VARIANT and not self._changing
        busy = model.busy
        if busy:
            self.primary.setText("Saving…")
        else:
            self.primary.setText("Done" if notes_first else "Confirm")
        self.primary.setToolTip(("Done" if notes_first else "Confirm") + " (Ctrl+Enter)")
        self.primary.setEnabled(not busy and self.selection() is not None)
        if model.variant == NOTES_FIRST_VARIANT:
            self.secondary.setText("Change build")
            self.secondary.setVisible(not self._changing)
            self.later.setVisible(False)
        else:
            self.secondary.setText("No set build")
            self.secondary.setVisible(True)
            self.later.setVisible(True)
        self.secondary.setEnabled(not busy)
        self.later.setEnabled(not busy)
        self.notes.setReadOnly(busy)

    def _render_counter(self) -> None:
        limit = self.model.notes_max if self.model is not None else 0
        count = utf16_length(self.notes.toPlainText())
        self.counter.setText(f"{count} / {limit}")
        self.counter.setAccessibleName(f"{count} of {limit} characters")
        if limit and count >= limit:
            tone = "danger"
        elif limit and count >= limit * NOTES_WARN_AT:
            tone = "warning"
        else:
            tone = "muted"
        set_tone(self.counter, "tone", tone)

    # ---------------------------------------------------- player out

    @property
    def card_id(self) -> Optional[str]:
        return self.model.card_id if self.model is not None else None

    def notes_text(self) -> str:
        return self.notes.toPlainText()

    def selection(self) -> Optional[str]:
        """The build an answer would send.

        A notes-first card keeps its planned build even when that build
        is no longer among the options (a deleted custom build).
        """
        picked = self.builds.selection()
        if (
            picked is None
            and self.model is not None
            and self.model.variant == NOTES_FIRST_VARIANT
            and not self._changing
        ):
            return self._planned
        return picked

    def _interacted(self) -> None:
        if self._applying or self.card_id is None:
            return
        now = time.monotonic()
        if now - self._last_interaction >= INTERACTION_THROTTLE_SEC:
            self._last_interaction = now
            self._act("interacted", self.card_id)

    def _draft_changed(self) -> None:
        self._touched = True
        self._last_interaction = time.monotonic()
        self._act("update_draft", self.card_id, self.selection(), self.notes_text())

    def _searched(self, _text: str) -> None:
        self._interacted()
        self.settle()

    def _expanded(self, _open: bool) -> None:
        self._interacted()
        self.settle()

    def _picked(self, _key: str) -> None:
        if self.card_id is None:
            return
        self._draft_changed()
        if self.model is not None:
            self._render_actions(self.model)

    def _notes_changed(self) -> None:
        limit = self.model.notes_max if self.model is not None else 0
        text = self.notes.toPlainText()
        if limit and utf16_length(text) > limit:
            kept = truncate_utf16(text, limit)
            position = min(self.notes.textCursor().position(), utf16_length(kept))
            self.notes.blockSignals(True)
            self.notes.setPlainText(kept)
            self.notes.blockSignals(False)
            cursor = self.notes.textCursor()
            cursor.setPosition(position)
            self.notes.setTextCursor(cursor)
        self._render_counter()
        if not self._applying and self.card_id is not None:
            self._draft_changed()

    def _primary_clicked(self) -> None:
        model = self.model
        if model is None or model.busy or not self.isVisible():
            return
        selection = self.selection()
        if selection is None:
            return
        self._act("confirm", model.card_id, selection, self.notes_text())

    def _secondary_clicked(self) -> None:
        model = self.model
        if model is None or model.busy:
            return
        if model.variant == NOTES_FIRST_VARIANT:
            self._changing = True
            self._interacted()
            self._render(model, apply_draft=False)
            self.settle()
            if self.builds.search is not None:
                self.builds.search.setFocus(QtCore.Qt.OtherFocusReason)
            return
        self._act("no_set_build", model.card_id, self.notes_text())

    def _later(self) -> None:
        model = self.model
        if model is None or model.busy or not self.isVisible():
            return
        self._act("later", model.card_id, self.notes_text())


__all__ = [
    "CardWindow",
    "LOADING_FLAGS",
    "LoadingCardWindow",
    "POSTGAME_FLAGS",
    "PostgameCardWindow",
    "truncate_utf16",
    "utf16_length",
]
