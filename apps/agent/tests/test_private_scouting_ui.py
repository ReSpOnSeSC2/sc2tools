import os
from dataclasses import replace
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest
from PySide6 import QtCore, QtGui, QtTest, QtWidgets

from sc2tools_agent.build_checkin.scouting import ScoutingStripModel
from sc2tools_agent.ui import win32_window
from sc2tools_agent.ui.build_checkin_cards import LoadingCardWindow
from sc2tools_agent.ui.build_checkin_window import BuildCheckinHost, LOADING, POSTGAME
from sc2tools_agent.ui.build_checkin_settings import CheckinSettingsGroup
from tests.test_build_checkin_ui_cards import loading_model, postgame_model, Recorder
from tests.build_checkin_fakes import Harness


@pytest.fixture
def app():
    application = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    # Windows' offscreen plugin has no system font database. Load the installed
    # UI font so elision/layout assertions exercise real glyph metrics.
    if not QtGui.QFontDatabase.families():
        fonts = Path(os.environ.get("SystemRoot", "C:/Windows")) / "Fonts"
        for name in ("segoeui.ttf", "segoeuib.ttf", "seguisb.ttf", "seguisym.ttf"):
            source = fonts / name
            if source.is_file():
                QtGui.QFontDatabase.addApplicationFont(str(source))
        if "Segoe UI" in QtGui.QFontDatabase.families():
            application.setFont(QtGui.QFont("Segoe UI", 9))
    return application


@pytest.fixture
def native(app, monkeypatch):
    excluded = []
    monkeypatch.setattr(win32_window, "exclude_from_capture", lambda handle: excluded.append(handle) or 0x11)
    monkeypatch.setattr(win32_window, "keep_topmost", lambda _: True)
    monkeypatch.setattr(win32_window, "foreground_window", lambda: None)
    monkeypatch.setattr(win32_window, "find_sc2_window", lambda: None)
    monkeypatch.setattr(win32_window, "restore_foreground", lambda *_: True)
    recorder = Recorder()
    host = BuildCheckinHost(controller=lambda: recorder)
    yield host, recorder, excluded
    host.close()


def strip(note="Private note"):
    return ScoutingStripModel("You 3–2 · last met 2 days ago (L on Alcyone)",
                             "Usually: 12 Pool (3 of last 5) · Best: Hatch First 3–1",
                             note, "/app/opponents/1-S2-1-42", "1-S2-1-42")


def test_actual_loading_card_keeps_plain_scouting_visible_when_locked(native, app):
    host, _, _ = native
    model = loading_model(scouting=strip("<b>private</b> " + "watch the ramp " * 80))
    host.dispatch("show_loading", (model,)); app.processEvents()
    window = host.existing_window(LOADING)
    assert window.width() == 320
    assert window.scouting.isVisible()
    assert window.scouting.note.textFormat() == QtCore.Qt.PlainText
    assert "<b>private</b>" in window.scouting.note.accessibleName()
    assert len(window.scouting.note.text().splitlines()) <= 2
    assert window.scouting.note.text().endswith("…")
    window.update_model(replace(model, collapsed=True, locked_label="Locked in: Hatch First"))
    assert window.bar.isVisible() and window.scouting.isVisible()


def test_loading_scouting_preserves_non_activation_contract_capture_and_local_close(native, app, monkeypatch):
    host, recorder, excluded = native
    activation_requests = []
    monkeypatch.setattr(LoadingCardWindow, "activateWindow", lambda *_: activation_requests.append("activate"))
    monkeypatch.setattr(LoadingCardWindow, "setFocus", lambda *_: activation_requests.append("focus"))
    host.dispatch("show_loading", (loading_model(scouting=strip(), scouting_only=True, heading="Private scouting"),))
    window = host.existing_window(LOADING); app.processEvents()
    assert window.windowFlags() & QtCore.Qt.WindowDoesNotAcceptFocus
    assert window.testAttribute(QtCore.Qt.WA_ShowWithoutActivating)
    # Offscreen ignores the native no-focus flags on the pre-change app too.
    # Verify the actual requested flags and code path; do not claim an OS-level
    # foreground guarantee from this backend's isActiveWindow value.
    assert not activation_requests
    assert excluded  # existing Windows capture-exclusion call precedes show
    assert window.builds.isHidden() and window.dont_ask.isHidden()
    assert window.not_now.text() == "Close"
    assert window.scouting.dossier.focusPolicy() == QtCore.Qt.NoFocus
    window.scouting.dossier.click()
    assert recorder.named("open_scouting_dossier") == [(window.model.game_key,)]
    window.not_now.click()
    assert recorder.named("dismiss_scouting") == [(window.model.game_key,)]
    assert not recorder.named("not_now")


def test_note_accordion_temporarily_hides_picker_and_keeps_controls_compact(native, app):
    host, _, _ = native
    host.dispatch("show_postgame", (postgame_model(game_id="g", opponent_pulse_id="1-S2-1-42"),))
    window = host.existing_window(POSTGAME)
    window.builds.set_expanded(True); window.settle()
    assert window.height() < 720
    window.opponent_note.toggle.click(); window.settle()
    assert window.picker.isHidden()
    assert window.opponent_note.editor.isVisible()
    assert window.height() < 500
    window.opponent_note.toggle.click(); window.settle()
    assert window.picker.isVisible() and window.builds.is_expanded()


def test_private_note_is_utf16_bounded_and_uses_its_own_save_action(native):
    host, recorder, _ = native
    model = postgame_model(game_id="g", opponent_pulse_id="1-S2-1-42", notes="Game notes")
    host.dispatch("show_postgame", (model,)); window = host.existing_window(POSTGAME)
    window.opponent_note.toggle.click()
    window.opponent_note.editor.setPlainText("🦊" * 300)
    note = window.opponent_note.editor.toPlainText()
    assert len(note.encode("utf-16-le")) // 2 == 500
    assert window.opponent_note.counter.text() == "500 / 500"
    window.opponent_note.save.click()
    assert recorder.named("save_opponent_note") == [(model.card_id, note)]
    assert window.notes_text() == "Game notes"
    assert not recorder.named("confirm")


def test_private_note_draft_survives_unrelated_updates_and_new_card_resets_it(native):
    host, _, _ = native
    model = postgame_model(game_id="g", opponent_pulse_id="1-S2-1-42", opponent_note="Stored note")
    host.dispatch("show_postgame", (model,)); window = host.existing_window(POSTGAME)
    window.opponent_note.toggle.click(); window.opponent_note.editor.setPlainText("My draft ")
    window.update_model(replace(model, status="Refreshing", opponent_note="Older cached note"))
    assert window.opponent_note.editor.toPlainText() == "My draft "
    assert window.picker.isHidden()
    window.show_model(replace(model, card_id="new-card", opponent_note="Different opponent"))
    assert window.opponent_note.editor.toPlainText() == "Different opponent"
    assert not window.opponent_note.toggle.isChecked()


def test_private_note_waits_for_uploaded_identity_and_remains_retryable(native):
    host, _, _ = native
    model = postgame_model(opponent_pulse_id="1-S2-1-42")
    host.dispatch("show_postgame", (model,)); window = host.existing_window(POSTGAME)
    window.opponent_note.toggle.click()
    assert not window.opponent_note.editor.isEnabled()
    assert "after this replay syncs" in window.opponent_note.status.text()
    window.update_model(replace(model, game_id="g", opponent_note_busy=True, opponent_note_status="Saving note…"))
    assert window.opponent_note.editor.isEnabled() and not window.opponent_note.save.isEnabled()
    window.update_model(replace(model, game_id="g", opponent_note_status="Couldn't save note. Try again."))
    assert window.opponent_note.save.isEnabled()
    assert "Try again" in window.opponent_note.status.text()


def test_native_settings_toggle_controls_only_local_scouting(app):
    h = Harness().boot()
    group = CheckinSettingsGroup(controller=lambda: h.ctl, available=True)
    group.apply_prefs(h.ctl.prefs); group.show(); app.processEvents()
    assert group.scouting_box.isChecked() and group.scouting_box.isEnabled()
    before = list(h.api.calls_to("put_checkin_prefs"))
    QtTest.QTest.mouseClick(group.scouting_box, QtCore.Qt.LeftButton); h.pump()
    assert not h.ctl.scouting_enabled
    assert h.api.calls_to("put_checkin_prefs") == before
    group.close()
