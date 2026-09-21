"""Composition samples preserve each unit's identity at that point in time."""

from __future__ import annotations

import importlib
import os
import sys
from types import SimpleNamespace

import pytest

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)


@pytest.fixture
def extractor(monkeypatch):
    ee = importlib.import_module("core.event_extractor")
    for name in (
        "PlayerStatsEvent", "UnitBornEvent", "UnitInitEvent", "UnitDoneEvent",
        "UnitTypeChangeEvent", "UnitDiedEvent",
    ):
        monkeypatch.setattr(ee, name, type(name, (), {}))
    return ee


def _event(kind, second, *, uid=None, pid=1, name=None, **attrs):
    event = kind()
    event.frame = second * 16
    event.pid = pid
    if uid is not None:
        event.unit_id = uid
    if name is not None:
        event.unit_type_name = name
    for key, value in attrs.items():
        setattr(event, key, value)
    return event


def _extract(ee, events, times, *, my_pid=1):
    stats = [_event(ee.PlayerStatsEvent, t, pid=my_pid) for t in times]
    replay = SimpleNamespace(
        tracker_events=sorted(events + stats, key=lambda event: event.frame),
        events=[], players=[], frames=960, length=SimpleNamespace(seconds=60),
        game_length=SimpleNamespace(seconds=60),
    )
    return ee.extract_macro_events(replay, my_pid, 3 - my_pid)


@pytest.mark.parametrize("my_pid", [1, 2])
def test_morphs_preserve_history_and_exclude_cocoon_intervals(extractor, my_pid):
    ee = extractor
    events = [
        _event(ee.UnitBornEvent, 10, uid=1, name="Roach"),
        # A duplicate completion must not create a second unit.
        _event(ee.UnitDoneEvent, 11, uid=1, name="Roach"),
        _event(ee.UnitTypeChangeEvent, 20, uid=1, name="RavagerCocoon"),
        _event(ee.UnitTypeChangeEvent, 30, uid=1, name="Ravager"),
        _event(ee.UnitDiedEvent, 50, uid=1),
        _event(ee.UnitBornEvent, 15, uid=2, pid=2, name="Zergling"),
        _event(ee.UnitTypeChangeEvent, 25, uid=2, pid=2, name="BanelingCocoon"),
        _event(ee.UnitTypeChangeEvent, 35, uid=2, pid=2, name="Baneling"),
    ]
    result = _extract(ee, events, [0, 10, 15, 20, 25, 30, 35, 50, 60], my_pid=my_pid)
    first_side = "my" if my_pid == 1 else "opp"
    second_side = "opp" if my_pid == 1 else "my"
    assert [row[first_side] for row in result["unit_timeline"]] == [
        {}, {"Roach": 1}, {"Roach": 1}, {}, {}, {"Ravager": 1},
        {"Ravager": 1}, {}, {},
    ]
    assert [row[second_side] for row in result["unit_timeline"]] == [
        {}, {}, {"Zergling": 1}, {"Zergling": 1}, {}, {},
        {"Baneling": 1}, {"Baneling": 1}, {"Baneling": 1},
    ]


def test_morph_only_unit_enters_at_completion_and_keeps_later_history(extractor):
    ee = extractor
    result = _extract(ee, [
        _event(ee.UnitBornEvent, 5, uid=1, name="Egg"),
        _event(ee.UnitTypeChangeEvent, 10, uid=1, name="Roach"),
        _event(ee.UnitDoneEvent, 10, uid=1, name="Roach"),
        _event(ee.UnitTypeChangeEvent, 20, uid=1, name="RavagerCocoon"),
        _event(ee.UnitTypeChangeEvent, 30, uid=1, name="Ravager"),
    ], [5, 10, 20, 30])
    assert [row["my"] for row in result["unit_timeline"]] == [
        {}, {"Roach": 1}, {}, {"Ravager": 1},
    ]


def test_mode_switches_preserve_one_unit_and_prior_samples(extractor):
    ee = extractor
    result = _extract(ee, [
        _event(ee.UnitBornEvent, 10, uid=1, name="WidowMine"),
        _event(ee.UnitTypeChangeEvent, 20, uid=1, name="WidowMineBurrowed"),
        _event(ee.UnitTypeChangeEvent, 30, uid=1, name="WidowMine"),
        _event(ee.UnitBornEvent, 10, uid=2, pid=2, name="SiegeTank"),
        _event(ee.UnitTypeChangeEvent, 20, uid=2, pid=2, name="SiegeTankSieged"),
        _event(ee.UnitTypeChangeEvent, 30, uid=2, pid=2, name="SiegeTank"),
    ], [10, 20, 30])
    assert [row["my"] for row in result["unit_timeline"]] == [{"WidowMine": 1}] * 3
    assert [row["opp"] for row in result["unit_timeline"]] == [
        {"SiegeTank": 1}, {"SiegeTankSieged": 1}, {"SiegeTank": 1},
    ]


def test_warp_in_completion_uses_historical_type_not_final_shared_name(extractor):
    ee = extractor
    unit = SimpleNamespace(
        name="Archon", owner=SimpleNamespace(pid=1),
        type_history={0: SimpleNamespace(name="HighTemplar"),
                      30 * 16: SimpleNamespace(name="Archon")},
    )
    result = _extract(ee, [
        _event(ee.UnitInitEvent, 5, uid=1, name="HighTemplar", unit=unit),
        _event(ee.UnitDoneEvent, 10, uid=1, unit=unit),
        _event(ee.UnitTypeChangeEvent, 30, uid=1, name="Archon", unit=unit),
    ], [5, 10, 20, 30])
    assert [row["my"] for row in result["unit_timeline"]] == [
        {}, {"HighTemplar": 1}, {"HighTemplar": 1}, {"Archon": 1},
    ]
    assert result["unit_births"] == [{"name": "HighTemplar", "time": 10, "unit_id": 1}]


def test_hallucinations_temporary_units_and_morph_shells_are_not_composition(extractor):
    ee = extractor
    events = [
        _event(ee.UnitBornEvent, 5, uid=1, name="Phoenix", hallucinated=True),
        # Once positively identified, a later unflagged event cannot admit it.
        _event(ee.UnitTypeChangeEvent, 10, uid=1, name="Phoenix"),
        _event(ee.UnitDoneEvent, 5, uid=2, pid=2, name="Colossus",
               unit=SimpleNamespace(hallucinated=True)),
        _event(ee.UnitBornEvent, 5, uid=3, name="Phoenix"),
    ]
    for uid, name in enumerate([
        "BroodLordCocoon", "LurkerMPEgg", "LocustMPFlying",
        "ChangelingZerglingWings", "Broodling", "DisruptorPhased", "BeaconArmy",
        "SporeCrawlerUprooted", "BarracksFlying",
    ], 10):
        events.append(_event(ee.UnitBornEvent, 5, uid=uid, name=name))
    result = _extract(ee, events, [5, 10])
    assert [row["my"] for row in result["unit_timeline"]] == [{"Phoenix": 1}] * 2
    assert [row["opp"] for row in result["unit_timeline"]] == [{}, {}]
    assert result["player_stats"]["1"]["units_produced"] == 1
    assert result["player_stats"]["2"]["units_produced"] == 0
