"""Confirm device revocation without treating a single failure as unlinking."""
from __future__ import annotations

import threading
from typing import Callable

from .api_client import DeviceUnauthorized


class AuthWatchdog:
    def __init__(self, *, get_api: Callable, on_unlinked: Callable[[], None]) -> None:
        self._get_api = get_api
        self._on_unlinked = on_unlinked
        self._lock = threading.Lock()
        self._failures = 0
        self._confirming = False
        self._unlinked = False

    def success(self) -> None:
        with self._lock:
            self._failures = 0

    def reset(self) -> None:
        with self._lock:
            self._failures = 0
            self._unlinked = False

    def failure(self, exc: Exception) -> None:
        with self._lock:
            if not isinstance(exc, DeviceUnauthorized):
                self._failures = 0
                return
            self._failures += 1
            if self._failures < 2 or self._confirming or self._unlinked:
                return
            self._confirming = True
        try:
            self._get_api().get_profile()
        except DeviceUnauthorized:
            with self._lock:
                self._unlinked = True
            self._on_unlinked()
        except Exception:
            pass  # An outage during confirmation is not proof of revocation.
        else:
            self.success()
        finally:
            with self._lock:
                self._confirming = False
