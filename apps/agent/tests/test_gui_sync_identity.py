"""Offscreen native Settings intent; no agent or StarCraft process launches."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import textwrap

import pytest


def test_player_handle_save_requires_an_actual_edit_and_captures_form_owner_epoch(tmp_path: Path):
    if importlib.util.find_spec("PySide6") is None:
        pytest.skip("Qt is not installed")
    script = textwrap.dedent('''
        import sys, time
        from pathlib import Path
        from PySide6 import QtCore, QtGui, QtWidgets
        from sc2tools_agent.ui.gui import GuiUI, SettingsPayload, _GuiSignals, _MainWindow
        app = QtWidgets.QApplication([])
        base = Path(sys.argv[1]); saved = []
        origin = ["a", object()]
        ui = GuiUI(version="0.24.8", dashboard_url="https://example.test/app",
            pairing_url="https://example.test/devices", log_dir=base, log_file=base/"agent.log",
            api_base="https://api.example.test", replay_folders=[], initial_paused=False,
            initial_paired=True, initial_user_id="a", initial_settings=SettingsPayload(player_handle="Legacy stale A"),
            on_pause=lambda _:None, on_resync=lambda:None, on_choose_folder=lambda _:None,
            on_check_updates=lambda:None, on_save_settings=saved.append, on_quit=lambda:None,
            settings_identity_provider=lambda:tuple(origin))
        ui._signals = _GuiSignals()
        window = _MainWindow(ui=ui, signals=ui._signals, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
        def save():
            before = len(saved); window._click_save_settings()
            deadline = time.monotonic()+3
            while (len(saved)==before or window._settings_save_pending) and time.monotonic()<deadline:
                app.processEvents(); time.sleep(0.005)
            assert len(saved)==before+1 and not window._settings_save_pending
            return saved[-1]
        assert not window._handle_input.isModified()
        assert save().player_handle is None  # unrelated Save cannot attribute flat cache
        window._handle_input.setText("Current")
        window._handle_input.setModified(True)
        window._handle_input.textEdited.emit("Current")
        edited = save()
        assert edited.player_handle == "Current" and edited.player_handle_origin == tuple(origin)
        assert not window._handle_input.isModified() and save().player_handle is None
        old = edited.player_handle_origin
        origin[:] = ["b", object()]
        window._on_unlinked(); window._on_paired("b")
        assert window._handle_input.text()=="" and not window._handle_input.isModified()
        assert old != tuple(origin) and save().player_handle is None
        window._handle_input.setText("B current")
        window._handle_input.setModified(True); window._handle_input.textEdited.emit("B current")
        assert save().player_handle_origin == tuple(origin)
        window._handle_input.clear(); window._handle_input.setModified(True)
        window._handle_input.textEdited.emit("")
        assert save().player_handle == ""  # explicit CLEAR survives KEEP protocol
        window.deleteLater(); app.processEvents()
    ''')
    env = {**os.environ, "QT_QPA_PLATFORM": "offscreen"}
    result = subprocess.run([sys.executable, "-c", script, str(tmp_path)], capture_output=True, text=True, timeout=45, env=env)
    assert result.returncode == 0, result.stdout + result.stderr
