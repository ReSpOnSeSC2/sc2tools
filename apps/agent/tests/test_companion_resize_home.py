from tests._gui_offscreen import run_gui_check


def test_home_remains_readable_and_scrollable_through_size_changes(tmp_path):
    run_gui_check(tmp_path, '''
        import os
        from sc2tools_agent.ui import theme
        from sc2tools_agent.ui.companion_console import build_companion_console

        fonts = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
        for filename in ("segoeui.ttf", "segoeuib.ttf", "seguisb.ttf"):
            font_path = fonts / filename
            if font_path.is_file():
                QtGui.QFontDatabase.addApplicationFont(str(font_path))
        app.setFont(QtGui.QFont("Segoe UI", 10))
        app.setStyleSheet(theme.STYLE)
        scouting = QtWidgets.QPlainTextEdit()
        scouting.setPlainText("Unsaved scouting note")
        console = build_companion_console(
            None, profile_widget=QtWidgets.QLabel("Opponent"), scouting_widget=scouting,
            tools={route: QtWidgets.QLabel(route) for route in ("builds", "randomizer", "ghost")},
            opponents_widget=QtWidgets.QListWidget(),
            QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets,
        )
        console.set_context(opponent_id="one", game_id="game-one")
        console.set_opponent_summary(name="NightshadeTheLongOpponentName", race="Protoss", mmr=5132, wins=3, losses=3)
        for text in ("Standard", "Voice off", "Assistance", "Agent"):
            console.brand_actions.addWidget(QtWidgets.QPushButton(text))
        home = console._pages["home"]
        assert isinstance(home, QtWidgets.QScrollArea)
        description = home.widget().findChild(QtWidgets.QLabel, "consolePageDescription")
        last_action = list(console.home_actions.values())[-1]
        context = console.context()
        original_parents = {button: button.parentWidget() for button in console.home_actions.values()}
        observed_scrolling = False
        try:
            for density, width, height in (
                ("standard", 520, 480), ("detailed", 1024, 800),
                ("standard", 420, 300), ("standard", 380, 260),
                ("detailed", 1024, 800), ("standard", 520, 480),
            ):
                console.set_density(density)
                console.resize(width, height)
                console.show()
                QtTest.QTest.qWait(20)
                assert console.current_route() == "home"
                assert console.context() == context
                assert (console.width(), console.height()) == (width, height)
                assert description.height() >= description.heightForWidth(description.width())
                assert home.horizontalScrollBar().maximum() == 0
                observed_scrolling |= home.verticalScrollBar().maximum() > 0
                home.ensureWidgetVisible(last_action)
                QtTest.QTest.qWait(5)
                assert home.viewport().rect().contains(last_action.mapTo(home.viewport(), last_action.rect().topLeft()))
                assert home.viewport().rect().contains(last_action.mapTo(home.viewport(), last_action.rect().bottomRight()))
                assert all(button.parentWidget() is original_parents[button] for button in original_parents)
            assert observed_scrolling
            console.navigate("scouting")
            assert scouting.toPlainText() == "Unsaved scouting note"
        finally:
            console.close()
            console.deleteLater()
            app.processEvents()
    ''')
