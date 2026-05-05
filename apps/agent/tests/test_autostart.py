"""Tests for sc2tools_agent.autostart - Windows Run-key toggling.

The real registry is platform-specific and stateful, so we
monkey-patch ``winreg`` with an in-memory fake that records the
calls. That's enough to verify:

  * is_supported() reads as expected on Windows vs not.
  * set_enabled(True) writes our value with a sane command line.
  * set_enabled(False) removes the value (idempotent on missing key).
  * is_enabled() round-trips correctly.

On non-Windows hosts these tests still run because we don't import the
real winreg - we install a fake one in sys.modules first, and we
override autostart._platform_is_windows() rather than os.name (the
latter breaks pathlib).
"""

from __future__ import annotations

import sys
import types
from pathlib import Path
from typing import Any, Dict, Tuple

import pytest


# ---------------------------------------------------------------------
# Fake winreg
# ---------------------------------------------------------------------


class _FakeKey:
    def __init__(self, registry: "_FakeRegistry", path: str) -> None:
        self._registry = registry
        self._path = path

    def __enter__(self) -> "_FakeKey":
        return self

    def __exit__(self, *exc_info) -> None:
        return None


class _FakeRegistry:
    """Minimal stand-in for the winreg module."""

    HKEY_CURRENT_USER = "HKCU"
    REG_SZ = "REG_SZ"
    KEY_SET_VALUE = "KEY_SET_VALUE"

    def __init__(self) -> None:
        self.values: Dict[Tuple[str, str], Tuple[str, Any]] = {}

    # Mimic the winreg surface area autostart.py touches.

    def OpenKey(self, hive, subkey, _reserved=0, _access=0):  # noqa: N802
        path = f"{hive}\\{subkey}"
        if not any(k[0] == path for k in self.values):
            raise FileNotFoundError(path)
        return _FakeKey(self, path)

    def CreateKey(self, hive, subkey):  # noqa: N802
        path = f"{hive}\\{subkey}"
        return _FakeKey(self, path)

    def QueryValueEx(self, key: _FakeKey, name: str):  # noqa: N802
        v = self.values.get((key._path, name))
        if v is None:
            raise FileNotFoundError(name)
        return v

    def SetValueEx(self, key: _FakeKey, name: str, _reserved, kind, value):  # noqa: N802
        self.values[(key._path, name)] = (value, kind)

    def DeleteValue(self, key: _FakeKey, name: str) -> None:  # noqa: N802
        if (key._path, name) not in self.values:
            raise FileNotFoundError(name)
        del self.values[(key._path, name)]


@pytest.fixture
def fake_winreg(monkeypatch: pytest.MonkeyPatch):
    fake = _FakeRegistry()
    module = types.ModuleType("winreg")
    for attr in (
        "HKEY_CURRENT_USER",
        "REG_SZ",
        "KEY_SET_VALUE",
        "OpenKey",
        "CreateKey",
        "QueryValueEx",
        "SetValueEx",
        "DeleteValue",
    ):
        setattr(module, attr, getattr(fake, attr))
    monkeypatch.setitem(sys.modules, "winreg", module)
    # Force is_supported() to behave like Windows for the duration of
    # the test, regardless of where pytest is actually running. We do
    # this via the autostart module's private hook so we never patch
    # os.name globally (that breaks pathlib's WindowsPath/PosixPath
    # selection and triggers pytest INTERNALERRORs).
    from sc2tools_agent import autostart
    monkeypatch.setattr(autostart, "_platform_is_windows", lambda: True)
    return fake


# ---------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------


def test_is_supported_true_on_nt(fake_winreg) -> None:
    from sc2tools_agent import autostart
    assert autostart.is_supported() is True


def test_set_enabled_writes_run_key(
    fake_winreg: _FakeRegistry,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    from sc2tools_agent import autostart

    fake_exe = tmp_path / "sc2tools-agent.exe"
    fake_exe.write_text("", encoding="utf-8")
    monkeypatch.setattr(autostart, "get_executable_path", lambda: fake_exe)

    assert autostart.set_enabled(True) is True

    expected_path = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"
    key = (expected_path, "SC2ToolsAgent")
    assert key in fake_winreg.values
    command, kind = fake_winreg.values[key]
    assert kind == "REG_SZ"
    assert "sc2tools-agent.exe" in command


def test_set_enabled_false_is_idempotent(
    fake_winreg: _FakeRegistry,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    from sc2tools_agent import autostart

    fake_exe = tmp_path / "sc2tools-agent.exe"
    fake_exe.write_text("", encoding="utf-8")
    monkeypatch.setattr(autostart, "get_executable_path", lambda: fake_exe)

    # Disabling a never-enabled key returns True (goal state reached).
    assert autostart.set_enabled(False) is True

    # Enable, then disable.
    autostart.set_enabled(True)
    assert autostart.is_enabled() is True
    assert autostart.set_enabled(False) is True
    assert autostart.is_enabled() is False


def test_is_enabled_returns_false_when_no_executable(
    fake_winreg: _FakeRegistry,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from sc2tools_agent import autostart

    monkeypatch.setattr(autostart, "get_executable_path", lambda: None)
    # No registry value yet -> False.
    assert autostart.is_enabled() is False
    # Trying to enable without an exe path is a soft failure.
    assert autostart.set_enabled(True) is False


def test_set_enabled_no_op_on_unsupported_os(monkeypatch: pytest.MonkeyPatch) -> None:
    from sc2tools_agent import autostart

    monkeypatch.setattr(autostart, "_platform_is_windows", lambda: False)
    assert autostart.is_supported() is False
    assert autostart.set_enabled(True) is False
    assert autostart.is_enabled() is False
