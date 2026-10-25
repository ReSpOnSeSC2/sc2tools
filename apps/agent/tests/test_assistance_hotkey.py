from unittest.mock import Mock
import ctypes
from ctypes import wintypes
import os

import pytest

from sc2tools_agent.ui.assistance_hotkey import HotkeyRegistration, HOTKEY_ID, KEY_F10, MODIFIERS


def test_registers_one_global_shortcut_and_releases_it_on_disable():
    user32 = Mock()
    user32.RegisterHotKey.return_value = True
    shortcut = HotkeyRegistration(user32)
    assert "hide/show" in shortcut.set_enabled(True)
    shortcut.set_enabled(True)
    user32.RegisterHotKey.assert_called_once_with(None, HOTKEY_ID, MODIFIERS, KEY_F10)
    shortcut.set_enabled(False)
    shortcut.shutdown()
    user32.UnregisterHotKey.assert_called_once_with(None, HOTKEY_ID)
    assert not shortcut.registered


def test_conflicts_are_visible_and_do_not_claim_success():
    user32 = Mock()
    user32.RegisterHotKey.return_value = False
    shortcut = HotkeyRegistration(user32)
    assert "used by another app" in shortcut.set_enabled(True)
    assert not shortcut.registered
    shortcut.shutdown()
    user32.UnregisterHotKey.assert_not_called()


def test_unsupported_platform_is_explicit():
    shortcut = HotkeyRegistration(None)
    assert "Windows desktop" in shortcut.set_enabled(True)
    assert "off" in shortcut.set_enabled(False)


def test_qt_native_filter_dispatches_only_its_registered_hotkey():
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    pytest.importorskip("PySide6")
    from PySide6 import QtCore, QtWidgets
    from sc2tools_agent.ui.assistance_hotkey import build_assistance_hotkey, WM_HOTKEY

    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    callback = Mock()
    shortcut = build_assistance_hotkey(app, callback, QtCore=QtCore)
    shortcut.registration.user32 = Mock()
    shortcut.registration.registered = True
    message = wintypes.MSG()
    message.message = WM_HOTKEY
    message.wParam = HOTKEY_ID
    pointer = ctypes.addressof(message)
    assert shortcut.nativeEventFilter(b"windows_generic_MSG", pointer) == (True, 0)
    callback.assert_called_once()
    message.wParam = HOTKEY_ID + 1
    assert shortcut.nativeEventFilter(b"windows_generic_MSG", pointer) == (False, 0)
    shortcut.shutdown()
    shortcut.shutdown()
    assert shortcut.nativeEventFilter(b"windows_generic_MSG", pointer) == (False, 0)
