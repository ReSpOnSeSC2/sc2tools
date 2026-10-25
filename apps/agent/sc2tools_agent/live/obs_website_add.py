"""Default-off, locally confirmed website requests. OBS is always injected."""
from __future__ import annotations

import re
import threading
import time
from typing import Callable

from .obs_game_overlay import OBS_GAME_WRITE_LOCK, matching_game_input
from .obs_layout import PlannedItem, Rect, _browser_settings, _overlay_url, _overlay_url_key, _transform_for, _unique_input_name
from .widget_sizes import widget_sizes


class ObsWebsiteAdd:
    def __init__(self, *, scope: Callable, client_factory: Callable, token_provider: Callable,
                 confirm: Callable, base_url: Callable, clock=time.time):
        self.scope, self.client_factory, self.token_provider = scope, client_factory, token_provider
        self.confirm, self.base_url, self.clock = confirm, base_url, clock
        self._pending = threading.Lock()

    def handle(self, raw, authenticated_token):
        request_id = raw.get("requestId") if isinstance(raw, dict) else None
        device_id = raw.get("deviceId") if isinstance(raw, dict) else None
        def reply(code):
            return {"requestId": request_id, "deviceId": device_id, "code": code}
        if (not isinstance(raw, dict) or set(raw) != {"requestId", "deviceId", "widget", "expiresAt"}
                or not isinstance(request_id, str) or not re.fullmatch(r"[a-f0-9]{32}", request_id)
                or not isinstance(device_id, str) or not re.fullmatch(r"[a-f0-9]{24}", device_id)
                or not isinstance(raw.get("widget"), str) or raw["widget"] not in widget_sizes()
                or type(raw.get("expiresAt")) not in (int, float)):
            return reply("invalid_request")
        if not self._pending.acquire(blocking=False):
            return reply("busy")
        client = None
        try:
            initial_scope = self.scope()
            if not initial_scope or initial_scope[1] != authenticated_token:
                return reply("disabled")
            if not 0 < raw["expiresAt"] / 1000 - self.clock() <= 45:
                return reply("expired")
            client = self.client_factory()
            client.connect_now()
            scene = client.current_program_scene()
            if not isinstance(scene, str) or not scene or len(scene) > 512:
                return reply("obs_unavailable")
            # Never auto-accept: the callback is a native default-Cancel dialog.
            if not self.confirm({"widget": raw["widget"], "scene": scene, "expiresAt": raw["expiresAt"]}):
                return reply("declined")
            if self.scope() != initial_scope:
                return reply("owner_changed")
            if self.clock() * 1000 >= raw["expiresAt"]:
                return reply("expired")
            token = self.token_provider()
            if self.scope() != initial_scope:
                return reply("owner_changed")
            if not isinstance(token, str) or not token:
                return reply("token_unavailable")
            with OBS_GAME_WRITE_LOCK:
                if self.scope() != initial_scope:
                    return reply("owner_changed")
                if self.clock() * 1000 >= raw["expiresAt"]:
                    return reply("expired")
                if client.current_program_scene() != scene:
                    return reply("scene_changed")
                widget = raw["widget"]
                width, height = widget_sizes()[widget]
                item = PlannedItem(label=widget, rect=Rect(0, 0, width, height), z=0,
                                   browser_path=_overlay_url(self.base_url(), token, f"widget/{widget}"),
                                   input_name=f"SC2 Tools {widget}", share_key=f"during_game:{widget}")
                rows = client.get_scene_item_list(scene)
                if len(rows) > 2000:
                    return reply("obs_unavailable")
                if any(row.get("input_kind") == "browser_source" and _overlay_url_key(
                    client.get_input_settings(str(row.get("source_name") or "")).get("url", ""),
                ) == _overlay_url_key(item.browser_path) for row in rows):
                    return reply("already_present")
                existing = matching_game_input(client, item)
                if existing:
                    new_id = client.create_scene_item(scene_name=scene, source_name=existing)
                else:
                    new_id = client.create_input(scene_name=scene, input_name=_unique_input_name(client, item.input_name),
                                                 input_kind="browser_source", settings=_browser_settings(item))
                client.set_scene_item_transform(scene_name=scene, item_id=new_id, transform=_transform_for(item.rect))
            return reply("added")
        except Exception:
            # No retry after an uncertain write; the user can inspect OBS first.
            return reply("local_error")
        finally:
            try:
                if client is not None:
                    client.shutdown()
            finally:
                self._pending.release()
