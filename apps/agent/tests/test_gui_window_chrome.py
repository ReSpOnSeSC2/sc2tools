from tests._gui_offscreen import run_gui_check


def test_agent_uses_themed_window_buttons_without_native_titlebar_and_keeps_tray_close(tmp_path):
    run_gui_check(tmp_path, '''
        from sc2tools_agent.ui import theme
        font = Path("C:/Windows/Fonts/segoeui.ttf")
        if font.is_file():
            QtGui.QFontDatabase.addApplicationFont(str(font))
        app.setStyleSheet(theme.STYLE)
        ui, win = make_window(window_page="dashboard")
        ui._tray_available = True
        ui._tray_hint_shown = True
        win.show()
        app.processEvents()
        assert win.windowFlags() & QtCore.Qt.FramelessWindowHint
        controls = win._agent_window_controls
        assert controls.isVisible()
        assert controls.minimize_button.accessibleName() == "Minimize window"
        assert controls.close_button.accessibleName() == "Close window"
        controls.minimize_button.click()
        app.processEvents()
        assert win.isMinimized()
        win.showNormal()
        controls.maximize_button.click()
        app.processEvents()
        assert win.isMaximized()
        assert controls.maximize_button.accessibleName() == "Restore window"
        controls.maximize_button.click()
        app.processEvents()
        assert not win.isMaximized()
        win._go_to_page("companion")
        app.processEvents()
        assert win._companion_window_controls.isVisible()
        win._companion_window_controls.close_button.click()
        app.processEvents()
        assert not win.isVisible()
        assert not win._really_quit
        win.show()
        win._set_window_size("Compact")
        app.processEvents()
        assert win.size() == QtCore.QSize(420, 44)
        card = win._companion_page.compact_card
        menu = win._companion_page._build_team_context_menu(card)
        actions = {action.text(): action for action in menu.actions()}
        actions["Minimize"].trigger()
        app.processEvents()
        assert win.isMinimized()
        win.showNormal()
        actions["Close"].trigger()
        app.processEvents()
        assert not win.isVisible()
        win._companion_page.shutdown()
    ''')


def test_standard_agent_pages_keep_navigation_drafts_and_window_controls_at_small_size(tmp_path):
    run_gui_check(tmp_path, '''
        from sc2tools_agent.ui import theme
        font = Path("C:/Windows/Fonts/segoeui.ttf")
        if font.is_file():
            QtGui.QFontDatabase.addApplicationFont(str(font))
        app.setStyleSheet(theme.STYLE)
        ui, win = make_window(window_page="companion")
        win.show()
        win._set_window_size("Standard")
        app.processEvents()
        win._handle_input.setText("Draft remains")
        for page in ("dashboard", "recent", "log", "settings", "streams", "companion"):
            win._go_to_page(page)
            app.processEvents()
            assert win.size() == QtCore.QSize(520, 480), (page, win.size())
            assert not win._sidebar.isVisible()
            controls = win._companion_window_controls if page == "companion" else win._agent_window_controls
            for button in (controls.minimize_button, controls.maximize_button, controls.close_button):
                position = button.mapTo(win, QtCore.QPoint(0, 0))
                assert win.rect().contains(QtCore.QRect(position, button.size())), (page, position)
            if page != "companion":
                assert win._agent_menu_button.isVisible()
                actions = {action.text() for action in win._agent_menu_button.menu().actions()}
                assert {"Help & support", "Check for updates", "Quit SC2 Tools"} <= actions
            assert win._handle_input.text() == "Draft remains"
        assert not saved
        win._companion_page.shutdown()
        win.hide()
    ''')
