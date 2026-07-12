"""Cross-platform single-instance guard for the desktop agent.

The replay watcher, uploader, and Live Game Bridge are process-wide
services. Running two main agents against the same state directory
duplicates uploads and gives one SC2 match two independently generated
``gameKey`` values, which makes start-of-game overlay widgets re-arm.

Windows uses a named kernel mutex, so crashes cannot leave a stale lock.
POSIX uses ``flock`` on a state-directory file for development and CI.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import IO, Optional


class AgentInstanceLock:
    """Hold exclusive ownership of one agent state directory."""

    def __init__(self, state_dir: Path) -> None:
        self._state_dir = Path(state_dir).resolve()
        self._windows_handle: Optional[int] = None
        self._posix_file: Optional[IO[str]] = None

    def acquire(self) -> bool:
        """Return ``False`` when another main agent already owns the lock."""
        if self.acquired:
            return True
        if os.name == "nt":
            return self._acquire_windows()
        return self._acquire_posix()

    @property
    def acquired(self) -> bool:
        return self._windows_handle is not None or self._posix_file is not None

    def release(self) -> None:
        """Release the lock. Safe to call more than once."""
        if self._windows_handle is not None:
            _close_windows_handle(self._windows_handle)
            self._windows_handle = None
        if self._posix_file is not None:
            _unlock_posix_file(self._posix_file)
            self._posix_file = None

    def _acquire_windows(self) -> bool:
        handle = _create_windows_mutex(_mutex_name(self._state_dir))
        if handle is None:
            return False
        self._windows_handle = handle
        return True

    def _acquire_posix(self) -> bool:
        import fcntl

        self._state_dir.mkdir(parents=True, exist_ok=True)
        lock_file = open(
            self._state_dir / ".agent-instance.lock",
            "a+",
            encoding="utf-8",
        )
        try:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            lock_file.close()
            return False
        lock_file.seek(0)
        lock_file.truncate()
        lock_file.write(str(os.getpid()))
        lock_file.flush()
        self._posix_file = lock_file
        return True


def _mutex_name(state_dir: Path) -> str:
    identity = str(state_dir).casefold().encode("utf-8")
    digest = hashlib.sha256(identity).hexdigest()[:24]
    return f"Local\\SC2ToolsAgent-{digest}"


def _create_windows_mutex(name: str) -> Optional[int]:
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    create_mutex = kernel32.CreateMutexW
    create_mutex.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
    create_mutex.restype = wintypes.HANDLE
    handle = create_mutex(None, False, name)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    if ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
        _close_windows_handle(int(handle))
        return None
    return int(handle)


def _close_windows_handle(handle: int) -> None:
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    close_handle = kernel32.CloseHandle
    close_handle.argtypes = [wintypes.HANDLE]
    close_handle.restype = wintypes.BOOL
    close_handle(handle)


def _unlock_posix_file(lock_file: IO[str]) -> None:
    import fcntl

    try:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
    finally:
        lock_file.close()


__all__ = ["AgentInstanceLock"]
