"""Exercise the Settings replay-folder list without opening desktop windows."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import textwrap

import pytest


def test_folder_list_reports_removals_and_keeps_unsaved_edits(
    tmp_path: Path,
) -> None:
    if importlib.util.find_spec("PySide6") is None:
        pytest.skip("Qt is not installed in this test environment")

    # Same isolation as the capture-consent test: a fresh interpreter owns
    # the QApplication, and the offscreen platform never shows a window.
    script = textwrap.dedent("""
        import sys
        from pathlib import Path
        from PySide6 import QtCore, QtGui, QtWidgets
        from sc2tools_agent.ui.gui import GuiUI, SettingsPayload, _GuiSignals, _MainWindow

        app = QtWidgets.QApplication([])
        base = Path(sys.argv[1])
        live, ptr, extra, later = (
            str(base / name) for name in ("live", "ptr", "extra", "later")
        )
        saved = []

        def save(payload):
            saved.append(payload)
            # The runner answers on this thread with the new watched list.
            ui.set_replay_folders([Path(live), Path(extra)])

        ui = GuiUI(
            version="0.17.6", dashboard_url="https://example.test/app",
            pairing_url="https://example.test/devices", log_dir=base,
            log_file=base / "agent.log", api_base="https://api.example.test",
            replay_folders=[Path(live), Path(ptr)], initial_paused=False,
            initial_paired=True, initial_user_id="u1",
            initial_settings=SettingsPayload(
                replay_folders=[Path(live), Path(ptr)],
            ),
            on_pause=lambda value: None, on_resync=lambda: None,
            on_choose_folder=lambda path: None, on_check_updates=lambda: None,
            on_save_settings=save, on_quit=lambda: None,
        )
        ui._signals = _GuiSignals()
        win = _MainWindow(ui=ui, signals=ui._signals, QtCore=QtCore,
                          QtGui=QtGui, QtWidgets=QtWidgets)

        def shown():
            return [win._folder_list.item(i).text()
                    for i in range(win._folder_list.count())]

        assert shown() == [live, ptr], shown()

        win._folder_list.item(1).setSelected(True)
        win._remove_folder_rows()
        assert shown() == [live], shown()

        # The agent starts watching a new folder while the edit is unsaved:
        # it is appended, and the removed folder is not put back.
        ui.set_replay_folders([Path(live), Path(ptr), Path(extra)])
        assert shown() == [live, extra], shown()

        win._click_save_settings()
        payload = saved[-1]
        assert [str(p) for p in payload.replay_folders] == [live, extra]
        assert [str(p) for p in payload.replay_folders_removed] == [ptr]
        assert shown() == [live, extra], shown()

        # With nothing unsaved, the watched list is shown as-is.
        ui.set_replay_folders([Path(live), Path(extra), Path(later)])
        assert shown() == [live, extra, later], shown()
        win._click_save_settings()
        assert saved[-1].replay_folders_removed == []

        win._log_timer.stop()
        win.deleteLater()
        app.processEvents()
        print("folder list passed")
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
    assert "folder list passed" in result.stdout
