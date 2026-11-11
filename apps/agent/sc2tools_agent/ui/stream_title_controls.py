"""Native title-template preview and explicit opt-in controls."""
from __future__ import annotations

from ..streaming.title_template import TOKEN_REFERENCE, render_values
from . import theme


class StreamTitleControls:
    def __init__(self, page, layout, QtCore, QtWidgets):
        self.page, self.dirty = page, False
        self.values = {}
        self.preview = page._label("Preview: waiting for synced statistics.", True)
        layout.addWidget(self.preview)
        layout.addWidget(page._label("Tokens: " + TOKEN_REFERENCE + ". Separate optional parts with |. Rendered titles must fit 70 characters.", True))
        self.match_template = page._button("Use current-match template", self.use_match_template, quiet=True)
        layout.addWidget(self.match_template)
        self.on_game_start = QtWidgets.QCheckBox("Refresh titles at the start of each game")
        self.on_game_start.setChecked(False)
        self.on_game_start.setToolTip("Optional and off by default. Uncheck and save to stop game-start title updates.")
        self.on_game_start.toggled.connect(self.edited)
        layout.addWidget(self.on_game_start)
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
        self.refresh = page._button("Refresh preview statistics", lambda: page.job({"action": "refresh_title_preview"}), quiet=True)
        layout.addWidget(self.refresh)
        self.note = page._label("Automatic updates are off. Saving these settings never publishes a title.", True)
        layout.addWidget(self.note)
        page.title_input.textChanged.connect(self.update_preview)

    def edited(self, *_args):
        self.dirty = True

    def use_match_template(self):
        # Preserve a custom plain-text prefix without repeating match tokens.
        current = self.page.title_input.text().split("|", 1)[0].strip()
        prefix = current if current and "{" not in current and "}" not in current else "SC2"
        self.page.title_input.setText(prefix + " | v {opp} {aka} | {h2h} ({h2h_wr}) | {map}")
        self.page._title_edited()
        self.edited()

    def configure(self):
        self.page.job({"action": "configure_title_automation", "template": self.page.title_input.text(),
            "enabled": self.enabled.isChecked(), "on_game_start": self.on_game_start.isChecked(),
            "platforms": {name: control.isChecked() for name, control in self.platforms.items()}})

    def update_preview(self, *_args):
        try:
            self.preview.setText("Preview: " + render_values(self.page.title_input.text(), self.values))
        except ValueError as error:
            self.preview.setText("Preview: " + str(error))

    def render(self, state):
        settings = state.get("title_automation", {})
        self.values = settings.get("values", {})
        if not self.dirty:
            for control, checked in [(self.enabled, settings.get("enabled") is True),
                (self.on_game_start, settings.get("on_game_start") is True),
                *[(control, settings.get("platforms", {}).get(name, name != "youtube")) for name, control in self.platforms.items()]]:
                blocked = control.blockSignals(True)
                control.setChecked(checked)
                control.blockSignals(blocked)
        self.note.setText(settings.get("message", "Automatic updates are off. Saving these settings never publishes a title.")
            + " Game-start refresh runs once per live game when its opponent is ready. Post-sync refresh runs at most once every 10 minutes. Only changed titles are sent. Head-to-head uses your confirmed record against the current opponent. Map appears only when the live source supplies it. Matchup rates and peak use at most 512 recorded ladder games from 90 days.")
        self.update_preview()
        self.buttons()

    def buttons(self):
        usable = not self.page.busy and self.page.state.get("account_mode") == "sc2tools"
        for control in (self.enabled, self.on_game_start, self.match_template, self.save, self.refresh, *self.platforms.values()):
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

