"""Regression tests for the matchup-prefixed "Game Too Short" bucket.

Replays that ended before 30 seconds carry no usable build order — only
the auto-spawned starting workers and maybe a Pylon / SupplyDepot /
Overlord under construction. The strategy detector short-circuits at
the top of both entry points and emits a matchup-prefixed
"<X>v<Y> - Game Too Short" label (the same string from both detectors)
so the dashboard groups these replays into one cohesive cohort and the
"Exclude too-short games" FilterBar toggle can drop them in one shot.

These tests lock in the short-circuit and all nine matchup prefixes.
Pure-function tests — no replay parsing — so this runs without
sc2reader installed.
"""
from __future__ import annotations

import importlib.util
import os
import sys
import types
from typing import Any, Dict, List

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(os.path.dirname(_HERE))  # reveal-sc2-opponent-main/
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)


def _load(mod_name: str, file_name: str):
    spec = importlib.util.spec_from_file_location(
        mod_name, os.path.join(_ROOT, "core", file_name),
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = module
    spec.loader.exec_module(module)
    return module


if "core" not in sys.modules:
    core_pkg = types.ModuleType("core")
    core_pkg.__path__ = [os.path.join(_ROOT, "core")]
    sys.modules["core"] = core_pkg
_load("core.atomic_io", "atomic_io.py")
_load("core.paths", "paths.py")
_load("core.custom_builds", "custom_builds.py")
_load("core.build_definitions", "build_definitions.py")
sd = _load("core.strategy_detector", "strategy_detector.py")


def _building(name: str, time: int) -> Dict[str, Any]:
    return {
        "type": "building", "name": name, "time": time, "x": 0.0, "y": 0.0,
        "subtype": "init",
    }


# Even a build-order-rich event list does NOT defeat the short-circuit;
# the detector is supposed to ignore events entirely once
# ``game_length_seconds < 30``.
_RICH_EVENTS: List[Dict[str, Any]] = [
    _building("Nexus", 0),
    _building("Pylon", 18),
    _building("Gateway", 60),
    _building("CyberneticsCore", 115),
    _building("Stargate", 220),
]


@pytest.mark.parametrize(
    "my_race,vs_race,expected_prefix",
    [
        ("Protoss", "Protoss", "PvP"),
        ("Protoss", "Terran", "PvT"),
        ("Protoss", "Zerg", "PvZ"),
        ("Terran", "Protoss", "TvP"),
        ("Terran", "Terran", "TvT"),
        ("Terran", "Zerg", "TvZ"),
        ("Zerg", "Protoss", "ZvP"),
        ("Zerg", "Terran", "ZvT"),
        ("Zerg", "Zerg", "ZvZ"),
    ],
)
def test_detect_my_build_short_circuits_to_matchup_label(
    my_race, vs_race, expected_prefix,
):
    """All 9 matchups: a 25-second replay must classify as
    ``<Matchup> - Game Too Short`` regardless of what events the
    detector would otherwise see."""
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build(
        f"vs {vs_race}",
        _RICH_EVENTS,
        my_race=my_race,
        game_length_seconds=25,
    )
    assert result == f"{expected_prefix} - Game Too Short", (
        f"Expected {expected_prefix} short-circuit for ({my_race} vs {vs_race}); "
        f"got {result!r}"
    )


@pytest.mark.parametrize(
    "my_race,opp_race,expected_prefix",
    [
        ("Protoss", "Protoss", "PvP"),
        ("Protoss", "Terran", "PvT"),
        ("Protoss", "Zerg", "PvZ"),
        ("Terran", "Protoss", "TvP"),
        ("Terran", "Terran", "TvT"),
        ("Terran", "Zerg", "TvZ"),
        ("Zerg", "Protoss", "ZvP"),
        ("Zerg", "Terran", "ZvT"),
        ("Zerg", "Zerg", "ZvZ"),
    ],
)
def test_get_strategy_name_short_circuits_to_matchup_label(
    my_race, opp_race, expected_prefix,
):
    """Same short-circuit fires from the opponent-side classifier when
    ``my_race`` is provided so the matchup prefix uses the USER's
    perspective (e.g. opponent's "TvP - Game Too Short" mirrors the
    user's "PvT - Game Too Short" for the same replay)."""
    detector = sd.OpponentStrategyDetector(custom_builds=[])
    result = detector.get_strategy_name(
        opp_race,
        _RICH_EVENTS,
        matchup=f"vs {opp_race}",
        game_length_seconds=25,
        my_race=my_race,
    )
    assert result == f"{expected_prefix} - Game Too Short", (
        f"Opponent classifier should short-circuit to {expected_prefix}; "
        f"got {result!r}"
    )


def test_threshold_is_strict_less_than_30():
    """29.99 fires the short-circuit; 30.0 does NOT."""
    detector = sd.UserBuildDetector(custom_builds=[])
    short = detector.detect_my_build(
        "vs Terran",
        _RICH_EVENTS,
        my_race="Protoss",
        game_length_seconds=29.99,
    )
    assert short == "PvT - Game Too Short"

    boundary = detector.detect_my_build(
        "vs Terran",
        _RICH_EVENTS,
        my_race="Protoss",
        game_length_seconds=30,
    )
    assert boundary != "PvT - Game Too Short", (
        f"30.0 seconds must run the normal classifier, not short-circuit; "
        f"got {boundary!r}"
    )


def test_short_circuit_does_not_fire_when_length_unknown():
    """``game_length_seconds=None`` (legacy callers) preserves the old
    behaviour: run the normal classification tree."""
    detector = sd.UserBuildDetector(custom_builds=[])
    result = detector.detect_my_build(
        "vs Terran",
        _RICH_EVENTS,
        my_race="Protoss",
        game_length_seconds=None,
    )
    assert result != "PvT - Game Too Short", (
        f"None duration must NOT short-circuit; got {result!r}"
    )


def test_opponent_short_circuit_falls_back_to_race_prefix_when_my_race_missing():
    """If a caller invokes ``get_strategy_name`` without ``my_race`` we
    can't build the matchup prefix from the user's perspective. Emit a
    race-prefixed fallback so the bucket still exists and the result
    is still easily filterable."""
    detector = sd.OpponentStrategyDetector(custom_builds=[])
    result = detector.get_strategy_name(
        "Terran",
        _RICH_EVENTS,
        matchup="vs Terran",
        game_length_seconds=25,
        my_race=None,
    )
    assert result == "Terran - Game Too Short", (
        f"my_race-less fallback should be race-prefixed; got {result!r}"
    )


def test_all_nine_matchup_definitions_present_in_catalog():
    """The /definitions catalog must ship all 9 matchup labels so the
    UI can render them with prose and the search index covers them."""
    import json
    with open(
        os.path.join(_ROOT, "data", "build_definitions.json"),
        "r",
        encoding="utf-8",
    ) as fh:
        defs = json.load(fh)
    for matchup in ("PvP", "PvT", "PvZ", "TvP", "TvT", "TvZ", "ZvP", "ZvT", "ZvZ"):
        name = f"{matchup} - Game Too Short"
        assert name in defs, f"Missing definition prose for {name!r}"
        # Each entry must mention the threshold so the UI is honest
        # about what it filters.
        assert "30 seconds" in defs[name], (
            f"Definition for {name!r} should state the 30-second cutoff"
        )


def test_too_short_label_helper_returns_matchup_prefix():
    """Helper is exposed at module scope so callers can build the same
    label without re-instantiating the detector."""
    assert sd.too_short_label("Protoss", "Terran") == "PvT - Game Too Short"
    assert sd.too_short_label("Zerg", "Zerg") == "ZvZ - Game Too Short"
    # Unknown / Random races fall through to "?" rather than crashing —
    # the bucket still exists for the unhappy-path replay.
    assert sd.too_short_label("Random", "Terran") == "?vT - Game Too Short"
