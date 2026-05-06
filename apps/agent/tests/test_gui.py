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
