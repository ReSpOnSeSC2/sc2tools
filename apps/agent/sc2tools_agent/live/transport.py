"""Transport layer for the Live Game Bridge.

The supported default is **cloud-only**: the agent POSTs each envelope
to ``/v1/agent/live`` and the cloud's ``LiveGameBroker`` fans it out
to every ``overlay:<token>`` Socket.io room belonging to the user
(driving the hosted ``sc2tools.com/overlay/<token>/widget/<name>``
Browser Sources) plus the per-user SSE stream the dashboard listens
on.

Two transport classes are exported here:

1. **CloudTransport** (default) — HTTPS POST to ``/v1/agent/live``
   using the existing device-token Bearer auth. Used by every
   production install.

2. **OverlayBackendTransport** (opt-in) — HTTP POST to a local URL
   (default-shaped at ``http://localhost:3000/api/agent/live``) so
   the legacy self-hosted
   ``reveal-sc2-opponent-main/stream-overlay-backend`` product can
   re-broadcast ``liveGameState`` to its own Socket.io clients. NOT
   wired by default — the runner only constructs it when
   ``SC2TOOLS_LOCAL_OVERLAY_URL`` is set or
   ``_build_live_bridge(overlay_base_url=...)`` is passed an explicit
   URL. The cloud product (sc2tools.com) does not depend on this
   path, and a default-cloud install ships zero traffic to
   localhost:3000.

Both transports are lossy by design — the bridge fires payloads at
~1 Hz; if a single POST fails (network blip, overlay backend not
running), we drop it and rely on the next poll's fresh data. There's
no retry queue — burning a thread context on a 1-second-stale payload
is worse than just waiting for the next snapshot.

Each transport has a small token-bucket rate limit (per-second) so a
buggy bridge upstream can't DDoS the cloud or the local backend.
"""

from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, Optional

import requests

from .metrics import METRICS

_log = logging.getLogger("sc2tools_agent.live.transport")

# Per-transport rate limit. ~2 messages / second is plenty for the
# 1 Hz bridge tick + the occasional out-of-band Pulse re-emit; tighter
# than that and a normal load drops payloads.
DEFAULT_RATE_PER_SEC = 4.0
DEFAULT_HTTP_TIMEOUT_SEC = 3.0
DEFAULT_MAX_WORKERS = 2


class _TokenBucket:
    """Trivial token-bucket rate limiter — thread-safe."""

    def __init__(self, *, rate_per_sec: float, capacity: float) -> None:
        self._rate = rate_per_sec
        self._capacity = capacity
        self._tokens = capacity
        self._last_refill = time.monotonic()
        self._lock = threading.Lock()

    def try_take(self) -> bool:
        with self._lock:
            now = time.monotonic()
            elapsed = now - self._last_refill
            self._last_refill = now
            self._tokens = min(self._capacity, self._tokens + elapsed * self._rate)
            if self._tokens >= 1.0:
                self._tokens -= 1.0
                return True
            return False


class OverlayBackendTransport:
    """Push envelopes to the local overlay backend over HTTP.

    The overlay backend's ``POST /api/agent/live`` route accepts any
    JSON body and re-broadcasts it as a ``liveGameState`` envelope on
    its existing ``overlay_event`` channel. Auth is a shared device
    token sent as ``X-SC2Tools-Agent-Token`` — the overlay backend
    rejects requests whose token doesn't match its own configured
    secret, mitigating the "any local process can spoof" risk the
    prompt's security section called out.

    All sends are non-blocking — the bridge fires fast and the
    transport queues to its own worker pool.
    """

    def __init__(
        self,
        *,
        base_url: str = "http://localhost:3000",
        device_token: Optional[str] = None,
        session: Optional[requests.Session] = None,
        rate_per_sec: float = DEFAULT_RATE_PER_SEC,
        timeout_sec: float = DEFAULT_HTTP_TIMEOUT_SEC,
        max_workers: int = DEFAULT_MAX_WORKERS,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = device_token
        self._session = session or requests.Session()
        self._timeout = timeout_sec
        self._executor = ThreadPoolExecutor(
            max_workers=max_workers,
            thread_name_prefix="sc2tools-overlay-tx",
        )
        self._bucket = _TokenBucket(
            rate_per_sec=rate_per_sec, capacity=rate_per_sec * 2,
        )
        # Diagnostics counters surfaced through the metrics module.
        self.sent_ok = 0
        self.sent_failed = 0
        self.dropped_rate_limited = 0
        # Track recent failures so we can quietly back off (don't spam
        # logs when the user just hasn't started the overlay backend).
        self._consecutive_failures = 0
        self._mute_log_until = 0.0

    def push(self, envelope: Dict[str, Any]) -> None:
        if not self._bucket.try_take():
            self.dropped_rate_limited += 1
            return
        self._executor.submit(self._send, envelope)

    def shutdown(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)

    # ------------------------------------------------------------------
    def _send(self, envelope: Dict[str, Any]) -> None:
        url = f"{self._base_url}/api/agent/live"
        headers = {"content-type": "application/json"}
        if self._token:
            headers["x-sc2tools-agent-token"] = self._token
        started = time.monotonic()
        try:
            r = self._session.post(
                url,
                json=envelope,
                headers=headers,
                timeout=self._timeout,
            )
        except requests.RequestException:
            METRICS.incr("transport.overlay.error")
            self._record_failure()
            return
        METRICS.observe_ms(
            "transport.overlay.latency",
            (time.monotonic() - started) * 1000.0,
        )
        if 200 <= r.status_code < 300:
            METRICS.incr("transport.overlay.ok")
            self.sent_ok += 1
            self._consecutive_failures = 0
            return
        METRICS.incr("transport.overlay.bad_status")
        self._record_failure()

    def _record_failure(self) -> None:
        self.sent_failed += 1
        self._consecutive_failures += 1
        # First few failures: quiet (overlay backend just isn't running).
        # After 10 consecutive failures, log once per minute so the
        # operator gets a hint without spam.
        if self._consecutive_failures > 10:
            now = time.time()
            if now > self._mute_log_until:
                _log.info(
                    "overlay_transport_unhealthy consecutive=%d "
                    "(overlay backend may not be running)",
                    self._consecutive_failures,
                )
                self._mute_log_until = now + 60.0


class CloudTransport:
    """Push envelopes to the cloud API.

    Uses ``ApiClient.push_agent_live`` so it shares the existing
    retry / auth / Retry-After handling. Each push runs in a worker
    thread so the bridge's emit loop never blocks on network latency.
    """

    def __init__(
        self,
        *,
        api_client: Any,
        rate_per_sec: float = DEFAULT_RATE_PER_SEC,
        max_workers: int = DEFAULT_MAX_WORKERS,
    ) -> None:
        self._api = api_client
        self._executor = ThreadPoolExecutor(
            max_workers=max_workers,
            thread_name_prefix="sc2tools-cloud-tx",
        )
        self._bucket = _TokenBucket(
            rate_per_sec=rate_per_sec, capacity=rate_per_sec * 2,
        )
        self.sent_ok = 0
        self.sent_failed = 0
        self.dropped_rate_limited = 0
        self._consecutive_failures = 0
        self._mute_log_until = 0.0

    def push(self, envelope: Dict[str, Any]) -> None:
        if not self._bucket.try_take():
            self.dropped_rate_limited += 1
            return
        self._executor.submit(self._send, envelope)

    def shutdown(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)

    # ------------------------------------------------------------------
    def _send(self, envelope: Dict[str, Any]) -> None:
        started = time.monotonic()
        try:
            self._api.push_agent_live(envelope=envelope)
        except PermissionError:
            # Not paired yet — don't try to send. The bridge keeps
            # running locally; once pairing completes the agent reboots
            # the relevant subsystems.
            METRICS.incr("transport.cloud.skipped_unpaired")
            return
        except Exception:  # noqa: BLE001
            METRICS.incr("transport.cloud.error")
            self.sent_failed += 1
            self._consecutive_failures += 1
            if self._consecutive_failures > 10:
                now = time.time()
                if now > self._mute_log_until:
                    _log.info(
                        "cloud_transport_unhealthy consecutive=%d",
                        self._consecutive_failures,
                    )
                    self._mute_log_until = now + 60.0
            return
        METRICS.observe_ms(
            "transport.cloud.latency",
            (time.monotonic() - started) * 1000.0,
        )
        METRICS.incr("transport.cloud.ok")
        self.sent_ok += 1
        self._consecutive_failures = 0


class FanOutTransport:
    """Convenience wrapper that pushes to many transports at once.

    Subscribed to ``LiveBridge.bus`` — one ``push`` call fans out to
    every wrapped transport. Each transport handles its own rate
    limiting / retry / failure semantics independently.
    """

    def __init__(self, *transports: Any) -> None:
        self._transports = list(transports)

    def push(self, envelope: Dict[str, Any]) -> None:
        for t in self._transports:
            try:
                t.push(envelope)
            except Exception:  # noqa: BLE001
                _log.debug(
                    "fanout_transport_push_failed transport=%s",
                    type(t).__name__,
                    exc_info=True,
                )

    def shutdown(self) -> None:
        for t in self._transports:
            try:
                t.shutdown()
            except Exception:  # noqa: BLE001
                pass

    @property
    def listener(self) -> Callable[[Dict[str, Any]], None]:
        """Return the callable to subscribe on ``bridge.bus``."""
        return self.push


__all__ = [
    "CloudTransport",
    "FanOutTransport",
    "OverlayBackendTransport",
]
