"""Stream Guardian: tells the streamer, off-stream, about the mistakes that ruin a stream.

A warning is a quiet tray notice and a banner in the Stream Dock, never an
overlay and never a sound. Every rule has its own switch, off until chosen.
The guardian makes no OBS request at all while every switch is off, and while
OBS is not live it makes only the two cheap status reads that notice going live.
"""
from __future__ import annotations

import logging
import threading
import time

from .guardian_rules import GuardianRules
from .guardian_settings import configure_guardian_settings
from .title_match import ACTIVE_PHASES, TERMINAL_PHASES

LOG = logging.getLogger(__name__)
LIVE_SECONDS = 5
IDLE_SECONDS = 15
UNREACHABLE_SECONDS = 30
OFF_SECONDS = 60
#: The server forgets an unrefreshed list after three minutes, so repeat it well inside that.
HEARTBEAT_SECONDS = 60
RETRY_SECONDS = 30
MESSAGES = {
    "mic_muted": "Your microphone has been muted for two minutes while you are live.",
    "stream_unstable": "OBS is dropping frames or reconnecting. Check your connection and encoder load.",
    "not_recording": "A game started but OBS is neither streaming nor recording.",
    "stuck_on_break": "You are still live on a break scene, long after your last game.",
}


class GameWatch:
    """When the current game started and when the last one ended, from the lifecycle events."""

    def __init__(self):
        self.active_since = None
        self.last_end = None

    def on_event(self, event, now):
        phase = getattr(event, "phase", None)
        if phase in TERMINAL_PHASES:
            self._end(now)
        elif phase in ACTIVE_PHASES:
            game = getattr(event, "game_state", None)
            if game is None:
                return  # Partial telemetry says nothing about whether play began or ended.
            if getattr(game, "is_replay", True) or getattr(game, "is_observer", False):
                self._end(now)
            else:
                self.active_since = self.active_since or now

    def _end(self, now):
        if self.active_since is not None:
            self.last_end = now
        self.active_since = None


class StreamGuardian:
    def __init__(self, probe, settings, *, persist, notify, send, clock=time.time):
        self.probe, self.settings = probe, settings
        self.persist, self.notify, self.send, self.clock = persist, notify, send, clock
        self.rules, self.game = GuardianRules(), GameWatch()
        self.active = {}
        self.inputs = []
        self.pushed, self.pushed_at, self.retry_at = set(), 0.0, 0.0
        self.dock_ok = None
        self.stop_event, self.wake = threading.Event(), threading.Event()
        self.thread = None

    def start(self):
        if self.thread and self.thread.is_alive():
            return
        self.stop_event.clear()
        self.thread = threading.Thread(target=self._run, name="sc2tools-stream-guardian", daemon=True)
        self.thread.start()

    def close(self):
        self.stop_event.set()
        self.wake.set()
        self.probe.close()

    def _run(self):
        while not self.stop_event.is_set():
            try:
                wait = self.tick()
            except Exception:
                LOG.debug("stream guardian check failed", exc_info=True)
                wait = UNREACHABLE_SECONDS
            self.wake.wait(wait)
            self.wake.clear()

    def tick(self):
        """One check. Returns how many seconds to wait before the next."""
        settings = self.settings
        if not any(settings["switches"].values()):
            self._settle({}, self.clock())
            self.probe.close()
            return OFF_SECONDS
        playing = self.game.active_since is not None
        reading = self.probe(settings["microphone"], plugin_outputs=settings["switches"]["not_recording"] and playing)
        now = self.clock()
        self._settle(self.rules.evaluate(settings["switches"], reading, self.game, now), now)
        if reading is None:
            return UNREACHABLE_SECONDS
        return LIVE_SECONDS if reading["streaming"] or playing else IDLE_SECONDS

    def _settle(self, found, now):
        """Notify once per new incident, then bring the Dock banner in line."""
        raised = [rule for rule in found if rule not in self.active]
        self.active = found
        for rule in raised:
            try:
                self.notify(MESSAGES[rule])
            except Exception:
                LOG.debug("stream guardian notice failed", exc_info=True)
        self._sync_dock(now)

    def _sync_dock(self, now):
        wanted = set(self.active)
        due = wanted != self.pushed or bool(wanted) and now - self.pushed_at >= HEARTBEAT_SECONDS
        if not due or now < self.retry_at:
            return
        try:
            self.send([{"rule": rule, "since": int(since * 1000)} for rule, since in self.active.items()])
        except Exception:
            self.retry_at, self.dock_ok = now + RETRY_SECONDS, False
            return
        self.pushed, self.pushed_at, self.dock_ok = wanted, now, True

    def on_game_event(self, event):
        before = self.game.active_since
        self.game.on_event(event, self.clock())
        if self.game.active_since != before:
            self.wake.set()

    def configure(self, payload):
        self.settings = settings = configure_guardian_settings(payload)
        self.persist(settings)
        self.wake.set()

    def refresh_inputs(self):
        self.inputs = self.probe.inputs()

    def snapshot(self):
        return {"switches": dict(self.settings["switches"]), "microphone": self.settings["microphone"],
                "inputs": list(self.inputs), "active": sorted(self.active), "dock_ok": self.dock_ok}
