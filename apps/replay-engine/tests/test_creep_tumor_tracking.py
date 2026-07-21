"""Unit tests for creep tumor tracking stats.

Pure-function tests for ``_creep_tumor_stats`` and the
``raw["creep_tumors_*"]`` plumbing through ``compute_macro_score``.
Dict inputs only — no real replay parsing — so this module runs
cleanly even when sc2reader is not installed in the test runner
(same mocking pattern as test_chrono_targets.py).

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

from analytics.macro_score import (  # noqa: E402  (sys.path tweak above)
    _creep_tumor_stats,
    compute_macro_score,
)
from core.event_extractor import CREEP_TUMOR_TYPES  # noqa: E402


# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------
def _tumor(kind: str, time: int, died_time: Any = None,
           unit_id: int = 0) -> Dict[str, Any]:
    return {"time": time, "kind": kind, "unit_id": unit_id,
            "died_time": died_time}


def _zerg_macro_events(tumors: Any) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "stats_events": [],
        "ability_events": [],
        "bases": [{"unit_id": 1, "name": "Hatchery",
                   "born_time": 0, "died_time": 600}],
        "game_length_sec": 600,
    }
    if tumors is not None:
        out["creep_tumor_events"] = tumors
    return out


# -----------------------------------------------------------------------------
# CREEP_TUMOR_TYPES — the extractor's classification set
# -----------------------------------------------------------------------------
def test_creep_tumor_types_cover_all_three_forms():
    assert CREEP_TUMOR_TYPES == {
        "CreepTumor", "CreepTumorQueen", "CreepTumorBurrowed",
    }


# -----------------------------------------------------------------------------
# _creep_tumor_stats — pure aggregation
# -----------------------------------------------------------------------------
def test_stats_empty_list():
    assert _creep_tumor_stats([]) == {
        "creep_tumors_queen": 0,
        "creep_tumors_spread": 0,
        "creep_tumors_total": 0,
        "creep_tumors_lost": 0,
        "first_tumor_sec": None,
    }


def test_stats_counts_by_kind():
    tumors = [
        _tumor("queen", 150),
        _tumor("queen", 200),
        _tumor("spread", 260),
    ]
    s = _creep_tumor_stats(tumors)
    assert s["creep_tumors_queen"] == 2
    assert s["creep_tumors_spread"] == 1
    assert s["creep_tumors_total"] == 3


def test_stats_first_tumor_is_min_time_not_first_row():
    tumors = [_tumor("spread", 400), _tumor("queen", 141)]
    assert _creep_tumor_stats(tumors)["first_tumor_sec"] == 141


def test_stats_lost_counts_died_tumors():
    tumors = [
        _tumor("queen", 150, died_time=300),
        _tumor("queen", 200),
        _tumor("spread", 260, died_time=500),
    ]
    assert _creep_tumor_stats(tumors)["creep_tumors_lost"] == 2


def test_stats_skips_garbage_rows():
    tumors: List[Any] = [
        "not-a-dict",
        None,
        {"time": 100, "kind": "mystery", "died_time": 50},
        _tumor("queen", 300),
    ]
    s = _creep_tumor_stats(tumors)
    assert s["creep_tumors_total"] == 1
    # Unknown-kind rows contribute nothing — not even to lost/first.
    assert s["creep_tumors_lost"] == 0
    assert s["first_tumor_sec"] == 300


# -----------------------------------------------------------------------------
# compute_macro_score plumbing
# -----------------------------------------------------------------------------
def test_zerg_raw_carries_creep_tumor_stats():
    events = _zerg_macro_events([
        _tumor("queen", 150),
        _tumor("spread", 260, died_time=400),
    ])
    result = compute_macro_score(events, my_race="Zerg", game_length_sec=600)
    raw = result["raw"]
    assert raw["creep_tumors_queen"] == 1
    assert raw["creep_tumors_spread"] == 1
    assert raw["creep_tumors_total"] == 2
    assert raw["creep_tumors_lost"] == 1
    assert raw["first_tumor_sec"] == 150


def test_zerg_zero_tumors_still_emits_zero_counts():
    """[] means 'tracked, none planted' — distinct from key-absent."""
    result = compute_macro_score(
        _zerg_macro_events([]), my_race="Zerg", game_length_sec=600,
    )
    assert result["raw"]["creep_tumors_total"] == 0
    assert result["raw"]["first_tumor_sec"] is None


def test_zerg_old_payload_without_key_omits_creep_stats():
    """Pre-tracking extractor payloads must not fake a zero count."""
    result = compute_macro_score(
        _zerg_macro_events(None), my_race="Zerg", game_length_sec=600,
    )
    assert "creep_tumors_total" not in result["raw"]


def test_zerg_non_list_creep_events_omits_creep_stats():
    result = compute_macro_score(
        _zerg_macro_events("corrupt"), my_race="Zerg", game_length_sec=600,
    )
    assert "creep_tumors_total" not in result["raw"]


def test_protoss_omits_creep_stats():
    """Creep stats are Zerg-branch only, like chrono_targets is Protoss."""
    macro_events = {
        "stats_events": [],
        "ability_events": [],
        "bases": [{"unit_id": 1, "name": "Nexus",
                   "born_time": 0, "died_time": 600}],
        "creep_tumor_events": [_tumor("queen", 150)],
        "game_length_sec": 600,
    }
    result = compute_macro_score(macro_events, my_race="Protoss",
                                 game_length_sec=600)
    assert "creep_tumors_total" not in result["raw"]


def test_creep_stats_do_not_affect_score_or_leaks():
    """Informational only: same score with and without tumor data."""
    with_tumors = compute_macro_score(
        _zerg_macro_events([_tumor("queen", 150)]),
        my_race="Zerg", game_length_sec=600,
    )
    without = compute_macro_score(
        _zerg_macro_events(None), my_race="Zerg", game_length_sec=600,
    )
    assert with_tumors["macro_score"] == without["macro_score"]
    assert [l["name"] for l in with_tumors["all_leaks"]] == \
        [l["name"] for l in without["all_leaks"]]
