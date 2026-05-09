"""Unit tests for ``sc2tools_agent.live.metrics``."""

from __future__ import annotations

from sc2tools_agent.live.metrics import LiveMetrics


def test_incr_accumulates_counts() -> None:
    m = LiveMetrics()
    m.incr("x")
    m.incr("x")
    m.incr("y", 5)
    snap = m.snapshot()
    assert snap["counters"]["x"]["count"] == 2
    assert snap["counters"]["y"]["count"] == 5


def test_observe_ms_tracks_ewma_and_last() -> None:
    m = LiveMetrics()
    m.observe_ms("call", 100.0)
    m.observe_ms("call", 200.0)
    m.observe_ms("call", 50.0)
    snap = m.snapshot()
    lat = snap["latencies"]["call"]
    assert lat["last_ms"] == 50.0
    assert lat["samples"] == 3
    # EWMA with 0.2 weight after the seed of 100, then 200, then 50:
    # step1: 100 (seed)
    # step2: 0.2*200 + 0.8*100 = 120
    # step3: 0.2*50 + 0.8*120 = 106
    assert 100.0 <= lat["ewma_ms"] <= 130.0


def test_snapshot_is_jsonable() -> None:
    """The snapshot dict is shipped verbatim through the diagnostics
    endpoint; it must be JSON-serialisable (no datetimes, no
    dataclasses)."""
    import json
    m = LiveMetrics()
    m.incr("a")
    m.observe_ms("b", 12.3)
    payload = json.dumps(m.snapshot())
    parsed = json.loads(payload)
    assert parsed["counters"]["a"]["count"] == 1
    assert parsed["latencies"]["b"]["last_ms"] == 12.3


def test_reset_clears_all_state() -> None:
    m = LiveMetrics()
    m.incr("x")
    m.observe_ms("y", 1.0)
    m.reset()
    snap = m.snapshot()
    assert snap["counters"] == {}
    assert snap["latencies"] == {}
