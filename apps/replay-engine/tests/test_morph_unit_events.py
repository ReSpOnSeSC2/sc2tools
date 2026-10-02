"""Units that morph in place reach the build log and the classifiers.

Banelings, Ravagers, Brood Lords, Overseers and Transport Overlords morph
from another unit, so the tracker reports them as a ``UnitTypeChangeEvent``
(cocoon, then the finished unit) and never as a ``UnitBornEvent``.
``extract_events`` read only structure morphs from that event, so none of
them was recorded: ``count_units("Baneling", t)`` read 0 on every replay
from 5.0.11 on, no Ling/Bane label could fire, and a custom rule on any of
them could not match on the desktop or the cloud.

Counted on real replays, builds 53644 (3.14) to 98274 (5.0.17 PTR):
Ravager, Brood Lord, Overseer and Transport Overlord are type changes on
every build. The Baneling was a NEW unit (``UnitBornEvent``) through 5.0.5
(build 82893) and is a type change from 5.0.11 (build 90136).

The streams below are real ladder games' event sequences for one unit of
each kind: names, event types and times as sc2reader reports them.
"""

from __future__ import annotations

import json
import os
import subprocess
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
    count_real_units,
)
from core.strategy_detector_race import classify_by_race  # noqa: E402

_FPS = 22.4
_ZERG_PID = 2
_REPLAYS = os.path.join(_HERE, "fixtures", "replays")


class _Placed:
    """Fields UnitInitEvent and UnitBornEvent share."""

    def __init__(self, sec, uid, type_name, x=150.0, y=60.0):
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


class _Change:
    """UnitTypeChangeEvent: raw type name, owner only through the Unit."""

    def __init__(self, sec, uid, type_name):
        self.frame = round(sec * _FPS)
        self.unit_id = uid
        self.unit_type_name = type_name
        self.unit = SimpleNamespace(
            id=uid, name=type_name, owner=SimpleNamespace(pid=_ZERG_PID),
            location=(150.0, 60.0),
        )


class _Never:
    """Stands in for the tracker event types these streams do not use."""


_MAIN, _NEST, _WARREN, _SPIRE = 1, 10, 11, 12
_OVERSEER, _TRANSPORT, _LING, _ROACH, _ROACH_CANCEL, _CORRUPTOR = (
    301, 302, 401, 501, 502, 601,
)


def _current_stream():
    """Type-change morphs, as every build from 5.0.11 reports them."""
    return [
        _Born(0, _MAIN, "Hatchery", 151.5, 109.5),
        _Init(62, 9, "SpawningPool"),
        _Init(150, _NEST, "BanelingNest"),
        _Init(200, _WARREN, "RoachWarren"),
        _Change(330, _MAIN, "Lair"),
        _Init(480, _SPIRE, "Spire"),
        _Change(1100, _SPIRE, "GreaterSpire"),
        # Overseer, then in and out of Oversight mode.
        _Born(46, _OVERSEER, "Overlord"),
        _Change(416, _OVERSEER, "OverlordCocoon"),
        _Change(428, _OVERSEER, "Overseer"),
        _Change(600, _OVERSEER, "OverseerSiegeMode"),
        _Change(640, _OVERSEER, "Overseer"),
        # Transport Overlord.
        _Born(270, _TRANSPORT, "Overlord"),
        _Change(703, _TRANSPORT, "TransportOverlordCocoon"),
        _Change(718, _TRANSPORT, "OverlordTransport"),
        # Baneling, then burrowed and unburrowed.
        _Born(365, _LING, "Zergling"),
        _Change(735, _LING, "BanelingCocoon"),
        _Change(749, _LING, "Baneling"),
        _Change(760, _LING, "BanelingBurrowed"),
        _Change(790, _LING, "Baneling"),
        # Ravager, then burrowed and unburrowed.
        _Born(411, _ROACH, "Roach"),
        _Change(466, _ROACH, "RavagerCocoon"),
        _Change(478, _ROACH, "Ravager"),
        _Change(500, _ROACH, "RavagerBurrowed"),
        _Change(510, _ROACH, "Ravager"),
        # A cancelled morph: the cocoon turns back into the Roach.
        _Born(444, _ROACH_CANCEL, "Roach"),
        _Change(470, _ROACH_CANCEL, "RavagerCocoon"),
        _Change(474, _ROACH_CANCEL, "Roach"),
        # Brood Lord.
        _Born(539, _CORRUPTOR, "Corruptor"),
        _Change(1262, _CORRUPTOR, "BroodLordCocoon"),
        _Change(1286, _CORRUPTOR, "BroodLord"),
    ]


def _extract(monkeypatch, events, my_pid=_ZERG_PID):
    monkeypatch.setattr(event_extractor, "UnitInitEvent", _Init)
    monkeypatch.setattr(event_extractor, "UnitBornEvent", _Born)
    monkeypatch.setattr(event_extractor, "UnitDoneEvent", _Never)
    monkeypatch.setattr(event_extractor, "UnitTypeChangeEvent", _Change)
    monkeypatch.setattr(event_extractor, "UpgradeCompleteEvent", _Never)
    events = sorted(events, key=lambda e: e.frame)
    replay = SimpleNamespace(
        tracker_events=events, events=[],
        frames=round(1400 * _FPS), length=SimpleNamespace(seconds=1400),
    )
    mine, theirs, stats = event_extractor.extract_events(replay, my_pid=my_pid)
    assert stats["errors"] == 0
    return mine, theirs


@pytest.fixture
def zerg_events(monkeypatch):
    mine, theirs = _extract(monkeypatch, _current_stream())
    assert theirs == []
    return mine


_MORPHED = ("Baneling", "Ravager", "BroodLord", "Overseer", "OverlordTransport")


def test_each_morph_is_one_unit_event_at_its_finish_time(zerg_events):
    morphed = [e for e in zerg_events if e["name"] in _MORPHED]
    assert [(e["type"], e["name"], e["time"]) for e in morphed] == [
        ("unit", "Overseer", 428),
        ("unit", "Ravager", 478),
        ("unit", "OverlordTransport", 718),
        ("unit", "Baneling", 749),
        ("unit", "BroodLord", 1286),
    ]
    # The event has no position of its own.
    assert all((e["x"], e["y"]) == (0, 0) for e in morphed)


def test_cocoons_stances_and_cancelled_morphs_are_not_recorded(zerg_events):
    names = {e["name"] for e in zerg_events}
    assert not names & {
        "BanelingCocoon", "RavagerCocoon", "BroodLordCocoon",
        "OverlordCocoon", "TransportOverlordCocoon", "BanelingBurrowed",
        "RavagerBurrowed", "OverseerSiegeMode",
    }
    # The units they morphed from stay, once each.
    assert len([e for e in zerg_events if e["name"] == "Roach"]) == 2
    assert len([e for e in zerg_events if e["name"] == "Overlord"]) == 2


def test_build_log_carries_the_morphed_units(zerg_events):
    lines = event_extractor.build_log_lines(zerg_events)
    assert [l for l in lines if l.split("] ")[1] in _MORPHED] == [
        "[7:08] Overseer", "[7:58] Ravager", "[11:58] OverlordTransport",
        "[12:29] Baneling", "[21:26] BroodLord",
    ]


def test_opponent_morphs_land_on_the_opponent_side(monkeypatch):
    mine, theirs = _extract(monkeypatch, _current_stream(), my_pid=1)
    assert mine == []
    assert sorted(e["name"] for e in theirs if e["name"] in _MORPHED) == sorted(
        _MORPHED,
    )


def test_born_baneling_is_not_emitted_again_when_it_unburrows(monkeypatch):
    """Builds up to 5.0.5: the cocoon is replaced by a new, born Baneling.

    Its later unburrow is a type change to "Baneling" for the same unit.
    """
    ling, bane = 700, 701
    mine, _theirs = _extract(monkeypatch, [
        _Born(0, _MAIN, "Hatchery", 151.5, 109.5),
        _Init(150, _NEST, "BanelingNest"),
        _Born(300, ling, "Zergling"),
        _Change(702, ling, "BanelingCocoon"),
        _Born(716, bane, "Baneling", 98.0, 117.0),
        _Change(727, bane, "BanelingBurrowed"),
        _Change(752, bane, "Baneling"),
        _Change(759, bane, "BanelingBurrowed"),
    ])
    assert [e for e in mine if e["name"] == "Baneling"] == [
        {"type": "unit", "name": "Baneling", "time": 716, "x": 98.0, "y": 117.0},
    ]


def test_one_overlord_can_be_a_transport_and_then_an_overseer(monkeypatch):
    """The de-duplication is per unit AND type, not per unit alone."""
    mine, _theirs = _extract(monkeypatch, [
        _Born(0, _MAIN, "Hatchery", 151.5, 109.5),
        _Change(330, _MAIN, "Lair"),
        _Born(270, _TRANSPORT, "Overlord"),
        _Change(703, _TRANSPORT, "TransportOverlordCocoon"),
        _Change(718, _TRANSPORT, "OverlordTransport"),
        _Change(900, _TRANSPORT, "OverlordCocoon"),
        _Change(912, _TRANSPORT, "Overseer"),
        _Change(950, _TRANSPORT, "OverseerSiegeMode"),
        _Change(990, _TRANSPORT, "Overseer"),
    ])
    assert [(e["name"], e["time"]) for e in mine if e["type"] == "unit"] == [
        ("Overlord", 270), ("OverlordTransport", 718), ("Overseer", 912),
    ]


def test_morph_durations_are_the_measured_cocoon_times():
    """Cocoon-to-finish seconds on real replays, current balance."""
    measured = {
        "Baneling": 14, "Ravager": 12, "BroodLord": 24, "Overseer": 12,
        "OverlordTransport": 15, "LurkerMP": 18,
    }
    assert set(measured) == event_extractor.UNIT_MORPH_COMPLETIONS
    for name, seconds in measured.items():
        assert to_start_seconds(name, 1000) == 1000 - seconds, name
        assert name in UNIT_TECH_PREREQUISITES, name


@pytest.mark.parametrize(
    "rule, expected",
    [
        # Baneling finishes at 12:29 and started 14 s earlier, 12:15.
        ({"type": "before", "name": "MorphBaneling", "time_lt": 736}, True),
        ({"type": "before", "name": "MorphBaneling", "time_lt": 735}, False),
        ({"type": "not_before", "name": "MorphBaneling", "time_lt": 800}, False),
        # Ravager: 7:58 less 12 s. The unburrow and the cancelled cocoon
        # add nothing.
        ({"type": "before", "name": "MorphRavager", "time_lt": 467}, True),
        ({"type": "before", "name": "MorphRavager", "time_lt": 466}, False),
        ({"type": "count_exact", "name": "MorphRavager", "time_lt": 1300,
          "count": 1}, True),
        # Brood Lord: 21:26 less 24 s.
        ({"type": "before", "name": "MorphBroodLord", "time_lt": 1263}, True),
        ({"type": "before", "name": "MorphBroodLord", "time_lt": 1262}, False),
        # Overseer: 7:08 less 12 s. Leaving Oversight mode is not a second one.
        ({"type": "before", "name": "MorphOverseer", "time_lt": 417}, True),
        ({"type": "before", "name": "MorphOverseer", "time_lt": 416}, False),
        ({"type": "count_max", "name": "MorphOverseer", "time_lt": 1300,
          "count": 1}, True),
        # Transport Overlord: 11:58 less 15 s. The cloud's token for it.
        ({"type": "before", "name": "BuildOverlordTransport", "time_lt": 704},
         True),
        ({"type": "before", "name": "BuildOverlordTransport", "time_lt": 703},
         False),
        # Legacy v1 rules: recorded times, inclusive cutoff.
        ({"type": "unit", "name": "Ravager", "count": 1, "time_lt": 478}, True),
        ({"type": "unit", "name": "Ravager", "count": 1, "time_lt": 477}, False),
        ({"type": "unit_max", "name": "Baneling", "count": 0, "time_lt": 748},
         True),
        ({"type": "unit_max", "name": "Baneling", "count": 0, "time_lt": 749},
         False),
    ],
)
def test_custom_rules_about_morphed_units_match(zerg_events, rule, expected):
    detector = BaseStrategyDetector([])
    buildings = [e for e in zerg_events if e["type"] == "building"]
    units = [e for e in zerg_events if e["type"] in ("unit", "worker")]
    verdict = detector.check_custom_rules(
        [rule], buildings, units, [],
        detector._get_main_base_loc(buildings),
    )
    assert verdict is expected


# ---------------------------------------------------------------------------
# Real replays
# ---------------------------------------------------------------------------
_REAL_SCRIPT = """
import json, sys
sys.path.insert(0, sys.argv[1])
import sc2reader
from core.event_extractor import _get_owner_pid, extract_events
replay = sc2reader.load_replay(sys.argv[2], load_level=4, load_map=False)
zerg = next(p for p in replay.players if p.play_race == "Zerg")
other = next(p for p in replay.players if p.pid != zerg.pid)
mine, _theirs, stats = extract_events(replay, zerg.pid)
# Unit ids that were ever each type, straight from the tracker.
distinct = {}
for ev in replay.tracker_events:
    if type(ev).__name__ not in ("UnitBornEvent", "UnitTypeChangeEvent"):
        continue
    if _get_owner_pid(ev) == zerg.pid:
        distinct.setdefault(ev.unit_type_name, set()).add(ev.unit.id)
json.dump({
    "events": mine, "errors": stats["errors"], "vs": other.play_race,
    "distinct": {name: len(ids) for name, ids in distinct.items()},
}, sys.stdout)
"""


def _real(name):
    """The Zerg player's events from a fixture replay.

    A clean process, like the other real-replay tests: modules collected
    earlier may have shimmed sc2reader, which breaks the extractor's
    isinstance gates in-process.
    """
    path = os.path.join(_REPLAYS, name)
    result = subprocess.run(
        [sys.executable, "-c", _REAL_SCRIPT, _ROOT, path],
        check=True, capture_output=True, text=True, timeout=120,
    )
    out = json.loads(result.stdout)
    assert out["errors"] == 0
    return out


@pytest.mark.parametrize(
    "fixture, banelings, overseers",
    [
        # Build 80949: every Baneling is a UnitBornEvent.
        ("ladder_tvz_ever_dream_18min.SC2Replay", 93, 6),
        # Builds 96314 and 96883: every Baneling is a type change.
        ("ladder_zvt_winter_madness.SC2Replay", 12, 0),
        ("warpgate_adept_tracking.SC2Replay", 12, 0),
    ],
)
def test_real_replays_record_each_morphed_unit_once(
    fixture, banelings, overseers,
):
    real = _real(fixture)
    for name, expected in (("Baneling", banelings), ("Overseer", overseers)):
        recorded = [e for e in real["events"] if e["name"] == name]
        assert len(recorded) == expected, name
        assert real["distinct"].get(name, 0) == expected, name
        assert all(e["type"] == "unit" for e in recorded)


def test_real_ling_bane_bust_is_labelled_as_one():
    """5.0.15 ZvT: 8 Banelings and 64 Zerglings by 5:30 off two bases.

    With the Banelings unrecorded the game fell through the ZvT tree to
    the generic "Zerg - 13/12 Baneling Bust".
    """
    real = _real("ladder_zvt_winter_madness.SC2Replay")
    mine = real["events"]
    buildings = [e for e in mine if e["type"] == "building"]
    units = [e for e in mine if e["type"] in ("unit", "worker")]
    assert real["vs"] == "Terran"
    assert count_real_units("Baneling", 330, units, buildings) == 8
    assert classify_by_race(
        "Zerg", mine, BaseStrategyDetector([]), opp_race="Terran",
    ) == "ZvT - Ling Bane Bust"


def test_ravagers_are_not_added_to_the_roach_count():
    """Every Ravager was born a Roach: 5 Roaches, 3 of them morphed, is 5."""
    events = [
        {"type": "building", "subtype": "born", "name": "Hatchery",
         "time": 0, "x": 60, "y": 48},
        {"type": "building", "subtype": "init", "name": "Hatchery",
         "time": 60, "x": 45, "y": 64},
        {"type": "building", "subtype": "init", "name": "SpawningPool",
         "time": 80, "x": 66, "y": 45},
        {"type": "building", "subtype": "init", "name": "RoachWarren",
         "time": 150, "x": 62, "y": 44},
    ]
    events += [
        {"type": "unit", "name": "Roach", "time": 240 + i, "x": 60, "y": 45}
        for i in range(5)
    ]
    events += [
        {"type": "unit", "name": "Ravager", "time": 270 + i, "x": 0, "y": 0}
        for i in range(3)
    ]
    detector = BaseStrategyDetector([])
    for opp_race in ("Terran", "Protoss"):
        label = classify_by_race("Zerg", events, detector, opp_race=opp_race)
        assert "Roach" not in label, label
    # Eight real Roaches (three of them later Ravagers) is the timing.
    events += [
        {"type": "unit", "name": "Roach", "time": 250 + i, "x": 60, "y": 45}
        for i in range(3)
    ]
    assert classify_by_race(
        "Zerg", events, detector, opp_race="Terran",
    ) == "ZvT - 2 Base Roach Ravager Timing"
    assert classify_by_race(
        "Zerg", events, detector, opp_race="Protoss",
    ) == "ZvP - 2 Base Roach Ravager All-in"
