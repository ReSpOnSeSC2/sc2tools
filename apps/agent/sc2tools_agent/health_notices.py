"""One tray toast when a health problem first appears, held while a match runs.

The status card shows every problem, but autostart keeps the window hidden in
the tray, so an unlink, a startup failure, an analyzer that didn't load, an
update that couldn't install, an OBS password OBS rejected or a missing replay
folder could go unnoticed for days. Each of those rows toasts once when it
first turns into a warning or an error. After it clears, the same sentence
toasts again only a day later (an update that keeps failing is retried every
12 hours, for example), while a new sentence toasts at once. A problem must
last ``SETTLE_SEC`` first, so a startup
moment never toasts, and every problem that is due at the same time shares one
toast. Nothing toasts while a match runs; held toasts go out after the match
if their problem is still there. Qt-free and stdlib-only, like ``health``.
"""
from __future__ import annotations

import logging
import threading
import time

from .health import UNLINKED_SENTENCE

log = logging.getLogger(__name__)

NOTIFY_ROW_IDS = frozenset({"boot", "analyzer", "updates", "obs", "folders"})
SETTLE_SEC = 20.0
RECHECK_SEC = 15.0
REPEAT_SEC = 24 * 3600.0  # the same problem, cleared and back, toasts again after a day
TITLE = "SC2 Tools needs attention"
MAX_MESSAGE = 255  # Windows notification body limit, in UTF-16 units


def problem_rows(snapshot):
    """The rows that toast, keyed by a stable id, worst first."""
    found = {}
    for row in getattr(snapshot, "rows", ()) or ():
        if row.level not in ("warn", "error"):
            continue
        if row.id in NOTIFY_ROW_IDS:
            found.setdefault(row.id, row)
        elif row.id == "pairing" and row.sentence == UNLINKED_SENTENCE:
            found.setdefault("unlinked", row)
    return found


def toast_message(rows):
    """The first problem's sentence, plus how many more the window shows."""
    first, more = rows[0].sentence, len(rows) - 1
    message = first if not more else f"{first} Open SC2 Tools to see {more} more."
    return fit_utf16(message, MAX_MESSAGE)


def fit_utf16(text, limit):
    """Trim ``text`` to ``limit`` UTF-16 units, ending with an ellipsis when cut."""
    if len(text.encode("utf-16-le")) // 2 <= limit:
        return text
    while text and len((text + "…").encode("utf-16-le")) // 2 > limit:
        text = text[:-1]
    return text.rstrip() + "…"


def _start_timer(delay, callback):
    timer = threading.Timer(delay, callback)
    timer.name, timer.daemon = "sc2tools-health-notice", True
    timer.start()
    return timer


class HealthNotices:
    """Subscribe ``on_health`` to a HealthMonitor; ``notify(message)`` shows the toast."""

    def __init__(self, *, notify, busy=lambda: False, clock=time.monotonic, schedule=_start_timer,
                 settle=SETTLE_SEC, recheck=RECHECK_SEC, repeat=REPEAT_SEC):
        self._notify, self._busy, self._clock, self._schedule = notify, busy, clock, schedule
        self._settle, self._recheck, self._repeat = settle, recheck, repeat
        self._toasted = {}  # (key, sentence) -> when it last toasted
        self._lock = threading.Lock()
        self._active = {}  # key -> (row, first seen)
        self._order = ()  # keys in the newest snapshot's order
        self._announced = set()
        self._timer = None
        self._closed = False

    def on_health(self, snapshot):
        rows = problem_rows(snapshot)
        now = self._clock()
        with self._lock:
            for key in [key for key in self._active if key not in rows]:
                del self._active[key]
                self._announced.discard(key)  # cleared: a return toasts again
            for key, row in rows.items():
                previous = self._active.get(key)
                self._active[key] = (row, previous[1] if previous else now)
            self._order = tuple(rows)
        self._deliver()

    def close(self):
        with self._lock:
            self._closed = True
            timer, self._timer = self._timer, None
        if timer is not None and hasattr(timer, "cancel"):
            timer.cancel()

    def _deliver(self):
        now = self._clock()
        with self._lock:
            if self._closed:
                return
            waiting = [key for key in self._order if key in self._active and key not in self._announced]
            due = [key for key in waiting if now - self._active[key][1] >= self._settle]
            if due and self._is_busy():
                self._arm(self._recheck)  # after the match
                return
            self._toasted = {seen: at for seen, at in self._toasted.items() if now - at < self._repeat}
            rows = []
            for key in due:
                row = self._active[key][0]
                if (key, row.sentence) not in self._toasted:
                    rows.append(row)
                    self._toasted[(key, row.sentence)] = now
            self._announced.update(due)
            later = [self._active[key][1] + self._settle - now for key in waiting if key not in due]
            if later:
                self._arm(max(0.05, min(later)))
        if rows:
            try:
                self._notify(toast_message(rows))
            except Exception:  # noqa: BLE001 - a toast must never break health delivery
                log.warning("health_notice_failed", exc_info=True)

    def _is_busy(self):
        try:
            return bool(self._busy())
        except Exception:  # noqa: BLE001 - unknown means no match is known to be running
            return False

    def _arm(self, delay):
        """One pending re-check at a time; the caller holds the lock."""
        if self._timer is not None:
            return
        try:
            self._timer = self._schedule(delay, self._fire)
        except Exception:  # noqa: BLE001
            self._timer = None
            log.debug("health_notice_schedule_failed", exc_info=True)

    def _fire(self):
        with self._lock:
            self._timer = None
        self._deliver()


__all__ = ["HealthNotices", "NOTIFY_ROW_IDS", "TITLE", "fit_utf16", "problem_rows", "toast_message"]
