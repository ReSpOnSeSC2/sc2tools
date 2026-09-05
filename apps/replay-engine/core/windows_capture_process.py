"""Launch and suppress only our owned Windows capture processes.

CreateProcessW starts the child suspended until its kill-on-close job and
window guardian are ready. Only explicit diagnostic handles are inherited.
No thread/desktop switch is performed on the agent or the user's game.
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes
import math
import os
import subprocess
import threading


class _STARTUPINFOW(ctypes.Structure):
    _fields_ = [("cb", wintypes.DWORD), ("lpReserved", wintypes.LPWSTR),
                ("lpDesktop", wintypes.LPWSTR), ("lpTitle", wintypes.LPWSTR),
                ("dwX", wintypes.DWORD), ("dwY", wintypes.DWORD),
                ("dwXSize", wintypes.DWORD), ("dwYSize", wintypes.DWORD),
                ("dwXCountChars", wintypes.DWORD), ("dwYCountChars", wintypes.DWORD),
                ("dwFillAttribute", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
                ("wShowWindow", wintypes.WORD), ("cbReserved2", wintypes.WORD),
                ("lpReserved2", ctypes.POINTER(wintypes.BYTE)),
                ("hStdInput", wintypes.HANDLE), ("hStdOutput", wintypes.HANDLE),
                ("hStdError", wintypes.HANDLE)]


class _STARTUPINFOEXW(ctypes.Structure):
    _fields_ = [("StartupInfo", _STARTUPINFOW), ("lpAttributeList", ctypes.c_void_p)]


class _PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [("hProcess", wintypes.HANDLE), ("hThread", wintypes.HANDLE),
                ("dwProcessId", wintypes.DWORD), ("dwThreadId", wintypes.DWORD)]


class _BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]


class _IO_COUNTERS(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in ("ReadOperationCount", "WriteOperationCount",
                "OtherOperationCount", "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]


class _EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [("BasicLimitInformation", _BASIC_LIMIT_INFORMATION), ("IoInfo", _IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]


class _WindowsAPI:
    """Typed bindings; kept separate so cleanup paths can be tested."""
    def __init__(self):
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.user = ctypes.WinDLL("user32", use_last_error=True)
        bind = self._bind
        bind(self.kernel, "GetCurrentProcess", wintypes.HANDLE, [])
        bind(self.kernel, "CloseHandle", wintypes.BOOL, [wintypes.HANDLE])
        bind(self.kernel, "DuplicateHandle", wintypes.BOOL,
             [wintypes.HANDLE, wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.HANDLE),
              wintypes.DWORD, wintypes.BOOL, wintypes.DWORD])
        bind(self.kernel, "InitializeProcThreadAttributeList", wintypes.BOOL,
             [ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(ctypes.c_size_t)])
        bind(self.kernel, "UpdateProcThreadAttribute", wintypes.BOOL,
             [ctypes.c_void_p, wintypes.DWORD, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t,
              ctypes.c_void_p, ctypes.c_void_p])
        bind(self.kernel, "DeleteProcThreadAttributeList", None, [ctypes.c_void_p])
        bind(self.kernel, "CreateProcessW", wintypes.BOOL,
             [wintypes.LPCWSTR, wintypes.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, wintypes.BOOL,
              wintypes.DWORD, ctypes.c_void_p, wintypes.LPCWSTR, ctypes.POINTER(_STARTUPINFOEXW),
              ctypes.POINTER(_PROCESS_INFORMATION)])
        bind(self.kernel, "WaitForSingleObject", wintypes.DWORD, [wintypes.HANDLE, wintypes.DWORD])
        bind(self.kernel, "GetExitCodeProcess", wintypes.BOOL,
             [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)])
        bind(self.kernel, "TerminateProcess", wintypes.BOOL, [wintypes.HANDLE, wintypes.UINT])
        bind(self.kernel, "CreateJobObjectW", wintypes.HANDLE, [ctypes.c_void_p, wintypes.LPCWSTR])
        bind(self.kernel, "SetInformationJobObject", wintypes.BOOL,
             [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD])
        bind(self.kernel, "AssignProcessToJobObject", wintypes.BOOL, [wintypes.HANDLE, wintypes.HANDLE])
        bind(self.kernel, "TerminateJobObject", wintypes.BOOL, [wintypes.HANDLE, wintypes.UINT])
        bind(self.kernel, "ResumeThread", wintypes.DWORD, [wintypes.HANDLE])

    @staticmethod
    def _bind(library, name, result, arguments):
        function = getattr(library, name)
        function.restype, function.argtypes = result, arguments

    @staticmethod
    def error(action):
        return OSError(f"{action}: {ctypes.WinError(ctypes.get_last_error())}")


class _BackgroundWindowGuard:
    """Hide only windows in this capture job; never select by process name.

    Created before the suspended child runs. STARTUPINFO and SC2 geometry
    suppress its first normal window; polling also catches later dialogs.
    Out-of-process suppression cannot promise that every application's very
    first window frame is invisible on every Windows/graphics configuration.
    """
    def __init__(self, api, job):
        self.api, self.job = api, job
        self.error = None
        self.suppressed_windows = set()
        self._stop = threading.Event()
        self._ready = threading.Event()
        self._callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        bind = _WindowsAPI._bind
        bind(api.kernel, "QueryInformationJobObject", wintypes.BOOL,
             [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p])
        bind(api.user, "EnumWindows", wintypes.BOOL, [self._callback_type, wintypes.LPARAM])
        bind(api.user, "GetWindowThreadProcessId", wintypes.DWORD,
             [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)])
        bind(api.user, "IsWindow", wintypes.BOOL, [wintypes.HWND])
        bind(api.user, "IsWindowVisible", wintypes.BOOL, [wintypes.HWND])
        bind(api.user, "ShowWindowAsync", wintypes.BOOL, [wintypes.HWND, ctypes.c_int])
        bind(api.user, "GetWindowLongPtrW", ctypes.c_ssize_t, [wintypes.HWND, ctypes.c_int])
        bind(api.user, "SetWindowLongPtrW", ctypes.c_ssize_t,
             [wintypes.HWND, ctypes.c_int, ctypes.c_ssize_t])
        bind(api.user, "SetWindowPos", wintypes.BOOL,
             [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT])
        self._thread = threading.Thread(target=self._run, name="SC2 capture windows", daemon=True)

    def start(self):
        self._thread.start()
        if not self._ready.wait(5):
            raise OSError("Could not start capture window suppression")
        self.check()

    def check(self):
        if self.error is not None:
            raise OSError(f"Capture window suppression failed: {self.error}") from self.error

    def stop(self):
        self._stop.set()
        if self._thread.ident is not None and threading.current_thread() is not self._thread:
            self._thread.join(timeout=5)
            if self._thread.is_alive():
                raise OSError("Could not stop the capture window guardian")

    def _scan(self):
        # JobObjectBasicProcessIdList: two DWORD counts, followed by ULONG_PTRs.
        capacity = 64
        while True:
            buffer = ctypes.create_string_buffer(8 + capacity * ctypes.sizeof(ctypes.c_size_t))
            if self.api.kernel.QueryInformationJobObject(self.job, 3, buffer, len(buffer), None):
                count = ctypes.cast(buffer, ctypes.POINTER(wintypes.DWORD))[1]
                pids = set((ctypes.c_size_t * count).from_buffer(buffer, 8))
                break
            if ctypes.get_last_error() != 234 or capacity >= 4096:  # ERROR_MORE_DATA
                raise self.api.error("Could not identify owned capture windows")
            capacity *= 2
        failure = []
        def visit(hwnd, _parameter):
            pid = wintypes.DWORD()
            self.api.user.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value not in pids:
                return True
            try:
                ctypes.set_last_error(0)
                style = self.api.user.GetWindowLongPtrW(hwnd, -20)  # GWL_EXSTYLE
                if style == 0 and ctypes.get_last_error() and self.api.user.IsWindow(hwnd):
                    raise self.api.error("Could not read an owned capture window style")
                desired = (style | 0x08000000 | 0x80) & ~0x40000  # NOACTIVATE | TOOLWINDOW, no APPWINDOW
                if style != desired:
                    ctypes.set_last_error(0)
                    previous = self.api.user.SetWindowLongPtrW(hwnd, -20, desired)
                    if previous == 0 and ctypes.get_last_error() and self.api.user.IsWindow(hwnd):
                        raise self.api.error("Could not suppress owned capture window activation")
                if self.api.user.IsWindowVisible(hwnd):
                    # Never minimize the DirectX render target. This moves
                    # and hides only our windows, without a focus operation.
                    if not self.api.user.SetWindowPos(hwnd, None, -32000, -32000, 0, 0,
                            0x1 | 0x4 | 0x10 | 0x200 | 0x4000) and self.api.user.IsWindow(hwnd):
                        raise self.api.error("Could not move an owned capture window offscreen")
                    if not self.api.user.ShowWindowAsync(hwnd, 0) and self.api.user.IsWindow(hwnd):
                        raise self.api.error("Could not hide an owned capture window")
                self.suppressed_windows.add(int(hwnd))
            except Exception as exc:
                failure.append(exc)
                return False
            return True
        callback = self._callback_type(visit)
        enumerated = self.api.user.EnumWindows(callback, 0)
        if failure:
            raise failure[0]
        if not enumerated:
            raise self.api.error("Could not inspect owned capture windows")

    def _run(self):
        try:
            while not self._stop.is_set():
                self._scan()
                self._ready.set()
                self._stop.wait(0.02)
        except Exception as exc:
            self.error = exc
            # Do not let a broken guardian leave capture windows visible.
            if not self._stop.is_set():
                self.api.kernel.TerminateJobObject(self.job, 1)
            self._ready.set()

class _CaptureProcess:
    def __init__(self, api, handle, pid, args, job=None, guard=None):
        self._api, self._handle = api, handle
        self._job = job
        self._guard = guard
        self.pid, self.args = pid, args
        self.returncode = None

    def poll(self):
        if self.returncode is not None:
            return self.returncode
        status = self._api.kernel.WaitForSingleObject(self._handle, 0)
        if status == 0x102:  # WAIT_TIMEOUT
            return None
        if status != 0:
            raise self._api.error("Could not query the capture process")
        code = wintypes.DWORD()
        if not self._api.kernel.GetExitCodeProcess(self._handle, ctypes.byref(code)):
            raise self._api.error("Could not read the capture process exit code")
        self.returncode = code.value
        return self.returncode

    def wait(self, timeout=None):
        if self.returncode is not None:
            return self.returncode
        milliseconds = 0xffffffff if timeout is None else min(0xfffffffe, max(0, math.ceil(timeout * 1000)))
        status = self._api.kernel.WaitForSingleObject(self._handle, milliseconds)
        if status == 0x102:
            raise subprocess.TimeoutExpired(self.args, timeout)
        if status != 0:
            raise self._api.error("Could not wait for the capture process")
        return self.poll()

    def terminate(self):
        if self._job is not None:
            if not self._api.kernel.TerminateJobObject(self._job, 1):
                raise self._api.error("Could not stop the owned capture job")
        elif self.poll() is None and not self._api.kernel.TerminateProcess(self._handle, 1):
            if self.poll() is None:
                raise self._api.error("Could not stop the capture process")

    kill = terminate

    def check_background(self):
        if self._guard is not None:
            self._guard.check()

    def close(self):
        guard_error = None
        if self._guard is not None:
            try:
                self._guard.stop()
            except Exception as exc:
                guard_error = exc
                # A hung owned HWND can block a style update. Stop the owned
                # job while the handle is still valid, then retry the join.
                if self._job is not None:
                    self._api.kernel.TerminateJobObject(self._job, 1)
                try:
                    self._guard.stop()
                except Exception:
                    pass
            finally:
                self._guard = None
        job_closed = False
        if self._job is not None:
            # The job is deliberately non-inheritable. Closing it kills the
            # entire owned capture tree, including if its main process exited.
            if not self._api.kernel.CloseHandle(self._job):
                raise self._api.error("Could not close the owned capture job")
            self._job = None
            job_closed = True
        if self._handle is not None:
            if job_closed:
                # Job termination is asynchronous. A second TerminateProcess
                # can return ACCESS_DENIED while Windows is already killing it.
                self.wait(timeout=5)
            elif self.poll() is None:
                self.terminate()
                self.wait(timeout=5)
            self._api.kernel.CloseHandle(self._handle)
            self._handle = None
        if guard_error is not None:
            raise guard_error

    def __del__(self):
        # Last-resort crash/exception ownership release. Normal _Engine.close
        # waits for exit first; the OS also closes this job if the agent dies.
        try:
            if self._guard is not None:
                try:
                    self._guard.stop()
                except Exception:
                    pass
                self._guard = None
            if self._job is not None:
                self._api.kernel.CloseHandle(self._job)
                self._job = None
            if self._handle is not None:
                self._api.kernel.CloseHandle(self._handle)
                self._handle = None
        except Exception:
            pass


def launch_background_process(args, *, cwd=None, stdin=subprocess.DEVNULL, stdout=None,
                              stderr=None, env=None, creationflags=0, startupinfo=None):
    """Start an owned, offscreen capture with continuous window suppression."""
    import msvcrt

    if stdin != subprocess.DEVNULL or stdout is None or stderr is None:
        raise ValueError("Background capture requires NUL input and explicit diagnostic output handles")
    api = _WindowsAPI()
    inherited = []
    job = None
    guard = None
    attributes = None
    initialized = False
    information = _PROCESS_INFORMATION()
    try:
        job = api.kernel.CreateJobObjectW(None, None)
        if not job:
            raise api.error("Could not create the owned capture job")
        limits = _EXTENDED_LIMIT_INFORMATION()
        limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not api.kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            raise api.error("Could not protect capture cleanup if the agent exits")
        parent = api.kernel.GetCurrentProcess()
        with open(os.devnull, "rb") as null_input:
            for stream in (null_input, stdout, stderr):
                duplicate = wintypes.HANDLE()
                if not api.kernel.DuplicateHandle(parent, msvcrt.get_osfhandle(stream.fileno()), parent,
                                                   ctypes.byref(duplicate), 0, True, 2):
                    raise api.error("Could not prepare isolated capture diagnostic handles")
                inherited.append(duplicate.value)
        size = ctypes.c_size_t()
        api.kernel.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size))
        if not size.value:
            raise api.error("Could not size the capture handle whitelist")
        attributes = ctypes.create_string_buffer(size.value)
        if not api.kernel.InitializeProcThreadAttributeList(attributes, 1, 0, ctypes.byref(size)):
            raise api.error("Could not initialize the capture handle whitelist")
        initialized = True
        handles = (wintypes.HANDLE * len(inherited))(*inherited)
        if not api.kernel.UpdateProcThreadAttribute(attributes, 0, 0x00020002, handles,
                                                     ctypes.sizeof(handles), None, None):
            raise api.error("Could not restrict capture handle inheritance")
        startup = _STARTUPINFOEXW()
        startup.StartupInfo.cb = ctypes.sizeof(startup)
        startup.StartupInfo.dwFlags = 0x100 | 0x1  # USESTDHANDLES | USESHOWWINDOW
        startup.StartupInfo.wShowWindow = 0  # SW_HIDE, including the first normal ShowWindow call
        startup.StartupInfo.dwFlags |= 0x4  # STARTF_USEPOSITION
        startup.StartupInfo.dwX = startup.StartupInfo.dwY = (-32000) & 0xffffffff
        startup.StartupInfo.hStdInput, startup.StartupInfo.hStdOutput, startup.StartupInfo.hStdError = inherited
        startup.lpAttributeList = ctypes.cast(attributes, ctypes.c_void_p)
        command = ctypes.create_unicode_buffer(subprocess.list2cmdline([os.fspath(arg) for arg in args]))
        environment = dict(os.environ) if env is None else env
        environment_block = ctypes.create_unicode_buffer("\0".join(
            f"{key}={value}" for key, value in sorted(environment.items(), key=lambda item: item[0].upper())) + "\0\0")
        flags = creationflags | 0x00080000 | 0x00000400 | 0x4 | 0x4000  # EXTENDED_STARTUPINFO | UNICODE_ENVIRONMENT | SUSPENDED | BELOW_NORMAL_PRIORITY
        if not api.kernel.CreateProcessW(os.fspath(args[0]), command, None, None, True, flags,
                                          environment_block, os.fspath(cwd) if cwd else None,
                                          ctypes.byref(startup), ctypes.byref(information)):
            raise api.error("Could not launch the owned StarCraft background capture")
        if not api.kernel.AssignProcessToJobObject(job, information.hProcess):
            raise api.error("Could not assign StarCraft to its owned capture job")
        guard = _BackgroundWindowGuard(api, job)
        guard.start()
        if api.kernel.ResumeThread(information.hThread) == 0xffffffff:
            raise api.error("Could not resume the isolated capture process")
        api.kernel.CloseHandle(information.hThread)
        information.hThread = None
        process = _CaptureProcess(api, information.hProcess, information.dwProcessId,
                                  list(args), job=job, guard=guard)
        information.hProcess = None
        job = None
        guard = None
        return process
    finally:
        if guard is not None:
            try:
                guard.stop()
            except Exception:
                # Preserve the launch error and still reap the suspended
                # process/job, even if a guardian thread failed to stop.
                if job is not None:
                    api.kernel.TerminateJobObject(job, 1)
                try:
                    guard.stop()
                except Exception:
                    pass
        if information.hProcess:
            # Assignment can fail before the job owns the suspended process.
            api.kernel.TerminateProcess(information.hProcess, 1)
            api.kernel.WaitForSingleObject(information.hProcess, 5000)
            api.kernel.CloseHandle(information.hProcess)
        if information.hThread:
            api.kernel.CloseHandle(information.hThread)
        if job is not None:
            api.kernel.CloseHandle(job)
        if initialized:
            api.kernel.DeleteProcThreadAttributeList(attributes)
        for handle in inherited:
            api.kernel.CloseHandle(handle)
