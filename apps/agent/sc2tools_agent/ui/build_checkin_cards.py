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
  the window it took focus from is SC2, focus goes back to SC2 — except
  when **Add new build…** just opened the browser, which keeps it. Once
  the replay is in it also carries the compact "Opponent's build: X ·
  Change" row, an accordion that swaps the build list for the
  opponent's.

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

from ..build_checkin.models import (
    CHECKING_REPLAY,
    DETECTED_LABEL,
    OPPONENT_ROW,
    OPPONENT_UNKNOWN,
    LoadingCardModel,
    OpponentRowModel,
    PostgameCardModel,
    opponent_change,
)
from ..build_checkin.view import HIDE_OPENED_WEB
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
from .private_scouting import OpponentNoteEditor, ScoutingStrip

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
        self.is_preview = False
        self.preview_chip = plain_label("Preview - nothing is saved", "checkinMuted")
        self.preview_chip.setAccessibleName("Preview - nothing is saved")
        self.preview_chip.hide()
        self._preview_timer = QtCore.QTimer(self)
        self._preview_timer.setSingleShot(True)
        self._preview_timer.setInterval(90_000)
        self._preview_timer.timeout.connect(self._dismiss_preview)
        self._preview_escape = None

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
        self._preview_timer.stop()
        if self._preview_escape is not None:
            self._preview_escape.setEnabled(False)
        self._identity = None
        self.hide()

    def shutdown(self) -> None:
        # Avoid the postgame foreground restore while the application exits.
        CardWindow.dismiss(self, "shutdown")

    def _set_preview(self, preview: bool) -> None:
        self.is_preview = preview
        self.preview_chip.setVisible(preview)
        if preview and self._preview_escape is None:
            self._preview_escape = QtGui.QShortcut(QtGui.QKeySequence(QtCore.Qt.Key_Escape), self)
            self._preview_escape.setContext(QtCore.Qt.ApplicationShortcut)
            self._preview_escape.activated.connect(self._dismiss_preview)
        if self._preview_escape is not None:
            self._preview_escape.setEnabled(preview)
        real_escape = getattr(self, "_real_escape", None)
        if real_escape is not None:
            real_escape.setEnabled(not preview)
        self._preview_timer.stop()
        if preview:
            self._preview_timer.start()

    def _dismiss_preview(self) -> None:
        if self.is_preview:
            self.dismiss("preview_closed")

    def reset_position(self) -> None:
        if self.isVisible():
            self._place()

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
        if self.is_preview:
            if action not in {"interacted", "update_draft", "update_opponent_note"}:
                self._dismiss_preview()
            return
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
        layout.addWidget(self.preview_chip)

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
        self.scouting = ScoutingStrip()
        self.scouting.open_requested.connect(lambda: self._act("open_scouting_dossier", self.model.game_key) if self.model else None)
        layout.addWidget(self.scouting)
        self.scouting.hide()

    # ---------------------------------------------------- controller in

    def show_model(self, model: LoadingCardModel, *, preview: bool = False) -> None:
        self._set_preview(preview)
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
        self.scouting.set_model(model.scouting)
        self.scouting.setVisible(model.scouting is not None)
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
        self.not_now.setText("Close" if model.scouting_only else "Not now")
        self.dont_ask.setVisible(not model.scouting_only)
        if model.scouting_only:
            for widget in (self.intro, self.waiting, self.strip, self.builds, self.loading, self.empty, self.status):
                widget.hide()
            return
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
            # Re-picking after **Change**: the standing pick is marked.
            self.builds.set_rows(
                model.featured, model.more,
                reason_key=model.locked_key if model.changing else None,
                reason_label=model.current_pick_label if model.changing else None,
            )
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
        self.not_now.setToolTip(model.not_now_tip)

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
            self._act("dismiss_scouting" if self.model.scouting_only else "not_now", self.model.game_key)


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
        self._opp_open = False
        """The opponent accordion replaces the build list."""
        self._opp_touched = False
        """The player changed the opponent row (this showing or a draft)."""
        self._applying = False
        self._reason: Optional[tuple] = None
        self._planned: Optional[str] = None
        """The model's own selection from the last untouched render."""
        self._last_interaction = 0.0

        layout = QtWidgets.QVBoxLayout(self.card)
        layout.setContentsMargins(16, 14, 16, 14)
        layout.setSpacing(8)
        layout.addWidget(self.preview_chip)

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

        # ---- "Opponent's build: X · changed · Change" ----
        self.opp_row = QtWidgets.QWidget()
        opp_row = QtWidgets.QHBoxLayout(self.opp_row)
        opp_row.setContentsMargins(0, 0, 0, 0)
        opp_row.setSpacing(6)
        self.opp_label = plain_label("", "checkinOpponent", wrap=True)
        opp_row.addWidget(self.opp_label, 1)
        self.opp_changed = plain_label("", "checkinChanged")
        opp_row.addWidget(self.opp_changed, 0, QtCore.Qt.AlignTop)
        self.opp_change = link("Change")
        self.opp_change.clicked.connect(self._toggle_opponent)
        opp_row.addWidget(self.opp_change, 0, QtCore.Qt.AlignTop)
        layout.addWidget(self.opp_row)

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
        self.add_build = link("")
        self.add_build.clicked.connect(lambda: self._add_build("you"))
        picker.addWidget(self.add_build)
        layout.addWidget(self.picker)

        # ---- the opponent's list (accordion) ----
        self.opp_picker = QtWidgets.QWidget()
        opp_picker = QtWidgets.QVBoxLayout(self.opp_picker)
        opp_picker.setContentsMargins(0, 0, 0, 0)
        opp_picker.setSpacing(6)
        defaults = OpponentRowModel(label="", name="")
        self.opp_builds = BuildList(
            selectable=True, searchable=True, focusable=True,
            featured_title=defaults.featured_title,
            more_title=defaults.more_title,
            more_toggle=defaults.more_toggle,
            search_placeholder=defaults.search_placeholder,
            no_match=defaults.no_match,
        )
        self.opp_builds.setAccessibleName("Opponent's build")
        self.opp_builds.picked.connect(self._opp_picked)
        self.opp_builds.searched.connect(self._searched)
        self.opp_builds.expanded.connect(self._expanded)
        opp_picker.addWidget(self.opp_builds)
        self.opp_loading = plain_label("Loading builds…", "checkinMuted")
        opp_picker.addWidget(self.opp_loading)
        self.opp_empty = plain_label(defaults.empty, "checkinMuted", wrap=True)
        opp_picker.addWidget(self.opp_empty)
        opp_footer = QtWidgets.QHBoxLayout()
        opp_footer.setContentsMargins(0, 0, 0, 0)
        opp_footer.setSpacing(8)
        self.opp_add = link("")
        self.opp_add.clicked.connect(lambda: self._add_build("opponent"))
        opp_footer.addWidget(self.opp_add)
        opp_footer.addStretch(1)
        self.opp_use_replay = link(defaults.use_replay_label)
        self.opp_use_replay.clicked.connect(self._use_replay_label)
        opp_footer.addWidget(self.opp_use_replay)
        opp_picker.addLayout(opp_footer)
        layout.addWidget(self.opp_picker)
        self.opp_picker.hide()

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
        self.opponent_note = OpponentNoteEditor()
        self.opponent_note.edited.connect(lambda note: self._act("update_opponent_note", self.card_id, note))
        self.opponent_note.save_requested.connect(lambda note: self._act("save_opponent_note", self.card_id, note))
        self.opponent_note.expanded.connect(self._private_note_expanded)
        layout.addWidget(self.opponent_note)

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
        self._real_escape = QtGui.QShortcut(QtGui.QKeySequence(QtCore.Qt.Key_Escape), self)
        self._real_escape.activated.connect(self._escape)

    # ---------------------------------------------------- controller in

    def show_model(self, model: PostgameCardModel, *, preview: bool = False) -> None:
        self._set_preview(preview)
        fresh = model.card_id != self._identity or not self.isVisible()
        if model.card_id != self._identity:
            self.builds.reset()
            self.opp_builds.reset()
            self._reason = None
            self._changing = False
        if fresh:
            self._touched = False
            self._opp_open = False
            self._opp_touched = model.opponent is not None and model.opponent.touched
        self._identity = model.card_id
        self._render(
            model,
            apply_draft=fresh or not (model.touched or self._touched),
            opponent_draft=fresh or not self._opp_touched,
        )
        self._present()

    def update_model(self, model: PostgameCardModel) -> None:
        self._render(model, apply_draft=not (model.touched or self._touched))
        self.settle()

    def dismiss(self, reason: str = "") -> None:
        if reason != HIDE_OPENED_WEB:
            # The browser just opened from this card should keep focus.
            win32_window.restore_foreground(self.native_handle(), self._previous_foreground)
        super().dismiss(reason)

    def _tick(self) -> None:
        super()._tick()
        if self.isVisible() and not self.isActiveWindow():
            # The window the player was in before clicking into the card.
            foreground = self._foreign_foreground()
            if foreground is not None:
                self._previous_foreground = foreground

    def _render(
        self,
        model: PostgameCardModel,
        *,
        apply_draft: bool,
        opponent_draft: Optional[bool] = None,
    ) -> None:
        self.model = model
        self._applying = True
        try:
            self._render_picker(model, apply_draft=apply_draft)
            self._render_opponent(
                model,
                apply_draft=(
                    not self._opp_touched if opponent_draft is None else opponent_draft
                ),
            )
            self._render_header(model)
            self.opponent_note.set_model(model)
            if self.opponent_note.toggle.isChecked():
                self.picker.hide()
                self.opp_picker.hide()
            if apply_draft and self.notes.toPlainText() != model.notes:
                self.notes.setPlainText(model.notes)
            self.notes.setPlaceholderText(model.notes_placeholder)
            self._render_counter()
            self._render_actions(model)
        finally:
            self._applying = False

    def _private_note_expanded(self, opened: bool) -> None:
        self._interacted()
        if opened:
            self.picker.hide()
            self.opp_picker.hide()
        elif self.model is not None:
            self._render_picker(self.model, apply_draft=False)
            self._render_opponent(self.model, apply_draft=False)
        self.settle()

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
        show_picker = (
            model.variant != NOTES_FIRST_VARIANT or self._changing
        ) and not (self._opp_open and model.opponent is not None)
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
        self._render_add_link(self.add_build, model)

    def _render_add_link(self, widget: QtWidgets.QPushButton, model: PostgameCardModel) -> None:
        widget.setText(model.add_build_label)
        widget.setEnabled(model.can_add_build and not model.busy)
        # Disabled until the replay is in; the tooltip says why.
        widget.setToolTip(model.add_build_hint)
        widget.setAccessibleDescription(model.add_build_hint)

    def _render_opponent(self, model: PostgameCardModel, *, apply_draft: bool) -> None:
        opp = model.opponent
        self.opp_row.setVisible(opp is not None)
        if opp is None:
            self._opp_open = False
            self.opp_picker.setVisible(False)
            return
        if opp.featured or opp.more:
            self.opp_builds.set_rows(opp.featured, opp.more)
        if apply_draft:
            self.opp_builds.set_selection(opp.selection)
            self.opp_builds.ensure_visible(opp.selection)
        has_rows = self.opp_builds.has_rows()
        self.opp_picker.setVisible(self._opp_open)
        self.opp_builds.setVisible(has_rows)
        self.opp_loading.setVisible(opp.options_loading and not has_rows)
        self.opp_empty.setVisible(not has_rows and not opp.options_loading)
        self.opp_builds.set_rows_enabled(not model.busy)
        self._render_add_link(self.opp_add, model)
        self.opp_use_replay.setText(opp.use_replay_label)
        self.opp_use_replay.setEnabled(not model.busy)
        self.opp_change.setText("Close" if self._opp_open else "Change")
        self.opp_change.setAccessibleName(
            "Close the opponent's builds" if self._opp_open else "Change the opponent's build",
        )
        self.opp_change.setEnabled(not model.busy)
        self._render_opponent_label(opp)

    def _render_opponent_label(self, opp: OpponentRowModel) -> None:
        """The row's text. A pick the controller has not echoed yet is
        named from the list itself so the row never lags the click."""
        if self._opp_touched:
            key = self.opp_builds.selection()
            row = self.opp_builds.row(key) if key else None
            if row is not None:
                name = row.name
            elif key == opp.replay_key:
                name = opp.replay_name or OPPONENT_UNKNOWN
            else:
                name = opp.name
            changed = opponent_change(
                key,
                server_key=opp.server_key,
                corrected=opp.corrected,
                replay_key=opp.replay_key,
            ) is not None
            show_replay = key != opp.replay_key
            detected = (
                DETECTED_LABEL.format(name=opp.replay_name)
                if show_replay and opp.replay_name and opp.replay_name != name
                else None
            )
            label = OPPONENT_ROW.format(name=name)
        else:
            label, changed, show_replay = opp.label, opp.changed, opp.show_use_replay
            detected = opp.detected_label
        self.opp_label.setText(label)
        self.opp_label.setToolTip(detected or "")
        self.opp_label.setAccessibleName(
            f"{label}, {opp.changed_label}" if changed else label,
        )
        self.opp_label.setAccessibleDescription(detected or "")
        self.opp_changed.setText(f"· {opp.changed_label}")
        self.opp_changed.setVisible(changed)
        self.opp_use_replay.setVisible(show_replay)

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
            self.opponent_note.toggle.setChecked(False)
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

    def opponent_args(self) -> tuple:
        """The opponent row for an action, once the player changed it."""
        if self._opp_touched and self.model is not None and self.model.opponent is not None:
            return (self.opp_builds.selection(),)
        return ()

    def _draft_changed(self) -> None:
        self._touched = True
        self._last_interaction = time.monotonic()
        self._act(
            "update_draft", self.card_id, self.selection(), self.notes_text(),
            *self.opponent_args(),
        )

    def _searched(self, _text: str) -> None:
        self._interacted()
        self.settle()

    def _expanded(self, _open: bool) -> None:
        self._interacted()
        self.settle()

    def _picked(self, _key: str) -> None:
        if self.is_preview:
            self._dismiss_preview()
            return
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
        self._act("confirm", model.card_id, selection, self.notes_text(), *self.opponent_args())

    def _secondary_clicked(self) -> None:
        model = self.model
        if model is None or model.busy:
            return
        if model.variant == NOTES_FIRST_VARIANT:
            self._changing = True
            self._opp_open = False
            self._interacted()
            self._render(model, apply_draft=False)
            self.settle()
            if self.builds.search is not None:
                self.builds.search.setFocus(QtCore.Qt.OtherFocusReason)
            return
        self._act("no_set_build", model.card_id, self.notes_text(), *self.opponent_args())

    def _later(self) -> None:
        model = self.model
        if model is None or model.busy or not self.isVisible():
            return
        self._act("later", model.card_id, self.notes_text())

    def _escape(self) -> None:
        """Esc closes the opponent's list first, then means Later."""
        if self._opp_open and self.model is not None and not self.model.busy:
            self._set_opponent_open(False)
            return
        self._later()

    # ---------------------------------------------------- opponent row

    def _set_opponent_open(self, open_: bool) -> None:
        self._opp_open = open_
        if self.model is not None:
            self._render(self.model, apply_draft=False, opponent_draft=False)
        self.settle()
        if open_ and self.opp_builds.search is not None:
            self.opp_builds.search.setFocus(QtCore.Qt.OtherFocusReason)
        elif not open_ and self.isActiveWindow():
            # Back to the row's trigger, not to whatever follows the
            # list that just closed under the keyboard focus.
            self.opp_change.setFocus(QtCore.Qt.OtherFocusReason)

    def _toggle_opponent(self) -> None:
        self.opponent_note.toggle.setChecked(False)
        if self.model is None or self.model.busy or self.model.opponent is None:
            return
        self._interacted()
        self._set_opponent_open(not self._opp_open)

    def _opp_picked(self, _key: str) -> None:
        if self.is_preview:
            self._dismiss_preview()
            return
        if self.card_id is None:
            return
        self._opp_touched = True
        self._set_opponent_open(False)
        self._draft_changed()

    def _use_replay_label(self) -> None:
        model = self.model
        if model is None or model.busy or model.opponent is None:
            return
        self.opp_builds.set_selection(model.opponent.replay_key)
        self._opp_picked(model.opponent.replay_key or "")

    def _add_build(self, side: str) -> None:
        model = self.model
        if model is None or model.busy or not model.can_add_build:
            return
        self._act("add_build", model.card_id, side)


__all__ = [
    "CardWindow",
    "LOADING_FLAGS",
    "LoadingCardWindow",
    "POSTGAME_FLAGS",
    "PostgameCardWindow",
    "truncate_utf16",
    "utf16_length",
]
