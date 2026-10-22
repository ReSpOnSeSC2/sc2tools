"""Win32 helpers for the build check-in cards (``ui/win32_window.py``).

Off Windows every helper is a silent no-op. The policy above the raw
calls (affinity fallback, SC2 verification before handing focus back,
SC2 window lookup) runs against a fake API on every platform, and a
failing or raising call never escapes. On Windows a smoke test drives
the real ``ctypes`` bindings with handles that cannot succeed.
"""

from __future__ import annotations

import sys
from typing import Dict, List, Optional

import pytest

from sc2tools_agent.ui import win32_window as w32

SC2 = r"C:\Program Files (x86)\StarCraft II\Versions\Base93333\SC2_x64.exe"


class FakeApi:
    """Plain-value stand-in for ``_Win32Api``."""

    def __init__(self) -> None:
        self.affinity_ok: Dict[int, bool] = {
            w32.WDA_EXCLUDEFROMCAPTURE: True, w32.WDA_MONITOR: True,
        }
        self.affinity_calls: List[tuple] = []
        self.topmost_calls: List[int] = []
        self.foreground = 0
        self.focused: List[int] = []
        self.windows: Dict[int, int] = {}  # hwnd → pid
        self.images: Dict[int, Optional[str]] = {}  # pid → image
        self.visible: List[int] = []
        self.image_lookups: List[int] = []
        self.raise_on: Optional[str] = None

    def _maybe_raise(self, name: str) -> None:
        if self.raise_on == name:
            raise OSError(f"{name} failed")

    def set_display_affinity(self, hwnd: int, affinity: int) -> bool:
        self.affinity_calls.append((hwnd, affinity))
        self._maybe_raise("set_display_affinity")
        return self.affinity_ok.get(affinity, False)

    def set_topmost(self, hwnd: int) -> bool:
        self.topmost_calls.append(hwnd)
        self._maybe_raise("set_topmost")
        return True

    def foreground_window(self) -> int:
        self._maybe_raise("foreground_window")
        return self.foreground

    def set_foreground_window(self, hwnd: int) -> bool:
        self._maybe_raise("set_foreground_window")
        self.focused.append(hwnd)
        return True

    def is_window(self, hwnd: int) -> bool:
        return hwnd in self.windows

    def process_id(self, hwnd: int) -> int:
        return self.windows.get(hwnd, 0)

    def process_image(self, pid: int) -> Optional[str]:
        self.image_lookups.append(pid)
        self._maybe_raise("process_image")
        return self.images.get(pid)

    def visible_windows(self) -> List[int]:
        self._maybe_raise("visible_windows")
        return list(self.visible)

    def monitor_info(self, hwnd: int) -> Optional[w32.MonitorInfo]:
        self._maybe_raise("monitor_info")
        return w32.MonitorInfo("\\\\.\\DISPLAY2", (1920, 0, 4480, 1440), (1920, 0, 4480, 1400))


@pytest.fixture
def api(monkeypatch: pytest.MonkeyPatch) -> FakeApi:
    fake = FakeApi()
    monkeypatch.setattr(w32, "_api", lambda: fake)
    return fake


# --------------------------------------------------------------- off Windows


def test_every_helper_is_a_noop_without_the_win32_api(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(w32, "_api", lambda: None)
    assert w32.exclude_from_capture(100) is None
    assert w32.keep_topmost(100) is False
    assert w32.foreground_window() is None
    assert w32.is_sc2_window(100) is False
    assert w32.find_sc2_window() is None
    assert w32.monitor_of_window(100) is None
    assert w32.restore_foreground(100, 200) is False


@pytest.mark.skipif(sys.platform == "win32", reason="checks the non-Windows path")
def test_api_is_never_loaded_off_windows(monkeypatch: pytest.MonkeyPatch) -> None:
    def explode() -> None:
        raise AssertionError("ctypes bindings must not load off Windows")

    monkeypatch.setattr(w32, "_Win32Api", explode)
    assert w32.IS_WINDOWS is False
    assert w32._api() is None
    assert w32.exclude_from_capture(1) is None
    assert w32.keep_topmost(1) is False


def test_failed_binding_is_cached_as_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    attempts = []

    def broken() -> None:
        attempts.append(1)
        raise OSError("user32 missing")

    monkeypatch.setattr(w32, "IS_WINDOWS", True)
    monkeypatch.setattr(w32, "_Win32Api", broken)
    monkeypatch.setattr(w32, "_api_cache", {})
    assert w32._api() is None
    assert w32._api() is None
    assert attempts == [1]
    assert w32.keep_topmost(5) is False
    assert w32.exclude_from_capture(5) is None


def test_null_handles_short_circuit(api: FakeApi) -> None:
    assert w32.exclude_from_capture(None) is None
    assert w32.exclude_from_capture(0) is None
    assert w32.keep_topmost(None) is False
    assert w32.monitor_of_window(0) is None
    assert w32.is_sc2_window(None) is False
    assert w32.restore_foreground(None, 5) is False
    assert w32.restore_foreground(5, None) is False
    assert w32.restore_foreground(5, 5) is False
    assert api.affinity_calls == [] and api.topmost_calls == []


# ------------------------------------------------------------ capture/topmost


def test_capture_exclusion_prefers_exclude_from_capture(api: FakeApi) -> None:
    assert w32.exclude_from_capture(42) == w32.WDA_EXCLUDEFROMCAPTURE
    assert api.affinity_calls == [(42, w32.WDA_EXCLUDEFROMCAPTURE)]


def test_capture_exclusion_falls_back_to_monitor(api: FakeApi) -> None:
    api.affinity_ok[w32.WDA_EXCLUDEFROMCAPTURE] = False  # Windows before 10 2004
    assert w32.exclude_from_capture(42) == w32.WDA_MONITOR
    assert api.affinity_calls == [
        (42, w32.WDA_EXCLUDEFROMCAPTURE), (42, w32.WDA_MONITOR),
    ]


def test_capture_exclusion_failures_are_ignored(api: FakeApi) -> None:
    api.affinity_ok = {}
    assert w32.exclude_from_capture(42) is None
    api.raise_on = "set_display_affinity"
    assert w32.exclude_from_capture(42) is None


def test_keep_topmost_reasserts_and_swallows_errors(api: FakeApi) -> None:
    assert w32.keep_topmost(7) is True
    assert api.topmost_calls == [7]
    api.raise_on = "set_topmost"
    assert w32.keep_topmost(7) is False


def test_topmost_flags_never_activate_move_or_resize() -> None:
    assert w32.TOPMOST_FLAGS == w32.SWP_NOMOVE | w32.SWP_NOSIZE | w32.SWP_NOACTIVATE


# ---------------------------------------------------------------- SC2 lookup


def test_sc2_window_is_identified_by_process_image(api: FakeApi) -> None:
    api.windows = {10: 1, 11: 2, 12: 3}
    api.images = {1: SC2, 2: r"C:\Windows\explorer.exe", 3: r"D:\Games\SC2.EXE"}
    assert w32.is_sc2_window(10) is True
    assert w32.is_sc2_window(11) is False
    assert w32.is_sc2_window(12) is True
    assert w32.is_sc2_window(99) is False  # not a window any more


def test_sc2_lookup_survives_unreadable_processes(api: FakeApi) -> None:
    api.windows = {10: 1}
    api.images = {1: None}  # access denied
    assert w32.is_sc2_window(10) is False
    api.raise_on = "process_image"
    assert w32.is_sc2_window(10) is False


def test_find_prefers_the_foreground_sc2_window(api: FakeApi) -> None:
    api.windows = {10: 1, 20: 1}
    api.images = {1: SC2}
    api.foreground = 20
    api.visible = [10, 20]
    assert w32.find_sc2_window() == 20


def test_find_scans_visible_windows_once_per_process(api: FakeApi) -> None:
    api.windows = {1: 7, 2: 7, 3: 8, 4: 9}
    api.images = {7: r"C:\Windows\explorer.exe", 8: r"C:\Tools\obs64.exe", 9: SC2}
    api.foreground = 1
    api.visible = [1, 2, 3, 4]
    assert w32.find_sc2_window() == 4
    assert sorted(api.image_lookups) == [7, 8, 9]


def test_find_returns_none_without_sc2_or_on_errors(api: FakeApi) -> None:
    api.windows = {1: 7}
    api.images = {7: r"C:\Windows\explorer.exe"}
    api.visible = [1]
    assert w32.find_sc2_window() is None
    api.raise_on = "visible_windows"
    assert w32.find_sc2_window() is None


def test_monitor_of_window_passes_through_and_swallows_errors(api: FakeApi) -> None:
    info = w32.monitor_of_window(10)
    assert info is not None and info.device.endswith("DISPLAY2")
    assert info.bounds == (1920, 0, 4480, 1440)
    api.raise_on = "monitor_info"
    assert w32.monitor_of_window(10) is None


# -------------------------------------------------------------- hand back focus


def test_focus_returns_to_sc2_when_the_card_is_foreground(api: FakeApi) -> None:
    api.windows = {500: 1}
    api.images = {1: SC2}
    api.foreground = 900  # the card
    assert w32.restore_foreground(900, 500) is True
    assert api.focused == [500]


def test_focus_is_left_alone_when_the_card_is_not_foreground(api: FakeApi) -> None:
    api.windows = {500: 1}
    api.images = {1: SC2}
    api.foreground = 333  # the player already moved on
    assert w32.restore_foreground(900, 500) is False
    assert api.focused == []


def test_focus_never_goes_to_a_window_that_is_not_sc2(api: FakeApi) -> None:
    api.windows = {500: 1}
    api.images = {1: r"C:\Program Files\Mozilla Firefox\firefox.exe"}
    api.foreground = 900
    assert w32.restore_foreground(900, 500) is False
    # A closed (or recycled) handle is never focused either.
    api.windows = {}
    assert w32.restore_foreground(900, 500) is False
    assert api.focused == []


def test_focus_restore_swallows_errors(api: FakeApi) -> None:
    api.windows = {500: 1}
    api.images = {1: SC2}
    api.foreground = 900
    api.raise_on = "set_foreground_window"
    assert w32.restore_foreground(900, 500) is False


# ----------------------------------------------------------------- real Win32


@pytest.mark.skipif(sys.platform != "win32", reason="needs the real Win32 API")
def test_real_bindings_fail_safely_on_bogus_handles() -> None:
    assert w32._api() is not None
    bogus = 0x7FFF_FFF0
    assert w32.exclude_from_capture(bogus) is None
    assert w32.keep_topmost(bogus) is False
    assert w32.is_sc2_window(bogus) is False
    assert w32.restore_foreground(bogus, bogus + 1) is False
    foreground = w32.foreground_window()
    assert foreground is None or isinstance(foreground, int)
    found = w32.find_sc2_window()
    assert found is None or isinstance(found, int)
