"""Win32 helpers for the build check-in cards.

The cards float over StarCraft II, so on Windows they need a few things
Qt does not offer:

* **Capture exclusion** — ``SetWindowDisplayAffinity`` keeps a card off
  stream (OBS display/window capture and screenshots skip it). Windows
  10 2004+ supports ``WDA_EXCLUDEFROMCAPTURE``; older builds fall back to
  ``WDA_MONITOR`` (captured as black). Failures are ignored.
* **Topmost re-assert** — SC2 can raise itself over a topmost tool
  window, so a visible card re-applies ``HWND_TOPMOST`` without
  activating itself.
* **Finding SC2** — the window and monitor of the game, identified by
  process image (``SC2_x64.exe`` / ``SC2.exe``), to place the cards on
  the screen the player is looking at.
* **Handing focus back** — after the player typed into the end card,
  focus returns to SC2 only when the card is still the foreground
  window and the window it took focus from is verifiably SC2.

Every helper is a no-op returning ``None`` / ``False`` off Windows, and
never raises: a failed call costs a feature, never the agent. All
``ctypes`` entry points get explicit ``argtypes`` / ``restype`` (the
pattern in ``instance_lock.py``) so handles are not truncated on 64-bit.
"""

from __future__ import annotations

import logging
import ntpath
import sys
import threading
from typing import Any, Callable, Dict, List, NamedTuple, Optional, Tuple

log = logging.getLogger(__name__)

IS_WINDOWS = sys.platform == "win32"

WDA_MONITOR = 0x00000001
WDA_EXCLUDEFROMCAPTURE = 0x00000011

HWND_TOPMOST = -1
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOACTIVATE = 0x0010
TOPMOST_FLAGS = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
MONITOR_DEFAULTTONEAREST = 0x00000002

SC2_IMAGE_NAMES = frozenset({"sc2_x64.exe", "sc2.exe"})
"""Process images of the StarCraft II game client (casefolded)."""

Rect = Tuple[int, int, int, int]
"""``(left, top, right, bottom)`` in physical pixels."""


class MonitorInfo(NamedTuple):
    """The monitor a window is on, as Win32 reports it."""

    device: str
    """GDI device name, e.g. ``\\\\.\\DISPLAY1``."""
    bounds: Rect
    work: Rect


class _Win32Api:
    """The user32/kernel32 calls the helpers need, typed once.

    Each method returns plain Python values so the helpers above it can
    be exercised with a fake on any platform.
    """

    def __init__(self) -> None:
        import ctypes
        from ctypes import wintypes

        self._ctypes = ctypes
        self._wintypes = wintypes
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

        class MONITORINFOEXW(ctypes.Structure):  # noqa: N801 — Win32 name
            _fields_ = [
                ("cbSize", wintypes.DWORD),
                ("rcMonitor", wintypes.RECT),
                ("rcWork", wintypes.RECT),
                ("dwFlags", wintypes.DWORD),
                ("szDevice", wintypes.WCHAR * 32),
            ]

        self._monitor_info_type = MONITORINFOEXW
        self._enum_proc_type = ctypes.WINFUNCTYPE(
            wintypes.BOOL, wintypes.HWND, wintypes.LPARAM,
        )

        self._set_affinity = user32.SetWindowDisplayAffinity
        self._set_affinity.argtypes = [wintypes.HWND, wintypes.DWORD]
        self._set_affinity.restype = wintypes.BOOL

        self._set_window_pos = user32.SetWindowPos
        self._set_window_pos.argtypes = [
            wintypes.HWND, wintypes.HWND,
            ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
            wintypes.UINT,
        ]
        self._set_window_pos.restype = wintypes.BOOL

        self._get_foreground = user32.GetForegroundWindow
        self._get_foreground.argtypes = []
        self._get_foreground.restype = wintypes.HWND

        self._set_foreground = user32.SetForegroundWindow
        self._set_foreground.argtypes = [wintypes.HWND]
        self._set_foreground.restype = wintypes.BOOL

        self._is_window = user32.IsWindow
        self._is_window.argtypes = [wintypes.HWND]
        self._is_window.restype = wintypes.BOOL

        self._is_visible = user32.IsWindowVisible
        self._is_visible.argtypes = [wintypes.HWND]
        self._is_visible.restype = wintypes.BOOL

        self._thread_process_id = user32.GetWindowThreadProcessId
        self._thread_process_id.argtypes = [
            wintypes.HWND, ctypes.POINTER(wintypes.DWORD),
        ]
        self._thread_process_id.restype = wintypes.DWORD

        self._enum_windows = user32.EnumWindows
        self._enum_windows.argtypes = [self._enum_proc_type, wintypes.LPARAM]
        self._enum_windows.restype = wintypes.BOOL

        self._monitor_from_window = user32.MonitorFromWindow
        self._monitor_from_window.argtypes = [wintypes.HWND, wintypes.DWORD]
        self._monitor_from_window.restype = wintypes.HMONITOR

        self._get_monitor_info = user32.GetMonitorInfoW
        self._get_monitor_info.argtypes = [
            wintypes.HMONITOR, ctypes.POINTER(MONITORINFOEXW),
        ]
        self._get_monitor_info.restype = wintypes.BOOL

        self._open_process = kernel32.OpenProcess
        self._open_process.argtypes = [
            wintypes.DWORD, wintypes.BOOL, wintypes.DWORD,
        ]
        self._open_process.restype = wintypes.HANDLE

        self._query_image = kernel32.QueryFullProcessImageNameW
        self._query_image.argtypes = [
            wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR,
            ctypes.POINTER(wintypes.DWORD),
        ]
        self._query_image.restype = wintypes.BOOL

        self._close_handle = kernel32.CloseHandle
        self._close_handle.argtypes = [wintypes.HANDLE]
        self._close_handle.restype = wintypes.BOOL

    def set_display_affinity(self, hwnd: int, affinity: int) -> bool:
        return bool(self._set_affinity(hwnd, affinity))

    def set_topmost(self, hwnd: int) -> bool:
        return bool(self._set_window_pos(
            hwnd, HWND_TOPMOST, 0, 0, 0, 0, TOPMOST_FLAGS,
        ))

    def foreground_window(self) -> int:
        return int(self._get_foreground() or 0)

    def set_foreground_window(self, hwnd: int) -> bool:
        return bool(self._set_foreground(hwnd))

    def is_window(self, hwnd: int) -> bool:
        return bool(self._is_window(hwnd))

    def process_id(self, hwnd: int) -> int:
        pid = self._wintypes.DWORD(0)
        self._thread_process_id(hwnd, self._ctypes.byref(pid))
        return int(pid.value)

    def process_image(self, pid: int) -> Optional[str]:
        handle = self._open_process(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return None
        try:
            size = self._wintypes.DWORD(1024)
            buffer = self._ctypes.create_unicode_buffer(size.value)
            if not self._query_image(handle, 0, buffer, self._ctypes.byref(size)):
                return None
            return buffer.value or None
        finally:
            self._close_handle(handle)

    def visible_windows(self) -> List[int]:
        found: List[int] = []

        def collect(hwnd: Any, _lparam: Any) -> bool:
            if hwnd and self._is_visible(hwnd):
                found.append(int(hwnd))
            return True

        # Keep the callback object alive for the duration of the call.
        callback = self._enum_proc_type(collect)
        self._enum_windows(callback, 0)
        return found

    def monitor_info(self, hwnd: int) -> Optional[MonitorInfo]:
        monitor = self._monitor_from_window(hwnd, MONITOR_DEFAULTTONEAREST)
        if not monitor:
            return None
        info = self._monitor_info_type()
        info.cbSize = self._ctypes.sizeof(self._monitor_info_type)
        if not self._get_monitor_info(monitor, self._ctypes.byref(info)):
            return None
        bounds, work = info.rcMonitor, info.rcWork
        return MonitorInfo(
            device=str(info.szDevice),
            bounds=(bounds.left, bounds.top, bounds.right, bounds.bottom),
            work=(work.left, work.top, work.right, work.bottom),
        )


_api_lock = threading.Lock()
_api_cache: Dict[str, Optional[_Win32Api]] = {}


def _api() -> Optional[_Win32Api]:
    """The typed Win32 surface, or ``None`` off Windows / when unavailable."""
    if not IS_WINDOWS:
        return None
    with _api_lock:
        if "api" not in _api_cache:
            try:
                _api_cache["api"] = _Win32Api()
            except Exception:  # noqa: BLE001
                log.debug("win32_window_api_unavailable", exc_info=True)
                _api_cache["api"] = None
        return _api_cache["api"]


def _safely(name: str, fn: Callable[[_Win32Api], Any], default: Any) -> Any:
    api = _api()
    if api is None:
        return default
    try:
        return fn(api)
    except Exception:  # noqa: BLE001
        log.debug("win32_window_call_failed call=%s", name, exc_info=True)
        return default


def exclude_from_capture(hwnd: Optional[int]) -> Optional[int]:
    """Keep ``hwnd`` out of screen capture.

    Returns the affinity that took (``WDA_EXCLUDEFROMCAPTURE`` or the
    ``WDA_MONITOR`` fallback), or ``None`` when neither did.
    """
    if not hwnd:
        return None

    def apply(api: _Win32Api) -> Optional[int]:
        for affinity in (WDA_EXCLUDEFROMCAPTURE, WDA_MONITOR):
            try:
                if api.set_display_affinity(hwnd, affinity):
                    return affinity
            except Exception:  # noqa: BLE001
                log.debug("win32_window_affinity_failed", exc_info=True)
        return None

    return _safely("exclude_from_capture", apply, None)


def keep_topmost(hwnd: Optional[int]) -> bool:
    """Re-assert ``HWND_TOPMOST`` without moving, sizing or activating."""
    if not hwnd:
        return False
    return bool(_safely("keep_topmost", lambda api: api.set_topmost(hwnd), False))


def foreground_window() -> Optional[int]:
    """The window that currently has the user's input, if any."""
    return _safely("foreground_window", lambda api: api.foreground_window(), 0) or None


def _image_is_sc2(image: Optional[str]) -> bool:
    return bool(image) and ntpath.basename(image).casefold() in SC2_IMAGE_NAMES


def is_sc2_window(hwnd: Optional[int]) -> bool:
    """``hwnd`` is a live window owned by the StarCraft II client."""
    if not hwnd:
        return False

    def check(api: _Win32Api) -> bool:
        if not api.is_window(hwnd):
            return False
        pid = api.process_id(hwnd)
        return bool(pid) and _image_is_sc2(api.process_image(pid))

    return bool(_safely("is_sc2_window", check, False))


def find_sc2_window() -> Optional[int]:
    """The StarCraft II game window: the foreground window when it is
    SC2, else the first visible top-level window of an SC2 process."""

    def find(api: _Win32Api) -> Optional[int]:
        foreground = api.foreground_window()
        verdicts: Dict[int, bool] = {}

        def owned_by_sc2(hwnd: int) -> bool:
            pid = api.process_id(hwnd)
            if not pid:
                return False
            if pid not in verdicts:
                verdicts[pid] = _image_is_sc2(api.process_image(pid))
            return verdicts[pid]

        if foreground and owned_by_sc2(foreground):
            return foreground
        for hwnd in api.visible_windows():
            if owned_by_sc2(hwnd):
                return hwnd
        return None

    return _safely("find_sc2_window", find, None)


def monitor_of_window(hwnd: Optional[int]) -> Optional[MonitorInfo]:
    """The monitor ``hwnd`` is (mostly) on."""
    if not hwnd:
        return None
    return _safely("monitor_of_window", lambda api: api.monitor_info(hwnd), None)


def restore_foreground(own_hwnd: Optional[int], previous_hwnd: Optional[int]) -> bool:
    """Give focus back to SC2 after the player typed into a card.

    Only when the card (``own_hwnd``) is still the foreground window and
    ``previous_hwnd`` — the window it took focus from — is verifiably
    the StarCraft II client. Anything else is left alone.
    """
    if not own_hwnd or not previous_hwnd or own_hwnd == previous_hwnd:
        return False

    def restore(api: _Win32Api) -> bool:
        if api.foreground_window() != own_hwnd:
            return False
        if not api.is_window(previous_hwnd):
            return False
        pid = api.process_id(previous_hwnd)
        if not pid or not _image_is_sc2(api.process_image(pid)):
            return False
        return api.set_foreground_window(previous_hwnd)

    return bool(_safely("restore_foreground", restore, False))


__all__ = [
    "IS_WINDOWS",
    "MonitorInfo",
    "SC2_IMAGE_NAMES",
    "TOPMOST_FLAGS",
    "WDA_EXCLUDEFROMCAPTURE",
    "WDA_MONITOR",
    "exclude_from_capture",
    "find_sc2_window",
    "foreground_window",
    "is_sc2_window",
    "keep_topmost",
    "monitor_of_window",
    "restore_foreground",
]
