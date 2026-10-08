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


def test_ready_catalog_lists_names_without_preselecting(page):
    widget, state, app = page
    state["youtube"] = {"connected": True}
    state["catalog"] = CATALOG
    state["catalog_status"] = {"state": "ready", "message": "Loaded 2 reusable keys for Owned channel.", "attempts": 0, "http_status": None}
    widget.render(state)
    assert placeholders(widget) == {"Choose…"}
    assert [widget.channel_combo.itemText(i) for i in range(widget.channel_combo.count())] == ["Choose…", "Owned channel"]
    assert [widget.horizontal_combo.itemText(i) for i in range(widget.horizontal_combo.count())] == ["Choose…", "Horizontal key", "Vertical key"]
    assert widget.channel_combo.currentData() is None
    assert widget.horizontal_combo.currentData() is None
    assert widget.portrait_combo.currentData() is None
    assert widget.privacy.currentData() is None
    assert widget.audience.currentData() is None
    assert widget.catalog_note.text() == "Loaded 2 reusable keys for Owned channel."
    assert not widget.prepare_button.isEnabled()


def test_ready_catalog_without_keys_tells_user_to_create_them(page):
    widget, state, app = page
    state["youtube"] = {"connected": True}
    state["catalog"] = {"channels": [{"id": "UCowned", "title": "Owned channel"}], "streams": []}
    state["catalog_status"] = {"state": "ready", "message": "No reusable stream keys were found on this channel. Create two in YouTube Studio, then refresh keys.", "attempts": 0, "http_status": None}
    widget.render(state)
    assert placeholders(widget) == {"No reusable keys found"}


def test_saved_setup_is_shown_once_catalog_loads(page):
    widget, state, app = page
    state["youtube"] = {"connected": True}
    state.update(configured=True, configuration={"channel_id": "UCowned", "horizontal_id": "stream-h", "portrait_id": "stream-v",
                                                 "privacy": "unlisted", "made_for_kids": False, "auto_rearm": False})
    widget.render(state)
    assert widget.horizontal_combo.currentData() is None, "names are unknown until discovery completes"
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
