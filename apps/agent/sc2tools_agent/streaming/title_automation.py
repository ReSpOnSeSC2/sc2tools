"""One bounded, independent worker for post-sync title refreshes."""
from __future__ import annotations

from datetime import datetime, timezone
import math
import threading
import time

REFRESH_SECONDS = 10 * 60
REPLAY_MATCH_SECONDS = 120
MAX_ACCEPTED_RECEIPTS = 4


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
        self.accepted_receipts = []
        self.consumed_receipts = []
        self.preview_pending = True

    def reset(self):
        """Discard all queued work when its paired owner/connection changes."""
        with self.lock:
            self.last_attempt = 0
            self.pending = None
            self.ready = False
            self.seen = []
            self.accepted_receipts = []
            self.consumed_receipts = []
            self.preview_pending = True
        self.wake.set()

    def _remember_consumed(self, ended_at):
        self.consumed_receipts = (self.consumed_receipts + [ended_at])[-32:]
        self.accepted_receipts = [row for row in self.accepted_receipts if row[0] != ended_at]

    def on_event(self, event):
        if (getattr(event, "phase", None) != "match_ended"
                or getattr(getattr(event, "game_state", None), "is_replay", True)):
            return
        key = getattr(event, "game_key", None)
        if not isinstance(key, str) or not key:
            return
        try:
            captured = float(event.captured_at)
        except (ValueError, TypeError, AttributeError):
            return
        if not math.isfinite(captured):
            return
        with self.lock:
            if key in self.seen:
                return
            self.seen = (self.seen + [key])[-32:]
            self.pending = captured
            self.ready = False
            self.accepted_receipts = [row for row in self.accepted_receipts
                if abs(self.clock() - row[1]) <= REPLAY_MATCH_SECONDS]
            matches = [row[0] for row in self.accepted_receipts
                if abs(row[0] - captured) <= REPLAY_MATCH_SECONDS]
            if matches:
                self._remember_consumed(min(matches, key=lambda end: abs(end - captured)))
                self.ready = True
        self.wake.set()

    def on_game_accepted(self, _path, game, *_accepted):
        # UploadQueue invokes this only after a priority/live replay is accepted.
        # date_iso is the replay END timestamp. History and resumed branches
        # must not authorize an update for the pending live match.
        row = _accepted[1] if len(_accepted) > 1 and isinstance(_accepted[1], dict) else {}
        if (getattr(game, "is_resumed_from_replay", False) or getattr(game, "is_history", False)
                or row.get("isHistory") is True):
            return
        try:
            ended = datetime.fromisoformat(game.date_iso.replace("Z", "+00:00"))
            ended = ended.replace(tzinfo=timezone.utc) if ended.tzinfo is None else ended
            ended_at = ended.timestamp()
        except (AttributeError, TypeError, ValueError):
            return
        with self.lock:
            if self.stop_event.is_set() or ended_at in self.consumed_receipts:
                return
            if self.pending is not None and abs(ended_at - self.pending) <= REPLAY_MATCH_SECONDS:
                self._remember_consumed(ended_at)
                self.ready = True
            elif abs(self.clock() - ended_at) <= REPLAY_MATCH_SECONDS:
                # A fast live upload can beat the next lifecycle poll. Retain
                # only a few fresh receipts until its game-end event arrives.
                self.accepted_receipts = [entry for entry in self.accepted_receipts
                    if entry[0] != ended_at and abs(self.clock() - entry[1]) <= REPLAY_MATCH_SECONDS]
                self.accepted_receipts = (self.accepted_receipts + [(ended_at, self.clock())])[-MAX_ACCEPTED_RECEIPTS:]
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
