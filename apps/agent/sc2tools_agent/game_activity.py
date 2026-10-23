"""A shared, bounded hold for work that must not interrupt ladder games."""
import os
import threading
import time


class GameActivityGate:
    def __init__(self, *, enabled=True, clock=time.monotonic):
        self.enabled, self.clock = enabled, clock
        self._lock = threading.RLock()
        self._started = None
        self._last_event = None
        self._release_at = None
        self._free_since = clock() - (120 if not enabled else 0)
        self._safety_released = False

    def on_event(self, event):
        if not self.enabled:
            return
        phase = getattr(getattr(event, "phase", event), "value", getattr(event, "phase", event))
        now = self.clock()
        with self._lock:
            self._last_event = now
            if phase in ("match_loading", "match_started", "match_in_progress"):
                if not self._safety_released:
                    if self._started is None:
                        self._started = now
                    self._release_at = None
            elif phase in ("match_ended", "menu", "idle"):
                self._safety_released = False
                if self._started is not None and self._release_at is None:
                    self._release_at = now + 20

    def _update(self):
        now = self.clock()
        if self._started is None:
            return
        stale = self._last_event is not None and now - self._last_event >= 120
        maximum = now - self._started >= 2700
        ended = self._release_at is not None and now >= self._release_at
        if stale or maximum or ended:
            deadlines = [self._started + 2700]
            if self._last_event is not None:
                deadlines.append(self._last_event + 120)
            if self._release_at is not None:
                deadlines.append(self._release_at)
            self._free_since = min(deadlines)
            self._started = None
            self._release_at = None
            self._safety_released = maximum

    @property
    def busy(self):
        with self._lock:
            self._update()
            return self.enabled and self._started is not None

    @property
    def free_for(self):
        with self._lock:
            self._update()
            return 0 if self._started is not None else max(0, self.clock() - self._free_since)


def background_workers(mode, maximum, cpu=None):
    cpu = max(1, cpu or os.cpu_count() or 1)
    if mode == "gentle":
        return min(2, cpu)
    if mode == "maximum":
        return max(1, min(maximum, cpu))
    return min(4, cpu)


def lower_worker_priority(mode="balanced", process=True):
    try:
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            if process:
                kernel.GetCurrentProcess.restype = wintypes.HANDLE
                kernel.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
                kernel.SetPriorityClass(kernel.GetCurrentProcess(), 0x40 if mode == "gentle" else 0x4000)
            else:
                kernel.GetCurrentThread.restype = wintypes.HANDLE
                kernel.SetThreadPriority.argtypes = [wintypes.HANDLE, ctypes.c_int]
                kernel.SetThreadPriority(kernel.GetCurrentThread(), -15 if mode == "gentle" else -1)
        else:
            os.nice(10)
    except (OSError, AttributeError):
        pass  # A refused scheduling hint cannot stop replay processing.


def on_battery():
    if os.name != "nt":
        from pathlib import Path
        for supply in Path("/sys/class/power_supply").glob("*"):
            try:
                if (supply / "type").read_text().strip() == "Mains":
                    return (supply / "online").read_text().strip() == "0"
            except OSError:
                continue
        return False
    try:
        import ctypes
        class Power(ctypes.Structure):
            _fields_ = [("ac", ctypes.c_ubyte), ("flag", ctypes.c_ubyte),
                        ("percent", ctypes.c_ubyte), ("reserved", ctypes.c_ubyte),
                        ("life", ctypes.c_ulong), ("full", ctypes.c_ulong)]
        power = Power()
        return bool(ctypes.windll.kernel32.GetSystemPowerStatus(ctypes.byref(power))) and power.ac == 0
    except (OSError, AttributeError):
        return False
