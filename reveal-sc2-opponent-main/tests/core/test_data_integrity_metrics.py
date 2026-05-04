"""
Tests for ``core.data_integrity_metrics`` -- Stage 7 of the
data-integrity roadmap.

Pins:
  * Counter increment is namespaced by basename and visible via
    snapshot().
  * Histogram record returns p50/p95/p99 once enough data points
    arrive.
  * Unknown counter names log a warning and don't pollute snapshot().
  * Error ring buffer is bounded.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO_ROOT))

from core import data_integrity_metrics  # noqa: E402


class CounterTests(unittest.TestCase):
    def test_counter_inc_namespaced_by_basename(self):
        m = data_integrity_metrics.DataIntegrityMetrics()
        m.counter_inc("write_attempted", basename="MyOpponentHistory.json")
        m.counter_inc("write_attempted", basename="MyOpponentHistory.json", n=4)
        m.counter_inc("write_attempted", basename="meta_database.json")
        snap = m.snapshot()
        self.assertEqual(
            snap["counters"]["write_attempted"]["MyOpponentHistory.json"], 5
        )
        self.assertEqual(
            snap["counters"]["write_attempted"]["meta_database.json"], 1
        )

    def test_unknown_counter_is_dropped(self):
        m = data_integrity_metrics.DataIntegrityMetrics()
        m.counter_inc("definitely_not_a_real_counter")
        self.assertEqual(m.snapshot()["counters"], {})


class HistogramTests(unittest.TestCase):
    def test_summary_has_percentiles(self):
        m = data_integrity_metrics.DataIntegrityMetrics()
        for v in [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]:
            m.histogram_record("write_duration_ms", v, basename="x.json")
        snap = m.snapshot()
        summary = snap["histogram_summary"]["write_duration_ms:x.json"]
        self.assertEqual(summary["count"], 10)
        self.assertGreaterEqual(summary["p50"], 50)
        self.assertGreaterEqual(summary["p95"], 90)
        self.assertEqual(summary["min"], 10)
        self.assertEqual(summary["max"], 100)

    def test_histogram_is_bounded(self):
        m = data_integrity_metrics.DataIntegrityMetrics()
        # 1100 samples -> trimmed to most recent 1000.
        for i in range(1100):
            m.histogram_record("h", i, basename="x")
        snap = m.snapshot()
        self.assertEqual(snap["histogram_summary"]["h:x"]["count"], 1000)


class ErrorBufferTests(unittest.TestCase):
    def test_ring_buffer_bounded(self):
        m = data_integrity_metrics.DataIntegrityMetrics()
        for i in range(150):
            m.error("DataIntegrityError", detail={"i": i})
        snap = m.snapshot()
        self.assertLessEqual(len(snap["recent_errors"]), 100)
        # Most-recent error first / last entry should be 149.
        self.assertEqual(snap["recent_errors"][-1]["detail"]["i"], 149)


if __name__ == "__main__":
    unittest.main()
