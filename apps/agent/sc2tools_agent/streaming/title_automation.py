"""One independent worker for game-start and post-sync title refreshes."""
from __future__ import annotations

from datetime import datetime, timezone
import math
import threading
import time
from typing import NamedTuple

from ..live.types import _battle_tag_stem

REFRESH_SECONDS = 10 * 60
REPLAY_MATCH_SECONDS = 120
MAX_ACCEPTED_RECEIPTS = 4


class _AcceptedReplay(NamedTuple):
    ended_at: float
    received_at: float
    game_id: str | None
    opponent: str


class GameTitleAutomation:
    def __init__(self, refresh, *, clock=time.time, last_attempt=0, refresh_match=None):
        self.refresh, self.clock = refresh, clock
        self.last_attempt = (min(last_attempt, clock()) if isinstance(last_attempt, (int, float))
                             and not isinstance(last_attempt, bool) and math.isfinite(last_attempt) else 0)
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.stop_event = threading.Event()
        self.thread = None
        self.pending = None
        self._pending_roster = ()
        self.ready = False
        self.ready_game_id = None
        self.seen = []
        self.accepted_receipts = []
        self.consumed_receipts = []
        self.preview_pending = True
        self._sync_generation = 0
        self._observed_live_key = None
        from .title_match import MatchTitleAutomation
        self.match = MatchTitleAutomation(refresh_match, clock=lambda: self.clock(),
                                         wake=self.wake, stop_event=self.stop_event)

    def reset(self):
        """Discard all queued work when its paired owner/connection changes."""
        with self.lock:
            self.last_attempt = 0
            self.pending = None
            self._pending_roster = ()
            self.ready = False
            self.ready_game_id = None
            self.seen = []
            self.accepted_receipts = []
            self.consumed_receipts = []
            self.preview_pending = True
            self._sync_generation += 1
            self._observed_live_key = None
        self.wake.set()
        self.match.reset()

    def _remember_consumed(self, receipt):
        self.consumed_receipts = (self.consumed_receipts + [receipt.ended_at])[-32:]
        self.accepted_receipts = [row for row in self.accepted_receipts if row.ended_at != receipt.ended_at]
        self.ready = True
        self.ready_game_id = receipt.game_id
        self._sync_generation += 1

    def _matches_pending(self, receipt):
        return (self.pending is not None and abs(receipt.ended_at - self.pending) <= REPLAY_MATCH_SECONDS
                and (not self._pending_roster or not receipt.opponent or receipt.opponent in self._pending_roster))

    def _sync_is_current(self, generation):
        with self.lock, self.match.lock:
            return (not self.stop_event.is_set() and self._sync_generation == generation
                    and (not self.match.enabled or self.match.key is None))

    def on_event(self, event):
        self.match.on_event(event)
        with self.lock, self.match.lock:
            # Menu ticks do not retire a post-sync read. A new live title can.
            if self.match.enabled and self.match.key is not None and self.match.key != self._observed_live_key:
                self._observed_live_key = self.match.key
                self._sync_generation += 1
        game = getattr(event, "game_state", None)
        if (getattr(event, "phase", None) != "match_ended" or getattr(game, "is_replay", True)
                or getattr(game, "is_observer", False)):
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
        # A previous game's delayed upload can be inside the end-time window.
        # Use the live names when the entire human 1v1 roster is available.
        players = getattr(game, "players", ())
        roster = tuple(_battle_tag_stem(player.name) for player in players
                       if getattr(player, "type", None) == "user" and isinstance(getattr(player, "name", None), str))
        with self.lock:
            if key in self.seen:
                return
            self.seen = (self.seen + [key])[-32:]
            self.pending = captured
            self._pending_roster = roster if len(players) == len(roster) == 2 and all(roster) else ()
            self.ready = False
            self.ready_game_id = None
            self._sync_generation += 1
            self.accepted_receipts = [row for row in self.accepted_receipts
                if abs(self.clock() - row.received_at) <= REPLAY_MATCH_SECONDS]
            matches = [row for row in self.accepted_receipts if self._matches_pending(row)]
            if matches:
                self._remember_consumed(min(matches, key=lambda row: abs(row.ended_at - captured)))
        self.wake.set()

    def on_game_accepted(self, _path, game, game_id=None, row=None):
        # UploadQueue invokes this only after a priority/live replay is accepted.
        # date_iso is the replay END timestamp. History and resumed branches
        # must not authorize an update for the pending live match.
        row = row if isinstance(row, dict) else {}
        if (getattr(game, "is_resumed_from_replay", False) or getattr(game, "is_history", False)
                or row.get("isHistory") is True):
            return
        try:
            ended = datetime.fromisoformat(game.date_iso.replace("Z", "+00:00"))
            ended = ended.replace(tzinfo=timezone.utc) if ended.tzinfo is None else ended
            ended_at = ended.timestamp()
        except (AttributeError, TypeError, ValueError):
            return
        if (not isinstance(game_id, str) or not game_id or len(game_id) > 200
                or game_id != game_id.strip() or any(ord(char) < 32 or ord(char) == 127 for char in game_id)):
            game_id = None
        opponent = getattr(game, "opponent", None)
        name = opponent.get("displayName") if isinstance(opponent, dict) else None
        with self.lock:
            if self.stop_event.is_set() or ended_at in self.consumed_receipts:
                return
            received_at = self.clock()
            receipt = _AcceptedReplay(ended_at, received_at, game_id, _battle_tag_stem(name) if isinstance(name, str) else "")
            if self._matches_pending(receipt):
                self._remember_consumed(receipt)
            elif abs(received_at - ended_at) <= REPLAY_MATCH_SECONDS:
                # A fast live upload can beat the next lifecycle poll. Retain
                # only a few fresh receipts until its game-end event arrives.
                self.accepted_receipts = [entry for entry in self.accepted_receipts
                    if entry.ended_at != ended_at and abs(received_at - entry.received_at) <= REPLAY_MATCH_SECONDS]
                self.accepted_receipts = (self.accepted_receipts + [receipt])[-MAX_ACCEPTED_RECEIPTS:]
        self.wake.set()

    def run_once(self):
        """Claim work without holding the lock during network/provider calls."""
        match_ran = self.match.run_once()
        with self.lock, self.match.lock:
            if self.stop_event.is_set():
                return False
            preview = self.preview_pending
            self.preview_pending = False
            elapsed = self.clock() - self.last_attempt
            automatic = self.ready and elapsed >= REFRESH_SECONDS
            game_id = self.ready_game_id if automatic else None
            generation = self._sync_generation if not self.match.enabled or self.match.key is None else None
            if automatic:
                self.ready = False
                self.ready_game_id = None
                self.pending = None
                self._pending_roster = ()
                self.last_attempt = self.clock()
            if not preview and not automatic:
                return match_ran
        if game_id is None:
            self.refresh(automatic)
        else:
            self.refresh(automatic, game_id=game_id, valid=lambda: self._sync_is_current(generation))
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
