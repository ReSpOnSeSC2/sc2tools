"""Saving OBS's replay buffer on request, on its own obs-websocket connection.

SaveReplayBuffer only starts the save; GetLastReplayBufferReplay names the file
once OBS has finished writing it. This never starts the buffer: a buffer that is
not running is a hint to the streamer, not something to switch on for them.
Nothing here raises.
"""
from __future__ import annotations

import logging
import time

from .obs_reader import ObsConnection

LOG = logging.getLogger(__name__)
SAVED, OFF, UNAVAILABLE, SLOW = "saved", "off", "unavailable", "slow"
POLL_SECONDS = 0.5
POLL_ATTEMPTS = 40


class ReplayBufferSaver(ObsConnection):
    def __init__(self, settings_provider, *, disabled=False, factory=None, sleep=time.sleep):
        super().__init__(settings_provider, disabled=disabled, factory=factory)
        self.sleep = sleep

    def running(self):
        """True or False for the buffer's state, None when OBS cannot be asked."""
        if self.disabled:
            return None
        with self.lock:
            try:
                active = getattr(self._connection().send("GetReplayBufferStatus"), "output_active", None)
                return active if isinstance(active, bool) else None
            except Exception as error:
                LOG.debug("OBS replay buffer status skipped: %s", type(error).__name__)
                self.close()
                return None

    def __call__(self):
        """(state, path): SAVED with the file OBS wrote, OFF while the buffer is not running, SLOW when OBS took the
        save but has not named the file in time, else UNAVAILABLE."""
        running = self.running()
        if running is not True:
            return (OFF, None) if running is False else (UNAVAILABLE, None)
        requested = False
        with self.lock:
            try:
                raw = self._connection()
                before = self._last_path(raw)
                raw.send("SaveReplayBuffer")
                requested = True
                for _ in range(POLL_ATTEMPTS):
                    path = self._last_path(raw)
                    if path and path != before:
                        return SAVED, path
                    self.sleep(POLL_SECONDS)
            except Exception as error:
                LOG.debug("OBS replay buffer save skipped: %s", type(error).__name__)
                self.close()
            return (SLOW if requested else UNAVAILABLE), None

    @staticmethod
    def _last_path(raw):
        """The newest saved replay's path, or None before OBS has saved one."""
        try:
            path = getattr(raw.send("GetLastReplayBufferReplay"), "saved_replay_path", None)
        except Exception:
            return None
        return path if isinstance(path, str) and path else None
