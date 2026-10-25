"""Periodic heartbeat to the cloud so the API knows this agent is alive.

The agent doesn't keep a long-lived socket — it only POSTs replays —
so without this signal the cloud can't tell "agent stopped" from
"player isn't laddering right now". A small POST every minute is
cheap and lets the dashboard show a green/grey dot per device.

The cloud route is ``POST /v1/devices/heartbeat`` and is authenticated
by the device token (same as the replay upload path).
"""

from __future__ import annotations

import logging
import platform
import socket
import threading
import time
from typing import Optional, Callable
from pathlib import Path

from . import __version__
from .api_client import ApiClient

DEFAULT_INTERVAL_SEC = 60.0
INITIAL_DELAY_SEC = 5.0


def _local_hostname() -> Optional[str]:
    """Best-effort, non-throwing hostname lookup.

    The cloud uses this to label rows on the Devices page so the user
    can tell their gaming PC apart from the laptop. ``socket.gethostname``
    can technically raise on misconfigured boxes, so we swallow and
    return ``None`` — the cloud falls back to OS + version when no
    hostname is sent.
    """
    try:
        name = socket.gethostname()
    except Exception:  # noqa: BLE001
        return None
    if not name:
        return None
    return name.strip() or None


class Heartbeat:
    """Background thread that POSTs a small ping to the cloud."""

    def __init__(
        self,
        api: ApiClient,
        *,
        interval_sec: float = DEFAULT_INTERVAL_SEC,
        on_success: Optional[Callable[[], None]] = None,
        on_failure: Optional[Callable[[Exception], None]] = None,
        on_overlay_tokens: Optional[Callable] = None,
        state_dir: Optional[Path] = None,
    ) -> None:
        self._on_success = on_success or (lambda: None)
        self._on_failure = on_failure or (lambda _exc: None)
        self._on_overlay_tokens = on_overlay_tokens
        self._api = api
        if state_dir is not None:
            from .preset_policy import PresetPolicyRefresh
            self._preset_policy = PresetPolicyRefresh(api, state_dir)
        else:
            self._preset_policy = None
        self._interval = interval_sec
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._log = logging.getLogger("sc2tools_agent.heartbeat")

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop, name="sc2tools-heartbeat", daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        thr = self._thread
        if thr is not None:
            thr.join(timeout=2.0)

    # ------------------------------------------------------------ loop
    def _loop(self) -> None:
        # First tick is delayed slightly so we don't race the rest of
        # boot (pairing, watcher startup) for the first request slot.
        if self._stop.wait(INITIAL_DELAY_SEC):
            return
        while not self._stop.is_set():
            try:
                self._send_one()
            except Exception:  # noqa: BLE001
                self._log.debug("heartbeat_send_failed", exc_info=True)
            if self._stop.wait(self._interval):
                return

    def _send_one(self) -> None:
        body = {
            "version": __version__,
            "os": platform.system(),
            "osRelease": platform.release(),
            "ts": int(time.time() * 1000),
        }
        hostname = _local_hostname()
        if hostname:
            body["hostname"] = hostname
        # Reuse the api_client request infrastructure (auth, retries,
        # backoff). Failures are logged-only — we'll try again next tick.
        try:
            api = self._api  # Recovery may replace self._api while this request is in flight.
            response = api._post("/v1/devices/heartbeat", auth=True, body=body)
            self._on_success()
        except Exception as exc:  # noqa: BLE001
            self._on_failure(exc)
            self._log.debug("heartbeat_attempt_failed: %s", exc)
            return
        if self._on_overlay_tokens is not None:
            try:
                receipts = response.get("overlayTokenReplacements", []) if isinstance(response, dict) else []
                self._on_overlay_tokens(receipts, api)
            except Exception as exc:  # Advisory repair must not fail the heartbeat/watchdog.
                self._log.debug("overlay_token_advisory_failed type=%s", type(exc).__name__)
        if self._preset_policy is not None:
            self._preset_policy.refresh()
