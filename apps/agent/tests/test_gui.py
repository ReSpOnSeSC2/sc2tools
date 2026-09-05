"""Smoke tests for sc2tools_agent.ui.gui.

The full Qt window can't be reliably instantiated under pytest in CI
(QApplication setup, event loop, OS display checks), so these tests
focus on the parts that don't need a live ``QApplication``:

  * Module imports without PySide6 (graceful fallback for source
    installs that haven't ``pip install -r requirements.txt``-d yet).
  * ``can_use_gui()`` returns False when PySide6 is missing.
  * ``SettingsPayload`` constructs with the expected default fields.
  * ``_matches_level`` behaves as the GUI's log filter expects.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest


def test_module_imports_cleanly() -> None:
    """A no-PySide6 environment must still be able to import the
    module — the runner does ``from .ui import GuiUI`` unconditionally
    and then probes ``can_use_gui()``."""
    from sc2tools_agent.ui import gui

    assert hasattr(gui, "GuiUI")
    assert hasattr(gui, "SettingsPayload")
    assert callable(gui.can_use_gui)


def test_can_use_gui_returns_false_without_pyside6(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Simulate PySide6 being missing — can_use_gui() must say False
    rather than raise."""
    # Remove any PySide6 entry from sys.modules so the import inside
    # can_use_gui() actually re-runs.
    for name in list(sys.modules):
        if name == "PySide6" or name.startswith("PySide6."):
            monkeypatch.delitem(sys.modules, name, raising=False)

    real_import = __builtins__["__import__"] if isinstance(__builtins__, dict) else __builtins__.__import__

    def fake_import(name: str, *args, **kwargs):
        if name == "PySide6.QtWidgets" or name.startswith("PySide6"):
            raise ImportError("simulated missing PySide6")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", fake_import)

    # Reload the gui module so its can_use_gui() runs against the
    # patched import hook.
    import sc2tools_agent.ui.gui as gui_mod
    importlib.reload(gui_mod)

    assert gui_mod.can_use_gui() is False


def test_settings_payload_defaults_to_none() -> None:
    from sc2tools_agent.ui.gui import SettingsPayload

    p = SettingsPayload()
    assert p.api_base is None
    assert p.log_level is None
    assert p.replay_folder is None
    assert p.replay_folders is None
    assert p.autostart_enabled is None
    assert p.start_minimized is None
    assert p.auto_update_enabled is None
    assert p.replay_capture_enabled is None


def test_settings_payload_auto_update_round_trips() -> None:
    """``auto_update_enabled`` must keep the None / True / False
    trichotomy — None means "no change" to the runner, False turns the
    updater notify-only, True restores automatic installs."""
    from sc2tools_agent.ui.gui import SettingsPayload

    assert SettingsPayload(auto_update_enabled=True).auto_update_enabled is True
    assert SettingsPayload(auto_update_enabled=False).auto_update_enabled is False


def test_settings_payload_replay_capture_keeps_explicit_opt_out() -> None:
    from sc2tools_agent.ui.gui import SettingsPayload

    assert SettingsPayload(replay_capture_enabled=True).replay_capture_enabled is True
    assert SettingsPayload(replay_capture_enabled=False).replay_capture_enabled is False


def test_settings_payload_round_trips_explicit_values(tmp_path: Path) -> None:
    from sc2tools_agent.ui.gui import SettingsPayload

    p = SettingsPayload(
        api_base="https://example.test",
        log_level="DEBUG",
        replay_folder=tmp_path,
        autostart_enabled=True,
        start_minimized=True,
    )
    assert p.api_base == "https://example.test"
    assert p.log_level == "DEBUG"
    assert p.replay_folder == tmp_path
    # Legacy single-folder field should auto-migrate into the list.
    assert p.replay_folders == [tmp_path]
    assert p.autostart_enabled is True
    assert p.start_minimized is True


def test_settings_payload_explicit_folder_list_wins(tmp_path: Path) -> None:
    """When the caller passes both fields, the explicit list takes
    priority — the legacy single field is only a fallback."""
    from sc2tools_agent.ui.gui import SettingsPayload

    a = tmp_path / "a"
    b = tmp_path / "b"
    p = SettingsPayload(
        replay_folder=tmp_path,
        replay_folders=[a, b],
    )
    assert p.replay_folders == [a, b]
    assert p.replay_folder == tmp_path


def test_settings_payload_empty_folder_list_means_clear() -> None:
    """An explicit empty list signals "clear the override list" — distinct
    from None ("no change"). The runner needs to be able to tell the
    difference to honour the Settings tab's Auto-detect button."""
    from sc2tools_agent.ui.gui import SettingsPayload

    p = SettingsPayload(replay_folders=[])
    assert p.replay_folders == []
    assert p.replay_folders is not None


def test_replay_archive_status_is_retained_until_qt_signals_exist(
    tmp_path: Path,
) -> None:
    from sc2tools_agent.ui.gui import GuiUI, SettingsPayload

    ui = GuiUI(
        version="0.15.0",
        dashboard_url="https://example.test/app",
        pairing_url="https://example.test/devices",
        log_dir=tmp_path,
        log_file=tmp_path / "agent.log",
        api_base="https://api.example.test",
        replay_folders=[],
        initial_paused=False,
        initial_paired=True,
        initial_user_id="u1",
        initial_settings=SettingsPayload(),
        on_pause=lambda _paused: None,
        on_resync=lambda: None,
        on_choose_folder=lambda _path: None,
        on_check_updates=lambda: None,
        on_save_settings=lambda _settings: None,
        on_quit=lambda: None,
    )

    ui.on_replay_archive_status(4, 10)

    assert ui._pending_replay_archive_status == (4, 10)


def test_archive_resync_explains_how_to_clear_a_saved_filter() -> None:
    from sc2tools_agent.ui.gui import _replay_archive_filter_block_message

    assert _replay_archive_filter_block_message("") is None
    message = _replay_archive_filter_block_message("Season 67")
    assert message is not None
    assert "Season 67" in message
    assert "choose All time" in message
    assert "Save settings" in message


def test_log_level_filter() -> None:
    from sc2tools_agent.ui.gui import _matches_level

    info_line = "2026-05-04T20:00:00 INFO sc2tools_agent | watching for replays"
    err_line = "2026-05-04T20:00:01 ERROR sc2tools_agent | upload_failed name=foo"
    debug_line = "2026-05-04T20:00:02 DEBUG sc2tools_agent | tail noisy"

    assert _matches_level(info_line, "All") is True
    assert _matches_level(info_line, "INFO+") is True
    assert _matches_level(debug_line, "INFO+") is False
    assert _matches_level(err_line, "ERROR only") is True
    assert _matches_level(info_line, "ERROR only") is False


def test_runner_uses_can_use_gui_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    """The runner must defer to gui.can_use_gui() rather than
    blindly importing PySide6 — otherwise a source install without
    GUI extras crashes on first launch."""
    from sc2tools_agent import runner

    # The runner imports can_use_gui from the ui package.
    assert callable(runner.can_use_gui)
