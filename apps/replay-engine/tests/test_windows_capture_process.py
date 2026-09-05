"""Exercise owned Windows capture processes using harmless children, never SC2."""
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import subprocess
import sys
import textwrap
import time

import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Win32 desktop integration")


def _desktop_api():
    user = ctypes.WinDLL("user32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    user.GetThreadDesktop.argtypes = [wintypes.DWORD]
    user.GetThreadDesktop.restype = wintypes.HANDLE
    user.OpenInputDesktop.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    user.OpenInputDesktop.restype = wintypes.HANDLE
    user.OpenDesktopW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    user.OpenDesktopW.restype = wintypes.HANDLE
    user.CloseDesktop.argtypes = [wintypes.HANDLE]
    user.CloseDesktop.restype = wintypes.BOOL
    user.GetUserObjectInformationW.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p,
                                             wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    user.GetUserObjectInformationW.restype = wintypes.BOOL
    kernel.GetCurrentThreadId.restype = wintypes.DWORD
    return user, kernel


def _desktop_name(user, handle):
    name = ctypes.create_unicode_buffer(256)
    needed = wintypes.DWORD()
    assert handle and user.GetUserObjectInformationW(handle, 2, name, ctypes.sizeof(name), ctypes.byref(needed))
    return name.value


def _desktop_snapshot():
    user, kernel = _desktop_api()
    # GetThreadDesktop returns a borrowed handle; OpenInputDesktop returns an
    # owned one. Neither function changes the user's active desktop.
    thread = _desktop_name(user, user.GetThreadDesktop(kernel.GetCurrentThreadId()))
    active = user.OpenInputDesktop(0, False, 0x0001)
    try:
        return thread, _desktop_name(user, active)
    finally:
        if active:
            assert user.CloseDesktop(active)


CHILD_INSPECT = textwrap.dedent("""
    import ctypes, json, os, sys
    from ctypes import wintypes
    user = ctypes.WinDLL('user32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetCurrentThreadId.restype = wintypes.DWORD
    user.GetThreadDesktop.argtypes = [wintypes.DWORD]
    user.GetThreadDesktop.restype = wintypes.HANDLE
    user.GetUserObjectInformationW.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p,
                                             wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    user.GetUserObjectInformationW.restype = wintypes.BOOL
    handle = user.GetThreadDesktop(kernel.GetCurrentThreadId())
    name = ctypes.create_unicode_buffer(256)
    needed = wintypes.DWORD()
    active = wintypes.BOOL()
    assert user.GetUserObjectInformationW(handle, 2, name, ctypes.sizeof(name), ctypes.byref(needed))
    assert user.GetUserObjectInformationW(handle, 6, ctypes.byref(active), ctypes.sizeof(active), ctypes.byref(needed))
    print(json.dumps({'desktop': name.value, 'input': bool(active.value), 'cwd': os.getcwd(),
                     'argv': sys.argv[1:], 'marker': os.environ['SC2TOOLS_CAPTURE_TEST_MARKER'],
                     'stdin': sys.stdin.read()}), flush=True)
""")


def test_background_child_has_normal_streams_unicode_and_preserves_user_desktop(tmp_path):
    from core.windows_capture_process import launch_background_process

    before = _desktop_snapshot()
    working = tmp_path / "capture path with spaces"
    working.mkdir()
    log_path = working / "child.log"
    environment = {**os.environ, "SC2TOOLS_CAPTURE_TEST_MARKER": "capture-\u2603"}
    arguments = [sys.executable, "-c", CHILD_INSPECT, "an argument with spaces", 'quote"inside', "\u00e9"]
    process = None
    with log_path.open("wb") as log:
        try:
            process = launch_background_process(arguments, cwd=working, stdin=subprocess.DEVNULL,
                                            stdout=log, stderr=log, env=environment)
            assert process.wait(timeout=15) == 0
            assert process.poll() == 0
        finally:
            if process is not None:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=5)
                process.close()
                process.close()
    output = json.loads(log_path.read_text(encoding="utf-8"))
    assert output["desktop"] == before[0]
    assert Path(output["cwd"]) == working
    assert output["argv"] == arguments[3:]
    assert output["marker"] == "capture-\u2603"
    assert output["stdin"] == ""
    assert _desktop_snapshot() == before


def test_closing_capture_reaps_an_unresponsive_owned_window(tmp_path):
    from core.windows_capture_process import launch_background_process

    before = _desktop_snapshot()
    ready = tmp_path / "unresponsive-window-ready"
    child_script = textwrap.dedent("""
        import ctypes, pathlib, sys, time
        from ctypes import wintypes
        user = ctypes.WinDLL('user32', use_last_error=True)
        user.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR,
            wintypes.DWORD, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
            wintypes.HWND, wintypes.HANDLE, wintypes.HINSTANCE, ctypes.c_void_p]
        user.CreateWindowExW.restype = wintypes.HWND
        window = user.CreateWindowExW(0, 'STATIC', 'Unresponsive owned capture test',
            0x80000000, -32000, -32000, 100, 100, None, None, None, None)
        assert window
        pathlib.Path(sys.argv[1]).write_text('ready', encoding='utf-8')
        # Never display the HWND, and intentionally do not service its messages.
        # Cleanup must still release the job when a window-thread call stalls.
        time.sleep(30)
    """)
    process = None
    error = None
    with (tmp_path / "unresponsive-child.log").open("wb") as log:
        try:
            process = launch_background_process([sys.executable, "-c", child_script, str(ready)],
                cwd=tmp_path, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
            deadline = time.monotonic() + 5
            while not ready.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.02)
            assert ready.exists(), "The unresponsive GUI test did not initialize"
            time.sleep(0.1)  # Allow one guardian scan to reach the owned HWND.
            started = time.monotonic()
            try:
                process.close()
            except OSError as exc:
                error = exc
            elapsed = time.monotonic() - started
            assert process.poll() is not None, "Closing capture left its unresponsive child alive"
            assert elapsed < 7.5, "Owned-window cleanup must have a bounded wait"
            if error is not None:
                assert "guardian" in str(error), str(error)
        finally:
            if process is not None:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=5)
                process.close()
    assert _desktop_snapshot() == before


def test_timeout_and_owned_child_termination_leave_user_desktop_unchanged(tmp_path):
    from core.windows_capture_process import launch_background_process

    before = _desktop_snapshot()
    log_path = tmp_path / "sleeping-child.log"
    process = None
    with log_path.open("wb") as log:
        try:
            process = launch_background_process([sys.executable, "-c", "import time; time.sleep(30)"],
                                            cwd=tmp_path, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
            with pytest.raises(subprocess.TimeoutExpired):
                process.wait(timeout=0.01)
            assert process.poll() is None
            process.terminate()
            process.wait(timeout=5)
            assert process.poll() is not None
        finally:
            if process is not None:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)
                process.close()
    assert _desktop_snapshot() == before


def test_abrupt_launcher_exit_reaps_its_capture_without_stopping_another_capture(tmp_path):
    from core.windows_capture_process import launch_background_process

    before = _desktop_snapshot()
    ready = tmp_path / "launcher-ready.json"
    launch_script = textwrap.dedent("""
        import json, os, pathlib, subprocess, sys
        sys.path.insert(0, sys.argv[1])
        from core.windows_capture_process import launch_background_process
        ready = pathlib.Path(sys.argv[2])
        child_code = (
            "import json,pathlib,subprocess,sys,time; "
            "grandchild=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'],"
            "creationflags=subprocess.CREATE_NO_WINDOW); "
            "temporary=pathlib.Path(sys.argv[1]+'.tmp'); "
            "temporary.write_text(json.dumps({'pid':grandchild.pid}),encoding='utf-8'); "
            "temporary.replace(sys.argv[1]); "
            "time.sleep(30)"
        )
        with (ready.parent / 'owned-child.log').open('wb') as log:
            child = launch_background_process([sys.executable, '-c', child_code, str(ready.parent / 'grandchild-ready.json')],
                cwd=ready.parent, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
            temporary = ready.with_suffix('.tmp')
            temporary.write_text(json.dumps({'pid': child.pid}), encoding='utf-8')
            temporary.replace(ready)
            sys.stdin.readline()
            os._exit(23)  # Simulate agent termination: no Python finally/destructor runs.
    """)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel.TerminateProcess.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    starter = control = None
    child_handles = []
    with (tmp_path / "launcher.log").open("wb") as launch_log, (tmp_path / "control.log").open("wb") as control_log:
        try:
            control = launch_background_process([sys.executable, "-c", "import time; time.sleep(30)"],
                cwd=tmp_path, stdin=subprocess.DEVNULL, stdout=control_log, stderr=control_log)
            startup = subprocess.STARTUPINFO()
            startup.dwFlags = subprocess.STARTF_USESHOWWINDOW
            startup.wShowWindow = subprocess.SW_HIDE
            starter = subprocess.Popen([sys.executable, "-c", launch_script,
                str(Path(__file__).parents[1]), str(ready)], stdin=subprocess.PIPE,
                stdout=launch_log, stderr=launch_log, creationflags=subprocess.CREATE_NO_WINDOW,
                startupinfo=startup)
            deadline = time.monotonic() + 10
            while not ready.exists() and starter.poll() is None and time.monotonic() < deadline:
                time.sleep(0.02)
            assert ready.exists(), "The isolated test launcher did not initialize"
            details = json.loads(ready.read_text(encoding="utf-8"))
            descendant_ready = tmp_path / "grandchild-ready.json"
            while not descendant_ready.exists() and starter.poll() is None and time.monotonic() < deadline:
                time.sleep(0.02)
            assert descendant_ready.exists(), "The isolated test child did not create its descendant"
            descendant = json.loads(descendant_ready.read_text(encoding="utf-8"))
            # Hold the exact child object to avoid PID reuse affecting checks
            # or cleanup; this test never enumerates or touches other apps.
            for pid in (details["pid"], descendant["pid"]):
                handle = kernel.OpenProcess(0x100000 | 0x1000 | 0x0001, False, pid)
                assert handle
                child_handles.append(handle)
                assert kernel.WaitForSingleObject(handle, 0) == 0x102
            assert control.poll() is None
            starter.stdin.write(b"exit\n")
            starter.stdin.flush()
            assert starter.wait(timeout=10) == 23
            assert all(kernel.WaitForSingleObject(handle, 5000) == 0 for handle in child_handles)
            assert control.poll() is None
        finally:
            if starter is not None:
                if starter.poll() is None:
                    starter.terminate()
                    starter.wait(timeout=5)
                starter.stdin.close()
            for handle in child_handles:
                if kernel.WaitForSingleObject(handle, 0) == 0x102:
                    kernel.TerminateProcess(handle, 1)
                    kernel.WaitForSingleObject(handle, 5000)
                kernel.CloseHandle(handle)
            if control is not None:
                control.close()
    assert _desktop_snapshot() == before


def test_background_guard_suppresses_only_owned_gui_windows_without_activating_them(tmp_path):
    from core.windows_capture_process import launch_background_process

    before = _desktop_snapshot()
    ready, stop = tmp_path / "window-ready.json", tmp_path / "stop-window"
    child_script = textwrap.dedent("""
        import ctypes, json, pathlib, sys, time
        from ctypes import wintypes
        user = ctypes.WinDLL('user32', use_last_error=True)
        user.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR,
            wintypes.DWORD, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
            wintypes.HWND, wintypes.HANDLE, wintypes.HINSTANCE, ctypes.c_void_p]
        user.CreateWindowExW.restype = wintypes.HWND
        user.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
        user.DestroyWindow.argtypes = [wintypes.HWND]
        user.PeekMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND,
                                     wintypes.UINT, wintypes.UINT, wintypes.UINT]
        user.TranslateMessage.argtypes = [ctypes.POINTER(wintypes.MSG)]
        user.DispatchMessageW.argtypes = [ctypes.POINTER(wintypes.MSG)]
        # Begin offscreen and hidden; every explicit show also avoids activation.
        # This test never deliberately brings a window onto the user's screen.
        window = user.CreateWindowExW(0x40000, 'STATIC', 'Owned capture guard test',
                                     0x80000000, -32000, -32000, 100, 100, None, None, None, None)
        assert window
        ready, stop = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
        temporary = ready.with_suffix('.tmp')
        temporary.write_text(json.dumps({'window': window}), encoding='utf-8')
        temporary.replace(ready)
        message = wintypes.MSG()
        deadline = time.monotonic() + 10
        while not stop.exists() and time.monotonic() < deadline:
            user.ShowWindow(window, 4)
            while user.PeekMessageW(ctypes.byref(message), None, 0, 0, 1):
                user.TranslateMessage(ctypes.byref(message))
                user.DispatchMessageW(ctypes.byref(message))
            time.sleep(0.01)
        assert user.DestroyWindow(window)
    """)
    user = ctypes.WinDLL("user32", use_last_error=True)
    dwm = ctypes.WinDLL("dwmapi", use_last_error=True)
    user.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR,
        wintypes.DWORD, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
        wintypes.HWND, wintypes.HANDLE, wintypes.HINSTANCE, ctypes.c_void_p]
    user.CreateWindowExW.restype = wintypes.HWND
    user.DestroyWindow.argtypes = [wintypes.HWND]
    user.GetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int]
    user.GetWindowLongPtrW.restype = ctypes.c_ssize_t
    user.IsWindowVisible.argtypes = [wintypes.HWND]
    user.IsWindowVisible.restype = wintypes.BOOL
    user.GetForegroundWindow.restype = wintypes.HWND
    user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    dwm.DwmGetWindowAttribute.argtypes = [wintypes.HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]
    dwm.DwmGetWindowAttribute.restype = ctypes.c_long
    def state(window):
        cloaked = wintypes.DWORD()
        assert dwm.DwmGetWindowAttribute(window, 14, ctypes.byref(cloaked), ctypes.sizeof(cloaked)) == 0
        return user.GetWindowLongPtrW(window, -20), bool(user.IsWindowVisible(window)), cloaked.value

    control = user.CreateWindowExW(0, "STATIC", "Unrelated hidden control", 0x80000000,
                                  -32000, -32000, 100, 100, None, None, None, None)
    assert control
    original_control = state(control)
    process = None
    with (tmp_path / "gui-child.log").open("wb") as log:
        try:
            process = launch_background_process([sys.executable, "-c", child_script, str(ready), str(stop)],
                cwd=tmp_path, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
            deadline = time.monotonic() + 5
            while not ready.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.02)
            assert ready.exists(), "The guarded GUI test process did not initialize"
            window = json.loads(ready.read_text(encoding="utf-8"))["window"]
            observed = state(window)
            while time.monotonic() < deadline:
                observed = state(window)
                style, visible, cloaked = observed
                if style & 0x08000000 and style & 0x80 and not style & 0x40000 and (cloaked or not visible):
                    break
                time.sleep(0.02)
            style, visible, cloaked = observed
            assert style & 0x08000000 and style & 0x80 and not style & 0x40000
            assert cloaked or not visible
            foreground_pid = wintypes.DWORD()
            user.GetWindowThreadProcessId(user.GetForegroundWindow(), ctypes.byref(foreground_pid))
            assert foreground_pid.value != process.pid
            assert state(control) == original_control
            stop.write_text("stop", encoding="utf-8")
            assert process.wait(timeout=5) == 0
        finally:
            if process is not None:
                process.close()
            assert user.DestroyWindow(control)
    assert _desktop_snapshot() == before
