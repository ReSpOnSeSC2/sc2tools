import os
from types import SimpleNamespace
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest

pytest.importorskip("PySide6")
from PySide6 import QtCore, QtTest, QtWidgets

from sc2tools_agent.ui.streams_page import build_streams_page


@pytest.fixture
def page():
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    state = {"metadata": {"title": "Saved title", "description": "Saved description"},
             "message": "Ready for setup", "youtube": {"connected": False}, "catalog": {}}
    widget = build_streams_page(None, provider=lambda: state, handler=lambda payload: state,
                               QtCore=QtCore, QtWidgets=QtWidgets)
    yield widget, state, app
    widget.timer.stop()
    widget.deleteLater()
    app.processEvents()


def test_polling_preserves_unsaved_title_and_description(page):
    widget, state, app = page
    widget.title_input.setText("Unsaved title")
    widget._title_edited()
    widget.description_input.setPlainText("Unsaved description")
    state["metadata"] = {"title": "Server title", "description": "Server description"}
    widget.refresh()
    assert widget.title_input.text() == "Unsaved title"
    assert widget.description_input.toPlainText() == "Unsaved description"


def test_failed_save_retains_dirty_edits_and_disables_prepare(page):
    widget, state, app = page
    widget.title_input.setText("Unsaved title")
    widget._title_edited()
    widget._completed({"action": "set_metadata", "error": "Save failed"})
    assert widget.title_dirty is True
    assert widget.title_input.text() == "Unsaved title"
    assert not widget.prepare_button.isEnabled()
    assert widget.notice.text() == "Save failed"


def test_youtube_metadata_failure_is_visible_with_connected_account(page):
    widget, state, app = page
    state["youtube"]["connected"] = True
    state["platform_results"] = {"youtube": {"ok": False, "message": "Current title was not verified."}}
    widget.render(state)
    assert "not verified" in widget.platform_labels["youtube"].text()


def test_connecting_disables_fields_and_poll_updates(page):
    widget, state, app = page
    widget.busy = True
    widget._buttons()
    state["metadata"]["title"] = "Changed remotely"
    widget.refresh()
    assert not widget.title_input.isEnabled()
    assert widget.title_input.text() == "Saved title"


def test_normal_sc2tools_connections_do_not_ask_for_developer_credentials(page, monkeypatch):
    widget, state, app = page
    state["account_mode"] = "sc2tools"
    widget.render(state)
    assert widget.import_google_button.isHidden()
    assert not widget.refresh_accounts_button.isHidden()
    calls = []
    monkeypatch.setattr(widget, "job", calls.append)
    widget.connect_platform("twitch")
    assert calls == [{"action": "connect_twitch"}]


def test_starting_format_is_never_labeled_ready(page):
    widget, state, app = page
    state["youtube"] = {"connected": True, "phase": "starting", "channels": {
        "horizontal": {"phase": "bound", "display_phase": "starting"},
        "portrait": {"phase": "bound", "display_phase": "ready"},
    }}
    widget.render(state)
    assert widget.format_labels["horizontal"].text() == "Starting"


def test_saved_visibility_is_shown_and_unsaved_setup_survives_polling(page):
    widget, state, app = page
    state.update(configured=True, configuration={"privacy": "unlisted", "made_for_kids": False, "auto_rearm": False})
    widget.render(state)
    assert widget.privacy.currentData() == "unlisted"
    widget.privacy.setCurrentIndex(widget.privacy.findData("private"))
    widget.refresh()
    assert widget.privacy.currentData() == "private"


def test_first_setup_requires_visibility_and_does_not_enable_auto(page, monkeypatch):
    widget, state, app = page
    calls = []
    monkeypatch.setattr(widget, "job", calls.append)
    widget.audience.setCurrentIndex(widget.audience.findData(False))
    widget.configure()
    assert calls == []
    assert "Choose visibility" in widget.notice.text()
    assert not widget.auto_check.isChecked()
    widget.privacy.setCurrentIndex(widget.privacy.findData("unlisted"))
    widget.configure()
    assert calls[0]["privacy"] == "unlisted"
    assert calls[0]["auto_rearm"] is False


def test_tiktok_buttons_dispatch_explicit_setup_actions(page, monkeypatch):
    widget, state, app = page
    state["tiktok"] = {"installed": True, "running": False, "virtual_camera_active": False}
    widget.render(state)
    calls = []
    monkeypatch.setattr(widget, "job", calls.append)
    widget.tiktok_launch_button.click()
    widget.virtual_camera_start_button.click()
    widget.tiktok_check_button.click()
    assert calls == [{"action": "launch_tiktok"}, {"action": "start_virtual_camera"}, {"action": "check_tiktok"}]
    assert not widget.virtual_camera_stop_button.isEnabled()
    state["tiktok"]["virtual_camera_active"] = True
    widget.render(state)
    assert not widget.virtual_camera_start_button.isEnabled()
    widget.virtual_camera_stop_button.click()
    assert calls[-1] == {"action": "stop_virtual_camera"}


def test_tiktok_unknown_setup_is_not_reported_as_connected(page):
    widget, state, app = page
    widget.render(state)
    assert "unchecked" in widget.platform_labels["tiktok"].text()
    assert widget.tiktok_camera_badge.text() == "Camera unchecked"
    assert not widget.virtual_camera_stop_button.isEnabled()


def test_advanced_sections_collapse_without_discarding_edits(page):
    widget, state, app = page
    assert widget.setup_box.isHidden()
    assert widget.description_box.isHidden()
    widget.description_toggle.setChecked(True)
    widget.description_input.setPlainText("My unsaved description")
    widget.description_toggle.setChecked(False)
    widget.refresh()
    assert widget.description_input.toPlainText() == "My unsaved description"


def test_tiktok_copy_title_remains_manual_and_makes_no_service_request(page, monkeypatch):
    widget, state, app = page
    calls = []
    monkeypatch.setattr(widget, "job", calls.append)
    widget.tiktok_copy_button.click()
    assert calls == []
    assert app.clipboard().text() == "Saved title"
    assert "Paste it into TikTok LIVE Studio" in widget.notice.text()


def test_unsaved_visibility_cannot_prepare_with_previous_visibility(page):
    widget, state, app = page
    state.update(configured=True, configuration={"privacy": "public", "made_for_kids": False, "auto_rearm": False})
    state["youtube"] = {"connected": True}
    widget.render(state)
    assert widget.prepare_button.isEnabled()
    widget.privacy.setCurrentIndex(widget.privacy.findData("private"))
    assert not widget.prepare_button.isEnabled()


def test_connection_setup_button_supports_return_to_sc2tools(page, monkeypatch):
    widget, state, app = page
    calls = []
    monkeypatch.setattr(widget, "job", calls.append)
    state["account_mode"] = "sc2tools"
    widget.render(state)
    assert widget.local_setup_button.text() == "Advanced local setup…"
    widget.local_setup_button.click()
    assert calls[-1] == {"action": "use_local_connections"}
    state["account_mode"] = "local"
    widget.render(state)
    assert not widget.local_setup_button.isHidden()
    assert widget.local_setup_button.text() == "Use SC2Tools connections"
    widget.local_setup_button.click()
    assert calls[-1] == {"action": "use_sc2tools_connections"}


@pytest.mark.parametrize("scope", ["horizontal", "portrait"])
def test_destination_connect_button_dispatches_connection_once(page, scope):
    _, _, app = page
    state = {"account_mode": "sc2tools", "youtube": {
        "connected": False, "phase": "authorization_required",
    }}
    calls = []

    def handle(payload):
        calls.append(payload)
        return state

    widget = build_streams_page(None, provider=lambda: state, handler=handle,
                               QtCore=QtCore, QtWidgets=QtWidgets)
    try:
        widget.timer.stop()
        button = widget.format_connect_buttons[scope]
        assert isinstance(button, QtWidgets.QPushButton)
        assert not button.isHidden()
        assert button.isEnabled()
        assert widget.format_labels[scope].isHidden()
        completed = QtTest.QSignalSpy(widget.completed)
        button.click()
        button.click()
        assert widget.busy
        assert not any(item.isEnabled() for item in widget.format_connect_buttons.values())
        assert completed.count() or completed.wait(2000)
        app.processEvents()
        assert not widget.busy
        assert calls == [{"action": "connect_youtube"}]
    finally:
        widget.deleteLater()
        app.processEvents()


@pytest.mark.parametrize("phase", ["bound", "ready", "starting", "live", "complete", "blocked"])
def test_destination_session_status_cannot_trigger_connection(page, monkeypatch, phase):
    widget, state, app = page
    state["youtube"] = {"connected": True, "phase": phase, "channels": {
        scope: {"phase": phase} for scope in ("horizontal", "portrait")
    }}
    widget.render(state)
    calls = []
    monkeypatch.setattr(widget, "job", calls.append)
    for scope, button in widget.format_connect_buttons.items():
        assert button.isHidden()
        assert not button.isEnabled()
        assert not widget.format_labels[scope].isHidden()
        button.click()
        widget.connect_youtube(scope)
    assert calls == []


@pytest.mark.parametrize("configured,expected", [(False, "Setup needed"), (True, "Prepare session")])
def test_connected_idle_destinations_explain_next_step(page, configured, expected):
    widget, state, app = page
    state.update(configured=configured, youtube={"connected": True, "phase": "idle"})
    widget.render(state)
    assert {label.text() for label in widget.format_labels.values()} == {expected}
    assert all(button.isHidden() and not button.isEnabled()
               for button in widget.format_connect_buttons.values())


def configured_obs_state(state):
    state.update(account_mode="sc2tools", configured=True,
                 youtube={"connected": True, "phase": "idle"},
                 configuration={"channel_id": "saved-channel", "horizontal_id": "saved-horizontal",
                                "portrait_id": "saved-portrait", "privacy": "unlisted", "made_for_kids": False},
                 catalog={"channels": [{"id": "saved-channel", "title": "My channel"}],
                          "streams": [{"id": "saved-horizontal", "title": "Horizontal key"},
                                      {"id": "saved-portrait", "title": "Vertical key"}]})


def complete_obs_details(widget, *, generation=None, changes=None):
    selection = widget._obs_selection()
    result = {"action": "fetch_obs_connection", "obs_generation": widget._obs_generation if generation is None else generation,
              "obs_connection": {**selection, "server_url": "rtmps://a.rtmps.youtube.com:443/live2",
                                 "stream_key": "fake-private-" + selection["stream_id"], **(changes or {})}}
    widget._completed(result)


def test_obs_details_never_fetch_on_render_and_explicit_button_uses_selected_id(page, monkeypatch):
    widget, state, app = page
    calls = []
    monkeypatch.setattr(widget, "job", calls.append)
    configured_obs_state(state)
    widget.render(state)
    widget.refresh()
    assert calls == []
    assert widget.obs_key.text() == ""
    widget.obs_toggle.setChecked(True)
    widget.obs_fetch_button.click()
    assert calls == [{"action": "fetch_obs_connection", "scope": "horizontal",
                      "expected_channel_id": "saved-channel", "stream_id": "saved-horizontal"}]
    widget.obs_destination.setCurrentIndex(1)
    widget.obs_fetch_button.click()
    assert calls[-1]["scope"] == "portrait"
    assert calls[-1]["stream_id"] == "saved-portrait"


def test_obs_details_mask_and_explicit_reveal_copy_never_enter_state(page, monkeypatch):
    widget, state, app = page
    configured_obs_state(state)
    widget.render(state)
    widget.obs_toggle.setChecked(True)
    clipboard = []
    monkeypatch.setattr(QtWidgets.QApplication, "clipboard", lambda: SimpleNamespace(setText=clipboard.append))
    complete_obs_details(widget)
    private_key = widget.obs_key.text()
    assert private_key == "fake-private-saved-horizontal"
    assert widget.obs_key.echoMode() == QtWidgets.QLineEdit.Password
    assert private_key not in widget.obs_key.displayText()
    assert private_key not in str(widget.state)
    assert private_key not in widget.notice.text()
    assert clipboard == []
    widget.obs_reveal.setChecked(True)
    assert widget.obs_key.echoMode() == QtWidgets.QLineEdit.Normal
    widget.obs_reveal.setChecked(False)
    widget.obs_copy_key.click()
    assert clipboard == [private_key]
    assert private_key not in widget.notice.text()
    widget.obs_copy_server.click()
    assert clipboard[-1] == "rtmps://a.rtmps.youtube.com:443/live2"


@pytest.mark.parametrize("change", ["destination", "channel", "key", "disconnect", "account_mode", "collapse", "close"])
def test_obs_details_clear_on_selection_disconnect_and_close(page, change):
    widget, state, app = page
    configured_obs_state(state)
    widget.render(state)
    widget.obs_toggle.setChecked(True)
    complete_obs_details(widget)
    widget.obs_reveal.setChecked(True)
    if change == "destination":
        widget.obs_destination.setCurrentIndex(1)
    elif change == "channel":
        widget.channel_combo.setCurrentIndex(0)
    elif change == "key":
        widget.horizontal_combo.setCurrentIndex(widget.horizontal_combo.findData("saved-portrait"))
    elif change == "disconnect":
        state["youtube"]["connected"] = False
        widget.render(state)
    elif change == "account_mode":
        state["account_mode"] = "local"
        widget.render(state)
    elif change == "collapse":
        widget.obs_toggle.setChecked(False)
    else:
        widget.close()
    assert widget.obs_key.text() == ""
    assert widget.obs_server.text() == ""
    assert widget.obs_key.echoMode() == QtWidgets.QLineEdit.Password
    assert not widget.obs_reveal.isChecked()
    assert not widget.obs_copy_key.isEnabled()


def test_obs_details_late_response_cannot_reappear_after_panel_was_closed(page):
    widget, state, app = page
    configured_obs_state(state)
    widget.render(state)
    widget.obs_toggle.setChecked(True)
    generation = widget._obs_generation
    widget.obs_toggle.setChecked(False)
    widget.obs_toggle.setChecked(True)
    complete_obs_details(widget, generation=generation)
    assert widget.obs_key.text() == ""
    assert not widget.obs_copy_key.isEnabled()


def test_obs_details_wrong_destination_response_is_rejected(page):
    widget, state, app = page
    configured_obs_state(state)
    widget.render(state)
    widget.obs_toggle.setChecked(True)
    complete_obs_details(widget, changes={"stream_id": "saved-portrait"})
    assert widget.obs_key.text() == ""
    assert "fake-private" not in widget.notice.text()


def test_masked_obs_key_cannot_copy_through_keyboard_or_line_edit(page):
    widget, state, app = page
    configured_obs_state(state)
    widget.render(state)
    widget.obs_toggle.setChecked(True)
    complete_obs_details(widget)
    clipboard = app.clipboard()
    clipboard.setText("unchanged-copy-marker")
    widget.obs_key.selectAll()
    widget.obs_key.copy()
    assert clipboard.text() == "unchanged-copy-marker"
    QtTest.QTest.keyClick(widget.obs_key, QtCore.Qt.Key_C, QtCore.Qt.ControlModifier)
    assert clipboard.text() == "unchanged-copy-marker"
    assert widget.obs_key.echoMode() == QtWidgets.QLineEdit.Password


def test_obs_details_hide_clears_key_and_rejects_late_fetch(page):
    widget, state, app = page
    configured_obs_state(state)
    widget.render(state)
    widget.obs_toggle.setChecked(True)
    widget.show()
    app.processEvents()
    complete_obs_details(widget)
    generation = widget._obs_generation
    widget.hide()
    assert widget.obs_key.text() == ""
    complete_obs_details(widget, generation=generation)
    assert widget.obs_key.text() == ""


def test_obs_details_fetch_error_hides_private_exception_text(page):
    _, _, app = page
    state = {}
    configured_obs_state(state)

    def handle(payload):
        raise ValueError("fake-private-provider-key-and-token")

    widget = build_streams_page(None, provider=lambda: state, handler=handle,
                               QtCore=QtCore, QtWidgets=QtWidgets)
    try:
        widget.timer.stop()
        widget.obs_toggle.setChecked(True)
        completed = QtTest.QSignalSpy(widget.completed)
        widget.obs_fetch_button.click()
        assert completed.count() or completed.wait(2000)
        app.processEvents()
        assert "fake-private" not in widget.notice.text()
        assert widget.obs_key.text() == ""
    finally:
        widget.close()
        widget.deleteLater()
        app.processEvents()


def test_obs_details_status_failure_clears_key_and_rejects_pending_response(page):
    _, _, app = page
    state = {}
    configured_obs_state(state)
    unavailable = False

    def provider():
        if unavailable:
            raise RuntimeError("fake-private-status-error")
        return state

    widget = build_streams_page(None, provider=provider, handler=lambda payload: state,
                               QtCore=QtCore, QtWidgets=QtWidgets)
    try:
        widget.timer.stop()
        widget.obs_toggle.setChecked(True)
        complete_obs_details(widget)
        generation = widget._obs_generation
        unavailable = True
        widget.refresh()
        assert widget.obs_key.text() == ""
        complete_obs_details(widget, generation=generation)
        assert widget.obs_key.text() == ""
        assert "fake-private" not in widget.notice.text()
    finally:
        widget.close()
        widget.deleteLater()
        app.processEvents()


def test_obs_details_fetch_worker_returns_secret_only_to_masked_controls(page):
    _, _, app = page
    state = {}
    configured_obs_state(state)
    calls = []

    def handle(payload):
        calls.append(payload)
        return {"obs_connection": {**{key: payload[key] for key in ("scope", "expected_channel_id", "stream_id")},
                                   "server_url": "rtmps://a.rtmps.youtube.com/live2", "stream_key": "fake-private-key"}}

    widget = build_streams_page(None, provider=lambda: state, handler=handle,
                               QtCore=QtCore, QtWidgets=QtWidgets)
    try:
        widget.timer.stop()
        widget.obs_toggle.setChecked(True)
        completed = QtTest.QSignalSpy(widget.completed)
        assert calls == []
        widget.obs_fetch_button.click()
        assert completed.count() or completed.wait(2000)
        app.processEvents()
        assert len(calls) == 1
        assert widget.obs_key.text() == "fake-private-key"
        assert widget.obs_key.echoMode() == QtWidgets.QLineEdit.Password
        assert "fake-private" not in str(widget.state)
    finally:
        widget.close()
        widget.deleteLater()
        app.processEvents()
