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
    class _TargetPointCommandEvent:
        pass

    class _SelectionEvent:
        pass

    game_mod = SimpleNamespace(
        CommandEvent=_CommandEvent,
        TargetPointCommandEvent=_TargetPointCommandEvent,
        SelectionEvent=_SelectionEvent,
    )
    sys.modules["sc2reader"] = MagicMock()
    sys.modules["sc2reader.events"] = MagicMock()
    sys.modules["sc2reader.events.tracker"] = tracker_mod
    sys.modules["sc2reader.events.game"] = game_mod

    sys.modules.pop("core.event_extractor", None)
    return importlib.import_module("core.event_extractor"), SimpleNamespace(
        UnitBornEvent=_UnitBornEvent,
        UnitInitEvent=_UnitInitEvent,
        UnitTypeChangeEvent=_UnitTypeChangeEvent,
        UnitDiedEvent=_UnitDiedEvent,
        UnitPositionsEvent=_UnitPositionsEvent,
        TargetPointCommandEvent=_TargetPointCommandEvent,
        SelectionEvent=_SelectionEvent,
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


def _select(klass, second, *, pid, ids):
    ev = klass()
    ev.second = second
    ev.frame = second * 16
    ev.control_group = 10
    ev.player = SimpleNamespace(pid=pid)
    ev.new_unit_ids = list(ids)
    return ev


def _target_cmd(klass, second, *, pid, ability, x, y):
    ev = klass()
    ev.second = second
    ev.frame = second * 16
    ev.player = SimpleNamespace(pid=pid)
    ev.ability_name = ability
    ev.x = x
    ev.y = y
    return ev


def _lifecycle_replay(tracker, game_events):
    r = _make_replay(tracker)
    r.events = game_events
    return r


def test_building_lifecycle_uses_observations_not_land_or_rally_intent():
    ee, k = _import_extractor()
    cc = (20 << 18) | 1
    tracker = [
        _born(k.UnitBornEvent, 0, pid=1, name="CommandCenter", uid=cc,
              index=20, x=30, y=40),
        _positions(k.UnitPositionsEvent, 320, [(20, (85, 86))]),
    ]
    game = [
        _select(k.SelectionEvent, 100, pid=1, ids=[cc]),
        # Rally click with the CC selected must NOT read as a move.
        _target_cmd(k.TargetPointCommandEvent, 110, pid=1,
                    ability="Rally", x=50, y=50),
        _target_cmd(k.TargetPointCommandEvent, 300, pid=1,
                    ability="Land", x=90.04, y=88.02),
    ]
    out = ee.extract_building_lifecycle(_lifecycle_replay(tracker, game))
    (rec,) = out[1]
    assert rec["name"] == "CommandCenter"
    assert rec["moves"] == [320.0, 85.0, 86.0]
    assert rec["died"] is None


def test_building_lifecycle_records_death_and_morph_rename():
    ee, k = _import_extractor()
    cc = (21 << 18) | 1
    rax = (22 << 18) | 1
    def _morph(second, uid, name):
        ev = k.UnitTypeChangeEvent()
        ev.second = second
        ev.frame = second * 16
        ev.unit_id = uid
        ev.unit = None
        ev.unit_type_name = name
        return ev
    tracker = [
        _born(k.UnitBornEvent, 0, pid=1, name="CommandCenter", uid=cc,
              index=21, x=30, y=40),
        _born(k.UnitInitEvent, 50, pid=1, name="Barracks", uid=rax,
              index=22, x=44, y=38),
        # Flying state must not rename; the Orbital morph must.
        _morph(200, cc, "CommandCenterFlying"),
        _morph(240, cc, "OrbitalCommand"),
        _died(k.UnitDiedEvent, 500, uid=rax, index=22, x=44, y=38),
    ]
    out = ee.extract_building_lifecycle(_lifecycle_replay(tracker, []))
    by_name = {r["name"]: r for r in out[1]}
    assert "CommandCenter" in by_name
    assert by_name["Barracks"]["died"] == 500.0
    assert by_name["CommandCenter"]["died"] is None
    assert by_name["CommandCenter"]["forms"] == [
        {"t": 200.0, "name": "CommandCenterFlying"},
        {"t": 240.0, "name": "OrbitalCommand"},
    ]


def test_commands_never_become_unit_positions():
    ee, k = _import_extractor()
    uid = (8 << 18) | 1
    replay = _make_replay([
        _born(k.UnitBornEvent, 0, pid=1, name="Probe", uid=uid, index=8, x=30, y=40),
        _positions(k.UnitPositionsEvent, 25, [(8, (32, 42))]),
    ])
    replay.events = [
        _select(k.SelectionEvent, 1, pid=1, ids=[uid]),
        _target_cmd(k.TargetPointCommandEvent, 5, pid=1, ability="Move", x=190, y=180),
        _target_cmd(k.TargetPointCommandEvent, 6, pid=1, ability="BuildPylon", x=170, y=160),
        _select(k.SelectionEvent, 7, pid=1, ids=[]),
        _target_cmd(k.TargetPointCommandEvent, 8, pid=1, ability="PsiStorm", x=150, y=140),
    ]
    out = ee.extract_unit_tracks(replay, 1)
    assert out["my_units"][0]["waypoints"] == [0.0, 30.0, 40.0, 25.0, 32.0, 42.0]
    assert out["complete"] is True


def test_all_beacons_and_spell_actors_are_excluded():
    ee, k = _import_extractor()
    names = ["BeaconClaim", "BeaconExpand", "BeaconFutureType", "ForceField", "KD8Charge", "DisruptorPhased", "OracleStasisTrap"]
    replay = _make_replay([
        _born(k.UnitBornEvent, 0, pid=1, name=name, uid=(i << 18) | 1,
              index=i, x=30, y=40) for i, name in enumerate(names, 1)
    ])
    out = ee.extract_unit_tracks(replay, 1)
    assert out["my_units"] == []
    assert out["opp_units"] == []


def _morph(klass, second, uid, name):
    ev = klass()
    ev.frame = second * 16
    ev.unit_id = uid
    ev.unit_type_name = name
    return ev


def test_morphs_keep_initial_identity_and_cocoon_interval():
    ee, k = _import_extractor()
    uid = (8 << 18) | 1
    replay = _make_replay([
        _born(k.UnitBornEvent, 10, pid=1, name="Zergling", uid=uid, index=8, x=30, y=40),
        _morph(k.UnitTypeChangeEvent, 20, uid, "BanelingCocoon"),
        _morph(k.UnitTypeChangeEvent, 30, uid, "Baneling"),
        _died(k.UnitDiedEvent, 50, uid=uid, index=8, x=60, y=70),
    ])
    (unit,) = ee.extract_unit_tracks(replay, 1)["my_units"]
    assert unit["name"] == "Zergling"
    assert unit["born"] == 10.0 and unit["died"] == 50.0
    assert unit["forms"] == [{"t": 20.0, "name": "BanelingCocoon"}, {"t": 30.0, "name": "Baneling"}]


def test_drone_becoming_structure_closes_worker_lifetime():
    ee, k = _import_extractor()
    uid = (8 << 18) | 1
    replay = _make_replay([
        _born(k.UnitBornEvent, 0, pid=1, name="Drone", uid=uid, index=8, x=30, y=40),
        _morph(k.UnitTypeChangeEvent, 20, uid, "Hatchery"),
        _positions(k.UnitPositionsEvent, 40, [(8, (50, 60))]),
        _died(k.UnitDiedEvent, 50, uid=uid, index=8, x=50, y=60),
    ])
    (unit,) = ee.extract_unit_tracks(replay, 1)["my_units"]
    assert unit["died"] == 20.0 and unit["killer_pid"] is None
    assert unit["waypoints"] == [0.0, 30.0, 40.0]


def test_stationary_samples_and_subsecond_death_survive():
    ee, k = _import_extractor()
    uid = (8 << 18) | 1
    born = _born(k.UnitBornEvent, 0, pid=1, name="Probe", uid=uid, index=8, x=30, y=40)
    died = _died(k.UnitDiedEvent, 1, uid=uid, index=8, x=31, y=40)
    born.frame = 1
    died.frame = 3
    replay = _make_replay([born, _positions(k.UnitPositionsEvent, 0.125, [(8, (30, 40))]), died])
    (unit,) = ee.extract_unit_tracks(replay, 1)["my_units"]
    assert unit["born"] == 0.062 and unit["died"] == 0.188
    assert unit["waypoints"][0::3] == [0.062, 0.125, 0.188]


def test_stale_death_does_not_evict_recycled_live_index():
    ee, k = _import_extractor()
    old, new = (8 << 18) | 1, (8 << 18) | 2
    replay = _make_replay([
        _born(k.UnitBornEvent, 0, pid=1, name="Marine", uid=old, index=8, x=30, y=40),
        _died(k.UnitDiedEvent, 10, uid=old, index=8, x=31, y=40),
        _born(k.UnitBornEvent, 20, pid=2, name="Drone", uid=new, index=8, x=100, y=110),
        _died(k.UnitDiedEvent, 21, uid=old, index=8, x=31, y=40),
        _positions(k.UnitPositionsEvent, 30, [(8, (101, 111))]),
    ])
    out = ee.extract_unit_tracks(replay, 1)
    assert out["my_units"][0]["died"] == 10.0
    assert out["opp_units"][0]["waypoints"][-3:] == [30.0, 101.0, 111.0]


def test_real_game_length_uses_event_timebase():
    from core.timebase import real_game_length
    # 16:04 real game at LotV Faster: frames = 964 * 22.4.
    replay = SimpleNamespace(
        frames=int(964 * 22.4),
        length=SimpleNamespace(seconds=964),
        game_length=SimpleNamespace(seconds=1349),  # frames/16 (game time)
    )
    assert abs(real_game_length(replay) - 964.0) < 1.0
    # No frames -> falls back to the reported game_length.
    bare = SimpleNamespace(frames=None, game_length=SimpleNamespace(seconds=600))
    assert real_game_length(bare) == 600.0


def test_precise_lotv_clock_does_not_infer_speed_from_rounded_duration():
    from core.timebase import event_seconds_precise
    replay = SimpleNamespace(frames=17847, length=SimpleNamespace(seconds=796),
                             speed="Faster", expansion="LotV")
    event = SimpleNamespace(frame=17847)
    assert event_seconds_precise(event, replay) == 17847 / 22.4
