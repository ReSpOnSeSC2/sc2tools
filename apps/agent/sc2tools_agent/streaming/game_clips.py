"""One OBS replay-buffer clip per finished game, named from the game.

A game's end (its result known, never during play) saves the buffer. The
buffer only holds the last seconds the streamer set in OBS, so a clip is the
ending, and it must be saved at once. The game's facts come later, when its
replay syncs, so the saved file waits for them and is renamed into the
Highlights folder; if the replay never syncs the clip is filed with a plain
name instead. Callbacks only queue work: OBS and the disk are never touched on
the live-game callback.
"""
from __future__ import annotations

from datetime import datetime, timezone
import logging
import math
import threading
import time

from .clip_files import clip_name, file_clip
from .obs_replay_buffer import OFF, SAVED, SLOW
from .title_match import game_episode

LOG = logging.getLogger(__name__)
REPLAY_MATCH_SECONDS = 120
FALLBACK_SECONDS = 600
MAX_SEEN = 16
NOT_RUNNING = ("OBS's replay buffer is not running, so no clip was saved. In OBS, choose Start Replay Buffer "
               "(Settings > Output > Replay Buffer must be on).")
UNREACHABLE = "OBS could not be reached, so no clip was saved. Open OBS and turn on its WebSocket server."
SLOW_SAVE = "OBS took too long to report the saved clip, so it was not filed. Look for it in OBS's recording folder."
CHECK_NOT_RUNNING = ("OBS's replay buffer is not running. In OBS, choose Start Replay Buffer "
                     "(Settings > Output > Replay Buffer must be on) before a game ends.")
CHECK_UNREACHABLE = "OBS could not be reached. Open OBS and turn on its WebSocket server."
CHECK_RUNNING = "OBS's replay buffer is running."
NOT_MOVED = "OBS saved the clip, but it could not be moved into Highlights. It is where OBS wrote it."
PROBLEMS = frozenset((NOT_RUNNING, UNREACHABLE, SLOW_SAVE, CHECK_NOT_RUNNING, CHECK_UNREACHABLE, NOT_MOVED))


def _start_thread(job, *args):
    threading.Thread(target=job, args=args, name="sc2tools-game-clip", daemon=True).start()


def _start_timer(delay, job):
    timer = threading.Timer(delay, job)
    timer.daemon = True
    timer.start()
    return timer


def _ended_at(game):
    try:
        ended = datetime.fromisoformat(game.date_iso.replace("Z", "+00:00"))
        return (ended.replace(tzinfo=timezone.utc) if ended.tzinfo is None else ended).timestamp()
    except (AttributeError, TypeError, ValueError):
        return None


def _decided_own_game(event):
    """A game the streamer played (not a replay or an observed game) whose result is known."""
    game = getattr(event, "game_state", None)
    return (getattr(event, "phase", None) == "match_ended" and game is not None
            and not getattr(game, "is_replay", True) and not getattr(game, "is_observer", False)
            and any(getattr(player, "is_decided", False) for player in getattr(game, "players", ())))


class GameClipSaver:
    def __init__(self, buffer, *, enabled, announce, report, clock=time.time, spawn=_start_thread,
                 schedule=_start_timer, file=file_clip):
        self.buffer, self.enabled, self.announce, self.report = buffer, enabled, announce, report
        self.clock, self.spawn, self.schedule, self.file = clock, spawn, schedule, file
        self.lock = threading.Lock()
        self.seen = []
        self.waiting = None
        self.early = None
        self.timer = None

    def check(self):
        """Tell the streamer now whether the buffer is running, without saving anything."""
        self.spawn(self._check)

    def _check(self):
        running = self.buffer.running()
        self.announce(CHECK_UNREACHABLE if running is None else CHECK_NOT_RUNNING if not running else CHECK_RUNNING)

    def on_event(self, event):
        key = getattr(event, "game_key", None)
        captured = getattr(event, "captured_at", None)
        if (not _decided_own_game(event) or not isinstance(key, str) or not key
                or type(captured) not in (int, float) or not math.isfinite(captured) or not self.enabled()):
            return
        with self.lock:
            episode = game_episode(key)
            if episode in self.seen:
                return
            self.seen = (self.seen + [episode])[-MAX_SEEN:]
        self.spawn(self._save, captured)

    def _save(self, ended_at):
        state, path = self.buffer()
        if state == SAVED:
            if not self._wait_for_facts(path, ended_at):
                self.announce("Clip saved. It is filed in Highlights once the game syncs.")
        else:
            self.announce(NOT_RUNNING if state == OFF else SLOW_SAVE if state == SLOW else UNREACHABLE)

    def _wait_for_facts(self, path, ended_at):
        """Hold the saved file until its replay syncs; True when the replay had already synced and it was filed."""
        with self.lock:
            earlier, self.waiting = self.waiting, None
            early, self.early = self.early, None
            if self.timer is not None:
                self.timer.cancel()
                self.timer = None
            matched = early is not None and abs(early["ended"] - ended_at) <= REPLAY_MATCH_SECONDS
            if not matched:
                self.waiting = {"path": path, "ended_at": ended_at}
                self.timer = self.schedule(FALLBACK_SECONDS, lambda: self._expire(path))
        if earlier is not None:
            self._file(earlier["path"], earlier["ended_at"], None)
        if matched:
            self._file(path, ended_at, early["facts"])
        return matched

    def on_accepted(self, game, row=None):
        """The synced replay of the game just saved names its clip."""
        row = row if isinstance(row, dict) else {}
        if (getattr(game, "is_resumed_from_replay", False) or getattr(game, "is_history", False)
                or row.get("isHistory") is True):
            return
        ended = _ended_at(game)
        if ended is None:
            return
        facts = {field: getattr(game, field, None) for field in ("result", "my_race", "map_name", "opponent")}
        with self.lock:
            waiting = self.waiting
            if waiting is None or abs(ended - waiting["ended_at"]) > REPLAY_MATCH_SECONDS:
                # A fast live upload can beat the save; keep its facts for the clip that is about to be saved.
                self.early = {"ended": ended, "facts": facts}
                return
            self.waiting = None
            if self.timer is not None:
                self.timer.cancel()
        self.spawn(self._file, waiting["path"], waiting["ended_at"], facts)

    def _expire(self, path):
        """No replay named this clip in time: file it with a plain name."""
        with self.lock:
            waiting = self.waiting
            if waiting is None or waiting["path"] != path:
                return
            self.waiting = None
        self._file(path, waiting["ended_at"], None)

    def _file(self, path, ended_at, facts):
        name = clip_name(ended_at, facts)
        if self.file(path, name) is None:
            self.announce(NOT_MOVED)
            return
        self.announce(f"Clip filed in Highlights: {name}")
        try:
            self.report(name, ended_at)
        except Exception as error:
            LOG.debug("clip_report_skipped %s", type(error).__name__)

    def close(self):
        with self.lock:
            if self.timer is not None:
                self.timer.cancel()
