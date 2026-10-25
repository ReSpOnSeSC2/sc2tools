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
@pytest.mark.parametrize("checkable", [True, False])
def test_hidden_native_scouting_control_receives_mouse_activation_without_focus(tmp_path, checkable):
    import os
    from pathlib import Path
    import subprocess
    import textwrap

    environment = dict(os.environ, QT_QPA_PLATFORM="windows")
    environment["PYTHONPATH"] = str(Path(__file__).resolve().parents[1])
    result = subprocess.run([sys.executable, "-c", textwrap.dedent('''
        import ctypes
        import sys
        from ctypes import wintypes
        from PySide6 import QtCore, QtWidgets
        from sc2tools_agent.ui.overlay_input import NativeClickThrough, build_scouting_control, _StyleApi, INPUT_STYLES
        app = QtWidgets.QApplication([])
        window = QtWidgets.QWidget()
        window.setWindowFlag(QtCore.Qt.FramelessWindowHint, True)
        window.setAttribute(QtCore.Qt.WA_TranslucentBackground)
        controls = QtWidgets.QWidget(window)
        source = QtWidgets.QToolButton(controls)
        source.setObjectName("opponentCardScout")
        source.setAccessibleName("Toggle scouting panel")
        source.setCheckable(sys.argv[1] == "checkable")
        source.resize(22, 22)
        control = build_scouting_control(source, QtCore=QtCore, QtWidgets=QtWidgets)
        native = NativeClickThrough(api=_StyleApi())
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        user32.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        user32.SendMessageW.restype = ctypes.c_ssize_t
        try:
            handle = int(control.winId())
            assert control.isWindow() and control.parentWidget() is controls
            original = native._api.style(int(window.winId()))
            assert original & 0x80000
            assert native.set_click_through(int(window.winId()), True)
            assert native._api.style(int(window.winId())) & INPUT_STYLES == INPUT_STYLES
            assert not native._api.style(handle) & 0x20
            assert native._api.style(handle) & 0x08000000
            assert control.isCheckable() == source.isCheckable()
            assert user32.SendMessageW(handle, 0x0021, int(window.winId()), (0x0201 << 16) | 1) == 3
            assert not window.isVisible() and not control.isVisible()
            assert native.set_click_through(int(window.winId()), False)
            assert native._api.style(int(window.winId())) == original
        finally:
            native.restore_all()
            control.close()
            window.close()
    '''), "checkable" if checkable else "momentary"], capture_output=True, text=True, timeout=30, env=environment)
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
window.resize(420, 44)
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
    assert control.testAttribute(QtCore.Qt.WA_TranslucentBackground)
    assert control.focusPolicy() == QtCore.Qt.NoFocus
    assert control.parentWidget() is window
    assert control.geometry().topLeft() == source.mapToGlobal(QtCore.QPoint())
    assert control.size() == source.size()
    control.click()
    assert panel.isVisible() and panel.property("gameClickThrough") is True
    assert source.isChecked() and control.isChecked()
    control.click()
    assert not panel.isVisible() and not source.isChecked()
    source.setProperty("compactAction", "expand")
    controller.refresh()
    assert not control.isVisible() and window.property("gameClickThrough") is True
    control.click()
    assert not panel.isVisible() and not source.isChecked()
    assert not control.isChecked()
    source.setProperty("compactAction", "scout")
    controller.refresh()
    assert control.isVisible()
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
            def set_click_through(self, hwnd, enabled):
                self.calls.append((hwnd, enabled))
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
        assert not window.isVisible()
        assert int(window.winId()) not in native.locked and len(native.locked) == 4
        assert window.size().toTuple() == (420, 44)
        panels[0].showMinimized()
        window.showNormal()
        app.processEvents()
        controller.refresh()
        assert window.isVisible() and int(window.winId()) in native.locked
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


def test_stable_input_polling_skips_native_calls_but_revalidates_unannounced_style_changes(tmp_path):
    run_gui_check(tmp_path, '''
        from sc2tools_agent.ui.overlay_input import install_overlay_input, NATIVE_RECHECK_SECONDS
        class Native:
            def __init__(self): self.calls, self.locked = [], set()
            def set_click_through(self, hwnd, enabled):
                self.calls.append((hwnd, enabled))
                self.locked.add(hwnd) if enabled else self.locked.discard(hwnd)
                return True
            def restore_all(self): self.locked.clear()
        class Changes(QtCore.QObject):
            def __init__(self): super().__init__(); self.count = 0
            def eventFilter(self, watched, event):
                if (event.type() == QtCore.QEvent.DynamicPropertyChange
                        and bytes(event.propertyName()) == b"gameClickThrough"):
                    self.count += 1
                return False
        window = QtWidgets.QWidget()
        window.show()
        app.processEvents()
        native, now, foreground = Native(), [0.0], [True]
        controller = install_overlay_input(window, panels_provider=lambda: [], compact_provider=lambda: True,
            QtCore=QtCore, native=native, foreground_provider=lambda: foreground[0], clock=lambda: now[0])
        controller.timer.stop()
        changes = Changes()
        window.installEventFilter(changes)
        try:
            app.processEvents()
            controller.refresh()
            handle = int(window.winId())
            assert native.locked == {handle} and window.property("gameClickThrough") is True
            native.calls.clear()
            for _ in range(60):
                now[0] += NATIVE_RECHECK_SECONDS / 100
                controller.refresh()
            assert native.calls == [] and changes.count == 0
            # A native style can change without a Qt event. The bounded
            # periodic validation repairs it instead of trusting the cache forever.
            native.locked.clear()
            now[0] = NATIVE_RECHECK_SECONDS + 0.01
            controller.refresh()
            assert native.calls == [(handle, True)] and native.locked == {handle}
            assert changes.count == 0
            foreground[0] = False
            controller.refresh()
            assert native.calls[-1] == (handle, False) and not native.locked
            assert window.property("gameClickThrough") is False and changes.count == 1
            native.calls.clear()
            for _ in range(60): controller.refresh()
            assert native.calls == [] and changes.count == 1
        finally:
            controller.shutdown()
            window.close()
    ''')


def test_input_sync_reacts_to_show_hide_focus_style_and_recreated_handle_events(tmp_path):
    run_gui_check(tmp_path, '''
        from sc2tools_agent.ui.overlay_input import install_overlay_input
        class Native:
            def __init__(self): self.calls, self.locked = [], set()
            def set_click_through(self, hwnd, enabled):
                self.calls.append((hwnd, enabled))
                self.locked.add(hwnd) if enabled else self.locked.discard(hwnd)
                return True
            def restore_all(self): self.locked.clear()
        class Panel(QtWidgets.QWidget):
            def __init__(self): super().__init__(); self.handle = 101
            def winId(self): return self.handle
        window, panel = QtWidgets.QWidget(), Panel()
        source = QtWidgets.QToolButton(panel)
        source.setObjectName("opponentCardScout")
        source.setAccessibleName("Toggle scouting panel")
        source.setGeometry(10, 10, 22, 22)
        native, foreground = Native(), [True]
        controller = install_overlay_input(window, panels_provider=lambda: [panel], compact_provider=lambda: False,
            QtCore=QtCore, QtWidgets=QtWidgets, scouting_buttons_provider=lambda: [source],
            native=native, foreground_provider=lambda: foreground[0], clock=lambda: 0.0)
        controller.timer.stop()
        try:
            panel.show()
            assert native.locked == {101} and panel.property("gameClickThrough") is True
            app.processEvents()
            control = controller._scouting_controls[source]
            assert control.isVisible()
            native.calls.clear()
            panel.handle = 202
            # Check the return from this single refresh, before another poll or
            # queued event could repair a stale property on the same widget.
            controller.refresh()
            assert native.locked == {202}
            assert panel.property("gameClickThrough") is True and control.isVisible()
            assert (202, True) in native.calls and (101, False) in native.calls
            QtCore.QCoreApplication.sendEvent(panel, QtCore.QEvent(QtCore.QEvent.WinIdChange))
            app.processEvents()
            assert native.locked == {202}
            assert panel.property("gameClickThrough") is True and control.isVisible()
            # Qt style changes invalidate immediately, then re-apply after Qt
            # has finished changing its surface, even inside the recheck interval.
            native.locked.clear()
            native.calls.clear()
            QtCore.QCoreApplication.sendEvent(panel, QtCore.QEvent(QtCore.QEvent.StyleChange))
            app.processEvents()
            assert native.locked == {202} and (202, True) in native.calls
            native.locked.clear()
            native.calls.clear()
            QtCore.QCoreApplication.sendEvent(panel, QtGui.QWindowStateChangeEvent(QtCore.Qt.WindowNoState))
            assert native.locked == {202} and (202, True) in native.calls
            assert panel.property("gameClickThrough") is True and control.isVisible()
            foreground[0] = False
            app.applicationStateChanged.emit(QtCore.Qt.ApplicationActive)
            assert not native.locked and panel.property("gameClickThrough") is False
            foreground[0] = True
            app.applicationStateChanged.emit(QtCore.Qt.ApplicationInactive)
            assert native.locked == {202} and panel.property("gameClickThrough") is True
            panel.hide()
            assert not native.locked and panel.property("gameClickThrough") is False
            panel.show()
            assert native.locked == {202} and panel.property("gameClickThrough") is True
        finally:
            controller.shutdown()
            panel.close()
            window.close()
        app.processEvents()
        assert not native.locked
    ''')


def test_failed_native_lock_and_release_are_retried_without_caching_success(tmp_path):
    run_gui_check(tmp_path, '''
        from sc2tools_agent.ui.overlay_input import install_overlay_input
        class Native:
            def __init__(self): self.locked, self.fail_lock, self.fail_release = set(), True, False
            def set_click_through(self, hwnd, enabled):
                if enabled and self.fail_lock: return False
                if not enabled and self.fail_release:
                    self.fail_release = False
                    return False
                self.locked.add(hwnd) if enabled else self.locked.discard(hwnd)
                return True
            def restore_all(self): self.locked.clear()
        window, panel = QtWidgets.QWidget(), QtWidgets.QWidget()
        panel.show()
        app.processEvents()
        native, targets = Native(), [panel]
        controller = install_overlay_input(window, panels_provider=lambda: targets, compact_provider=lambda: False,
            QtCore=QtCore, native=native, foreground_provider=lambda: True, clock=lambda: 0.0)
        controller.timer.stop()
        try:
            handle = int(panel.winId())
            assert not native.locked and panel.property("gameClickThrough") is not True
            native.fail_lock = False
            controller.refresh()
            assert native.locked == {handle} and panel.property("gameClickThrough") is True
            native.fail_release = True
            targets.clear()
            controller.refresh()
            assert native.locked == {handle} and panel.property("gameClickThrough") is True
            controller.refresh()
            assert not native.locked and panel.property("gameClickThrough") is False
        finally:
            controller.shutdown()
            panel.close()
            window.close()
    ''')


def test_collapsing_companion_keeps_one_pinned_identity_and_one_live_control(tmp_path):
    run_gui_check(tmp_path, '''
        from sc2tools_agent.ui.overlay_input import install_overlay_input
        from shiboken6 import isValid
        class Native:
            def set_click_through(self, hwnd, locked): return True
            def restore_all(self): pass
        ui, window = make_window(window_page="companion")
        page = window._companion_page
        page.timer.stop()
        page.ghost_page.timer.stop()
        page.set_active = lambda active: None
        window._overlay_input.shutdown()
        window._overlay_input = controller = install_overlay_input(
            window, panels_provider=lambda: list(page.overlays.values()),
            compact_provider=window._compact_window_active, QtCore=QtCore, QtWidgets=QtWidgets,
            scouting_buttons_provider=page.scouting_buttons, native=Native(), foreground_provider=lambda: True)
        controller.timer.stop()
        page.inputTargetsChanged.connect(controller.refresh)
        page._paired = page._snapshot_healthy = True
        page._preferences.update(overlaysEnabled=True, opponentOverlay=False, scoutingOverlay=False)
        context = {"name": "Nightshade", "race": "Zerg", "mmr": 5100,
                   "headToHead": {"wins": 1, "losses": 0}}
        page.live_context = lambda: (True, context)
        page._scouting_toggle_allowed = lambda: True
        window.show()
        window._set_window_size("Compact")
        page._update_overlays()
        app.processEvents()
        controller.refresh()
        opponent = page.overlays["opponent"]
        first = controller._scouting_controls[page.compact_card.scouting_button]
        assert window.isVisible() and first.isVisible() and not opponent.isVisible()
        try:
            page._preferences["opponentOverlay"] = True
            page._update_overlays()
            app.processEvents()
            controller.refresh()
            assert not window.isVisible() and opponent.isVisible()
            assert not isValid(first) or not first.isVisible()
            control = controller._scouting_controls[opponent.identity_card.scouting_button]
            assert control.isVisible()
            assert len([widget for widget in controller._scouting_controls.values() if widget.isVisible()]) == 1
            opponent.move(80, 45)
            app.processEvents()
            position = opponent.pos()
            control.click()
            assert page.overlays["scouting"].isVisible()
            control.click()
            assert not page.overlays["scouting"].isVisible()
            for _ in range(3):
                window._on_show_requested()
                app.processEvents()
                assert window.isVisible() and page.current_density() == "standard"
                assert not page.compact_card.isVisible() and opponent.isVisible()
                assert window._set_window_size("Compact")
                app.processEvents()
                assert not window.isVisible() and opponent.isVisible()
                assert opponent.pos() == position
                assert len([widget for widget in controller._scouting_controls.values() if widget.isVisible()]) == 1
                assert len([widget for widget in app.topLevelWidgets()
                            if widget.objectName() == "opponentCardScout" and widget.isVisible()]) == 1
            # Re-showing saved Compact cannot recreate the duplicate. Explicit
            # tray/shortcut open above still opens the normal Standard workspace.
            window.showNormal()
            app.processEvents()
            assert not window.isVisible() and opponent.isVisible()
            page._preferences["opponentOverlay"] = False
            page._update_overlays()
            window.showNormal()
            app.processEvents()
            controller.refresh()
            assert window.isVisible() and page.compact_card.isVisible()
            assert not opponent.isVisible()
            active = [widget for widget in controller._scouting_controls.values() if widget.isVisible()]
            assert len(active) == 1 and active[0].isVisible()
            window.hide()
            assert not active[0].isVisible()
            # An old input proxy must not activate a now-hidden source.
            active[0].click()
            assert not page.overlays["scouting"].isVisible()
        finally:
            controller.shutdown()
            page.shutdown()
            window._race_effects.shutdown()
            window.hide()
    ''', timeout=60)


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
