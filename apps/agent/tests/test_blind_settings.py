"""Durable opt-in and real Qt control coverage for native Blind Ladder."""

from __future__ import annotations

import importlib.util
import json
import logging
import os
from pathlib import Path
import subprocess
import sys
import textwrap
from types import SimpleNamespace

import pytest

from sc2tools_agent.config import AgentConfig
from sc2tools_agent.runner import _handle_save_settings
from sc2tools_agent.state import AgentState, load_state, save_state
from sc2tools_agent.ui.gui import SettingsPayload


@pytest.mark.parametrize("value", [None, False, 0, 1, "true", "false", [], {}])
def test_blind_mode_only_exact_true_opts_in(tmp_path: Path, value) -> None:
    (tmp_path / "agent.json").write_text(json.dumps({"blind_mode_enabled": value}))
    assert load_state(tmp_path).blind_mode_enabled is False


def test_blind_mode_round_trip_and_corrupt_config(tmp_path: Path) -> None:
    state = AgentState(blind_mode_enabled=True, blind_mode_config={
        "loading_style": "panels", "borderless_confirmed": True,
        "coverage_verified": True, "calibrated_aspect_ratio": 16 / 9,
    })
    save_state(tmp_path, state)
    loaded = load_state(tmp_path)
    assert loaded.blind_mode_enabled is True
    assert loaded.blind_mode_config["loading_style"] == "panels"
    assert loaded.blind_mode_config["coverage_verified"] is True
    assert loaded.blind_mode_config["borderless_confirmed"] is True
    assert loaded.blind_mode_config["calibrated_aspect_ratio"] == 16 / 9
    assert "enabled" not in loaded.blind_mode_config
    raw = json.loads((tmp_path / "agent.json").read_text())
    raw["blind_mode_config"] = {"chat_masks": [{"x": -1, "y": 0, "width": 1, "height": 1}]}
    (tmp_path / "agent.json").write_text(json.dumps(raw))
    recovered = load_state(tmp_path)
    assert recovered.blind_mode_enabled is True
    assert recovered.blind_mode_config["loading_style"] == "curtain"
    assert recovered.blind_mode_config["coverage_verified"] is False
    assert recovered.blind_mode_config["chat_masks"]


def test_save_applies_blind_settings_only_after_durable_write(tmp_path: Path, monkeypatch) -> None:
    config = AgentConfig(api_base="http://localhost:0", state_dir=tmp_path,
                         replay_folder=None, poll_interval_sec=10, parse_concurrency=1)
    state = AgentState()
    applied = []

    def apply(enabled, coverage, hint):
        assert load_state(tmp_path).blind_mode_enabled is enabled
        assert load_state(tmp_path).blind_mode_config == coverage
        applied.append((enabled, coverage, hint))

    cell = SimpleNamespace(upload=None, watcher=None, tray=None,
                           gui=SimpleNamespace(apply_blind_settings=apply))
    payload = SettingsPayload(blind_mode_enabled=True, blind_mode_config={"loading_style": "panels"})
    _handle_save_settings(config, state, payload, cell, logging.getLogger("test"))
    assert len(applied) == 1 and state.blind_mode_enabled is True
    previous_coverage = dict(state.blind_mode_config)

    def fail_save(*args):
        raise OSError("disk full")

    monkeypatch.setattr("sc2tools_agent.runner.save_state", fail_save)
    with pytest.raises(OSError, match="disk full"):
        _handle_save_settings(
            config, state, SettingsPayload(blind_mode_enabled=False, blind_mode_config={}),
            cell, logging.getLogger("test"),
        )
    assert state.blind_mode_enabled is True
    assert state.blind_mode_config == previous_coverage
    assert len(applied) == 1
    assert load_state(tmp_path).blind_mode_enabled is True


def test_invalid_blind_coverage_does_not_change_enabled_state(tmp_path: Path) -> None:
    config = AgentConfig(api_base="http://localhost:0", state_dir=tmp_path,
                         replay_folder=None, poll_interval_sec=10, parse_concurrency=1)
    state = AgentState()
    cell = SimpleNamespace(upload=None, watcher=None, tray=None, gui=None)
    with pytest.raises(ValueError):
        _handle_save_settings(
            config, state, SettingsPayload(blind_mode_enabled=True,
                                          blind_mode_config={"loading_masks": []}),
            cell, logging.getLogger("test"),
        )
    assert state.blind_mode_enabled is False


def test_real_qt_blind_controls_share_durable_state(tmp_path: Path) -> None:
    if importlib.util.find_spec("PySide6") is None:
        pytest.skip("Qt is not installed")
    script = textwrap.dedent("""
        import logging
        import sys
        from pathlib import Path
        from types import SimpleNamespace
        from PySide6 import QtCore, QtGui, QtWidgets
        from sc2tools_agent import runner
        from sc2tools_agent.config import AgentConfig
        from sc2tools_agent.state import AgentState, load_state
        from sc2tools_agent.ui.gui import GuiUI, SettingsPayload, _GuiSignals, _MainWindow

        app = QtWidgets.QApplication([])
        base = Path(sys.argv[1])
        cfg = AgentConfig(api_base='http://localhost:0', state_dir=base,
                          replay_folder=None, poll_interval_sec=10, parse_concurrency=1)
        state = AgentState()
        cell = SimpleNamespace(upload=None, watcher=None, tray=None, gui=None)
        saves = []
        def save(payload):
            runner._handle_save_settings(cfg, state, payload, cell, logging.getLogger('test'))
            saves.append(payload)
        ui = GuiUI(
            version='test', dashboard_url='https://example.test/app',
            pairing_url='https://example.test/devices', log_dir=base,
            log_file=base / 'agent.log', api_base='http://localhost:0', replay_folders=[],
            initial_paused=False, initial_paired=True, initial_user_id='u',
            initial_settings=SettingsPayload(), on_pause=lambda value: None,
            on_resync=lambda: None, on_choose_folder=lambda path: None,
            on_check_updates=lambda: None, on_save_settings=save, on_quit=lambda: None,
        )
        ui._signals = _GuiSignals()
        window = _MainWindow(ui=ui, signals=ui._signals, QtCore=QtCore,
                             QtGui=QtGui, QtWidgets=QtWidgets)
        ui._window = window
        cell.gui = ui
        assert saves == [] and not window._blind_enable_check.isChecked()
        if sys.platform == 'win32':
            window._api_input.setText('unsaved draft')
            window._blind_toggle_button.click()
            assert window._blind_enable_check.isChecked()
            assert load_state(base).blind_mode_enabled is True
            assert 'Setup needed' in window._blind_status_labels[0].text()
            assert window._blind_dashboard_adjust_button.isEnabled()
            assert saves[-1].api_base is None
            assert window._api_input.text() == 'unsaved draft'
            assert 'off' in window._blind_toggle_button.text()
            window._blind_enable_check.setChecked(False)
            assert not window._blind_enabled
            assert load_state(base).blind_mode_enabled is False
            assert 'on' in window._blind_toggle_button.text()
            # Controller hotkey requests go through the same durable callback.
            assert window._toggle_blind_mode(True) is True
            assert load_state(base).blind_mode_enabled is True
            original_save = runner.save_state
            def fail(*args):
                raise OSError('disk full')
            runner.save_state = fail
            assert window._toggle_blind_mode(False) is False
            assert not window._blind_enable_check.isChecked()
            assert state.blind_mode_enabled is True
            assert 'Off for this run' in window._blind_status_labels[0].text()
            assert window._blind_toggle_button.text() == 'Save off setting'
            ui.apply_blind_settings(True, state.blind_mode_config, None)
            assert not window._blind_enabled
            runner.save_state = original_save
            window._blind_toggle_button.click()
            assert not load_state(base).blind_mode_enabled
            assert not window._blind_unsaved_off
            # Calibration's result is saved before it changes the controller.
            coverage_answer = {'loading_style': 'panels'}
            configs = []
            class CoverageActions:
                def calibrate(self, parent):
                    assert parent is window
                    return coverage_answer
                def set_config(self, config):
                    configs.append(config)
                def set_enabled(self, enabled):
                    assert load_state(base).blind_mode_enabled is enabled
                def set_user_name_hint(self, hint):
                    pass
            ui._blind_controller = CoverageActions()
            window._blind_dashboard_adjust_button.click()
            assert load_state(base).blind_mode_config['loading_style'] == 'panels'
            assert window._blind_config == load_state(base).blind_mode_config
            assert saves[-1].blind_mode_enabled is None
            old_count = len(saves)
            coverage_answer = None
            window._blind_adjust_button.click()
            assert len(saves) == old_count
            coverage_answer = {'loading_style': 'curtain'}
            runner.save_state = fail
            window._blind_adjust_button.click()
            assert load_state(base).blind_mode_config['loading_style'] == 'panels'
            assert configs[-1]['loading_style'] == 'panels'
            assert 'Could not save coverage' in window._blind_status_labels[0].text()
            runner.save_state = original_save
        else:
            assert not window._blind_toggle_button.isEnabled()
            assert not window._blind_enable_check.isEnabled()
            assert 'Windows' in window._blind_status_labels[0].text()
        assert isinstance(window._stack.widget(0), QtWidgets.QScrollArea)
        window._log_timer.stop()
        window.deleteLater()
        app.processEvents()
        print('blind controls passed')
    """)
    environment = dict(os.environ)
    environment["QT_QPA_PLATFORM"] = "offscreen"
    environment["PYTHONPATH"] = os.pathsep.join(
        part for part in (str(Path(__file__).resolve().parents[1]), environment.get("PYTHONPATH")) if part
    )
    result = subprocess.run([sys.executable, "-c", script, str(tmp_path)],
                            capture_output=True, text=True, timeout=30, env=environment)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "blind controls passed" in result.stdout
