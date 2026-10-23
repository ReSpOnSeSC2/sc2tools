"""Native controls for the shared build randomizer and its persisted live pick."""

from __future__ import annotations

import math
import threading
import time

from ..companion import CompanionError


MATCHUPS = tuple(mine + "v" + theirs for mine in "PTZ" for theirs in "PTZ")
ACTIVE_PHASES = {"match_loading", "match_started", "match_in_progress"}


def randomizer_context(snapshot, *, now=None):
    if not isinstance(snapshot, dict) or snapshot.get("paired") is not True:
        return None
    envelope = snapshot.get("liveGame")
    if (not isinstance(envelope, dict) or envelope.get("phase") not in ACTIVE_PHASES
            or envelope.get("isReplay") is True):
        return None
    game_key = envelope.get("gameKey")
    user, opponent = envelope.get("user"), envelope.get("opponent")
    if not isinstance(game_key, str) or not game_key or not isinstance(user, dict) or not isinstance(opponent, dict):
        return None
    races = {"p": "P", "protoss": "P", "t": "T", "terran": "T", "z": "Z", "zerg": "Z"}
    mine = races.get(str(user.get("race") or "").lower())
    theirs = races.get(str(opponent.get("race") or "").lower())
    if not mine or not theirs:
        return None
    stamp = envelope.get("receivedAt")
    if isinstance(stamp, (int, float)) and not isinstance(stamp, bool):
        stamp /= 1000
    else:
        stamp = envelope.get("capturedAt")
    if isinstance(stamp, (int, float)) and not isinstance(stamp, bool):
        elapsed = (time.time() if now is None else now) - stamp
        if not math.isfinite(elapsed) or elapsed > 30 or elapsed < -30:
            return None
    players = envelope.get("players")
    if isinstance(players, list) and (len(players) != 2 or any(
            isinstance(player, dict) and player.get("type") == "computer" for player in players)):
        return None
    return game_key, mine + "v" + theirs


def build_companion_randomizer(parent, *, handler, QtCore, QtGui, QtWidgets):
    """Create a lazy-Qt panel; account requests always run on daemon workers."""

    def label(text):
        widget = QtWidgets.QLabel(text)
        widget.setTextFormat(QtCore.Qt.PlainText)
        widget.setWordWrap(True)
        return widget

    class CompanionRandomizer(QtWidgets.QWidget):
        completed = QtCore.Signal(dict)

        def __init__(self):
            super().__init__(parent)
            self.setObjectName("companionRandomizer")
            self._closed = False
            self._busy = False
            self._context = None
            self._snapshot = {}
            self._config = {}
            self._intent = {}
            self._intent_context = None
            self._inflight_settings = {}
            self._assistance = True
            self._assistance_reason = "Game assistance is off. Your matchup settings remain saved."
            self._pending_settings = {}
            self._needs_refresh = False
            self._loaded = False
            self._pool_dirty = False
            self._pool_revision = 0
            self._rendering = False
            self._retry_at = 0
            self._explicit_roll = None
            self._status_error = False
            self._build_ui()
            self.completed.connect(self._completed)
            self.timer = QtCore.QTimer(self)
            self.timer.setInterval(3000)
            self.timer.timeout.connect(self.refresh)
            if callable(handler):
                self.timer.start()
            else:
                self.status.setText("The randomizer connects when the agent service is available.")
                self.refresh_button.setEnabled(False)
                self.enabled_check.setEnabled(False)

        def _build_ui(self):
            layout = QtWidgets.QVBoxLayout(self)
            heading = label("BUILD RANDOMIZER")
            heading.setObjectName("companionHeading")
            layout.addWidget(heading)
            layout.addWidget(label("Use your account's build pool. Each real match keeps one shared pick, with or without an OBS source."))
            row = QtWidgets.QHBoxLayout()
            self.matchup_select = QtWidgets.QComboBox()
            self.matchup_select.addItems(MATCHUPS)
            self.matchup_select.currentTextChanged.connect(self._matchup_changed)
            row.addWidget(self.matchup_select)
            self.enabled_check = QtWidgets.QCheckBox("Enable for this matchup")
            self.enabled_check.setEnabled(False)
            self.enabled_check.toggled.connect(self._enabled_changed)
            row.addWidget(self.enabled_check)
            row.addStretch(1)
            self.refresh_button = QtWidgets.QPushButton("Refresh pool")
            self.refresh_button.clicked.connect(self.refresh)
            row.addWidget(self.refresh_button)
            layout.addLayout(row)
            self.context_label = label("Waiting for a current one-on-one matchup…")
            layout.addWidget(self.context_label)
            self.pool = QtWidgets.QTreeWidget()
            self.pool.setColumnCount(2)
            self.pool.setHeaderLabels(["ELIGIBLE BUILD", "WEIGHT"])
            self.pool.setRootIsDecorated(False)
            self.pool.setAlternatingRowColors(True)
            self.pool.itemChanged.connect(self._pool_changed)
            self.pool.header().setSectionResizeMode(0, QtWidgets.QHeaderView.Stretch)
            layout.addWidget(self.pool, 1)
            self.save_pool_button = QtWidgets.QPushButton("Save selected pool")
            self.save_pool_button.setEnabled(False)
            self.save_pool_button.clicked.connect(self._save_pool)
            layout.addWidget(self.save_pool_button)
            self.result_label = label("No build has been drawn for the current game.")
            self.result_label.setObjectName("companionAccent")
            layout.addWidget(self.result_label)
            self.roll_button = QtWidgets.QPushButton("Roll now")
            self.roll_button.setEnabled(False)
            self.roll_button.clicked.connect(lambda: self._roll(True))
            layout.addWidget(self.roll_button)
            self.status = label("Pair your agent to load your randomizer settings.")
            self.status.setObjectName("companionMuted")
            layout.addWidget(self.status)

        def update_snapshot(self, snapshot):
            if self._closed:
                return
            self._snapshot = snapshot if isinstance(snapshot, dict) else {}
            context = randomizer_context(self._snapshot)
            if context != self._context:
                self._context = context
                self._intent = {}
                self._intent_context = None
                self._retry_at = 0
                self._explicit_roll = None
                if context:
                    blocked = QtCore.QSignalBlocker(self.matchup_select)
                    self.matchup_select.setCurrentText(context[1])
                    del blocked
                    self._pool_dirty = False
                self._needs_refresh = True
            if context:
                self.context_label.setText("Current game · " + context[1])
            else:
                self.context_label.setText("Waiting for a current one-on-one matchup… You can still edit any pool.")
            self._render_result()
            self._render_switch()
            if self._snapshot.get("paired") is True and (not self._loaded or self._needs_refresh):
                self.refresh()

        def refresh(self):
            if self._closed or not callable(handler) or self._snapshot.get("paired") is not True:
                return
            if self._busy:
                self._needs_refresh = True
                return
            self._needs_refresh = False
            self._request("state", {"action": "randomizer_state", "matchup": self.matchup_select.currentText(),
                                    "gameKey": self._context[0] if self._context else None})

        def set_assistance_enabled(self, enabled, reason=None):
            changed = self._assistance != bool(enabled)
            self._assistance = bool(enabled)
            self._assistance_reason = reason or "Game assistance is off. Your matchup settings remain saved."
            if not self._assistance:
                self._explicit_roll = None
            self._render_result()
            if changed and self._assistance:
                self.refresh()

        def request_roll_now(self):
            if self._closed or not self._assistance or not self._context:
                return
            self._explicit_roll = self._context
            self._retry_at = 0
            self._drain()

        def shutdown(self):
            self._closed = True
            self.timer.stop()

        def _request(self, kind, payload):
            if self._closed:
                return
            self._busy = True
            self._status_error = False
            if kind == "settings":
                self._inflight_settings = payload
            self._render_result()
            context = self._context
            selected = self.matchup_select.currentText()
            revision = self._pool_revision

            def work():
                try:
                    answer = {"result": handler(dict(payload))}
                except Exception as error:
                    answer = {"error": str(error) if isinstance(error, CompanionError) else "The randomizer request failed. Refresh to try again."}
                try:
                    self.completed.emit({"kind": kind, "payload": payload, "context": context,
                                         "selected": selected, "revision": revision, **answer})
                except RuntimeError:
                    pass

            threading.Thread(target=work, name="companion-randomizer", daemon=True).start()

        def _completed(self, answer):
            if self._closed:
                return
            self._busy = False
            kind = answer["kind"]
            current = answer["context"] == self._context
            selected = answer["selected"] == self.matchup_select.currentText()
            result = answer.get("result")
            if "error" in answer:
                self._status_error = True
                if current:
                    self.status.setText(answer["error"])
                self._retry_at = time.monotonic() + 5
            elif isinstance(result, dict):
                self._status_error = False
                if kind in {"state", "settings"} and (kind == "settings" or (current and selected and not self._pending_settings)):
                    self._config = result.get("config") or {}
                    self._loaded = True
                if kind == "state" and current:
                    self._intent = result.get("intent") or {}
                    self._intent_context = self._context
                if kind == "roll" and current:
                    self._intent = result
                    self._intent_context = self._context
                if kind == "settings":
                    self.status.setText("Randomizer settings saved to your account.")
                    if "buildKeys" in answer["payload"] and selected and answer["revision"] == self._pool_revision:
                        self._pool_dirty = False
                    self._needs_refresh = True
                if kind == "state" and current and selected and not self._pending_settings:
                    self._render_pool(result.get("options") or {})
            self._inflight_settings = {}
            self._render_switch()
            self._render_result()
            self._drain()

        def _drain(self):
            if self._closed or self._busy:
                return
            if self._pending_settings:
                matchup = next(iter(self._pending_settings))
                updates = self._pending_settings.pop(matchup)
                self._request("settings", {"action": "randomizer_settings", "matchup": matchup, **updates})
            elif self._explicit_roll == self._context and self._context:
                if time.monotonic() < self._retry_at:
                    return
                if not self._assistance or self._intent.get("declared") or self._intent.get("randomizer"):
                    self._explicit_roll = None
                elif self._can_roll():
                    self._explicit_roll = None
                    self._roll(True)
                elif self._intent_context != self._context or not self._loaded:
                    self.refresh()
                else:
                    self._explicit_roll = None
            elif self._needs_refresh:
                self.refresh()
            elif time.monotonic() >= self._retry_at:
                self._maybe_roll()

        def _matchup_changed(self, _text):
            self._pool_dirty = False
            self._render_switch()
            self.refresh()

        def _matchup_config(self, matchup):
            matchups = self._config.get("matchups")
            source = matchups.get(matchup) if isinstance(matchups, dict) else None
            return source if isinstance(source, dict) else {}

        def _render_switch(self):
            matchup = self.matchup_select.currentText()
            config = self._matchup_config(matchup)
            inflight = self._inflight_settings if self._inflight_settings.get("matchup") == matchup else {}
            enabled = self._pending_settings.get(matchup, {}).get("enabled", inflight.get("enabled", config.get("enabled") is True))
            blocked = QtCore.QSignalBlocker(self.enabled_check)
            self.enabled_check.setChecked(enabled)
            del blocked
            self.enabled_check.setEnabled(self._loaded and self._snapshot.get("paired") is True)

        def _render_pool(self, options):
            if self._pool_dirty:
                return
            config = self._matchup_config(self.matchup_select.currentText())
            builds = config.get("builds") or []
            by_key = {build.get("id"): build for build in builds if isinstance(build, dict)}
            self._rendering = True
            self.pool.clear()
            for build in options.get("builds") or []:
                if not isinstance(build, dict) or not build.get("key"):
                    continue
                key = build["key"]
                weight = by_key.get(key, {}).get("weight", 1) if config.get("useCustomWeights") is True else 1
                item = QtWidgets.QTreeWidgetItem([str(build.get("name") or key), str(weight)])
                item.setData(0, QtCore.Qt.UserRole, key)
                item.setFlags(item.flags() | QtCore.Qt.ItemIsUserCheckable)
                item.setCheckState(0, QtCore.Qt.Checked if key in by_key else QtCore.Qt.Unchecked)
                self.pool.addTopLevelItem(item)
            self._rendering = False
            self.save_pool_button.setEnabled(False)
            if not self.pool.topLevelItemCount():
                self.status.setText("No eligible builds for this matchup. Refresh after adding a build to your account.")
            elif not self._context:
                self.status.setText("Choose your pool and enable this matchup. The next live match receives one shared pick.")

        def _pool_changed(self, _item, _column):
            if not self._rendering:
                self._pool_dirty = True
                self._pool_revision += 1
                self.save_pool_button.setEnabled(True)

        def _enabled_changed(self, enabled):
            matchup = self.matchup_select.currentText()
            self._pending_settings.setdefault(matchup, {})["enabled"] = enabled
            self.status.setText("Saving randomizer setting…")
            self._render_result()
            self._drain()

        def _save_pool(self):
            keys = [self.pool.topLevelItem(index).data(0, QtCore.Qt.UserRole)
                    for index in range(self.pool.topLevelItemCount())
                    if self.pool.topLevelItem(index).checkState(0) == QtCore.Qt.Checked]
            matchup = self.matchup_select.currentText()
            self._pending_settings.setdefault(matchup, {})["buildKeys"] = keys
            self.status.setText("Saving selected pool…")
            self.save_pool_button.setEnabled(False)
            self._drain()

        def _can_roll(self):
            if self._closed or self._busy or not self._assistance or not self._context or self._pending_settings:
                return False
            config = self._matchup_config(self._context[1])
            return bool(config.get("enabled") is True and config.get("builds")
                        and self._intent_context == self._context
                        and self._intent.get("gameKey") in {None, self._context[0]}
                        and not self._intent.get("declared") and not self._intent.get("randomizer")
                        and not self._intent.get("gameId"))

        def _render_result(self):
            self.roll_button.setEnabled(self._can_roll())
            if not self._context:
                self.result_label.setText("No build has been drawn for the current game.")
            elif self._intent.get("declared"):
                self.result_label.setText("Declared build · " + str(self._intent["declared"].get("name") or "Your chosen build"))
            elif self._intent.get("randomizer"):
                self.result_label.setText("Shared pick · " + str(self._intent["randomizer"].get("name") or "Saved build"))
            else:
                self.result_label.setText("No build has been drawn for the current game.")
            if not self._assistance:
                self.status.setText(self._assistance_reason)
            elif not self._status_error and not self._busy:
                if self._intent.get("declared"):
                    self.status.setText("Your declared plan takes priority. No random draw replaces it.")
                elif self._intent.get("randomizer"):
                    self.status.setText("This game's saved pick is shared by every connected display.")
                elif self._loaded and self._context and self._matchup_config(self._context[1]).get("enabled") is not True:
                    self.status.setText("The randomizer is off for this matchup. Your saved pool is kept.")

        def _maybe_roll(self):
            if not self._can_roll():
                return
            envelope = self._snapshot.get("liveGame") or {}
            if envelope.get("phase") == "match_loading":
                prefs = self._intent.get("prefs") or {}
                if self._intent.get("holdRemainingMs", 0) > 0 or (prefs.get("enabled") is not False and prefs.get("askAtLoading") is not False):
                    self.status.setText("Waiting for the loading check-in. Choose Roll now or wait for the match to start.")
                    return
            self._roll(False)

        def _roll(self, release_hold):
            if not self._can_roll() or randomizer_context(self._snapshot) != self._context:
                return
            self.status.setText("Drawing the shared build…")
            self._request("roll", {"action": "randomizer_roll", "gameKey": self._context[0],
                                   "matchup": self._context[1], "releaseHold": release_hold})

    return CompanionRandomizer()
