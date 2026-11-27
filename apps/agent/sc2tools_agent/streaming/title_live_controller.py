"""Current-match preview and publication using the private session snapshot."""
from __future__ import annotations

import copy

from .title_match import game_episode
from .title_template import render_title

HISTORY_VALUE_KEYS = {"h2h", "h2h_wr", "h2h_with_wr"}
MATCH_VALUE_KEYS = {"opp", "aka", "map", "race", "match_mmr"} | HISTORY_VALUE_KEYS


class LiveTitleControllerMixin:
    def _title_stats(self):
        stats = copy.deepcopy(self.stats)
        match = stats.get("currentMatch")
        if not isinstance(match, dict) or match.get("gameKey") != self.worker.match.current_key():
            stats.pop("currentMatch", None)
        return stats

    def scope_snapshot(self, snapshot):
        """Cached UI values must stop naming a match as soon as play ends."""
        if snapshot.get("match_game_key") != self.worker.match.current_key():
            values = snapshot.get("values", {})
            snapshot["values"] = {key: value for key, value in values.items() if key not in MATCH_VALUE_KEYS}
            snapshot["match_game_key"] = None
        return snapshot

    def refresh_match(self, game_key, generation, final):
        service = self.service
        owner = self.owner()
        valid = lambda: (self.owner() == owner and self.settings["owner"] == owner
                         and self.game_start_active() and not service.stop_event.is_set()
                         and self.worker.match.is_current(game_key, generation))
        if not owner or not valid():
            return True
        receipt = self.settings.get("last_start_game")
        title_pending = self.settings["on_game_start"] and not (
            receipt and game_episode(receipt) == game_episode(game_key))
        channel_pending = self.channel_pending(game_key)
        if not title_pending and not channel_pending:
            return True
        try:
            client = service.cloud_client.bound(self.connection(), guard=valid)
            stats = client.title_session()
        except Exception:
            with service.operations:
                if valid():
                    self.message = "Current-game statistics are not ready. No game-start title was sent."
                    service._publish()
            return final or not valid()
        with service.operations:
            if not valid():
                return True
            service._sync_cloud_owner(service._connection_context())
            self.stats = stats
            match = stats.get("currentMatch")
            if not isinstance(match, dict) or match.get("gameKey") != game_key:
                self.message = "Waiting for the current opponent. No game-start title was sent."
                service._publish()
                return final
            # The title goes first; tags and category follow it and cannot hold it up.
            done = self._send_match_title(match, client, valid, game_key, final) if title_pending else True
            if done and channel_pending and valid():
                self.update_channel(game_key, client, valid)
            service._publish()
        return done

    def _send_match_title(self, match, client, valid, game_key, final):
        """Publish the game-start title; False while the head-to-head record is still loading."""
        template = self.settings["template"]
        needs_history = any(f"{{{token}}}" in template for token in HISTORY_VALUE_KEYS)
        if needs_history and not isinstance(match.get("h2h"), dict) and not final:
            self.message = "Waiting for the current opponent's head-to-head record."
            return False
        try:
            title = render_title(template, self._title_stats())
            selected = [name for name, enabled in self.settings["platforms"].items()
                        if enabled and self.settings["last_titles"].get(name) != title]
            if selected:
                self._deliver(title, selected, client, guard=valid, game_key=game_key)
            else:
                self.message = "Rendered title is unchanged; no platform request was sent."
        except ValueError as error:
            self.message = str(error)
        except Exception:
            self.message = "Game-start title could not be completed. Check platform receipts before retrying."
        return True
