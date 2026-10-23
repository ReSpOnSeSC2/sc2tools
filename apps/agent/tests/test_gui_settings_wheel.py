from tests._gui_offscreen import run_gui_check


def test_value_controls_scroll_the_page_until_deliberately_focused(tmp_path):
    run_gui_check(tmp_path, '''
        ui, win = make_window()
        win._go_to_page("settings")
        win.show()
        win._obs_enable_check.setChecked(True)
        win._filter_combo.setCurrentIndex(win._filter_combo.findData("custom"))
        win._log_combo.setCurrentIndex(1)
        # Exercise a slider endpoint even on a small CI host. Parser workers
        # now derive from the Performance profile and are read-only.
        win._upload_batch_slider.setValue(win._upload_batch_slider.maximum())
        app.processEvents()
        settings = win._stack.currentWidget()
        scrollbar = settings.verticalScrollBar()
        controls = [win._log_combo, win._filter_since, win._filter_until,
                    win._speed_combo, win._upload_batch_slider,
                    win._obs_debounce_spin, *win._obs_scene_combos.values(), win._filter_combo]
        for combo in win._obs_scene_combos.values():
            combo.addItems(["Wheel A", "Wheel B", "Wheel C"])
            combo.setCurrentIndex(1)

        def value(control):
            if isinstance(control, QtWidgets.QComboBox): return control.currentIndex()
            if isinstance(control, QtWidgets.QDateEdit): return control.date().toJulianDay()
            return control.value()

        def wheel(control, angle):
            point = control.mapTo(win, control.rect().center())
            QtTest.QTest.wheelEvent(win.windowHandle(), point, QtCore.QPoint(0, angle))
            app.processEvents()

        scrolled = False
        for control in controls:
            assert getattr(control, "_sc2_wheel_guard", None) is not None
            settings.ensureWidgetVisible(control)
            win._api_input.setFocus()
            app.processEvents()
            assert not control.hasFocus()
            old_value = value(control)
            before = scrollbar.value()
            angle = 120 if before > scrollbar.maximum() // 2 else -120
            wheel(control, angle)
            assert value(control) == old_value, (type(control).__name__, old_value, value(control))
            scrolled |= scrollbar.value() != before
            settings.ensureWidgetVisible(control)
            control.setFocus()
            app.processEvents()
            assert control.hasFocus()
            old_value = value(control)
            # A slider at its ceiling cannot move farther upward. Wheel toward the available range so the assertion
            # tests focused input, rather than clamping at that endpoint.
            angle = -120 if isinstance(control, QtWidgets.QAbstractSlider) and old_value == control.maximum() else 120
            wheel(control, angle)
            assert value(control) != old_value, (type(control).__name__, old_value)
        assert scrolled
    ''')
