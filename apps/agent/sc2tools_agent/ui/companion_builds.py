"""Embedded build check-ins driven by the agent's existing controller."""
from __future__ import annotations

from dataclasses import replace
import logging
import time

from ..build_checkin.models import CheckinPrefs, LoadingCardModel, PostgameCardModel
from ..build_checkin.scouting import plain_text

log = logging.getLogger(__name__)


def build_companion_builds(parent, *, controller_provider, QtCore, QtGui, QtWidgets):
    from .build_checkin_widgets import BuildList, button, card_stylesheet, plain_label, set_tone
    from .private_scouting import OpponentNoteEditor

    class CompanionBuilds(QtWidgets.QWidget):
        def __init__(self):
            super().__init__(parent)
            self.setObjectName("companionBuilds")
            self.setStyleSheet(card_stylesheet())
            self.loading_model = None
            self.postgame_model = None
            self._loading_open = False
            self._postgame_open = False
            self._assistance_enabled = True
            self._pre_game_gate = True
            self._post_game_gate = True
            self._mode_name = "Ladder"
            self._prefs = None
            self._prefs_seen = False
            self._expected_prefs = None
            self._prefs_changed_at = 0.0
            self._prefs_error = ""
            self._applying = False
            self._touched = False
            self._opponent_touched = False
            self._changing = False
            self._planned = None
            self._build_ui()
            self.refresh()

        def _build_ui(self):
            layout = QtWidgets.QVBoxLayout(self)
            layout.setContentsMargins(14, 12, 14, 12)
            layout.setSpacing(10)
            title = plain_label("BUILD CHECK-INS", "checkinEyebrow")
            layout.addWidget(title)
            choices = QtWidgets.QHBoxLayout()
            self.loading_toggle = QtWidgets.QCheckBox("Pre-game build selector")
            self.postgame_toggle = QtWidgets.QCheckBox("Post-game build selector")
            self.loading_toggle.toggled.connect(lambda checked: self._change_pref("ask_at_loading", checked))
            self.postgame_toggle.toggled.connect(lambda checked: self._change_pref("ask_after_game", checked))
            choices.addWidget(self.loading_toggle)
            choices.addWidget(self.postgame_toggle)
            choices.addStretch()
            self.refresh_button = button("Refresh settings", "checkinSmall")
            self.refresh_button.clicked.connect(self._refresh_settings)
            choices.addWidget(self.refresh_button)
            layout.addLayout(choices)
            self.hint = plain_label("", "checkinMuted", wrap=True)
            layout.addWidget(self.hint)
            self.tabs = QtWidgets.QTabWidget()
            self.tabs.addTab(self._loading_tab(), "Pre-game")
            self.tabs.addTab(self._postgame_tab(), "Post-game")
            layout.addWidget(self.tabs)

        def _loading_tab(self):
            tab = QtWidgets.QWidget()
            layout = QtWidgets.QVBoxLayout(tab)
            layout.setContentsMargins(12, 12, 12, 12)
            layout.setSpacing(8)
            self.loading_title = plain_label("Your next match", "checkinTitle", wrap=True)
            layout.addWidget(self.loading_title)
            self.loading_status = plain_label("Build choices appear when a match loads.", "checkinStatus", wrap=True)
            layout.addWidget(self.loading_status)
            self.loading_body = QtWidgets.QWidget()
            body = QtWidgets.QVBoxLayout(self.loading_body)
            body.setContentsMargins(0, 0, 0, 0)
            body.setSpacing(8)
            self.loading_waiting = plain_label("", "checkinMuted", wrap=True)
            body.addWidget(self.loading_waiting)
            self.locked = plain_label("", "checkinLocked", wrap=True)
            body.addWidget(self.locked)
            self.roll_strip = QtWidgets.QWidget()
            roll = QtWidgets.QHBoxLayout(self.roll_strip)
            roll.setContentsMargins(0, 0, 0, 0)
            self.roll_label = plain_label("", "checkinMuted", wrap=True)
            self.roll_now = button("Roll in widget", "checkinSmall")
            self.roll_now.setToolTip("Release the check-in hold so the overlay widget can draw. The Companion does not roll or play randomizer audio.")
            self.roll_now.clicked.connect(lambda: self._loading_action("roll_now"))
            roll.addWidget(self.roll_label, 1)
            roll.addWidget(self.roll_now)
            body.addWidget(self.roll_strip)
            self.loading_builds = BuildList(selectable=False, searchable=True, focusable=True)
            self.loading_builds.picked.connect(lambda key: self._loading_action("declare", key))
            body.addWidget(self.loading_builds)
            actions = QtWidgets.QHBoxLayout()
            self.change_loading = button("Change build")
            self.change_loading.clicked.connect(lambda: self._loading_action("undeclare"))
            actions.addWidget(self.change_loading)
            actions.addStretch()
            self.skip_loading = button("Not now", "checkinQuiet")
            self.skip_loading.clicked.connect(lambda: self._loading_action("not_now"))
            actions.addWidget(self.skip_loading)
            body.addLayout(actions)
            layout.addWidget(self.loading_body)
            self.loading_body.hide()
            layout.addStretch()
            return self._scroll(tab)

        def _postgame_tab(self):
            tab = QtWidgets.QWidget()
            layout = QtWidgets.QVBoxLayout(tab)
            layout.setContentsMargins(12, 12, 12, 12)
            layout.setSpacing(8)
            self.postgame_title = plain_label("Your last match", "checkinTitle", wrap=True)
            layout.addWidget(self.postgame_title)
            self.postgame_status = plain_label("Confirm your plan after the next match.", "checkinStatus", wrap=True)
            layout.addWidget(self.postgame_status)
            self.reopen = button("Reopen pending check-in", "checkinSmall")
            self.reopen.clicked.connect(self._reopen)
            layout.addWidget(self.reopen, 0, QtCore.Qt.AlignLeft)
            self.postgame_body = QtWidgets.QWidget()
            body = QtWidgets.QVBoxLayout(self.postgame_body)
            body.setContentsMargins(0, 0, 0, 0)
            body.setSpacing(8)
            self.prompt = plain_label("", "checkinPrompt", wrap=True)
            self.detected = plain_label("", "checkinMuted", wrap=True)
            body.addWidget(self.prompt)
            body.addWidget(self.detected)
            self.own_picker = QtWidgets.QWidget()
            own = QtWidgets.QVBoxLayout(self.own_picker)
            own.setContentsMargins(0, 0, 0, 0)
            self.postgame_builds = BuildList(selectable=True, searchable=True, focusable=True)
            self.postgame_builds.picked.connect(self._own_picked)
            self.postgame_builds.searched.connect(lambda _text: self._interacted())
            self.postgame_builds.expanded.connect(lambda _open: self._interacted())
            own.addWidget(self.postgame_builds)
            self.own_empty = plain_label("", "checkinMuted", wrap=True)
            own.addWidget(self.own_empty)
            self.add_own_build = button("Add new build…", "checkinLink")
            self.add_own_build.clicked.connect(lambda: self._add_build("you"))
            own.addWidget(self.add_own_build, 0, QtCore.Qt.AlignLeft)
            body.addWidget(self.own_picker)
            opponent_heading = QtWidgets.QHBoxLayout()
            self.opponent_label = plain_label("", "checkinOpponent", wrap=True)
            opponent_heading.addWidget(self.opponent_label, 1)
            self.change_opponent = button("Change opponent build", "checkinSmall")
            self.change_opponent.setCheckable(True)
            self.change_opponent.toggled.connect(self._opponent_expanded)
            opponent_heading.addWidget(self.change_opponent)
            body.addLayout(opponent_heading)
            self.opponent_picker = QtWidgets.QWidget()
            opponent = QtWidgets.QVBoxLayout(self.opponent_picker)
            opponent.setContentsMargins(0, 0, 0, 0)
            self.opponent_builds = BuildList(
                selectable=True, searchable=True, focusable=True, featured_title="FACED BEFORE",
                more_title="ALL BUILDS", search_placeholder="Search opponent builds",
                no_match="No opponent builds match your search.",
            )
            self.opponent_builds.picked.connect(self._opponent_picked)
            self.opponent_builds.searched.connect(lambda _text: self._interacted())
            self.opponent_builds.expanded.connect(lambda _open: self._interacted())
            opponent.addWidget(self.opponent_builds)
            self.opponent_empty = plain_label("", "checkinMuted", wrap=True)
            opponent.addWidget(self.opponent_empty)
            opponent_actions = QtWidgets.QHBoxLayout()
            self.use_replay = button("Use replay's label", "checkinLink")
            self.use_replay.clicked.connect(self._use_replay)
            opponent_actions.addWidget(self.use_replay)
            opponent_actions.addStretch()
            self.add_opponent_build = button("Add new build…", "checkinLink")
            self.add_opponent_build.clicked.connect(lambda: self._add_build("opponent"))
            opponent_actions.addWidget(self.add_opponent_build)
            opponent.addLayout(opponent_actions)
            body.addWidget(self.opponent_picker)
            self.opponent_picker.hide()
            body.addWidget(plain_label("Game notes", "checkinSection"))
            self.notes = QtWidgets.QPlainTextEdit()
            self.notes.setObjectName("checkinNotes")
            self.notes.setAccessibleName("Build check-in game notes")
            self.notes.setFixedHeight(76)
            self.notes.setTabChangesFocus(True)
            self.notes.textChanged.connect(self._notes_changed)
            body.addWidget(self.notes)
            self.note_count = plain_label("", "checkinCounter")
            body.addWidget(self.note_count)
            self.opponent_note = OpponentNoteEditor()
            self.opponent_note.edited.connect(lambda text: self._private_note_action("update_opponent_note", text))
            self.opponent_note.save_requested.connect(lambda text: self._private_note_action("save_opponent_note", text))
            body.addWidget(self.opponent_note)
            actions = QtWidgets.QHBoxLayout()
            self.confirm = button("Confirm", "checkinPrimary")
            self.confirm.clicked.connect(self._confirm)
            self.change_own = button("Change build")
            self.change_own.clicked.connect(self._change_own)
            self.no_build = button("No set build")
            self.no_build.clicked.connect(self._no_build)
            self.later = button("Later", "checkinQuiet")
            self.later.clicked.connect(self._later)
            for control in (self.confirm, self.change_own, self.no_build):
                actions.addWidget(control)
            actions.addStretch()
            actions.addWidget(self.later)
            body.addLayout(actions)
            layout.addWidget(self.postgame_body)
            self.postgame_body.hide()
            layout.addStretch()
            return self._scroll(tab)

        def _scroll(self, content):
            scroll = QtWidgets.QScrollArea()
            scroll.setFrameShape(QtWidgets.QFrame.NoFrame)
            scroll.setWidgetResizable(True)
            scroll.setHorizontalScrollBarPolicy(QtCore.Qt.ScrollBarAlwaysOff)
            scroll.setWidget(content)
            return scroll

        def _controller(self):
            return controller_provider() if callable(controller_provider) else None

        def _act(self, method, *args, **kwargs):
            controller = self._controller()
            action = getattr(controller, method, None) if controller is not None else None
            if not callable(action) or (getattr(controller, "available", None) is False and method != "refresh_prefs") or (not self._assistance_enabled and method not in {"set_prefs", "refresh_prefs"}):
                return False
            try:
                action(*args, **kwargs)
                return True
            except Exception:
                log.exception("companion_checkin_action_failed method=%s", method)
                self.hint.setText("Couldn't update the build check-in. Try again after reconnecting.")
                return False

        def refresh(self):
            controller = self._controller()
            prefs = getattr(controller, "prefs", None) if controller is not None else None
            if isinstance(prefs, CheckinPrefs):
                self._prefs_seen = self._prefs_seen or getattr(controller, "available", None) is True
                self._apply_prefs(prefs)
            self._render_availability()
            self._render_controls()

        def dispatch(self, method, args=()):
            arguments = tuple(args or ())
            if method == "bind_controller":
                self.refresh()
            elif method == "update_prefs" and arguments and isinstance(arguments[0], CheckinPrefs):
                self._prefs_seen = True
                self._apply_prefs(arguments[0])
                self._render_availability()
                self._render_controls()
            elif method in {"show_loading", "update_loading"} and arguments and isinstance(arguments[0], LoadingCardModel):
                model = arguments[0]
                if method == "update_loading" and (not self._loading_open or self.loading_model is None or self.loading_model.game_key != model.game_key):
                    return
                if self.loading_model is None or self.loading_model.game_key != model.game_key:
                    self.loading_builds.reset()
                self.loading_model = model
                self._loading_open = True
                self._render_loading()
                self._render_controls()
            elif method == "hide_loading" and arguments and self.loading_model is not None and self.loading_model.game_key == arguments[0]:
                self._loading_open = False
                self.loading_status.setText("Your loading-screen check-in is closed. The next match's choices appear here.")
                self.loading_body.hide()
            elif method in {"show_postgame", "update_postgame"} and arguments and isinstance(arguments[0], PostgameCardModel):
                model = arguments[0]
                if method == "update_postgame" and (not self._postgame_open or self.postgame_model is None or self.postgame_model.card_id != model.card_id):
                    return
                fresh = self.postgame_model is None or self.postgame_model.card_id != model.card_id or not self._postgame_open
                if self.postgame_model is None or self.postgame_model.card_id != model.card_id:
                    self.postgame_builds.reset()
                    self.opponent_builds.reset()
                    self.change_opponent.setChecked(False)
                    self._changing = False
                if fresh:
                    self._touched = False
                    self._opponent_touched = bool(model.opponent and model.opponent.touched)
                self.postgame_model = model
                self._postgame_open = True
                self._render_postgame(fresh=fresh)
                self._render_controls()
            elif method == "hide_postgame" and arguments and self.postgame_model is not None and self.postgame_model.card_id == arguments[0]:
                self._postgame_open = False
                reason = arguments[1] if len(arguments) > 1 else ""
                self.postgame_status.setText({"confirmed": "Build check-in confirmed.", "skipped": "Saved without a set build.", "decided_elsewhere": "This check-in was completed elsewhere."}.get(reason, "Check-in set aside. Reopen pending check-in when you're ready."))
                self.postgame_body.hide()
                self._render_controls()

        def set_assistance_enabled(self, enabled):
            self._assistance_enabled = bool(enabled)
            self._render_availability()
            self._render_controls()

        def set_feature_gates(self, gates):
            self._pre_game_gate = gates.get("preGameSelector") is not False
            self._post_game_gate = gates.get("postGameSelector") is not False
            self._mode_name = str(gates.get("mode") or "Ladder").capitalize()
            self._render_availability()
            self._render_controls()

        def _apply_prefs(self, prefs):
            if self._expected_prefs is not None and prefs != self._expected_prefs and time.monotonic() - self._prefs_changed_at < 15:
                self._prefs_error = "The selector setting wasn't saved. Check your connection and try again."
            elif prefs == self._expected_prefs:
                self._prefs_error = ""
            self._prefs = prefs
            for control, value in ((self.loading_toggle, prefs.ask_at_loading), (self.postgame_toggle, prefs.ask_after_game)):
                blocked = QtCore.QSignalBlocker(control)
                control.setChecked(value)
                del blocked

        def _render_availability(self):
            controller = self._controller()
            available = getattr(controller, "available", None) if controller is not None else None
            ready = controller is not None and available is not False and self._prefs is not None and self._prefs_seen
            for control in (self.loading_toggle, self.postgame_toggle):
                control.setEnabled(ready)
            self.refresh_button.setEnabled(controller is not None)
            self.reopen.setEnabled(ready and self._assistance_enabled and self._post_game_gate and self._prefs.postgame_cards)
            if controller is None:
                message = "Waiting for the agent's live-game controller. Build selectors need live game detection."
            elif available is False:
                message = "Build check-ins are unavailable on the connected server."
            elif self._prefs is None or not self._prefs_seen:
                message = "Loading build selector settings…"
            elif not self._assistance_enabled:
                message = "Assistance is off. Your independent selector choices stay saved."
            elif not self._pre_game_gate and not self._post_game_gate:
                message = self._mode_name + " preset hides build selectors. Account selector switches stay saved and adjustable."
            elif not self._pre_game_gate or not self._post_game_gate:
                message = self._mode_name + " preset allows only the " + ("pre-game" if self._pre_game_gate else "post-game") + " selector. Account switches still apply."
            elif self._prefs_error:
                message = self._prefs_error
            elif not self._prefs.enabled:
                message = "Build check-ins are disabled. Enable either selector to turn check-ins back on."
            else:
                message = "Selections and corrections use the same check-ins as your in-game cards."
            self.hint.setText(message)

        def _change_pref(self, field, enabled):
            if self._prefs is None:
                return
            changes = {field: bool(enabled)}
            if enabled and not self._prefs.enabled:
                changes["enabled"] = True
            self._expected_prefs = replace(self._expected_prefs or self._prefs, **changes)
            self._prefs_changed_at = time.monotonic()
            self._prefs_error = ""
            if not self._act("set_prefs", **changes):
                self._apply_prefs(self._prefs)

        def _refresh_settings(self):
            self._prefs_error = ""
            self._act("refresh_prefs")
            self.refresh()

        def _render_loading(self):
            model = self.loading_model
            self.loading_title.setText(model.title or model.heading)
            self.loading_status.setText("Pre-game build selection is off; scouting is available in its own tab." if model.scouting_only else model.status or ("Saving your build choice…" if model.saving else model.locked_label or model.heading))
            set_tone(self.loading_status, "tone", "warning" if model.status else "muted")
            self.loading_waiting.setText(model.waiting_label if model.waiting_for_matchup else "Loading builds…" if model.options_loading else "No builds for this matchup yet." if not (model.featured or model.more) else "")
            self.loading_waiting.setVisible(bool(self.loading_waiting.text()))
            self.locked.setText(model.locked_label or "")
            self.locked.setVisible(bool(model.locked_label))
            self.loading_builds.set_rows(model.featured, model.more, reason_key=model.locked_key if model.changing else None, reason_label=model.current_pick_label if model.changing else None)
            self.loading_builds.setVisible(not model.collapsed and not model.waiting_for_matchup and not model.scouting_only)
            self.change_loading.setVisible(model.can_change)
            self.roll_strip.setVisible(model.randomizer is not None)
            if model.randomizer:
                self.roll_label.setText(model.randomizer.label)
                self.roll_now.setVisible(model.randomizer.can_roll_now)
            self.skip_loading.setToolTip(model.not_now_tip)
            self.loading_body.setVisible(self._loading_open and not model.scouting_only)

        def _render_postgame(self, *, fresh=False):
            model = self.postgame_model
            self._applying = True
            try:
                self.postgame_title.setText(model.title or model.heading)
                self.postgame_status.setText(model.status or model.heading)
                set_tone(self.postgame_status, "tone", "warning" if model.status else "muted")
                self.prompt.setText(model.prompt or "")
                self.prompt.setVisible(bool(model.prompt))
                self.detected.setText(model.detected_label or "")
                self.detected.setVisible(bool(model.detected_label))
                self.postgame_builds.set_rows(model.featured, model.more, reason_key=model.selection, reason_label=model.reason_label, reason=model.reason)
                if fresh or not self._touched:
                    self._planned = model.selection
                    self.postgame_builds.set_selection(model.selection)
                    self.notes.setPlainText(model.notes)
                self.notes.setPlaceholderText(model.notes_placeholder)
                self.own_empty.setText("Loading builds…" if model.options_loading else "Your build choices appear once the replay shows the matchup.")
                self.own_empty.setVisible(not self.postgame_builds.has_rows())
                self.own_picker.setVisible(model.variant != "notes_first" or self._changing)
                self.change_own.setVisible(model.variant == "notes_first" and not self._changing)
                self.confirm.setText("Saving…" if model.busy else "Done" if model.variant == "notes_first" and not self._changing else "Confirm")
                self.add_own_build.setToolTip(model.add_build_hint)
                self.add_opponent_build.setToolTip(model.add_build_hint)
                opponent = model.opponent
                self.change_opponent.setVisible(opponent is not None)
                self.opponent_label.setVisible(opponent is not None)
                if opponent is not None:
                    self.opponent_builds.set_rows(opponent.featured, opponent.more)
                    if fresh or not self._opponent_touched:
                        self.opponent_builds.set_selection(opponent.selection)
                    self._render_opponent_label()
                    self.opponent_empty.setText("Loading opponent builds…" if opponent.options_loading else opponent.empty)
                    self.opponent_empty.setVisible(not self.opponent_builds.has_rows())
                    self.use_replay.setVisible(opponent.show_use_replay or self._opponent_touched)
                self.opponent_picker.setVisible(opponent is not None and self.change_opponent.isChecked())
                self.opponent_note.set_model(model)
                self._update_counter()
                self.postgame_body.setVisible(self._postgame_open)
            finally:
                self._applying = False

        def _render_controls(self):
            controller = self._controller()
            supported = controller is not None and getattr(controller, "available", None) is not False
            enabled = self._assistance_enabled and supported
            prefs = self._prefs or CheckinPrefs()
            loading = self.loading_model
            loading_enabled = enabled and self._pre_game_gate and prefs.loading_cards and self._loading_open and loading is not None and not loading.saving and not loading.scouting_only
            self.loading_body.setEnabled(loading_enabled)
            if loading is not None:
                self.loading_builds.set_rows_enabled(loading_enabled and not loading.waiting_for_matchup)
            postgame = self.postgame_model
            postgame_enabled = enabled and self._post_game_gate and prefs.postgame_cards and self._postgame_open and postgame is not None and not postgame.busy
            self.postgame_body.setEnabled(postgame_enabled)
            if postgame is not None:
                self.postgame_builds.set_rows_enabled(postgame_enabled)
                self.opponent_builds.set_rows_enabled(postgame_enabled)
                self.confirm.setEnabled(postgame_enabled and self.selection() is not None)
                self.add_own_build.setEnabled(postgame_enabled and postgame.can_add_build)
                self.add_opponent_build.setEnabled(postgame_enabled and postgame.can_add_build)

        def _loading_action(self, method, *args):
            model = self.loading_model
            if not self._pre_game_gate or not (self._prefs or CheckinPrefs()).loading_cards or not self._loading_open or model is None or model.saving or model.scouting_only:
                return
            self._act(method, model.game_key, *args)

        def selection(self):
            selected = self.postgame_builds.selection()
            if selected is None and self.postgame_model is not None and self.postgame_model.variant == "notes_first" and not self._changing:
                return self._planned
            return selected

        def _postgame_ready(self):
            return self._post_game_gate and (self._prefs or CheckinPrefs()).postgame_cards and self._postgame_open and self.postgame_model is not None and not self.postgame_model.busy and not self._applying

        def _opponent_args(self):
            return (self.opponent_builds.selection(),) if self._opponent_touched and self.postgame_model is not None and self.postgame_model.opponent is not None else ()

        def _interacted(self):
            if self._postgame_ready():
                self._act("interacted", self.postgame_model.card_id)

        def _draft_changed(self):
            if self._postgame_ready():
                self._touched = True
                self._act("update_draft", self.postgame_model.card_id, self.selection(), self.notes.toPlainText(), *self._opponent_args())

        def _own_picked(self, key):
            self._draft_changed()
            self._render_controls()

        def _opponent_picked(self, key):
            if not self._postgame_ready():
                return
            self._opponent_touched = True
            self._draft_changed()
            self._render_opponent_label()

        def _opponent_expanded(self, opened):
            self.opponent_picker.setVisible(opened and self.postgame_model is not None and self.postgame_model.opponent is not None)
            self._interacted()

        def _render_opponent_label(self):
            opponent = self.postgame_model.opponent
            row = self.opponent_builds.row(self.opponent_builds.selection()) if self._opponent_touched else None
            self.opponent_label.setText("Opponent's build: " + row.name + " · changed" if row is not None else opponent.label)

        def _use_replay(self):
            if self._postgame_ready() and self.postgame_model.opponent is not None:
                self.opponent_builds.set_selection(self.postgame_model.opponent.replay_key)
                self._opponent_picked(self.postgame_model.opponent.replay_key)

        def _notes_changed(self):
            if self._applying:
                return
            model = self.postgame_model
            if model is None:
                return
            text = self.notes.toPlainText()
            kept = plain_text(text, model.notes_max, trim=False)
            if text != kept:
                blocked = QtCore.QSignalBlocker(self.notes)
                cursor = self.notes.textCursor().position()
                self.notes.setPlainText(kept)
                position = self.notes.textCursor()
                position.setPosition(min(cursor, len(kept.encode("utf-16-le")) // 2))
                self.notes.setTextCursor(position)
                del blocked
            self._update_counter()
            self._draft_changed()

        def _update_counter(self):
            count = len(self.notes.toPlainText().encode("utf-16-le")) // 2
            limit = self.postgame_model.notes_max if self.postgame_model is not None else 1000
            self.note_count.setText(f"{count} / {limit}")

        def _confirm(self):
            if self._postgame_ready() and self.selection() is not None:
                self._act("confirm", self.postgame_model.card_id, self.selection(), self.notes.toPlainText(), *self._opponent_args())

        def _no_build(self):
            if self._postgame_ready():
                self._act("no_set_build", self.postgame_model.card_id, self.notes.toPlainText(), *self._opponent_args())

        def _later(self):
            if self._postgame_ready():
                self._act("later", self.postgame_model.card_id, self.notes.toPlainText())

        def _change_own(self):
            if self._postgame_ready():
                self._changing = True
                self._interacted()
                self._render_postgame()
                self._render_controls()

        def _add_build(self, side):
            if self._postgame_ready() and self.postgame_model.can_add_build:
                self._act("add_build", self.postgame_model.card_id, side)

        def _private_note_action(self, method, text):
            if self._postgame_ready():
                self._act(method, self.postgame_model.card_id, text)

        def _reopen(self):
            if self._post_game_gate and (self._prefs or CheckinPrefs()).postgame_cards:
                self._act("reopen")

    return CompanionBuilds()
