"""Unit tests for chrono target tracking and aggregation.

Pure-function tests for ``_build_chrono_targets`` and the
``raw["chrono_targets"]`` plumbing through ``compute_macro_score``. Both
exercise dict inputs only — no real replay parsing — so this module
runs cleanly even when sc2reader is not installed in the test runner.

When a fixture replay exists at
``tests/fixtures/replays/protoss_chrono.SC2Replay`` (Stage 11+), the
end-to-end integration test runs and asserts the live extraction shape.
Until then it ``pytest.skip``s without failing.

Module: tests
"""
from __future__ import annotations

import os
import sys
from typing import Any, Dict, List
from unittest.mock import MagicMock

# Match the existing test_macro_score_inject_timeline.py mocking pattern
# so this module imports without sc2reader installed.
sys.modules.setdefault("sc2reader", MagicMock())
sys.modules.setdefault("sc2reader.events", MagicMock())
sys.modules.setdefault("sc2reader.events.tracker", MagicMock())
sys.modules.setdefault("sc2reader.events.game", MagicMock())

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import pytest  # noqa: E402  (sys.path tweak above)

from core.event_extractor import (  # noqa: E402
    _build_chrono_targets,
    _resolve_target_unit_id,
)
from analytics.macro_score import compute_macro_score  # noqa: E402


# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------
def _chrono(target_unit_id: int = 0, time: int = 0) -> Dict[str, Any]:
    return {"category": "chrono", "time": time, "target_unit_id": target_unit_id}


def _other(category: str = "inject", target_unit_id: int = 0) -> Dict[str, Any]:
    return {"category": category, "time": 0, "target_unit_id": target_unit_id}


# -----------------------------------------------------------------------------
# _resolve_target_unit_id
# -----------------------------------------------------------------------------
def test_resolve_target_unit_id_reads_attribute():
    e = type("E", (), {"target_unit_id": 1234})()
    assert _resolve_target_unit_id(e) == 1234


def test_resolve_target_unit_id_zero_when_missing():
    e = type("E", (), {})()
    assert _resolve_target_unit_id(e) == 0


def test_resolve_target_unit_id_zero_when_none():
    e = type("E", (), {"target_unit_id": None})()
    assert _resolve_target_unit_id(e) == 0


def test_resolve_target_unit_id_handles_garbage():
    e = type("E", (), {"target_unit_id": "not-an-int"})()
    assert _resolve_target_unit_id(e) == 0


# -----------------------------------------------------------------------------
# _build_chrono_targets — pure aggregation
# -----------------------------------------------------------------------------
def test_build_chrono_targets_empty_list():
    assert _build_chrono_targets([], {}) == []


def test_build_chrono_targets_filters_non_chrono_categories():
    """Inject / mule events must not bleed into chrono aggregation."""
    events = [
        _other("inject", 1),
        _other("mule", 2),
        _other("other", 3),
    ]
    assert _build_chrono_targets(events, {1: "Hatchery"}) == []


def test_build_chrono_targets_aggregates_by_name():
    events = [_chrono(10), _chrono(10), _chrono(20)]
    result = _build_chrono_targets(events, {10: "Nexus", 20: "Gateway"})
    # Sorted by count desc.
    assert result == [
        {"building_name": "Nexus", "count": 2},
        {"building_name": "Gateway", "count": 1},
    ]


def test_build_chrono_targets_unresolved_buckets_as_unknown():
    """unit_id not in name_by_uid -> 'Unknown' bucket. We never invent."""
    events = [_chrono(99), _chrono(99)]
    result = _build_chrono_targets(events, {})
    assert result == [{"building_name": "Unknown", "count": 2}]


def test_build_chrono_targets_zero_target_buckets_as_unknown():
    """target_unit_id == 0 means sc2reader had no target field at all."""
    events = [_chrono(0)]
    result = _build_chrono_targets(events, {10: "Nexus"})
    assert result == [{"building_name": "Unknown", "count": 1}]


def test_build_chrono_targets_mixed_resolved_and_unknown():
    events = [_chrono(10), _chrono(0), _chrono(10), _chrono(99)]
    result = _build_chrono_targets(events, {10: "Nexus"})
    assert result == [
        {"building_name": "Nexus", "count": 2},
        {"building_name": "Unknown", "count": 2},
    ]


def test_build_chrono_targets_alphabetical_tie_break():
    events = [_chrono(10), _chrono(20)]
    result = _build_chrono_targets(events, {10: "Stargate", 20: "Forge"})
    # Tied counts -> alphabetical order on building_name.
    assert result == [
        {"building_name": "Forge", "count": 1},
        {"building_name": "Stargate", "count": 1},
    ]


def test_build_chrono_targets_handles_garbage_uid():
    """Non-int target_unit_id (e.g. None, 'abc') buckets as Unknown."""
    events: List[Dict[str, Any]] = [
        {"category": "chrono", "target_unit_id": None},
        {"category": "chrono", "target_unit_id": "abc"},
        {"category": "chrono"},  # missing field entirely
    ]
    result = _build_chrono_targets(events, {})
    assert result == [{"building_name": "Unknown", "count": 3}]


# -----------------------------------------------------------------------------
# compute_macro_score - chrono_targets passthrough
# -----------------------------------------------------------------------------
def _toss_macro_events(
    chrono_targets: List[Dict[str, Any]],
    chrono_count: int = 5,
) -> Dict[str, Any]:
    """Build a minimal macro_events dict that triggers the Protoss branch."""
    abilities = [_chrono(target_unit_id=10) for _ in range(chrono_count)]
    bases = [{"unit_id": 1, "name": "Nexus", "born_time": 0, "died_time": 600}]
    return {
        "stats_events": [],
        "ability_events": abilities,
        "bases": bases,
        "chrono_targets": chrono_targets,
        "game_length_sec": 600,
    }


def test_compute_macro_score_protoss_includes_chrono_targets():
    targets = [{"building_name": "Nexus", "count": 5}]
    result = compute_macro_score(
        _toss_macro_events(targets), my_race="Protoss", game_length_sec=600,
    )
    assert "raw" in result
    assert result["raw"].get("chrono_targets") == targets


def test_compute_macro_score_protoss_with_empty_chrono_targets():
    """Empty list still passes through - the SPA gates render on length>0."""
    result = compute_macro_score(
        _toss_macro_events([]), my_race="Protoss", game_length_sec=600,
    )
    assert result["raw"].get("chrono_targets") == []


def test_compute_macro_score_zerg_omits_chrono_targets():
    """Zerg replays must NOT have chrono_targets in raw - they don't chrono."""
    macro_events = {
        "stats_events": [],
        "ability_events": [],
        "bases": [{"unit_id": 1, "name": "Hatchery", "born_time": 0, "died_time": 600}],
        "chrono_targets": [{"building_name": "Nexus", "count": 1}],
        "game_length_sec": 600,
    }
    result = compute_macro_score(macro_events, my_race="Zerg", game_length_sec=600)
    assert "chrono_targets" not in result["raw"]


def test_compute_macro_score_terran_omits_chrono_targets():
    macro_events = {
        "stats_events": [],
        "ability_events": [],
        "bases": [{"unit_id": 1, "name": "OrbitalCommand",
                   "born_time": 0, "died_time": 600}],
        "chrono_targets": [{"building_name": "Nexus", "count": 1}],
        "game_length_sec": 600,
    }
    result = compute_macro_score(macro_events, my_race="Terran", game_length_sec=600)
    assert "chrono_targets" not in result["raw"]


def test_compute_macro_score_protoss_garbage_chrono_targets_skipped():
    """If macro_events.chrono_targets is not a list, raw should NOT contain it.

    Defensive: if a corrupt cache file or older extractor surfaces a
    non-list, we'd rather omit the key than crash the SPA donut.
    """
    macro_events = _toss_macro_events([])
    macro_events["chrono_targets"] = "not-a-list"
    result = compute_macro_score(macro_events, my_race="Protoss",
                                 game_length_sec=600)
    assert "chrono_targets" not in result["raw"]


# -----------------------------------------------------------------------------
# Integration test (skipped pre-Stage-11)
# -----------------------------------------------------------------------------
_FIXTURE = os.path.join(
    _ROOT, "tests", "fixtures", "replays", "protoss_chrono.SC2Replay",
)


@pytest.mark.skipif(
    not os.path.exists(_FIXTURE),
    reason="Stage 11 fixture replay not available; pure-function tests cover the logic.",
)
def test_extract_macro_events_chrono_targets_end_to_end():
    """Real replay -> chrono_targets shape + chained-state inheritance.

    Re-imports event_extractor without the MagicMock shims so the real
    sc2reader is used. Asserts:
      * ``chrono_targets`` is a list of {building_name, count}
      * Total count equals ability_counts['chrono']
      * No row with count <= 0
    """
    # Drop the mocks so sc2reader actually loads.
    for k in (
        "sc2reader", "sc2reader.events",
        "sc2reader.events.tracker", "sc2reader.events.game",
    ):
        sys.modules.pop(k, None)
    import importlib  # noqa: WPS433
    import sc2reader  # noqa: F401, WPS433
    import core.event_extractor as ee  # noqa: WPS433
    importlib.reload(ee)

    replay = sc2reader.load_replay(_FIXTURE, load_level=4)
    me = next(p for p in replay.players if p.play_race == "Protoss")
    out = ee.extract_macro_events(replay, me.pid, None)

    targets = out.get("chrono_targets")
    assert isinstance(targets, list)
    assert all(isinstance(r, dict) for r in targets)
    assert all(r.get("count", 0) > 0 for r in targets)
    assert all("building_name" in r for r in targets)
    total_in_targets = sum(r["count"] for r in targets)
    assert total_in_targets == out["ability_counts"]["chrono"]
