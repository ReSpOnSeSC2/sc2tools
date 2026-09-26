"""Offline checks; these tests never start SC2."""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from s2clientprotocol import common_pb2 as common
from s2clientprotocol import data_pb2 as data
from s2clientprotocol import sc2api_pb2 as api
from sc2.ids.unit_typeid import UnitTypeId as U


spec = importlib.util.spec_from_file_location(
    "inspect_pvz_walls", Path(__file__).resolve().parents[1] / "scripts/inspect_pvz_walls.py")
walls = importlib.util.module_from_spec(spec)
spec.loader.exec_module(walls)


def test_packed_grid_preserves_world_yx_and_bit_order():
    grid = common.ImageData(bits_per_pixel=1, size=common.Size2DI(x=4, y=2), data=b"\x91")
    assert walls.grid_array(grid).tolist() == [[1, 0, 0, 1], [0, 0, 0, 1]]


def test_malformed_grid_is_not_silently_interpreted():
    grid = common.ImageData(bits_per_pixel=8, size=common.Size2DI(x=4, y=2), data=b"\x91")
    with pytest.raises(ValueError, match="Unsupported grid encoding"):
        walls.grid_array(grid)


def test_current_own_engine_centers_are_not_rounded_or_mixed_with_enemies():
    response = api.Response()
    ob = response.observation.observation
    ob.game_loop = 4032
    ob.raw_data.units.add(tag=1, owner=2, unit_type=U.NEXUS.value,
                         pos=common.Point(x=133.5, y=38.5, z=8), radius=2.75, build_progress=.8125)
    guard = ob.raw_data.units.add(tag=2, owner=2, unit_type=U.ZEALOT.value,
                                 pos=common.Point(x=127.8125, y=44.0625), radius=.5, build_progress=1)
    guard.orders.add(ability_id=18)
    ob.raw_data.units.add(tag=3, owner=1, unit_type=U.ZERGLING.value,
                         pos=common.Point(x=127.75, y=44.5))
    row = {"natural_tracker_position": [133, 38], "player": {"player_id": 2},
           "replay_id": "fixture", "label": "wall"}
    grids = {"pathing_grid": {"width": 180, "height": 180, "numpy": np.ones((180, 180), dtype=np.uint8)}}
    units = {U.NEXUS.value: data.UnitTypeData(unit_id=U.NEXUS.value, attributes=[data.Structure])}
    snapshot = walls.wall_snapshot(response, row, [133.5, 38.5], grids, units)
    assert snapshot["natural_raw_position"] == [133.5, 38.5]
    assert [u["tag"] for u in snapshot["own_near_natural"]] == [1, 2]
    assert snapshot["own_near_natural"][0]["build_progress"] == .8125
    assert snapshot["own_near_natural"][1]["position"] == [127.8125, 44.0625]
    assert snapshot["own_near_natural"][1]["orders"][0]["ability_id"] == 18
    assert snapshot["gap_width_verified"] is False
    assert snapshot["guard_role_verified"] is False


def test_overview_includes_natural_and_wall_not_main_or_gas():
    record = {"natural_raw_position": [181.5, 107.5], "own_near_natural": [
        {"type": "GATEWAY", "position": [170.5, 111.5], "is_structure": True},
        {"type": "CYBERNETICSCORE", "position": [171.5, 115.5], "is_structure": True},
        {"type": "ASSIMILATOR", "position": [188.5, 108.5], "is_structure": True},
        {"type": "GATEWAY", "position": [178.5, 76.5], "is_structure": True},
    ]}
    row = {"natural_tracker_position": [181, 107], "main_tracker_position": [178, 73]}
    assert walls.overview_center(record, row) == [176.0, 111.5]


def test_active_review_driver_blocks_before_any_engine_launch(tmp_path, monkeypatch):
    folder = tmp_path / "engine-views"
    folder.mkdir()
    (folder / "status.json").write_text(json.dumps({"pid": 11, "process_created_at": 12, "status": "complete"}))
    monkeypatch.setattr(walls, "identity_alive", lambda *_: True)
    with pytest.raises(ValueError, match="driver is still alive"):
        walls.require_idle_engine(tmp_path)


def test_other_sc2_process_blocks_and_is_never_terminated(tmp_path, monkeypatch):
    fake = SimpleNamespace(pid=52, info={"name": "SC2_x64.exe", "pid": 52, "create_time": 91})
    monkeypatch.setattr(walls.psutil, "process_iter", lambda *_: [fake])
    with pytest.raises(ValueError, match="no second engine"):
        walls.require_idle_engine(tmp_path)
