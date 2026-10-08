"""Form-only YouTube defaults with synthetic catalogs and no service actions."""
import copy
import os
from types import SimpleNamespace
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest

pytest.importorskip("PySide6")
from PySide6 import QtCore, QtWidgets

from sc2tools_agent.ui.streams_page import build_streams_page, DEFAULT_STREAM_DESCRIPTION
from sc2tools_agent.streaming.service import StreamService


@pytest.fixture
def page():
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    state = {"metadata": {"title": "StarCraft II live", "description": ""}, "metadata_saved": False,
             "configuration": {}, "configured": False, "youtube": {"connected": True},
             "catalog": {"channels": [{"id": "owned", "title": "Owned channel"}], "streams": []}}
    calls = []
    widget = build_streams_page(None, provider=lambda: state, handler=calls.append,
                               QtCore=QtCore, QtWidgets=QtWidgets)
    widget.timer.stop()
    yield widget, state, calls
    widget.deleteLater()
    app.processEvents()


def key(identity, title, **extra):
    return {"id": identity, "title": title, "channel_id": "owned", **extra}


def test_new_description_is_an_editable_draft_and_never_saved_on_refresh(page):
    widget, state, calls = page
    original = copy.deepcopy(state)
    assert widget.description_input.toPlainText() == DEFAULT_STREAM_DESCRIPTION
    assert widget.description_dirty
    widget.description_input.setPlainText("My own description")
    widget.refresh()
    assert widget.description_input.toPlainText() == "My own description"
    assert state == original
    assert calls == []


@pytest.mark.parametrize("description", ["", "My saved template"])
def test_saved_description_including_empty_is_preserved(page, description):
    widget, state, calls = page
    state["metadata_saved"] = True
    state["metadata"]["description"] = description
    widget.description_dirty = False
    widget.render(state)
    assert widget.description_input.toPlainText() == description
    assert not widget.description_dirty
    assert calls == []


def test_fresh_service_default_description_needs_no_extra_metadata_save(page):
    widget, state, calls = page
    widget.description_dirty = False
    state["metadata"]["description"] = DEFAULT_STREAM_DESCRIPTION
    widget.render(state)
    assert widget.description_input.toPlainText() == DEFAULT_STREAM_DESCRIPTION
    assert not widget.description_dirty
    assert calls == []


@pytest.mark.parametrize("description", ["", "Previously saved description"])
def test_late_saved_description_replaces_only_an_untouched_default_draft(page, description):
    widget, state, calls = page
    state["metadata_saved"] = True
    state["metadata"]["description"] = description
    widget.refresh()
    assert widget.description_input.toPlainText() == description
    assert not widget.description_dirty
    widget.description_input.setPlainText("My unsaved edit")
    state["metadata"]["description"] = "Changed remotely"
    widget.refresh()
    assert widget.description_input.toPlainText() == "My unsaved edit"
    assert calls == []


def test_saved_settings_and_keys_win_over_suggestions_even_when_runtime_is_off(page):
    widget, state, calls = page
    state["configuration"] = {"channel_id": "owned", "horizontal_id": "saved-h", "portrait_id": "saved-v",
                              "privacy": "private", "made_for_kids": True, "auto_rearm": False}
    state["catalog"]["streams"] = [key("saved-h", "My key", bound_elsewhere=True), key("saved-v", "My other key"),
                                    key("new-h", "SC2ToolsHorizontal"), key("new-v", "VerticalStream")]
    widget.render(state)
    assert widget.horizontal_combo.currentData() == "saved-h"
    assert widget.portrait_combo.currentData() == "saved-v"
    assert widget.privacy.currentData() == "private"
    assert widget.audience.currentData() is True
    assert not widget.auto_check.isChecked()
    assert calls == []


@pytest.mark.parametrize("title, expected", [("SC2ToolsHorizontal", "horizontal_id"), ("VerticalStream", "portrait_id")])
def test_one_named_role_allows_the_other_distinct_remaining_key(page, title, expected):
    widget, state, calls = page
    state["catalog"]["streams"] = [key("named", title), key("other", "My reusable key")]
    widget.render(state)
    combos = {"horizontal_id": widget.horizontal_combo, "portrait_id": widget.portrait_combo}
    assert combos[expected].currentData() == "named"
    assert combos["portrait_id" if expected == "horizontal_id" else "horizontal_id"].currentData() == "other"
    assert calls == []


@pytest.mark.parametrize("count, expected", [(2, "key-1"), (3, None)])
def test_ambiguous_names_wait_until_only_one_distinct_key_remains(page, count, expected):
    widget, state, calls = page
    state["catalog"]["streams"] = [key("key-" + str(n), "Reusable " + str(n)) for n in range(count)]
    widget.render(state)
    assert widget.horizontal_combo.currentData() is None
    assert widget.portrait_combo.currentData() is None
    widget.horizontal_combo.setCurrentIndex(widget.horizontal_combo.findData("key-0"))
    widget.refresh()
    assert widget.horizontal_combo.currentData() == "key-0"
    assert widget.portrait_combo.currentData() == expected
    assert calls == []


def test_multiple_channels_and_multiple_named_keys_remain_a_choice(page):
    widget, state, calls = page
    state["catalog"] = {"channels": [{"id": "owned", "title": "Owned"}, {"id": "other", "title": "Other"}],
                        "streams": [key("h1", "Horizontal key"), key("h2", "Horizontal backup"), key("v", "VerticalStream")]}
    widget.render(state)
    assert widget.channel_combo.currentData() is None
    widget.channel_combo.setCurrentIndex(widget.channel_combo.findData("owned"))
    assert widget.horizontal_combo.currentData() is None
    assert widget.portrait_combo.currentData() == "v"
    assert calls == []


@pytest.mark.parametrize("excluded", [{"eligible": False}, {"available": False}, {"bound_elsewhere": True},
                                      {"bound_broadcast_id": "another-event"}, {"stream_status": "active"},
                                      {"status": {"streamStatus": "active"}}, {"channel_id": "another-channel"}])
def test_known_unavailable_keys_are_not_suggested(page, excluded):
    widget, state, calls = page
    state["catalog"]["streams"] = [key("h", "SC2ToolsHorizontal", **excluded), key("v", "VerticalStream")]
    widget.render(state)
    assert widget.horizontal_combo.currentData() is None
    assert widget.portrait_combo.currentData() == "v"
    assert calls == []


def test_duplicate_ids_and_names_with_both_roles_are_not_guessed(page):
    widget, state, calls = page
    state["catalog"]["streams"] = [key("duplicate", "Horizontal key"), key("duplicate", "Vertical key"),
                                    key("both", "Horizontal Vertical key"), key("generic", "Reusable")]
    widget.render(state)
    assert widget.horizontal_combo.currentData() is None
    assert widget.portrait_combo.currentData() is None
    assert calls == []


def test_dirty_selections_and_fields_survive_catalog_removal_and_periodic_refresh(page):
    widget, state, calls = page
    state["catalog"]["streams"] = [key("h", "Horizontal key"), key("v", "Vertical key")]
    widget.render(state)
    widget.horizontal_combo.setCurrentIndex(0)
    widget.horizontal_combo.setCurrentIndex(widget.horizontal_combo.findData("h"))
    widget.portrait_combo.setCurrentIndex(0)
    widget.portrait_combo.setCurrentIndex(widget.portrait_combo.findData("v"))
    widget.privacy.setCurrentIndex(widget.privacy.findData("unlisted"))
    widget.audience.setCurrentIndex(widget.audience.findData(True))
    widget.auto_check.setChecked(False)
    widget.description_input.setPlainText("")
    state["catalog"] = {"channels": [], "streams": []}
    widget.refresh()
    assert widget.channel_combo.currentData() == "owned"
    assert widget.horizontal_combo.currentData() == "h"
    assert widget.portrait_combo.currentData() == "v"
    assert widget.privacy.currentData() == "unlisted"
    assert widget.audience.currentData() is True
    assert not widget.auto_check.isChecked()
    assert widget.description_input.toPlainText() == ""
    assert widget.setup_dirty and widget.description_dirty
    assert calls == []


def test_user_can_leave_an_automatic_choice_unselected_across_refreshes(page):
    widget, state, calls = page
    state["catalog"]["streams"] = [key("h", "Horizontal key"), key("v", "Vertical key")]
    widget.render(state)
    widget.horizontal_combo.setCurrentIndex(0)
    widget.refresh()
    assert widget.horizontal_combo.currentData() is None
    assert widget.portrait_combo.currentData() == "v"
    assert calls == []


@pytest.mark.parametrize("saved_channel", ["saved-channel", "owned"])
def test_late_unavailable_saved_ids_replace_suggestions_without_changing_mapping(page, monkeypatch, saved_channel):
    widget, state, calls = page
    state["catalog"]["streams"] = [key("suggested-h", "Horizontal key"), key("suggested-v", "Vertical key")]
    widget.render(state)
    assert widget.horizontal_combo.currentData() == "suggested-h"
    assert widget.portrait_combo.currentData() == "suggested-v"
    # The catalog does not change when the saved configuration arrives.
    state["configuration"] = {"channel_id": saved_channel, "horizontal_id": "saved-h", "portrait_id": "saved-v",
                              "privacy": "private", "made_for_kids": False, "auto_rearm": False}
    saved = copy.deepcopy(state["configuration"])
    widget.render(state)
    widget.refresh()
    assert widget.channel_combo.currentData() == saved_channel
    assert widget.horizontal_combo.currentData() == "saved-h"
    assert widget.portrait_combo.currentData() == "saved-v"
    if saved_channel != "owned":
        assert "Unavailable saved channel" in widget.channel_combo.currentText()
    assert "Unavailable saved key" in widget.horizontal_combo.currentText()
    assert state["configuration"] == saved
    assert calls == []
    # Exercise the actual service gate with inert reads and no constructor.
    # It must reject these unavailable IDs; the form
    # must send the saved mapping rather than silently substituting suggestions.
    service = StreamService.__new__(StreamService)
    service.backend = SimpleNamespace(connected=True)
    service.catalog = copy.deepcopy(state["catalog"])
    service._outputs = lambda: {"horizontal": False, "portrait": False}
    service._discover_youtube = lambda *, explicit: None
    rejected = []
    def validate(payload):
        rejected.append(payload)
        with pytest.raises(ValueError, match="authorized channel|does not belong"):
            service._configure(payload)
    monkeypatch.setattr(widget, "job", validate)
    widget.configure()
    assert rejected[0]["channel_id"] == saved_channel
    assert (rejected[0]["horizontal_id"], rejected[0]["portrait_id"]) == ("saved-h", "saved-v")
    assert state["configuration"] == saved
