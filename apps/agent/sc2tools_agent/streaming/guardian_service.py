"""The Stream Guardian's seams to the stream service: persistence, tray notice, Dock push, game events."""
from __future__ import annotations

import copy

from .guardian import StreamGuardian
from .guardian_settings import load_guardian_settings
from .youtube_pair_backend import atomic_json


class GuardianServiceMixin:
    notify = None  # the runner points this at the tray once there is one

    def _build_guardian(self, probe, saved):
        return StreamGuardian(probe, load_guardian_settings(saved), persist=self._persist_guardian,
                              notify=self._notify_guardian, send=self._send_guardian)

    def on_game_event(self, event):
        self.guardian.on_game_event(event)
        self.titles.worker.on_event(event)

    def _persist_guardian(self, settings):
        config = copy.deepcopy(self.backend.config)
        config["stream_guardian"] = settings
        atomic_json(self.config_path, config)
        self.backend.config = config

    def _notify_guardian(self, message):
        if self.notify is not None:
            self.notify(message, title="SC2 Tools Stream Guardian")

    def _send_guardian(self, warnings):
        if self.account_mode != "sc2tools" or self.cloud_client is None:
            raise ValueError("Pair this agent with your SC2Tools account to show warnings in the Stream Dock.")
        self.cloud_client.guardian_warnings(warnings)
