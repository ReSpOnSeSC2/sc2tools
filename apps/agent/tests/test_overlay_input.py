from __future__ import annotations

import sys

import pytest

from sc2tools_agent.ui import overlay_input
from sc2tools_agent.ui.overlay_input import INPUT_STYLES, NativeClickThrough, WS_EX_LAYERED, WS_EX_TRANSPARENT
from tests._gui_offscreen import run_gui_check


class FakeStyleApi:
    def __init__(self, style=0):
        self.styles = {100: style}
        self.owners = {100}
        self.calls = []
        self.fail = None

    def owns_window(self, hwnd):
        return hwnd in self.owners

    def style(self, hwnd):
        return self.styles[hwnd]

    def set_style(self, hwnd, style):
        self.calls.append(("style", hwnd, style))
        if self.fail == "style":
            raise OSError("Cannot write style")
        self.styles[hwnd] = style

    def make_opaque(self, hwnd):
        self.calls.append(("opaque", hwnd))
        if self.fail == "opaque":
            raise OSError("Cannot set opacity")

    def refresh(self, hwnd):
        self.calls.append(("refresh", hwnd))
        if self.fail == "refresh":
            raise OSError("Cannot refresh style")


def test_native_hit_testing_uses_layered_transparency_and_restores_only_owned_bits():
    original = 0x00040000 | 0x00000080 | 0x00000008
    api = FakeStyleApi(original)
    native = NativeClickThrough(api=api)
    assert native.set_click_through(100, True)
    assert api.styles[100] == original | INPUT_STYLES
    assert api.calls == [("style", 100, original | INPUT_STYLES), ("opaque", 100), ("refresh", 100)]
    assert not api.styles[100] & 0x08000000
    before = len(api.calls)
    assert native.set_click_through(100, True)
    assert len(api.calls) == before
    api.styles[100] |= 0x00000100
    assert native.set_click_through(100, False)
    assert api.styles[100] == original | 0x00000100
    assert not native._added
    assert overlay_input.REFRESH_FLAGS == 0x0037


@pytest.mark.skipif(sys.platform != "win32", reason="Windows native mouse activation")
def test_scouting_mouse_activation_accepts_click_without_activating_or_eating_it():
    import ctypes
    from ctypes import wintypes

    message = wintypes.MSG()
    message.message = 0x0021
    assert overlay_input.mouse_activation_reply(ctypes.addressof(message)) == (True, 3)
    message.message = 0x0201
    assert overlay_input.mouse_activation_reply(ctypes.addressof(message)) is None
    assert overlay_input.mouse_activation_reply(0) is None


@pytest.mark.skipif(sys.platform != "win32", reason="Windows native Qt event delivery")
def test_hidden_native_scouting_control_receives_mouse_activation_without_focus(tmp_path):
    import os
    from pathlib import Path
    import subprocess
    import textwrap

    environment = dict(os.environ, QT_QPA_PLATFORM="windows")
    environment["PYTHONPATH"] = str(Path(__file__).resolve().parents[1])
    result = subprocess.run([sys.executable, "-c", textwrap.dedent('''
        import ctypes
        from ctypes import wintypes
        from PySide6 import QtCore, QtWidgets
        from sc2tools_agent.ui.overlay_input import NativeClickThrough, build_scouting_control, _StyleApi, INPUT_STYLES
        app = QtWidgets.QApplication([])
        window = QtWidgets.QWidget()
        source = QtWidgets.QToolButton(window)
        source.setObjectName("opponentCardScout")
        source.setAccessibleName("Toggle scouting panel")
        source.resize(22, 22)
        control = build_scouting_control(source, QtCore=QtCore, QtWidgets=QtWidgets)
        native = NativeClickThrough(api=_StyleApi())
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        user32.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        user32.SendMessageW.restype = ctypes.c_ssize_t
        try:
            handle = int(control.winId())
            assert native.set_click_through(int(window.winId()), True)
            assert native._api.style(int(window.winId())) & INPUT_STYLES == INPUT_STYLES
            assert not native._api.style(handle) & 0x20
            assert native._api.style(handle) & 0x08000000
            assert user32.SendMessageW(handle, 0x0021, int(window.winId()), (0x0201 << 16) | 1) == 3
            assert not window.isVisible() and not control.isVisible()
        finally:
            native.restore_all()
            control.close()
            window.close()
    ''')], capture_output=True, text=True, timeout=30, env=environment)
    assert result.returncode == 0, result.stdout + result.stderr


def test_only_the_scouting_control_receives_input_over_locked_windows_and_alt_tab_restores_controls(tmp_path):
    run_gui_check(tmp_path, '''
from sc2tools_agent.ui.overlay_input import install_overlay_input
class Native:
    def __init__(self): self.locked = set()
    def set_click_through(self, handle, locked):
        self.locked.add(handle) if locked else self.locked.discard(handle)
        return True
    def restore_all(self): self.locked.clear()
window = QtWidgets.QWidget()
window.resize(340, 78)
source = QtWidgets.QToolButton(window)
source.setObjectName("opponentCardScout")
source.setAccessibleName("Toggle scouting panel")
source.setText("Scouting")
source.setGeometry(172, 5, 62, 22)
source.setCheckable(True)
other = QtWidgets.QToolButton(window)
other.setGeometry(236, 5, 50, 22)
panel = QtWidgets.QWidget()
panel.resize(650, 450)
source.clicked.connect(lambda checked: panel.setVisible(checked))
window.show()
app.processEvents()
foreground = [True]
native = Native()
controller = install_overlay_input(window, panels_provider=lambda: [panel], compact_provider=lambda: True,
    scouting_buttons_provider=lambda: [source], QtCore=QtCore, QtWidgets=QtWidgets,
    native=native, foreground_provider=lambda: foreground[0])
controller.timer.stop()
try:
    controller.refresh()
    assert window.property("gameClickThrough") is True
    assert list(controller._scouting_controls) == [source]
    control = controller._scouting_controls[source]
    assert control.isVisible()
    assert control.text() == "Scouting"
    assert control.windowFlags() & QtCore.Qt.WindowDoesNotAcceptFocus
    assert control.testAttribute(QtCore.Qt.WA_ShowWithoutActivating)
    assert control.focusPolicy() == QtCore.Qt.NoFocus
    assert control.parentWidget() is window
    assert control.geometry().topLeft() == source.mapToGlobal(QtCore.QPoint())
    assert control.size() == source.size()
    control.click()
    assert panel.isVisible() and panel.property("gameClickThrough") is True
    assert source.isChecked() and control.isChecked()
    control.click()
    assert not panel.isVisible() and not source.isChecked()
    source.setEnabled(False)
    controller.refresh()
    assert not control.isVisible() and window.property("gameClickThrough") is True
    source.setEnabled(True)
    foreground[0] = False
    controller.refresh()
    assert not control.isVisible() and not native.locked
    assert not window.property("gameClickThrough") and other.isEnabled()
    foreground[0] = True
    controller.refresh()
    window.move(70, 90)
    app.processEvents()
    controller.refresh()
    assert control.geometry().topLeft() == source.mapToGlobal(QtCore.QPoint())
    window.showMinimized()
    app.processEvents()
    controller.refresh()
    assert not control.isVisible()
finally:
    controller.shutdown()
    panel.close()
    window.close()
assert not native.locked and not controller._scouting_controls
''')


@pytest.mark.parametrize("original", [WS_EX_LAYERED, INPUT_STYLES, WS_EX_TRANSPARENT | 0x08000000])
def test_existing_layering_or_native_flags_are_never_discarded(original):
    api = FakeStyleApi(original)
    native = NativeClickThrough(api=api)
    assert native.set_click_through(100, True)
    if original & WS_EX_LAYERED:
        assert not any(call[0] == "opaque" for call in api.calls)
    native.restore_all()
    assert api.styles[100] == original


@pytest.mark.parametrize("failure", ["style", "opaque", "refresh"])
def test_failed_native_change_is_rolled_back_and_never_escapes(failure):
    api = FakeStyleApi(0x80)
    api.fail = failure
    native = NativeClickThrough(api=api)
    assert not native.set_click_through(100, True)
    assert api.styles[100] == 0x80
    api.fail = None
    native.restore_all()
    assert not native._added


def test_recycled_foreign_handles_are_never_modified_on_lock_or_restore():
    api = FakeStyleApi(0x80)
    native = NativeClickThrough(api=api)
    assert not native.set_click_through(200, True)
    assert not api.calls
    assert native.set_click_through(100, True)
    api.owners.clear()
    api.calls.clear()
    native.restore_all()
    assert not api.calls and not native._added


def test_non_windows_does_not_load_ctypes_bindings_and_keeps_windows_interactive(monkeypatch):
    monkeypatch.setattr(overlay_input.sys, "platform", "linux")
    monkeypatch.setattr(overlay_input, "_StyleApi", lambda: pytest.fail("Windows bindings loaded off Windows"))
    native = NativeClickThrough()
    assert not native.set_click_through(100, True)
    assert native.set_click_through(100, False)
    native.restore_all()


@pytest.mark.parametrize("image,expected", [
    (r"C:\Games\StarCraft II\Versions\Base93333\SC2_x64.exe", True),
    (r"D:\Games\SC2.EXE", True), (r"C:\Windows\explorer.exe", False),
    (r"C:\Games\not-SC2_x64.exe", False), (None, False),
])
def test_foreground_policy_verifies_exact_sc2_process_image(monkeypatch, image, expected):
    from types import SimpleNamespace
    api = SimpleNamespace(foreground_window=lambda: 77, is_window=lambda hwnd: hwnd == 77,
                          process_id=lambda hwnd: 88, process_image=lambda process: image)
    monkeypatch.setattr(overlay_input.win32_window, "_api", lambda: api)
    assert overlay_input.sc2_has_foreground() is expected
    api.foreground_window = lambda: 0
    assert not overlay_input.sc2_has_foreground()


@pytest.mark.skipif(sys.platform != "win32", reason="requires real Windows ctypes bindings")
def test_real_native_style_bindings_reject_foreign_or_invalid_handles_without_focus_changes():
    api = overlay_input._StyleApi()
    assert not api.owns_window(0)
    assert not api.owns_window(0x7FFF_FFF0)
    native = NativeClickThrough(api=api)
    assert not native.set_click_through(0x7FFF_FFF0, True)
    assert not native._added


@pytest.mark.skipif(sys.platform != "win32", reason="requires real Windows HWNDs")
def test_real_owned_hidden_window_roundtrips_styles_without_showing_moving_or_taking_focus():
    import ctypes
    from ctypes import wintypes
    import uuid

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    procedure_type = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, wintypes.HWND, wintypes.UINT,
                                       wintypes.WPARAM, wintypes.LPARAM)
    user32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    user32.DefWindowProcW.restype = ctypes.c_ssize_t

    class WindowClass(ctypes.Structure):
        _fields_ = [("style", wintypes.UINT), ("procedure", procedure_type), ("classExtra", ctypes.c_int),
                    ("windowExtra", ctypes.c_int), ("instance", wintypes.HINSTANCE), ("icon", wintypes.HICON),
                    ("cursor", wintypes.HANDLE), ("brush", wintypes.HBRUSH), ("menu", wintypes.LPCWSTR),
                    ("name", wintypes.LPCWSTR)]

    kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
    kernel32.GetModuleHandleW.restype = wintypes.HMODULE
    user32.RegisterClassW.argtypes = [ctypes.POINTER(WindowClass)]
    user32.RegisterClassW.restype = wintypes.WORD
    user32.UnregisterClassW.argtypes = [wintypes.LPCWSTR, wintypes.HINSTANCE]
    user32.UnregisterClassW.restype = wintypes.BOOL
    user32.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
                                     ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                     wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID]
    user32.CreateWindowExW.restype = wintypes.HWND
    user32.DestroyWindow.argtypes = [wintypes.HWND]
    user32.DestroyWindow.restype = wintypes.BOOL
    user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user32.GetWindowRect.restype = wintypes.BOOL
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.IsWindowVisible.restype = wintypes.BOOL
    user32.GetForegroundWindow.argtypes = []
    user32.GetForegroundWindow.restype = wintypes.HWND
    procedure = procedure_type(user32.DefWindowProcW)
    instance = kernel32.GetModuleHandleW(None)
    name = "sc2tools-hidden-input-test-" + uuid.uuid4().hex
    window_class = WindowClass(0, procedure, 0, 0, instance, None, None, None, None, name)
    assert user32.RegisterClassW(ctypes.byref(window_class))
    hwnd = None
    native = NativeClickThrough(api=overlay_input._StyleApi())
    try:
        hwnd = user32.CreateWindowExW(0x80, name, "Hidden overlay input test", 0x80000000,
                                      50, 60, 150, 110, None, None, instance, None)
        assert hwnd and native._api.owns_window(hwnd)
        before = wintypes.RECT()
        assert user32.GetWindowRect(hwnd, ctypes.byref(before))
        geometry = (before.left, before.top, before.right, before.bottom)
        original = native._api.style(hwnd)
        assert not user32.IsWindowVisible(hwnd)
        assert native.set_click_through(hwnd, True)
        assert native._api.style(hwnd) == original | INPUT_STYLES
        assert native.set_click_through(hwnd, False)
        assert native._api.style(hwnd) == original
        after = wintypes.RECT()
        assert user32.GetWindowRect(hwnd, ctypes.byref(after))
        assert (after.left, after.top, after.right, after.bottom) == geometry
        assert not user32.IsWindowVisible(hwnd) and user32.GetForegroundWindow() != hwnd
    finally:
        native.restore_all()
        if hwnd:
            assert user32.DestroyWindow(hwnd)
        assert user32.UnregisterClassW(name, instance)


def test_all_native_pins_and_only_main_compact_follow_foreground_without_focus_or_geometry_changes(tmp_path):
    run_gui_check(tmp_path, '''
        from sc2tools_agent.ui.overlay_input import install_overlay_input
        class Native:
            def __init__(self):
                self.locked = set()
                self.calls = []
                self.fail_release = None
            def set_click_through(self, hwnd, enabled):
                self.calls.append((hwnd, enabled))
                if not enabled and self.fail_release == hwnd:
                    self.fail_release = None
                    return False
                self.locked.add(hwnd) if enabled else self.locked.discard(hwnd)
                return True
            def restore_all(self):
                self.locked.clear()
        foreground = [True]
        ui, window = make_window(window_page="companion")
        window.show()
        window._overlay_input.shutdown()
        native = Native()
        page = window._companion_page
        page.timer.stop()
        page.ghost_page.timer.stop()
        page.set_active = lambda active: None
        panels = [*page.overlays.values(), page.ghost_page.panel, page.session_panel]
        for panel in panels:
            panel.show()
        controller = install_overlay_input(window, panels_provider=lambda: panels,
            compact_provider=window._compact_window_active, QtCore=QtCore,
            native=native, foreground_provider=lambda: foreground[0])
        assert controller.timer.isActive()
        controller.timer.stop()
        app.processEvents()
        before = [(panel.geometry(), panel.windowFlags(), panel.windowState()) for panel in panels]
        controller.refresh()
        assert len(native.locked) == 4
        assert all(panel.property("gameClickThrough") for panel in panels)
        assert int(window.winId()) not in native.locked
        window._set_window_size("Compact")
        app.processEvents()
        controller.refresh()
        assert int(window.winId()) in native.locked and len(native.locked) == 5
        assert window.size().toTuple() == (340, 78)
        panels[0].showMinimized()
        app.processEvents()
        minimized = panels[0].windowState()
        foreground[0] = False
        controller.refresh()
        assert not native.locked
        assert not any(panel.property("gameClickThrough") for panel in panels)
        assert panels[0].windowState() == minimized and panels[0].isMinimized()
        for panel, (geometry, flags, state) in zip(panels, before):
            assert panel.geometry() == geometry and panel.windowFlags() == flags
        foreground[0] = True
        controller.refresh()
        assert int(window.winId()) in native.locked
        window._set_window_size("Standard")
        app.processEvents()
        native.fail_release = int(window.winId())
        controller.refresh()
        assert int(window.winId()) in native.locked
        assert window.property("gameClickThrough")
        controller.refresh()
        assert int(window.winId()) not in native.locked
        assert window.size().toTuple() == (520, 480)
        assert window.isVisible()
        panels[1].hide()
        controller.refresh()
        assert int(panels[1].winId()) not in native.locked
        def unavailable():
            raise OSError("Cannot read foreground")
        controller._foreground = unavailable
        controller.refresh()
        assert not native.locked
        foreground[0] = True
        controller._foreground = lambda: foreground[0]
        controller.refresh()
        controller.shutdown()
        assert not controller.timer.isActive() and not native.locked
        assert not any(panel.property("gameClickThrough") for panel in panels)
        page.shutdown()
        window._race_effects.shutdown()
        window.hide()
    ''')


def test_main_gui_wires_all_pin_kinds_and_shuts_down_native_controller_without_changing_close_policy(tmp_path):
    run_gui_check(tmp_path, '''
        ui, window = make_window(window_page="companion")
        window.show()
        app.processEvents()
        controller = window._overlay_input
        assert controller.parent() is window and controller.timer.isActive()
        window.close()
        app.processEvents()
        assert not window.isVisible()
        assert controller.timer.isActive()
        window._on_show_requested()
        assert window.isVisible()
        controller.shutdown()
        assert not controller.timer.isActive()
        window._companion_page.shutdown()
        window._race_effects.shutdown()
        window.hide()
    ''')
