"""Native stream studio. Qt imports stay lazy for headless agent installs."""
from __future__ import annotations

import threading
import webbrowser
import re
import copy
from collections import Counter

CATALOG_PLACEHOLDERS = {
    "idle": "Connect YouTube first", "loading": "Loading…",
    "failed": "Not loaded — press Refresh keys", "retrying": "Not loaded yet — retrying…",
    "ready": "Choose…",
}
DEFAULT_STREAM_DESCRIPTION = "Live StarCraft II games, ranked matches, and practice.\n\nThanks for watching! Join the chat and enjoy the stream."


def _WheelGuard(QtCore, parent):
    class WheelGuard(QtCore.QObject):
        """Ignore wheel events on unfocused dropdowns so page scrolling never edits a choice."""
        def eventFilter(self, watched, event):
            if event.type() == QtCore.QEvent.Wheel and not watched.hasFocus():
                event.ignore()
                return True
            return False
    return WheelGuard(parent)


def build_streams_page(parent, *, provider, handler, QtCore, QtWidgets):
    class StreamsPage(QtWidgets.QScrollArea):
        completed = QtCore.Signal(dict)

        def __init__(self):
            super().__init__(parent)
            self.setObjectName("streamStudio")
            self.setWidgetResizable(True)
            self.setFrameShape(QtWidgets.QFrame.NoFrame)
            self.setHorizontalScrollBarPolicy(QtCore.Qt.ScrollBarAlwaysOff)
            self.busy = False
            self.title_dirty = False
            self.description_dirty = False
            self.description_draft = False
            self.setup_dirty = False
            self.setup_edits = set()
            self.loaded = False
            self.state = {}
            self.action_buttons = []
            self.platform_labels = {}
            self.platform_badges = {}
            self.format_labels = {}
            self.format_connect_buttons = {}
            self.format_phases = {}
            self.format_links = {}
            self._obs_identity = None
            self._obs_generation = 0
            self._obs_account_mode = None
            self.setWidget(self._content())
            self.completed.connect(self._completed)
            self.timer = QtCore.QTimer(self)
            self.timer.setInterval(2000)
            self.timer.timeout.connect(self.refresh)
            self.timer.start()
            self.refresh()

        def _label(self, text, muted=False, *, name=None):
            label = QtWidgets.QLabel(text)
            label.setWordWrap(name not in {"studioEyebrow", "studioCounter", "studioDestinationTitle", "h1", "h2"})
            label.setTextFormat(QtCore.Qt.PlainText)
            if name or muted:
                label.setObjectName(name or "muted")
            return label

        def _button(self, text, callback, *, primary=False, quiet=False):
            button = QtWidgets.QPushButton(text)
            button.setCursor(QtCore.Qt.PointingHandCursor)
            if primary or quiet:
                button.setObjectName("primary" if primary else "quietButton")
            button.clicked.connect(callback)
            self.action_buttons.append(button)
            return button

        def _card(self, name="studioCard"):
            card = QtWidgets.QFrame()
            card.setObjectName(name)
            layout = QtWidgets.QVBoxLayout(card)
            layout.setContentsMargins(18, 14, 18, 14)
            layout.setSpacing(8)
            return card, layout

        def _badge(self, text):
            label = self._label(text, name="studioBadge")
            label.setWordWrap(False)
            label.setAlignment(QtCore.Qt.AlignCenter)
            label.setProperty("tone", "neutral")
            label.setSizePolicy(QtWidgets.QSizePolicy.Maximum, QtWidgets.QSizePolicy.Fixed)
            return label

        def _set_badge(self, label, text, tone="neutral"):
            label.setText(text)
            if label.property("tone") != tone:
                label.setProperty("tone", tone)
                label.style().unpolish(label)
                label.style().polish(label)

        def _disclosure(self, title, detail):
            container = QtWidgets.QWidget()
            container.setObjectName("studioTransparent")
            layout = QtWidgets.QVBoxLayout(container)
            layout.setContentsMargins(0, 0, 0, 0)
            layout.setSpacing(8)
            toggle = QtWidgets.QToolButton()
            toggle.setObjectName("studioDisclosureToggle")
            toggle.setText(title + "  ·  " + detail)
            toggle.setToolButtonStyle(QtCore.Qt.ToolButtonTextBesideIcon)
            toggle.setArrowType(QtCore.Qt.RightArrow)
            toggle.setCheckable(True)
            toggle.setCursor(QtCore.Qt.PointingHandCursor)
            toggle.setSizePolicy(QtWidgets.QSizePolicy.Expanding, QtWidgets.QSizePolicy.Fixed)
            body, body_layout = self._card()
            body.setVisible(False)
            def toggled(opened):
                body.setVisible(opened)
                toggle.setArrowType(QtCore.Qt.DownArrow if opened else QtCore.Qt.RightArrow)
            toggle.toggled.connect(toggled)
            layout.addWidget(toggle)
            layout.addWidget(body)
            return container, toggle, body, body_layout

        def _content(self):
            content = QtWidgets.QWidget()
            content.setObjectName("studioContent")
            layout = QtWidgets.QVBoxLayout(content)
            layout.setContentsMargins(28, 24, 28, 24)
            layout.setSpacing(14)
            heading = QtWidgets.QHBoxLayout()
            heading.addWidget(self._label("Streams", name="h1"))
            heading.addStretch()
            heading.addWidget(self._label("SC2TOOLS  /  STREAM STUDIO", name="studioEyebrow"))
            layout.addLayout(heading)

            command, command_layout = self._card("studioCommand")
            label_row = QtWidgets.QHBoxLayout()
            label_row.addWidget(self._label("ONE TITLE. EVERY DESTINATION.", name="studioEyebrow"))
            label_row.addStretch()
            self.counter = self._label("0 / 70", name="studioCounter")
            label_row.addWidget(self.counter)
            command_layout.addLayout(label_row)
            self.title_input = QtWidgets.QLineEdit()
            self.title_input.setObjectName("streamTitle")
            self.title_input.setMaxLength(70)
            self.title_input.setPlaceholderText("Give your next stream a title")
            self.title_input.setMinimumHeight(44)
            self.title_input.textEdited.connect(self._title_edited)
            self.title_input.returnPressed.connect(self.save_title)
            command_layout.addWidget(self.title_input)
            description_header = QtWidgets.QHBoxLayout()
            self.description_label = self._label("YouTube description", name="studioEyebrow")
            self.description_scope = self._label("Applies to both YouTube formats", True)
            description_header.addWidget(self.description_label)
            description_header.addWidget(self.description_scope, 1)
            command_layout.addLayout(description_header)
            self.description_input = QtWidgets.QPlainTextEdit()
            self.description_input.setObjectName("streamDescription")
            self.description_input.setFixedHeight(112)
            self.description_input.textChanged.connect(self._description_edited)
            command_layout.addWidget(self.description_input)
            self.description_link_note = self._label("The vertical-to-horizontal watch link is added automatically.", True)
            command_layout.addWidget(self.description_link_note)
            actions = QtWidgets.QHBoxLayout()
            actions.setSpacing(10)
            self.save_button = self._button("Save title & description", self.save_title, primary=True)
            self.prepare_button = self._button("Prepare YouTube session", lambda: self.job({"action": "prepare"}))
            self.prepare_button.setToolTip("Save your title, description and YouTube setup, then prepare both destinations before starting Aitum.")
            actions.addWidget(self.save_button)
            actions.addWidget(self.prepare_button)
            actions.addStretch()
            actions.addWidget(self._label("YouTube · Twitch · Kick", True))
            command_layout.addLayout(actions)
            self.notice = self._label("Loading stream settings…", name="studioNotice")
            command_layout.addWidget(self.notice)
            layout.addWidget(command)

            youtube_section = QtWidgets.QVBoxLayout()
            youtube_section.setSpacing(8)
            youtube_header = QtWidgets.QHBoxLayout()
            youtube_header.addWidget(self._label("YouTube destinations", name="h2"))
            youtube_header.addStretch()
            self.import_google_button = self._button("Import Google client…", self.import_google, quiet=True)
            youtube_header.addWidget(self.import_google_button)
            self.refresh_accounts_button = self._button("Refresh connections", lambda: self.job({"action": "refresh_accounts"}), quiet=True)
            youtube_header.addWidget(self.refresh_accounts_button)
            self.youtube_setup_button = QtWidgets.QPushButton("Setup")
            self.youtube_setup_button.setObjectName("quietButton")
            self.youtube_setup_button.setCursor(QtCore.Qt.PointingHandCursor)
            self.youtube_setup_button.clicked.connect(self.open_setup)
            youtube_header.addWidget(self.youtube_setup_button)
            self.youtube_connect_button = self._button("Connect YouTube", lambda: self.job({"action": "connect_youtube"}), quiet=True)
            youtube_header.addWidget(self.youtube_connect_button)
            youtube_section.addLayout(youtube_header)
            self.platform_labels["youtube"] = self._label("YouTube · connection required", True)
            youtube_section.addWidget(self.platform_labels["youtube"])
            destinations = QtWidgets.QHBoxLayout()
            destinations.setSpacing(14)
            for scope, title, canvas, ratio in (
                ("horizontal", "Horizontal", "OBS main canvas", "16:9"),
                ("portrait", "Vertical", "OBS vertical canvas", "9:16"),
            ):
                card, card_layout = self._card("studioDestination")
                row = QtWidgets.QHBoxLayout()
                row.setSpacing(12)
                marker = self._label(ratio, name="canvasLandscape" if scope == "horizontal" else "canvasPortrait")
                marker.setAlignment(QtCore.Qt.AlignCenter)
                marker.setFixedSize(54, 32) if scope == "horizontal" else marker.setFixedSize(28, 40)
                marker_box = QtWidgets.QWidget()
                marker_box.setObjectName("studioTransparent")
                marker_box.setFixedWidth(58)
                marker_layout = QtWidgets.QHBoxLayout(marker_box)
                marker_layout.setContentsMargins(0, 0, 0, 0)
                marker_layout.addWidget(marker, 0, QtCore.Qt.AlignCenter)
                row.addWidget(marker_box)
                names = QtWidgets.QVBoxLayout()
                names.setSpacing(3)
                names.addWidget(self._label(title, name="studioDestinationTitle"))
                names.addWidget(self._label(canvas, True))
                row.addLayout(names, 1)
                self.format_labels[scope] = self._badge("Setup needed")
                row.addWidget(self.format_labels[scope], 0, QtCore.Qt.AlignTop)
                connect = self._button(
                    "Connect YouTube",
                    lambda _checked=False, key=scope: self.connect_youtube(key),
                    quiet=True,
                )
                connect.setToolTip("Connect your YouTube account in your browser.")
                connect.setVisible(False)
                self.format_connect_buttons[scope] = connect
                row.addWidget(connect, 0, QtCore.Qt.AlignTop)
                card_layout.addLayout(row)
                footer = QtWidgets.QHBoxLayout()
                footer.addWidget(self._label("Reusable key · separate link & chat", True), 1)
                view = QtWidgets.QPushButton("View ↗")
                view.setObjectName("quietButton")
                view.setCursor(QtCore.Qt.PointingHandCursor)
                view.clicked.connect(lambda _checked=False, key=scope: self.view_stream(key))
                view.setEnabled(False)
                self.format_links[scope] = view
                footer.addWidget(view)
                card_layout.addLayout(footer)
                destinations.addWidget(card, 1)
            youtube_section.addLayout(destinations)
            session_row = QtWidgets.QHBoxLayout()
            session_row.setSpacing(8)
            self.auto_label = self._label("Next session: manual", True)
            session_row.addWidget(self.auto_label, 1)
            session_row.addWidget(self._button("Check / recover", lambda: self.job({"action": "recover"}), quiet=True))
            self.pause_auto_button = self._button("Pause auto", lambda: self.job({"action": "pause_auto"}), quiet=True)
            self.resume_auto_button = self._button("Enable auto", lambda: self.job({"action": "resume_auto"}), quiet=True)
            session_row.addWidget(self.pause_auto_button)
            session_row.addWidget(self.resume_auto_button)
            youtube_section.addLayout(session_row)
            youtube_section.addWidget(self._label("Start the two YouTube Output buttons in Aitum when both destinations show Ready.", True))
            layout.addLayout(youtube_section)

            accounts = QtWidgets.QHBoxLayout()
            accounts.setSpacing(14)
            for platform in ("twitch", "kick"):
                card, account_layout = self._card()
                row = QtWidgets.QHBoxLayout()
                text = QtWidgets.QVBoxLayout()
                text.setSpacing(4)
                title_row = QtWidgets.QHBoxLayout()
                title_row.addWidget(self._label(platform.title(), name="h2"))
                self.platform_badges[platform] = self._badge("Not connected")
                title_row.addWidget(self.platform_badges[platform])
                title_row.addStretch()
                text.addLayout(title_row)
                self.platform_labels[platform] = self._label("Connect your streaming account", True)
                text.addWidget(self.platform_labels[platform])
                row.addLayout(text, 1)
                row.addWidget(self._button("Connect", lambda _checked=False, name=platform: self.connect_platform(name), quiet=True))
                account_layout.addLayout(row)
                accounts.addWidget(card, 1)
            layout.addLayout(accounts)

            setup_section, self.setup_toggle, self.setup_box, setup_layout = self._disclosure("YouTube setup", "Channel, keys & session options")
            setup = QtWidgets.QFormLayout()
            setup.setHorizontalSpacing(18)
            setup.setVerticalSpacing(12)
            setup.setFieldGrowthPolicy(QtWidgets.QFormLayout.AllNonFixedFieldsGrow)
            self.channel_combo = QtWidgets.QComboBox()
            self.horizontal_combo = QtWidgets.QComboBox()
            self.portrait_combo = QtWidgets.QComboBox()
            for combo in (self.channel_combo, self.horizontal_combo, self.portrait_combo):
                combo.addItem("Choose…", None)
            setup.addRow("Channel", self.channel_combo)
            setup.addRow("Horizontal reusable key", self.horizontal_combo)
            setup.addRow("Vertical reusable key", self.portrait_combo)
            self.catalog_note = self._label("Connect YouTube to load your channel and reusable keys.", True)
            setup.addRow("", self.catalog_note)
            self.privacy = QtWidgets.QComboBox()
            for text, data in (("Choose visibility…", None), ("Unlisted (for testing)", "unlisted"), ("Private", "private"), ("Public", "public")):
                self.privacy.addItem(text, data)
            setup.addRow("Visibility", self.privacy)
            self.audience = QtWidgets.QComboBox()
            self.audience.addItem("Choose audience setting…", None)
            self.audience.addItem("No, not made for kids", False)
            self.audience.addItem("Yes, made for kids", True)
            setup.addRow("Audience", self.audience)
            self.auto_check = QtWidgets.QCheckBox("Prepare the next pair automatically after both streams end")
            self.auto_check.setChecked(False)
            setup.addRow(self.auto_check)
            from ..streaming.obs_reader import DEFAULT_OUTPUTS
            self.output_inputs = {}
            for scope, text in (("horizontal", "OBS horizontal output name"), ("portrait", "OBS vertical output name")):
                field = QtWidgets.QLineEdit(DEFAULT_OUTPUTS[scope])
                self.output_inputs[scope] = field
                setup.addRow(text, field)
            setup_layout.addLayout(setup)
            setup_actions = QtWidgets.QHBoxLayout()
            setup_actions.addWidget(self._button("Refresh keys", lambda: self.job({"action": "refresh_keys"})))
            setup_actions.addWidget(self._button("Save YouTube setup", self.configure, primary=True))
            setup_actions.addStretch()
            setup_layout.addLayout(setup_actions)
            self.connection_note = self._label("Authorize your accounts through SC2Tools once. Provider credentials stay on the server.", True)
            setup_layout.addWidget(self.connection_note)
            account_actions = QtWidgets.QHBoxLayout()
            self.local_setup_button = self._button("Advanced local setup…", self.change_connection_mode, quiet=True)
            account_actions.addWidget(self.local_setup_button)
            account_actions.addStretch()
            setup_layout.addLayout(account_actions)
            layout.addWidget(setup_section)

            obs_section, self.obs_toggle, self.obs_box, obs_layout = self._disclosure("OBS connection details", "Server & key for the selected YouTube destination")
            obs_layout.addWidget(self._label("Save your channel and both reusable keys with Save YouTube setup first. Then choose a destination and Fetch its server and key for the matching Aitum output in OBS.", True))
            obs_form = QtWidgets.QFormLayout()
            self.obs_destination = QtWidgets.QComboBox()
            self.obs_destination.addItem("Horizontal", "horizontal")
            self.obs_destination.addItem("Vertical", "portrait")
            obs_form.addRow("Destination", self.obs_destination)
            self.obs_selected_key = self._label("Save your YouTube setup first.", True)
            obs_form.addRow("Reusable key", self.obs_selected_key)
            self.obs_output_name = self._label("", True)
            obs_form.addRow("OBS / Aitum output", self.obs_output_name)
            self.obs_server = QtWidgets.QLineEdit()
            self.obs_server.setReadOnly(True)
            obs_form.addRow("Server URL", self.obs_server)
            self.obs_key = QtWidgets.QLineEdit()
            self.obs_key.setReadOnly(True)
            self.obs_key.setEchoMode(QtWidgets.QLineEdit.Password)
            obs_form.addRow("Stream key", self.obs_key)
            obs_layout.addLayout(obs_form)
            obs_actions = QtWidgets.QHBoxLayout()
            self.obs_fetch_button = self._button("Fetch connection details", self.fetch_obs_connection)
            self.obs_copy_server = QtWidgets.QPushButton("Copy server")
            self.obs_copy_key = QtWidgets.QPushButton("Copy key")
            for button, field, message in (
                (self.obs_copy_server, self.obs_server, "Server URL copied."),
                (self.obs_copy_key, self.obs_key, "Stream key copied. Paste it into the selected OBS output."),
            ):
                button.setObjectName("quietButton")
                button.setCursor(QtCore.Qt.PointingHandCursor)
                button.clicked.connect(lambda _checked=False, item=field, text=message: self.copy_obs_detail(item, text))
            self.obs_reveal = QtWidgets.QCheckBox("Reveal key")
            self.obs_reveal.toggled.connect(lambda checked: self.obs_key.setEchoMode(QtWidgets.QLineEdit.Normal if checked else QtWidgets.QLineEdit.Password))
            for control in (self.obs_fetch_button, self.obs_copy_server, self.obs_copy_key, self.obs_reveal):
                obs_actions.addWidget(control)
            obs_actions.addStretch()
            obs_layout.addLayout(obs_actions)
            self.obs_note = self._label("Connection details appear only after Fetch; the key stays hidden until you reveal or copy it.", True)
            obs_layout.addWidget(self.obs_note)
            self.obs_destination.currentIndexChanged.connect(self._obs_selection_changed)
            self.obs_toggle.toggled.connect(lambda opened: None if opened else self._clear_obs_connection())
            layout.addWidget(obs_section)

            layout.addStretch()
            # Scrolling the page over an unfocused dropdown must never change a
            # saved choice (channel, key, visibility, audience, destination).
            self._wheel_guard = _WheelGuard(QtCore, self)
            for combo in (self.channel_combo, self.horizontal_combo, self.portrait_combo, self.privacy, self.audience, self.obs_destination):
                combo.setFocusPolicy(QtCore.Qt.StrongFocus)
                combo.installEventFilter(self._wheel_guard)
            for combo, key in ((self.channel_combo, "channel_id"), (self.horizontal_combo, "horizontal_id"), (self.portrait_combo, "portrait_id"), (self.privacy, "privacy"), (self.audience, "made_for_kids")):
                combo.currentIndexChanged.connect(lambda _index, name=key: self._setup_edited(name))
            self.auto_check.toggled.connect(lambda _checked: self._setup_edited("auto_rearm"))
            for scope, field in self.output_inputs.items():
                field.textEdited.connect(lambda _text, name=scope: self._setup_edited("output_" + name))
            return content

        def _setup_edited(self, field=None):
            self.setup_dirty = True
            if field:
                self.setup_edits.add(field)
            else:
                self.setup_edits.update(("channel_id", "horizontal_id", "portrait_id", "privacy", "made_for_kids", "auto_rearm"))
            self._suggest_catalog_choices()
            self._clear_obs_connection()
            self._buttons()

        def open_setup(self):
            self.setup_toggle.setChecked(True)
            self.ensureWidgetVisible(self.setup_toggle, 0, 12)

        def _title_edited(self):
            self.title_dirty = True
            self.counter.setText(f"{len(self.title_input.text())} / 70")
            self._buttons()

        def _description_edited(self):
            self.description_dirty = True
            self.description_draft = False
            self._buttons()

        def _buttons(self):
            enabled = not self.busy and handler is not None and self.loaded
            for button in self.action_buttons:
                button.setEnabled(enabled)
            for field in (self.title_input, self.description_input, self.channel_combo, self.horizontal_combo, self.portrait_combo, self.privacy, self.audience, self.auto_check, *self.output_inputs.values()):
                field.setEnabled(not self.busy)
            self.save_button.setEnabled(enabled and bool(self.title_input.text().strip()))
            youtube = self.state.get("youtube", {})
            for scope, button in self.format_connect_buttons.items():
                button.setEnabled(enabled and self.format_phases.get(scope) == "authorization_required")
            self.prepare_button.setEnabled(enabled and not self.title_dirty and not self.description_dirty and not self.setup_dirty and youtube.get("connected", False) and self.state.get("configured", False))
            self.obs_fetch_button.setEnabled(enabled and self._obs_selection() is not None)
            details_available = not self.busy and self._obs_identity == self._obs_selection() and bool(self.obs_key.text())
            self.obs_copy_server.setEnabled(details_available)
            self.obs_copy_key.setEnabled(details_available)
            self.obs_reveal.setEnabled(details_available)
            self.obs_destination.setEnabled(not self.busy)

        def refresh(self):
            if provider is None:
                self._clear_obs_connection()
                self.notice.setText("Stream controls are unavailable in this session. Restart SC2Tools to reconnect.")
                self._buttons()
                return
            try:
                state = provider()
                if self.busy:
                    if state.get("auth_prompt"):
                        self.notice.setText(state["auth_prompt"])
                    return
                self.render(state)
            except Exception:
                self._clear_obs_connection()
                self.notice.setText("Stream controls are unavailable. Restart SC2Tools to reconnect.")

        def render(self, state):
            if state.get("account_mode") != self._obs_account_mode:
                self._clear_obs_connection()
            self._obs_account_mode = state.get("account_mode")
            self.state = state
            metadata = state.get("metadata", {})
            if not self.title_dirty:
                self.title_input.setText(metadata.get("title", ""))
                self.counter.setText(f"{len(self.title_input.text())} / 70")
            saved_description = "description" in metadata and state.get("metadata_saved") is not False
            if not self.description_dirty or self.description_draft and saved_description:
                blocked = self.description_input.blockSignals(True)
                description = metadata.get("description")
                draft = not description and (state.get("metadata_saved") is False or "description" not in metadata)
                self.description_input.setPlainText(DEFAULT_STREAM_DESCRIPTION if draft else description or "")
                self.description_input.blockSignals(blocked)
                self.description_dirty = draft
                self.description_draft = draft
            self.loaded = True
            self.notice.setText(state.get("message", "Check your stream connections."))
            youtube = state.get("youtube", {})
            youtube_text = "YouTube · " + ("connected" if youtube.get("connected") else "connection required")
            results = state.get("platform_results", {})
            if "youtube" in results:
                youtube_text += " · " + results["youtube"].get("message", "Not verified")
            self.platform_labels["youtube"].setText(youtube_text)
            self.platform_labels["youtube"].setVisible(youtube.get("connected") is True or "youtube" in results)
            local = state.get("account_mode", "local") == "local"
            self.import_google_button.setVisible(local)
            self.local_setup_button.setVisible(True)
            self.local_setup_button.setText("Use SC2Tools connections" if local else "Advanced local setup…")
            self.refresh_accounts_button.setVisible(not local)
            self.connection_note.setText("Advanced local setup: use OAuth apps you own. Connections are encrypted for your Windows account." if local else "Authorize through SC2Tools once. Streaming-account credentials stay on the server; the agent uses your paired SC2Tools account.")
            labels = {"authorization_required": "Connect YouTube", "idle": "Waiting", "bound": "Ready", "ready": "Ready", "starting": "Starting", "stopping": "Finishing", "live": "Live", "complete": "Finished", "blocked": "Needs attention", "disabled": "Setup required"}
            for scope in self.format_labels:
                row = youtube.get("channels", {}).get(scope, {})
                phase = row.get("display_phase") or (row.get("lifecycle") if row.get("lifecycle") in {"live", "complete"} else row.get("phase", youtube.get("phase", "idle")))
                if not youtube.get("connected"):
                    phase = "authorization_required"
                if youtube.get("code") not in {None, "ok", "template_saved"} and youtube.get("phase") not in {"authorization_required", "disabled", "idle"}:
                    phase = "blocked"
                self.format_phases[scope] = phase
                connection_required = phase == "authorization_required"
                self.format_labels[scope].setVisible(not connection_required)
                self.format_connect_buttons[scope].setVisible(connection_required)
                tone = "live" if phase == "live" else "good" if phase in {"ready", "bound"} else "warning" if phase in {"starting", "stopping", "blocked"} else "neutral"
                text = labels.get(phase, phase.replace("_", " ").title())
                if phase in {"idle", "disabled"}:
                    text = "Prepare session" if state.get("configured") else "Setup needed"
                self._set_badge(self.format_labels[scope], text, tone)
                self.format_links[scope].setEnabled(bool(row.get("url")))
            auto = state.get("configuration", {}).get("auto_rearm") is True
            auto_text = "automatic · armed" if youtube.get("auto_rearm_enabled") else "automatic · prepare the first pair" if auto else "manual"
            self.auto_label.setText("Next session: " + auto_text)
            self.pause_auto_button.setVisible(auto)
            self.resume_auto_button.setVisible(not auto)
            for name in ("twitch", "kick"):
                status = state.get("platforms", {}).get(name, {})
                connected = status.get("connected") is True
                self._set_badge(self.platform_badges[name], "Connected" if connected else "Not connected", "good" if connected else "neutral")
                text = status.get("account") or ("Title controls ready" if connected else "Connect your streaming account")
                if name in results:
                    text += " · " + results[name].get("message", "Not verified")
                self.platform_labels[name].setText(text)
            catalog = state.get("catalog", {})
            if catalog != getattr(self, "last_catalog", None):
                self.last_catalog = copy.deepcopy(catalog)
                for combo, rows in ((self.channel_combo, catalog.get("channels", [])), (self.horizontal_combo, catalog.get("streams", [])), (self.portrait_combo, catalog.get("streams", []))):
                    selected = combo.currentData()
                    selected_text = combo.currentText()
                    blocked = combo.blockSignals(True)
                    combo.clear()
                    combo.addItem("Choose…", None)
                    for row in rows:
                        combo.addItem(row["title"], row["id"])
                    index = combo.findData(selected)
                    if index < 0 and selected is not None and self.setup_dirty:
                        combo.addItem(selected_text, selected)
                        index = combo.findData(selected)
                    if index >= 0:
                        combo.setCurrentIndex(index)
                    combo.blockSignals(blocked)
            self._render_catalog_status(state, youtube)
            if not self.setup_dirty:
                config = state.get("configuration", {})
                for combo, key in ((self.channel_combo, "channel_id"), (self.horizontal_combo, "horizontal_id"), (self.portrait_combo, "portrait_id"), (self.privacy, "privacy"), (self.audience, "made_for_kids")):
                    blocked = combo.blockSignals(True)
                    value = config.get(key)
                    if value is None and key in {"privacy", "made_for_kids"}:
                        value = "public" if key == "privacy" else False
                    index = combo.findData(value)
                    if index < 0 and isinstance(value, str) and value and key in {"channel_id", "horizontal_id", "portrait_id"}:
                        label = "Unavailable saved channel" if key == "channel_id" else "Unavailable saved key"
                        combo.addItem(label + " · " + value, value)
                        index = combo.findData(value)
                    if index >= 0:
                        combo.setCurrentIndex(index)
                    combo.blockSignals(blocked)
                blocked = self.auto_check.blockSignals(True)
                self.auto_check.setChecked(True if config.get("auto_rearm") is None else config.get("auto_rearm") is True)
                self.auto_check.blockSignals(blocked)
                for scope, field in self.output_inputs.items():
                    field.setText(config.get("output_names", {}).get(scope, field.text()))
            self._suggest_catalog_choices()
            self._sync_obs_details()
            self._buttons()

        def _suggest_catalog_choices(self):
            """Fill unambiguous form choices without saving or replacing edits."""
            state = self.state
            catalog = state.get("catalog", {})
            config = state.get("configuration", {})

            def choose(combo, value):
                index = combo.findData(value)
                if index >= 0:
                    blocked = combo.blockSignals(True)
                    combo.setCurrentIndex(index)
                    combo.blockSignals(blocked)

            channels = {row.get("id") for row in catalog.get("channels", []) if row.get("id")}
            if self.channel_combo.currentData() is None and "channel_id" not in self.setup_edits and not config.get("channel_id") and len(channels) == 1:
                choose(self.channel_combo, next(iter(channels)))
            channel = self.channel_combo.currentData()
            if not channel or channel not in channels:
                return

            def eligible(row):
                status = row.get("status") or {}
                return (row.get("channel_id") in {None, channel}
                    and not any(row.get(key) is False for key in ("eligible", "selectable", "available"))
                    and row.get("bound_elsewhere") is not True and not row.get("bound_broadcast_id")
                    and row.get("stream_status", status.get("streamStatus") if isinstance(status, dict) else None) != "active")

            inventory = catalog.get("streams", [])
            counts = Counter(row.get("id") for row in inventory)
            rows = [row for row in inventory if row.get("id") and counts[row["id"]] == 1 and eligible(row)]
            roles = {}
            for row in rows:
                title = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", row.get("title", "")).lower()
                horizontal = bool(re.search(r"\b(horizontal|landscape)\b", title))
                portrait = bool(re.search(r"\b(vertical|portrait)\b", title))
                roles[row["id"]] = "horizontal_id" if horizontal and not portrait else "portrait_id" if portrait and not horizontal else None
            combos = {"horizontal_id": self.horizontal_combo, "portrait_id": self.portrait_combo}
            for key in ("horizontal_id", "portrait_id") * 2:
                combo = combos[key]
                other = combos["portrait_id" if key == "horizontal_id" else "horizontal_id"].currentData()
                if key in self.setup_edits or config.get(key):
                    continue
                eligible_ids = {row["id"] for row in rows}
                if combo.currentData() is not None and (combo.currentData() == other or combo.currentData() not in eligible_ids):
                    choose(combo, None)
                if combo.currentData() is not None:
                    continue
                candidates = {row["id"] for row in rows if row["id"] != other}
                named = {identity for identity in candidates if roles.get(identity) == key}
                if len(named) == 1:
                    choose(combo, next(iter(named)))
                elif other is not None and len(candidates) == 1:
                    identity = next(iter(candidates))
                    if roles.get(identity) in {None, key}:
                        choose(combo, identity)

        def _render_catalog_status(self, state, youtube):
            status = state.get("catalog_status") or {}
            connected = youtube.get("connected") is True
            catalog = state.get("catalog", {})
            phase = status.get("state") if connected else "idle"
            if phase == "failed" and status.get("retry_pending") is True:
                phase = "retrying"
            if phase not in CATALOG_PLACEHOLDERS:
                phase = "ready" if catalog.get("channels") else "idle"
            placeholder = CATALOG_PLACEHOLDERS[phase]
            key_placeholder = "No reusable keys found" if phase == "ready" and not catalog.get("streams") else placeholder
            for combo, text in ((self.channel_combo, placeholder), (self.horizontal_combo, key_placeholder), (self.portrait_combo, key_placeholder)):
                if combo.count() and combo.itemText(0) != text:
                    combo.setItemText(0, text)
            if not connected:
                note = "Connect YouTube to load your channel and reusable keys."
            else:
                note = status.get("message") if isinstance(status.get("message"), str) else ""
            self.catalog_note.setText(note)
            self.catalog_note.setVisible(bool(note))

        def job(self, payload):
            if self.busy or handler is None:
                return
            if payload["action"] in {"connect_youtube", "refresh_keys", "refresh_accounts", "use_local_connections", "use_sc2tools_connections"}:
                self._clear_obs_connection()
            self.busy = True
            message = "Connecting in your browser…" if payload["action"].startswith("connect_") else "Saving / checking stream settings…"
            if payload["action"] == "prepare":
                message = "Preparing both YouTube formats… Wait until both show Ready before starting the Aitum outputs."
            self.notice.setText(message)
            self._buttons()
            obs_generation = self._obs_generation
            def work():
                try:
                    value = handler(payload)
                    if payload["action"] == "fetch_obs_connection":
                        result = {"obs_connection": value.get("obs_connection"), "action": payload["action"], "obs_generation": obs_generation}
                    else:
                        result = {"state": value, "action": payload["action"]}
                except ValueError as error:
                    message = "OBS connection details could not be verified. Refresh connections and fetch the selected destination again." if payload["action"] == "fetch_obs_connection" else str(error)
                    result = {"error": message, "action": payload["action"]}
                except Exception:
                    result = {"error": "The action did not complete. Check your connection and setup, then try again.", "action": payload["action"]}
                self.completed.emit(result)
            threading.Thread(target=work, name="sc2tools-stream-action", daemon=True).start()

        def _completed(self, result):
            self.busy = False
            if result.get("action") == "fetch_obs_connection" and "obs_connection" in result:
                self.refresh()
                self._accept_obs_connection(result)
            elif "state" in result:
                if result["action"] == "set_metadata":
                    self.title_dirty = self.description_dirty = False
                    self.description_draft = False
                if result["action"] == "configure_youtube":
                    self.setup_dirty = False
                    self.setup_edits.clear()
                self.render(result["state"])
            else:
                self.notice.setText(result.get("error", "Could not verify the operation."))
            self._buttons()

        def save_title(self):
            if not self.save_button.isEnabled():
                return
            self.job({"action": "set_metadata", "title": self.title_input.text(), "description": self.description_input.toPlainText()})

        def connect_youtube(self, scope):
            if self.loaded and not self.busy and self.format_phases.get(scope) == "authorization_required":
                self.job({"action": "connect_youtube"})

        def _obs_selection(self):
            config = self.state.get("configuration", {})
            scope = self.obs_destination.currentData()
            stream_id = config.get("horizontal_id" if scope == "horizontal" else "portrait_id")
            channel = config.get("channel_id")
            if not self.state.get("configured") or not self.state.get("youtube", {}).get("connected") or scope not in {"horizontal", "portrait"} or not channel or not stream_id:
                return None
            combo = self.horizontal_combo if scope == "horizontal" else self.portrait_combo
            if self.channel_combo.currentData() != channel or combo.currentData() != stream_id:
                return None
            return {"scope": scope, "expected_channel_id": channel, "stream_id": stream_id}

        def _clear_obs_connection(self):
            self._obs_identity = None
            self._obs_generation += 1
            self.obs_key.clear()
            self.obs_server.clear()
            self.obs_key.setEchoMode(QtWidgets.QLineEdit.Password)
            blocked = self.obs_reveal.blockSignals(True)
            self.obs_reveal.setChecked(False)
            self.obs_reveal.blockSignals(blocked)
            for control in (self.obs_copy_server, self.obs_copy_key, self.obs_reveal):
                control.setEnabled(False)

        def _obs_selection_changed(self):
            self._clear_obs_connection()
            self._sync_obs_details()
            self._buttons()

        def _sync_obs_details(self):
            selection = self._obs_selection()
            if self._obs_identity is not None and selection != self._obs_identity:
                self._clear_obs_connection()
            combo = self.horizontal_combo if self.obs_destination.currentData() == "horizontal" else self.portrait_combo
            self.obs_selected_key.setText(combo.currentText() if selection else "Save this destination's channel and reusable key first.")
            from ..streaming.obs_reader import DEFAULT_OUTPUTS
            scope = self.obs_destination.currentData()
            name = self.state.get("configuration", {}).get("output_names", DEFAULT_OUTPUTS).get(scope, DEFAULT_OUTPUTS.get(scope, ""))
            if name.startswith("aitum_multi_output_"):
                name = "Aitum Multistream · " + name.removeprefix("aitum_multi_output_")
            elif name.startswith("vertical_canvas_stream_"):
                name = "Aitum Vertical · " + name.removeprefix("vertical_canvas_stream_")
            self.obs_output_name.setText(name)

        def fetch_obs_connection(self):
            selection = self._obs_selection()
            if not self.busy and selection is not None:
                self._clear_obs_connection()
                self.job({"action": "fetch_obs_connection", **selection})

        def _accept_obs_connection(self, result):
            value = result.get("obs_connection")
            selection = self._obs_selection()
            if result.get("obs_generation") != self._obs_generation or not self.obs_toggle.isChecked() or not isinstance(value, dict) or selection is None or any(value.get(key) != expected for key, expected in selection.items()):
                self._clear_obs_connection()
                self.notice.setText("Connection details cleared because the selected destination changed or the panel closed.")
                return
            try:
                from ..streaming.cloud_client import validated_obs_connection
                details = validated_obs_connection(value, selection["stream_id"])
            except Exception:
                self._clear_obs_connection()
                self.notice.setText("OBS connection details could not be verified. Fetch the selected destination again.")
                return
            self._obs_identity = selection
            self.obs_server.setText(details["server_url"])
            self.obs_key.setText(details["stream_key"])
            self.notice.setText("Connection details fetched for " + self.obs_destination.currentText() + ". The key is hidden.")

        def copy_obs_detail(self, field, message):
            if not self.busy and self._obs_identity == self._obs_selection() and field.text():
                QtWidgets.QApplication.clipboard().setText(field.text())
                self.notice.setText(message)

        def hideEvent(self, event):
            self._clear_obs_connection()
            super().hideEvent(event)

        def closeEvent(self, event):
            self._clear_obs_connection()
            super().closeEvent(event)

        def view_stream(self, scope):
            url = self.state.get("youtube", {}).get("channels", {}).get(scope, {}).get("url", "")
            import re
            if re.fullmatch(r"https://www\.youtube\.com/watch\?v=[A-Za-z0-9_-]{11}", url):
                webbrowser.open(url)

        def import_google(self):
            path, _ = QtWidgets.QFileDialog.getOpenFileName(self, "Choose your Google Desktop OAuth client", "", "JSON files (*.json)")
            if path:
                self.job({"action": "import_youtube_client", "path": path})

        def change_connection_mode(self):
            local = self.state.get("account_mode", "local") == "local"
            self.job({"action": "use_sc2tools_connections" if local else "use_local_connections"})

        def connect_platform(self, platform):
            if self.state.get("account_mode") == "sc2tools":
                self.job({"action": "connect_" + platform})
                return
            dialog = QtWidgets.QDialog(self)
            dialog.setWindowTitle("Connect " + platform.title())
            layout = QtWidgets.QFormLayout(dialog)
            client_id = QtWidgets.QLineEdit()
            layout.addRow("Your OAuth app client ID", client_id)
            secret = QtWidgets.QLineEdit()
            secret.setEchoMode(QtWidgets.QLineEdit.Password)
            if platform == "kick":
                layout.addRow("Client secret", secret)
                layout.addRow(self._label("Register this redirect URL in your Kick app: http://localhost:8768/oauth/kickcallback", True))
            account = QtWidgets.QLineEdit()
            layout.addRow("Expected account name", account)
            hint = self._label("Use an OAuth app you own. Authorize in your browser; SC2Tools will verify and remember this account.", True)
            layout.addRow(hint)
            buttons = QtWidgets.QDialogButtonBox(QtWidgets.QDialogButtonBox.Ok | QtWidgets.QDialogButtonBox.Cancel)
            buttons.accepted.connect(dialog.accept)
            buttons.rejected.connect(dialog.reject)
            layout.addRow(buttons)
            if dialog.exec():
                self.job({"action": "connect_" + platform, "client_id": client_id.text().strip(), "client_secret": secret.text(), "expected_account": account.text().strip()})

        def configure(self):
            if self.privacy.currentData() is None:
                self.notice.setText("Choose visibility for your YouTube broadcasts before saving setup.")
                return
            if self.audience.currentData() is None:
                self.notice.setText("Choose whether your broadcasts are made for kids.")
                return
            self.job({"action": "configure_youtube", "channel_id": self.channel_combo.currentData(), "horizontal_id": self.horizontal_combo.currentData(), "portrait_id": self.portrait_combo.currentData(), "privacy": self.privacy.currentData(), "made_for_kids": self.audience.currentData(), "auto_rearm": self.auto_check.isChecked(), "output_names": {scope: field.text().strip() for scope, field in self.output_inputs.items()}})

    return StreamsPage()
