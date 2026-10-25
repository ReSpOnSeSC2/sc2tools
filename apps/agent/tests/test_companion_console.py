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
    for button in [shell.home_button, shell.back_button, shell.previous_game, shell.next_game, shell.browse_button]:
        point = button.mapTo(shell, button.rect().bottomRight())
        assert shell.rect().contains(point)
    assert shell.display_panel.width() > 300
    assert not shell.profile_panel.isVisible()
    assert shell.browse_button.isVisible()
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


def test_small_console_keeps_all_routes_profile_and_drafts_accessible_without_resetting_context(console):
    shell, profile, scouting, notes, tools, library, app = console
    shell.navigate("scouting", opponent_id="one", game_id="game-one")
    original_profile_parent = profile.parentWidget()
    shell.resize(520, 480)
    app.processEvents()
    assert not shell.profile_panel.isVisible()
    assert shell.browse_button.isVisible()
    for route in ("home", "opponents", "profile", "scouting", "builds", "randomizer", "ghost"):
        assert route in shell.browse_actions
        shell.browse_actions[route].trigger()
        app.processEvents()
        assert shell.current_route() == route
        assert shell.context()["opponentId"] == "one" and shell.context()["gameId"] == "game-one"
        if route == "profile":
            assert shell.profile_panel.isVisible()
            assert shell.profile_panel.parentWidget() is shell.profile_route_scroll.viewport()
    shell.resize(1024, 800)
    app.processEvents()
    assert shell.profile_panel.isVisible() and not shell.browse_button.isVisible()
    assert shell.current_route() == "ghost"
    assert notes.toPlainText() == "Unsaved scouting note"
    assert profile.parentWidget() is original_profile_parent


def test_brand_actions_wrap_instead_of_hiding_or_overflowing_small_windows(console):
    from PySide6 import QtWidgets

    shell, profile, scouting, notes, tools, library, app = console
    controls = []
    for title in ("Full workspace", "Read scouting report", "Assistance", "Agent"):
        button = QtWidgets.QPushButton(title)
        shell.brand_actions.addWidget(button)
        controls.append(button)
    window_controls = QtWidgets.QWidget()
    window_controls.setFixedSize(86, 24)
    shell.brand_actions.addWidget(window_controls)
    controls.append(window_controls)
    for width in (520, 480, 1024, 520):
        shell.resize(width, 480)
        app.processEvents()
        assert shell.width() == width
        for widget in controls:
            assert widget.isVisible()
            assert shell.brand_actions_widget.rect().contains(widget.geometry()), (width, widget.geometry(), shell.brand_actions_widget.rect())
            assert shell.rect().contains(widget.mapTo(shell, widget.rect().bottomRight()))
        if width < 800:
            assert not shell.brand_edition.isVisible()
            required_width = sum(max(widget.sizeHint().width(), widget.minimumWidth()) for widget in controls)
            required_width += shell.brand_actions.spacing() * (len(controls) - 1)
            if required_width > shell.brand_actions_widget.width():
                assert len({widget.y() for widget in controls}) > 1


def test_narrow_header_shows_truthful_selected_profile_summary_without_changing_navigation(console):
    from PySide6 import QtCore

    shell, profile, scouting, notes, tools, library, app = console
    shell.navigate("scouting", opponent_id="one", game_id="game-one")
    previous_context = shell.context()
    shell.set_opponent_summary("Nightshade", "Zerg", 4268, 3, 2)
    shell.resize(520, 480)
    app.processEvents()
    assert shell.opponent_summary.isVisible()
    assert shell.opponent_summary_identity.full_text == "Nightshade · Zerg · MMR 4268"
    assert shell.opponent_summary_record.full_text == "Your record 3W · 2L · 60%"
    for label in (shell.opponent_summary_identity, shell.opponent_summary_record):
        assert label.textFormat() == QtCore.Qt.PlainText
        assert "Selected opponent profile" in label.toolTip()
        assert label.fontMetrics().horizontalAdvance(label.text()) <= label.width()
    assert shell.context() == previous_context
    assert notes.toPlainText() == "Unsaved scouting note"
    shell.set_opponent_summary("<b>" + "A very long opponent name " * 5, "unknown", None, None, 5)
    app.processEvents()
    assert "MMR —" in shell.opponent_summary_identity.full_text
    assert shell.opponent_summary_record.full_text == "Your record — · —"
    assert shell.opponent_summary_identity.text() != shell.opponent_summary_identity.full_text
    shell.resize(1024, 800)
    app.processEvents()
    assert shell.opponent_summary.isHidden() and shell.profile_panel.isVisible()


def test_window_controls_attach_to_far_right_top_row_without_losing_wrapped_actions(console):
    from PySide6 import QtWidgets

    shell, profile, scouting, notes, tools, library, app = console
    controls = QtWidgets.QWidget()
    controls.setFixedSize(86, 24)
    action = QtWidgets.QPushButton("Assistance")
    shell.brand_actions.addWidget(action)
    shell.brand_actions.addWidget(controls)
    shell.attach_window_controls(controls)
    assert shell.brand_actions.count() == 1
    shell.set_opponent_summary("Nightshade", "Zerg", 4268, 3, 2)
    for width in (520, 480, 1024, 520):
        shell.resize(width, 480)
        app.processEvents()
        assert controls.isVisible() and action.isVisible()
        assert shell.brand_widget.rect().contains(controls.geometry())
        assert controls.geometry().right() == shell.brand_widget.rect().right()
        assert controls.y() < shell.brand_actions_widget.y() if width < 800 else controls.y() == 0
        assert shell.opponent_summary.isVisible() is (width < 800)


def test_narrow_profile_uses_two_tool_columns_and_returns_to_the_unchanged_wide_rail(console):
    from PySide6 import QtCore

    shell, profile, scouting, notes, tools, library, app = console
    profile_parent = profile.parentWidget()
    shell.resize(442, 374)
    shell.navigate("profile", opponent_id="one", game_id="game-one")
    app.processEvents()
    assert shell.size().toTuple() == (442, 374)
    assert shell.profile_route_scroll.isVisible()
    buttons = list(shell.destination_buttons.values())
    assert buttons[0].y() == buttons[1].y()
    assert buttons[2].y() == buttons[3].y() > buttons[0].y()
    assert buttons[0].x() < buttons[1].x()
    assert shell.profile_scroll.verticalScrollBarPolicy() == QtCore.Qt.ScrollBarAlwaysOff
    assert profile.parentWidget() is profile_parent
    shell.resize(1024, 800)
    shell.set_density("detailed")
    app.processEvents()
    assert shell.profile_panel.parentWidget() is shell
    assert shell.profile_panel.width() == 280
    assert shell.profile_route_scroll.isHidden()
    assert shell.profile_scroll.minimumHeight() == 0
    assert shell.profile_scroll.verticalScrollBarPolicy() == QtCore.Qt.ScrollBarAsNeeded
    assert len({button.y() for button in buttons}) == 4
    assert profile.parentWidget() is profile_parent
    assert notes.toPlainText() == "Unsaved scouting note"


def test_real_standard_profile_scroll_reveals_portrait_identity_record_and_all_tools_without_resizing(tmp_path):
    from tests._gui_offscreen import run_gui_check

    run_gui_check(tmp_path, '''
        import os
        from sc2tools_agent.ui import theme
        fonts = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
        for filename in ("segoeui.ttf", "segoeuib.ttf", "seguisb.ttf"):
            font_path = fonts / filename
            if font_path.is_file():
                QtGui.QFontDatabase.addApplicationFont(str(font_path))
        app.setStyleSheet(theme.STYLE)
        ui, window = make_window(window_page="companion")
        window.show()
        window._set_window_size("Standard")
        page = window._companion_page
        page._selected_id = "sample-opponent"
        shell = page.console
        card = page.profile_card
        card.set_identity("LetaIeX", "Protoss", 5321, wins=12, losses=8)
        shell.set_player_navigation(1, 100)
        shell.set_opponent_summary("LetaIeX", "Protoss", 5321, 12, 8)
        shell.navigate("profile", opponent_id="sample-opponent")
        for tick in range(10):
            app.processEvents()
        assert window.size().toTuple() == (520, 480)
        assert shell.profile_scroll.viewport().height() >= card.minimumHeight()
        assert shell.profile_scroll.verticalScrollBar().maximum() == 0
        scroll = shell.profile_route_scroll
        assert scroll.verticalScrollBar().maximum() > 0
        assert scroll.viewport().height() >= card.portrait.height()
        original_geometry = window.geometry()
        labels = (card.portrait, card.name_label, card.race_label, card.mmr_label,
                  card.record_label, card.win_rate_label)
        for widget in labels:
            scroll.ensureWidgetVisible(widget, 0, 0)
            app.processEvents()
            position = widget.mapTo(scroll.viewport(), QtCore.QPoint())
            assert scroll.viewport().rect().contains(QtCore.QRect(position, widget.size())), widget.objectName()
        assert card.name_label.full_text == "LetaIeX"
        assert card.race_label.text() == "Protoss" and card.mmr_label.text() == "5321"
        assert card.record_label.text() == "12W · 8L" and card.win_rate_label.text() == "60%"
        scroll.ensureWidgetVisible(card.record_label, 0, 0)
        app.processEvents()
        assert window.grab().save(str(base / "standard-profile-record.png"))
        for route, button in shell.destination_buttons.items():
            shell.navigate("profile")
            scroll.ensureWidgetVisible(button, 0, 0)
            app.processEvents()
            position = button.mapTo(scroll.viewport(), QtCore.QPoint())
            assert scroll.viewport().rect().contains(QtCore.QRect(position, button.size()))
            button.click()
            assert shell.current_route() == route
            assert shell.context()["opponentId"] == "sample-opponent"
        assert window.geometry() == original_geometry
        window._race_effects.shutdown()
        page.shutdown()
        window.hide()
    ''')
