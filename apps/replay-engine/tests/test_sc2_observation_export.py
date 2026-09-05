"""Engine accumulator and cache regressions; no SC2 install/network required."""
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
from core import sc2_observation_export as exporter


def unit(tag="18446744073709551614", owner=1, unit_type=1, x=10, y=20, display_type=1):
    return dict(tag=tag, owner=owner, unit_type=unit_type, x=x, y=y, display_type=display_type)


def accumulator():
    return exporter.ObservationAccumulator(1, {1: {"name": "Marine"}, 2: {"name": "Hatchery", "structure": True},
        3: {"name": "Lair", "structure": True}}, {1: "PsiStormPersistent"}, 0.2)


def test_external_windows_environment_removes_only_bundle_path_entries():
    environment = {"Path": ';"C:/Agent/_internal";C:\\Agent\\_INTERNAL\\PySide6;C:\\Agent\\_internal-extra;C:\\Games;C:\\Windows',
                   "SC2PATH": "D:/Games/StarCraft II", "OTHER": "untouched"}
    original = environment.copy()
    child = exporter._external_windows_environment(environment, "C:/Agent/_internal")
    assert child["Path"] == ";C:\\Agent\\_internal-extra;C:\\Games;C:\\Windows"
    assert child["SC2PATH"] == environment["SC2PATH"]
    assert child["OTHER"] == "untouched"
    assert environment == original


@pytest.mark.parametrize("fails", [False, True])
def test_frozen_launch_restores_dll_directory_even_if_popen_fails(monkeypatch, fails):
    import ctypes

    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", "C:/Agent/_internal", raising=False)
    monkeypatch.setenv("PATH", "C:/Agent/_internal;D:/UserTools;C:/Windows")
    state = {"directory": "D:/ExistingDllDirectory", "calls": []}

    def get_directory(length, buffer):
        if length:
            buffer.value = state["directory"] or ""
        return len(state["directory"] or "")

    def set_directory(path):
        state["directory"] = path
        state["calls"].append(path)
        return True

    monkeypatch.setattr(ctypes, "WinDLL", lambda *_args, **_kwargs: SimpleNamespace(
        GetDllDirectoryW=get_directory, SetDllDirectoryW=set_directory), raising=False)
    process = object()

    def popen(args, **kwargs):
        assert args == ["C:/SC2/SC2_x64.exe"]
        assert state["directory"] is None
        assert kwargs["env"]["PATH"] == "D:/UserTools;C:/Windows"
        assert exporter.os.environ["PATH"] == "C:/Agent/_internal;D:/UserTools;C:/Windows"
        if fails:
            raise OSError("process creation failed")
        return process

    monkeypatch.setattr(exporter.subprocess, "Popen", popen)
    if fails:
        with pytest.raises(OSError, match="process creation failed"):
            exporter._launch_sc2(["C:/SC2/SC2_x64.exe"])
    else:
        assert exporter._launch_sc2(["C:/SC2/SC2_x64.exe"]) is process
    assert state["calls"] == [None, "D:/ExistingDllDirectory"]
    assert state["directory"] == "D:/ExistingDllDirectory"


def test_source_launch_preserves_environment_without_touching_dll_state(monkeypatch):
    monkeypatch.setattr(sys, "frozen", False, raising=False)
    calls = []
    monkeypatch.setattr(exporter.subprocess, "Popen", lambda *args, **kwargs: calls.append((args, kwargs)) or "process")
    environment = {"PATH": "C:/Agent/_internal;D:/UserTools"}
    assert exporter._launch_sc2(["SC2"], env=environment) == "process"
    assert calls == [((["SC2"],), {"env": environment})]


def test_background_launch_failure_never_falls_back_to_unprotected_popen(monkeypatch):
    from core import windows_capture_process
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(sys, "frozen", False, raising=False)

    def denied(*_args, **_kwargs):
        raise OSError("window guardian denied")

    monkeypatch.setattr(windows_capture_process, "launch_background_process", denied)
    monkeypatch.setattr(exporter.subprocess, "Popen", lambda *_a, **_k: pytest.fail("visible fallback launched"))
    with pytest.raises(OSError, match="window guardian denied"):
        exporter._launch_sc2(["SC2"], background_windows=True)


def test_standalone_exporter_resolves_background_launcher_without_package(monkeypatch):
    import runpy
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(sys, "frozen", False, raising=False)
    monkeypatch.setitem(sys.modules, "windows_capture_process", SimpleNamespace(
        launch_background_process=lambda *_a, **_k: "background child"))
    namespace = runpy.run_path(exporter.__file__, run_name="standalone_exporter_test")
    assert not namespace["__package__"]
    assert namespace["_launch_sc2"](["SC2"], background_windows=True) == "background child"


def test_background_create_process_failure_releases_job_and_only_duplicated_handles(tmp_path, monkeypatch):
    import ctypes
    from ctypes import wintypes
    from core import windows_capture_process as windows
    closed, duplicated, deleted = [], [], []

    def duplicate(_parent, _source, _target, output, _access, inherit, _options):
        assert inherit is True
        handle = 100 + len(duplicated)
        ctypes.cast(output, ctypes.POINTER(wintypes.HANDLE))[0] = handle
        duplicated.append(handle)
        return True

    def attributes(pointer, _count, _flags, size):
        ctypes.cast(size, ctypes.POINTER(ctypes.c_size_t))[0] = 64
        return pointer is not None

    def create(_exe, _command, _psa, _tsa, inherit, flags, _env, _cwd, startup, _information):
        startup = ctypes.cast(startup, ctypes.POINTER(windows._STARTUPINFOEXW)).contents
        assert startup.StartupInfo.lpDesktop is None
        assert flags & 0x80000 and flags & 0x4000 and flags & 0x4 and inherit is True
        assert startup.StartupInfo.wShowWindow == 0
        assert startup.lpAttributeList
        return False

    api = SimpleNamespace(error=lambda action: OSError(action),
        kernel=SimpleNamespace(GetCurrentProcess=lambda: 1, DuplicateHandle=duplicate,
            CreateJobObjectW=lambda *_a: 800, SetInformationJobObject=lambda *_a: True,
            InitializeProcThreadAttributeList=attributes,
            UpdateProcThreadAttribute=lambda _p, _f, attribute, handles, *_a: attribute == 0x20002 and list(handles) == duplicated,
            DeleteProcThreadAttributeList=lambda pointer: deleted.append(pointer),
            CloseHandle=lambda handle: closed.append(handle) or True, CreateProcessW=create))
    monkeypatch.setattr(windows, "_WindowsAPI", lambda: api)
    with (tmp_path / "capture.log").open("wb") as output:
        with pytest.raises(OSError, match="background capture"):
            windows.launch_background_process(["SC2"], stdout=output, stderr=output)
        assert output.closed is False
    assert duplicated == [100, 101, 102]
    assert closed == [800, 100, 101, 102]
    assert len(deleted) == 1


def test_background_guard_enumeration_failure_is_not_silently_accepted():
    import ctypes
    from core import windows_capture_process as windows
    guard = windows._BackgroundWindowGuard.__new__(windows._BackgroundWindowGuard)
    guard.job = 800
    guard._callback_type = lambda callback: callback
    guard.api = SimpleNamespace(error=lambda action: OSError(action),
        kernel=SimpleNamespace(QueryInformationJobObject=lambda *_a: True),
        user=SimpleNamespace(EnumWindows=lambda *_a: False))
    with pytest.raises(OSError, match="inspect owned capture windows"):
        guard._scan()


def test_background_guard_stop_error_cannot_skip_owned_job_cleanup():
    from core import windows_capture_process as windows
    calls = []
    api = SimpleNamespace(error=lambda action: OSError(action), kernel=SimpleNamespace(
        TerminateJobObject=lambda handle, _code: calls.append(("terminate", handle)) or True,
        CloseHandle=lambda handle: calls.append(("close", handle)) or True))
    guard = SimpleNamespace(stop=lambda: (_ for _ in ()).throw(OSError("guardian join failed")))
    process = windows._CaptureProcess(api, 100, 17, ["SC2"], job=800, guard=guard)
    process.returncode = 0
    with pytest.raises(OSError, match="guardian join failed"):
        process.close()
    assert calls == [("terminate", 800), ("close", 800), ("close", 100)]
    assert process._job is None and process._handle is None


@pytest.mark.parametrize("failed", [False, True])
def test_engine_websocket_close_failure_still_reaps_child_and_desktop(tmp_path, monkeypatch, failed):
    calls = []
    state = {"finished": False}
    engine = exporter._Engine(tmp_path, tmp_path / "SC2.exe", None, 10)
    engine.temp = exporter.tempfile.TemporaryDirectory(dir=tmp_path)
    temporary = Path(engine.temp.name)
    engine.log = (temporary / "engine.log").open("wb")
    monkeypatch.setenv("SC2TOOLS_OBSERVATION_DIR", str(tmp_path / "cache"))

    def wait(timeout):
        calls.append("wait")
        if not state["finished"]:
            raise exporter.subprocess.TimeoutExpired("SC2", timeout)

    def kill():
        calls.append("kill")
        state["finished"] = True

    def close_process():
        assert state["finished"]
        calls.append("close desktop")

    engine.process = SimpleNamespace(poll=lambda: 0 if state["finished"] else None,
        terminate=lambda: calls.append("terminate"), wait=wait, kill=kill, close=close_process)
    engine.ws = SimpleNamespace(close=lambda: (_ for _ in ()).throw(ConnectionError("socket closed")))
    if failed:
        engine.close(failed=True)
    else:
        with pytest.raises(exporter.ObservationExportError, match="socket closed"):
            engine.close()
    assert calls == ["terminate", "wait", "kill", "wait", "close desktop"]
    assert not temporary.exists()
    assert engine.process is None and engine.ws is None and engine.log is None


def test_engine_startup_failure_retains_diagnostic_after_temp_cleanup(tmp_path, monkeypatch):
    monkeypatch.setenv("SC2TOOLS_OBSERVATION_DIR", str(tmp_path / "cache"))
    original_temp = exporter.tempfile.TemporaryDirectory
    monkeypatch.setattr(exporter.tempfile, "TemporaryDirectory", lambda **kwargs: original_temp(dir=tmp_path, **kwargs))
    monkeypatch.setitem(sys.modules, "websocket", SimpleNamespace())
    monkeypatch.setitem(sys.modules, "s2clientprotocol", SimpleNamespace(sc2api_pb2=SimpleNamespace()))

    def launch(_args, **kwargs):
        kwargs["stdout"].write(b"engine startup explanation\n")
        return SimpleNamespace(returncode=17, poll=lambda: 17)

    monkeypatch.setattr(exporter, "_launch_sc2", launch)
    engine = exporter._Engine(tmp_path, tmp_path / "SC2_x64.exe", None, 10)
    with pytest.raises(exporter.ObservationExportError) as error:
        engine.__enter__()
    assert "code 17" in str(error.value)
    logs = list((tmp_path / "cache" / "diagnostics").glob("*.log"))
    assert len(logs) == 1
    assert str(logs[0].resolve()) in str(error.value)
    assert b"engine startup explanation" in logs[0].read_bytes()
    assert not list(tmp_path.glob("sc2-observation-*"))


def test_engine_failure_log_is_bounded_and_success_has_no_diagnostic(tmp_path, monkeypatch):
    monkeypatch.setenv("SC2TOOLS_OBSERVATION_DIR", str(tmp_path / "cache"))
    for failed in (False, True):
        engine = exporter._Engine(tmp_path, tmp_path / "SC2_x64.exe", None, 10)
        engine.temp = exporter.tempfile.TemporaryDirectory(dir=tmp_path)
        temp_path = Path(engine.temp.name)
        engine.log = (temp_path / "engine.log").open("wb")
        engine.log.write(b"a" * (exporter.MAX_DIAGNOSTIC_BYTES * 2) + b"last output")
        if failed:
            with pytest.raises(exporter.ObservationExportError) as error:
                engine.__exit__(ValueError, ValueError("capture failed"), None)
            logs = list((tmp_path / "cache" / "diagnostics").glob("*.log"))
            assert len(logs) == 1
            data = logs[0].read_bytes()
            assert len(data) < exporter.MAX_DIAGNOSTIC_BYTES + 512
            assert data.endswith(b"last output")
            assert b"Earlier output omitted" in data
            assert "capture failed" in str(error.value)
            assert str(logs[0].resolve()) in str(error.value)
        else:
            engine.__exit__(None, None, None)
            assert not (tmp_path / "cache" / "diagnostics").exists()
        assert not temp_path.exists()


def test_bitmap_runs_msb_first_and_row_boundary():
    # Width 4: y0 has x0,x3; y1 has x0,x1. The adjacent set bits across
    # the row edge are one span; the renderer must split at width.
    assert exporter.encode_bit_runs(bytes([0b10011100]), 4, 2) == [0, 1, 3, 3]
    assert exporter.encode_bit_runs(bytes([0, 1, 1, 0]), 2, 2, 8) == [1, 2]
    assert exporter.encode_bit_runs(bytes([0]), 4, 2) == []
    with pytest.raises(exporter.ObservationExportError):
        exporter.encode_bit_runs(b"", 4, 2)


def test_stationary_compression_preserves_arrival_and_departure_times():
    points = []
    for sample in [(0, 0, 0), (1, 1, 1), (2, 1, 1), (3, 1, 1), (4, 2, 1)]:
        exporter.append_observed_waypoint(points, *sample)
    assert points == [0, 0, 0, 1, 1, 1, 3, 1, 1, 4, 2, 1]


def test_transport_absence_hides_without_death_and_keeps_uint64_tags_as_strings():
    acc = accumulator()
    acc.observe({"t": 0, "units": [unit()]})
    acc.observe({"t": 1, "units": []})
    acc.observe({"t": 2, "units": [unit(x=30)]})
    result = acc.result(True)["my_units"][0]
    assert result["id"] == "18446744073709551614"
    assert result["hidden"] == [1, 2]
    assert result["died"] is None
    assert result["waypoints"] == [0, 10, 20, 1, 10, 20, 2, 30, 20]


def test_creep_feature_rows_normalize_to_world_y_without_scaling():
    # Two rows, top-left x0 and bottom-right x3 -> inverse in world coordinates.
    assert exporter.flip_bitmap_rows(bytes([0b10000001]), 4, 2) == bytes([0b00011000])
    assert exporter.flip_bitmap_rows(bytes([0b10000000, 0b00000001]), 8, 2) == bytes([0b00000001, 0b10000000])


def test_structure_or_owner_transition_splits_lives_without_retroactive_ownership():
    acc = accumulator()
    acc.observe({"t": 0, "units": [unit()]})
    acc.observe({"t": 10, "units": [unit(unit_type=2)]})
    acc.observe({"t": 20, "units": [unit(unit_type=2, owner=2)]})
    result = acc.result(True)
    assert result["my_units"][0]["died"] == 10
    assert result["my_units"][0]["killer_pid"] is None
    assert result["my_buildings"][0]["born"] == 10
    assert result["my_buildings"][0]["died"] == 20
    assert result["opp_buildings"][0]["born"] == 20
    assert result["opp_buildings"][0]["died"] is None


def test_only_explicit_death_kills_and_snapshot_or_placeholder_never_spawns_a_ghost():
    acc = accumulator()
    acc.observe({"t": 0, "units": [unit(), unit(tag="2", display_type=2), unit(tag="3", display_type=4), unit(tag="4", owner=16)]})
    acc.observe({"t": 1, "units": [], "dead_units": ["18446744073709551614"]})
    result = acc.result(True)
    assert len(result["my_units"]) == 1
    assert result["my_units"][0]["died"] == 1
    assert not result["opp_units"]


def test_morph_stays_one_building_and_keeps_recorded_form_time():
    acc = accumulator()
    acc.observe({"t": 0, "units": [unit(unit_type=2, owner=2)]})
    acc.observe({"t": 10, "units": [unit(unit_type=3, owner=2)]})
    result = acc.result(True)
    assert len(result["opp_buildings"]) == 1
    assert result["opp_buildings"][0]["name"] == "Hatchery"
    assert result["opp_buildings"][0]["forms"] == [{"t": 10, "name": "Lair"}]
    assert result["opp_buildings"][0]["x"] == 10
    assert not result["opp_units"]


def test_effect_lifetimes_follow_observation_disappearance_and_multiple_positions():
    acc = accumulator()
    effect = {"id": 1, "owner": 2, "radius": 1.5, "positions": [(20, 30), (25, 30)]}
    acc.observe({"t": 5, "effects": [effect]})
    acc.observe({"t": 5.2, "effects": [effect]})
    acc.observe({"t": 5.4, "effects": []})
    effects = acc.result(True)["effects"]
    assert len(effects) == 2
    assert all(effect["t"] == 5 and effect["end"] == 5.4 for effect in effects)
    assert all(effect["name"] == "PsiStormPersistent" and effect["owner"] == "opp" for effect in effects)


def test_effect_without_player_owner_remains_visible_as_neutral():
    acc = accumulator()
    acc.observe({"t": 1, "effects": [{"id": 1, "owner": 0, "radius": 2, "positions": [(10, 20)]}]})
    assert acc.result(True)["effects"][0]["owner"] == "neutral"


def test_unknown_owner_effects_union_both_perspectives_but_keep_separate_casts():
    effect = {"id": 1, "name": "PsiStormPersistent", "owner": "neutral", "x": 10, "y": 20,
              "radius": 2, "t": 1, "end": 3}
    effects = exporter.merge_observed_effects([{"effects": [effect]}, {"effects": [
        {**effect, "t": 2, "end": 4}, {**effect, "t": 6, "end": 7}]}])
    assert [(row["t"], row["end"]) for row in effects] == [(1, 4), (6, 7)]
    assert effect["end"] == 3


def test_proto_adapter_uses_global_feature_creep_and_flips_y():
    creep = SimpleNamespace(size=SimpleNamespace(x=4, y=2), bits_per_pixel=1, data=bytes([0b10000001]))
    observation = SimpleNamespace(game_loop=224, raw_data=SimpleNamespace(units=[], effects=[],
        event=SimpleNamespace(dead_units=[]), map_state=SimpleNamespace(creep=SimpleNamespace(data=b""))),
        feature_layer_data=SimpleNamespace(minimap_renders=SimpleNamespace(creep=creep)))
    frame = exporter._frame_from_proto(observation)
    assert frame["t"] == 10
    assert exporter.encode_bit_runs(frame["creep"]["data"], 4, 2) == [3, 2]


def test_participant_proto_adapter_never_accesses_unused_feature_images():
    # Deliberately omit feature_layer_data. Raw units, cooldowns, deaths and
    # effects remain sufficient when the expensive feature renderer is off.
    target = SimpleNamespace(tag=2, owner=2, unit_type=1, display_type=1,
        pos=SimpleNamespace(x=30, y=40), weapon_cooldown=0, engaged_target_tag=0,
        HasField=lambda name: name == "weapon_cooldown")
    attacker = SimpleNamespace(tag=1, owner=1, unit_type=1, display_type=1,
        pos=SimpleNamespace(x=20, y=30), weapon_cooldown=15, engaged_target_tag=2,
        HasField=lambda name: name == "weapon_cooldown")
    observation = SimpleNamespace(game_loop=224, raw_data=SimpleNamespace(
        units=[attacker, target], event=SimpleNamespace(dead_units=[3]),
        effects=[SimpleNamespace(effect_id=11, owner=1, radius=.5, pos=[SimpleNamespace(x=30, y=40)])]))
    frame = exporter._frame_from_proto(observation, capture_creep=False)
    assert frame["creep"] is None
    assert frame["units"][0]["weapon_cooldown"] == 15
    assert frame["units"][0]["target_position"] == (30, 40)
    assert frame["dead_units"] == ["3"]
    assert frame["effects"] == [{"id": 11, "owner": 1, "radius": .5, "positions": [(30, 40)]}]


def test_global_creep_adapter_never_decodes_unused_unit_or_effect_channels():
    # No raw_data member: the Everyone pass needs just the global bitmap.
    creep = SimpleNamespace(size=SimpleNamespace(x=4, y=2), bits_per_pixel=1, data=bytes([0b10000001]))
    observation = SimpleNamespace(game_loop=224,
        feature_layer_data=SimpleNamespace(minimap_renders=SimpleNamespace(creep=creep)))
    frame = exporter._frame_from_proto(observation, capture_entities=False)
    assert exporter.encode_bit_runs(frame["creep"]["data"], 4, 2) == [3, 2]
    assert frame["units"] == frame["effects"] == frame["dead_units"] == []


def test_ownership_departure_closes_life_and_can_return_under_same_tag():
    acc = accumulator()
    tag = unit()["tag"]
    acc.observe({"t": 0, "units": [unit()]})
    acc.observe({"t": 5, "departed_tags": [tag], "units": []})
    acc.observe({"t": 10, "units": [unit(x=40)]})
    lives = acc.result(True)["my_units"]
    assert [(life["born"], life["died"]) for life in lives] == [(0, 5), (10, None)]
    assert lives[0]["killer_pid"] is None


def test_attacks_require_positive_cooldown_reset_and_capture_only_observed_aim():
    acc = accumulator()
    for t, cooldown, target in [(0, -0.4, None), (0.2, 0, None), (0.4, 15, (25, 30)),
                                (0.6, 11, (26, 31)), (0.8, 7, None), (1.0, 14, None)]:
        acc.observe({"t": t, "units": [{**unit(), "weapon_cooldown": cooldown,
                                        "target_position": target}]})
    result = acc.result(True)
    assert result["my_units"][0]["attacks"] == [0.4, 1.0]
    assert result["my_units"][0]["aim"] == [0.4, 25, 30]
    assert result["fidelity"]["attacks"] == "observed"


def test_missing_weapon_data_cargo_and_large_sampling_gaps_do_not_invent_shots():
    acc = accumulator()
    acc.observe({"t": 0, "units": [{**unit(), "weapon_cooldown": 0}]})
    acc.observe({"t": 0.2, "units": []})
    acc.observe({"t": 0.4, "units": [{**unit(), "weapon_cooldown": 10}]})
    acc.observe({"t": 0.6, "units": [unit()]})
    acc.observe({"t": 0.8, "units": [{**unit(), "weapon_cooldown": 20}]})
    acc.observe({"t": 5, "units": [{**unit(), "weapon_cooldown": 30}]})
    assert "attacks" not in acc.result(True)["my_units"][0]


def test_weapon_structures_use_same_observed_attack_channel():
    acc = accumulator()
    acc.observe({"t": 0, "units": [{**unit(unit_type=2), "weapon_cooldown": 0}]})
    acc.observe({"t": 0.2, "units": [{**unit(unit_type=2), "weapon_cooldown": 18}]})
    assert acc.result(True)["my_buildings"][0]["attacks"] == [0.2]


def test_type_change_and_first_positive_sample_do_not_count_as_weapon_shots():
    acc = accumulator()
    acc.observe({"t": 0, "units": [{**unit(unit_type=2), "weapon_cooldown": 20}]})
    acc.observe({"t": 0.2, "units": [{**unit(unit_type=3), "weapon_cooldown": 30}]})
    assert "attacks" not in acc.result(True)["my_buildings"][0]


def test_proto_attack_target_requires_visible_current_target_not_snapshot():
    def proto_unit(tag, owner, display_type=1):
        return SimpleNamespace(tag=tag, owner=owner, unit_type=1, display_type=display_type,
            pos=SimpleNamespace(x=tag * 10, y=20), weapon_cooldown=15, engaged_target_tag=2,
            HasField=lambda name: name == "weapon_cooldown")
    attacker, target = proto_unit(1, 1), proto_unit(2, 2)
    creep = SimpleNamespace(data=b"")
    observation = SimpleNamespace(game_loop=224, raw_data=SimpleNamespace(units=[attacker, target], effects=[],
        event=SimpleNamespace(dead_units=[])),
        feature_layer_data=SimpleNamespace(minimap_renders=SimpleNamespace(creep=creep)))
    frame = exporter._frame_from_proto(observation)
    assert frame["units"][0]["weapon_cooldown"] == 15
    assert frame["units"][0]["target_position"] == (20, 20)
    target.display_type = 2
    assert "target_position" not in exporter._frame_from_proto(observation)["units"][0]


def test_creep_stores_changed_masks_including_clear_frame():
    acc = accumulator()
    def creep(data):
        return {"width": 4, "height": 2, "bits_per_pixel": 1, "data": data}
    acc.observe({"t": 0, "creep": creep(b"\x80")})
    acc.observe({"t": 1, "creep": creep(b"\x80")})
    acc.observe({"t": 2, "creep": creep(b"\x00")})
    assert acc.result(True)["creep"]["frames"] == [{"t": 0, "runs": [0, 1]}, {"t": 2, "runs": []}]
    assert acc.result(False)["fidelity"]["complete"] is False


def artifact_for(replay):
    return {"artifactVersion": 1, "replaySha256": exporter.replay_digest(replay), "myName": "<Team>Player",
        "playback": {"my_units": [{"id": "1", "name": "Marine"}], "opp_units": [], "my_buildings": [], "opp_buildings": [],
        "fidelity": {"positions": "engine", "complete": True}, "creep": {"width": 1, "height": 1, "frames": []}}}


def test_precomputed_merge_requires_matching_bytes_complete_export_and_perspective(tmp_path, monkeypatch):
    monkeypatch.delenv("SC2TOOLS_OBSERVATION_DIR", raising=False)
    replay = tmp_path / "sample.SC2Replay"
    replay.write_bytes(b"replay contents")
    cached = replay.with_name(replay.name + ".observations.json")
    tracker = {"me_name": "Player", "my_units": [], "my_stats": [{"time": 5}]}
    assert exporter.merge_precomputed_engine_playback(tracker, replay, "Player") is tracker
    artifact = artifact_for(replay)
    exporter.write_observation_artifact(artifact, cached)
    merged = exporter.merge_precomputed_engine_playback(tracker, replay, "Player")
    assert merged["my_units"] == [{"id": "1", "name": "Marine"}]
    assert merged["my_stats"] == tracker["my_stats"]
    assert exporter.merge_precomputed_engine_playback({**tracker, "me_name": "Other"}, replay, "Other")["my_units"] == []
    artifact["playback"]["fidelity"]["complete"] = False
    exporter.write_observation_artifact(artifact, cached)
    assert exporter.merge_precomputed_engine_playback(tracker, replay, "Player") is tracker
    artifact["playback"]["fidelity"]["complete"] = True
    exporter.write_observation_artifact(artifact, cached)
    replay.write_bytes(b"changed contents")
    assert exporter.merge_precomputed_engine_playback(tracker, replay, "Player") is tracker


def test_env_cache_is_hash_keyed_and_broken_cache_preserves_tracker(tmp_path, monkeypatch):
    replay = tmp_path / "sample.SC2Replay"
    replay.write_bytes(b"replay")
    cache = tmp_path / "cache"
    monkeypatch.setenv("SC2TOOLS_OBSERVATION_DIR", str(cache))
    tracker = {"me_name": "Player"}
    output = cache / (exporter.replay_digest(replay) + ".json")
    exporter.write_observation_artifact(artifact_for(replay), output)
    assert exporter.merge_precomputed_engine_playback(tracker, replay, "Player")["fidelity"]["positions"] == "engine"
    output.write_text("broken json", encoding="utf-8")
    assert exporter.merge_precomputed_engine_playback(tracker, replay, "Player") is tracker


def test_export_separates_participant_effects_from_global_everyone_creep(tmp_path, monkeypatch):
    """Neither Everyone effects nor participant creep can be trusted as global."""
    import sc2reader
    replay_path = tmp_path / "game.SC2Replay"
    replay_path.write_bytes(b"replay")
    binary = "SC2_x64.exe" if exporter.os.name == "nt" else "SC2_x64"
    executable = tmp_path / "Versions" / "Base100" / binary
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b"fake")
    version = "A" * 32
    metadata = {"BaseBuild": "Base100", "DataVersion": version, "Players": [{"PlayerID": 1}, {"PlayerID": 2}]}
    monkeypatch.setattr(sc2reader, "load_replay", lambda *_args, **_kwargs: SimpleNamespace(
        archive=SimpleNamespace(read_file=lambda _name: json.dumps(metadata).encode()),
        raw_data={"replay.initData": {"game_description": {"map_size_x": 2, "map_size_y": 2}}}))
    # Optional protocol wheels are unnecessary for this transport-free test.
    monkeypatch.setitem(sys.modules, "s2clientprotocol", SimpleNamespace(data_pb2=SimpleNamespace(Structure=8),
        sc2api_pb2=SimpleNamespace(InterfaceOptions=lambda **kwargs: kwargs, SpatialCameraSetup=lambda **kwargs: kwargs)))
    perspectives = []

    class FakeEngine:
        def __init__(self, *_args):
            self.loop = 0
            self.pid = None

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def request(self, kind, **kwargs):
            if kind == "ping":
                return SimpleNamespace(base_build=100, data_version=version)
            if kind == "replay_info":
                return SimpleNamespace(player_info=[SimpleNamespace(player_info=SimpleNamespace(player_id=pid,
                    player_name=f"Player{pid}")) for pid in (1, 2)], game_duration_loops=4, game_duration_seconds=4 / 22.4)
            if kind == "start_replay":
                self.pid = kwargs["observed_player_id"]
                perspectives.append(self.pid)
                assert self.pid in (0, 1, 2)
                assert kwargs["disable_fog"] is True
                assert kwargs["options"]["raw"] is True
                if self.pid == 0:
                    assert "feature_layer" in kwargs["options"]
                else:
                    assert "feature_layer" not in kwargs["options"]
                    assert kwargs["options"]["score"] is False
                return None
            if kind == "game_info":
                return SimpleNamespace(map_name="Test map", start_raw=SimpleNamespace(map_size=SimpleNamespace(x=2, y=2),
                    playable_area=SimpleNamespace(p0=SimpleNamespace(x=0, y=0), p1=SimpleNamespace(x=2, y=2))))
            if kind == "data":
                return SimpleNamespace(units=[SimpleNamespace(unit_id=1, name="Marine", attributes=[])],
                    effects=[SimpleNamespace(effect_id=1, name="PsiStormPersistent")])
            if kind == "observation":
                frame = {"t": self.loop / 22.4, "units": [unit(tag=str(pid), owner=pid,
                    display_type=1 if pid == self.pid else 2) for pid in (1, 2)],
                    "effects": [{"id": 1, "owner": pid, "radius": 2, "positions": [(pid, 0)]} for pid in (1, 2)],
                    "creep": {"width": 2, "height": 2, "data": b"\x80" if self.pid == 0 else b"\x00"}}
                if self.pid == 0:
                    frame["effects"] = []
                return SimpleNamespace(observation=SimpleNamespace(game_loop=self.loop, frame=frame),
                    player_result=[1] if self.loop >= 4 else [])
            if kind == "step":
                self.loop += kwargs["count"]
                return None
            raise AssertionError(kind)

    monkeypatch.setattr(exporter, "_Engine", FakeEngine)
    def adapt_frame(observation, *, capture_creep=True, capture_entities=True):
        if len(perspectives) < 3:
            assert capture_creep is False and capture_entities is True
        else:
            assert capture_creep is True and capture_entities is False
        return observation.frame

    monkeypatch.setattr(exporter, "_frame_from_proto", adapt_frame)
    artifact = exporter.export_engine_observations(replay_path, 2, sc2_path=tmp_path)
    result = artifact["playback"]
    assert perspectives == [2, 1, 0]
    assert [record["id"] for record in result["my_units"]] == ["2"]
    assert [record["id"] for record in result["opp_units"]] == ["1"]
    assert sorted(effect["owner"] for effect in result["effects"]) == ["me", "opp"]
    assert result["fidelity"]["effects"] == "observed"
    assert result["fidelity"]["complete"] is True
    assert result["creep"]["frames"] == [{"t": 0, "runs": [0, 1]}]
