"""Saved local assistance presets, independent of shared account settings."""

from __future__ import annotations

from copy import deepcopy


MODES = (("ladder", "Ladder"), ("customs", "Customs"), ("teams", "Teams"),
         ("practice", "Practice"), ("review", "Review"))
FEATURES = (("opponentOverlay", "Opponent panel"), ("scoutingOverlay", "Scouting panel"),
            ("scoutingReadAloud", "Spoken scouting report"),
            ("preGameSelector", "Pre-game selector"), ("postGameSelector", "Post-game selector"),
            ("randomizer", "Randomizer"), ("ghost", "Build Order Ghost"))


def default_modes():
    enabled = {key: True for key, _label in FEATURES}
    disabled = {key: False for key, _label in FEATURES}
    return {"version": 1, "active": "ladder", "hotkeyEnabled": False, "profiles": {
        "ladder": dict(enabled), "customs": dict(enabled), "teams": {**disabled, "opponentOverlay": True, "scoutingOverlay": True, "scoutingReadAloud": True, "ghost": True},
        "practice": {**disabled, "preGameSelector": True, "postGameSelector": True, "ghost": True},
        "review": dict(disabled),
    }}


def normalize_modes(value):
    source = value if isinstance(value, dict) else {}
    result = default_modes()
    if isinstance(source.get("active"), str) and source["active"] in result["profiles"]:
        result["active"] = source["active"]
    result["hotkeyEnabled"] = source.get("hotkeyEnabled") is True
    profiles = source.get("profiles") if isinstance(source.get("profiles"), dict) else {}
    for mode, _label in MODES:
        profile = profiles.get(mode) if isinstance(profiles.get(mode), dict) else {}
        for feature, _caption in FEATURES:
            if type(profile.get(feature)) is bool:
                result["profiles"][mode][feature] = profile[feature]
    return result


def validate_modes(value):
    if not isinstance(value, dict) or any(key not in {"version", "active", "profiles", "hotkeyEnabled"} for key in value):
        raise ValueError("Choose valid local Companion mode settings.")
    if value.get("version", 1) != 1 or not isinstance(value.get("active", "ladder"), str) or value.get("active", "ladder") not in dict(MODES):
        raise ValueError("Choose one of the available Companion modes.")
    if "hotkeyEnabled" in value and type(value["hotkeyEnabled"]) is not bool:
        raise ValueError("The global shortcut switch must be on or off.")
    profiles = value.get("profiles", {})
    if not isinstance(profiles, dict) or any(mode not in dict(MODES) for mode in profiles):
        raise ValueError("Choose valid Companion mode profiles.")
    for profile in profiles.values():
        if not isinstance(profile, dict) or any(key not in dict(FEATURES) or type(setting) is not bool for key, setting in profile.items()):
            raise ValueError("Mode features must be on or off.")
    return normalize_modes(value)


def verified_one_on_one(snapshot):
    envelope = snapshot.get("liveGame") if isinstance(snapshot, dict) else None
    if not isinstance(envelope, dict) or envelope.get("isReplay") is True:
        return False
    players = envelope.get("players")
    return isinstance(players, list) and len(players) == 2 and all(
        isinstance(player, dict) and player.get("type") == "user" for player in players
    )


def effective_mode_features(value, snapshot=None):
    modes = normalize_modes(value)
    features = dict(modes["profiles"][modes["active"]])
    if modes["active"] == "teams" and not verified_one_on_one(snapshot):
        features = {key: False for key, _caption in FEATURES}
    return {**features, "mode": modes["active"]}


def build_companion_modes(parent, *, QtCore, QtWidgets):
    from .ui.qt_helpers import build_flow_layout

    class ModeControls(QtWidgets.QWidget):
        changed = QtCore.Signal(dict)

        def __init__(self):
            super().__init__(parent)
            self._state = default_modes()
            layout = QtWidgets.QVBoxLayout(self)
            layout.setContentsMargins(0, 0, 0, 0)
            layout.setSpacing(5)
            choices = build_flow_layout(QtCore=QtCore, QtWidgets=QtWidgets)
            mode_choice = QtWidgets.QWidget()
            mode_choice_layout = QtWidgets.QHBoxLayout(mode_choice)
            mode_choice_layout.setContentsMargins(0, 0, 0, 0)
            title = QtWidgets.QLabel("SAVED MODE")
            title.setObjectName("companionAccent")
            mode_choice_layout.addWidget(title)
            self.mode_select = QtWidgets.QComboBox()
            for key, caption in MODES:
                self.mode_select.addItem(caption, key)
            self.mode_select.currentIndexChanged.connect(self._mode_changed)
            mode_choice_layout.addWidget(self.mode_select)
            choices.addWidget(mode_choice)
            self.hotkey_check = QtWidgets.QCheckBox("Global hide/show shortcut")
            self.hotkey_check.toggled.connect(self._hotkey_changed)
            choices.addWidget(self.hotkey_check)
            self.customize_button = QtWidgets.QPushButton("Customize mode")
            self.customize_button.setCheckable(True)
            choices.addWidget(self.customize_button)
            layout.addLayout(choices)
            self.feature_checks = {}
            self.details = QtWidgets.QWidget()
            detail_layout = QtWidgets.QVBoxLayout(self.details)
            detail_layout.setContentsMargins(0, 0, 0, 0)
            help_text = QtWidgets.QLabel("Local preset gates only. Shared account switches and pin choices still apply.")
            help_text.setTextFormat(QtCore.Qt.PlainText)
            help_text.setWordWrap(True)
            detail_layout.addWidget(help_text)
            features = build_flow_layout(QtCore=QtCore, QtWidgets=QtWidgets)
            for feature, caption in FEATURES:
                checkbox = QtWidgets.QCheckBox(caption)
                checkbox.toggled.connect(lambda checked, key=feature: self._feature_changed(key, checked))
                self.feature_checks[feature] = checkbox
                features.addWidget(checkbox)
            detail_layout.addLayout(features)
            self.explanation = QtWidgets.QLabel()
            self.explanation.setTextFormat(QtCore.Qt.PlainText)
            self.explanation.setWordWrap(True)
            self.explanation.setObjectName("companionMuted")
            layout.addWidget(self.explanation)
            self.hotkey_status = QtWidgets.QLabel("Shortcut off · Ctrl+Shift+F10")
            self.hotkey_status.setTextFormat(QtCore.Qt.PlainText)
            self.hotkey_status.setWordWrap(True)
            self.hotkey_status.setObjectName("companionMuted")
            detail_layout.addWidget(self.hotkey_status)
            layout.addWidget(self.details)
            self.details.hide()
            self.customize_button.toggled.connect(self.details.setVisible)
            self.save_status = QtWidgets.QLabel()
            self.save_status.setTextFormat(QtCore.Qt.PlainText)
            self.save_status.setWordWrap(True)
            self.save_status.setObjectName("companionMuted")
            layout.addWidget(self.save_status)
            self.save_status.hide()
            self.set_state(self._state)

        def set_state(self, state):
            self._state = normalize_modes(state)
            blocked = QtCore.QSignalBlocker(self.mode_select)
            self.mode_select.setCurrentIndex(self.mode_select.findData(self._state["active"]))
            del blocked
            for feature, checkbox in self.feature_checks.items():
                blocked = QtCore.QSignalBlocker(checkbox)
                checkbox.setChecked(self._state["profiles"][self._state["active"]][feature])
                del blocked
            blocked = QtCore.QSignalBlocker(self.hotkey_check)
            self.hotkey_check.setChecked(self._state["hotkeyEnabled"])
            del blocked
            self.explanation.setText(self.summary())

        def summary(self):
            active = self._state["active"]
            allowed = [caption for feature, caption in FEATURES if self._state["profiles"][active][feature]]
            if active == "teams":
                return "Teams Hybrid · confirm yourself and enemy membership for live roster scouting. Historical MMR is not team MMR. Ghost needs an explicit target for this game; automatic 1v1 check-ins and randomizer stay off."
            if not allowed:
                return dict(MODES)[active] + " preset · game assistance hidden; account switches and pin choices stay saved."
            if len(allowed) == len(FEATURES):
                return dict(MODES)[active] + " preset · all features allowed; account switches and pin choices still apply."
            return dict(MODES)[active] + " preset allows: " + ", ".join(allowed) + ". Account switches still apply."

        def _mode_changed(self, _index):
            state = deepcopy(self._state)
            state["active"] = self.mode_select.currentData()
            self.set_state(state)
            self.changed.emit(deepcopy(self._state))

        def _feature_changed(self, feature, enabled):
            self._state["profiles"][self._state["active"]][feature] = bool(enabled)
            self.changed.emit(deepcopy(self._state))

        def _hotkey_changed(self, enabled):
            self._state["hotkeyEnabled"] = bool(enabled)
            self.changed.emit(deepcopy(self._state))

    return ModeControls()
