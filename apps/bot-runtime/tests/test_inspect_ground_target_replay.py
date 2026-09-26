"""The replay diagnosis must preserve exact timing and screen-only evidence."""
import asyncio
import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest
from s2clientprotocol import sc2api_pb2 as api


spec = importlib.util.spec_from_file_location(
    "inspect_ground_target_replay", Path(__file__).parents[1] / "scripts" / "inspect_ground_target_replay.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def case():
    return {"command_loop": 100, "audit_index": 0,
            "command": {"kind": "command", "ability": 23, "game_loop": 100,
                        "target_kind": "ground", "minimap": False, "target_pixel": [64, 36],
                        "camera": [50, 50], "effective_target": [50.09375, 49.90625]}}


def response(loop=100):
    reply = api.Response()
    ob = reply.observation.observation
    ob.game_loop = loop
    ob.raw_data.player.camera.x = 50
    ob.raw_data.player.camera.y = 50
    return reply


def test_schedule_has_exact_pre_and_post_command_frames():
    assert sorted(module.sample_schedule([case()], module.DEFAULT_OFFSETS, 200)) == [92, 99, 100, 101, 102, 108]
    with pytest.raises(ValueError, match="outside"):
        module.sample_schedule([case()], [-101], 200)


@pytest.mark.parametrize("change", [{"minimap": True}, {"target_pixel": [-1, 2]}, {"ability": 16}])
def test_audit_inputs_must_be_feature_screen_attack23(change):
    command = case()["command"] | change
    with pytest.raises(ValueError):
        module.command_cases({"actions": [command]}, [100])


def test_exact_loop_mismatch_fails_instead_of_labelling_later_state_as_command_frame():
    with pytest.raises(RuntimeError, match="Expected exact"):
        module.snapshot(response(101), 100, [{"case": case(), "offset": 0}])


def test_hidden_unit_position_is_never_read():
    class HiddenUnit:
        is_on_screen = False

        @property
        def pos(self):
            raise AssertionError("Hidden geometry read")

    assert module.screen_unit(HiddenUnit(), SimpleNamespace(x=50, y=50)) is None


def test_snapshot_keeps_executed_command_distinct_from_unit_order_and_filters_hidden():
    reply = response(102)
    ob = reply.observation.observation
    visible = ob.raw_data.units.add(tag=3, unit_type=74, owner=1, alliance=1,
                                   is_on_screen=True, display_type=1, radius=.625)
    visible.pos.x, visible.pos.y = 50, 50
    visible.orders.add(ability_id=23, target_unit_tag=4)
    ob.raw_data.units.add(tag=99, unit_type=74, owner=1, alliance=1,
                          is_on_screen=False, display_type=1)
    action = reply.observation.actions.add(game_loop=101)
    action.action_raw.unit_command.ability_id = 23
    action.action_raw.unit_command.target_world_space_pos.x = 51
    action.action_raw.unit_command.target_world_space_pos.y = 49
    reply.observation.actions.add(game_loop=20)  # Outside this diagnostic window.
    layer = ob.feature_layer_data.renders.player_relative
    layer.size.x, layer.size.y, layer.bits_per_pixel = 128, 72, 8
    values = bytearray(128 * 72)
    values[36 * 128 + 64] = 1
    layer.data = bytes(values)
    record = module.snapshot(reply, 102, [{"case": case(), "offset": 2}])
    assert [row["tag"] for row in record["current_screen_units"]] == [3]
    assert record["current_screen_units"][0]["radius"] == .625
    assert record["current_screen_units"][0]["orders"][0]["target_unit_tag"] == "4"
    assert record["samples"][0]["layers"]["player_relative"] == 1
    actions = record["executed_actions_since_previous_observation"]
    assert len(actions) == 1 and actions[0]["game_loop"] == 101
    assert actions[0]["action_raw"]["unit_command"]["target_world_space_pos"] == {"x": 51.0, "y": 49.0}


def metadata_reply():
    reply = api.Response()
    reply.replay_info.base_build = 97563
    reply.replay_info.data_version = "ABC"
    reply.replay_info.player_info.add().player_info.player_id = 1
    return reply


@pytest.mark.parametrize("failure", [None, "Could not open initData", "Other archive failure"])
def test_playback_start_uses_one_label_only_copy_only_for_engine_initdata_failure(tmp_path, monkeypatch, failure):
    from pluto_sc2 import replay_repair

    replay = tmp_path / "original.SC2Replay"
    replay.write_bytes(b"original replay")
    requests, repairs, updates = [], [], {}

    async def ping():
        result = api.Response()
        result.ping.base_build, result.ping.data_version = 97563, "ABC"
        return result

    async def execute(**request):
        assert list(request) == ["replay_info"]  # Never a gameplay or observer command here.
        query = request["replay_info"]
        assert not query.download_data
        requests.append(query)
        if failure and not query.replay_path.endswith("viewing-copy.SC2Replay"):
            return api.Response(replay_info=api.ResponseReplayInfo(
                error=api.ResponseReplayInfo.ParsingError, error_details=failure))
        return metadata_reply()

    def repair(source, target):
        assert source == replay and source.read_bytes() == b"original replay"
        assert target != source and not target.exists()
        repairs.append(target)
        target.write_bytes(b"derived viewing copy")
        return {"derived_replay": str(target), "engine_playback_verified": False}

    monkeypatch.setattr(replay_repair, "repair_replay", repair)
    task = module.playback_source(SimpleNamespace(ping=ping, _execute=execute), replay, tmp_path,
                                  {"base_build": 97563, "data_version": "ABC"}, 1,
                                  lambda **values: updates.update(values))
    if failure == "Other archive failure":
        with pytest.raises(RuntimeError, match="Replay metadata failed"):
            asyncio.run(task)
        assert not repairs and len(requests) == 2
    else:
        result = asyncio.run(task)
        if failure:
            assert len(repairs) == 1 and result == repairs[0]
            assert len(requests) == 3 and requests[1].replay_data == b"original replay"
            assert not updates["viewing_copy_repair"]["engine_playback_verified"]
        else:
            assert result == replay and not repairs and len(requests) == 1
    assert replay.read_bytes() == b"original replay"
