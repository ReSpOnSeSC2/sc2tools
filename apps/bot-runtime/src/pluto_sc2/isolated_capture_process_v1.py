"""Windows non-input-desktop launcher; no desktop switch or visible fallback.

Handle/job binding definitions adapted from the user's SC2TOOLS launcher,
SHA3485c018cf93a7c9ea130bfd67d41d3234c331331613e7343661516de720a572.
Unlike its window suppression, this boundary gives the child a separate desktop.
SC2 DirectX/replay viability is UNVERIFIED until a separate native receipt exists.
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes
import math
import os
import subprocess
import threading
import uuid


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
        bind(self.kernel, "GetProcessTimes", wintypes.BOOL, [wintypes.HANDLE, *([ctypes.POINTER(wintypes.FILETIME)] * 4)])
        bind(self.user, "CreateDesktopW", wintypes.HANDLE,
             [wintypes.LPCWSTR, wintypes.LPCWSTR, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p])
        bind(self.user, "CloseDesktop", wintypes.BOOL, [wintypes.HANDLE])
        bind(self.user, "GetUserObjectInformationW", wintypes.BOOL,
             [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)])

    @staticmethod
    def _bind(library, name, result, arguments):
        function = getattr(library, name)
        function.restype, function.argtypes = result, arguments

    @staticmethod
    def error(action):
        return OSError(f"{action}: {ctypes.WinError(ctypes.get_last_error())}")


class _Desktop:
    def __init__(self, api, *, verify=True):
        self.api = api
        self.name = "pluto-capture-" + uuid.uuid4().hex
        # READOBJECTS | CREATEWINDOW | WRITEOBJECTS. No SWITCHDESKTOP right is
        # requested and the handle is not inheritable (NULL security attrs).
        self.handle = api.user.CreateDesktopW(self.name, None, None, 0, 0x83, None)
        if not self.handle:
            raise api.error("Could not create a separate capture desktop; no visible fallback")
        if verify:
            try:
                self.check()
            except BaseException:
                self.close()
                raise

    def check(self):
        if self.handle is None:
            raise RuntimeError("Capture desktop was closed")
        active, needed = wintypes.BOOL(), wintypes.DWORD()
        if not self.api.user.GetUserObjectInformationW(self.handle, 6, ctypes.byref(active),
                ctypes.sizeof(active), ctypes.byref(needed)):
            raise self.api.error("Could not verify capture desktop is non-input")
        if active.value:
            raise RuntimeError("Capture desktop is the input desktop; refusing execution")

    def close(self):
        if self.handle is not None:
            if not self.api.user.CloseDesktop(self.handle):
                raise self.api.error("Could not close capture desktop")
            self.handle = None


class IsolatedCaptureProcess:
    """Operations target retained process/job handles, never an unverified PID."""
    def __init__(self, api, process, job, desktop, pid, args, created):
        self._api, self._handle, self._job, self._desktop = api, process, job, desktop
        self.pid, self.args, self.process_created_at = pid, list(args), created
        self.desktop_name = desktop.name
        self.returncode = None

    def poll(self):
        if self.returncode is not None:
            return self.returncode
        status = self._api.kernel.WaitForSingleObject(self._handle, 0)
        if status == 0x102:
            return None
        if status != 0:
            raise self._api.error("Could not query owned capture process")
        code = wintypes.DWORD()
        if not self._api.kernel.GetExitCodeProcess(self._handle, ctypes.byref(code)):
            raise self._api.error("Could not read owned capture exit code")
        self.returncode = code.value
        return self.returncode

    def wait(self, timeout=5):
        if timeout is None or not math.isfinite(timeout) or not 0 <= timeout <= 90:
            raise ValueError("Owned wait requires a finite 0..90-second timeout")
        if self.returncode is not None:
            return self.returncode
        value = self._api.kernel.WaitForSingleObject(self._handle, math.ceil(timeout * 1000))
        if value == 0x102:
            raise subprocess.TimeoutExpired(self.args, timeout)
        if value != 0:
            raise self._api.error("Could not wait for owned capture process")
        return self.poll()

    def check_background(self):
        try:
            self._desktop.check()
        except BaseException:
            self.terminate()
            raise

    def terminate(self):
        if self._job is not None and not self._api.kernel.TerminateJobObject(self._job, 1):
            raise self._api.error("Could not terminate owned capture job")

    kill = terminate

    def close(self):
        # Do not close the desktop while a surviving child can still use it.
        if self._job is not None:
            if not self._api.kernel.CloseHandle(self._job):
                raise self._api.error("Could not close owned capture job")
            self._job = None
        if self._handle is not None:
            self.wait(timeout=5)
            if not self._api.kernel.CloseHandle(self._handle):
                raise self._api.error("Could not close owned capture handle")
            self._handle = None
        self._desktop.close()


def _launch_on_desktop(args, *, cwd, stdout, env, api=None, get_osfhandle=None, desktop=None):
    """Production passes a desktop created by a thread that already exited."""
    if get_osfhandle is None:
        from msvcrt import get_osfhandle
    api = api or _WindowsAPI()
    desktop = desktop or _Desktop(api)
    job = None
    info = _PROCESS_INFORMATION()
    initialized = False
    inherited = []
    attributes = None
    try:
        desktop.check()
        job = api.kernel.CreateJobObjectW(None, None)
        if not job:
            raise api.error("Could not create capture job")
        limits = _EXTENDED_LIMIT_INFORMATION()
        limits.BasicLimitInformation.LimitFlags = 0x2000
        if not api.kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            raise api.error("Could not enable kill-on-close capture job")
        parent = api.kernel.GetCurrentProcess()
        with open(os.devnull, "rb") as null_input:
            for stream in (null_input, stdout, stdout):
                duplicate = wintypes.HANDLE()
                if not api.kernel.DuplicateHandle(parent, get_osfhandle(stream.fileno()), parent,
                        ctypes.byref(duplicate), 0, True, 2):
                    raise api.error("Could not isolate diagnostic handles")
                inherited.append(duplicate.value)
        size = ctypes.c_size_t()
        api.kernel.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size))
        if not size.value:
            raise api.error("Could not size capture handle whitelist")
        attributes = ctypes.create_string_buffer(size.value)
        if not api.kernel.InitializeProcThreadAttributeList(attributes, 1, 0, ctypes.byref(size)):
            raise api.error("Could not initialize handle whitelist")
        initialized = True
        handles = (wintypes.HANDLE * len(inherited))(*inherited)
        if not api.kernel.UpdateProcThreadAttribute(attributes, 0, 0x00020002, handles,
                ctypes.sizeof(handles), None, None):
            raise api.error("Could not restrict inherited handles")
        startup = _STARTUPINFOEXW()
        startup.StartupInfo.cb = ctypes.sizeof(startup)
        startup.StartupInfo.lpDesktop = desktop.name
        startup.StartupInfo.dwFlags = 0x100 | 0x1 | 0x80  # explicit handles, hidden, no feedback cursor
        startup.StartupInfo.wShowWindow = 0
        startup.StartupInfo.hStdInput, startup.StartupInfo.hStdOutput, startup.StartupInfo.hStdError = inherited
        startup.lpAttributeList = ctypes.cast(attributes, ctypes.c_void_p)
        command = ctypes.create_unicode_buffer(subprocess.list2cmdline([os.fspath(x) for x in args]))
        environment = ctypes.create_unicode_buffer("\0".join(
            f"{key}={value}" for key, value in sorted(env.items(), key=lambda row: row[0].upper())) + "\0\0")
        # NO_WINDOW | EXTENDED_STARTUPINFO | UNICODE_ENVIRONMENT | SUSPENDED | BELOW_NORMAL.
        flags = 0x08000000 | 0x00080000 | 0x400 | 0x4 | 0x4000
        desktop.check()
        if not api.kernel.CreateProcessW(os.fspath(args[0]), command, None, None, True, flags,
                environment, os.fspath(cwd), ctypes.byref(startup), ctypes.byref(info)):
            raise api.error("Isolated capture launch failed; no visible fallback")
        if not api.kernel.AssignProcessToJobObject(job, info.hProcess):
            raise api.error("Could not own suspended capture process")
        times = [wintypes.FILETIME() for _ in range(4)]
        if not api.kernel.GetProcessTimes(info.hProcess, *(ctypes.byref(t) for t in times)):
            raise api.error("Could not establish capture creation identity")
        created = ((times[0].dwHighDateTime << 32) | times[0].dwLowDateTime) / 10_000_000 - 11644473600
        if created <= 0:
            raise RuntimeError("Invalid process creation time")
        desktop.check()
        if api.kernel.ResumeThread(info.hThread) == 0xffffffff:
            raise api.error("Could not resume owned isolated capture")
        api.kernel.CloseHandle(info.hThread)
        info.hThread = None
        process = IsolatedCaptureProcess(api, info.hProcess, job, desktop, info.dwProcessId, args, created)
        info.hProcess = None
        job = None
        desktop = None
        return process
    finally:
        if info.hProcess:
            api.kernel.TerminateProcess(info.hProcess, 1)
            api.kernel.WaitForSingleObject(info.hProcess, 5000)
            api.kernel.CloseHandle(info.hProcess)
        if info.hThread:
            api.kernel.CloseHandle(info.hThread)
        if job is not None:
            api.kernel.CloseHandle(job)
        if initialized:
            api.kernel.DeleteProcThreadAttributeList(attributes)
        for handle in inherited:
            api.kernel.CloseHandle(handle)
        if desktop is not None:
            desktop.close()


def launch_isolated_capture(args, *, cwd, stdout, env=None):
    """Prepare an owned native child on a fresh desktop. Never falls back.

    The separate desktop is created on a disposable thread, so any automatic
    desktop association never changes the caller's/UI thread's desktop.
    This function does not claim DirectX or SC2 protocol compatibility.
    """
    if os.name != "nt":
        raise RuntimeError("Only the reviewed Windows isolated-desktop path is supported")
    if not args or not os.path.isabs(os.fspath(args[0])) or stdout is None or not os.path.isabs(os.fspath(cwd)):
        raise ValueError("Absolute executable/cwd and explicit diagnostic stream are required")
    result, errors = [], []

    def create_desktop():
        try:
            api = _WindowsAPI()
            # Validate/close only after this thread exits: a thread-associated
            # desktop cannot be closed while its creating thread still uses it.
            result.append((api, _Desktop(api, verify=False)))
        except BaseException as error:
            errors.append(error)

    thread = threading.Thread(target=create_desktop, name="isolated-capture-desktop")
    thread.start()
    # CreateProcess can block inside the OS. A parent wall-time supervisor must
    # own this entire child launcher process; never abandon a launcher thread.
    thread.join()
    if errors:
        raise errors[0]
    api, desktop = result[0]
    return _launch_on_desktop(args, cwd=cwd, stdout=stdout, env=dict(os.environ) if env is None else env,
                              api=api, desktop=desktop)
