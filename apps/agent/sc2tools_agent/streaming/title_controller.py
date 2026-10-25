"""Account-bound title preview and optional post-game publication.

Human authorization received 2026-10-23 permits this optional updater for
linked Twitch/Kick/YouTube accounts, only when enabled. Development uses mocks;
it must never enable the feature or publish from the owner's accounts.
"""
from __future__ import annotations

import copy

from .title_automation import GameTitleAutomation
from .title_settings import connection_key, configure_title_settings, load_title_settings
from .title_template import render_title, title_values
from .youtube_pair_backend import atomic_json


class StreamTitleController:
    def __init__(self, service):
        self.service = service
        self.settings = load_title_settings(service.backend.config.get("title_automation"), self.owner())
        self.stats = {}
        self.message = "Waiting for synced game statistics."
        self.worker = GameTitleAutomation(self.refresh, last_attempt=self.settings["last_attempt"])

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
            self.message = "Account changed. Automatic titles are off; review the template and platforms."
            self.worker.last_attempt = 0
        return owner

    def snapshot(self):
        self._current()
        result = {key: copy.deepcopy(self.settings[key]) for key in ("enabled", "platforms", "template")}
        result.update(values=title_values(self.stats), message=self.message)
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
        return render_title(template, self.stats)

    def refresh(self, automatic):
        service = self.service
        owner = self.owner()
        if not owner or service.stop_event.is_set():
            return
        try:
            # This client pins the token used by this snapshot. Its guard also
            # prevents a queued old-account write after unlink/account change.
            client = service.cloud_client.bound(self.connection(),
                guard=lambda: not service.stop_event.is_set() and service.account_mode == "sc2tools")
            stats = client.title_session()
        except Exception:
            with service.operations:
                if self.owner() == owner:
                    self.stats = {}
                    self.message = "Statistics could not be refreshed. No automatic title was sent."
                    service._publish()
            return
        with service.operations:
            if service.stop_event.is_set() or self.owner() != owner:
                return
            self._current()
            service._sync_cloud_owner(service._connection_context())
            self.stats = stats
            self.message = "Preview uses your synced cloud session and recorded ladder history."
            if automatic and self.settings["enabled"]:
                try:
                    title = render_title(self.settings["template"], stats)
                    selected = [name for name, enabled in self.settings["platforms"].items()
                                if enabled and self.settings["last_titles"].get(name) != title]
                    if selected:
                        self._deliver(title, selected, client)
                    else:
                        self.message = "Rendered title is unchanged; no platform request was sent."
                except ValueError as error:
                    self.message = str(error)
                except Exception:
                    self.message = "Automatic title could not be completed. Check platform receipts before retrying."
            service._publish()

    def _deliver(self, title, selected, client):
        service = self.service
        for name in selected:
            if service.stop_event.is_set() or self.owner() != self.settings["owner"]:
                break
            # A known local preflight failure has made no provider attempt.
            # Keep its receipt separate and still deliver other selections.
            if name == "youtube" and not service._setup_matches(service._connection_context()):
                service.platform_results[name] = {"ok": False,
                    "message": "Save YouTube setup for this account before updating its title."}
                continue
            # Persist this platform immediately before its path. An ambiguous
            # attempt must not repeat after restart; untouched platforms may.
            attempted = copy.deepcopy(self.settings)
            attempted["last_attempt"] = self.worker.last_attempt
            attempted["last_titles"][name] = title
            self._persist(attempted)
            self.settings = attempted
            try:
                service._apply_title(title, service.backend.metadata["description"], [name], client=client)
            except Exception as error:
                service.platform_results[name] = {"ok": False,
                    "message": "Automatic title could not be completed. Check this platform before retrying."}
                if getattr(error, "pairing_changed", False):
                    break
        self.message = "Automatic title requests completed. See each platform's receipt."
