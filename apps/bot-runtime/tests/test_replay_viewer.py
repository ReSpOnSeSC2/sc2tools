import asyncio
import json
from types import SimpleNamespace

import pytest
from s2clientprotocol import sc2api_pb2 as api

from pluto_sc2 import replay_viewer as viewer


class Clock:
    def __init__(self):
        self.now = 0.0
        self.on_sleep = None

    def __call__(self):
        return self.now

    async def sleep(self, duration):
        assert 0 < duration <= .05
        self.now += duration
        if self.on_sleep:
            self.on_sleep()


class Controller:
    def __init__(self, finish_loop=24, wrong_build=False, start_error=False):
        self.calls = []
        self.loop = 0
        self.finish_loop = finish_loop
        self.wrong_build = wrong_build
        self.start_error = start_error

    async def ping(self):
        return api.Response(ping=api.ResponsePing(base_build=1 if self.wrong_build else 97563, data_version="ABC"))

    async def _execute(self, **request):
        self.calls.append(request)
        if "replay_info" in request:
            info = api.ResponseReplayInfo(base_build=97563, data_version="ABC", local_map_path="",
                                          map_name="Local map")
            info.player_info.add().player_info.player_id = 1
            return api.Response(replay_info=info)
        if "start_replay" in request:
            started = api.ResponseStartReplay()
            if self.start_error:
                started.error = 1
                started.error_details = "Missing replay map"
            return api.Response(start_replay=started)
        if "step" in request:
            self.loop += request["step"].count
            return api.Response(step=api.ResponseStep())
        if "observation" in request:
            response = api.ResponseObservation(observation=api.Observation(game_loop=self.loop))
            if self.loop >= self.finish_loop:
                response.player_result.add(player_id=1, result=1)
            return api.Response(observation=response)
        pytest.fail(f"Unexpected request: {request}")


class Process:
    def __init__(self, controller):
        self.controller = controller
        self._process = SimpleNamespace(pid=987654, poll=lambda: None)
        self.cleaned = False
        self.configuration = None

    def factory(self, **configuration):
        self.configuration = configuration
        return self

    async def __aenter__(self):
        return self.controller

    async def __aexit__(self, *args):
        self.cleaned = True


@pytest.fixture
def rig(tmp_path, monkeypatch):
    replay = tmp_path / "local.SC2Replay"
    replay.write_bytes(b"fixture replay bytes")
    output = tmp_path / "viewer"
    output.mkdir()
    monkeypatch.setattr(viewer, "_process_created_at", lambda pid: 123.0)
    clock, process = Clock(), Process(Controller())
    info = {"base_build": 97563, "data_version": "ABC", "map_name": "Local map"}

    def run(**kwargs):
        return asyncio.run(viewer.view(replay, output, process_factory=process.factory,
            inspect=lambda path, sc2_path: info, sleep=clock.sleep, monotonic=clock, **kwargs))

    return SimpleNamespace(run=run, output=output, process=process, clock=clock)


def test_finishes_owned_exact_version_replay_with_game_time_pacing(rig):
    result = rig.run()
    assert result["status"] == "finished" and rig.process.cleaned
    assert result["game_loop"] == 24
    assert result["game_seconds"] == pytest.approx(24 / 22.4)
    assert rig.clock.now == pytest.approx(16 / 22.4)
    assert rig.process.configuration["base_build"] == "Base97563"
    assert rig.process.configuration["data_hash"] == "ABC"
    # No training socket, port, create_game, join_game, or policy actions.
    assert "port" not in rig.process.configuration
    assert all(set(call) <= {"replay_info", "start_replay", "step", "observation"} for call in rig.process.controller.calls)
    start = next(call["start_replay"] for call in rig.process.controller.calls if "start_replay" in call)
    assert start.observed_player_id == 0 and not start.realtime
    assert start.replay_path.endswith("local.SC2Replay")
    assert not start.HasField("replay_data")
    saved = json.loads((rig.output / "status.json").read_text())
    assert saved["status"] == "finished" and saved["sc2pid"] == 987654
    assert saved["process_created_at"] == 123.0


def test_pause_holds_steps_then_resume_uses_requested_speed(rig):
    viewer.write_json(rig.output / "control.json", {"paused": True, "speed": 2.0})
    checked = []

    def resume():
        if not checked:
            checked.append(True)
            assert rig.process.controller.loop == 0
            assert json.loads((rig.output / "status.json").read_text())["status"] == "paused"
            viewer.write_json(rig.output / "control.json", {"paused": False, "speed": 2.0})

    rig.clock.on_sleep = resume
    result = rig.run()
    assert result["status"] == "finished" and result["speed"] == 2.0
    assert rig.clock.now == pytest.approx(.05 + 16 / 22.4 / 2)


def test_close_cleans_only_owned_process_before_any_steps(rig):
    viewer.write_json(rig.output / "control.json", {"close": True})
    result = rig.run()
    assert result["status"] == "closed" and rig.process.cleaned
    assert rig.process.controller.loop == 0


def test_wall_time_limit_closes_owned_viewer(rig):
    result = rig.run(max_wall_seconds=.1)
    assert result["status"] == "closed" and rig.process.cleaned
    assert result["game_loop"] == 8
    assert "wall-time limit" in result["close_reason"]


def test_wrong_game_build_never_starts_replay(rig):
    rig.process.controller.wrong_build = True
    result = rig.run()
    assert result["status"] == "failed" and rig.process.cleaned
    assert "different build" in result["error"]
    assert not rig.process.controller.calls


def test_start_failure_is_durable_and_cleans_owned_process(rig):
    rig.process.controller.start_error = True
    result = rig.run()
    assert result["status"] == "failed" and rig.process.cleaned
    assert "Missing replay map" in result["error"]
    assert rig.process.controller.loop == 0


def test_closed_sc2_window_is_reported_as_closed(rig):
    rig.process._process.poll = lambda: 0
    result = rig.run()
    assert result["status"] == "closed" and rig.process.cleaned


@pytest.mark.parametrize("value", [{"paused": 1}, {"close": "true"}, {"speed": True},
                                  {"speed": 0}, {"speed": 999}, []])
def test_controls_require_bounded_speed_and_boolean_flags(tmp_path, value):
    path = tmp_path / "control.json"
    viewer.write_json(path, value)
    with pytest.raises(ValueError):
        viewer.read_controls(path, {"paused": False, "speed": 1.0, "close": False})


def test_invalid_controls_preserve_safe_previous_pacing(rig):
    viewer.write_json(rig.output / "control.json", {"speed": 999})
    result = rig.run()
    assert result["status"] == "finished" and result["speed"] == 1.0
    assert "Replay speed" in result["control_error"]


def test_exact_recorded_local_map_is_supplied(tmp_path):
    map_path = tmp_path / "ExactMap.SC2Map"
    map_path.write_bytes(b"MPQ\x1a" + b"exact map")
    data, path = viewer.local_map_data({"map_name": str(map_path)})
    assert data == map_path.read_bytes() and path == str(map_path)


def test_missing_recorded_map_is_not_replaced_with_same_basename(tmp_path, monkeypatch):
    (tmp_path / "SameName.SC2Map").write_bytes(b"MPQ\x1a" + b"different map")
    monkeypatch.chdir(tmp_path)
    with pytest.raises(ValueError, match="exact local map is unavailable"):
        viewer.local_map_data({"map_name": str(tmp_path / "missing" / "SameName.SC2Map")})


def test_published_map_display_name_uses_recorded_cache():
    assert viewer.local_map_data({"map_name": "Tourmaline LE"}) == (None, None)


def test_replay_info_path_parse_error_uses_bytes_once(rig):
    execute = rig.process.controller._execute
    requests = []

    async def with_path_error(**request):
        if "replay_info" in request:
            requests.append(request["replay_info"])
            if request["replay_info"].HasField("replay_path"):
                return api.Response(replay_info=api.ResponseReplayInfo(
                    error=api.ResponseReplayInfo.ParsingError, error_details="Could not open initData"))
        return await execute(**request)

    rig.process.controller._execute = with_path_error
    result = rig.run()
    assert result["status"] == "finished" and result["replay_info_transport"] == "bytes"
    assert result["replay_info_path_error"]["code"] == "ParsingError"
    assert len(requests) == 2 and requests[1].replay_data == b"fixture replay bytes"


def test_replay_info_failure_never_attempts_playback(rig):
    requests = []

    async def cannot_parse(**request):
        requests.append(request)
        return api.Response(replay_info=api.ResponseReplayInfo(
            error=api.ResponseReplayInfo.ParsingError, error_details="Could not open initData"))

    rig.process.controller._execute = cannot_parse
    result = rig.run()
    assert result["status"] == "failed" and rig.process.cleaned
    assert result["replay_info"]["error"] == "ParsingError"
    assert len(requests) == 2 and all("replay_info" in request for request in requests)


def test_initdata_failure_uses_one_derived_copy_and_marks_only_real_steps_verified(rig, monkeypatch):
    from pluto_sc2 import replay_repair
    execute = rig.process.controller._execute
    repaired = []

    def repair(source, target):
        repaired.append((source, target))
        target.write_bytes(b"derived replay bytes")
        return {"source": str(source), "derived_replay": str(target), "engine_playback_verified": False}

    async def cannot_parse_original(**request):
        query = request.get("replay_info")
        if query is not None and not query.replay_path.endswith("viewing-copy.SC2Replay"):
            return api.Response(replay_info=api.ResponseReplayInfo(
                error=api.ResponseReplayInfo.ParsingError, error_details="Could not open initData"))
        return await execute(**request)

    monkeypatch.setattr(replay_repair, "repair_replay", repair)
    rig.process.controller._execute = cannot_parse_original
    result = rig.run()
    assert result["status"] == "finished" and len(repaired) == 1
    source, target = repaired[0]
    assert source.read_bytes() == b"fixture replay bytes"
    assert result["replay"] == str(source) and result["playback_replay"] == str(target)
    start = next(call["start_replay"] for call in rig.process.controller.calls if "start_replay" in call)
    assert start.replay_path == str(target)
    report = json.loads((rig.output / "repair-report.json").read_text())
    assert report["engine_playback_verified"] is True and report["verified_game_loop"] == 8
    assert result["engine_playback_verified"] is True


@pytest.mark.parametrize("code,message", [(api.ResponseReplayInfo.InvalidReplayData, "bad data"),
                                        (api.ResponseReplayInfo.ParsingError, "Unknown archive format")])
def test_other_engine_errors_do_not_trigger_repair(rig, monkeypatch, code, message):
    from pluto_sc2 import replay_repair
    monkeypatch.setattr(replay_repair, "repair_replay", lambda *args: pytest.fail("unrelated error must not repair"))

    async def fail(**request):
        return api.Response(replay_info=api.ResponseReplayInfo(error=code, error_details=message))

    rig.process.controller._execute = fail
    result = rig.run()
    assert result["status"] == "failed" and not result["engine_playback_verified"]
