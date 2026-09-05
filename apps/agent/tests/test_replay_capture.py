import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from sc2tools_agent import replay_pipeline, replay_capture
from sc2tools_agent.replay_capture import capture_exact_replay, wait_for_replay_upload


def setup_capture(monkeypatch, *, complete=True, me=None):
    metadata = {"BaseBuild": "Base97563", "DataVersion": "F364D7C8BB1A0444ABC9BEE547B3FBB3"}
    parser = SimpleNamespace(parse_deep=Mock(return_value=SimpleNamespace(me=me, all_players=[],
        raw=SimpleNamespace(archive=SimpleNamespace(read_file=lambda _: json.dumps(metadata))))))
    artifact = {"playback": {"fidelity": {"complete": complete}}}
    exporter = SimpleNamespace(
        ARTIFACT_VERSION=1, MAX_ARTIFACT_BYTES=128 * 1024 * 1024,
        export_engine_observations=Mock(return_value=artifact),
        replay_digest=Mock(return_value="abc123"),
        write_observation_artifact=Mock(side_effect=lambda _artifact, output: output),
    )
    monkeypatch.setattr(replay_pipeline, "_load_sc2ra_package_module", lambda name: parser if name == "sc2_replay_parser" else exporter)
    monkeypatch.setattr(replay_pipeline, "_read_player_handle", lambda _state: "PlayerTwo")
    monkeypatch.setattr(replay_pipeline, "_toon_handle_from_path", lambda _path: None)
    monkeypatch.delenv("SC2TOOLS_OBSERVATION_DIR", raising=False)
    monkeypatch.setattr(replay_capture, "replay_capture_enabled", lambda _state: True)
    return parser, exporter


def test_capture_uses_upload_perspective_and_process_visible_sidecar(monkeypatch, tmp_path):
    parser, exporter = setup_capture(monkeypatch, me=SimpleNamespace(pid=2, name="PlayerTwo"))
    replay = tmp_path / "game.SC2Replay"
    output = capture_exact_replay(replay, tmp_path)
    parser.parse_deep.assert_called_once_with(str(replay), "PlayerTwo")
    assert exporter.export_engine_observations.call_args.args == (replay, 2)
    assert exporter.export_engine_observations.call_args.kwargs["progress"] is None
    assert exporter.export_engine_observations.call_args.kwargs["cancel_requested"]() is False
    assert output == tmp_path / "game.SC2Replay.observations.json"


def test_capture_never_caches_partial_or_unknown_perspective(monkeypatch, tmp_path):
    _parser, exporter = setup_capture(monkeypatch, complete=False, me=SimpleNamespace(pid=1))
    with pytest.raises(ValueError, match="end of the game"):
        capture_exact_replay(tmp_path / "partial.SC2Replay", tmp_path)
    exporter.write_observation_artifact.assert_not_called()
    _parser, exporter = setup_capture(monkeypatch)
    with pytest.raises(ValueError, match="player name"):
        capture_exact_replay(tmp_path / "unknown.SC2Replay", tmp_path)
    exporter.export_engine_observations.assert_not_called()


def saved_recording():
    return {
        "artifactVersion": 1, "replaySha256": "abc123", "myPid": 2,
        "baseBuild": 97563, "dataVersion": "F364D7C8BB1A0444ABC9BEE547B3FBB3",
        "playback": {
            "fidelity": {"complete": True, "positions": "engine", "attacks": "observed",
                         "paths": "observed", "effects": "observed", "creep": "observed", "sampleSeconds": 0.1786},
            "my_units": [], "opp_units": [], "my_buildings": [], "opp_buildings": [],
            "effects": [], "creep": {"frames": []},
        },
    }


@pytest.mark.parametrize("location", ["adjacent", "cache"])
def test_recompute_reuses_complete_matching_recording_without_launching_sc2(monkeypatch, tmp_path, location):
    import hashlib
    _parser, exporter = setup_capture(monkeypatch, me=SimpleNamespace(pid=2))
    monkeypatch.setattr(replay_capture, "replay_capture_enabled", lambda _state: False)
    replay = tmp_path / "game.SC2Replay"
    replay.write_bytes(b"saved replay bytes")
    digest = hashlib.sha256(replay.read_bytes()).hexdigest()
    exporter.replay_digest.return_value = digest
    artifact = saved_recording()
    artifact["replaySha256"] = digest
    output = replay.with_name(replay.name + ".observations.json")
    source = output if location == "adjacent" else tmp_path / "replay-observations" / f"{digest}.json"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text(json.dumps(artifact), encoding="utf-8")
    progress = Mock()
    notice = Mock()
    assert replay_capture.capture_request_allowed(replay, tmp_path) is True
    assert capture_exact_replay(replay, tmp_path, progress, notify_start=notice) == output
    notice.assert_not_called()
    exporter.export_engine_observations.assert_not_called()
    assert all(call.args[0] == artifact for call in exporter.write_observation_artifact.call_args_list)
    progress.assert_called_once_with("Using the complete saved recording; StarCraft does not need to start again.")


@pytest.mark.parametrize("invalid", ["hash", "perspective", "version", "base", "data", "partial", "attacks", "effects",
                                      "creep", "paths", "sparse", "boolean_sample", "compacted", "malformed", "oversized"])
def test_recompute_recaptures_incompatible_recordings(monkeypatch, tmp_path, invalid):
    _parser, exporter = setup_capture(monkeypatch, me=SimpleNamespace(pid=2))
    replay = tmp_path / "game.SC2Replay"
    artifact = saved_recording()
    if invalid in ("hash", "perspective", "version", "base", "data"):
        artifact[{"hash": "replaySha256", "perspective": "myPid", "version": "artifactVersion",
                  "base": "baseBuild", "data": "dataVersion"}[invalid]] = "wrong"
    elif invalid == "partial":
        artifact["playback"]["fidelity"]["complete"] = False
    elif invalid in ("attacks", "effects", "creep", "paths"):
        artifact["playback"]["fidelity"][invalid] = "unavailable"
    elif invalid == "sparse":
        artifact["playback"]["fidelity"]["sampleSeconds"] = 1
    elif invalid == "boolean_sample":
        artifact["playback"]["fidelity"]["sampleSeconds"] = True
    elif invalid == "compacted":
        artifact["playback"]["fidelity"]["positionError"] = 0.35
    elif invalid == "oversized":
        exporter.MAX_ARTIFACT_BYTES = 16
    encoded = "invalid JSON" if invalid == "malformed" else json.dumps(artifact)
    replay.with_name(replay.name + ".observations.json").write_text(encoded, encoding="utf-8")
    capture_exact_replay(replay, tmp_path)
    exporter.export_engine_observations.assert_called_once()
    assert exporter.export_engine_observations.call_args.args == (replay, 2)


@pytest.mark.parametrize("enabled", [None, False, "true", 1, [], {}])
def test_runtime_permission_is_explicit_true_only(monkeypatch, tmp_path, enabled):
    from sc2tools_agent import state
    monkeypatch.setattr(state, "load_state", lambda _: SimpleNamespace(replay_capture_enabled=enabled))
    assert replay_capture.replay_capture_enabled(tmp_path) is False
    assert replay_capture.replay_capture_enabled(None) is False


def test_runtime_permission_tracks_durable_state_and_fails_closed(monkeypatch, tmp_path):
    from sc2tools_agent import state
    current = SimpleNamespace(replay_capture_enabled=True)
    monkeypatch.setattr(state, "load_state", lambda _: current)
    assert replay_capture.replay_capture_enabled(tmp_path) is True
    current.replay_capture_enabled = False
    assert replay_capture.replay_capture_enabled(tmp_path) is False
    monkeypatch.setattr(state, "load_state", Mock(side_effect=OSError("unreadable state")))
    assert replay_capture.replay_capture_enabled(tmp_path) is False


def test_disabled_request_never_launches_or_writes_new_artifact(monkeypatch, tmp_path):
    _parser, exporter = setup_capture(monkeypatch, me=SimpleNamespace(pid=2))
    monkeypatch.setattr(replay_capture, "replay_capture_enabled", lambda _: False)
    replay = tmp_path / "game.SC2Replay"
    assert replay_capture.capture_request_allowed(replay, tmp_path) is False
    notice = Mock()
    with pytest.raises(replay_capture.ReplayCaptureDisabled, match="Settings > Map replay"):
        capture_exact_replay(replay, tmp_path, notify_start=notice)
    exporter.export_engine_observations.assert_not_called()
    exporter.write_observation_artifact.assert_not_called()
    notice.assert_not_called()


def test_new_capture_warns_before_start_and_rechecks_opt_in(monkeypatch, tmp_path):
    _parser, exporter = setup_capture(monkeypatch, me=SimpleNamespace(pid=2))
    enabled, events = [True], []
    monkeypatch.setattr(replay_capture, "replay_capture_enabled", lambda _: enabled[0])
    def notice(message):
        events.append(message)
        enabled[0] = False
    with pytest.raises(replay_capture.ReplayCaptureDisabled):
        capture_exact_replay(tmp_path / "game.SC2Replay", tmp_path, progress=events.append, notify_start=notice)
    assert events == [replay_capture.CAPTURE_START_NOTICE] * 2
    assert "CPU" in events[0]
    exporter.export_engine_observations.assert_not_called()


def test_capture_cancellation_reports_disabled_and_preserves_previous_recording(monkeypatch, tmp_path):
    _parser, exporter = setup_capture(monkeypatch, me=SimpleNamespace(pid=2))
    enabled, events = [True], []
    monkeypatch.setattr(replay_capture, "replay_capture_enabled", lambda _: enabled[0])
    def capture(_path, _pid, *, progress, cancel_requested):
        assert events == [replay_capture.CAPTURE_START_NOTICE]
        enabled[0] = False
        assert cancel_requested() is True
        raise RuntimeError("owned engine stopped")
    exporter.export_engine_observations.side_effect = capture
    with pytest.raises(replay_capture.ReplayCaptureDisabled, match="previous playback was preserved"):
        capture_exact_replay(tmp_path / "game.SC2Replay", tmp_path, notify_start=events.append)
    exporter.write_observation_artifact.assert_not_called()


def test_dispatch_cache_hint_does_not_authorize_an_invalid_recording(monkeypatch, tmp_path):
    _parser, exporter = setup_capture(monkeypatch, me=SimpleNamespace(pid=2))
    monkeypatch.setattr(replay_capture, "replay_capture_enabled", lambda _: False)
    replay = tmp_path / "game.SC2Replay"
    replay.with_name(replay.name + ".observations.json").write_text("not a recording", encoding="utf-8")
    assert replay_capture.capture_request_allowed(replay, tmp_path) is True
    with pytest.raises(replay_capture.ReplayCaptureDisabled):
        capture_exact_replay(replay, tmp_path)
    exporter.export_engine_observations.assert_not_called()


def test_cancellation_reloads_large_state_only_after_file_changes(monkeypatch, tmp_path):
    _parser, exporter = setup_capture(monkeypatch, me=SimpleNamespace(pid=2))
    permission = Mock(return_value=True)
    monkeypatch.setattr(replay_capture, "replay_capture_enabled", permission)
    clock = [0.0]
    monkeypatch.setattr(replay_capture.time, "monotonic", lambda: clock[0])
    state_file = tmp_path / "agent.json"
    state_file.write_text("initial", encoding="utf-8")
    def capture(_path, _pid, *, progress, cancel_requested):
        before = permission.call_count
        assert cancel_requested() is False
        assert permission.call_count == before + 1
        clock[0] = 2.0
        assert cancel_requested() is False
        assert permission.call_count == before + 1
        state_file.write_text("changed state", encoding="utf-8")
        permission.return_value = False
        clock[0] = 4.0
        assert cancel_requested() is True
        assert permission.call_count == before + 2
        raise RuntimeError("owned engine stopped")
    exporter.export_engine_observations.side_effect = capture
    with pytest.raises(replay_capture.ReplayCaptureDisabled):
        capture_exact_replay(tmp_path / "game.SC2Replay", tmp_path)
    exporter.write_observation_artifact.assert_not_called()


@pytest.mark.parametrize("digest", ["a" * 64, "invalid", None])
def test_compactor_retains_only_valid_source_hash(digest):
    raw = {"bounds": {"x_min": 0, "x_max": 10, "y_min": 0, "y_max": 10}, "replaySha256": digest,
           "my_units": [{"name": "Probe", "born": 0, "died": None, "waypoints": [0, 1, 1]}]}
    compact = replay_pipeline._compact_map_playback(raw)
    assert compact.get("replaySha256") == (digest if digest == "a" * 64 else None)


@pytest.mark.parametrize("marker,match", [
    ("rejected", "server rejected"), ("filtered", "date filter"),
    ("skipped:parse_failed", "could not parse"),
    ("skipped:playback_budget_exceeded", "upload capacity for accurate playback"),
])
def test_upload_monitor_reports_terminal_outcomes_immediately(monkeypatch, tmp_path, marker, match):
    from sc2tools_agent import state
    path = tmp_path / "game.SC2Replay"
    monkeypatch.setattr(state, "load_state", lambda _dir: SimpleNamespace(paused=False, uploaded={str(path): marker}))
    with pytest.raises(RuntimeError, match=match):
        wait_for_replay_upload(path, tmp_path, "old-upload", poll_seconds=0)


def test_upload_monitor_requires_a_fresh_success_and_bounds_waiting(monkeypatch, tmp_path):
    from sc2tools_agent import state
    path = tmp_path / "game.SC2Replay"
    monkeypatch.setattr(state, "load_state", lambda _dir: SimpleNamespace(paused=False, uploaded={str(path): "2026-09-05T08:00:00Z"}))
    wait_for_replay_upload(path, tmp_path, "2026-09-04T08:00:00Z")
    with pytest.raises(TimeoutError, match="upload has not completed"):
        wait_for_replay_upload(path, tmp_path, "2026-09-05T08:00:00Z", timeout_seconds=0)


@pytest.mark.parametrize("parse_mode", ["thread", "process_result"])
def test_upload_budget_failure_is_durable_and_reaches_recording_status(monkeypatch, tmp_path, parse_mode):
    """An isolated skipped replay has no successful upload to save its state."""
    import threading
    from concurrent.futures import Future
    from sc2tools_agent import watcher as watcher_module
    from sc2tools_agent.config import AgentConfig
    from sc2tools_agent.socket_client import make_recompute_handlers
    from sc2tools_agent.state import AgentState, load_state, save_state

    replay = tmp_path / "large.SC2Replay"
    replay.write_bytes(b"original replay")
    recording = replay.with_name(replay.name + ".observations.json")
    recording.write_bytes(b"preserved complete engine recording")
    state = AgentState(uploaded={str(replay): "previous-upload"}, replay_capture_enabled=True,
                       path_by_game_id={"large": str(replay)})
    save_state(tmp_path, state)
    monkeypatch.setenv("SC2TOOLS_PARSE_USE_PROCESSES", "0")
    monkeypatch.setattr(watcher_module, "_wait_for_file_ready", lambda *_args: True)
    monkeypatch.setattr(watcher_module, "parse_replay_for_cloud_ex",
                        lambda *_args, **_kwargs: (None, "playback_budget_exceeded"))
    upload = SimpleNamespace(submit=Mock(), is_pending=lambda _path: False)
    watcher = watcher_module.ReplayWatcher(
        cfg=AgentConfig(api_base="http://localhost:0", state_dir=tmp_path,
                        replay_folder=None, poll_interval_sec=10, parse_concurrency=1),
        state=state, upload=upload,
    )
    monkeypatch.setattr(watcher, "_drain_history_inventory", lambda: None)
    failed = threading.Event()
    updates = []

    def queue(paths):
        assert paths == [replay]
        state.uploaded.pop(str(replay), None)
        save_state(tmp_path, state)
        if parse_mode == "thread":
            watcher._handle_replay(replay)
        else:
            result = Future()
            result.set_result(("skipped", str(replay), "playback_budget_exceeded"))
            watcher._on_worker_done(result, str(replay))

    def status(update):
        updates.append(update)
        if update["status"] == "failed":
            failed.set()

    try:
        on_macro, _, _ = make_recompute_handlers(
            state_dir=tmp_path, engine_capture=lambda _path: None,
            queue_resync_for_paths=queue,
        )
        assert on_macro(["large"], replay_fidelity="engine", report_status=status)["ok"]
        assert failed.wait(2), "A terminal size rejection must not wait for the upload timeout"
        assert [update["status"] for update in updates] == ["processing", "uploading", "failed"]
        assert updates[-1]["code"] == "replay_upload_failed"
        assert "upload capacity for accurate playback" in updates[-1]["message"]
        assert "recording and previous playback were preserved" in updates[-1]["message"]
        assert "repeating the recording will not fix" in updates[-1]["message"]
        assert load_state(tmp_path).uploaded[str(replay)] == "skipped:playback_budget_exceeded"
        upload.submit.assert_not_called()
        assert recording.read_bytes() == b"preserved complete engine recording"
        assert replay.read_bytes() == b"original replay"
    finally:
        watcher.stop()


def test_shipped_protocol_runtime_roundtrips_observation_requests():
    # Smoke the generated protobuf/runtime compatibility used by the frozen
    # exporter. New incompatible protobuf major versions fail at import.
    from s2clientprotocol import sc2api_pb2, raw_pb2
    import websocket
    request = sc2api_pb2.Request()
    request.start_replay.observed_player_id = 1
    request.start_replay.options.raw = True
    decoded = sc2api_pb2.Request.FromString(request.SerializeToString())
    assert decoded.start_replay.options.raw is True
    assert raw_pb2.Effect(effect_id=1, radius=1.5).radius == 1.5
    assert callable(websocket.create_connection)
