"""Headless coverage of the Windows boundary; never probes the running game."""

from dataclasses import FrozenInstanceError, replace
from contextlib import nullcontext
import os
from types import SimpleNamespace

import pytest

from sc2tools_agent.ui.blind_windows import (
    BlindWindowsBackend, HOTKEY_ID, HOTKEY_MODIFIERS, HOTKEY_VK,
    NativeGameWindow, WM_HOTKEY, WS_CAPTION, WS_CHILD, _Win32Api,
    classify_display_mode, is_sc2_executable,
)


def game(hwnd=7, **changes):
    return replace(NativeGameWindow(hwnd, -1920, 0, 1280, 720, False, False, True), **changes)


class FakeApi:
    def __init__(self):
        self.foreground = 0
        self.windows = {}
        self.enumerations = 0
        self.registrations = []
        self.unregistrations = []
        self.hotkey_success = True
        self.positions = []

    def foreground_window(self):
        return self.foreground

    def inspect_window(self, hwnd, foreground):
        result = self.windows.get(hwnd)
        return replace(result, foreground=hwnd == foreground) if result else None

    def enumerate_windows(self):
        self.enumerations += 1
        return list(self.windows)

    def register_hotkey(self, hwnd):
        self.registrations.append(hwnd)
        return self.hotkey_success

    def unregister_hotkey(self, hwnd):
        self.unregistrations.append(hwnd)

    def poll_hotkey(self, hwnd):
        return hwnd == 12

    def matches_native_message(self, address, hwnd):
        return (address, hwnd) == (1234, 12)

    def position_overlay(self, *geometry, show=True):
        self.positions.append((*geometry, show))
        return True

    def position_editor(self, *geometry):
        self.positions.append((*geometry, "editor"))
        return True

    def hide_overlay(self, hwnd):
        pass


@pytest.mark.parametrize("path", [r"C:\StarCraft II\Versions\Base999\SC2_x64.exe",
                                       r"D:\Games\SC2.EXE", "SC2_x64.exe"])
def test_executable_metadata_accepts_game_names(path):
    assert is_sc2_executable(path)


@pytest.mark.parametrize("path", ["StarCraft II", r"C:\SC2_x64.exe\chrome.exe",
                                       "SC2_x64.exe.bak", "StarCraft II.exe", "", "SC2Switcher_x64.exe"])
def test_title_or_similar_process_does_not_count_as_game(path):
    assert not is_sc2_executable(path)


def test_snapshot_is_immutable_and_retains_negative_monitor_coordinates():
    snapshot = game()
    assert snapshot.x == -1920
    with pytest.raises(FrozenInstanceError):
        snapshot.x = 0


def test_full_monitor_popup_cannot_certify_borderless_or_exclusive():
    assert classify_display_mode(0x80000000, (-1920, 0, 1920, 1080), (-1920, 0, 1920, 1080)) == (False, "fullscreen-unverified")
    assert classify_display_mode(WS_CAPTION, (-1920, 0, 1920, 1080), (-1920, 0, 1920, 1080)) == (True, "windowed")
    assert classify_display_mode(0x80000000, (100, 100, 1280, 720), (0, 0, 1920, 1080)) == (True, "windowed")


@pytest.mark.parametrize("style,geometry", [(0, (0, 0, 0, 0)), (WS_CHILD, (0, 0, 1280, 720))])
def test_invalid_or_child_window_is_not_coverable(style, geometry):
    assert classify_display_mode(style, geometry, (0, 0, 1920, 1080)) == (False, "unavailable")


def test_discovery_throttles_enumeration_but_tracks_foreground_immediately():
    api = FakeApi()
    now = [10.0]
    backend = BlindWindowsBackend(api, clock=lambda: now[0])
    assert backend.find_game_window() is None
    assert backend.find_game_window() is None
    assert api.enumerations == 1
    api.windows[7] = game()
    api.foreground = 7
    # The newly focused SC2 is found without waiting for a rescan.
    assert backend.find_game_window().foreground is True
    assert api.enumerations == 1
    api.foreground = 99
    assert backend.find_game_window().foreground is False
    assert api.enumerations == 1
    del api.windows[7]
    assert backend.find_game_window() is None
    now[0] = 11.0
    assert backend.find_game_window() is None
    assert api.enumerations == 2


def test_multiple_clients_prefer_the_foreground_game_and_report_minimized():
    api = FakeApi()
    api.windows = {7: game(), 8: game(8)}
    backend = BlindWindowsBackend(api)
    assert backend.find_game_window().hwnd == 7
    api.foreground = 8
    assert backend.find_game_window().hwnd == 8
    api.windows[8] = game(8, minimized=True, supported=False)
    assert backend.find_game_window().minimized is True


def test_failed_probe_returns_none_instead_of_showing_stale_geometry():
    api = FakeApi()
    api.windows[7] = game()
    backend = BlindWindowsBackend(api)
    assert backend.find_game_window() is not None
    api.inspect_window = lambda *_: (_ for _ in ()).throw(OSError("window vanished"))
    assert backend.find_game_window() is None


def test_hotkey_is_idempotent_migrates_window_and_cleans_up():
    api = FakeApi()
    backend = BlindWindowsBackend(api)
    assert backend.register_hotkey()
    assert backend.register_hotkey()
    assert api.registrations == [0]
    assert backend.register_hotkey(12)
    assert api.unregistrations == [0]
    assert backend.poll_hotkey()
    assert backend.consume_native_message(1234)
    assert not backend.consume_native_message(0)
    backend.close()
    backend.close()
    assert api.unregistrations == [0, 12]
    assert not backend.poll_hotkey()
    assert not backend.consume_native_message(1234)


def test_registration_conflict_does_not_pretend_emergency_key_is_available():
    api = FakeApi()
    api.hotkey_success = False
    backend = BlindWindowsBackend(api)
    assert not backend.register_hotkey(12)
    assert not backend.poll_hotkey()
    backend.close()
    assert api.unregistrations == []


def test_overlay_position_uses_physical_rectangle_and_rejects_empty_bounds():
    api = FakeApi()
    backend = BlindWindowsBackend(api)
    assert backend.position_overlay(22, -1920, 30, 1920, 1080)
    assert api.positions == [(22, -1920, 30, 1920, 1080, True)]
    assert not backend.position_overlay(22, 0, 0, 0, 1080)
    assert not backend.position_overlay(0, 0, 0, 1920, 1080)
    assert len(api.positions) == 1


def test_hidden_preparation_passes_through_without_showing():
    api = FakeApi()
    backend = BlindWindowsBackend(api)
    assert backend.position_overlay(22, -1920, 30, 1920, 1080, show=False)
    assert backend.position_editor(23, -1920, 30, 1920, 1080)
    assert not backend.position_editor(0, 0, 0, 100, 100)
    assert not backend.position_editor(23, 0, 0, -1, 100)
    assert api.positions == [(22, -1920, 30, 1920, 1080, False),
                             (23, -1920, 30, 1920, 1080, "editor")]


def test_hotkey_message_requires_our_identifier_and_target_window():
    api = _Win32Api.__new__(_Win32Api)
    message = SimpleNamespace(message=WM_HOTKEY, wParam=HOTKEY_ID, hwnd=7)
    assert api._matches_message(message, 7)
    assert not api._matches_message(message, 8)
    message.wParam += 1
    assert not api._matches_message(message, 7)
    message.wParam = HOTKEY_ID
    message.message = 0x0100
    assert not api._matches_message(message, 7)


def test_bounded_poll_leaves_other_hotkeys_in_queue():
    api = _Win32Api.__new__(_Win32Api)
    api.Message = lambda: SimpleNamespace(message=0, wParam=0, hwnd=0)
    api.c = SimpleNamespace(byref=lambda value: value)
    calls = []
    queued_id = [HOTKEY_ID + 1]

    def peek(message, target, low, high, remove):
        calls.append((target, low, high, remove))
        message.message, message.wParam, message.hwnd = WM_HOTKEY, queued_id[0], None
        return True

    api.user = SimpleNamespace(PeekMessageW=peek)
    assert not api.poll_hotkey(0)
    assert calls == [(-1, WM_HOTKEY, WM_HOTKEY, 0)]
    calls.clear()
    queued_id[0] = HOTKEY_ID
    assert api.poll_hotkey(0)
    assert calls == [(-1, WM_HOTKEY, WM_HOTKEY, 0), (-1, WM_HOTKEY, WM_HOTKEY, 1)]


def test_global_hotkey_uses_control_shift_f9_without_autorepeat():
    assert HOTKEY_MODIFIERS == 0x4006
    assert HOTKEY_VK == 0x78


def test_process_identity_cache_checks_pid_each_tick_and_expires_in_one_second():
    api = _Win32Api.__new__(_Win32Api)
    now, pid = [10.0], [100]
    queries, pid_checks = [], []
    api._clock = lambda: now[0]
    api._path_cache = {}
    api.w = SimpleNamespace(DWORD=lambda: SimpleNamespace(value=0))
    api.c = SimpleNamespace(byref=lambda value: value)

    def get_pid(hwnd, out):
        pid_checks.append(hwnd)
        out.value = pid[0]
        return 1

    api.user = SimpleNamespace(GetWindowThreadProcessId=get_pid)
    api._query_executable_path = lambda process: queries.append(process) or f"C:\\{process}\\SC2.exe"
    assert api._executable_path(7) == r"C:\100\SC2.exe"
    now[0] = 10.05
    assert api._executable_path(7) == r"C:\100\SC2.exe"
    assert queries == [100] and pid_checks == [7, 7]
    pid[0] = 200  # Window handle reused by another process before expiry.
    assert api._executable_path(7) == r"C:\200\SC2.exe"
    assert queries == [100, 200]
    now[0] = 11.05
    assert api._executable_path(7) == r"C:\200\SC2.exe"
    assert queries == [100, 200, 200]
    api.user.GetWindowThreadProcessId = lambda *_: 0
    assert api._executable_path(7) == ""
    assert 7 not in api._path_cache


def test_native_cover_position_does_not_activate_and_refuses_other_processes():
    api = _Win32Api.__new__(_Win32Api)
    api._is_own_window = lambda hwnd: hwnd == 55
    api.get_long = lambda *_: 0
    styles, positions, hidden = [], [], []
    api.set_long = lambda *args: styles.append(args)
    api.c = SimpleNamespace(set_last_error=lambda _: None, get_last_error=lambda: 0)
    api._physical_coordinates = lambda: nullcontext(True)
    api.user = SimpleNamespace(SetWindowPos=lambda *args: positions.append(args) or True,
                               ShowWindow=lambda *args: hidden.append(args))
    assert not api.position_overlay(99, 0, 0, 500, 500)
    api.hide_overlay(99)
    assert styles == positions == hidden == []
    assert api.position_overlay(55, -1920, 10, 1920, 1080)
    assert styles == [(55, -20, 0x080000A0)]
    assert positions == [(55, -1, -1920, 10, 1920, 1080, 0x0070)]
    assert api.position_overlay(55, -1920, 10, 1920, 1080, show=False)
    assert positions[-1] == (55, -1, -1920, 10, 1920, 1080, 0x0030)
    api.hide_overlay(55)
    assert hidden == [(55, 0)]


def test_editor_position_preserves_input_styles_and_waits_for_qt_to_show():
    api = _Win32Api.__new__(_Win32Api)
    api._is_own_window = lambda hwnd: hwnd == 55
    api._physical_coordinates = lambda: nullcontext(True)
    positions = []
    api.user = SimpleNamespace(SetWindowPos=lambda *args: positions.append(args) or True)
    assert not api.position_editor(99, 0, 0, 500, 500)
    assert api.position_editor(55, -1920, 0, 1920, 1080)
    assert positions == [(55, -1, -1920, 0, 1920, 1080, 0x0010)]


def test_thread_dpi_context_falls_back_and_restores_after_error():
    api = _Win32Api.__new__(_Win32Api)
    contexts = []

    def set_dpi(context):
        contexts.append(context)
        return 0 if context == -4 else 123

    api.set_dpi = set_dpi
    with pytest.raises(ValueError):
        with api._physical_coordinates() as physical:
            assert physical
            raise ValueError("failed window geometry read")
    assert contexts == [-4, -3, 123]


def test_native_cover_position_refuses_unverified_coordinate_space():
    api = _Win32Api.__new__(_Win32Api)
    api._is_own_window = lambda _: True
    api.get_long = lambda *_: 0x080000A0
    api._physical_coordinates = lambda: nullcontext(False)
    assert not api.position_overlay(55, 0, 0, 1920, 1080)


@pytest.mark.skipif(os.name != "nt", reason="Windows DLL signature check only")
def test_native_bindings_preserve_pointer_width_without_querying_windows():
    import ctypes
    api = _Win32Api()  # Binds functions only: no window/process/hotkey calls.
    pointer_size = ctypes.sizeof(ctypes.c_void_p)
    assert ctypes.sizeof(api.user.GetForegroundWindow.restype) == pointer_size
    assert ctypes.sizeof(api.kernel.OpenProcess.restype) == pointer_size
    assert ctypes.sizeof(api.get_long.restype) == pointer_size
    assert ctypes.sizeof(api.Message) == (48 if pointer_size == 8 else 32)
    message = api.Message()
    message.message, message.wParam, message.hwnd = WM_HOTKEY, HOTKEY_ID, 0x123456789 if pointer_size == 8 else 7
    assert api.matches_native_message(ctypes.addressof(message), int(message.hwnd))
