"""Real Qt GUI/controller integration; OS and network boundaries stay isolated."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import textwrap

import pytest


def test_gui_runs_one_blind_controller_and_shuts_it_down(tmp_path: Path) -> None:
    if sys.platform != "win32" or importlib.util.find_spec("PySide6") is None:
        pytest.skip("Windows Qt integration")
    script = textwrap.dedent("""
        import logging
        import os
        import sys
        import threading
        import traceback
        from pathlib import Path
        from types import SimpleNamespace
        from PySide6 import QtCore, QtGui, QtWidgets
        from sc2tools_agent import runner
        from sc2tools_agent.config import AgentConfig
        from sc2tools_agent.state import AgentState, load_state
        from sc2tools_agent.ui import blind_shield
        from sc2tools_agent.ui.blind_windows import BlindWindowsBackend, NativeGameWindow
        from sc2tools_agent.ui.gui import GuiUI, SettingsPayload

        base = Path(sys.argv[1])
        qa = Path(os.environ.get('SC2TOOLS_BLIND_QA_DIR', str(base / 'screenshots')))
        qa.mkdir(parents=True, exist_ok=True)
        cfg = AgentConfig(api_base='http://localhost:0', state_dir=base,
                          replay_folder=None, poll_interval_sec=10, parse_concurrency=1)
        state = AgentState()
        saved = []
        errors = []
        fail_save = False
        created = []
        sessions = []
        cell = SimpleNamespace(upload=None, watcher=None, tray=None, gui=None)

        # The actual backend facade runs, but never calls user32 or touches
        # another desktop application. The controller and editor are real.
        class IsolatedWindowsApi:
            game = None
            registered = 0
            unregistered = 0
            editor_positions = 0
            def foreground_window(self): return 1 if self.game else 0
            def inspect_window(self, hwnd, foreground): return self.game if hwnd == 1 else None
            def enumerate_windows(self): return []
            def register_hotkey(self, hwnd):
                self.registered += 1
                return True
            def unregister_hotkey(self, hwnd): self.unregistered += 1
            def poll_hotkey(self, hwnd): return False
            def matches_native_message(self, *args): return False
            def position_overlay(self, *args, **kwargs):
                raise AssertionError('GUI integration must not create gameplay cover fixtures')
            def position_editor(self, *args):
                self.editor_positions += 1
                return True
        api = IsolatedWindowsApi()
        def backend_factory():
            backend = BlindWindowsBackend(api=api)
            created.append(backend)
            return backend
        blind_shield.BlindWindowsBackend = backend_factory

        class NoNetworkSession:
            trust_env = True
            closed = False
            calls = 0
            def __init__(self): sessions.append(self)
            def get(self, *args, **kwargs):
                self.calls += 1
                raise AssertionError('No network is permitted in this GUI integration test')
            def close(self): self.closed = True
        blind_shield.requests.Session = NoNetworkSession
        original_save = runner.save_state
        def guarded_save(*args):
            if fail_save:
                raise OSError('test disk full')
            return original_save(*args)
        runner.save_state = guarded_save
        def save(payload):
            runner._handle_save_settings(cfg, state, payload, cell, logging.getLogger('test'))
            saved.append(payload)

        ui = GuiUI(
            version='test fixture', dashboard_url='https://example.test/app',
            pairing_url='https://example.test/devices', log_dir=base,
            log_file=base / 'agent.log', api_base='http://localhost:0',
            replay_folders=[], initial_paused=False, initial_paired=True,
            initial_user_id='test-fixture', initial_settings=SettingsPayload(),
            on_pause=lambda value: None, on_resync=lambda: None,
            on_choose_folder=lambda path: None, on_check_updates=lambda: None,
            on_save_settings=save, on_quit=lambda: None, start_minimized=True,
        )
        cell.gui = ui
        app = QtWidgets.QApplication([])
        # The offscreen Qt platform does not enumerate Windows' system fonts.
        # Load the real application fonts explicitly for legible QA renders.
        for name in ('segoeui.ttf', 'segoeuib.ttf', 'seguisb.ttf', 'consola.ttf'):
            font_path = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts' / name
            if font_path.exists():
                QtGui.QFontDatabase.addApplicationFont(str(font_path))
        controller = None
        worker = None

        def exercise():
            global controller, worker, fail_save
            try:
                window = ui._window
                controller = ui._blind_controller
                assert isinstance(controller, blind_shield.BlindShieldController)
                assert len(created) == 1
                assert controller.thread() == app.thread()
                assert controller._started and controller._timer.isActive()
                worker = controller._thread
                assert worker is not None and worker.is_alive()
                controller.start()
                assert controller._thread is worker
                assert not window.isVisible()  # --start-minimized does not skip the runtime.
                assert saved == []
                ui.show_window()
                app.processEvents()
                assert window.isVisible()
                window.resize(1100, 860)
                window._blind_toggle_button.click()
                assert len(saved) == 1 and load_state(base).blind_mode_enabled
                assert controller._enabled and window._blind_enable_check.isChecked()
                assert window._toggle_blind_mode(True)
                assert len(saved) == 1  # Idempotent callback does not write again.
                assert 'Set up coverage' in window._blind_dashboard_adjust_button.text()
                app.processEvents()
                assert window.grab().save(str(qa / 'dashboard.png'))
                window.resize(820, 540)
                app.processEvents()
                viewport = window._stack.widget(0).viewport()
                for button in (window._blind_toggle_button, window._blind_dashboard_adjust_button):
                    bottom_right = button.mapTo(viewport, QtCore.QPoint(button.width(), button.height()))
                    assert 0 <= bottom_right.x() <= viewport.width()
                    assert 0 <= bottom_right.y() <= viewport.height()
                assert window.grab().save(str(qa / 'dashboard-minimum.png'))
                window._nav_group.button(3).click()
                window.resize(1100, 1120)
                app.processEvents()
                assert window.grab().save(str(qa / 'settings.png'))

                # Closing the GUI hides to tray; it does not stop protection.
                window.close()
                app.processEvents()
                assert not window.isVisible()
                assert controller._started and worker.is_alive()
                ui.show_window()
                controller._emergency_off()
                assert len(saved) == 2 and not load_state(base).blind_mode_enabled
                assert not controller._enabled and not window._blind_enable_check.isChecked()

                window._toggle_blind_mode(True)
                fail_save = True
                controller._emergency_off()
                assert state.blind_mode_enabled and load_state(base).blind_mode_enabled
                assert not controller._enabled and not window._blind_enable_check.isChecked()
                assert window._blind_toggle_button.text() == 'Save off setting'
                controller._tick()
                assert 'Off for this run' in window._blind_status_labels[0].text()
                ui.apply_blind_settings(True, state.blind_mode_config, 'late hint')
                assert not controller._enabled  # Late boot updates cannot undo emergency off.
                fail_save = False
                window._blind_toggle_button.click()
                assert not load_state(base).blind_mode_enabled
                controller._tick()
                assert not window._blind_unsaved_off
                assert 'Off for this run' not in window._blind_status_labels[0].text()
                window._toggle_blind_mode(True)
                fail_save = True
                window._blind_enable_check.setChecked(False)
                assert not controller._enabled and state.blind_mode_enabled
                assert not window._blind_enable_check.isChecked()
                fail_save = False
                window._blind_toggle_button.click()
                assert not state.blind_mode_enabled

                # Calibrate while disabled: real editor, real acceptance,
                # persisted result; fixture window metadata stays test-only.
                api.game = NativeGameWindow(1, 0, 0, 1600, 900, True, False, True, 'windowed')
                before = len(saved)
                def accept_editor():
                    dialog = controller._dialog
                    assert isinstance(dialog, blind_shield._CoverageEditor)
                    dialog._verified.setChecked(True)
                    dialog._borderless.setChecked(True)
                    api.game = None
                    dialog._save()
                QtCore.QTimer.singleShot(0, accept_editor)
                window._blind_dashboard_adjust_button.click()
                assert len(saved) == before + 1
                assert state.blind_mode_config['coverage_verified'] is True
                assert load_state(base).blind_mode_config['calibrated_aspect_ratio'] == 1600 / 900
                assert window._blind_dashboard_adjust_button.text() == 'Adjust coverage…'
                assert not controller._enabled
                assert api.editor_positions > 0

                # Cancel invokes no save and always clears the calibration state.
                api.game = NativeGameWindow(1, 0, 0, 1600, 900, True, False, True, 'windowed')
                before = len(saved)
                def cancel_editor():
                    api.game = None
                    controller._dialog.reject()
                QtCore.QTimer.singleShot(0, cancel_editor)
                window._blind_adjust_button.click()
                assert len(saved) == before
                assert controller._dialog is None and not controller._calibrating
                assert not any(s.calls for s in sessions)
            except BaseException:
                errors.append(traceback.format_exc())
            finally:
                ui.request_quit()

        QtCore.QTimer.singleShot(0, exercise)
        QtCore.QTimer.singleShot(15000, app.quit)
        rc = ui.run()
        assert not errors, '\\n'.join(errors)
        assert rc == 0 and controller is not None
        assert not controller._started and not controller._timer.isActive()
        assert worker is not None and not worker.is_alive()
        assert controller._thread is None and controller._surfaces == []
        assert all(s.closed and not s.calls for s in sessions)
        assert api.unregistered >= 1
        print('GUI/controller lifecycle and calibration passed')
        print('screenshots:', qa)
    """)
    environment = dict(os.environ)
    environment["QT_QPA_PLATFORM"] = "offscreen"
    environment["PYTHONPATH"] = os.pathsep.join(
        part for part in (str(Path(__file__).resolve().parents[1]), environment.get("PYTHONPATH")) if part
    )
    result = subprocess.run([sys.executable, "-c", script, str(tmp_path)],
                            capture_output=True, text=True, timeout=25, env=environment)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "GUI/controller lifecycle and calibration passed" in result.stdout
