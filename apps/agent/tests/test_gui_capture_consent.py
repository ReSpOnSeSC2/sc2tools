"""Exercise the real Qt opt-in controls without opening desktop windows."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import textwrap

import pytest


def test_capture_checkbox_requires_consent_and_applies_immediately(tmp_path: Path) -> None:
    if importlib.util.find_spec("PySide6") is None:
        pytest.skip("Qt is not installed in this test environment")

    # Keep QApplication lifetime isolated from the import-fallback tests, which
    # deliberately remove PySide6 from sys.modules. Offscreen never opens a
    # window or asks the developer to answer the warning dialog.
    script = textwrap.dedent("""
        import sys
        import threading
        from pathlib import Path
        from PySide6 import QtCore, QtGui, QtWidgets
        from sc2tools_agent.ui.gui import GuiUI, SettingsPayload, _GuiSignals, _MainWindow

        app = QtWidgets.QApplication([])
        base = Path(sys.argv[1])
        saved = []
        prompts = []
        answer = QtWidgets.QMessageBox.No
        fail_save = False

        def save(payload):
            if fail_save:
                raise OSError("disk full")
            saved.append(payload)

        def warn(*args):
            prompts.append(args)
            return answer

        QtWidgets.QMessageBox.warning = warn

        def window(initial):
            ui = GuiUI(
                version="0.16.9", dashboard_url="https://example.test/app",
                pairing_url="https://example.test/devices", log_dir=base,
                log_file=base / "agent.log", api_base="https://api.example.test",
                replay_folders=[], initial_paused=False, initial_paired=True,
                initial_user_id="u1", initial_settings=initial,
                on_pause=lambda value: None, on_resync=lambda: None,
                on_choose_folder=lambda path: None, on_check_updates=lambda: None,
                on_save_settings=save, on_quit=lambda: None,
            )
            ui._signals = _GuiSignals()
            result = _MainWindow(ui=ui, signals=ui._signals, QtCore=QtCore,
                                 QtGui=QtGui, QtWidgets=QtWidgets)
            result.capture_test_ui = ui
            return result

        fresh = window(SettingsPayload())
        assert not fresh._replay_capture_check.isChecked()
        assert fresh._replay_capture_notice.isHidden()
        assert saved == [] and prompts == []

        fresh._replay_capture_check.setChecked(True)
        assert len(prompts) == 1
        assert prompts[0][-1] == QtWidgets.QMessageBox.No
        assert "CPU" in prompts[0][2] and "several minutes" in prompts[0][2]
        assert not fresh._replay_capture_check.isChecked()
        assert saved == []

        answer = QtWidgets.QMessageBox.Yes
        fresh._replay_capture_check.setChecked(True)
        assert saved[-1].replay_capture_enabled is True
        assert saved[-1].obs_scene_switch_enabled is None
        assert not fresh._replay_capture_notice.isHidden()
        assert "capture on" in fresh._settings_status.text()

        # Turning off does not ask for another confirmation or need Save.
        prompt_count = len(prompts)
        fresh._replay_capture_check.setChecked(False)
        assert saved[-1].replay_capture_enabled is False
        assert len(prompts) == prompt_count
        assert fresh._replay_capture_notice.isHidden()

        fail_save = True
        fresh._replay_capture_check.setChecked(True)
        assert not fresh._replay_capture_check.isChecked()
        assert fresh._replay_capture_last_saved is False
        assert "Could not save" in fresh._settings_status.text()
        assert fresh._replay_capture_notice.isHidden()
        fail_save = False

        # A saved opt-in is displayed after restart without prompting again.
        counts = (len(prompts), len(saved))
        existing = window(SettingsPayload(replay_capture_enabled=True))
        assert existing._replay_capture_check.isChecked()
        assert not existing._replay_capture_notice.isHidden()
        assert (len(prompts), len(saved)) == counts
        worker = threading.Thread(target=lambda: existing.capture_test_ui.show_update_notice(
            "Accurate replay capture is starting; CPU use may increase.", sticky=False,
        ))
        worker.start()
        worker.join(timeout=2)
        assert not worker.is_alive()
        app.processEvents()
        assert "CPU use may increase" in existing._update_notice.text()
        fresh._log_timer.stop()
        existing._log_timer.stop()
        fresh.deleteLater()
        existing.deleteLater()
        app.processEvents()
        print("consent controls passed")
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
    assert "consent controls passed" in result.stdout
