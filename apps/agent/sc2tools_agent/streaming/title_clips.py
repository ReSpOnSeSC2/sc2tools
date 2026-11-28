"""The optional replay-buffer clip after each game, wired to the title settings.

Opt-in with the other automatic stream features. It never publishes a title and
a failed step only becomes a line under the switch.
"""
from __future__ import annotations

from .game_clips import GameClipSaver


class ClipSaveMixin:
    def build_clip_saver(self):
        service = self.service
        return GameClipSaver(service.clip_buffer, enabled=self.clips_enabled, announce=self.announce_clip,
                             report=lambda name: service.cloud_client.clip_saved(name))

    def clips_enabled(self):
        owner = self.owner()
        return bool(owner) and self.settings["owner"] == owner and self.settings["save_clips"]

    def announce_clip(self, message):
        with self.service.operations:
            self.clip_message = message
            self.service._publish()

    def on_game_accepted(self, path, game, game_id=None, row=None):
        self.worker.on_game_accepted(path, game, game_id, row)
        self.clips.on_accepted(game, row)
