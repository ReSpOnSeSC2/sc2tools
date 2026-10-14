"""TvP mine-drop evidence must survive the generic race fallback."""

import os
import sys

import pytest

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from core.strategy_detector_base import BaseStrategyDetector
from core.strategy_detector_race import classify_by_race


def _building(name, time):
    return {
        "type": "building", "subtype": "init", "name": name,
        "time": time, "x": 10.0, "y": 10.0,
    }


def _unit(name, time):
    return {"type": "unit", "name": name, "time": time}


def _events(*, viking_time=None, mines=True, thor=False):
    # No Reaper and only three Marines: these deliberately miss the
    # detailed TvP/TvZ/TvT signatures and exercise the generic tree.
    events = [
        _building("CommandCenter", 0), _building("CommandCenter", 100),
        _building("Barracks", 40), _building("Factory", 130),
        _building("Starport", 180), _unit("Medivac", 300),
        _unit("Marine", 140), _unit("Marine", 160), _unit("Marine", 210),
    ]
    if mines:
        events += [_unit("WidowMine", 260), _unit("WidowMine", 268)]
    if viking_time is not None:
        events += [_unit("VikingFighter", viking_time)]
    if thor:
        events += [_building("Armory", 350), _unit("Thor", 410)]
    return sorted(events, key=lambda event: event["time"])


def _classify(events, opponent="Protoss"):
    return classify_by_race(
        "Terran", events, BaseStrategyDetector([]), opp_race=opponent,
    )


@pytest.mark.parametrize("thor", [False, True])
def test_tvp_viking_first_support_mines_do_not_fall_back_to_mine_drop(thor):
    assert _classify(_events(viking_time=230, thor=thor)) == "Terran - 1-1-1 Standard"


def test_tvp_viking_without_mines_is_not_a_generic_mine_drop():
    assert _classify(_events(viking_time=230, mines=False)) == "Terran - 1-1-1 Standard"


@pytest.mark.parametrize("viking_time", [None, 340])
@pytest.mark.parametrize("thor,expected", [
    (False, "Terran - Widow Mine Drop"),
    (True, "Terran - Widow Mine Drop into Thor Rush"),
])
def test_tvp_medivac_first_preserves_genuine_generic_mine_drop(viking_time, thor, expected):
    assert _classify(_events(viking_time=viking_time, thor=thor)) == expected


@pytest.mark.parametrize("opponent", [None, "Terran", "Zerg"])
@pytest.mark.parametrize("thor,expected", [
    (False, "Terran - Widow Mine Drop"),
    (True, "Terran - Widow Mine Drop into Thor Rush"),
])
def test_other_matchups_preserve_existing_generic_mine_drop_behavior(opponent, thor, expected):
    assert _classify(_events(viking_time=230, thor=thor), opponent) == expected
