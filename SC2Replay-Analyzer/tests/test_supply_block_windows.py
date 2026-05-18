"""Unit tests for per-window supply-block detection.

Pure-function tests for ``detect_supply_block_windows`` and the
``raw["supply_block_windows"]`` plumbing through ``compute_macro_score``.
Both exercise dict inputs only — no real replay parsing — so this
module runs cleanly even when sc2reader is not installed in the test
runner.

The chart binds its translucent supply-block bands to the emitted
windows. Pre-fix the agent only emitted ``supply_blocked_seconds`` as
an aggregate, so a player with 40 s of total blocks saw no bands on
the chart. These tests pin the per-window shape so the visualisation
can't silently regress.

Module: tests
"""
from __future__ import annotations

import os
import sys
from typing import Any, Dict, List
from unittest.mock import MagicMock

sys.modules.setdefault("sc2reader", MagicMock())
sys.modules.setdefault("sc2reader.events", MagicMock())
sys.modules.setdefault("sc2reader.events.tracker", MagicMock())
sys.modules.setdefault("sc2reader.events.game", MagicMock())

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import pytest  # noqa: E402

from analytics.macro_score import (  # noqa: E402
    _supply_block_seconds,
    compute_macro_score,
    detect_supply_block_windows,
)


def _sample(time: int, food_used: int, food_made: int) -> Dict[str, Any]:
    return {"time": time, "food_used": food_used, "food_made": food_made}


def test_empty_stats_returns_no_windows():
    assert detect_supply_block_windows([]) == []


def test_single_blocked_run_produces_one_window():
    # Three contiguous blocked samples 10s apart; the 10s sample is not
    # blocked → window closes at 30 (the time of the first unblocked
    # sample). Each blocked sample credits min(gap, 4) = 4 s, so the
    # window's blocked_sec = 12 s for the three blocked samples
    # (including the gap to the unblocked sample at t=30).
    stats = [
        _sample(0, 20, 20),
        _sample(10, 22, 22),
        _sample(20, 28, 28),
        _sample(30, 32, 40),
    ]
    windows = detect_supply_block_windows(stats)
    assert len(windows) == 1
    assert windows[0]["start"] == 0
    assert windows[0]["end"] == 30
    assert windows[0]["blocked_sec"] == pytest.approx(12.0)


def test_two_separated_blocked_runs_emit_two_windows():
    stats = [
        _sample(0, 22, 22),
        _sample(10, 30, 38),     # not blocked — splits the runs
        _sample(20, 40, 40),
        _sample(30, 50, 50),
        _sample(40, 60, 68),     # not blocked — closes second run
    ]
    windows = detect_supply_block_windows(stats)
    assert len(windows) == 2
    assert (windows[0]["start"], windows[0]["end"]) == (0, 10)
    assert (windows[1]["start"], windows[1]["end"]) == (20, 40)


def test_block_running_at_end_closes_at_last_plus_four():
    # Block stays open through the last sample → window end clamps to
    # last_t + 4 (the per-sample floor we already credited).
    stats = [
        _sample(0, 10, 20),
        _sample(10, 30, 30),
        _sample(20, 40, 40),
    ]
    windows = detect_supply_block_windows(stats)
    assert len(windows) == 1
    assert windows[0]["start"] == 10
    assert windows[0]["end"] == 24


def test_supply_capped_samples_are_not_blocks():
    # food_used == food_made AND food_used >= 200 (the supply cap) →
    # the player is maxed, not blocked. No window emitted.
    stats = [
        _sample(0, 200, 200),
        _sample(10, 200, 200),
    ]
    assert detect_supply_block_windows(stats) == []


def test_aggregate_matches_window_sum():
    # _supply_block_seconds and detect_supply_block_windows derive from
    # the same per-sample rule — summing window blocked_sec must equal
    # the aggregate so the chart bands and the "Supply blocked" stat
    # below the chart can never disagree.
    stats = [
        _sample(0, 22, 22),
        _sample(10, 30, 38),
        _sample(20, 40, 40),
        _sample(30, 50, 50),
        _sample(40, 60, 68),
    ]
    windows = detect_supply_block_windows(stats)
    aggregate = _supply_block_seconds(stats)
    assert aggregate == pytest.approx(sum(w["blocked_sec"] for w in windows))


def test_compute_macro_score_emits_supply_block_windows():
    # Smoke-test the plumbing into ``raw`` so the SPA's chart prop is
    # actually populated. Empty opp series → opp_supply_block_windows
    # is an empty list.
    macro_events = {
        "stats_events": [
            _sample(0, 22, 22),
            _sample(10, 30, 38),
        ],
        "opp_stats_events": [],
        "ability_events": [],
        "bases": [],
        "game_length_sec": 600,
    }
    result = compute_macro_score(macro_events, "Protoss", 600)
    raw = result.get("raw") or {}
    assert "supply_block_windows" in raw
    assert "opp_supply_block_windows" in raw
    assert isinstance(raw["supply_block_windows"], list)
    assert len(raw["supply_block_windows"]) == 1
    assert raw["opp_supply_block_windows"] == []
    # Legacy field is gone — the chart's prop binding moved.
    assert "leak_windows" not in raw
    assert "opp_leak_windows" not in raw
