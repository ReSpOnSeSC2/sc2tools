"""Locks the unit-track extraction the map replayer plays back.

``UnitPositionsEvent`` is the only mid-game TRUE-position source a
replay offers (every 15 s, for units that dealt/took damage), and its
rows carry the tracker unit INDEX — not the full unit_id. Pre-fix the
extractor resolved rows against unit_id-keyed records (dropping every
snapshot on the floor) and divided the coordinates by 4 (a misreading
of sc2reader's pre-2014 "4 point resolution" note — those are rounded,
not scaled, and sc2reader rescales them on load). The visible symptom
was armies drifting between spawn and command clicks with nothing
pinning them to where the fights actually happened.

Three behaviours locked here:

  1. Position snapshots resolve through the unit_id_index -> unit map
     (mirroring sc2reader's ``replay.active_units``) at full scale.
  2. A recycled index (unit dies, index reassigned to a new unit) must
     not leak the old unit's identity — the new occupant owns it.
  3. ``UnitDiedEvent``'s exact death coordinates land as the final
     waypoint so a unit dies where the game says it died.

Runs without sc2reader by stubbing the tracker classes, matching
test_building_death_tracking.py.

Module: tests
"""
from __future__ import annotations

import os
import sys
from types import SimpleNamespace
from typing import Any, List
from unittest.mock import MagicMock

sys.modules.setdefault("sc2reader", MagicMock())
sys.modules.setdefault("sc2reader.events", MagicMock())
sys.modules.setdefault("sc2reader.events.tracker", MagicMock())
sys.modules.setdefault("sc2reader.events.game", MagicMock())

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

GAME_END = 600


def _import_extractor():
    """Import event_extractor with sc2reader's tracker classes stubbed."""
    import importlib

    class _PlayerStatsEvent:
        pass

    class _UnitBornEvent:
        pass

    class _UnitInitEvent:
        pass

    class _UnitDoneEvent:
        pass

    class _UnitTypeChangeEvent:
        pass

    class _UnitDiedEvent:
        pass

    class _UnitPositionsEvent:
        pass

    class _UpgradeCompleteEvent:
        pass

    class _CommandEvent:
        pass

    tracker_mod = SimpleNamespace(
        PlayerStatsEvent=_PlayerStatsEvent,
        UnitBornEvent=_UnitBornEvent,
        UnitInitEvent=_UnitInitEvent,
        UnitDoneEvent=_UnitDoneEvent,
        UnitTypeChangeEvent=_UnitTypeChangeEvent,
        UnitDiedEvent=_UnitDiedEvent,
        UnitPositionsEvent=_UnitPositionsEvent,
        UpgradeCompleteEvent=_UpgradeCompleteEvent,
    )
    game_mod = SimpleNamespace(
        CommandEvent=_CommandEvent,
        TargetPointCommandEvent=None,
        SelectionEvent=None,
    )
    sys.modules["sc2reader"] = MagicMock()
    sys.modules["sc2reader.events"] = MagicMock()
    sys.modules["sc2reader.events.tracker"] = tracker_mod
    sys.modules["sc2reader.events.game"] = game_mod

    sys.modules.pop("core.event_extractor", None)
    return importlib.import_module("core.event_extractor"), SimpleNamespace(
        UnitBornEvent=_UnitBornEvent,
        UnitDiedEvent=_UnitDiedEvent,
        UnitPositionsEvent=_UnitPositionsEvent,
    )


def _born(klass: type, second: int, *, pid: int, name: str, uid: int,
          index: int, x: float = 0, y: float = 0) -> Any:
    ev = klass()
    ev.second = second
    ev.frame = second * 16
    ev.control_pid = pid
    ev.unit_type_name = name
    ev.unit_id = uid
    ev.unit_id_index = index
    ev.unit = None
    ev.x = x
    ev.y = y
    return ev


def _died(klass: type, second: int, *, uid: int, index: int,
          x: float = 0, y: float = 0) -> Any:
    ev = klass()
    ev.second = second
    ev.frame = second * 16
    ev.unit_id = uid
    ev.unit_id_index = index
    ev.unit = None
    ev.x = x
    ev.y = y
    return ev


def _positions(klass: type, second: int, rows: List) -> Any:
    ev = klass()
    ev.second = second
    ev.frame = second * 16
    ev.positions = rows
    return ev


def _make_replay(events: List[Any]) -> SimpleNamespace:
    """sc2reader-shaped Replay stub at a genuine 16 fps timebase."""
    return SimpleNamespace(
        tracker_events=events,
        events=[],
        build=92440,
        frames=GAME_END * 16,
        length=SimpleNamespace(seconds=GAME_END),
        game_length=SimpleNamespace(seconds=GAME_END),
        players=[],
    )


def test_position_snapshots_resolve_by_unit_index_at_full_scale():
    ee, k = _import_extractor()
    # unit_id is (index << 18) | recycle — nothing like the raw index.
    uid = (7 << 18) | 1
    events = [
        _born(k.UnitBornEvent, 10, pid=1, name="Stalker", uid=uid,
              index=7, x=30, y=40),
        _positions(k.UnitPositionsEvent, 25, [(7, (88, 96))]),
        _positions(k.UnitPositionsEvent, 40, [(7, (120, 132))]),
    ]
    out = ee.extract_unit_tracks(_make_replay(events), my_pid=1)
    (stalker,) = out["my_units"]
    # Flat [t, x, y, ...] — born anchor plus BOTH snapshots, unscaled.
    assert stalker["waypoints"] == [
        10.0, 30.0, 40.0,
        25.0, 88.0, 96.0,
        40.0, 120.0, 132.0,
    ]


def test_recycled_index_attributes_positions_to_new_occupant():
    ee, k = _import_extractor()
    first = (9 << 18) | 1
    second = (9 << 18) | 2
    events = [
        _born(k.UnitBornEvent, 5, pid=1, name="Marine", uid=first,
              index=9, x=10, y=10),
        _died(k.UnitDiedEvent, 20, uid=first, index=9, x=15, y=15),
        _born(k.UnitBornEvent, 30, pid=2, name="Roach", uid=second,
              index=9, x=150, y=150),
        _positions(k.UnitPositionsEvent, 45, [(9, (140, 140))]),
    ]
    out = ee.extract_unit_tracks(_make_replay(events), my_pid=1)
    (marine,) = out["my_units"]
    (roach,) = out["opp_units"]
    # The dead marine keeps its own track (born + death anchor) and
    # must NOT absorb the roach's later snapshot on the recycled index.
    assert marine["waypoints"] == [5.0, 10.0, 10.0, 20.0, 15.0, 15.0]
    assert roach["waypoints"] == [30.0, 150.0, 150.0, 45.0, 140.0, 140.0]


def test_death_position_is_final_waypoint():
    ee, k = _import_extractor()
    uid = (3 << 18) | 4
    events = [
        _born(k.UnitBornEvent, 12, pid=1, name="Zealot", uid=uid,
              index=3, x=50, y=60),
        _died(k.UnitDiedEvent, 90, uid=uid, index=3, x=101, y=77),
    ]
    out = ee.extract_unit_tracks(_make_replay(events), my_pid=1)
    (zealot,) = out["my_units"]
    assert zealot["died"] == 90.0
    assert zealot["waypoints"][-3:] == [90.0, 101.0, 77.0]


def test_resource_nodes_extracted_with_kinds_and_death_times():
    ee, k = _import_extractor()

    def _neutral(name, uid, index, x, y, second=0):
        ev = k.UnitBornEvent()
        ev.second = second
        ev.frame = second * 16
        ev.control_pid = 0
        ev.upkeep_pid = 0
        ev.unit_type_name = name
        ev.unit_id = uid
        ev.unit_id_index = index
        ev.unit = None
        ev.x = x
        ev.y = y
        return ev

    events = [
        _neutral("MineralField750", 1001, 50, 30.5, 40.5),
        _neutral("RichMineralField", 1002, 51, 100, 100),
        _neutral("PurifierVespeneGeyser", 1003, 52, 26, 44),
        _neutral("DestructibleRockEx16x6", 1004, 53, 80, 80),
        _neutral("XelNagaTower", 1005, 54, 88, 88),
        _neutral("UnbuildableBricksDestructible", 1006, 55, 0, 0),  # zero pos: dropped
        # Player-owned lookalike must not classify as neutral.
        _born(k.UnitBornEvent, 5, pid=1, name="Probe", uid=(60 << 18) | 1, index=60, x=31, y=41),
        # Patch mines out at 400 s; rocks broken at 250 s.
        _died(k.UnitDiedEvent, 400, uid=1001, index=50, x=30.5, y=40.5),
        _died(k.UnitDiedEvent, 250, uid=1004, index=53, x=80, y=80),
    ]
    nodes = ee.extract_resource_nodes(_make_replay(events))
    by_kind = {}
    for n in nodes:
        by_kind.setdefault(n["kind"], []).append(n)

    assert [n["died"] for n in by_kind["minerals"]] == [400.0]
    assert by_kind["minerals"][0]["x"] == 30.5
    assert by_kind["gold"][0]["died"] is None
    assert by_kind["gas"][0] == {"kind": "gas", "x": 26.0, "y": 44.0, "died": None}
    assert by_kind["rocks"][0]["died"] == 250.0
    assert by_kind["tower"][0]["died"] is None
    # 5 classified neutral nodes; the zero-position node and the probe
    # never enter.
    assert len(nodes) == 5


def test_classify_resource_name_covers_tileset_variants():
    ee, _k = _import_extractor()
    c = ee.classify_resource_name
    assert c("MineralField") == "minerals"
    assert c("LabMineralField750") == "minerals"
    assert c("RichMineralField750") == "gold"
    assert c("SpacePlatformGeyser") == "gas"
    assert c("ShakurasVespeneGeyser") == "gas"
    assert c("DestructibleCityDebris6x6") == "rocks"
    assert c("CollapsibleRockTowerDiagonal") == "rocks"
    assert c("XelNagaTower") == "tower"
    assert c("Zergling") is None
    assert c(None) is None
