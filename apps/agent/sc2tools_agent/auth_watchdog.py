"""Confirm device revocation without treating a single failure as unlinking."""
from __future__ import annotations

import threading
from typing import Callable

from .api_client import DeviceUnauthorized

_UNSET = object()


class AuthWatchdog:
    def __init__(self, *, get_api: Callable, on_unlinked: Callable[[], None],
                 get_epoch: Callable | None = None, on_unlinked_current: Callable | None = None) -> None:
        self._get_api = get_api
        self._get_epoch = get_epoch or (lambda: None)
        self._on_unlinked = on_unlinked
        self._on_unlinked_current = on_unlinked_current
        self._lock = threading.Lock()
        self._failures = 0
        self._confirming = False
        self._confirmation = None
        self._failure_context = None
        self._counter_generation = 0
        self._unlinked = False

    def _current(self, api, epoch):
        try:
            return (self._get_api() is api and self._get_epoch() is epoch
                and self._get_api() is api)
        except Exception:
            return False

    def _context(self, api, epoch):
        try:
            if api is _UNSET:
                api = self._get_api()
            if epoch is _UNSET:
                epoch = self._get_epoch()
        except Exception:
            return None
        return (api, epoch) if self._current(api, epoch) else None

    def _matches(self, context):
        return (self._failure_context is not None
            and self._failure_context[0] is context[0] and self._failure_context[1] is context[1])

    def success(self, *, api=_UNSET, epoch=_UNSET) -> None:
        context = self._context(api, epoch)
        if context is None:
            return
        with self._lock:
            if self._matches(context):
                self._failures = 0
                self._counter_generation += 1

    def reset(self) -> None:
        with self._lock:
            self._failures = 0
            self._failure_context = None
            self._unlinked = False
            self._counter_generation += 1
            # The actual old request still owns its confirmation reservation.

    def failure(self, exc: Exception, *, api=_UNSET, epoch=_UNSET) -> None:
        context = self._context(api, epoch)
        if context is None:
            return
        api, epoch = context
        while True:
            with self._lock:
                generation = self._counter_generation
            if not self._current(api, epoch):
                return
            with self._lock:
                if generation != self._counter_generation:
                    continue  # Revalidate externally; never take STATE under this lock.
                self._counter_generation += 1
                if not self._matches(context):
                    self._failure_context = context
                    self._failures = 0
                    self._unlinked = False
                if not isinstance(exc, DeviceUnauthorized):
                    self._failures = 0
                    return
                self._failures += 1
                if self._failures < 2 or self._confirming or self._unlinked:
                    return
                self._confirming = True
                reservation = self._confirmation = object()
                break
        try:
            if not self._current(api, epoch):
                return
            try:
                api.get_profile()
            except DeviceUnauthorized:
                denied, healthy = True, False
            except Exception:
                denied = healthy = False  # An outage is not proof of revocation.
            else:
                denied, healthy = False, True
            if denied and self._current(api, epoch):
                if self._on_unlinked_current is None:
                    with self._lock:
                        if not self._matches(context):
                            return
                        self._unlinked = True
                    self._on_unlinked()
                elif self._on_unlinked_current(api, epoch) is True:
                    with self._lock:
                        if self._matches(context) and self._confirmation is reservation:
                            self._unlinked = True
            elif healthy:
                self.success(api=api, epoch=epoch)
        finally:
            with self._lock:
                if self._confirmation is reservation:
                    self._confirmation = None
                    self._confirming = False
