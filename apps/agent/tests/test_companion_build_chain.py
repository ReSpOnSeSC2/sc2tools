import os
from copy import deepcopy
from unittest.mock import Mock

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest

pytest.importorskip("PySide6")
from PySide6 import QtCore, QtGui, QtWidgets

from sc2tools_agent.ui.companion_build_chain import BATCH_SIZE, TIME_RANGES, _entity_name, _event_time, build_build_chain


@pytest.fixture
def chain():
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    calls = []
    pixmap = QtGui.QPixmap(38, 38)
    pixmap.fill(QtGui.QColor("#426a35"))

    def icon_provider(name, kind):
        calls.append((name, kind))
        return QtGui.QIcon(pixmap)

    widget = build_build_chain(None, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets, icon_provider=icon_provider)
    widget.resize(560, 180)
    widget.show()
    app.processEvents()
    yield widget, calls, app
    widget.close()
    widget.deleteLater()
    app.processEvents()


def events(count=12):
    return [{"name": "Hatchery" if index % 2 == 0 else "SpawningPool", "timeSec": index * 30,
             "kind": "building", "timing": "started"} for index in range(count)]


def settle(app):
    for _index in range(5):
        app.processEvents()


def test_default_range_includes_every_step_through_three_minutes_without_a_row_cap(chain):
    widget, calls, app = chain
    source = [{"name": f"Gateway{index}", "timeSec": index * 2, "kind": "building"} for index in range(91)]
    source.append({"name": "Stargate", "timeSec": 180.1, "kind": "building"})
    widget.set_events(source)
    settle(app)
    assert widget.time_range() == 180
    assert len(widget.steps) == 91
    assert widget.steps[-1].time_label.text() == "3:00"
    assert len(widget.events) == 92
    assert "1 after 3:00" in widget.summary.text()
    assert "Through 3:00" in widget.accessibleDescription()


def test_ranges_are_inclusive_preserve_observation_order_and_expand_to_the_full_source(chain):
    widget, calls, app = chain
    timestamps = [360, 0, 180, 180.1, 360.1, 600, 600.1, None]
    source = [{"name": f"Gateway{index}", "timeSec": stamp, "kind": "building", "timing": "started"}
              for index, stamp in enumerate(timestamps)]
    widget.set_events(source)
    for horizon, wanted in ((180, [0, 180]), (360, [360, 0, 180, 180.1]),
                            (600, [360, 0, 180, 180.1, 360.1, 600]), (None, timestamps)):
        widget.set_time_range(horizon)
        assert [step.observation["timeSec"] for step in widget.steps] == wanted
        assert len(widget.events) == len(source)
        assert all(step.timing_label.text() == "Started" for step in widget.steps)
    assert widget.steps[-1].time_label.text() == "Time unknown"
    assert "Time unknown" in widget.steps[-1].accessibleName()
    assert "1 with unknown timing" in widget.summary.text()
    assert "Full build order" in widget.accessibleDescription()
    assert "more replay steps" not in widget.summary.text()


@pytest.mark.parametrize("invalid", [None, True, False, -1, float("nan"), float("inf"), -float("inf"), "12"])
def test_unknown_times_are_not_placed_inside_a_timed_range(chain, invalid):
    widget, calls, app = chain
    source = [{"name": "Gateway", "timeSec": invalid, "kind": "building"},
              {"name": "Stargate", "kind": "building"}]
    widget.set_events(source)
    assert not widget.steps
    assert widget.empty.text() == "No timed replay steps through 3:00"
    assert not widget.empty.isHidden()
    assert "2 with unknown timing" in widget.summary.text()
    assert "+2 more replay steps" in widget.summary.text()
    assert "Full build order" in widget.summary.text()
    widget.set_time_range(None)
    assert [step.time_label.text() for step in widget.steps] == ["Time unknown", "Time unknown"]
    assert all(step.observation["timeSec"] is None for step in widget.steps)


def test_summary_distinguishes_later_unknown_and_explicitly_limited_steps(chain):
    widget, calls, app = chain
    timestamps = [180, 181, None, 0, 360, 600]
    widget.set_events([{"name": "Gateway", "timeSec": stamp, "kind": "building"} for stamp in timestamps], limit=1)
    assert len(widget.steps) == 1
    assert widget.steps[0].observation["timeSec"] == 180
    assert "+5 more replay steps" in widget.summary.text()
    assert "3 after 3:00" in widget.summary.text()
    assert "1 with unknown timing" in widget.summary.text()
    assert "1 hidden by step limit" in widget.summary.text()
    widget.set_time_range(None)
    assert len(widget.steps) == 1
    assert "5 hidden by step limit" in widget.summary.text()
    widget.set_events(widget.events)
    assert len(widget.steps) == 6
    assert "hidden" not in widget.summary.text()


def test_refresh_and_information_density_never_reset_the_selected_time_range(chain):
    widget, calls, app = chain
    source = events(40)
    widget.set_events(source)
    widget.set_time_range(600)
    tiles = tuple(widget.steps)
    for density in ("compact", "standard", "detailed", "full"):
        widget.set_density(density)
        widget.set_events(deepcopy(source))
        assert widget.time_range() == 600
        assert len(widget.steps) == 21
        assert all(current is previous for current, previous in zip(widget.steps, tiles))
    source.append({"name": "Hive", "timeSec": 590, "kind": "building", "timing": "completed"})
    widget.set_events(source)
    assert widget.time_range() == 600
    assert widget.steps[-1].timing_label.text() == "Completed"
    widget.set_events(events(2))
    assert widget.time_range() == 600 and len(widget.steps) == 2


def test_shared_range_control_labels_are_explicit_and_invalid_ranges_leave_selection_intact(chain):
    widget, calls, app = chain
    assert TIME_RANGES == (("3 minutes", 180), ("6 minutes", 360), ("10 minutes", 600), ("Full build order", None))
    assert widget.accessibleName() == "Replay build chain"
    for invalid in (True, False, "180", 180.0, -1, 0, 179, 601):
        with pytest.raises(ValueError):
            widget.set_time_range(invalid)
        assert widget.time_range() == 180


def test_unchanged_timed_range_refresh_preserves_scroll_tiles_and_icon_requests(chain):
    widget, calls, app = chain
    source = [{"name": "Gateway", "timeSec": index * 7, "kind": "building"} for index in range(80)]
    widget.set_time_range(600)
    widget.set_events(source)
    settle(app)
    tiles = tuple(widget.steps)
    icon_calls = len(calls)
    scrollbar = widget.scroll.verticalScrollBar()
    position = scrollbar.maximum() // 2
    assert position > 0
    scrollbar.setValue(position)
    for _index in range(3):
        widget.set_events(deepcopy(source))
        widget.set_time_range(600)
        settle(app)
    assert widget.time_range() == 600
    assert scrollbar.value() == position
    assert all(current is previous for current, previous in zip(widget.steps, tiles))
    assert len(calls) == icon_calls


def test_large_full_source_loads_in_explicit_accessible_batches_without_discarding_steps(chain):
    widget, calls, app = chain
    source = [{"name": f"Gateway{index}", "timeSec": index, "kind": "building"} for index in range(250)]
    widget.set_time_range(None)
    widget.set_events(source)
    assert len(widget.events) == 250 and len(widget.steps) == BATCH_SIZE == 100
    assert len(calls) == 100
    assert "Showing 100 of 250 replay steps" in widget.summary.text()
    assert "150 not loaded yet" in widget.summary.text()
    assert widget.more_button.accessibleName() == "Show next 100 replay steps"
    first_batch = tuple(widget.steps)
    widget.more_button.click()
    assert len(widget.steps) == 200 and len(calls) == 200
    assert all(current is previous for current, previous in zip(widget.steps, first_batch))
    assert widget.more_button.text() == "Show next 50 steps"
    widget.more_button.click()
    assert len(widget.steps) == 250 and len(calls) == 250
    assert widget.more_button.isHidden()
    assert "Showing 250 of 250 replay steps" in widget.summary.text()
    assert "not loaded" not in widget.summary.text()
    assert [step.observation["name"] for step in widget.steps] == [event["name"] for event in source]


def test_range_change_resets_batch_progress_but_identical_refresh_preserves_expanded_scroll(chain):
    widget, calls, app = chain
    source = [{"name": "Gateway", "timeSec": index, "kind": "building"} for index in range(300)]
    widget.set_time_range(None)
    widget.set_events(source)
    widget.more_button.click()
    settle(app)
    tiles = tuple(widget.steps)
    scrollbar = widget.scroll.verticalScrollBar()
    position = scrollbar.maximum() // 2
    assert position > 0
    scrollbar.setValue(position)
    icon_calls = len(calls)
    widget.set_events(deepcopy(source))
    widget.set_time_range(None)
    settle(app)
    assert len(widget.steps) == 200 and scrollbar.value() == position
    assert len(calls) == icon_calls
    assert all(current is previous for current, previous in zip(widget.steps, tiles))
    widget.set_time_range(180)
    assert len(widget.steps) == 100
    assert "Showing 100 of 181 replay steps" in widget.summary.text()
    widget.more_button.click()
    assert len(widget.steps) == 181
    assert widget.steps[-1].observation["timeSec"] == 180
    assert widget.more_button.isHidden()
    widget.set_time_range(600)
    assert len(widget.steps) == 100 and widget.more_button.isVisible()


def test_batch_counts_are_separate_from_an_explicit_legacy_step_limit(chain):
    widget, calls, app = chain
    widget.set_time_range(None)
    widget.set_events(events(250), limit=150)
    assert len(widget.events) == 250 and len(widget.steps) == 100
    assert "100 hidden by step limit" in widget.summary.text()
    assert "50 not loaded yet" in widget.summary.text()
    widget.more_button.click()
    assert len(widget.steps) == 150 and widget.more_button.isHidden()
    assert "100 hidden by step limit" in widget.summary.text()
    widget.set_events(widget.events)
    assert len(widget.steps) == 100 and len(widget.events) == 250
    assert "hidden by step limit" not in widget.summary.text()


def test_maximum_stored_log_does_not_eagerly_construct_thousands_of_qt_tiles(chain):
    widget, calls, app = chain
    widget.set_time_range(None)
    widget.set_events([{"name": "Gateway", "timeSec": index, "kind": "building"} for index in range(5000)])
    assert len(widget.events) == 5000
    assert len(widget.steps) == len(calls) == BATCH_SIZE
    assert "Showing 100 of 5000 replay steps" in widget.summary.text()
    assert "4900 not loaded yet" in widget.summary.text()


def test_narrow_standard_tile_width_fits_two_icons_without_changing_events_or_detailed_density(chain):
    widget, calls, app = chain
    widget.set_time_range(None)
    widget.set_events(events(8))
    first_tiles = tuple(widget.steps)
    widget.set_tile_width(90)
    widget.resize(210, 200)
    settle(app)
    assert widget._columns == 2 and widget._tile_width == 90
    assert widget.scroll.horizontalScrollBar().maximum() == 0
    assert all(step.name_label.height() == 18 and not step.name_label.wordWrap() for step in widget.steps)
    assert all(current is previous for current, previous in zip(widget.steps, first_tiles))
    assert len(widget.events) == 8 and widget.time_range() is None
    widget.set_density("detailed")
    settle(app)
    assert widget._tile_width == 120
    assert all(step.name_label.height() == 34 and step.name_label.wordWrap() for step in widget.steps)
    widget.set_density("standard")
    assert widget._tile_width == 90
    widget.set_tile_width(None)
    assert widget._tile_width == 112
    assert all(current is previous for current, previous in zip(widget.steps, first_tiles))


@pytest.mark.parametrize("width", [True, False, 0, 71, 241, "90", 90.0])
def test_invalid_tile_width_never_changes_current_layout(chain, width):
    widget, calls, app = chain
    with pytest.raises(ValueError):
        widget.set_tile_width(width)
    assert widget._tile_width == 112


def test_observed_labels_and_raw_icon_names_are_preserved(chain):
    widget, calls, app = chain
    widget.set_time_range(None)
    source = [
        {"name": "Hatchery", "timeSec": 17.9, "kind": "building", "timing": "started"},
        {"name": "zerglingmovementspeed", "timeSec": 140, "kind": "upgrade", "timing": "completed"},
        {"name": "Zergling", "timeSec": None, "kind": "unit"},
    ]
    widget.set_events(source)
    settle(app)
    assert calls == [(event["name"], event["kind"]) for event in source]
    assert [step.name_label.text() for step in widget.steps] == ["Hatchery", "Metabolic Boost", "Zergling"]
    assert [step.time_label.text() for step in widget.steps] == ["0:17", "2:20", "Time unknown"]
    assert [step.timing_label.text() for step in widget.steps] == ["Started", "Completed", "Recorded"]
    assert not widget.steps[0].icon_label.pixmap().isNull()
    assert widget.steps[1].icon_label.size().toTuple() == (44, 44)
    assert "Completed" in widget.steps[1].accessibleName()
    assert source[2].get("timing") is None


def test_unknown_categories_still_request_offline_icons_without_reclassifying_observations(chain):
    widget, calls, app = chain
    source = [{"name": "Sentry", "timeSec": 125, "kind": "unknown", "timing": "completed"},
              {"name": "Phoenix", "timeSec": 150, "kind": "unknown", "timing": "recorded"}]
    widget.set_events(source)
    settle(app)
    assert calls == [("Sentry", "unknown"), ("Phoenix", "unknown")]
    assert widget.events == source
    assert all(step.icon_label.text() == "" and not step.icon_label.pixmap().isNull() for step in widget.steps)


@pytest.mark.parametrize("value", [None, True, False, -1, float("nan"), float("inf"), "12"])
def test_invalid_times_never_become_guessed_timestamps(value):
    assert _event_time(value) == "—"


def test_known_upgrade_names_are_readable_without_changing_icon_lookup():
    assert _entity_name("BlinkTech") == "Blink"
    assert _entity_name("ShieldWall") == "Combat Shield"
    assert _entity_name("PunisherGrenades") == "Concussive Shells"
    assert _entity_name("CyberneticsCore") == "Cybernetics Core"


def test_limits_are_explicit_and_density_does_not_silently_discard_events(chain):
    widget, calls, app = chain
    widget.set_time_range(None)
    source = events()
    widget.set_events(source, limit=4)
    assert len(widget.steps) == 4
    assert "+8 more replay steps" in widget.summary.text() and "8 hidden by step limit" in widget.summary.text()
    widget.set_density("detailed")
    assert len(widget.steps) == 4
    widget.set_events(source, limit=8)
    assert len(widget.steps) == 8 and "+4 more replay steps" in widget.summary.text()
    widget.set_density("full")
    widget.set_events(source)
    assert len(widget.steps) == 12 and widget.summary.isHidden()
    assert [step.observation["timeSec"] for step in widget.steps] == [event["timeSec"] for event in source]


def test_grid_wraps_at_narrow_widths_without_horizontal_overflow(chain):
    widget, calls, app = chain
    widget.set_time_range(None)
    widget.set_events(events(8))
    settle(app)
    assert widget._columns == 4
    for width, columns in ((280, 3), (150, 1), (560, 4)):
        widget.resize(width, 180)
        settle(app)
        assert widget._columns == columns
        assert widget.scroll.horizontalScrollBar().maximum() == 0
        assert widget.content.width() <= widget.scroll.viewport().width()
        assert all(step.geometry().right() < widget.content.width() for step in widget.steps)
    assert widget.steps[3].arrow.text() == "↳"
    assert widget.steps[-1].arrow.isHidden()


def test_many_steps_scroll_vertically_and_replacing_source_removes_old_tiles(chain):
    widget, calls, app = chain
    widget.set_time_range(None)
    widget.set_events(events(80))
    settle(app)
    assert len(widget.steps) == 80
    assert widget.scroll.verticalScrollBar().maximum() > 0
    assert widget.scroll.horizontalScrollBar().maximum() == 0
    widget.set_events([{ "name": "Factory", "timeSec": 150, "kind": "building", "timing": "started"}])
    settle(app)
    assert len(widget.steps) == 1
    assert widget.grid.count() == 1
    assert widget.steps[0].name_label.text() == "Factory"
    widget.set_events([None, {}, {"name": ""}])
    settle(app)
    assert not widget.steps
    assert not widget.empty.isHidden()
    assert widget.scroll.isHidden()


def test_identical_normalized_snapshots_preserve_tiles_scroll_and_icon_calls(chain):
    widget, calls, app = chain
    widget.set_time_range(None)
    source = events(80)
    source[0].pop("timing")
    widget.set_events(source)
    widget.set_density("full")
    settle(app)
    tiles = tuple(widget.steps)
    icon_calls = len(calls)
    scrollbar = widget.scroll.verticalScrollBar()
    position = scrollbar.maximum() // 2
    assert position > 0
    scrollbar.setValue(position)
    refreshed = deepcopy(source)
    refreshed[0]["timing"] = "recorded"
    refreshed[0]["unusedMetadata"] = "new snapshot"
    for _index in range(3):
        widget.set_events(deepcopy(refreshed))
        widget.set_density("full")
        settle(app)
    assert all(current is previous for current, previous in zip(widget.steps, tiles))
    assert scrollbar.value() == position
    assert len(calls) == icon_calls
    widget.resize(280, 180)
    settle(app)
    assert widget._columns == 3
    assert all(current is previous for current, previous in zip(widget.steps, tiles))
    assert widget.scroll.horizontalScrollBar().maximum() == 0


@pytest.mark.parametrize("density", ["standard", "detailed", "full"])
def test_narrow_cards_share_row_width_for_two_or_three_readable_steps(chain, density):
    widget, calls, app = chain
    widget.set_time_range(None)
    source = events(12)
    widget.set_events(source)
    widget.set_density(density)
    tiles = tuple(widget.steps)
    icon_calls = len(calls)
    for width, columns in ((230, 2), (300, 3), (560, 4), (230, 2)):
        widget.resize(width, 200)
        settle(app)
        assert widget._columns == columns
        assert widget.grid.itemAtPosition(0, columns - 1).widget() is tiles[columns - 1]
        assert widget.grid.itemAtPosition(1, 0).widget() is tiles[columns]
        assert widget.scroll.horizontalScrollBar().maximum() == 0
        assert widget.content.width() <= widget.scroll.viewport().width()
        for step in widget.steps:
            assert step.width() >= 80
            assert step.icon_label.size() == QtCore.QSize(44, 44)
            assert step.geometry().right() < widget.content.width()
            assert step.time_label.width() >= step.time_label.sizeHint().width()
        assert all(current is previous for current, previous in zip(widget.steps, tiles))
    assert len(calls) == icon_calls
    assert [step.observation["timeSec"] for step in widget.steps] == [event["timeSec"] for event in source]


def test_changed_event_or_limit_updates_tiles_and_unchanged_density_never_reflows(chain, monkeypatch):
    widget, calls, app = chain
    widget.set_time_range(None)
    source = events(12)
    widget.set_events(source, limit=4)
    previous = widget.steps[0]
    widget.set_events(deepcopy(source), limit=4)
    assert widget.steps[0] is previous
    changed = deepcopy(source)
    changed[0]["timeSec"] = 75
    widget.set_events(changed, limit=4)
    assert widget.steps[0] is not previous
    assert widget.steps[0].time_label.text() == "1:15"
    widget.set_events(changed, limit=8)
    assert len(widget.steps) == 8 and "+4 more replay steps" in widget.summary.text()
    settle(app)
    reflow = Mock(wraps=widget._reflow)
    monkeypatch.setattr(widget, "_reflow", reflow)
    widget.set_density("standard")
    reflow.assert_not_called()
    widget.set_density("detailed")
    reflow.assert_called_once_with()
    widget.set_density("detailed")
    reflow.assert_called_once_with()


def test_same_viewport_does_not_rebuild_layout_or_request_more_geometry(chain, monkeypatch):
    widget, calls, app = chain
    widget.set_events(events(40))
    settle(app)
    layout_add = Mock(wraps=widget.grid.addWidget)
    adjust = Mock(wraps=widget.content.adjustSize)
    monkeypatch.setattr(widget.grid, "addWidget", layout_add)
    monkeypatch.setattr(widget.content, "adjustSize", adjust)
    for _ in range(20):
        widget._reflow()
    assert layout_add.call_count == 0
    assert adjust.call_count == 0
    widget.resize(280, 180)
    settle(app)
    assert widget._columns == 3
    assert layout_add.call_count > 0
    assert widget.scroll.horizontalScrollBar().maximum() == 0
