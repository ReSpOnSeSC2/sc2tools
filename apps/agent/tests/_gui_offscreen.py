"""Isolate QApplication from tests that intentionally unload PySide6."""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import textwrap

import pytest


def run_gui_check(tmp_path, body, *, timeout=30):
    if importlib.util.find_spec("PySide6") is None:
        pytest.skip("Qt is not installed")
    setup = '''
import sys
from pathlib import Path
from PySide6 import QtCore, QtGui, QtTest, QtWidgets
from sc2tools_agent.ui import gui
from sc2tools_agent.ui.gui import GuiUI, SettingsPayload, _GuiSignals, _MainWindow
app = QtWidgets.QApplication([])
base = Path(sys.argv[1])
saved = []
window_states = []
def make_window(**overrides):
    args = dict(
        version="test", dashboard_url="https://example.test/app",
        pairing_url="https://example.test/devices", log_dir=base,
        log_file=base / "agent.log", api_base="https://api.example.test",
        replay_folders=[], initial_paused=False, initial_paired=True,
        initial_user_id="u1", initial_settings=SettingsPayload(),
        on_pause=lambda value: None, on_resync=lambda: None,
        on_choose_folder=lambda path: None, on_check_updates=lambda: None,
        on_save_settings=saved.append, on_quit=lambda: None,
        on_window_state=lambda geometry, page: window_states.append((geometry, page)),
    )
    args.update(overrides)
    ui = GuiUI(**args)
    ui._signals = _GuiSignals()
    win = _MainWindow(ui=ui, signals=ui._signals, QtCore=QtCore,
                      QtGui=QtGui, QtWidgets=QtWidgets)
    win._log_timer.stop()
    return ui, win
'''
    environment = dict(os.environ, QT_QPA_PLATFORM="offscreen")
    environment["PYTHONPATH"] = os.pathsep.join(
        part for part in (str(Path(__file__).resolve().parents[1]), environment.get("PYTHONPATH")) if part
    )
    result = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(setup) + "\n" + textwrap.dedent(body), str(tmp_path)],
        capture_output=True, text=True, timeout=timeout, env=environment,
    )
    assert result.returncode == 0, result.stdout + result.stderr
