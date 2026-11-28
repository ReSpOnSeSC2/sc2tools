"""The build check-in card chrome and the loading card.

Both cards are parentless top-level windows (a window owned by the main
window would vanish when it is minimised to the tray), frameless and
always on top, with a translucent background around a rounded
``QFrame#card``. Their window flags are set once in ``__init__`` and
never changed: ``setWindowFlags`` on a live window re-creates the native
window and can activate it over the game.

* :class:`CardWindow` is the shared chrome.
* :class:`LoadingCardWindow`, "What's the plan?", never takes focus
  (``WindowDoesNotAcceptFocus`` + ``WA_ShowWithoutActivating``) and has
  no text input, so clicking it never pulls focus from StarCraft II.
  Under a Randomizer pick, or for units drawn without a build, it shows
  the draw as a still (``build_checkin_draw``).
* The end-of-game card is ``build_checkin_postgame.PostgameCardWindow``.

The cards never animate. Every repaint of a see-through window redraws
all of it over the game, so a card paints when its content changes and
otherwise only wakes for the topmost re-assert below
(``tests/test_card_paint_budget.py``).

On Windows each card is excluded from screen capture and re-asserts
topmost once a second while visible (``win32_window``). Placement: the
dragged position when it is still on a screen, else the right edge of
the screen SC2 is on (primary screen as fallback), ~12 % from the top.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from PySide6 import QtCore, QtGui, QtWidgets

from ..build_checkin.models import LoadingCardModel
from . import checkin_theme, theme, win32_window
from .brand_mark import create_brand_mark
from .build_checkin_draw import UNITS_ALONE_LABEL, RandomizerDrawStill
from .build_checkin_widgets import (
    BuildList,
    button,
    link,
    plain_label,
    set_tone,
)
from .build_checkin_window import (
    LOADING,
    clamp_card_position,
    default_card_position,
    match_screen,
    rect_of,
    screen_rects,
)
from .private_scouting import ScoutingStrip

log = logging.getLogger(__name__)

TOPMOST_INTERVAL_MS = 1000
LAYOUT_DEPTH = 5
"""Nesting depth of the card layouts (window → card → section → list)."""

LOADING_FLAGS = (
    QtCore.Qt.Tool
    | QtCore.Qt.WindowStaysOnTopHint
    | QtCore.Qt.FramelessWindowHint
    | QtCore.Qt.WindowDoesNotAcceptFocus
)



class CardWindow(QtWidgets.QWidget):
    """Shared chrome: flags, translucent rounded card, drag, placement,
    capture exclusion and the topmost timer."""

    KIND = ""
    WIDTH = 320
    EXPANDED_WIDTH = 600
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
        self.preview_chip = plain_label("Preview - nothing is saved", "checkinPreview")
        self.preview_chip.setAccessibleName("Preview - nothing is saved")
        self.preview_chip.setSizePolicy(QtWidgets.QSizePolicy.Maximum, QtWidgets.QSizePolicy.Fixed)
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
        self.set_skin("default")

        outer = QtWidgets.QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSizeConstraint(QtWidgets.QLayout.SetFixedSize)
        self.card = QtWidgets.QFrame()
        self.card.setObjectName("card")
        self.card.setFixedWidth(self.WIDTH)
        outer.addWidget(self.card)
        card_layout = QtWidgets.QVBoxLayout(self.card)
        card_layout.setContentsMargins(0, 0, 0, 0)
        self.content_scroll = QtWidgets.QScrollArea()
        self.content_scroll.setWidgetResizable(True)
        self.content_scroll.setFrameShape(QtWidgets.QFrame.NoFrame)
        self.content_scroll.setHorizontalScrollBarPolicy(QtCore.Qt.ScrollBarAlwaysOff)
        self.content_scroll.setFocusPolicy(QtCore.Qt.NoFocus)
        self.content = QtWidgets.QWidget()
        self.content_layout = QtWidgets.QVBoxLayout(self.content)
        self.content_scroll.setWidget(self.content)
        card_layout.addWidget(self.content_scroll)
        self._names_expanded = False

        self._topmost_timer = QtCore.QTimer(self)
        self._topmost_timer.setInterval(TOPMOST_INTERVAL_MS)
        self._topmost_timer.timeout.connect(self._tick)

    def set_skin(self, name: str) -> None:
        if self.property("checkinSkin") == name:
            return
        self.setProperty("checkinSkin", name)
        self.setStyleSheet(checkin_theme.card_stylesheet(theme.SKINS[name]))
        for mark in self.findChildren(QtWidgets.QWidget, "agentBrandMark"):
            mark.set_skin(name)

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
        content_layout = self.content.layout()
        if content_layout is not None:
            width = self.content_scroll.viewport().width()
            height = content_layout.totalHeightForWidth(width)
            if height < 0:
                height = content_layout.sizeHint().height()
            screen = self.screen()
            available_height = screen.availableGeometry().height() - 48 if screen else height
            self.content_scroll.setFixedHeight(min(height, max(1, available_height)))
            self.card.layout().invalidate()
            self.card.layout().activate()
            self.layout().invalidate()
        self.layout().activate()

    def _expand_build_names(self, expanded: bool) -> None:
        """Expand either picker without changing the player's answer."""
        self._names_expanded = expanded
        screen = self.screen() if self.isVisible() else self._target_screen()
        width = self.EXPANDED_WIDTH if expanded else self.WIDTH
        if screen is not None:
            width = min(width, screen.availableGeometry().width() - 48)
        self.card.setFixedWidth(max(1, width))
        for builds in self.findChildren(BuildList):
            if builds.names_toggle.isChecked() != expanded:
                builds.blockSignals(True)
                builds.set_names_expanded(expanded)
                builds.blockSignals(False)
        interacted = getattr(self, "_interacted", None)
        if interacted is not None:
            interacted()
        self.settle()
        # Widening a card already beside the right edge must keep it on screen.
        if self.isVisible() and screen is not None:
            available = screen.availableGeometry()
            self.move(
                min(max(self.x(), available.left()), max(available.left(), available.right() - self.width() + 1)),
                min(max(self.y(), available.top()), max(available.top(), available.bottom() - self.height() + 1)),
            )

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
        if self._names_expanded:
            self.card.setFixedWidth(min(self.EXPANDED_WIDTH, max(1, screen.availableGeometry().width() - 48)))
        self.settle()
        size = (self.width(), self.height())
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


def card_header(
    eyebrow: QtWidgets.QLabel,
    title_row: QtWidgets.QWidget,
) -> QtWidgets.QWidget:
    header = QtWidgets.QWidget()
    row = QtWidgets.QHBoxLayout(header)
    row.setContentsMargins(0, 0, 0, 0)
    row.setSpacing(theme.SPACE_S)
    column = QtWidgets.QVBoxLayout()
    column.setContentsMargins(0, 0, 0, 0)
    column.setSpacing(theme.SPACE_2XS)
    mark = create_brand_mark(QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
    row.addWidget(mark, 0, QtCore.Qt.AlignVCenter)
    column.addWidget(eyebrow)
    column.addWidget(title_row)
    row.addLayout(column, 1)
    grip = plain_label("⋮⋮", "checkinGrip")
    grip.setToolTip("Drag to move")
    grip.setAccessibleName("Drag to move the card")
    row.addWidget(grip, 0, QtCore.Qt.AlignTop)
    return header


def intro_box(text_label: QtWidgets.QLabel, dismiss: QtWidgets.QPushButton) -> QtWidgets.QFrame:
    box = QtWidgets.QFrame()
    box.setObjectName("checkinIntroBox")
    row = QtWidgets.QHBoxLayout(box)
    row.setContentsMargins(theme.SPACE_S, theme.SPACE_XS, theme.SPACE_S, theme.SPACE_XS)
    row.setSpacing(theme.SPACE_S)
    row.addWidget(text_label, 1)
    row.addWidget(dismiss, 0, QtCore.Qt.AlignTop)
    return box


class LoadingCardWindow(CardWindow):
    """"What's the plan?" — the loading-screen card. Mouse only."""

    KIND = LOADING
    WIDTH = 320
    FLAGS = LOADING_FLAGS

    def __init__(self, *, host: Any) -> None:
        super().__init__(host=host)
        self.model: Optional[LoadingCardModel] = None

        layout = self.content_layout
        layout.setContentsMargins(theme.SPACE_M, theme.SPACE_M, theme.SPACE_M, theme.SPACE_M)
        layout.setSpacing(0)
        layout.addWidget(self.preview_chip)

        # ---- full card ----
        self.full = QtWidgets.QWidget()
        full = QtWidgets.QVBoxLayout(self.full)
        full.setContentsMargins(0, 0, 0, 0)
        full.setSpacing(theme.SPACE_S)

        self.eyebrow = plain_label("", "checkinEyebrow")
        self.title = plain_label("", "checkinTitle", wrap=True)
        self.header = card_header(self.eyebrow, self.title)
        self.make_drag_handle(self.header)
        full.addWidget(self.header)

        self.intro_text = plain_label("", "checkinIntro", wrap=True)
        self.intro_dismiss = link("Got it", focusable=False)
        self.intro_dismiss.clicked.connect(lambda: self._act("dismiss_intro"))
        self.intro = intro_box(self.intro_text, self.intro_dismiss)
        full.addWidget(self.intro)

        self.waiting = plain_label("", "checkinMuted", wrap=True)
        full.addWidget(self.waiting)
        self.strip = self._build_strip()
        full.addWidget(self.strip)

        self.builds = BuildList(selectable=False, searchable=False, focusable=False)
        self.builds.picked.connect(self._declare)
        self.builds.expanded.connect(lambda _open: self.settle())
        self.builds.names_expanded.connect(self._expand_build_names)
        full.addWidget(self.builds)

        self.loading = plain_label("Loading your builds…", "checkinMuted")
        full.addWidget(self.loading)
        self.empty = plain_label("No builds to pick for this matchup yet.", "checkinMuted", wrap=True)
        full.addWidget(self.empty)
        self.status = plain_label("", "checkinStatus", wrap=True)
        full.addWidget(self.status)

        full.addLayout(self._build_footer())
        layout.addWidget(self.full)

        self.bar = self._build_bar()
        layout.addWidget(self.bar)
        self.bar.hide()
        self.scouting = ScoutingStrip()
        self.scouting.open_requested.connect(lambda: self._act("open_scouting_dossier", self.model.game_key) if self.model else None)
        layout.addWidget(self.scouting)
        self.scouting.hide()

    def _build_footer(self) -> QtWidgets.QHBoxLayout:
        footer = QtWidgets.QHBoxLayout()
        footer.setContentsMargins(0, theme.SPACE_2XS, 0, 0)
        footer.setSpacing(theme.SPACE_S)
        self.not_now = button("Not now", "checkinQuiet", focusable=False)
        self.not_now.setToolTip("Skip this game's check-in at loading")
        self.not_now.clicked.connect(self._not_now)
        footer.addWidget(self.not_now)
        footer.addStretch(1)
        self.dont_ask = link("Don't ask at loading", focusable=False)
        self.dont_ask.setToolTip("Stop showing this card during loading screens")
        self.dont_ask.clicked.connect(lambda: self._act("disable", "loading"))
        footer.addWidget(self.dont_ask)
        return footer

    def _build_strip(self) -> QtWidgets.QFrame:
        """The Randomizer row and, under a saved pick, its draw."""
        strip = QtWidgets.QFrame()
        strip.setObjectName("checkinStrip")
        box = QtWidgets.QVBoxLayout(strip)
        box.setContentsMargins(theme.SPACE_S, theme.SPACE_XS, theme.SPACE_XS, theme.SPACE_XS)
        box.setSpacing(theme.SPACE_XS)
        row = QtWidgets.QHBoxLayout()
        row.setContentsMargins(0, 0, 0, 0)
        row.setSpacing(theme.SPACE_S)
        box.addLayout(row)
        self.strip_label = plain_label("", None, wrap=True)
        row.addWidget(self.strip_label, 1)
        self.roll_now = button("Randomize", "checkinSmall", focusable=False)
        self.roll_now.setToolTip("Select and save one build for this match. Animation and audio stay in the separate widget.")
        self.roll_now.clicked.connect(self._roll_now)
        self.play_roll = button("Play it", "checkinSmall", focusable=False)
        self.play_roll.clicked.connect(self._play_roll)
        self.reroll = button("Reroll", "checkinSmall", focusable=False)
        self.reroll.clicked.connect(self._reroll)
        for action in (self.roll_now, self.play_roll, self.reroll):
            row.addWidget(action, 0, QtCore.Qt.AlignVCenter)
        self.strip_draw = RandomizerDrawStill()
        box.addWidget(self.strip_draw)
        return strip

    def _build_bar(self) -> QtWidgets.QWidget:
        """The slim "Locked in" bar a declared build collapses the card to."""
        bar = QtWidgets.QWidget()
        box = QtWidgets.QVBoxLayout(bar)
        box.setContentsMargins(0, 0, 0, 0)
        box.setSpacing(theme.SPACE_XS)
        row = QtWidgets.QHBoxLayout()
        row.setContentsMargins(0, 0, 0, 0)
        row.setSpacing(theme.SPACE_S)
        self.locked = plain_label("", "checkinLocked", wrap=True)
        self.locked.setSizePolicy(QtWidgets.QSizePolicy.Ignored, QtWidgets.QSizePolicy.Preferred)
        row.addWidget(self.locked, 1)
        self.saving = plain_label("Saving…", "checkinMuted")
        row.addWidget(self.saving)
        self.change = link("Change", focusable=False)
        self.change.setToolTip("Pick a different build")
        self.change.clicked.connect(self._change)
        row.addWidget(self.change)
        box.addLayout(row)
        self.bar_draw = RandomizerDrawStill()
        box.addWidget(self.bar_draw)
        self.bar_status = plain_label("", "checkinStatus", wrap=True)
        box.addWidget(self.bar_status)
        self.make_drag_handle(bar)
        return bar

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

    def refresh_randomizer_draw(self) -> None:
        """The host has just read this game's draw."""
        model = self.model
        if model is None:
            return
        self._render_draw(model)
        if not model.scouting_only:
            self._render_strip(model)
        self.settle()

    def _render_draw(self, model: LoadingCardModel) -> None:
        """The still in the strip and in the slim bar."""
        self.strip_draw.show_draw(self._strip_draw(model))
        self.bar_draw.show_draw(self._bar_draw(model))

    def _strip_draw(self, model: LoadingCardModel) -> Optional[Any]:
        """Under the saved pick; with no Randomizer row, units drawn alone."""
        strip = model.randomizer
        if strip is None:
            return self._host.randomizer_draw(model.game_key, None)
        return self._host.randomizer_draw(model.game_key, strip.rolled_key) if strip.rolled_key else None

    def _bar_draw(self, model: LoadingCardModel) -> Optional[Any]:
        """The played pick's draw, else units drawn alone: those hold for
        whatever build is locked in."""
        if not model.collapsed:
            return None
        played = self._host.randomizer_draw(model.game_key, model.locked_key) if model.locked_key else None
        return played if played is not None else self._host.randomizer_draw(model.game_key, None)

    def _render(self, model: LoadingCardModel) -> None:
        self.model = model
        self._render_draw(model)
        self.scouting.set_model(model.scouting)
        self.scouting.setVisible(model.scouting is not None)
        collapsed = model.collapsed and bool(model.locked_label)
        self.full.setVisible(not collapsed)
        self.bar.setVisible(collapsed)
        if collapsed:
            self._render_bar(model)
            return

        self.eyebrow.setText(model.heading.upper())
        self.title.setText(model.title)
        self.title.setVisible(bool(model.title))
        self.not_now.setText("Close" if model.scouting_only else "Not now")
        self.dont_ask.setVisible(not model.scouting_only and not model.randomizer_only)
        if model.scouting_only:
            for widget in (self.intro, self.waiting, self.strip, self.builds, self.loading, self.empty, self.status):
                widget.hide()
            return
        self.intro_text.setText(model.intro_text)
        self.intro.setVisible(model.show_intro)
        self.waiting.setText(model.waiting_label)
        self.waiting.setVisible(model.waiting_for_matchup)

        self._render_strip(model)
        has_rows = bool(model.featured or model.more)
        if has_rows:
            # Re-picking after **Change**: the standing pick is marked.
            self.builds.set_rows(
                model.featured, model.more,
                reason_key=model.locked_key if model.changing else None,
                reason_label=model.current_pick_label if model.changing else None,
            )
        self.builds.setVisible(not model.randomizer_only and not model.waiting_for_matchup and self.builds.has_rows())
        self.loading.setVisible(not model.randomizer_only and model.options_loading and not self.builds.has_rows())
        self.empty.setVisible(
            not model.randomizer_only and bool(model.matchup)
            and not model.options_loading
            and not self.builds.has_rows()
            and not model.status
        )
        self.status.setText(model.status)
        self.status.setVisible(bool(model.status))
        set_tone(self.status, "tone", "warning")
        self.not_now.setToolTip(model.not_now_tip)

    def _render_bar(self, model: LoadingCardModel) -> None:
        self.locked.setText(model.locked_label or "")
        self.locked.setToolTip(model.locked_label or "")
        set_tone(self.locked, "saving", "true" if model.saving else "false")
        self.saving.setVisible(model.saving)
        self.change.setVisible(model.can_change)
        self.bar_status.setText(model.status)
        self.bar_status.setVisible(bool(model.status))
        set_tone(self.bar_status, "tone", "warning")

    def _render_strip(self, model: LoadingCardModel) -> None:
        """The Randomizer row; units drawn alone get it with no actions."""
        strip = model.randomizer
        alone = strip is None and self.strip_draw.draw is not None
        self.strip.setVisible(strip is not None or alone)
        if strip is None:
            self.strip_label.setText(UNITS_ALONE_LABEL if alone else "")
            for action in (self.roll_now, self.play_roll, self.reroll):
                action.setVisible(False)
            return
        self.strip_label.setText(strip.label)
        self.roll_now.setVisible(strip.can_roll_now)
        self.play_roll.setVisible(bool(strip.rolled_key))
        self.play_roll.setEnabled(strip.can_play)
        self.reroll.setVisible(strip.can_reroll)

    # ---------------------------------------------------- player out

    def _declare(self, key: str) -> None:
        if self.model is not None:
            self._act("declare", self.model.game_key, key)

    def _change(self) -> None:
        if self.model is not None:
            self._act("undeclare", self.model.game_key)

    def _play_roll(self) -> None:
        strip = self.model.randomizer if self.model is not None else None
        if strip is not None and strip.rolled_key and strip.can_play:
            self._declare(strip.rolled_key)

    def _reroll(self) -> None:
        if self.model is not None and self.model.randomizer is not None and self.model.randomizer.can_reroll:
            self._act("reroll", self.model.game_key)

    def _roll_now(self) -> None:
        if self.model is not None:
            self._act("roll_now", self.model.game_key)

    def _not_now(self) -> None:
        if self.model is not None:
            self._act("dismiss_scouting" if self.model.scouting_only else "not_now", self.model.game_key)


__all__ = [
    "CardWindow",
    "LOADING_FLAGS",
    "LoadingCardWindow",
    "card_header",
    "intro_box",
]
