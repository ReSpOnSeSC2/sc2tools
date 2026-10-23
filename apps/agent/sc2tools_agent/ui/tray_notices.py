"""Thread-safe expiry and per-message toast deduplication for the native tray."""
from datetime import datetime, timezone
import threading
from ..updater import notice_is_current


class TrayNotices:
    def __init__(self, *, notify, refresh):
        self.notify, self.refresh = notify, refresh
        self.current = None
        self.seen = []
        self.timer = None
        self.lock = threading.Lock()

    def apply(self, notice):
        with self.lock:
            if self.timer:
                self.timer.cancel()
                self.timer = None
            self.current = notice if notice_is_current(notice) else None
            current = self.current
            should_notify = bool(current and current.hash not in self.seen)
            if should_notify:
                self.seen = (self.seen + [current.hash])[-64:]
            if current:
                ends = datetime.fromisoformat(current.ends_at.replace("Z", "+00:00"))
                delay = max(.05, (ends-datetime.now(timezone.utc)).total_seconds()+.05)
                self.timer = threading.Timer(delay, lambda: self.expire(current.hash))
                self.timer.daemon = True
                self.timer.start()
        if should_notify:
            self.notify(current.message, title="SC2 Tools service notice")
        self.refresh()

    def expire(self, key):
        with self.lock:
            if self.current is None or self.current.hash != key or notice_is_current(self.current):
                return
            self.current = None
            self.timer = None
        self.refresh()

    def stop(self):
        with self.lock:
            if self.timer:
                self.timer.cancel()
                self.timer = None
