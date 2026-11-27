"""Account-bound title preview and optional game-start/post-game publication.

Human authorization received 2026-10-23 permits this optional updater for
linked Twitch/Kick/YouTube accounts, only when enabled. Development uses mocks;
it must never enable the feature or publish from the owner's accounts.
"""
from __future__ import annotations

import copy

from .title_automation import GameTitleAutomation
from .title_channel_controller import ChannelUpdateMixin
from .title_live_controller import LiveTitleControllerMixin, MATCH_VALUE_KEYS
from .title_record_chapter import RecordChapterMixin
from .title_settings import connection_key, configure_title_settings, load_title_settings
from .title_template import render_title, title_values
from .youtube_pair_backend import atomic_json


class StreamTitleController(ChannelUpdateMixin, RecordChapterMixin, LiveTitleControllerMixin):
    def __init__(self, service):
        self.service = service
        self.settings = load_title_settings(service.backend.config.get("title_automation"), self.owner())
        self.stats = {}
        self.message = "Waiting for synced game statistics."
        self.channel_message = ""
        self.worker = GameTitleAutomation(self.refresh, last_attempt=self.settings["last_attempt"],
                                          refresh_match=self.refresh_match)
        self.configure_game_start()

    def connection(self):
        client = self.service.cloud_client
        provider = getattr(client, "connection_provider", None)
        return provider() if callable(provider) else ("", "")

    def owner(self):
        if self.service.account_mode != "sc2tools":
            return ""
        read = getattr(self.service.cloud_client, "context", None)
        if callable(read):
            context = read()
            return connection_key((context.get("accountKey") or "", context.get("connectionKey") or ""))
        return connection_key(self.connection())

    def _current(self):
        owner = self.owner()
        if self.settings["owner"] != owner:
            self.settings = load_title_settings({}, owner)
            self.stats = {}
            self.channel_message = ""
            self.message = "Account changed. Automatic titles are off; review the template and platforms."
            self.worker.reset()
        return owner

    def snapshot(self):
        self._current()
        result = {key: copy.deepcopy(self.settings[key]) for key in (
            "enabled", "on_game_start", "channel_tags", "category_guard", "record_chapters", "platforms", "template")}
        stats = self._title_stats()
        result.update(values=title_values(stats), message=self.message, tag_preview=self.tag_preview(),
                      channel_message=self.channel_message,
                      match_game_key=stats.get("currentMatch", {}).get("gameKey"))
        return result

    def save_template(self, template):
        from .title_template import validate_template
        self._current()
        configured = copy.deepcopy(self.settings)
        configured["template"] = validate_template(template)
        self._persist(configured)
        self.settings = configured

    def save(self, payload):
        self._current()
        configured = configure_title_settings(self.settings, payload, self.owner())
        self._persist(configured)
        self.settings = configured
        self.configure_game_start()
        self.worker.preview_pending = True
        self.worker.wake.set()
        self.message = "Automatic title settings saved. No title was published."

    def _persist(self, settings):
        config = copy.deepcopy(self.service.backend.config)
        config["title_automation"] = settings
        atomic_json(self.service.config_path, config)
        self.service.backend.config = config

    def preview(self, template):
        self._current()
        return render_title(template, self._title_stats())

    def refresh(self, automatic, *, game_id=None, valid=None):
        service = self.service
        owner = self.owner()
        guard = lambda: (not service.stop_event.is_set() and service.account_mode == "sc2tools"
                         and (valid is None or valid()))
        if not owner or not guard():
            return
        template = self.settings["template"]
        include_completed = game_id and automatic and self.settings["enabled"] and any(
            f"{{{token}}}" in template for token in MATCH_VALUE_KEYS)
        try:
            # This client pins the token used by this snapshot. Its guard also
            # prevents a queued old-account write after unlink/account change.
            client = service.cloud_client.bound(self.connection(), guard=guard)
            stats = client.title_session(game_id=game_id if include_completed else None)
        except Exception:
            with service.operations:
                if self.owner() == owner and guard():
                    self.stats = {}
                    self.message = "Statistics could not be refreshed. No automatic title was sent."
                    service._publish()
            return
        with service.operations:
            if self.owner() != owner or not guard():
                return
            self._current()
            service._sync_cloud_owner(service._connection_context())
            completed = stats.pop("completedMatch", None)
            self.stats = stats
            self.message = "Preview uses your synced cloud session and recorded ladder history."
            # A late upload from the previous game must not overwrite a new
            # game's pending opponent title with generic session statistics.
            match_owns_title = self.settings["on_game_start"] and self.worker.match.current_key() is not None
            if automatic and self.settings["enabled"] and not match_owns_title:
                try:
                    title_stats = self._title_stats()
                    if include_completed:
                        title_stats.pop("currentMatch", None)
                        if isinstance(completed, dict) and completed.get("gameKey") == game_id:
                            title_stats["currentMatch"] = completed
                    title = render_title(self.settings["template"], title_stats)
                    selected = [name for name, enabled in self.settings["platforms"].items()
                                if enabled and self.settings["last_titles"].get(name) != title]
                    if selected:
                        self._deliver(title, selected, client, guard=guard if valid is not None else None)
                    else:
                        self.message = "Rendered title is unchanged; no platform request was sent."
                except ValueError as error:
                    self.message = str(error)
                except Exception:
                    self.message = "Automatic title could not be completed. Check platform receipts before retrying."
            service._publish()

    def _deliver(self, title, selected, client, *, guard=None, game_key=None):
        service = self.service
        for name in selected:
            if service.stop_event.is_set() or self.owner() != self.settings["owner"] or guard is not None and not guard():
                break
            # A known local preflight failure has made no provider attempt.
            # Keep its receipt separate and still deliver other selections.
            if name == "youtube" and not service._setup_matches(service._connection_context()):
                service.platform_results[name] = {"ok": False,
                    "message": "Save YouTube setup for this account before updating its title."}
                continue
            # Persist this platform immediately before its path. An ambiguous
            # attempt must not repeat after restart; untouched platforms may.
            previous = copy.deepcopy(self.settings)
            attempted = copy.deepcopy(previous)
            attempted["last_attempt"] = self.worker.last_attempt
            attempted["last_titles"][name] = title
            if game_key is not None:
                attempted["last_start_game"] = game_key
            self._persist(attempted)
            self.settings = attempted
            if guard is not None and not guard():
                # The guard changed while saving, before any provider call.
                # Release only this unattempted receipt; earlier platforms'
                # attempts are retained in the previous settings snapshot.
                self._persist(previous)
                self.settings = previous
                break
            try:
                service._apply_title(title, service.backend.metadata["description"], [name], client=client)
            except Exception as error:
                service.platform_results[name] = {"ok": False,
                    "message": "Automatic title could not be completed. Check this platform before retrying."}
                if getattr(error, "pairing_changed", False):
                    break
        self.message = "Automatic title requests completed. See each platform's receipt."
