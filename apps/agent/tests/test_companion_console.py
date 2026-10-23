from __future__ import annotations

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest

from sc2tools_agent.ui.companion_console import ConsoleNavigation, build_companion_console


def test_navigation_preserves_only_identifiers_and_restores_back_context():
    navigation = ConsoleNavigation()
    navigation.navigate("opponents")
    navigation.navigate("history", opponent_id="opponent-one")
    navigation.navigate("game", game_id="replay-one")
    navigation.navigate("ghost")
    assert navigation.current() == {"route": "ghost", "opponentId": "opponent-one", "gameId": "replay-one"}
    navigation.back()
    assert navigation.current()["route"] == "game"
    navigation.back()
    assert navigation.current() == {"route": "history", "opponentId": "opponent-one", "gameId": None}
    navigation.navigate("history", opponent_id="opponent-two")
    assert navigation.current()["gameId"] is None
    snapshot = navigation.history()
    snapshot[0]["route"] = "modified"
    assert navigation.history()[0]["route"] == "home"
    assert all(set(entry) == {"route", "opponentId", "gameId"} for entry in navigation.history())


def test_navigation_history_is_bounded_and_rejects_objects():
    navigation = ConsoleNavigation()
    for index in range(80):
        navigation.navigate("game", game_id=f"game-{index}")
    assert len(navigation.history()) == 32
    for value in [{"private": "data"}, object(), "x" * 201, ""]:
        with pytest.raises(ValueError):
            navigation.navigate("game", game_id=value)


@pytest.fixture
def console():
    pytest.importorskip("PySide6")
    from PySide6 import QtCore, QtGui, QtWidgets

    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    profile = QtWidgets.QLabel("Opponent portrait\nTerran · 4,000 MMR")
    scouting = QtWidgets.QWidget()
    scouting_layout = QtWidgets.QVBoxLayout(scouting)
    notes = QtWidgets.QPlainTextEdit()
    notes.setPlainText("Unsaved scouting note")
    scouting_layout.addWidget(notes)
    tools = {route: QtWidgets.QLabel(route) for route in ("builds", "randomizer", "ghost")}
    library = QtWidgets.QListWidget()
    library.addItems(["Opponent one", "Opponent two"])
    shell = build_companion_console(None, profile_widget=profile, scouting_widget=scouting, tools=tools,
                                    opponents_widget=library, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
    shell.resize(1050, 700)
    shell.show()
    app.processEvents()
    yield shell, profile, scouting, notes, tools, library, app
    shell.close()
    shell.deleteLater()
    app.processEvents()


def test_console_routes_without_reparenting_or_losing_tool_state(console):
    shell, profile, scouting, notes, tools, library, app = console
    widgets = [profile, scouting, *tools.values(), library]
    parents = [widget.parentWidget() for widget in widgets]
    navigations = []
    shell.navigationChanged.connect(navigations.append)
    shell.navigate("opponents")
    shell.navigate("scouting", opponent_id="one", game_id="game-one")
    shell.destination_buttons["ghost"].click()
    assert shell.content_stack.currentWidget() is tools["ghost"]
    shell.set_density("full")
    shell.set_density("standard")
    shell.resize(820, 540)
    shell.back_button.click()
    app.processEvents()
    assert shell.content_stack.currentWidget() is scouting
    assert shell.context() == {"route": "scouting", "opponentId": "one", "gameId": "game-one"}
    assert notes.toPlainText() == "Unsaved scouting note"
    assert [widget.parentWidget() for widget in widgets] == parents
    assert navigations[-1] == shell.context()
    shell.home_button.click()
    assert shell.current_route() == "home"
    assert shell.context()["gameId"] == "game-one"


def test_console_acknowledges_context_without_reentrant_navigation(console):
    shell, *_rest = console
    events = []
    shell.navigationChanged.connect(events.append)
    shell.set_context(opponent_id="one", game_id="game-one")
    assert events == []
    shell.navigate("scouting")
    assert events[-1]["gameId"] == "game-one"
    assert not shell.navigate("scouting")
    assert len(events) == 1
    assert not shell.navigate("missing")
    assert len(events) == 1


def test_console_game_and_opponent_arrows_are_distinct_and_bounded(console):
    shell, *_rest = console
    games = []
    players = []
    shell.gameStepRequested.connect(games.append)
    shell.playerStepRequested.connect(players.append)
    shell.navigate("scouting")
    shell.set_game_navigation(0, 2, "Win · Test map")
    shell.previous_game.click()
    shell.next_game.click()
    shell.set_player_navigation(1, 2)
    shell.previous_player.click()
    shell.next_player.click()
    assert games == [1]
    assert players == [-1]
    assert shell.game_title.text() == "GAME 1 / 2  ·  Win · Test map"
    shell.set_game_navigation(-1, 0)
    shell.set_player_navigation(-1, 0)
    assert not shell.previous_game.isEnabled()
    assert not shell.next_game.isEnabled()
    assert not shell.previous_player.isEnabled()
    assert not shell.next_player.isEnabled()


def test_console_pages_and_controls_fit_narrow_workspace(console):
    shell, profile, scouting, notes, tools, library, app = console
    shell.resize(734, 450)
    shell.navigate("scouting")
    shell.set_breadcrumb(opponent_name="A long opponent name", game_title="A long map and replay description")
    app.processEvents()
    for button in [shell.home_button, shell.back_button, shell.previous_game, shell.next_game,
                   shell.previous_player, shell.next_player, *shell.destination_buttons.values()]:
        point = button.mapTo(shell, button.rect().bottomRight())
        assert shell.rect().contains(point)
    assert shell.display_panel.width() > 300
    assert shell.profile_panel.isVisible()
    assert shell.content_stack.currentWidget() is scouting


def test_existing_workspace_keeps_all_four_pages_mounted_and_legacy_navigation():
    pytest.importorskip("PySide6")
    from PySide6 import QtCore, QtGui, QtWidgets

    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    workspace = QtWidgets.QTabWidget()
    pages = [QtWidgets.QLabel(title) for title in ("Scouting", "Builds", "Randomizer", "Ghost")]
    for page in pages:
        workspace.addTab(page, page.text())
    parents = [page.parentWidget() for page in pages]
    shell = build_companion_console(None, profile_widget=QtWidgets.QLabel("Identity"),
                                    workspace_tabs=workspace, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
    changes = []
    shell.navigationChanged.connect(changes.append)
    shell.set_context(opponent_id="one", game_id="game-one")
    shell.navigate("scouting")
    shell.destination_buttons["ghost"].click()
    assert workspace.currentIndex() == 3
    workspace.setCurrentIndex(1)
    assert shell.current_route() == "builds"
    assert shell.content_stack.currentWidget() is workspace
    assert changes[-1] == {"route": "builds", "opponentId": "one", "gameId": "game-one"}
    shell.back()
    assert workspace.currentIndex() == 3
    assert len(changes) == 4
    shell.navigate("home")
    shell.navigate("randomizer")
    assert workspace.currentIndex() == 2
    assert workspace.count() == 4
    assert [workspace.widget(index) for index in range(4)] == pages
    assert [page.parentWidget() for page in pages] == parents
    assert workspace.tabBar().isHidden()
    shell.deleteLater()
    app.processEvents()
