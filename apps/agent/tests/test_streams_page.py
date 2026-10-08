import os
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest

pytest.importorskip("PySide6")
from PySide6 import QtCore, QtWidgets

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
