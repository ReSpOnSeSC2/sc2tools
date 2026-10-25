"""Owned exact replacement receipts; never infer a token from list ordering."""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import logging
import re
import threading
import time
from urllib.parse import urlsplit

from .obs_game_overlay import OBS_GAME_WRITE_LOCK
from .obs_layout import (
    BROWSER_INPUT_KIND, MANUAL_OVERRIDE_SCENES, SCENE_BETWEEN_GAMES,
    _assert_ours, _generated_browser_route_for_input_name, _strict_browser_url_key,
)

MAX_TOKENS = 512
MAX_HOPS = 32
MAX_ITEMS = 2000
MAX_PATCHES = 128
TOKEN = re.compile(r"[A-Za-z0-9_-]{1,512}\Z")
log = logging.getLogger(__name__)


@dataclass(frozen=True, repr=False)
class OwnedReplacements:
    replacements: dict[str, str]
    ready: frozenset[str]


def owned_replacements(config) -> OwnedReplacements:
    """Only complete pointers ending at an owned ready active row are usable."""
    rows = config.get("items") if isinstance(config, dict) else None
    if not isinstance(rows, list) or len(rows) > MAX_TOKENS:
        raise ValueError("invalid_overlay_token_config")
    owned = {}
    for row in rows:
        token = row.get("token") if isinstance(row, dict) else None
        if not isinstance(token, str) or not TOKEN.fullmatch(token) or token in owned:
            raise ValueError("invalid_overlay_token_config")
        owned[token] = row
    ready = frozenset(token for token, row in owned.items()
                      if row.get("revokedAt") is None and row.get("rotationPending", False) is False
                      and row.get("replacedBy") is None)
    replacements = {}
    for source, first in owned.items():
        if not first.get("replacedBy"):
            continue
        current, seen = source, set()
        for _ in range(MAX_HOPS):
            if current in seen:
                break
            seen.add(current)
            row = owned.get(current)
            if row is None or row.get("rotationPending", False) is not False:
                break
            target = row.get("replacedBy")
            if target is None:
                if current in ready and current != source:
                    replacements[source] = current
                break
            if not isinstance(target, str) or not TOKEN.fullmatch(target):
                break
            current = target
    return OwnedReplacements(replacements, ready)


def _source_url(value, route, snapshot: OwnedReplacements, base_url):
    if not isinstance(value, str) or len(value) > 65536:
        return None
    try:
        parsed, base = urlsplit(value), urlsplit(base_url)
    except ValueError:
        return None
    if (parsed.scheme not in {"http", "https"} or parsed.scheme.lower() != base.scheme.lower()
            or parsed.netloc.lower() != base.netloc.lower()):
        return None
    prefix = base.path.rstrip("/") + "/overlay/"
    if not parsed.path.startswith(prefix):
        return None
    tail = parsed.path[len(prefix):].rstrip("/").split("/")
    expected = [] if route == ("overlay", "") else list(route)
    if len(tail) != 1 + len(expected) or tail[1:] != expected:
        return None
    token = tail[0]
    target = snapshot.replacements.get(token, token if token in snapshot.ready else None)
    if target is None:
        return None
    # Replace exactly one opaque path segment; keep every query/fragment byte.
    path = prefix + target + parsed.path[len(prefix) + len(token):]
    return token, target, parsed._replace(path=path).geturl()


def repair_generated_token_urls(client, snapshot: OwnedReplacements, base_url, checkpoint=lambda: None,
                                refresh_before_write=None) -> int:
    """Same strict builder fingerprint as startup repair, including partial chains.

    Only recognized inputs referenced in the two exact generated scenes are
    patched. No source creation, activation, transform, ordering or dimensions.
    """
    checkpoint()
    scenes = client.refresh_scenes()
    if len(scenes) > 1000 or SCENE_BETWEEN_GAMES not in scenes:
        return 0
    inventories, settings = {}, {}
    for scene in MANUAL_OVERRIDE_SCENES:
        if scene not in scenes:
            continue
        _assert_ours(scene)
        checkpoint()
        rows = client.get_scene_item_list(scene)
        if len(rows) > MAX_ITEMS:
            raise ValueError("obs_inventory_too_large")
        inventories[scene] = rows
        for row in rows:
            name = str(row.get("source_name") or "")
            if row.get("input_kind") != BROWSER_INPUT_KIND or not _generated_browser_route_for_input_name(name):
                continue
            if name not in settings:
                checkpoint()
                settings[name] = client.get_input_settings(name)
    required = {("scene", "between-games"): [], ("widget", "session"): [], ("widget", "multichat"): []}
    for row in inventories[SCENE_BETWEEN_GAMES]:
        name = str(row.get("source_name") or "")
        route = _generated_browser_route_for_input_name(name)
        if route in required and row.get("input_kind") == BROWSER_INPUT_KIND:
            value = _source_url(settings.get(name, {}).get("url"), route, snapshot, base_url)
            if value:
                required[route].append(value[1])
    if any(len(values) != 1 for values in required.values()):
        return 0
    canonical = {values[0] for values in required.values()}
    if len(canonical) != 1:
        return 0
    target = next(iter(canonical))
    patches = []
    for name, initial in settings.items():
        route = _generated_browser_route_for_input_name(name)
        value = _source_url(initial.get("url"), route, snapshot, base_url)
        if value and value[1] == target and value[0] != value[1]:
            patches.append((name, initial["url"], value[2]))
    if len(patches) > MAX_PATCHES:
        raise ValueError("obs_inventory_too_large")
    if patches and refresh_before_write is not None:
        # A cached receipt is an inventory hint, never current write authority.
        # Refresh only when a real repair is needed, then plan again so a newer
        # terminal/revocation cannot be overwritten by this cached plan.
        snapshot = refresh_before_write()
        checkpoint()
        return repair_generated_token_urls(client, snapshot, base_url, checkpoint)
    changed = 0
    for name, before, after in patches:
        checkpoint()
        current = client.get_input_settings(name)
        if _strict_browser_url_key(current.get("url", "")) != _strict_browser_url_key(before):
            continue  # The operator changed this source while inventory was read.
        checkpoint()
        client.set_input_settings(name, {"url": after})
        changed += 1
    return changed


class _Stopped(Exception):
    pass


class ObsTokenRotation:
    """One advisory worker; successful config can be reused on the next heartbeat.

    Failed/unavailable OBS work is never marked permanently seen. Every existing
    heartbeat retries the cached exact mapping; changed receipts refresh it.
    """
    def __init__(self, *, scope, api_factory, client_factory, base_url, dispatch=None, clock=time.monotonic):
        self.scope, self.api_factory, self.client_factory = scope, api_factory, client_factory
        self.base_url, self.clock = base_url, clock
        self.dispatch = dispatch or self._thread
        self._busy = threading.Lock()
        self._cache = None

    @staticmethod
    def _thread(callback):
        threading.Thread(target=callback, name="sc2tools-obs-token-repair", daemon=True).start()

    def changed(self, authenticated_token):
        return self._submit(authenticated_token, None, True)

    def heartbeat(self, receipts, api):
        if not isinstance(receipts, list) or len(receipts) > 32:
            return False
        pairs = []
        for row in receipts:
            if not isinstance(row, dict) or set(row) != {"from", "to"}:
                return False
            if any(not isinstance(row[key], str) or not TOKEN.fullmatch(row[key]) for key in ("from", "to")):
                return False
            pairs.append((row["from"], row["to"]))
        signature = hashlib.sha256(repr(sorted(pairs)).encode()).digest()
        current = self.scope()
        if not current or str(getattr(api, "base_url", "")).rstrip("/") != str(current[0]).rstrip("/"):
            return False
        force = self._cache is None or self._cache[0] != current or self._cache[1] != signature
        return self._submit(getattr(api, "device_token", None), signature, force)

    def _submit(self, authenticated_token, signature, force):
        initial = self.scope()
        if not initial or initial[1] != authenticated_token or not self._busy.acquire(blocking=False):
            return False
        try:
            self.dispatch(lambda: self._run(initial, signature, force))
            return True
        except Exception:
            self._busy.release()
            return False

    def _run(self, initial, signature, force):
        client = None
        deadline = self.clock() + 15
        def checkpoint():
            if self.scope() != initial or self.clock() >= deadline:
                raise _Stopped()
        try:
            checkpoint()
            def refresh():
                api = self.api_factory(initial[0], initial[1])
                config = api.get_overlay_tokens(interactive=True)
                checkpoint()
                snapshot = owned_replacements(config)
                self._cache = (initial, signature, snapshot)
                return snapshot
            fresh = force or self._cache is None or self._cache[0] != initial
            if fresh:
                snapshot = refresh()
            else:
                snapshot = self._cache[2]
            if not snapshot.replacements:
                return
            client = self.client_factory(initial)
            checkpoint()
            client.connect_now()
            checkpoint()
            if not OBS_GAME_WRITE_LOCK.acquire(timeout=max(0, deadline - self.clock())):
                return
            try:
                checkpoint()
                changed = repair_generated_token_urls(client, snapshot, self.base_url(initial[0]), checkpoint,
                    refresh_before_write=None if fresh else refresh)
            finally:
                OBS_GAME_WRITE_LOCK.release()
            if changed:
                log.info("obs_token_rotation_repaired count=%d", changed)
        except _Stopped:
            pass
        except Exception as exc:
            # Exception text can contain a bearer URL. Never log it or a traceback.
            log.debug("obs_token_rotation_retry type=%s", type(exc).__name__)
        finally:
            try:
                if client is not None:
                    client.shutdown()
            except Exception:
                pass
            self._busy.release()
