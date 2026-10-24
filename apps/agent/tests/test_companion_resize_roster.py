from textwrap import dedent

from tests._gui_offscreen import run_gui_check


_ROSTER_SETUP = dedent('''
    import os
    from types import SimpleNamespace
    from sc2tools_agent.ui import theme
    from sc2tools_agent.ui.companion_page import _STYLE
    from sc2tools_agent.ui.team_roster import build_team_roster

    fonts = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
    for filename in ("segoeui.ttf", "segoeuib.ttf", "seguisb.ttf"):
        font_path = fonts / filename
        if font_path.is_file():
            QtGui.QFontDatabase.addApplicationFont(str(font_path))
    app.setFont(QtGui.QFont("Segoe UI", 10))
    app.setStyleSheet(theme.STYLE)
    host = QtWidgets.QWidget()
    host.setObjectName("companionDesk")
    host.setStyleSheet(_STYLE)
    layout = QtWidgets.QVBoxLayout(host)
    layout.setContentsMargins(0, 0, 0, 0)
    roster = build_team_roster(host, QtCore=QtCore, QtWidgets=QtWidgets)
    layout.addWidget(roster)
    state = SimpleNamespace(
        candidate={"gameKey": "team-game"}, signature=("owner", "team-game"),
        ready=True, selected_key="enemy-1", bindings={},
        enemies=[{"key": f"enemy-{index}", "name": f"Enemy {index}", "race": "Protoss"}
                 for index in range(1, 5)],
    )
''')


def test_standard_roster_header_contains_themed_controls_when_resized(tmp_path):
    run_gui_check(tmp_path, _ROSTER_SETUP + dedent('''
        roster.set_density("standard")
        host.resize(520, 180)
        host.show()
        roster.render(state, [], {})
        try:
            for width in (520, 380, 280, 520):
                host.resize(width, 180)
                QtTest.QTest.qWait(20)
                assert host.width() == width
                assert not roster.scroll.isVisible()
                for widget in (roster.status, roster.open_roster, roster.configure):
                    assert roster.rect().contains(widget.geometry()), (width, roster.size(), widget.geometry())
                assert not roster.open_roster.geometry().intersects(roster.configure.geometry())
                assert roster.open_roster.height() >= roster.open_roster.minimumSizeHint().height()
                assert roster.configure.height() >= roster.configure.minimumSizeHint().height()
        finally:
            host.close()
            host.deleteLater()
            app.processEvents()
    '''))


def test_expanded_roster_reflows_without_rendering_or_replacing_selection(tmp_path):
    run_gui_check(tmp_path, _ROSTER_SETUP + dedent('''
        roster.set_density("full")
        host.resize(1024, 250)
        host.show()
        QtTest.QTest.qWait(20)
        roster.render(state, [], {})
        QtTest.QTest.qWait(20)
        buttons = tuple(roster._buttons)
        selection_events = []
        identity_events = []
        roster.selected.connect(selection_events.append)
        roster.identityRequested.connect(identity_events.append)
        try:
            for width in (1024, 380, 520, 1024):
                host.resize(width, 250)
                QtTest.QTest.qWait(20)
                assert host.width() == width
                assert tuple(roster._buttons) == buttons
                assert buttons[0].isChecked()
                assert not selection_events and not identity_events
                positions = [roster.grid.getItemPosition(index)[:2] for index in range(roster.grid.count())]
                assert max(column for _row, column in positions) == (0 if width == 380 else 3 if width == 1024 else 1), positions
                assert roster.cards.width() <= roster.scroll.viewport().width()
                for button in buttons:
                    frame = button.parentWidget()
                    assert roster.cards.rect().contains(frame.geometry())
                roster.render(state, [], {})
                assert tuple(roster._buttons) == buttons
            buttons[-1].click()
            assert selection_events == ["enemy-4"]
        finally:
            host.close()
            host.deleteLater()
            app.processEvents()
    '''))


def test_long_enemy_name_stays_available_without_widening_the_roster(tmp_path):
    run_gui_check(tmp_path, _ROSTER_SETUP + dedent('''
        name = "NightshadeWithAnExtremelyLongPlayerName" * 2
        state.enemies[0]["name"] = name
        roster.set_density("full")
        host.resize(380, 250)
        host.show()
        roster.render(state, [], {})
        try:
            QtTest.QTest.qWait(20)
            assert host.width() == 380
            assert roster.cards.width() <= roster.scroll.viewport().width()
            button = roster._buttons[0]
            assert button.toolTip() == name + " · Protoss"
            assert button.accessibleName() == "Select enemy " + name
            assert button.text().endswith("…")
            assert button.fontMetrics().horizontalAdvance(button.text()) <= button.width() - 26
            selected = []
            roster.selected.connect(selected.append)
            button.click()
            assert selected == ["enemy-1"]
        finally:
            host.close()
            host.deleteLater()
            app.processEvents()
    '''))
