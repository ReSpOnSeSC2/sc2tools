"""Stream Guardian card: four opt-in warnings and the OBS input that is the microphone."""
from __future__ import annotations

from ..streaming.guardian_settings import RULES

LABELS = {
    "mic_muted": ("Microphone muted for two minutes",
                  "Off until you turn it on. Needs the OBS input you speak into, chosen below."),
    "stream_unstable": ("Frames dropping or stream reconnecting",
                        "Off until you turn it on. Judged from the frames OBS skips, never from your game."),
    "not_recording": ("Game started with OBS not live or recording",
                      "Off until you turn it on. Checked once the game has been running a few seconds."),
    "stuck_on_break": ("Live on a break scene long after a game",
                       "Off until you turn it on. A break scene has BRB, break, starting soon, intermission, AFK or away in its name."),
}


class StreamGuardianControls:
    def __init__(self, page, layout, QtCore, QtWidgets):
        self.page, self.dirty, self.inputs = page, False, []
        layout.addWidget(page._label("STREAM GUARDIAN", name="studioEyebrow"))
        layout.addWidget(page._label(
            "While OBS is live, SC2 Tools warns you off-stream with a quiet tray notice and a banner in the Stream Dock. "
            "It never draws on your stream or plays a sound. It reads OBS every few seconds and does nothing while OBS is not live.", True))
        self.switches = {}
        for rule in RULES:
            text, tip = LABELS[rule]
            box = QtWidgets.QCheckBox(text)
            box.setChecked(False)
            box.setToolTip(tip)
            box.toggled.connect(self.edited)
            layout.addWidget(box)
            self.switches[rule] = box
        row = QtWidgets.QHBoxLayout()
        self.microphone = QtWidgets.QComboBox()
        self.microphone.setEditable(True)
        self.microphone.setInsertPolicy(QtWidgets.QComboBox.NoInsert)
        self.microphone.setSizePolicy(QtWidgets.QSizePolicy.Expanding, QtWidgets.QSizePolicy.Fixed)
        self.microphone.setAccessibleName("OBS input that is your microphone")
        self.microphone.lineEdit().setPlaceholderText("OBS input that is your microphone")
        self.microphone.currentTextChanged.connect(self.edited)
        row.addWidget(self.microphone, 1)
        self.find_inputs = page._button("Find OBS inputs", lambda: page.job({"action": "list_obs_inputs"}), quiet=True)
        row.addWidget(self.find_inputs)
        layout.addLayout(row)
        self.save = page._button("Save Stream Guardian settings", self.configure, quiet=True)
        layout.addWidget(self.save)
        self.status = page._label("", True)
        layout.addWidget(self.status)

    def edited(self, *_args):
        self.dirty = True
        self._update_status(self.page.state.get("guardian", {}))

    def configure(self):
        self.page.job({"action": "configure_guardian", "microphone": self.microphone.currentText().strip(),
                       "switches": {rule: box.isChecked() for rule, box in self.switches.items()}})

    def _update_status(self, settings):
        on = [rule for rule, enabled in (settings.get("switches") or {}).items() if enabled is True]
        status = f"{len(on)} of {len(RULES)} warnings are on." if on else "All warnings are off."
        if settings.get("active"):
            status += " Active now: " + ", ".join(LABELS[rule][0].lower() for rule in settings["active"] if rule in LABELS) + "."
        if settings.get("dock_ok") is False:
            status += " The Stream Dock banner could not be updated; the tray notice still works."
        if self.dirty:
            status += " Click Save Stream Guardian settings to apply your changes."
        self.status.setText(status)

    def render(self, state):
        settings = state.get("guardian", {})
        names = settings.get("inputs") or []
        if not self.dirty:
            saved = settings.get("switches") or {}
            for rule, box in self.switches.items():
                blocked = box.blockSignals(True)
                box.setChecked(saved.get(rule) is True)
                box.blockSignals(blocked)
        if names != self.inputs:
            self.inputs = list(names)
            current = self.microphone.currentText()
            blocked = self.microphone.blockSignals(True)
            self.microphone.clear()
            self.microphone.addItems(self.inputs)
            self.microphone.setEditText(current)
            self.microphone.blockSignals(blocked)
        if not self.dirty:
            blocked = self.microphone.blockSignals(True)
            self.microphone.setEditText(settings.get("microphone", ""))
            self.microphone.blockSignals(blocked)
        self._update_status(settings)
        self.buttons()

    def buttons(self):
        usable = not self.page.busy
        for control in (self.microphone, self.find_inputs, self.save, *self.switches.values()):
            control.setEnabled(usable)
