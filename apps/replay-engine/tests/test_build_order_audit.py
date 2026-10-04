"""Regressions for build-order ordering and main-base event shape."""

import os
import sys

import pytest

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from core.strategy_detector_base import BaseStrategyDetector
from core.strategy_detector_race import classify_by_race


def _building(name, time, subtype="init"):
    return {
        "type": "building", "name": name, "time": time,
        "subtype": subtype, "x": 10.0, "y": 10.0,
    }


def _unit(name, time):
    return {"type": "unit", "name": name, "time": time}


def _classify(race, opponent, events):
    return classify_by_race(
        race, events, BaseStrategyDetector(custom_builds=[]), opp_race=opponent,
    )


def _macro_events(pool_time, natural_time, main_subtype):
    return [
        _building("Hatchery", 0, main_subtype),
        _building("SpawningPool", pool_time),
        _building("Hatchery", natural_time),
        _building("Hatchery", 230),
        *[_unit("Drone", 0) for _ in range(12)],
        *[_unit("Drone", 12 * (i + 1)) for i in range(28)],
    ]


@pytest.mark.parametrize("main_subtype", ["init", "born"])
@pytest.mark.parametrize("opponent", ["Protoss", "Terran", "Zerg"])
@pytest.mark.parametrize("natural_time", [80, 130])
def test_pool_first_or_simultaneous_natural_is_not_hatch_first_macro(
    main_subtype, opponent, natural_time,
):
    events = _macro_events(80, natural_time, main_subtype)
    assert _classify("Zerg", opponent, events) == "Zerg - 3 Base Macro (Pool First)"


@pytest.mark.parametrize("main_subtype", ["init", "born"])
@pytest.mark.parametrize("opponent,expected", [
    ("Protoss", "ZvP - Hatch First Macro"),
    ("Terran", "ZvT - Hatch First Macro"),
    ("Zerg", "ZvZ - Drone Macro (Hatch First)"),
])
def test_literal_hatch_first_macro_remains_matchup_specific(
    main_subtype, opponent, expected,
):
    events = _macro_events(96, 72, main_subtype)
    assert _classify("Zerg", opponent, events) == expected


@pytest.mark.parametrize("main_subtype", ["init", "born"])
@pytest.mark.parametrize("natural_time", [80, 130])
def test_zvz_pool_first_or_simultaneous_natural_is_not_hatch_first_muta(
    main_subtype, natural_time,
):
    events = [
        _building("Hatchery", 0, main_subtype),
        _building("SpawningPool", 80),
        _building("Hatchery", natural_time),
        _building("Spire", 450),
    ]
    assert _classify("Zerg", "Zerg", events) == "Zerg - Pool First Opener"


@pytest.mark.parametrize("main_subtype", ["init", "born"])
def test_zvz_literal_hatch_first_muta_remains_matchup_specific(main_subtype):
    events = [
        _building("Hatchery", 0, main_subtype),
        _building("Hatchery", 72),
        _building("SpawningPool", 96),
        _building("Spire", 450),
    ]
    assert _classify("Zerg", "Zerg", events) == "ZvZ - Hatch First Muta"


@pytest.mark.parametrize("main_subtype", ["init", "born"])
@pytest.mark.parametrize("opponent", [None, "Protoss", "Terran", "Zerg"])
def test_terran_main_birth_shape_does_not_hide_three_rax_marine_rush(
    main_subtype, opponent,
):
    events = [
        _building("CommandCenter", 0, main_subtype),
        _building("Barracks", 70),
        _building("Barracks", 90),
        _building("Barracks", 110),
        *[_unit("Marine", 150 + i * 18) for i in range(9)],
    ]
    assert _classify("Terran", opponent, events) == "Terran - 3-4 Rax Marine rush"


@pytest.mark.parametrize("main_subtype", ["init", "born"])
@pytest.mark.parametrize("opponent", [None, "Protoss", "Terran", "Zerg"])
def test_terran_main_birth_shape_does_not_hide_three_rax_expand(
    main_subtype, opponent,
):
    events = [
        _building("CommandCenter", 0, main_subtype),
        _building("CommandCenter", 150),
        _building("Barracks", 70),
        _building("Barracks", 200),
        _building("Barracks", 220),
        _building("Refinery", 90),
    ]
    assert _classify("Terran", opponent, events) == "Terran - 3 Rax"


@pytest.mark.parametrize("main_subtype", ["init", "born"])
@pytest.mark.parametrize("base_count", [1, 2, 3])
@pytest.mark.parametrize("opponent,extra_events,two_base_label", [
    ("Terran", [_unit("SiegeTank", 500)], "TvT - 2-1-1 Marine Tank"),
    ("Protoss", [_unit("SiegeTank", 500)], "TvP - 2 Base Tank Push"),
    ("Zerg", [_unit("Medivac", 450)], "TvZ - 2-1-1 Marine Drop"),
    ("Zerg", [
        _building("Armory", 350),
        *[_unit("Hellion", 250 + i * 8) for i in range(4)],
    ], "TvZ - 2-1-1 Marine Hellbat Timing"),
    ("Zerg", [
        _building("Factory", 350), _building("Armory", 300),
        *[_unit("Hellion", 250 + i * 8) for i in range(4)],
        _unit("Thor", 500),
    ], "TvZ - 2 Base Hellbat Thor"),
])
def test_two_base_terran_timings_require_exactly_two_bases(
    main_subtype, base_count, opponent, extra_events, two_base_label,
):
    events = [
        _building("CommandCenter", 0, main_subtype),
        *[_building("CommandCenter", 150 + i * 20) for i in range(base_count - 1)],
        _building("Barracks", 80), _building("Factory", 200),
        _building("Starport", 300),
        *[_unit("Marine", 250 + i * 8) for i in range(8)],
        *extra_events,
    ]
    expected = {
        1: "Terran - 1-1-1 One Base",
        2: two_base_label,
        3: "Terran - Fast 3 CC",
    }[base_count]
    assert _classify("Terran", opponent, events) == expected
