from tests._gui_offscreen import run_gui_check


def test_assistance_modes_fit_main_window_and_preserve_state_during_resize(tmp_path):
    run_gui_check(tmp_path, '''
        import os
        from copy import deepcopy
        from sc2tools_agent.companion_modes import FEATURES, default_modes
        from sc2tools_agent.ui import theme

        fonts = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
        for filename in ("segoeui.ttf", "segoeuib.ttf", "seguisb.ttf"):
            font_path = fonts / filename
            if font_path.is_file():
                QtGui.QFontDatabase.addApplicationFont(str(font_path))
        app.setFont(QtGui.QFont("Segoe UI", 10))
        app.setStyleSheet(theme.STYLE)
        ui, window = make_window(window_page="companion", window_animations=False)
        page = window._companion_page
        controls = page.mode_controls
        state = default_modes()
        state["active"] = "practice"
        state["hotkeyEnabled"] = True
        state["profiles"]["practice"]["ghost"] = False
        controls.set_state(state)
        expected = deepcopy(controls._state)
        events = []
        controls.changed.connect(events.append)
        page.console.navigate("settings")
        window.show()
        try:
            for preset in ("Detailed", "Compact", "Standard"):
                window._set_window_size(preset)
                QtTest.QTest.qWait(10)
            for width, height in ((520, 480), (480, 360), (520, 480)):
                window.resize(width, height)
                for expanded in (False, True):
                    controls.customize_button.setChecked(expanded)
                    QtTest.QTest.qWait(20)
                    assert (window.width(), window.height()) == (width, height)
                    assert page.current_density() == "standard"
                    assert controls._state == expected
                    assert controls.mode_select.currentData() == "practice"
                    assert controls.hotkey_check.isChecked()
                    assert not events
                    assert page.controls_page.horizontalScrollBar().maximum() == 0
                    widgets = [controls.mode_select, controls.hotkey_check, controls.customize_button]
                    if expanded:
                        widgets.extend(controls.feature_checks.values())
                    for widget in widgets:
                        assert widget.isVisible()
                        assert widget.width() >= widget.minimumSizeHint().width()
                        page.controls_page.ensureWidgetVisible(widget)
                        QtTest.QTest.qWait(5)
                        viewport = page.controls_page.viewport()
                        assert viewport.rect().contains(widget.mapTo(viewport, widget.rect().topLeft()))
                        assert viewport.rect().contains(widget.mapTo(viewport, widget.rect().bottomRight()))
                    for label in controls.findChildren(QtWidgets.QLabel):
                        if label.isVisible() and label.wordWrap() and label.text():
                            assert label.height() >= label.heightForWidth(label.width())
                    assert {key: checkbox.text() for key, checkbox in controls.feature_checks.items()} == dict(FEATURES)
            assert controls._state == expected and not events
        finally:
            page.shutdown()
            window._really_quit = True
            window.close()
            app.processEvents()
    ''')
