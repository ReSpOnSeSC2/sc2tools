"""The mouse wheel scrolls every agent page and never edits a control by accident."""

from tests._gui_offscreen import run_gui_check


def test_every_page_scrolls_with_the_wheel_and_unfocused_controls_pass_it_on(tmp_path):
    run_gui_check(tmp_path, '''
        from sc2tools_agent.ui.qt_helpers import install_wheel_router
        ui, win = make_window()
        router = getattr(app, "_sc2_wheel_router", None)
        assert router is not None, "the main window installs the wheel router"
        assert install_wheel_router(app, QtCore, QtWidgets) is router, "installing twice reuses one filter"
        win.resize(480, 360)
        win.show()
        app.processEvents()

        value_types = (QtWidgets.QComboBox, QtWidgets.QAbstractSpinBox, QtWidgets.QAbstractSlider, QtWidgets.QTabBar)

        def value(control):
            if isinstance(control, QtWidgets.QComboBox): return control.currentIndex()
            if isinstance(control, QtWidgets.QTabBar): return control.currentIndex()
            if isinstance(control, QtWidgets.QDateTimeEdit): return control.dateTime().toSecsSinceEpoch()
            return control.value()

        def wheel_at(widget, angle):
            point = widget.mapTo(win, widget.rect().center())
            QtTest.QTest.wheelEvent(win.windowHandle(), point, QtCore.QPoint(0, angle))
            app.processEvents()

        def scroll_area_of(widget):
            parent = widget.parentWidget()
            while parent is not None:
                if isinstance(parent, QtWidgets.QScrollArea):
                    return parent
                parent = parent.parentWidget()
            return None

        pages_scrolled = []
        controls_checked = 0
        for key in win._PAGE_KEYS:
            win._go_to_page(key)
            app.processEvents()
            page = win._stack.currentWidget()
            # A focused text field elsewhere, so no value control holds focus.
            win.setFocus()
            app.processEvents()
            for control in page.findChildren(QtWidgets.QWidget):
                if not isinstance(control, value_types) or isinstance(control, QtWidgets.QScrollBar):
                    continue
                if not control.isVisibleTo(win) or not control.isEnabled():
                    continue
                if not isinstance(control, QtWidgets.QTabBar):
                    policy = control.focusPolicy()
                    assert (policy & QtCore.Qt.WheelFocus) != QtCore.Qt.WheelFocus, (key, type(control).__name__)
                area = scroll_area_of(control)
                if area is not None:
                    area.ensureWidgetVisible(control)
                    app.processEvents()
                if control.hasFocus() or not control.visibleRegion().boundingRect().contains(control.rect().center()):
                    continue
                before = value(control)
                wheel_at(control, -120)
                assert value(control) == before, (key, type(control).__name__, control.objectName(), before, value(control))
                assert not control.hasFocus(), (key, type(control).__name__, "the wheel must not take focus")
                controls_checked += 1
            # Every page area that can scroll does scroll under the wheel.
            for area in page.findChildren(QtWidgets.QAbstractScrollArea) + ([page] if isinstance(page, QtWidgets.QAbstractScrollArea) else []):
                if not area.isVisibleTo(win) or area.viewport().width() < 40 or area.viewport().height() < 40:
                    continue
                bar = area.verticalScrollBar()
                if bar.maximum() <= 0:
                    continue
                bar.setValue(0)
                app.processEvents()
                wheel_at(area.viewport(), -120)
                if bar.value() > 0:
                    pages_scrolled.append(key)
                    break
        assert controls_checked >= 5, controls_checked
        # At 480 x 360 the long pages must scroll with the wheel.
        for key in ("dashboard", "settings", "help"):
            assert key in pages_scrolled, (key, pages_scrolled)
    ''', timeout=120)
