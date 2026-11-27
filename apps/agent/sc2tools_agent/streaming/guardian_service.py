"""The Stream Guardian's seams to the stream service: persistence, tray notice, Dock push, game events."""
from __future__ import annotations

import copy

from .guardian import StreamGuardian
from .guardian_probe import ObsGuardianProbe
from .guardian_settings import load_guardian_settings
from .obs_reader import DEFAULT_OUTPUTS
from .youtube_pair_backend import atomic_json


GUARDIAN_JOBS = ("configure_guardian", "list_obs_inputs")


class GuardianServiceMixin:
    notify = None  # the runner points this at the tray once there is one

    def _build_guardian(self, probe, settings_provider, no_obs, config):
        probe = probe or ObsGuardianProbe(settings_provider, disabled=no_obs, output_names=self._output_names)
        return StreamGuardian(probe, load_guardian_settings(config.get("stream_guardian")), persist=self._persist_guardian,
                              notify=self._notify_guardian, send=self._send_guardian)

    def _output_names(self):
        """The plugin outputs that carry a stream, as the streamer named them."""
        names = self.backend.config.get("output_names")
        return tuple(name for name in (names or DEFAULT_OUTPUTS).values() if isinstance(name, str) and name)

    def _guardian_job(self, kind, payload):
        """Run a Stream Guardian action from the Streams page; returns the message to show."""
        if kind == "configure_guardian":
            self.guardian.configure(payload)
            return "Stream Guardian settings saved. Warnings show while OBS is live."
        self.guardian.refresh_inputs()
        return "OBS inputs refreshed. Pick the one you speak into."

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
