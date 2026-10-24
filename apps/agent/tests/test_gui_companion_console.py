from tests._gui_offscreen import run_gui_check


def test_companion_console_owns_navigation_and_hides_agent_sidebar_at_every_density(tmp_path):
    run_gui_check(tmp_path, '''
        layouts = []
        ui, win = make_window(window_page="companion", on_window_information_layout=layouts.append)
        win.show()
        app.processEvents()
        page = win._companion_page
        assert win._stack.currentWidget() is page
        assert not win._sidebar.isVisible()
        assert page.agent_menu_button.accessibleName() == "Agent pages and settings"
        menu_actions = {action.text(): action for action in page.agent_menu_button.menu().actions()}
        for title, level in [("Compact", "compact"), ("Standard", "standard"), ("Detailed", "detailed"), ("Full workspace", "full")]:
            assert win._set_window_size(title)
            app.processEvents()
            assert page.current_density() == level
            assert win._stack.currentWidget() is page
            assert not win._sidebar.isVisible(), level
            if level == "compact":
                assert (win.width(), win.height()) == (340, 78)
                assert page.compact_card.isVisible()
                assert not page.console.isVisible()
                page.compact_card.enlarge_button.click()
                app.processEvents()
                assert page.current_density() == "standard"
                assert page.console.isVisible()
                assert not page.compact_card.isVisible()
                assert not win._sidebar.isVisible()
                assert layouts[-1] == "standard"
                continue
            assert page.console.isVisible()
            assert page.agent_menu_button.isVisible()
            for label, index in [("Settings", 3), ("Dashboard", 0)]:
                before = list(layouts)
                menu_actions[label].trigger()
                app.processEvents()
                assert win._stack.currentIndex() == index, (label, win._stack.currentIndex())
                assert win._sidebar.isVisible() == (win.width() >= 900), label
                assert win._agent_menu_button.isVisible(), label
                assert page.current_density() == level
                assert layouts == before
                win._nav_group.button(5).click()
                app.processEvents()
                assert win._stack.currentWidget() is page
                assert not win._sidebar.isVisible()
                assert page.current_density() == level
                assert layouts == before
        page.shutdown()
        win.hide()
    ''')


def test_explicit_agent_request_from_compact_expands_before_opening_settings(tmp_path):
    run_gui_check(tmp_path, '''
        layouts = []
        ui, win = make_window(window_page="companion", on_window_information_layout=layouts.append)
        win.show()
        app.processEvents()
        page = win._companion_page
        win._set_window_size("Compact")
        app.processEvents()
        assert not win._sidebar.isVisible()
        assert (win.width(), win.height()) == (340, 78)
        page.agentPageRequested.emit("settings")
        app.processEvents()
        assert win._stack.currentIndex() == 3
        assert not win._sidebar.isVisible()
        assert win._agent_menu_button.isVisible()
        assert page.current_density() == "standard"
        assert layouts == ["compact", "standard"]
        assert win.width() > 360 and win.height() > 190
        win._nav_group.button(5).click()
        app.processEvents()
        assert win._stack.currentWidget() is page
        assert not win._sidebar.isVisible()
        assert page.current_density() == "standard"
        assert layouts == ["compact", "standard"]
        page.shutdown()
        win.hide()
    ''')
