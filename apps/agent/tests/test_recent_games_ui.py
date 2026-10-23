import os
from datetime import datetime, timezone

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
import pytest

pytest.importorskip("PySide6")
from PySide6 import QtCore, QtGui, QtTest, QtWidgets

from sc2tools_agent.ui.recent_games import build_recent_games

APP = None


def example(index, **extra):
    return {"path": f"C:/fixture/replay-{index}.SC2Replay", "gameId": f"game-{index}",
            "dateIso": datetime.now(timezone.utc).isoformat(), "status": "uploaded",
            "result": "Victory", "races": {"own": "Protoss", "opponent": "Zerg"},
            "oppName": "Opponent", "map": "Alcyone LE", "durationSec": 675, "mmr": 5321,
            **extra}


@pytest.fixture
def recent(monkeypatch):
    global APP
    APP = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    def forbidden(*args, **kwargs):
        raise AssertionError("Native recent-game verification must never use network or a system browser")
    monkeypatch.setattr("socket.socket.connect", forbidden)
    monkeypatch.setattr("webbrowser.open", forbidden)
    events = []
    widget = build_recent_games(None, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets,
                               open_game=lambda identifier: events.append(("game", identifier)),
                               reveal=lambda path: events.append(("reveal", path)),
                               retry=lambda paths, reason: events.append(("retry", paths, reason)),
                               open_help=lambda slug: events.append(("help", slug)))
    yield widget, events
    widget.deleteLater()
    APP.processEvents()


def test_real_abstract_table_model_inserts_incrementally_and_caps_two_hundred(recent):
    widget, _ = recent
    assert isinstance(widget.model, QtCore.QAbstractTableModel)
    reset = QtTest.QSignalSpy(widget.model.modelReset)
    inserted = QtTest.QSignalSpy(widget.model.rowsInserted)
    for index in range(500):
        widget.append(example(index))
    assert widget.model.rowCount() == 200
    assert widget.model.data(widget.model.index(0, 3)) == "Opponent"
    assert widget.model.visible[0]["gameId"] == "game-499"
    assert widget.model.visible[-1]["gameId"] == "game-300"
    assert inserted.count() == 500 and reset.count() == 0
    existing = QtCore.QPersistentModelIndex(widget.model.index(0, 3))
    widget.append(example(500))
    assert existing.isValid() and existing.row() == 1
    assert widget.model.visible[1]["gameId"] == "game-499"


def test_column_values_and_absolute_time_tooltip_describe_the_actual_game(recent):
    widget, events = recent
    widget.append(example(1))
    model = widget.model
    assert model.columnCount() == 8
    assert [model.headerData(column, QtCore.Qt.Horizontal) for column in range(8)] == [
        "When", "Result", "Matchup", "Opponent", "Map", "Length", "MMR", "Status"]
    assert [model.data(model.index(0, column)) for column in range(1, 8)] == [
        "Victory", "PvZ", "Opponent", "Alcyone LE", "11:15", "5321", "Uploaded"]
    assert "2026" in model.data(model.index(0, 0), QtCore.Qt.ToolTipRole)
    widget.table.doubleClicked.emit(model.index(0, 0))
    assert events == [("game", "game-1")]


def test_filter_counts_and_history_import_collapsed_row(recent):
    widget, _ = recent
    widget.set_rows([example(1), example(2, status="problem", result=None),
                     example(3, isHistory=True), example(4, isHistory=True)])
    assert widget.model.rowCount() == 3
    assert widget.model.visible[-1] == {"_group": True, "count": 2}
    assert widget.filters["all"].text() == "All (4)"
    widget.table.doubleClicked.emit(widget.model.index(2, 0))
    assert widget.model.rowCount() == 5
    widget.filters["problem"].click()
    assert widget.model.rowCount() == 1
    assert widget.model.visible[0]["gameId"] == "game-2"
    assert widget.filters["problem"].text() == "Problems (1)"


def test_context_menu_reveals_exact_path_copies_plain_error_and_retries_selected_failures(recent):
    widget, events = recent
    widget.set_rows([example(1, status="problem", error="Plain error <not markup>"),
                     example(2, status="problem", error="Other error"), example(3)])
    selection = widget.table.selectionModel()
    for index in (0, 1, 2):
        selection.select(widget.model.index(index, 0), QtCore.QItemSelectionModel.Select | QtCore.QItemSelectionModel.Rows)
    row = widget.model.visible[0]
    menu = widget.menu_for(row)
    actions = {action.text(): action for action in menu.actions()}
    actions["Show in Explorer"].trigger()
    actions["Copy path"].trigger()
    assert QtWidgets.QApplication.clipboard().text() == row["path"]
    actions["Copy error"].trigger()
    assert QtWidgets.QApplication.clipboard().text() == "Plain error <not markup>"
    actions["Retry failed"].trigger()
    assert events == [("reveal", row["path"]),
                      ("retry", ["C:/fixture/replay-1.SC2Replay", "C:/fixture/replay-2.SC2Replay"], None)]
    assert "&lt;not markup&gt;" in widget.model.data(widget.model.index(0, 7), QtCore.Qt.ToolTipRole)
    menu.deleteLater()


def test_legacy_rows_without_game_id_reveal_the_local_file_without_inventing_metadata(recent):
    widget, events = recent
    widget.append({"path": "C:/legacy.SC2Replay", "status": "uploaded", "seeded": True})
    assert widget.model.data(widget.model.index(0, 1)) == "—"
    widget.table.doubleClicked.emit(widget.model.index(0, 0))
    assert events == [("reveal", "C:/legacy.SC2Replay")]
