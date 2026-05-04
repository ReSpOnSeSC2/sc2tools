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
import threading
import time
from typing import Optional

from . import __version__
from .api_client import ApiClient

DEFAULT_INTERVAL_SEC = 60.0
INITIAL_DELAY_SEC = 5.0


class Heartbeat:
    """Background thread that POSTs a small ping to the cloud."""

    def __init__(
        self,
        api: ApiClient,
        *,
        interval_sec: float = DEFAULT_INTERVAL_SEC,
    ) -> None:
        self._api = api
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
        # Reuse the api_client request infrastructure (auth, retries,
        # backoff). Failures are logged-only — we'll try again next tick.
        try:
            self._api._post("/v1/devices/heartbeat", auth=True, body=body)
        except Exception as exc:  # noqa: BLE001
            self._log.debug("heartbeat_attempt_failed: %s", exc)
