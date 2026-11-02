"""Ephemeral namespace-bound socket protocol; never full resync or raw logs."""
from __future__ import annotations

import asyncio
import math
import re
import time
import threading

from .sync_retry import RETRY_REASONS

ID = re.compile(r"[a-f0-9]{24}")
REQUEST = re.compile(r"[a-f0-9]{32}")
CODES = frozenset({"accepted", "no_matches", "busy", "expired", "owner_changed", "unsupported", "invalid_request", "local_error"})


class SyncRetrySocket:
    def __init__(self, client, callback, clock=time.time):
        self.client, self.callback, self.clock = client, callback, clock
        self.epoch = object()
        self.binding = None
        self.pending = False
        self.replies = {}

    def retire(self):
        self.epoch = object()
        self.binding = None
        self.replies.clear()

    def sid(self):
        try:
            return self.client._sio.get_sid(namespace="/")
        except Exception:
            return None

    def ready(self, raw):
        if (self.callback is None or not isinstance(raw, dict) or set(raw) != {"version", "deviceId", "sessionId"}
                or type(raw["version"]) is not int or raw["version"] != 1
                or not isinstance(raw["deviceId"], str) or not ID.fullmatch(raw["deviceId"])
                or not isinstance(raw["sessionId"], str) or not 0 < len(raw["sessionId"]) <= 200
                or raw["sessionId"] != self.sid() or self.client._stop.is_set()
                or not self.client._device_connected):
            return
        self.binding = (raw["deviceId"], raw["sessionId"])

    async def request(self, raw):
        valid = (isinstance(raw, dict) and set(raw) == {"requestId", "deviceId", "sessionId", "reason", "expiresAt"}
                 and isinstance(raw["requestId"], str) and REQUEST.fullmatch(raw["requestId"])
                 and isinstance(raw["deviceId"], str) and ID.fullmatch(raw["deviceId"])
                 and isinstance(raw["sessionId"], str) and 0 < len(raw["sessionId"]) <= 200
                 and isinstance(raw["reason"], str) and raw["reason"] in RETRY_REASONS
                 and type(raw["expiresAt"]) in (int, float) and math.isfinite(raw["expiresAt"]))
        def reply(code, count=0):
            return {"requestId": raw["requestId"] if valid else None, "deviceId": raw["deviceId"] if valid else None,
                    "sessionId": raw["sessionId"] if valid else None, "reason": raw["reason"] if valid else None,
                    "code": code, "count": count}
        if not valid:
            return reply("invalid_request")
        epoch, binding, token = self.epoch, self.binding, self.client._device_token
        def current():
            return (self.epoch is epoch and self.binding is binding and binding == (raw["deviceId"], raw["sessionId"])
                    and not self.client._stop.is_set() and self.client._device_connected
                    and self.client._device_token == token and self.sid() == raw["sessionId"])
        if self.callback is None:
            return reply("unsupported")
        if not current() or self.sid() != raw["sessionId"]:
            return reply("owner_changed")
        now = self.clock() * 1000
        if not 0 < raw["expiresAt"] - now <= 15000:
            return reply("expired")
        for key, (expires, _fingerprint, _answer) in list(self.replies.items()):
            if expires <= now:
                self.replies.pop(key, None)
        fingerprint = tuple(raw[field] for field in ("deviceId", "sessionId", "reason", "expiresAt"))
        cached = self.replies.get(raw["requestId"])
        if cached:
            return dict(cached[2]) if fingerprint == cached[1] else reply("invalid_request")
        if self.pending or len(self.replies) >= 64:
            return reply("busy")
        self.pending = True
        # Reserve before dispatch. Exceptions or cancelled ACK tasks can never
        # repeat work whose local commit status is uncertain.
        uncertain = reply("local_error")
        self.replies[raw["requestId"]] = (raw["expiresAt"], fingerprint, uncertain)
        started = threading.Event()
        def invoke():
            started.set()
            try:
                return self.callback(dict(raw), token, current)
            finally:
                self.pending = False  # Real worker settlement, not ACK cancellation.
        try:
            coroutine = None
            try:
                coroutine = asyncio.to_thread(invoke)
                worker = asyncio.create_task(coroutine)
            except BaseException:
                if coroutine is not None:
                    coroutine.close()
                self.pending = False  # No task was submitted; invoke cannot run.
                raise
            def consume(done):
                try:
                    error = done.exception()
                    if error is not None and not started.is_set():
                        self.pending = False  # Proven executor scheduling failure.
                except BaseException:
                    pass  # Cancelled/detached workers never log private exceptions.
            worker.add_done_callback(consume)
            code, count = await asyncio.shield(worker)
            if not current() or self.sid() != raw["sessionId"]:
                return reply("owner_changed")
            if self.clock() * 1000 >= raw["expiresAt"]:
                return reply("expired")
            if code not in CODES or type(count) is not int or not 0 <= count <= 999999 or (code != "accepted" and count):
                code, count = "local_error", 0
            answer = reply(code, count)
            self.replies[raw["requestId"]] = (raw["expiresAt"], fingerprint, answer)
            return dict(answer)
        except Exception:
            return reply("local_error")
