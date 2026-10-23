import os
from copy import deepcopy
from unittest.mock import Mock

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest

pytest.importorskip("PySide6")
from PySide6 import QtCore, QtGui, QtWidgets

from sc2tools_agent.ui.companion_build_chain import _entity_name, _event_time, build_build_chain


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


def test_observed_labels_and_raw_icon_names_are_preserved(chain):
    widget, calls, app = chain
    source = [
        {"name": "Hatchery", "timeSec": 17.9, "kind": "building", "timing": "started"},
        {"name": "zerglingmovementspeed", "timeSec": 140, "kind": "upgrade", "timing": "completed"},
        {"name": "Zergling", "timeSec": None, "kind": "unit"},
    ]
    widget.set_events(source)
    settle(app)
    assert calls == [(event["name"], event["kind"]) for event in source]
    assert [step.name_label.text() for step in widget.steps] == ["Hatchery", "Metabolic Boost", "Zergling"]
    assert [step.time_label.text() for step in widget.steps] == ["0:17", "2:20", "—"]
    assert [step.timing_label.text() for step in widget.steps] == ["Started", "Completed", "Recorded"]
    assert not widget.steps[0].icon_label.pixmap().isNull()
    assert widget.steps[1].icon_label.size().toTuple() == (44, 44)
    assert "Completed" in widget.steps[1].accessibleName()
    assert source[2].get("timing") is None


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
    source = events()
    widget.set_events(source, limit=4)
    assert len(widget.steps) == 4
    assert widget.summary.text() == "+8 more replay steps"
    widget.set_density("detailed")
    assert len(widget.steps) == 4
    widget.set_events(source, limit=8)
    assert len(widget.steps) == 8 and widget.summary.text() == "+4 more replay steps"
    widget.set_density("full")
    widget.set_events(source)
    assert len(widget.steps) == 12 and widget.summary.isHidden()
    assert [step.observation["timeSec"] for step in widget.steps] == [event["timeSec"] for event in source]


def test_grid_wraps_at_narrow_widths_without_horizontal_overflow(chain):
    widget, calls, app = chain
    widget.set_events(events(8))
    settle(app)
    assert widget._columns == 4
    for width, columns in ((280, 2), (150, 1), (560, 4)):
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
    assert widget._columns == 2
    assert all(current is previous for current, previous in zip(widget.steps, tiles))
    assert widget.scroll.horizontalScrollBar().maximum() == 0


def test_changed_event_or_limit_updates_tiles_and_unchanged_density_never_reflows(chain, monkeypatch):
    widget, calls, app = chain
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
    assert len(widget.steps) == 8 and widget.summary.text() == "+4 more replay steps"
    settle(app)
    reflow = Mock(wraps=widget._reflow)
    monkeypatch.setattr(widget, "_reflow", reflow)
    widget.set_density("standard")
    reflow.assert_not_called()
    widget.set_density("detailed")
    reflow.assert_called_once_with()
    widget.set_density("detailed")
    reflow.assert_called_once_with()
