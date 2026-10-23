"""Exercise real Qt port editing and wheel events without desktop windows."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import textwrap

import pytest


def test_obs_port_ignores_wheel_and_preserves_explicit_edits(tmp_path: Path) -> None:
    if importlib.util.find_spec("PySide6") is None:
        pytest.skip("Qt is not installed in this test environment")

    # Own QApplication in a subprocess, isolated from import-fallback tests
    # that deliberately remove PySide6 from sys.modules.
    script = textwrap.dedent("""
        import sys
        from pathlib import Path
        from PySide6 import QtCore, QtGui, QtTest, QtWidgets
        from sc2tools_agent import __version__
        from sc2tools_agent.ui.gui import GuiUI, SettingsPayload, _GuiSignals, _MainWindow

        app = QtWidgets.QApplication([])
        def wait_saved(win):
            deadline = QtCore.QDeadlineTimer(5000)
            while win._settings_save_pending and not deadline.hasExpired():
                QtTest.QTest.qWait(10)
            assert not win._settings_save_pending
        base = Path(sys.argv[1])
        saved = []
        ui = GuiUI(
            version=__version__, dashboard_url="https://example.test/app",
            pairing_url="https://example.test/devices", log_dir=base,
            log_file=base / "agent.log", api_base="https://api.example.test",
            replay_folders=[], initial_paused=False, initial_paired=True,
            initial_user_id="u1", initial_settings=SettingsPayload(obs_port=4455),
            on_pause=lambda value: None, on_resync=lambda: None,
            on_choose_folder=lambda path: None, on_check_updates=lambda: None,
            on_save_settings=saved.append, on_quit=lambda: None,
        )
        ui._signals = _GuiSignals()
        win = _MainWindow(ui=ui, signals=ui._signals, QtCore=QtCore,
                          QtGui=QtGui, QtWidgets=QtWidgets)
        win._stack.setCurrentIndex(3)
        win.show()
        app.processEvents()
        port = win._obs_port_input
        settings = win._stack.currentWidget()
        scrollbar = settings.verticalScrollBar()
        assert scrollbar.maximum() > 0
        assert port.value() == 4455
        assert any("Default: 4455" in label.text()
                   for label in settings.findChildren(QtWidgets.QLabel))

        def wheel(target, angle, pixel=0):
            # Send through the window so Qt performs its real hit testing
            # and propagation from the ignored field to the scroll area.
            settings.ensureWidgetVisible(target)
            app.processEvents()
            position = target.mapTo(win, target.rect().center())
            QtTest.QTest.wheelEvent(
                win.windowHandle(), position, QtCore.QPoint(0, angle),
                QtCore.QPoint(0, pixel),
            )
            app.processEvents()

        for focused in (False, True):
            if focused:
                port.setFocus()
            else:
                win._obs_host_input.setFocus()
            app.processEvents()
            assert port.hasFocus() is focused
            for target in (port, port.lineEdit()):
                for angle, pixel in ((-120, 0), (120, 0), (0, -45)):
                    scrollbar.setValue(scrollbar.maximum() // 2)
                    wheel(target, angle, pixel)
                    assert port.value() == 4455, (focused, angle, pixel)

        # An ignored wheel continues scrolling the settings page, including
        # after a deliberate click gave the port keyboard focus.
        port.setFocus()
        scrollbar.setValue(scrollbar.maximum() // 2)
        settings.ensureWidgetVisible(port)
        app.processEvents()
        before = scrollbar.value()
        angle = 120 if before >= scrollbar.maximum() else -120
        wheel(port, angle)
        assert scrollbar.value() != before
        assert (scrollbar.value() < before) is (angle > 0)

        port.setFocus()
        port.selectAll()
        QtTest.QTest.keyClicks(port, "4460")
        QtTest.QTest.keyClick(port, QtCore.Qt.Key_Return)
        assert port.value() == 4460
        QtTest.QTest.keyClick(port, QtCore.Qt.Key_Up)
        assert port.value() == 4461
        QtTest.QTest.keyClick(port, QtCore.Qt.Key_Down)
        assert port.value() == 4460
        assert port.minimum() == 1 and port.maximum() == 65535
        win._click_save_settings()
        wait_saved(win)
        assert saved[-1].obs_port == 4460

        win._log_timer.stop()
        win.deleteLater()
        app.processEvents()
        print("OBS port controls passed")
    """)
    environment = dict(os.environ)
    environment["QT_QPA_PLATFORM"] = "offscreen"
    agent_dir = str(Path(__file__).resolve().parents[1])
    environment["PYTHONPATH"] = os.pathsep.join(
        value for value in (agent_dir, environment.get("PYTHONPATH")) if value
    )
    result = subprocess.run(
        [sys.executable, "-c", script, str(tmp_path)],
        capture_output=True, text=True, timeout=30, env=environment,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "OBS port controls passed" in result.stdout
