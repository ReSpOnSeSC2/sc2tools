from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys

from tests._gui_offscreen import run_gui_check


def test_window_chrome_module_keeps_qt_import_lazy():
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(Path(__file__).resolve().parents[1])
    result = subprocess.run([
        sys.executable, "-c",
        "import sys; import sc2tools_agent.ui.window_chrome; "
        "assert not any(name == 'PySide6' or name.startswith('PySide6.') for name in sys.modules)",
    ], capture_output=True, text=True, env=environment, timeout=15)
    assert result.returncode == 0, result.stdout + result.stderr


def test_themed_controls_use_real_window_states_and_respect_close_event(tmp_path):
    run_gui_check(tmp_path, '''
        from sc2tools_agent.ui.window_chrome import build_window_controls
        from sc2tools_agent.ui import theme
        app.setStyleSheet(theme.STYLE)
        class ProtectedWindow(QtWidgets.QWidget):
            def __init__(self):
                super().__init__()
                self.close_calls = 0
                self.allow_close = False
            def closeEvent(self, event):
                self.close_calls += 1
                event.accept() if self.allow_close else event.ignore()
        window = ProtectedWindow()
        window.setWindowFlag(QtCore.Qt.FramelessWindowHint, True)
        window.resize(480, 320)
        controls = build_window_controls(window, window=window, QtCore=QtCore, QtWidgets=QtWidgets)
        window.show()
        app.processEvents()
        assert window.windowFlags() & QtCore.Qt.FramelessWindowHint
        assert controls.minimize_button.accessibleName() == "Minimize window"
        controls.minimize_button.click()
        app.processEvents()
        assert window.isMinimized()
        window.showNormal()
        controls.maximize_button.click()
        app.processEvents()
        assert window.isMaximized()
        assert controls.maximize_button.accessibleName() == "Restore window"
        controls.maximize_button.click()
        app.processEvents()
        assert not window.isMaximized()
        assert controls.maximize_button.accessibleName() == "Maximize window"
        controls.close_button.click()
        app.processEvents()
        assert window.close_calls == 1 and window.isVisible()
        window.allow_close = True
        controls.close_button.click()
        app.processEvents()
        assert window.close_calls == 2 and not window.isVisible()
    ''')


def test_native_drag_ignores_interactive_descendants_and_double_click_respects_gate(tmp_path):
    run_gui_check(tmp_path, '''
        from types import SimpleNamespace
        from sc2tools_agent.ui.window_chrome import install_window_interactions
        window = QtWidgets.QWidget()
        window.resize(600, 400)
        header = QtWidgets.QFrame(window)
        header.setGeometry(12, 12, 570, 170)
        label = QtWidgets.QLabel("Drag title", header)
        label.setGeometry(12, 10, 100, 24)
        controls = [QtWidgets.QPushButton("Button", header), QtWidgets.QLineEdit(header),
                    QtWidgets.QComboBox(header), QtWidgets.QSpinBox(header), QtWidgets.QSlider(header),
                    QtWidgets.QTreeWidget(header), QtWidgets.QPlainTextEdit(header)]
        for index, control in enumerate(controls):
            control.setGeometry(10 + index * 70, 70, 65, 50)
        window.show()
        app.processEvents()
        native_calls = []
        native = SimpleNamespace(startSystemMove=lambda: native_calls.append("move") or True,
                                 startSystemResize=lambda edges: native_calls.append(edges) or True)
        window.windowHandle = lambda: native
        allowed = [True]
        interactions = install_window_interactions(window, drag_widgets=[header], QtCore=QtCore,
                                                    QtWidgets=QtWidgets, can_maximize=lambda: allowed[0])
        def mouse(kind, button=QtCore.Qt.LeftButton):
            return QtGui.QMouseEvent(kind, QtCore.QPointF(10, 10), QtCore.QPointF(10, 10),
                                     button, button, QtCore.Qt.NoModifier)
        assert interactions._drag_target(label)
        assert interactions.eventFilter(label, mouse(QtCore.QEvent.MouseButtonPress))
        assert native_calls == ["move"]
        for control in controls:
            assert not interactions._drag_target(control)
            assert not interactions.eventFilter(control, mouse(QtCore.QEvent.MouseButtonPress))
            for child in control.findChildren(QtWidgets.QWidget):
                assert not interactions._drag_target(child)
        assert native_calls == ["move"]
        assert not interactions.eventFilter(label, mouse(QtCore.QEvent.MouseButtonPress, QtCore.Qt.RightButton))
        assert interactions.eventFilter(label, mouse(QtCore.QEvent.MouseButtonDblClick))
        app.processEvents()
        assert window.isMaximized()
        assert interactions.eventFilter(label, mouse(QtCore.QEvent.MouseButtonDblClick))
        app.processEvents()
        assert not window.isMaximized()
        allowed[0] = False
        assert interactions.eventFilter(label, mouse(QtCore.QEvent.MouseButtonDblClick))
        assert not window.isMaximized()
        other = QtWidgets.QLabel("Extra drag target", window)
        assert not interactions._drag_target(other)
        interactions.extend_drag_widgets([other, other])
        assert interactions._drag_target(other)
        unrelated = QtWidgets.QWidget()
        unrelated.show()
        assert not interactions.eventFilter(unrelated, mouse(QtCore.QEvent.MouseButtonPress))
        assert native_calls == ["move"]
        native.startSystemMove = lambda: False
        assert not interactions.eventFilter(label, mouse(QtCore.QEvent.MouseButtonPress))
        unrelated.hide()
        window.hide()
    ''')


def test_native_edge_resize_and_hover_restore_original_cursor(tmp_path):
    run_gui_check(tmp_path, '''
        from types import SimpleNamespace
        from sc2tools_agent.ui.window_chrome import install_window_interactions
        window = QtWidgets.QWidget()
        window.resize(500, 350)
        edge_control = QtWidgets.QToolButton(window)
        edge_control.setGeometry(0, 80, 40, 24)
        edge_control.setCursor(QtCore.Qt.CrossCursor)
        window.show()
        app.processEvents()
        resized = []
        native = SimpleNamespace(startSystemMove=lambda: False,
                                 startSystemResize=lambda edges: resized.append(edges) or True)
        window.windowHandle = lambda: native
        interactions = install_window_interactions(window, drag_widgets=[], QtCore=QtCore, QtWidgets=QtWidgets)
        assert interactions._edges(QtCore.QPoint(1, 1)) == QtCore.Qt.LeftEdge | QtCore.Qt.TopEdge
        assert interactions._edges(QtCore.QPoint(499, 349)) == QtCore.Qt.RightEdge | QtCore.Qt.BottomEdge
        assert not interactions._edges(QtCore.QPoint(20, 20))
        def mouse(kind, position, button=QtCore.Qt.LeftButton):
            return QtGui.QMouseEvent(kind, QtCore.QPointF(position), QtCore.QPointF(position),
                                     button, button, QtCore.Qt.NoModifier)
        assert interactions.eventFilter(window, mouse(QtCore.QEvent.MouseButtonPress, QtCore.QPoint(1, 100)))
        assert resized == [QtCore.Qt.LeftEdge]
        native.startSystemResize = lambda edges: False
        assert not interactions.eventFilter(window, mouse(QtCore.QEvent.MouseButtonPress, QtCore.QPoint(499, 100)))
        assert not interactions.eventFilter(edge_control, mouse(QtCore.QEvent.MouseMove, QtCore.QPoint(1, 5), QtCore.Qt.NoButton))
        assert edge_control.cursor().shape() == QtCore.Qt.SizeHorCursor
        interactions.eventFilter(edge_control, QtCore.QEvent(QtCore.QEvent.Leave))
        assert edge_control.cursor().shape() == QtCore.Qt.CrossCursor
        window.showMaximized()
        app.processEvents()
        assert not interactions.eventFilter(window, mouse(QtCore.QEvent.MouseButtonPress, QtCore.QPoint(1, 1)))
        assert resized == [QtCore.Qt.LeftEdge]
        window.hide()
    ''')
