"""One game-start title claim, driven by the existing title worker.

Lifecycle callbacks only update small in-memory state. Reads and provider calls
run on the title worker, with a claim that becomes invalid as soon as play ends
or another match replaces it.
"""
from __future__ import annotations

import math
import threading

START_DELAY_SECONDS = 3
RETRY_SECONDS = 5
START_WINDOW_SECONDS = 60
ACTIVE_PHASES = {"match_loading", "match_started", "match_in_progress"}
TERMINAL_PHASES = {"match_ended", "menu", "idle"}


def game_episode(key):
    # Loading identities can be corrected without starting a new game. The
    # poller's millisecond start anchor remains stable across that correction.
    suffix = key.rsplit("|", 1)[-1]
    return suffix if len(suffix) >= 12 and suffix.isascii() and suffix.isdigit() else key


class MatchTitleAutomation:
    def __init__(self, refresh, *, clock, wake, stop_event):
        self.refresh, self.clock = refresh, clock
        self.wake, self.stop_event = wake, stop_event
        self.lock = threading.Lock()
        self.enabled = False
        self.key = None
        self.generation = 0
        self.captured_at = float("-inf")
        self.pending = None
        self.inflight = None
        self.seen = []

    def configure(self, enabled):
        with self.lock:
            self.enabled = enabled is True
            if not self.enabled:
                self.pending = None
                self.generation += 1
        self.wake.set()

    def reset(self):
        with self.lock:
            self.enabled = False
            self.key = None
            self.pending = None
            self.inflight = None
            self.seen = []
            self.generation += 1
            self.captured_at = float("-inf")

    def current_key(self):
        with self.lock:
            return self.key

    def is_current(self, key, generation):
        with self.lock:
            return (not self.stop_event.is_set() and self.enabled
                    and self.key == key and self.generation == generation)

    def on_event(self, event):
        phase = getattr(event, "phase", None)
        if phase not in ACTIVE_PHASES | TERMINAL_PHASES:
            return
        captured = getattr(event, "captured_at", None)
        if type(captured) not in (int, float) or not math.isfinite(captured):
            return
        now = self.clock()
        if abs(now - captured) > START_WINDOW_SECONDS * 2:
            return
        key = getattr(event, "game_key", None)
        game = getattr(event, "game_state", None)
        with self.lock:
            if captured < self.captured_at:
                return
            if phase == "match_ended" and self.key is not None and key != self.key:
                return
            self.captured_at = captured
            if (phase in TERMINAL_PHASES or not isinstance(key, str) or not key or len(key) > 300
                    or game is None or getattr(game, "is_replay", True)
                    or getattr(game, "is_observer", False)):
                self.key = None
                self.pending = None
                self.generation += 1
                return
            players = getattr(game, "players", [])
            humans = len(players) == 2 and all(getattr(player, "type", None) == "user" for player in players)
            same_team = (humans and getattr(players[0], "team_id", None) is not None
                         and players[0].team_id == getattr(players[1], "team_id", None))
            decided = any(getattr(player, "is_decided", False) for player in players)
            if not humans or same_team or decided:
                if self.pending is not None or self.inflight is not None:
                    self.seen = [episode for episode in self.seen if episode != game_episode(key)]
                self.key = None
                self.pending = None
                self.generation += 1
                return
            if self.key != key:
                previous = self.pending or self.inflight
                same_episode = self.key is not None and game_episode(self.key) == game_episode(key)
                self.key = key
                self.generation += 1
                self.pending = ({**previous, "key": key, "generation": self.generation}
                                if same_episode and previous is not None else None)
            # Partial loading telemetry can fill in on the next lifecycle tick.
            display_time = getattr(game, "display_time", None)
            early = type(display_time) in (int, float) and 0 <= display_time <= START_WINDOW_SECONDS
            episode = game_episode(key)
            if self.enabled and self.refresh is not None and humans and early and episode not in self.seen:
                self.seen = (self.seen + [episode])[-32:]
                self.pending = {"key": key, "generation": self.generation,
                                "due": now + START_DELAY_SECONDS, "deadline": now + START_WINDOW_SECONDS,
                                "attempts": 0}
        self.wake.set()

    def run_once(self):
        with self.lock:
            pending = self.pending
            if (self.stop_event.is_set() or not self.enabled or pending is None
                    or self.clock() < pending["due"]):
                return False
            claim = dict(pending)
            self.pending = None
            self.inflight = claim
        final = self.clock() >= claim["deadline"]
        consumed = True
        try:
            consumed = self.refresh(claim["key"], claim["generation"], final)
        finally:
            with self.lock:
                if self.inflight is claim:
                    self.inflight = None
        with self.lock:
            if (not consumed and not final and self.enabled and not self.stop_event.is_set()
                    and self.key == claim["key"] and self.generation == claim["generation"]):
                delay = RETRY_SECONDS * 2 ** min(claim["attempts"], 2)
                self.pending = {**claim, "due": min(claim["deadline"], self.clock() + delay),
                                "attempts": claim["attempts"] + 1}
        return True
