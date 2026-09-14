"""Win32 boundary for the optional loading-screen cover.

Only window metadata and executable paths are queried. Nothing is injected
into SC2 and no process memory is read. Importing this module is portable;
DLLs are loaded only when a backend is constructed on Windows.

All hotkey and window methods must be called on the GUI thread. With Qt,
forward the native MSG pointer to ``consume_native_message`` from a native
event filter: Qt may dequeue a hotkey before a polling timer sees it.
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import logging
import ntpath
import os
import time
from typing import Callable, Optional

log = logging.getLogger(__name__)
HOTKEY_ID = 0x5C29
HOTKEY_MODIFIERS = 0x4000 | 0x0002 | 0x0004  # NOREPEAT, CONTROL, SHIFT
HOTKEY_VK = 0x78  # F9
WM_HOTKEY = 0x0312
WS_CAPTION = 0x00C00000
WS_THICKFRAME = 0x00040000
WS_CHILD = 0x40000000


@dataclass(frozen=True)
class NativeGameWindow:
    hwnd: int
    x: int
    y: int
    width: int
    height: int
    foreground: bool
    minimized: bool
    supported: bool
    display_mode: str = "unknown"
    dpi: int = 96
    monitor_x: int = 0
    monitor_y: int = 0
    monitor_width: int = 0
    monitor_height: int = 0


def is_sc2_executable(path: str) -> bool:
    """Match executable metadata, never a window title.

    This excludes unrelated windows titled 'StarCraft II'. It is not a
    signature/authenticity check of a deliberately renamed executable.
    """
    return bool(path) and ntpath.basename(path).casefold() in {"sc2.exe", "sc2_x64.exe"}


def classify_display_mode(style: int, rect: tuple[int, int, int, int],
                          monitor: tuple[int, int, int, int]) -> tuple[bool, str]:
    """Conservative geometry heuristic, not exclusive-fullscreen detection.

    Full-monitor borderless windows and exclusive fullscreen can look the
    same here. The UI must obtain a borderless-mode confirmation/preview
    for ``fullscreen-unverified`` rather than promising coverage.
    """
    x, y, width, height = rect
    if width <= 0 or height <= 0 or style & WS_CHILD:
        return False, "unavailable"
    mx, my, mw, mh = monitor
    fills_monitor = mw > 0 and mh > 0 and x <= mx and y <= my and x + width >= mx + mw and y + height >= my + mh
    if fills_monitor and not style & (WS_CAPTION | WS_THICKFRAME):
        return False, "fullscreen-unverified"
    return True, "windowed"


class BlindWindowsBackend:
    """Small injectable facade. Missing OS access is a soft failure."""

    def __init__(self, api=None, clock: Callable[[], float] = time.monotonic):
        self._api = api
        if self._api is None and os.name == "nt":
            try:
                self._api = _Win32Api(clock=clock)
            except (OSError, AttributeError):
                log.warning("blind_windows_unavailable", exc_info=True)
        self._clock = clock
        self._cached_hwnd = 0
        self._next_enumeration = 0.0
        self._hotkey_hwnd: Optional[int] = None

    @property
    def available(self) -> bool:
        return self._api is not None

    def find_game_window(self) -> Optional[NativeGameWindow]:
        if self._api is None:
            return None
        try:
            foreground = self._api.foreground_window()
            # Prefer the game actually being played if multiple SC2 clients exist.
            if foreground:
                current = self._api.inspect_window(foreground, foreground)
                if current is not None:
                    self._cached_hwnd = current.hwnd
                    return current
            if self._cached_hwnd:
                current = self._api.inspect_window(self._cached_hwnd, foreground)
                if current is not None:
                    return current
                self._cached_hwnd = 0
            now = self._clock()
            if now < self._next_enumeration:
                return None
            self._next_enumeration = now + 1.0
            for hwnd in self._api.enumerate_windows():
                current = self._api.inspect_window(hwnd, foreground)
                if current is not None:
                    self._cached_hwnd = current.hwnd
                    return current
        except (OSError, ValueError):
            log.debug("blind_windows_probe_failed", exc_info=True)
        return None

    def register_hotkey(self, hwnd: int = 0) -> bool:
        if self._api is None:
            return False
        if self._hotkey_hwnd == hwnd:
            return True
        self.unregister_hotkey()
        if self._api.register_hotkey(hwnd):
            self._hotkey_hwnd = hwnd
            return True
        return False

    def unregister_hotkey(self) -> None:
        if self._api is not None and self._hotkey_hwnd is not None:
            self._api.unregister_hotkey(self._hotkey_hwnd)
            self._hotkey_hwnd = None

    def poll_hotkey(self) -> bool:
        return bool(self._api is not None and self._hotkey_hwnd is not None
                    and self._api.poll_hotkey(self._hotkey_hwnd))

    def consume_native_message(self, message_address: int) -> bool:
        return bool(self._api is not None and self._hotkey_hwnd is not None
                    and message_address and self._api.matches_native_message(
                        int(message_address), self._hotkey_hwnd))

    def position_overlay(self, hwnd: int, x: int, y: int, width: int, height: int,
                         *, show: bool = True) -> bool:
        if self._api is None or not hwnd or width <= 0 or height <= 0:
            return False
        return self._api.position_overlay(hwnd, x, y, width, height, show=show)

    def position_editor(self, hwnd: int, x: int, y: int, width: int, height: int) -> bool:
        """Prepare a hidden calibration window without changing input styles."""
        if self._api is None or not hwnd or width <= 0 or height <= 0:
            return False
        return self._api.position_editor(hwnd, x, y, width, height)

    def hide_overlay(self, hwnd: int) -> None:
        if self._api is not None and hwnd:
            self._api.hide_overlay(hwnd)

    def close(self) -> None:
        self.unregister_hotkey()
        self._cached_hwnd = 0


class _Win32Api:
    def __init__(self, clock: Callable[[], float] = time.monotonic):
        import ctypes as c
        from ctypes import wintypes as w

        self.c, self.w = c, w
        self._clock = clock
        self._path_cache: dict[int, tuple[int, float, str]] = {}
        self.user = c.WinDLL("user32", use_last_error=True)
        self.kernel = c.WinDLL("kernel32", use_last_error=True)
        self._enum_proc = c.WINFUNCTYPE(w.BOOL, w.HWND, c.c_ssize_t)

        class MonitorInfo(c.Structure):
            _fields_ = [("cbSize", w.DWORD), ("rcMonitor", w.RECT),
                        ("rcWork", w.RECT), ("dwFlags", w.DWORD)]

        class Message(c.Structure):
            _fields_ = [("hwnd", w.HWND), ("message", w.UINT),
                        ("wParam", c.c_size_t), ("lParam", c.c_ssize_t),
                        ("time", w.DWORD), ("pt", w.POINT), ("lPrivate", w.DWORD)]

        self.MonitorInfo, self.Message = MonitorInfo, Message

        def bind(dll, name, args, result):
            fn = getattr(dll, name)
            fn.argtypes, fn.restype = args, result
            return fn

        bind(self.user, "GetForegroundWindow", [], w.HWND)
        bind(self.user, "EnumWindows", [self._enum_proc, c.c_ssize_t], w.BOOL)
        bind(self.user, "IsWindowVisible", [w.HWND], w.BOOL)
        bind(self.user, "IsIconic", [w.HWND], w.BOOL)
        bind(self.user, "GetWindowThreadProcessId", [w.HWND, c.POINTER(w.DWORD)], w.DWORD)
        bind(self.user, "GetClientRect", [w.HWND, c.POINTER(w.RECT)], w.BOOL)
        bind(self.user, "ClientToScreen", [w.HWND, c.POINTER(w.POINT)], w.BOOL)
        bind(self.user, "MonitorFromWindow", [w.HWND, w.DWORD], w.HANDLE)
        bind(self.user, "GetMonitorInfoW", [w.HANDLE, c.POINTER(MonitorInfo)], w.BOOL)
        # Get/SetWindowLongPtr are macros mapping to Long on 32-bit Windows.
        suffix = "PtrW" if c.sizeof(c.c_void_p) == 8 else "W"
        self.get_long = bind(self.user, "GetWindowLong" + suffix, [w.HWND, c.c_int], c.c_ssize_t)
        self.set_long = bind(self.user, "SetWindowLong" + suffix, [w.HWND, c.c_int, c.c_ssize_t], c.c_ssize_t)
        bind(self.user, "SetWindowPos", [w.HWND, w.HWND, c.c_int, c.c_int, c.c_int, c.c_int, w.UINT], w.BOOL)
        bind(self.user, "ShowWindow", [w.HWND, c.c_int], w.BOOL)
        bind(self.user, "RegisterHotKey", [w.HWND, c.c_int, w.UINT, w.UINT], w.BOOL)
        bind(self.user, "UnregisterHotKey", [w.HWND, c.c_int], w.BOOL)
        bind(self.user, "PeekMessageW", [c.POINTER(Message), w.HWND, w.UINT, w.UINT, w.UINT], w.BOOL)
        bind(self.kernel, "OpenProcess", [w.DWORD, w.BOOL, w.DWORD], w.HANDLE)
        bind(self.kernel, "GetCurrentProcessId", [], w.DWORD)
        bind(self.kernel, "QueryFullProcessImageNameW", [w.HANDLE, w.DWORD, w.LPWSTR, c.POINTER(w.DWORD)], w.BOOL)
        bind(self.kernel, "CloseHandle", [w.HANDLE], w.BOOL)
        self.set_dpi = None
        self.get_dpi = None
        if hasattr(self.user, "SetThreadDpiAwarenessContext"):
            self.set_dpi = bind(self.user, "SetThreadDpiAwarenessContext", [w.HANDLE], w.HANDLE)
        if hasattr(self.user, "GetDpiForWindow"):
            self.get_dpi = bind(self.user, "GetDpiForWindow", [w.HWND], w.UINT)

    @contextmanager
    def _physical_coordinates(self):
        # Thread-local scope avoids changing Qt's process DPI policy. Restore
        # even on an API failure. -4 is PER_MONITOR_AWARE_V2; -3 is V1.
        previous = None
        if self.set_dpi:
            previous = self.set_dpi(-4) or self.set_dpi(-3)
        try:
            yield bool(previous)
        finally:
            if previous:
                self.set_dpi(previous)

    def foreground_window(self) -> int:
        return int(self.user.GetForegroundWindow() or 0)

    def enumerate_windows(self) -> list[int]:
        result = []

        @self._enum_proc
        def collect(hwnd, _):
            if self.user.IsWindowVisible(hwnd):
                result.append(int(hwnd))
            return True

        self.user.EnumWindows(collect, 0)
        return result

    def _executable_path(self, hwnd: int) -> str:
        pid = self.w.DWORD()
        if not self.user.GetWindowThreadProcessId(hwnd, self.c.byref(pid)):
            self._path_cache.pop(hwnd, None)
            return ""
        now = self._clock()
        cached = self._path_cache.get(hwnd)
        # PID is still checked on every sample: a reused HWND must not inherit
        # a prior process's identity. Cache successful and denied metadata for
        # at most one second instead of reopening processes every GUI tick.
        if cached is not None and cached[0] == pid.value and now < cached[1]:
            return cached[2]
        path = self._query_executable_path(pid.value)
        if len(self._path_cache) >= 256:
            self._path_cache.clear()
        self._path_cache[hwnd] = (pid.value, now + 1.0, path)
        return path

    def _query_executable_path(self, pid: int) -> str:
        process = self.kernel.OpenProcess(0x1000, False, pid)
        if not process:
            return ""
        try:
            capacity = self.w.DWORD(32768)
            buffer = self.c.create_unicode_buffer(capacity.value)
            if self.kernel.QueryFullProcessImageNameW(process, 0, buffer, self.c.byref(capacity)):
                return buffer.value
            return ""
        finally:
            self.kernel.CloseHandle(process)

    def inspect_window(self, hwnd: int, foreground: int) -> Optional[NativeGameWindow]:
        if not self.user.IsWindowVisible(hwnd) or not is_sc2_executable(self._executable_path(hwnd)):
            return None
        minimized = bool(self.user.IsIconic(hwnd))
        with self._physical_coordinates() as physical:
            client = self.w.RECT()
            origin = self.w.POINT()
            if not self.user.GetClientRect(hwnd, self.c.byref(client)) or not self.user.ClientToScreen(hwnd, self.c.byref(origin)):
                return None
            geometry = (origin.x, origin.y, client.right - client.left, client.bottom - client.top)
            info = self.MonitorInfo()
            info.cbSize = self.c.sizeof(info)
            monitor = (0, 0, 0, 0)
            handle = self.user.MonitorFromWindow(hwnd, 2)  # MONITOR_DEFAULTTONEAREST
            if handle and self.user.GetMonitorInfoW(handle, self.c.byref(info)):
                rect = info.rcMonitor
                monitor = (rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top)
            supported, mode = classify_display_mode(self.get_long(hwnd, -16), geometry, monitor)
            if not physical:
                supported, mode = False, "dpi-unverified"
            if not monitor[2] or not monitor[3]:
                supported, mode = False, "monitor-unavailable"
            dpi = int(self.get_dpi(hwnd) or 96) if self.get_dpi else 96
        return NativeGameWindow(hwnd, *geometry, hwnd == foreground, minimized,
                                supported and not minimized, mode, dpi, *monitor)

    def register_hotkey(self, hwnd: int) -> bool:
        return bool(self.user.RegisterHotKey(hwnd or None, HOTKEY_ID, HOTKEY_MODIFIERS, HOTKEY_VK))

    def unregister_hotkey(self, hwnd: int) -> None:
        self.user.UnregisterHotKey(hwnd or None, HOTKEY_ID)

    def _matches_message(self, message, hwnd: int) -> bool:
        return (message.message == WM_HOTKEY and message.wParam == HOTKEY_ID
                and int(message.hwnd or 0) == hwnd)

    def matches_native_message(self, address: int, hwnd: int) -> bool:
        # Only call with a valid MSG pointer supplied by Qt's native filter.
        return self._matches_message(self.Message.from_address(address), hwnd)

    def poll_hotkey(self, hwnd: int) -> bool:
        message = self.Message()
        # -1 requests thread-only messages for a thread registration. Inspect
        # before removing so we never consume another feature's hotkey.
        target = hwnd or -1
        if not self.user.PeekMessageW(self.c.byref(message), target, WM_HOTKEY, WM_HOTKEY, 0):
            return False
        if not self._matches_message(message, hwnd):
            return False
        return bool(self.user.PeekMessageW(self.c.byref(message), target, WM_HOTKEY, WM_HOTKEY, 1))

    def position_overlay(self, hwnd: int, x: int, y: int, width: int, height: int,
                         *, show: bool = True) -> bool:
        # Refuse accidental mutation of SC2 or any other process's window.
        if not self._is_own_window(hwnd):
            return False
        style = self.get_long(hwnd, -20)
        flags = 0x08000000 | 0x00000080 | 0x00000020  # NOACTIVATE, TOOLWINDOW, TRANSPARENT
        changed = style & flags != flags
        if changed:
            self.c.set_last_error(0)
            if not self.set_long(hwnd, -20, style | flags) and self.c.get_last_error():
                return False
        with self._physical_coordinates() as physical:
            if not physical:
                return False
            position_flags = 0x0010  # SWP_NOACTIVATE
            if show:
                position_flags |= 0x0040  # SWP_SHOWWINDOW
            if changed:
                position_flags |= 0x0020  # SWP_FRAMECHANGED
            return bool(self.user.SetWindowPos(hwnd, -1, x, y, width, height, position_flags))

    def position_editor(self, hwnd: int, x: int, y: int, width: int, height: int) -> bool:
        if not self._is_own_window(hwnd):
            return False
        with self._physical_coordinates() as physical:
            return bool(physical and self.user.SetWindowPos(
                hwnd, -1, x, y, width, height, 0x0010))  # NOACTIVATE, no SHOWWINDOW

    def hide_overlay(self, hwnd: int) -> None:
        if self._is_own_window(hwnd):
            self.user.ShowWindow(hwnd, 0)  # SW_HIDE; never activates another window

    def _is_own_window(self, hwnd: int) -> bool:
        pid = self.w.DWORD()
        return bool(self.user.GetWindowThreadProcessId(hwnd, self.c.byref(pid))
                    and pid.value == self.kernel.GetCurrentProcessId())
