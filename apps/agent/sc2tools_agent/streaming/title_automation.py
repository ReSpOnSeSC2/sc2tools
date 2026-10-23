"""One bounded, independent worker for post-sync title refreshes."""
from __future__ import annotations

from datetime import datetime, timezone
import math
import threading
import time

REFRESH_SECONDS = 10 * 60
REPLAY_MATCH_SECONDS = 120


class GameTitleAutomation:
    def __init__(self, refresh, *, clock=time.time, last_attempt=0):
        self.refresh, self.clock = refresh, clock
        self.last_attempt = (min(last_attempt, clock()) if isinstance(last_attempt, (int, float))
                             and not isinstance(last_attempt, bool) and math.isfinite(last_attempt) else 0)
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.stop_event = threading.Event()
        self.thread = None
        self.pending = None
        self.ready = False
        self.seen = []
        self.preview_pending = True

    def on_event(self, event):
        if (getattr(event, "phase", None) != "match_ended"
                or getattr(getattr(event, "game_state", None), "is_replay", True)):
            return
        key = getattr(event, "game_key", None)
        if not isinstance(key, str) or not key:
            return
        with self.lock:
            if key in self.seen:
                return
            self.seen = (self.seen + [key])[-32:]
            self.pending = float(event.captured_at)
            self.ready = False

    def on_game_accepted(self, _path, game, *_accepted):
        # UploadQueue invokes this only after a priority/live replay is accepted.
        # date_iso is the replay END timestamp. History and resumed branches
        # must not authorize an update for the pending live match.
        if getattr(game, "is_resumed_from_replay", False):
            return
        try:
            ended = datetime.fromisoformat(game.date_iso.replace("Z", "+00:00"))
            ended = ended.replace(tzinfo=timezone.utc) if ended.tzinfo is None else ended
            ended_at = ended.timestamp()
        except (AttributeError, TypeError, ValueError):
            return
        with self.lock:
            if self.pending is None or abs(ended_at - self.pending) > REPLAY_MATCH_SECONDS:
                return
            self.ready = True
        self.wake.set()

    def run_once(self):
        """Claim work without holding the lock during network/provider calls."""
        with self.lock:
            if self.stop_event.is_set():
                return False
            preview = self.preview_pending
            self.preview_pending = False
            elapsed = self.clock() - self.last_attempt
            automatic = self.ready and elapsed >= REFRESH_SECONDS
            if automatic:
                self.ready = False
                self.pending = None
                self.last_attempt = self.clock()
            if not preview and not automatic:
                return False
        self.refresh(automatic)
        return True

    def start(self):
        if self.thread and self.thread.is_alive():
            return
        self.stop_event.clear()
        self.thread = threading.Thread(target=self._run, name="sc2tools-stream-titles", daemon=True)
        self.thread.start()

    def _run(self):
        while not self.stop_event.is_set():
            self.wake.clear()
            try:
                self.run_once()
            except Exception:
                # The service publishes a scrubbed error; providers are never
                # retried automatically on an ambiguous write receipt.
                pass
            self.wake.wait(1)

    def close(self):
        self.stop_event.set()
        self.wake.set()
        if self.thread and self.thread is not threading.current_thread():
            self.thread.join(timeout=4)
