"""Streams page rendering of YouTube channel/key discovery states."""
import os
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest

pytest.importorskip("PySide6")
from PySide6 import QtCore, QtGui, QtWidgets

from sc2tools_agent.ui.streams_page import build_streams_page

CATALOG = {"channels": [{"id": "UCowned", "title": "Owned channel"}],
           "streams": [{"id": "stream-h", "title": "Horizontal key", "channel_id": "UCowned"},
                       {"id": "stream-v", "title": "Vertical key", "channel_id": "UCowned"}]}


@pytest.fixture
def page():
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    state = {"metadata": {"title": "Saved title", "description": ""}, "message": "Ready for setup",
             "youtube": {"connected": False}, "catalog": {"channels": [], "streams": []},
             "catalog_status": {"state": "idle", "message": "Connect YouTube to load your channel and reusable keys.", "attempts": 0, "http_status": None},
             "account_mode": "sc2tools"}
    widget = build_streams_page(None, provider=lambda: state, handler=lambda payload: state,
                               QtCore=QtCore, QtWidgets=QtWidgets)
    yield widget, state, app
    widget.timer.stop()
    widget.deleteLater()
    app.processEvents()


def placeholders(widget):
    return {combo.itemText(0) for combo in (widget.channel_combo, widget.horizontal_combo, widget.portrait_combo)}


def test_unauthorized_account_explains_connection_first(page):
    widget, state, app = page
    widget.render(state)
    assert placeholders(widget) == {"Connect YouTube first"}
    assert "Connect YouTube" in widget.catalog_note.text()


def test_loading_and_failure_states_are_visible_and_actionable(page):
    widget, state, app = page
    state["youtube"] = {"connected": True}
    state["catalog_status"] = {"state": "loading", "message": "Loading your YouTube channel and reusable keys…", "attempts": 0, "http_status": None}
    widget.render(state)
    assert placeholders(widget) == {"Loading…"}
    assert widget.catalog_note.text().startswith("Loading")
    state["catalog_status"] = {"state": "failed", "attempts": 1, "http_status": 502,
                              "message": "Your YouTube channel and reusable keys could not be loaded through SC2Tools. Existing selections are unchanged. Retrying automatically."}
    widget.render(state)
    assert placeholders(widget) == {"Not loaded — press Refresh keys"}
    assert "could not be loaded" in widget.catalog_note.text()
    assert widget.channel_combo.count() == 1


def test_ready_catalog_suggests_one_channel_and_unique_named_roles(page):
    widget, state, app = page
    state["youtube"] = {"connected": True}
    state["catalog"] = CATALOG
    state["catalog_status"] = {"state": "ready", "message": "Loaded 2 reusable keys for Owned channel.", "attempts": 0, "http_status": None}
    widget.render(state)
    assert placeholders(widget) == {"Choose…"}
    assert [widget.channel_combo.itemText(i) for i in range(widget.channel_combo.count())] == ["Choose…", "Owned channel"]
    assert [widget.horizontal_combo.itemText(i) for i in range(widget.horizontal_combo.count())] == ["Choose…", "Horizontal key", "Vertical key"]
    assert widget.channel_combo.currentData() == "UCowned"
    assert widget.horizontal_combo.currentData() == "stream-h"
    assert widget.portrait_combo.currentData() == "stream-v"
    assert widget.privacy.currentData() == "public"
    assert widget.audience.currentData() is False
    assert widget.catalog_note.text() == "Loaded 2 reusable keys for Owned channel."
    assert not widget.prepare_button.isEnabled()


def test_ready_catalog_without_keys_tells_user_to_create_them(page):
    widget, state, app = page
    state["youtube"] = {"connected": True}
    state["catalog"] = {"channels": [{"id": "UCowned", "title": "Owned channel"}], "streams": []}
    state["catalog_status"] = {"state": "ready", "message": "No reusable stream keys were found on this channel. Create two in YouTube Studio, then refresh keys.", "attempts": 0, "http_status": None}
    widget.render(state)
    assert placeholders(widget) == {"Choose…", "No reusable keys found"}
    assert widget.channel_combo.itemText(0) == "Choose…"
    assert "Create two in YouTube Studio" in widget.catalog_note.text()


def test_saved_setup_is_shown_once_catalog_loads(page):
    widget, state, app = page
    state["youtube"] = {"connected": True}
    state.update(configured=True, configuration={"channel_id": "UCowned", "horizontal_id": "stream-h", "portrait_id": "stream-v",
                                                 "privacy": "unlisted", "made_for_kids": False, "auto_rearm": False})
    widget.render(state)
    assert widget.horizontal_combo.currentData() == "stream-h"
    assert "Unavailable saved key" in widget.horizontal_combo.currentText()
    state["catalog"] = CATALOG
    state["catalog_status"] = {"state": "ready", "message": "Loaded 2 reusable keys for Owned channel.", "attempts": 0, "http_status": None}
    widget.render(state)
    assert widget.channel_combo.currentData() == "UCowned"
    assert widget.horizontal_combo.currentData() == "stream-h"
    assert widget.portrait_combo.currentData() == "stream-v"
    assert widget.obs_fetch_button.isEnabled()


def wheel(widget_under_test):
    center = QtCore.QPointF(widget_under_test.rect().center())
    event = QtGui.QWheelEvent(center, widget_under_test.mapToGlobal(center.toPoint()).toPointF(), QtCore.QPoint(0, -120), QtCore.QPoint(0, -120),
                              QtCore.Qt.NoButton, QtCore.Qt.NoModifier, QtCore.Qt.NoScrollPhase, False)
    QtWidgets.QApplication.sendEvent(widget_under_test, event)


def test_page_scrolling_over_unfocused_dropdowns_never_changes_a_choice(page):
    widget, state, app = page
    state["youtube"] = {"connected": True}
    state["catalog"] = CATALOG
    state["catalog_status"] = {"state": "ready", "message": "Loaded.", "attempts": 0, "http_status": None}
    widget.render(state)
    widget.horizontal_combo.setCurrentIndex(1)
    widget.privacy.setCurrentIndex(widget.privacy.findData("unlisted"))
    widget.setup_dirty = False
    for combo in (widget.channel_combo, widget.horizontal_combo, widget.portrait_combo, widget.privacy, widget.audience, widget.obs_destination):
        assert combo.focusPolicy() == QtCore.Qt.StrongFocus
        assert not combo.hasFocus()
        before = combo.currentIndex()
        wheel(combo)
        assert combo.currentIndex() == before
    assert widget.horizontal_combo.currentData() == "stream-h"
    assert widget.privacy.currentData() == "unlisted"
    assert widget.setup_dirty is False


READY = {"state": "ready", "message": "Loaded 2 reusable keys for Owned channel.", "attempts": 0, "http_status": None, "retry_pending": False}
FAILED = {"state": "failed", "attempts": 4, "http_status": 502, "retry_pending": False, "message": "Could not be loaded. Press Refresh keys to try again."}
RETRYING = {"state": "failed", "attempts": 1, "http_status": 502, "retry_pending": True, "message": "Could not be loaded. Retrying automatically."}


def configured(state):
    state.update(configured=True, configuration={"channel_id": "UCowned", "horizontal_id": "stream-h", "portrait_id": "stream-v",
                                                 "privacy": "unlisted", "made_for_kids": False, "auto_rearm": False})


def test_automatic_retry_is_distinguished_from_an_exhausted_failure(page):
    widget, state, app = page
    state["youtube"] = {"connected": True}
    state["catalog_status"] = RETRYING
    widget.render(state)
    assert placeholders(widget) == {"Not loaded yet — retrying…"}
    state["catalog_status"] = FAILED
    widget.render(state)
    assert placeholders(widget) == {"Not loaded — press Refresh keys"}


def test_zero_keys_placeholder_applies_to_key_dropdowns_only(page):
    widget, state, app = page
    state["youtube"] = {"connected": True}
    state["catalog"] = {"channels": [{"id": "UCowned", "title": "Owned channel"}], "streams": []}
    state["catalog_status"] = {**READY, "message": "No reusable stream keys were found on this channel. Create two in YouTube Studio, then refresh keys."}
    widget.render(state)
    assert widget.channel_combo.itemText(0) == "Choose…"
    assert widget.horizontal_combo.itemText(0) == "No reusable keys found"
    assert widget.portrait_combo.itemText(0) == "No reusable keys found"


@pytest.mark.parametrize("catalog, expected", [
    (CATALOG, "Choose…"),
    ({"channels": [], "streams": []}, "Connect YouTube first"),
    ({}, "Connect YouTube first"),
])
def test_snapshot_without_catalog_status_falls_back_by_catalog_content(page, catalog, expected):
    widget, state, app = page
    state["youtube"] = {"connected": True}
    state["catalog"] = catalog
    del state["catalog_status"]
    widget.render(state)
    assert placeholders(widget) == {expected}
    assert widget.catalog_note.isHidden(), "no message available: the note row must not show stale idle text"


def test_unknown_future_state_does_not_crash_and_falls_back(page):
    widget, state, app = page
    state["youtube"] = {"connected": True}
    state["catalog"] = CATALOG
    state["catalog_status"] = {"state": "stale", "message": "Newer agent message.", "attempts": 0, "http_status": None}
    widget.render(state)
    assert placeholders(widget) == {"Choose…"}
    assert widget.catalog_note.text() == "Newer agent message."


def test_disconnected_account_ignores_leftover_failed_or_loading_status(page):
    widget, state, app = page
    for status in (FAILED, {"state": "loading", "message": "Loading…", "attempts": 0, "http_status": None}):
        state["youtube"] = {"connected": False}
        state["catalog_status"] = status
        widget.render(state)
        assert placeholders(widget) == {"Connect YouTube first"}
        assert widget.catalog_note.text() == "Connect YouTube to load your channel and reusable keys."


def test_placeholder_transitions_never_dirty_setup_or_clear_fetched_obs_details(page):
    widget, state, app = page
    state["youtube"] = {"connected": True}
    state["catalog"] = CATALOG
    state["catalog_status"] = READY
    configured(state)
    widget.render(state)
    widget.obs_toggle.setChecked(True)
    selection = widget._obs_selection()
    assert selection is not None
    widget._completed({"action": "fetch_obs_connection", "obs_generation": widget._obs_generation,
                       "obs_connection": {**selection, "server_url": "rtmps://a.rtmps.youtube.com/live2", "stream_key": "fake-private-key"}})
    assert widget.obs_key.text() == "fake-private-key"
    generation = widget._obs_generation
    for status in (RETRYING, {"state": "loading", "message": "Loading…", "attempts": 1, "http_status": None, "retry_pending": False}, FAILED, READY):
        state["catalog_status"] = status
        widget.render(state)
        assert widget.setup_dirty is False
        assert widget._obs_generation == generation, "a placeholder text change is not a selection change"
        assert widget.obs_key.text() == "fake-private-key"
        assert widget.horizontal_combo.currentData() == "stream-h"


def test_failed_reload_keeps_names_and_saved_selection_but_flags_the_placeholder(page):
    widget, state, app = page
    state["youtube"] = {"connected": True}
    state["catalog"] = CATALOG
    state["catalog_status"] = READY
    configured(state)
    widget.render(state)
    state["catalog_status"] = FAILED
    widget.render(state)
    assert placeholders(widget) == {"Not loaded — press Refresh keys"}
    assert widget.channel_combo.count() == 2 and widget.horizontal_combo.count() == 3
    assert widget.channel_combo.currentData() == "UCowned"
    assert widget.horizontal_combo.currentData() == "stream-h"
    assert widget.portrait_combo.currentData() == "stream-v"
    assert widget.catalog_note.text() == FAILED["message"]
    assert widget.obs_fetch_button.isEnabled(), "a saved, connected destination stays fetchable"


def test_focused_dropdown_still_responds_to_the_wheel(page):
    widget, state, app = page
    state["youtube"] = {"connected": True}
    state["catalog"] = CATALOG
    state["catalog_status"] = READY
    widget.render(state)
    if not app.style().styleHint(QtWidgets.QStyle.SH_ComboBox_AllowWheelScrolling):
        pytest.skip("this style never scrolls combo boxes with the wheel")
    widget.show()
    app.setActiveWindow(widget)
    app.processEvents()
    combo = widget.horizontal_combo
    combo.setFocus()
    app.processEvents()
    assert combo.hasFocus()
    combo.setCurrentIndex(1)
    wheel(combo)
    assert combo.currentIndex() == 2
    assert widget.setup_dirty is True
    widget.hide()
