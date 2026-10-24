"""Native click-through for display-only overlays while StarCraft has focus."""

from __future__ import annotations

import logging
import os
import sys

from . import win32_window


log = logging.getLogger(__name__)
WS_EX_TRANSPARENT = 0x00000020
WS_EX_LAYERED = 0x00080000
INPUT_STYLES = WS_EX_TRANSPARENT | WS_EX_LAYERED
REFRESH_FLAGS = 0x0001 | 0x0002 | 0x0004 | 0x0010 | 0x0020


class _StyleApi:
    def __init__(self):
        import ctypes
        from ctypes import wintypes

        self._ctypes = ctypes
        self._wintypes = wintypes
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        self._get_style = getattr(user32, "GetWindowLongPtrW", None) or user32.GetWindowLongW
        self._get_style.argtypes = [wintypes.HWND, ctypes.c_int]
        self._get_style.restype = ctypes.c_ssize_t
        self._set_style = getattr(user32, "SetWindowLongPtrW", None) or user32.SetWindowLongW
        self._set_style.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_ssize_t]
        self._set_style.restype = ctypes.c_ssize_t
        self._thread_process_id = user32.GetWindowThreadProcessId
        self._thread_process_id.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        self._thread_process_id.restype = wintypes.DWORD
        self._layered = user32.SetLayeredWindowAttributes
        self._layered.argtypes = [wintypes.HWND, wintypes.DWORD, wintypes.BYTE, wintypes.DWORD]
        self._layered.restype = wintypes.BOOL
        self._position = user32.SetWindowPos
        self._position.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int,
                                  ctypes.c_int, ctypes.c_int, wintypes.UINT]
        self._position.restype = wintypes.BOOL

    def owns_window(self, hwnd):
        process = self._wintypes.DWORD(0)
        self._thread_process_id(hwnd, self._ctypes.byref(process))
        return process.value == os.getpid()

    def style(self, hwnd):
        self._ctypes.set_last_error(0)
        result = self._get_style(hwnd, -20)
        if not result and self._ctypes.get_last_error():
            raise self._ctypes.WinError(self._ctypes.get_last_error())
        return int(result)

    def set_style(self, hwnd, style):
        self._ctypes.set_last_error(0)
        previous = self._set_style(hwnd, -20, style)
        if not previous and self._ctypes.get_last_error():
            raise self._ctypes.WinError(self._ctypes.get_last_error())

    def make_opaque(self, hwnd):
        if not self._layered(hwnd, 0, 255, 0x00000002):
            raise self._ctypes.WinError(self._ctypes.get_last_error())

    def refresh(self, hwnd):
        if not self._position(hwnd, None, 0, 0, 0, 0, REFRESH_FLAGS):
            raise self._ctypes.WinError(self._ctypes.get_last_error())


class NativeClickThrough:
    def __init__(self, *, api=None):
        self._api = api
        self._unavailable = False
        self._added = {}

    def _get_api(self):
        if self._api is None and not self._unavailable:
            self._unavailable = True
            if sys.platform == "win32":
                try:
                    self._api = _StyleApi()
                except Exception:
                    log.debug("overlay_input_api_unavailable", exc_info=True)
        return self._api

    def set_click_through(self, hwnd, enabled):
        if not hwnd:
            return False
        if not enabled and hwnd not in self._added:
            return True
        api = self._get_api()
        if api is None:
            return False
        original = None
        changed = False
        created = False
        try:
            if not api.owns_window(hwnd):
                self._added.pop(hwnd, None)
                return False
            original = api.style(hwnd)
            if enabled:
                added = self._added.get(hwnd, INPUT_STYLES & ~original)
                if hwnd not in self._added:
                    self._added[hwnd] = added
                    created = True
                desired = original | INPUT_STYLES
            else:
                desired = original & ~self._added[hwnd]
            if desired != original:
                api.set_style(hwnd, desired)
                changed = True
                if enabled and not original & WS_EX_LAYERED:
                    api.make_opaque(hwnd)
                api.refresh(hwnd)
            if enabled:
                self._added[hwnd] = added
            else:
                self._added.pop(hwnd, None)
            return True
        except Exception:
            restored = not changed
            if changed and original is not None:
                try:
                    api.set_style(hwnd, original)
                    api.refresh(hwnd)
                    restored = True
                except Exception:
                    log.debug("overlay_input_restore_failed", exc_info=True)
            if created and restored:
                self._added.pop(hwnd, None)
            log.debug("overlay_input_style_failed", exc_info=True)
            return False

    def restore_all(self):
        for hwnd in tuple(self._added):
            self.set_click_through(hwnd, False)


def sc2_has_foreground():
    return win32_window.is_sc2_window(win32_window.foreground_window())


def install_overlay_input(window, *, panels_provider, compact_provider, QtCore, native=None, foreground_provider=None):
    class OverlayInput(QtCore.QObject):
        def __init__(self):
            super().__init__(window)
            self._native = native if native is not None else NativeClickThrough()
            self._foreground = foreground_provider or sc2_has_foreground
            self._handles = {}
            self._closed = False
            self._updating = False
            self.timer = QtCore.QTimer(self)
            self.timer.setInterval(150)
            self.timer.timeout.connect(self.refresh)
            self.timer.start()
            self.refresh()

        def refresh(self):
            if self._closed or self._updating:
                return
            self._updating = True
            try:
                try:
                    locked = self._foreground() is True
                except Exception:
                    locked = False
                targets = list(panels_provider())
                if compact_provider():
                    targets.append(window)
                current = {}
                for widget in targets:
                    if widget.isVisible():
                        hwnd = int(widget.winId())
                        current[hwnd] = widget
                        applied = self._native.set_click_through(hwnd, locked)
                        if applied:
                            widget.setProperty("gameClickThrough", locked)
                for hwnd, widget in self._handles.items():
                    if hwnd not in current:
                        if self._native.set_click_through(hwnd, False):
                            widget.setProperty("gameClickThrough", False)
                        else:
                            current[hwnd] = widget
                self._handles = current
            except RuntimeError:
                self._native.restore_all()
            finally:
                self._updating = False

        def shutdown(self):
            if not self._closed:
                self._closed = True
                self.timer.stop()
                self._native.restore_all()
                for widget in self._handles.values():
                    try:
                        widget.setProperty("gameClickThrough", False)
                    except RuntimeError:
                        pass
                self._handles.clear()

    return OverlayInput()
