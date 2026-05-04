"""
core.data_integrity_metrics -- Stage 7 of STAGE_DATA_INTEGRITY_ROADMAP.

Lightweight in-process counters + structured logging for the
data-write hot paths. Counters are read by ``routes/diagnostics.js``
to render the "write health" widget on the SPA's Diagnostics tab.

Why an in-process module rather than ``prometheus_client``
----------------------------------------------------------
sc2tools runs as a single Node process plus a single Python watcher
on the user's desktop -- there is no Prometheus scraper, no shared
metrics endpoint, no Grafana. We need cheap counters that any caller
can increment and the diagnostics page can read in one HTTP round
trip. Layering Prometheus on top would mean a 50 MB extra dependency
for a single-user app.

Sentry hook
-----------
Stage 14 of the master roadmap ships Sentry. Until then the
``error()`` function is a structured ``logger.error`` call so the
existing log viewer / debug bundle picks up the same fields.

Usage
-----

    from core.data_integrity_metrics import DataIntegrityMetrics
    metrics = DataIntegrityMetrics.singleton()
    metrics.counter_inc("write_attempted", basename="MyOpponentHistory.json")
    metrics.histogram_record("write_duration_ms",
                             123, basename="MyOpponentHistory.json")
    metrics.error("DataIntegrityError",
                  detail={"basename": "...", "violation": "..."})

The Express backend reads via the JS sibling
``stream-overlay-backend/lib/data_integrity_metrics.js`` which is
process-local. The diagnostics widget calls
``GET /api/data-integrity/metrics`` to surface them.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import Counter, defaultdict
from typing import Any, Dict, List, Optional

logger = logging.getLogger("data_integrity")


COUNTER_NAMES = (
    "write_attempted",
    "write_succeeded",
    "write_failed",
    "lock_acquired",
    "lock_contended",
    "lock_timeout",
    "validation_rejected",
    "salvage_triggered",
    "recovery_staged",
    "recovery_applied",
    "schema_too_new_rejection",
)


class DataIntegrityMetrics:
    """Process-local counters + duration histograms.

    Thread-safe: a single RLock guards every mutation. Reads return
    snapshots so callers don't see partial state.
    """

    _instance: Optional["DataIntegrityMetrics"] = None
    _instance_lock = threading.Lock()

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._counters: Dict[str, Counter] = defaultdict(Counter)
        self._histograms: Dict[str, List[float]] = defaultdict(list)
        self._errors: List[Dict[str, Any]] = []
        self._max_errors = 100  # ring buffer for the diagnostics widget

    @classmethod
    def singleton(cls) -> "DataIntegrityMetrics":
        with cls._instance_lock:
            if cls._instance is None:
                cls._instance = cls()
            return cls._instance

    def counter_inc(self, name: str, *, basename: str = "_global", n: int = 1) -> None:
        if name not in COUNTER_NAMES:
            logger.warning("metrics: unknown counter %s", name)
            return
        with self._lock:
            self._counters[name][basename] += n

    def histogram_record(
        self, name: str, value: float, *, basename: str = "_global"
    ) -> None:
        if not isinstance(value, (int, float)):
            return
        with self._lock:
            self._histograms[name + ":" + basename].append(float(value))
            # Keep the histogram bounded so a long-running process
            # doesn't accumulate unbounded memory.
            if len(self._histograms[name + ":" + basename]) > 1000:
                self._histograms[name + ":" + basename] = (
                    self._histograms[name + ":" + basename][-1000:]
                )

    def error(self, kind: str, *, detail: Optional[Dict[str, Any]] = None) -> None:
        record = {
            "kind": kind,
            "detail": detail or {},
            "timestamp": time.time(),
        }
        with self._lock:
            self._errors.append(record)
            if len(self._errors) > self._max_errors:
                self._errors = self._errors[-self._max_errors:]
        logger.error(
            "data_integrity error", extra={"event": "data_integrity_error", **record}
        )

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "counters": {
                    name: dict(self._counters[name])
                    for name in COUNTER_NAMES
                    if name in self._counters
                },
                "histogram_summary": {
                    key: _summarize(vals)
                    for key, vals in self._histograms.items()
                },
                "recent_errors": list(self._errors),
            }


def _summarize(vals: List[float]) -> Dict[str, float]:
    if not vals:
        return {"count": 0}
    sorted_vals = sorted(vals)
    n = len(sorted_vals)
    def pct(p: float) -> float:
        idx = max(0, min(n - 1, int(p * (n - 1))))
        return sorted_vals[idx]
    return {
        "count": n,
        "p50": pct(0.50),
        "p95": pct(0.95),
        "p99": pct(0.99),
        "min": sorted_vals[0],
        "max": sorted_vals[-1],
    }


__all__ = ["DataIntegrityMetrics", "COUNTER_NAMES"]
