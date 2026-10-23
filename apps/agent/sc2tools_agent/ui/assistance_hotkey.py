"""A Windows registered shortcut, without keyboard hooks or game input."""

from __future__ import annotations

import ctypes
from ctypes import wintypes
import logging
import sys


log = logging.getLogger(__name__)
HOTKEY_ID = 0x5343
WM_HOTKEY = 0x0312
MODIFIERS = 0x0002 | 0x0004 | 0x4000
KEY_F10 = 0x79
SHORTCUT = "Ctrl+Shift+F10"


class HotkeyRegistration:
    def __init__(self, user32):
        self.user32 = user32
        self.registered = False

    def set_enabled(self, enabled):
        if not enabled:
            self.shutdown()
            return "Global shortcut off. Use the Game assistance switch instead."
        if self.user32 is None:
            return "Global shortcut is available in the Windows desktop app."
        if not self.registered:
            self.registered = bool(self.user32.RegisterHotKey(None, HOTKEY_ID, MODIFIERS, KEY_F10))
        if not self.registered:
            return SHORTCUT + " is unavailable or used by another app. The Game assistance switch still works."
        return SHORTCUT + " · hide/show game assistance without leaving the game"

    def shutdown(self):
        if self.registered:
            self.user32.UnregisterHotKey(None, HOTKEY_ID)
            self.registered = False


def build_assistance_hotkey(app, callback, *, QtCore):
    user32 = None
    if sys.platform == "win32" and app.platformName() == "windows":
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        user32.RegisterHotKey.argtypes = [wintypes.HWND, ctypes.c_int, wintypes.UINT, wintypes.UINT]
        user32.RegisterHotKey.restype = wintypes.BOOL
        user32.UnregisterHotKey.argtypes = [wintypes.HWND, ctypes.c_int]
        user32.UnregisterHotKey.restype = wintypes.BOOL

    class AssistanceHotkey(QtCore.QAbstractNativeEventFilter):
        def __init__(self):
            super().__init__()
            self.registration = HotkeyRegistration(user32)
            self.closed = False
            app.installNativeEventFilter(self)

        def set_enabled(self, enabled):
            if self.closed:
                return "Global shortcut off."
            return self.registration.set_enabled(bool(enabled))

        def nativeEventFilter(self, event_type, message):
            if self.closed or not self.registration.registered:
                return False, 0
            if bytes(event_type) not in {b"windows_generic_MSG", b"windows_dispatcher_MSG"}:
                return False, 0
            native = wintypes.MSG.from_address(int(message))
            if native.message == WM_HOTKEY and native.wParam == HOTKEY_ID:
                try:
                    callback()
                except Exception:
                    log.exception("assistance_shortcut_failed")
                return True, 0
            return False, 0

        def shutdown(self):
            if not self.closed:
                self.closed = True
                self.registration.shutdown()
                app.removeNativeEventFilter(self)

    return AssistanceHotkey()
