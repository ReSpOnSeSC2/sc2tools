"""The Lurker Den and Lurkers reach the build log and the rule evaluators.

sc2reader types the den's ``UnitInitEvent`` as ``LurkerDenMP`` and its
``UnitDoneEvent`` carries no type name, resolving to ``LurkerDen`` through
``unit.name``. ``extract_events`` dropped the first as an unknown name and
skipped the second as a known building, so no replay ever recorded a
Lurker Den. Lurkers were missing too: a Hydralisk morphs in place
(``UnitTypeChangeEvent`` to ``LurkerMPEgg``, then ``LurkerMP``) and only
structure morphs were read from that event. A custom rule such as "Lurker
before 10:00" therefore never matched, "no Lurker before 10:00" always
did, and the built-in "Lurker Contain" labels could not fire.

The tracker stream below is the Zerg player's from a real 5.0.16 ladder
game (build 97563): names, event types and times as sc2reader reports
them.
"""

from __future__ import annotations

import os
import sys
from types import SimpleNamespace

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from core import event_extractor  # noqa: E402
from core.build_durations import to_start_seconds  # noqa: E402
from core.strategy_detector_base import BaseStrategyDetector  # noqa: E402
from core.strategy_detector_helpers import (  # noqa: E402
    UNIT_TECH_PREREQUISITES,
)

_FPS = 22.4
_ZERG_PID = 2


class _Placed:
    """Fields UnitInitEvent and UnitBornEvent share."""

    def __init__(self, sec, uid, type_name, x, y):
        self.frame = round(sec * _FPS)
        self.unit_id = uid
        self.unit_type_name = type_name
        self.control_pid = _ZERG_PID
        self.x = x
        self.y = y


class _Init(_Placed):
    """UnitInitEvent: carries the raw type name, the owner and a position."""


class _Born(_Placed):
    """UnitBornEvent: same fields as an init."""


class _Done:
    """UnitDoneEvent: no type name; only the shared Unit names it."""

    def __init__(self, sec, uid, unit_name):
        self.frame = round(sec * _FPS)
        self.unit_id = uid
        self.unit = _unit(uid, unit_name)


class _Change:
    """UnitTypeChangeEvent: raw type name, owner only through the Unit."""

    def __init__(self, sec, uid, type_name, unit_name="Lurker"):
        self.frame = round(sec * _FPS)
        self.unit_id = uid
        self.unit_type_name = type_name
        self.unit = _unit(uid, unit_name)


class _Never:
    """Stands in for the tracker event types this stream does not use."""


def _unit(uid, name):
    return SimpleNamespace(
        id=uid, name=name, owner=SimpleNamespace(pid=_ZERG_PID),
        location=(150.0, 60.0),
    )


_DEN, _LURKER_A, _LURKER_B, _HYDRA = 101, 201, 202, 203


def _replay():
    events = [
        _Born(0, 1, "Hatchery", 185.5, 68.5),
        _Init(357, 90, "HydraliskDen", 186.0, 76.0),
        _Init(430, _DEN, "LurkerDenMP", 189.0, 71.0),
        _Done(487, _DEN, "LurkerDen"),
        _Born(520, _LURKER_A, "Hydralisk", 180.0, 70.0),
        _Born(520, _LURKER_B, "Hydralisk", 180.0, 70.0),
        _Born(520, _HYDRA, "Hydralisk", 180.0, 70.0),
        _Change(551, _LURKER_A, "LurkerMPEgg"),
        _Change(552, _LURKER_B, "LurkerMPEgg", "LurkerBurrowed"),
        _Change(569, _LURKER_A, "LurkerMP"),
        _Change(570, _LURKER_B, "LurkerMP", "LurkerBurrowed"),
        # Burrowing and unburrowing fire the same event for the same unit.
        _Change(580, _LURKER_A, "LurkerMPBurrowed"),
        _Change(596, _LURKER_A, "LurkerMP"),
        _Change(596, _LURKER_B, "LurkerMPBurrowed", "LurkerBurrowed"),
        _Change(738, _LURKER_B, "LurkerMP", "LurkerBurrowed"),
        # A cancelled morph: the egg turns back into the Hydralisk.
        _Change(600, _HYDRA, "LurkerMPEgg", "Hydralisk"),
        _Change(604, _HYDRA, "Hydralisk", "Hydralisk"),
    ]
    events.sort(key=lambda e: e.frame)
    return SimpleNamespace(
        tracker_events=events, events=[],
        frames=round(1000 * _FPS), length=SimpleNamespace(seconds=1000),
    )


@pytest.fixture
def zerg_events(monkeypatch):
    monkeypatch.setattr(event_extractor, "UnitInitEvent", _Init)
    monkeypatch.setattr(event_extractor, "UnitBornEvent", _Born)
    monkeypatch.setattr(event_extractor, "UnitDoneEvent", _Done)
    monkeypatch.setattr(event_extractor, "UnitTypeChangeEvent", _Change)
    monkeypatch.setattr(event_extractor, "UpgradeCompleteEvent", _Never)
    mine, theirs, stats = event_extractor.extract_events(
        _replay(), my_pid=_ZERG_PID,
    )
    assert theirs == []
    assert stats["errors"] == 0
    return mine


def _named(events, fragment):
    return [e for e in events if fragment in e["name"]]


def test_lurker_den_is_a_building_at_its_start_time(zerg_events):
    assert _named(zerg_events, "LurkerDen") == [{
        "type": "building", "subtype": "init", "name": "LurkerDen",
        "time": 430, "x": 189.0, "y": 71.0,
    }]


def test_each_lurker_is_one_unit_event_at_its_finish_time(zerg_events):
    lurkers = [e for e in zerg_events if e["name"] == "LurkerMP"]
    assert [(e["type"], e["time"]) for e in lurkers] == [
        ("unit", 569), ("unit", 570),
    ]
    # The event has no position of its own.
    assert all((e["x"], e["y"]) == (0, 0) for e in lurkers)


def test_only_the_den_and_finished_lurkers_are_recorded(zerg_events):
    # No LurkerDenMP, no eggs, no burrowed form.
    assert {e["name"] for e in _named(zerg_events, "Lurker")} == {
        "LurkerDen", "LurkerMP",
    }
    assert len([e for e in zerg_events if e["name"] == "Hydralisk"]) == 3


def test_opponent_lurker_events_land_on_the_opponent_side(monkeypatch):
    monkeypatch.setattr(event_extractor, "UnitInitEvent", _Init)
    monkeypatch.setattr(event_extractor, "UnitBornEvent", _Born)
    monkeypatch.setattr(event_extractor, "UnitDoneEvent", _Done)
    monkeypatch.setattr(event_extractor, "UnitTypeChangeEvent", _Change)
    monkeypatch.setattr(event_extractor, "UpgradeCompleteEvent", _Never)
    mine, theirs, _stats = event_extractor.extract_events(_replay(), my_pid=1)
    assert mine == []
    assert [e["name"] for e in _named(theirs, "Lurker")] == [
        "LurkerDen", "LurkerMP", "LurkerMP",
    ]


def test_build_log_carries_the_den_and_the_lurkers(zerg_events):
    lines = event_extractor.build_log_lines(zerg_events)
    assert [line for line in lines if "Lurker" in line] == [
        "[7:10] LurkerDen", "[9:29] LurkerMP", "[9:30] LurkerMP",
    ]


def test_recorded_names_are_the_ones_the_rule_tables_use():
    """The tables are keyed by the names ``extract_events`` records."""
    for raw, recorded in event_extractor.EVENT_NAME_ALIASES.items():
        assert raw not in event_extractor.KNOWN_BUILDINGS
        assert recorded in event_extractor.KNOWN_BUILDINGS
    for recorded in event_extractor.UNIT_MORPH_COMPLETIONS:
        assert recorded in UNIT_TECH_PREREQUISITES
        for alternative in UNIT_TECH_PREREQUISITES[recorded]:
            assert set(alternative) <= event_extractor.KNOWN_BUILDINGS
        # A finish time the start-time rewind knows how to rewind.
        assert to_start_seconds(recorded, 100) < 100


@pytest.mark.parametrize(
    "rule, expected",
    [
        # The first Lurker finishes at 9:29 and started 18 s earlier, 9:11.
        ({"type": "before", "name": "BuildLurkerMP", "time_lt": 552}, True),
        ({"type": "before", "name": "BuildLurkerMP", "time_lt": 551}, False),
        ({"type": "not_before", "name": "BuildLurkerMP", "time_lt": 600}, False),
        ({"type": "not_before", "name": "BuildLurkerMP", "time_lt": 551}, True),
        ({"type": "count_exact", "name": "BuildLurkerMP", "time_lt": 900,
          "count": 2}, True),
        # The den is recorded when it starts (7:10), not when it finishes.
        ({"type": "before", "name": "BuildLurkerDen", "time_lt": 431}, True),
        ({"type": "before", "name": "BuildLurkerDen", "time_lt": 430}, False),
        # Legacy v1 rules: recorded times, inclusive cutoff.
        ({"type": "building", "name": "LurkerDen", "time_lt": 430}, True),
        ({"type": "unit", "name": "LurkerMP", "count": 2, "time_lt": 570}, True),
        ({"type": "unit", "name": "LurkerMP", "count": 2, "time_lt": 569}, False),
    ],
)
def test_custom_rules_about_lurkers_match(zerg_events, rule, expected):
    detector = BaseStrategyDetector([])
    buildings = [e for e in zerg_events if e["type"] == "building"]
    units = [e for e in zerg_events if e["type"] in ("unit", "worker")]
    verdict = detector.check_custom_rules(
        [rule], buildings, units, [],
        detector._get_main_base_loc(buildings),
    )
    assert verdict is expected
