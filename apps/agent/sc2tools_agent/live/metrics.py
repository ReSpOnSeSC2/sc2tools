"""In-process metrics for the Live Game Bridge.

Surfaces per-source counters + latencies so an operator can answer
"is the bridge healthy right now?" without spinning up Prometheus or
Sentry. Three usage shapes:

* The bridge / poller / pulse / transports increment counters on
  success and failure; the transport modules also stash send/failure
  counts on themselves which we aggregate here.
* A periodic logger dumps the snapshot to ``agent.log`` at INFO
  every 5 minutes so a long-running session leaves a paper trail.
* The agent's existing diagnostics endpoint (added by the runner if
  the user asks for it) can call ``snapshot()`` synchronously and
  return the dict to the user.

Intentionally tiny — no HDR-histogram, no Prometheus formatting, no
exemplars. The real-time path is small enough that simple counters +
EWMA-style latency is enough to answer the operator's questions.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

_log = logging.getLogger("sc2tools_agent.live.metrics")


@dataclass
class _Counter:
    count: int = 0
    last_at: float = 0.0


@dataclass
class _Latency:
    """Exponentially-weighted moving average latency tracker.

    Mirrors the shape Sentry / Datadog use for "p50-ish" estimates
    without keeping a full ring buffer. We expose ``last_ms`` (most
    recent observation) plus the EWMA so an operator can spot a
    sudden regression vs. a long-term trend in the same line.
    """

    ewma_ms: float = 0.0
    last_ms: float = 0.0
    samples: int = 0

    def observe(self, ms: float) -> None:
        self.last_ms = ms
        self.samples += 1
        if self.samples == 1:
            self.ewma_ms = ms
        else:
            # 0.2 weight matches what Datadog uses for short-window
            # latency views — responsive to regressions, smooth over
            # one-off spikes.
            self.ewma_ms = (0.2 * ms) + (0.8 * self.ewma_ms)


class LiveMetrics:
    """Per-process metrics singleton. Thread-safe."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._counters: Dict[str, _Counter] = defaultdict(_Counter)
        self._latencies: Dict[str, _Latency] = defaultdict(_Latency)

    def incr(self, name: str, amount: int = 1) -> None:
        with self._lock:
            c = self._counters[name]
            c.count += amount
            c.last_at = time.time()

    def observe_ms(self, name: str, ms: float) -> None:
        with self._lock:
            self._latencies[name].observe(ms)

    def snapshot(self) -> Dict[str, Any]:
        """Return a JSON-friendly dict of every tracked counter +
        latency. Stable shape — the diagnostics endpoint can ship it
        verbatim."""
        with self._lock:
            return {
                "counters": {
                    name: {
                        "count": c.count,
                        "last_at": c.last_at,
                    }
                    for name, c in self._counters.items()
                },
                "latencies": {
                    name: {
                        "ewma_ms": round(l.ewma_ms, 2),
                        "last_ms": round(l.last_ms, 2),
                        "samples": l.samples,
                    }
                    for name, l in self._latencies.items()
                },
                "captured_at": time.time(),
            }

    def reset(self) -> None:
        """Test helper. Production code never resets in flight."""
        with self._lock:
            self._counters.clear()
            self._latencies.clear()


# Module-level singleton — every subsystem in ``sc2tools_agent.live``
# imports ``METRICS`` and calls counters/observers on it. The runner
# constructs nothing extra; the singleton survives runner restarts
# within a single process (which is the only meaningful scope for
# in-process counters).
METRICS = LiveMetrics()


class PeriodicMetricsLogger:
    """Background thread that dumps ``METRICS.snapshot()`` to the
    agent log every ``interval_sec``. Stops cleanly on ``stop()``.

    Use case: operators tailing ``agent.log`` see a 5-minute summary
    line they can grep for ``live_metrics`` to spot trends.
    """

    def __init__(
        self,
        *,
        interval_sec: float = 300.0,
        metrics: Optional[LiveMetrics] = None,
    ) -> None:
        self._interval = interval_sec
        self._metrics = metrics or METRICS
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop,
            name="sc2tools-live-metrics",
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)

    def _loop(self) -> None:
        # Skip the first wait so the operator sees a snapshot soon
        # after agent start (helps confirm the bridge wired up
        # correctly without waiting 5 min).
        if self._stop.wait(min(60.0, self._interval)):
            return
        while not self._stop.is_set():
            try:
                _log.info(
                    "live_metrics %s",
                    self._compact_summary(),
                )
            except Exception:  # noqa: BLE001
                _log.debug("live_metrics_log_failed", exc_info=True)
            if self._stop.wait(self._interval):
                return

    def _compact_summary(self) -> str:
        snap = self._metrics.snapshot()
        bits = []
        for name in sorted(snap["counters"]):
            bits.append(f"{name}={snap['counters'][name]['count']}")
        for name in sorted(snap["latencies"]):
            lat = snap["latencies"][name]
            bits.append(f"{name}_ewma_ms={lat['ewma_ms']:.0f}")
        return " ".join(bits) if bits else "(empty)"


__all__ = ["METRICS", "LiveMetrics", "PeriodicMetricsLogger"]
