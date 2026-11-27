"""Game-start channel tags and the StarCraft II category guard.

Runs after the title update for the same game and never raises into it: each
provider call is its own attempt, and a failure only becomes a receipt line.
"""
from __future__ import annotations

import copy

from .title_channel import CHANNEL_PLATFORMS, channel_tags

PLATFORM_NAMES = {"twitch": "Twitch", "kick": "Kick"}


class ChannelUpdateMixin:
    def game_start_active(self):
        settings = self.settings
        return settings["on_game_start"] or settings["channel_tags"] or settings["category_guard"]

    def configure_game_start(self):
        self.worker.match.configure(self.game_start_active(), titles=self.settings["on_game_start"])

    def channel_pending(self, game_key):
        settings = self.settings
        return ((settings["channel_tags"] or settings["category_guard"])
                and settings["last_channel_game"] != game_key)

    def tag_preview(self):
        """The exact tags the next game start would send, from the latest statistics."""
        return channel_tags(self._title_stats())

    def update_channel(self, game_key, client, guard):
        """One attempt per game. The receipt is saved first: an ambiguous write is never repeated."""
        settings = copy.deepcopy(self.settings)
        settings["last_channel_game"] = game_key
        self._persist(settings)
        self.settings = settings
        platforms = [name for name in CHANNEL_PLATFORMS if settings["platforms"].get(name)]
        lines = []
        tags = channel_tags(self._title_stats()) if settings["channel_tags"] else []
        for name in platforms:
            if not guard():
                break
            if tags:
                lines.append(self._send_tags(name, tags, client))
            if settings["category_guard"] and guard():
                lines.append(self._send_category(name, client))
        self.channel_message = " ".join(lines)

    def _send_tags(self, name, tags, client):
        try:
            result = client.set_tags(name, tags, self.settings["last_tags"].get(name, []))
        except Exception:
            return f"{PLATFORM_NAMES[name]} tags could not be confirmed."
        if result["status"] in {"updated", "unchanged"}:
            written = copy.deepcopy(self.settings)
            written["last_tags"][name] = result["added"]
            self._persist(written)
            self.settings = written
            return f"{PLATFORM_NAMES[name]} tags: {', '.join(result['added']) or 'none added'}."
        return f"{PLATFORM_NAMES[name]} tags not changed. {result['reason']}".rstrip()

    def _send_category(self, name, client):
        try:
            result = client.ensure_category(name)
        except Exception:
            return f"{PLATFORM_NAMES[name]} category could not be confirmed."
        if result["status"] == "updated":
            return f"{PLATFORM_NAMES[name]} category set to StarCraft II."
        if result["status"] == "unchanged":
            return f"{PLATFORM_NAMES[name]} category is already StarCraft II."
        return f"{PLATFORM_NAMES[name]} category not changed. {result['reason']}".rstrip()
