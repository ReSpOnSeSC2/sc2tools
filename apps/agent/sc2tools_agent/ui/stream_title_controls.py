"""Native title-template preview and explicit opt-in controls."""
from __future__ import annotations

from ..streaming.title_template import MATCH_TEMPLATES, TOKEN_REFERENCE, render_values
from . import theme


class StreamTitleControls:
    def __init__(self, page, layout, QtCore, QtWidgets):
        self.page, self.dirty = page, False
        self.values = {}
        self.preview = page._label("Preview: waiting for synced statistics.", True)
        layout.addWidget(self.preview)
        layout.addWidget(page._label("Tokens: " + TOKEN_REFERENCE + ". Separate optional parts with |. Rendered titles must fit 70 characters.", True))
        preset_row = QtWidgets.QHBoxLayout()
        self.record_style = QtWidgets.QComboBox()
        self.record_style.setAccessibleName("Records in the current-match template")
        self.record_style.addItem("Session", "session")
        self.record_style.addItem("Head-to-head", "h2h")
        self.record_style.addItem("Both", "both")
        self.record_style.activated.connect(self.use_match_template)
        preset_row.addWidget(self.record_style)
        self.match_template = page._button("Use current-match template", self.use_match_template, quiet=True)
        preset_row.addWidget(self.match_template, 1)
        layout.addLayout(preset_row)
        self.on_game_start = QtWidgets.QCheckBox("Refresh titles at the start of each game")
        self.on_game_start.setChecked(False)
        self.on_game_start.setToolTip("Optional and off by default. Uncheck and save to stop game-start title updates.")
        self.on_game_start.toggled.connect(self.edited)
        layout.addWidget(self.on_game_start)
        self.channel_tags = QtWidgets.QCheckBox("Set channel tags at the start of each game")
        self.channel_tags.setChecked(False)
        self.channel_tags.setToolTip("Optional and off by default. Tags you set yourself are kept; ours fill the places that remain.")
        self.channel_tags.toggled.connect(self.edited)
        layout.addWidget(self.channel_tags)
        self.tag_preview = page._label("Tags: none yet.", True)
        layout.addWidget(self.tag_preview)
        self.category_guard = QtWidgets.QCheckBox("Switch the category to StarCraft II when a game starts")
        self.category_guard.setChecked(False)
        self.category_guard.setToolTip("Optional and off by default. Changes the category only at a game start, only when it is not StarCraft II, and never back.")
        self.category_guard.toggled.connect(self.edited)
        layout.addWidget(self.category_guard)
        self.enabled = QtWidgets.QCheckBox("Refresh titles after each synced game")
        self.enabled.setChecked(False)
        self.enabled.setToolTip("Optional post-sync updates, independent of game-start updates. Uncheck and save to stop.")
        layout.addWidget(self.enabled)
        row = QtWidgets.QHBoxLayout()
        self.platforms = {}
        for name, text in (("twitch", "Twitch"), ("kick", "Kick"), ("youtube", "YouTube (uses quota)")):
            control = QtWidgets.QCheckBox(text)
            control.setChecked(name != "youtube")
            control.toggled.connect(self.edited)
            self.platforms[name] = control
            row.addWidget(control)
        row.addStretch()
        layout.addLayout(row)
        self.enabled.toggled.connect(self.edited)
        self.save = page._button("Save automatic title settings", self.configure, quiet=True)
        layout.addWidget(self.save)
        self.activation = page._label("Automatic title refresh is off.", True)
        layout.addWidget(self.activation)
        self.refresh = page._button("Refresh preview statistics", lambda: page.job({"action": "refresh_title_preview"}), quiet=True)
        layout.addWidget(self.refresh)
        self.note = page._label("", True)
        layout.addWidget(self.note)
        page.title_input.textChanged.connect(self.update_preview)

    def edited(self, *_args):
        self.dirty = True
        self._update_activation(self.page.state.get("title_automation", {}))

    def use_match_template(self, *_args):
        # Preserve a custom plain-text prefix without repeating match tokens.
        current = self.page.title_input.text().split("|", 1)[0].strip()
        prefix = current if current and "{" not in current and "}" not in current else "SC2"
        self.page.title_input.setText(f"{prefix} | {MATCH_TEMPLATES[self.record_style.currentData()]}")
        self.page._title_edited()

    def configure(self):
        self.page.job({"action": "configure_title_automation", "template": self.page.title_input.text(),
            "enabled": self.enabled.isChecked(), "on_game_start": self.on_game_start.isChecked(),
            "channel_tags": self.channel_tags.isChecked(), "category_guard": self.category_guard.isChecked(),
            "platforms": {name: control.isChecked() for name, control in self.platforms.items()}})

    def update_preview(self, *_args):
        template = self.page.title_input.text()
        for style, preset in MATCH_TEMPLATES.items():
            if template.endswith(f" | {preset}"):
                self.record_style.setCurrentIndex(self.record_style.findData(style))
                break
        try:
            self.preview.setText("Preview: " + render_values(template, self.values))
        except ValueError as error:
            self.preview.setText("Preview: " + str(error))

    def _saved_controls(self, settings):
        platforms = settings.get("platforms", {})
        return [
            (self.enabled, settings.get("enabled") is True),
            (self.on_game_start, settings.get("on_game_start") is True),
            (self.channel_tags, settings.get("channel_tags") is True),
            (self.category_guard, settings.get("category_guard") is True),
            *((control, platforms.get(name, name != "youtube")) for name, control in self.platforms.items()),
        ]

    def _update_activation(self, settings):
        modes = []
        if settings.get("on_game_start") is True:
            modes.append("at game start")
        if settings.get("enabled") is True:
            modes.append("after replay sync")
        status = "Automatic title refresh is off."
        if modes:
            status = "Automatic titles refresh " + " and ".join(modes) + "."
        channel = [text for text, on in (("tags", settings.get("channel_tags")), ("category", settings.get("category_guard"))) if on is True]
        if channel:
            status += " Channel " + " and ".join(channel) + " update at game start."
        options_changed = any(control.isChecked() != checked for control, checked in self._saved_controls(settings))
        template_changed = self.page.title_dirty and (self.enabled.isChecked() or self.on_game_start.isChecked())
        if options_changed or template_changed:
            status += " Click Save automatic title settings to apply your changes."
        self.activation.setText(status)

    def render(self, state):
        settings = state.get("title_automation", {})
        self.values = settings.get("values", {})
        if not self.dirty:
            for control, checked in self._saved_controls(settings):
                blocked = control.blockSignals(True)
                control.setChecked(checked)
                control.blockSignals(blocked)
        self._update_activation(settings)
        self.tag_preview.setText(self._tag_text(settings.get("tag_preview")))
        self.note.setText(settings.get("message", "Saving automatic title settings applies them to future games.")
            + (" " + settings["channel_message"] if settings.get("channel_message") else "")
            + " Game-start refresh runs once per live game. Post-sync refresh runs at most once every 10 minutes. Only changed titles are sent. Session uses your synced wins and losses across the session. H2H uses your confirmed record against the opponent. Matchup rates and peak use at most 512 recorded ladder games from 90 days.")
        self.update_preview()
        self.buttons()

    @staticmethod
    def _tag_text(tags):
        if not tags:
            return "Tags: race, matchup and league tags appear here once a game is loading. Tags you set yourself are kept."
        return "Tags we add for this game: " + ", ".join(tags) + ". Tags you set yourself are kept; ours fill the places that remain."

    def buttons(self):
        usable = not self.page.busy and self.page.state.get("account_mode") == "sc2tools"
        for control in (self.enabled, self.on_game_start, self.channel_tags, self.category_guard, self.record_style, self.match_template, self.save, self.refresh, *self.platforms.values()):
            control.setEnabled(usable)


def connect_platform(page, platform, QtWidgets):
    if page.state.get("account_mode") == "sc2tools":
        page.job({"action": "connect_" + platform})
        return
    dialog = QtWidgets.QDialog(page)
    dialog.setWindowTitle("Connect " + platform.title())
    layout = QtWidgets.QFormLayout(dialog)
    layout.setContentsMargins(*(theme.SPACE_L,) * 4)
    layout.setHorizontalSpacing(theme.SPACE_M)
    layout.setVerticalSpacing(theme.SPACE_S)
    layout.setRowWrapPolicy(QtWidgets.QFormLayout.WrapLongRows)
    client_id = QtWidgets.QLineEdit()
    layout.addRow("Your OAuth app client ID", client_id)
    secret = QtWidgets.QLineEdit()
    secret.setEchoMode(QtWidgets.QLineEdit.Password)
    if platform == "kick":
        layout.addRow("Client secret", secret)
        layout.addRow(page._label("Register this redirect URL in your Kick app: http://localhost:8768/oauth/kickcallback", True))
    account = QtWidgets.QLineEdit()
    layout.addRow("Expected account name", account)
    hint = page._label("Use an OAuth app you own. Authorize in your browser; SC2Tools will verify and remember this account.", True)
    layout.addRow(hint)
    buttons = QtWidgets.QDialogButtonBox(QtWidgets.QDialogButtonBox.Ok | QtWidgets.QDialogButtonBox.Cancel)
    buttons.accepted.connect(dialog.accept)
    buttons.rejected.connect(dialog.reject)
    layout.addRow(buttons)
    if dialog.exec():
        page.job({"action": "connect_" + platform, "client_id": client_id.text().strip(), "client_secret": secret.text(), "expected_account": account.text().strip()})

