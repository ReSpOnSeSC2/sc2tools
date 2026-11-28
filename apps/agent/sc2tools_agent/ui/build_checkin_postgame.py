"""The end-of-game build check-in card: "Which build were you going for?".

It shows without activating but can take focus once the player clicks
into it (search, notes). When it closes while it is the foreground window
and the window it took focus from is SC2, focus goes back to SC2, except
when **Add new build...** just opened the browser, which keeps it. Once
the replay is in it also carries the compact "Opponent's build: X ·
Change" row, an accordion that swaps the build list for the opponent's.

The shared window chrome is ``build_checkin_cards.CardWindow``. Like the
loading card it never animates: a waiting state is a line of text, since
any animation repaints the whole see-through window over the game.
"""

from __future__ import annotations

import time
from typing import Any, Optional

from PySide6 import QtCore, QtGui, QtWidgets

from ..build_checkin.models import (
    CHECKING_REPLAY,
    DETECTED_LABEL,
    OPPONENT_ROW,
    OPPONENT_UNKNOWN,
    OpponentRowModel,
    PostgameCardModel,
    opponent_change,
)
from ..build_checkin.view import HIDE_OPENED_WEB
from . import theme, win32_window
from .build_checkin_cards import CardWindow, card_header, intro_box
from .build_checkin_widgets import BuildList, button, link, plain_label, set_tone
from .build_checkin_window import POSTGAME
from .private_scouting import OpponentNoteEditor

INTERACTION_THROTTLE_SEC = 1.0
NOTES_WARN_AT = 0.9
"""Share of the notes limit at which the counter turns amber."""

POSTGAME_FLAGS = (
    QtCore.Qt.Tool
    | QtCore.Qt.WindowStaysOnTopHint
    | QtCore.Qt.FramelessWindowHint
)

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

        layout = self.content_layout
        layout.setContentsMargins(theme.SPACE_L, theme.SPACE_M, theme.SPACE_L, theme.SPACE_M)
        layout.setSpacing(theme.SPACE_S)
        layout.addWidget(self.preview_chip)

        self.header = self._build_header()
        self.make_drag_handle(self.header)
        layout.addWidget(self.header)

        self.intro_text = plain_label("", "checkinIntro", wrap=True)
        self.intro_dismiss = link("Got it")
        self.intro_dismiss.clicked.connect(lambda: self._act("dismiss_intro"))
        self.intro = intro_box(self.intro_text, self.intro_dismiss)
        layout.addWidget(self.intro)

        self.prompt = plain_label("", "checkinPrompt", wrap=True)
        layout.addWidget(self.prompt)
        self.detected = plain_label("", "checkinMuted", wrap=True)
        layout.addWidget(self.detected)

        self.opp_row = self._build_opponent_row()
        layout.addWidget(self.opp_row)
        self.status = plain_label("", "checkinStatus", wrap=True)
        layout.addWidget(self.status)
        self.picker = self._build_picker()
        layout.addWidget(self.picker)
        self.opp_picker = self._build_opponent_picker()
        layout.addWidget(self.opp_picker)
        self.opp_picker.hide()
        self._build_notes(layout)
        layout.addLayout(self._build_actions())
        self.turn_off = link("Turn off check-ins after games")
        self.turn_off.setToolTip("Stop showing this card after games")
        self.turn_off.clicked.connect(lambda: self._act("disable", "postgame"))
        layout.addWidget(self.turn_off)

        for keys in ("Ctrl+Return", "Ctrl+Enter"):
            shortcut = QtGui.QShortcut(QtGui.QKeySequence(keys), self)
            shortcut.activated.connect(self._primary_clicked)
        self._real_escape = QtGui.QShortcut(QtGui.QKeySequence(QtCore.Qt.Key_Escape), self)
        self._real_escape.activated.connect(self._escape)

    def _build_header(self) -> QtWidgets.QWidget:
        """The eyebrow, then the result in its tone ahead of the title."""
        self.eyebrow = plain_label("", "checkinEyebrow")
        title_row = QtWidgets.QWidget()
        title = QtWidgets.QHBoxLayout(title_row)
        title.setContentsMargins(0, 0, 0, 0)
        title.setSpacing(0)
        self.result = plain_label("", "checkinResult")
        title.addWidget(self.result)
        self.title = plain_label("", "checkinTitle", wrap=True)
        title.addWidget(self.title, 1)
        return card_header(self.eyebrow, title_row)

    def _build_opponent_row(self) -> QtWidgets.QWidget:
        """"Opponent's build: X · changed · Change"."""
        row_widget = QtWidgets.QWidget()
        row = QtWidgets.QHBoxLayout(row_widget)
        row.setContentsMargins(0, 0, 0, 0)
        row.setSpacing(theme.SPACE_S)
        self.opp_label = plain_label("", "checkinOpponent", wrap=True)
        row.addWidget(self.opp_label, 1)
        self.opp_changed = plain_label("", "checkinChanged")
        row.addWidget(self.opp_changed, 0, QtCore.Qt.AlignTop)
        self.opp_change = link("Change")
        self.opp_change.clicked.connect(self._toggle_opponent)
        row.addWidget(self.opp_change, 0, QtCore.Qt.AlignTop)
        return row_widget

    def _build_picker(self) -> QtWidgets.QWidget:
        """The player's own build list."""
        picker_widget = QtWidgets.QWidget()
        picker = QtWidgets.QVBoxLayout(picker_widget)
        picker.setContentsMargins(0, 0, 0, 0)
        picker.setSpacing(theme.SPACE_S)
        self.builds = BuildList(selectable=True, searchable=True, focusable=True)
        self.builds.picked.connect(self._picked)
        self.builds.searched.connect(self._searched)
        self.builds.expanded.connect(self._expanded)
        self.builds.names_expanded.connect(self._expand_build_names)
        picker.addWidget(self.builds)
        self.loading = plain_label("Loading builds…", "checkinMuted")
        picker.addWidget(self.loading)
        self.empty = plain_label("", "checkinMuted", wrap=True)
        picker.addWidget(self.empty)
        self.add_build = link("")
        self.add_build.clicked.connect(lambda: self._add_build("you"))
        picker.addWidget(self.add_build)
        return picker_widget

    def _build_opponent_picker(self) -> QtWidgets.QWidget:
        """The opponent's build list, an accordion that replaces the player's."""
        picker_widget = QtWidgets.QWidget()
        opp_picker = QtWidgets.QVBoxLayout(picker_widget)
        opp_picker.setContentsMargins(0, 0, 0, 0)
        opp_picker.setSpacing(theme.SPACE_S)
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
        self.opp_builds.names_expanded.connect(self._expand_build_names)
        opp_picker.addWidget(self.opp_builds)
        self.opp_loading = plain_label("Loading builds…", "checkinMuted")
        opp_picker.addWidget(self.opp_loading)
        self.opp_empty = plain_label(defaults.empty, "checkinMuted", wrap=True)
        opp_picker.addWidget(self.opp_empty)
        opp_footer = QtWidgets.QHBoxLayout()
        opp_footer.setContentsMargins(0, 0, 0, 0)
        opp_footer.setSpacing(theme.SPACE_S)
        self.opp_add = link("")
        self.opp_add.clicked.connect(lambda: self._add_build("opponent"))
        opp_footer.addWidget(self.opp_add)
        opp_footer.addStretch(1)
        self.opp_use_replay = link(defaults.use_replay_label)
        self.opp_use_replay.clicked.connect(self._use_replay_label)
        opp_footer.addWidget(self.opp_use_replay)
        opp_picker.addLayout(opp_footer)
        return picker_widget

    def _build_notes(self, layout: QtWidgets.QVBoxLayout) -> None:
        """The game's notes with their counter, then the private opponent note."""
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

    def _build_actions(self) -> QtWidgets.QHBoxLayout:
        actions = QtWidgets.QHBoxLayout()
        actions.setContentsMargins(0, theme.SPACE_2XS, 0, 0)
        actions.setSpacing(theme.SPACE_S)
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
        return actions

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
    "POSTGAME_FLAGS",
    "PostgameCardWindow",
    "truncate_utf16",
    "utf16_length",
]
