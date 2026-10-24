from tests._gui_offscreen import run_gui_check


def test_all_agent_pages_share_console_bezel_and_keep_existing_page_ownership(tmp_path):
    run_gui_check(tmp_path, '''
        app.setStyleSheet(gui._STYLE)
        ui, win = make_window(window_page="dashboard")
        win.show()
        win.resize(1100, 800)
        app.processEvents()
        pages = [win._stack.widget(index) for index in range(win._stack.count())]
        parents = [page.parentWidget() for page in pages]
        geometry = win.geometry()
        assert len(pages) == 6
        assert win._agent_frame.objectName() == "agentFrame"
        assert win._agent_display.objectName() == "agentDisplay"
        assert win._sidebar.objectName() == "agentSidebar"
        assert win._sidebar.width() == 240
        for key, label in [("dashboard", "Dashboard"), ("recent", "Recent games"),
                           ("log", "Activity log"), ("settings", "Settings"), ("streams", "Streams")]:
            win._go_to_page(key)
            app.processEvents()
            assert win._PAGE_KEYS[win._stack.currentIndex()] == key
            assert win._agent_frame.property("companion") is False
            assert win._agent_display.property("companion") is False
            assert win._agent_brandbar.isVisible()
            assert win._agent_toolbar.isVisible()
            assert win._sidebar.isVisible()
            assert label.casefold() in win._agent_section_label.text().casefold()
            assert win._agent_display.isAncestorOf(win._stack.currentWidget())
            assert win._agent_frame.isAncestorOf(win._agent_display)
            margins = win._agent_frame.layout().contentsMargins()
            assert (margins.left(), margins.top(), margins.right(), margins.bottom()) == (14, 12, 14, 14)
            margins = win.centralWidget().layout().contentsMargins()
            assert (margins.left(), margins.top(), margins.right(), margins.bottom()) == (10, 10, 10, 10)
            bezel = win._agent_frame.grab().toImage().pixelColor(win._agent_frame.width() // 2, 5)
            assert bezel.red() > bezel.green() and bezel.blue() > bezel.green(), bezel.name()
            display = win._agent_display.grab().toImage().pixelColor(4, win._agent_display.height() // 2)
            assert max(display.red(), display.green(), display.blue()) < 110, display.name()
            assert win.geometry() == geometry
        win._go_to_page("companion")
        app.processEvents()
        assert win._stack.currentWidget() is win._companion_page
        assert win._agent_frame.property("companion") is True
        assert win._agent_display.property("companion") is True
        assert not win._agent_brandbar.isVisible()
        assert not win._agent_toolbar.isVisible()
        assert not win._sidebar.isVisible()
        for layout in [win.centralWidget().layout(), win._agent_frame.layout()]:
            margins = layout.contentsMargins()
            assert (margins.left(), margins.top(), margins.right(), margins.bottom()) == (0, 0, 0, 0)
        assert win.geometry() == geometry
        assert [win._stack.widget(index) for index in range(6)] == pages
        assert [page.parentWidget() for page in pages] == parents
        win._companion_page.shutdown()
        win.hide()
    ''')


def test_agent_menu_and_companion_button_keep_geometry_density_and_unsaved_settings(tmp_path):
    run_gui_check(tmp_path, '''
        app.setStyleSheet(gui._STYLE)
        layouts = []
        ui, win = make_window(window_page="settings", on_window_information_layout=layouts.append)
        win.show()
        win.resize(1100, 800)
        app.processEvents()
        page = win._companion_page
        density = page.current_density()
        win._api_input.setText("https://draft.example.test")
        win._handle_input.setText("Unsaved player handle")
        geometry = win.geometry()
        menu = {action.text(): action for action in win._agent_menu_button.menu().actions() if not action.isSeparator()}
        assert "Companion" in menu
        for title, key in [("Dashboard", "dashboard"), ("Recent games", "recent"),
                           ("Streams", "streams"), ("Settings", "settings")]:
            menu[title].trigger()
            app.processEvents()
            assert win._PAGE_KEYS[win._stack.currentIndex()] == key
            assert win._api_input.text() == "https://draft.example.test"
            assert win._handle_input.text() == "Unsaved player handle"
            assert win.geometry() == geometry
            assert page.current_density() == density
        log_title = "Logs" if "Logs" in menu else "Activity log"
        menu[log_title].trigger()
        app.processEvents()
        assert win._PAGE_KEYS[win._stack.currentIndex()] == "log"
        win._agent_companion_button.click()
        app.processEvents()
        assert win._stack.currentWidget() is page
        assert page.console.isVisible()
        assert not win._sidebar.isVisible()
        agent_actions = {action.text(): action for action in page.agent_menu_button.menu().actions()}
        agent_actions["Settings"].trigger()
        app.processEvents()
        assert win._PAGE_KEYS[win._stack.currentIndex()] == "settings"
        assert win._stack.currentWidget().isAncestorOf(win._settings_page)
        assert win._sidebar.isVisible()
        menu["Companion"].trigger()
        app.processEvents()
        assert win._stack.currentWidget() is page
        assert win.geometry() == geometry
        assert page.current_density() == density
        assert win._api_input.text() == "https://draft.example.test"
        assert win._handle_input.text() == "Unsaved player handle"
        assert layouts == []
        assert saved == []
        assert page.scouting_speech.available() is None
        page.shutdown()
        win.hide()
    ''')


def test_compact_hides_both_agent_chrome_surfaces_and_expand_restores_same_settings_draft(tmp_path):
    run_gui_check(tmp_path, '''
        app.setStyleSheet(gui._STYLE)
        ui, win = make_window(window_page="settings")
        win.show()
        app.processEvents()
        win._handle_input.setText("Draft kept through Compact")
        page = win._companion_page
        win._agent_companion_button.click()
        assert win._set_window_size("Compact")
        app.processEvents()
        assert (win.width(), win.height()) == (420, 44)
        assert page.compact_card.isVisible()
        assert not page.console.isVisible()
        assert not win._sidebar.isVisible()
        assert not win._agent_brandbar.isVisible()
        assert not win._agent_toolbar.isVisible()
        assert win._agent_frame.property("companion") is True
        page.compact_enlarge.click()
        app.processEvents()
        assert page.current_density() == "standard"
        assert page.console.isVisible()
        assert not win._agent_brandbar.isVisible()
        actions = {action.text(): action for action in page.agent_menu_button.menu().actions()}
        actions["Settings"].trigger()
        app.processEvents()
        assert win._agent_brandbar.isVisible()
        assert win._agent_toolbar.isVisible()
        assert not win._sidebar.isVisible()
        assert win._agent_menu_button.isVisible()
        assert win._sidebar.width() == 240
        assert win._handle_input.text() == "Draft kept through Compact"
        assert not saved
        page.shutdown()
        win.hide()
    ''')


def test_settings_form_wraps_without_horizontal_clipping_at_minimum_size_and_keeps_drafts(tmp_path):
    run_gui_check(tmp_path, '''
        from sc2tools_agent.ui import theme
        font = Path("C:/Windows/Fonts/segoeui.ttf")
        if font.is_file():
            QtGui.QFontDatabase.addApplicationFont(str(font))
            app.setFont(QtGui.QFont("Segoe UI", 10))
        app.setStyleSheet(theme.STYLE)
        ui, win = make_window(window_page="settings")
        win.show()
        win.resize(1200, 900)
        app.processEvents()
        win._api_input.setText("https://unsaved.example.test")
        win._handle_input.setText("Narrow settings draft")
        win.resize(820, 540)
        app.processEvents()
        assert (win.width(), win.height()) == (820, 540)
        scroller = win._stack.widget(3)
        body = win._settings_page
        assert isinstance(scroller, QtWidgets.QScrollArea)
        assert scroller.widget() is body
        assert body.width() <= scroller.viewport().width(), (body.size(), scroller.viewport().size(), body.minimumSizeHint())
        assert scroller.horizontalScrollBar().maximum() == 0
        forms = [form for form in body.findChildren(QtWidgets.QFormLayout)
                 if form.parentWidget().isAncestorOf(win._api_input)]
        assert len(forms) == 1
        assert forms[0].rowWrapPolicy() == QtWidgets.QFormLayout.WrapLongRows
        assert scroller.verticalScrollBar().maximum() > 0
        control_types = (QtWidgets.QAbstractButton, QtWidgets.QLineEdit, QtWidgets.QComboBox,
                         QtWidgets.QAbstractSpinBox, QtWidgets.QSlider)
        controls = [widget for widget in body.findChildren(QtWidgets.QWidget)
                    if isinstance(widget, control_types) and widget.isVisibleTo(body)
                    and widget.width() > 0 and widget.height() > 0]
        assert win._api_input in controls and win._handle_input in controls
        assert win._save_settings_btn in controls
        for control in controls:
            scroller.ensureWidgetVisible(control, 0, 0)
            scroller.verticalScrollBar().setValue(control.mapTo(body, QtCore.QPoint(0, 0)).y())
            app.processEvents()
            position = control.mapTo(scroller.viewport(), QtCore.QPoint(0, 0))
            visible = QtCore.QRect(position, control.size())
            assert scroller.viewport().rect().contains(visible), (control.objectName(), control.metaObject().className(), visible, scroller.viewport().rect())
        win._agent_companion_button.click()
        app.processEvents()
        actions = {action.text(): action for action in win._companion_page.agent_menu_button.menu().actions()}
        actions["Settings"].trigger()
        app.processEvents()
        assert win._stack.currentWidget() is scroller
        assert (win.width(), win.height()) == (820, 540)
        assert body.width() <= scroller.viewport().width()
        assert win._api_input.text() == "https://unsaved.example.test"
        assert win._handle_input.text() == "Narrow settings draft"
        assert not saved
        win._companion_page.shutdown()
        win.hide()
    ''')
