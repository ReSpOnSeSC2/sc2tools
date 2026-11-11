"""Offscreen Qt checks. This test creates a widget, never runs the agent."""
import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
pytest.importorskip("PySide6")
from PySide6 import QtCore, QtGui, QtTest, QtWidgets

from sc2tools_agent.ui.page_shortcuts import install_page_shortcuts


def test_page_shortcuts_and_sidebar_focus():
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    window = QtWidgets.QWidget()
    layout = QtWidgets.QVBoxLayout(window)
    buttons = [QtWidgets.QPushButton(name, window) for name in ("Companion", "Dashboard", "Recent games")]
    for button in buttons:
        layout.addWidget(button)
    events = []
    bindings = install_page_shortcuts(
        window, QtCore=QtCore, QtGui=QtGui, go_to=events.append,
        refresh=lambda: events.append("refresh"), save=lambda: events.append("save"), nav_buttons=buttons,
    )
    window.show()
    window.activateWindow()
    app.processEvents()
    try:
        assert len(bindings) == 15
        buttons[0].setFocus()
        QtTest.QTest.keyClick(buttons[0], QtCore.Qt.Key_Down)
        assert buttons[1].hasFocus()
        buttons[1].setEnabled(False)
        buttons[0].setFocus()
        QtTest.QTest.keyClick(buttons[0], QtCore.Qt.Key_Down)
        assert buttons[2].hasFocus()
        QtTest.QTest.keyClick(buttons[2], QtCore.Qt.Key_Up)
        assert buttons[0].hasFocus()
        QtTest.QTest.keyClick(buttons[0], QtCore.Qt.Key_2, QtCore.Qt.ControlModifier)
        QtTest.QTest.keyClick(buttons[0], QtCore.Qt.Key_Comma, QtCore.Qt.ControlModifier)
        QtTest.QTest.keyClick(buttons[0], QtCore.Qt.Key_S, QtCore.Qt.ControlModifier)
        QtTest.QTest.keyClick(buttons[0], QtCore.Qt.Key_F5)
        assert events == ["dashboard", "settings", "save", "refresh"]
    finally:
        window.close()
