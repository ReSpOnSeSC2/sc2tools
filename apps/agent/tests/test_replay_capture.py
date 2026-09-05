from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from sc2tools_agent import replay_pipeline
from sc2tools_agent.replay_capture import capture_exact_replay, wait_for_replay_upload


def setup_capture(monkeypatch, *, complete=True, me=None):
    parser = SimpleNamespace(parse_deep=Mock(return_value=SimpleNamespace(me=me, all_players=[])))
    artifact = {"playback": {"fidelity": {"complete": complete}}}
    exporter = SimpleNamespace(
        export_engine_observations=Mock(return_value=artifact),
        replay_digest=Mock(return_value="abc123"),
        write_observation_artifact=Mock(side_effect=lambda _artifact, output: output),
    )
    monkeypatch.setattr(replay_pipeline, "_load_sc2ra_package_module", lambda name: parser if name == "sc2_replay_parser" else exporter)
    monkeypatch.setattr(replay_pipeline, "_read_player_handle", lambda _state: "PlayerTwo")
    monkeypatch.setattr(replay_pipeline, "_toon_handle_from_path", lambda _path: None)
    monkeypatch.delenv("SC2TOOLS_OBSERVATION_DIR", raising=False)
    return parser, exporter


def test_capture_uses_upload_perspective_and_process_visible_sidecar(monkeypatch, tmp_path):
    parser, exporter = setup_capture(monkeypatch, me=SimpleNamespace(pid=2, name="PlayerTwo"))
    replay = tmp_path / "game.SC2Replay"
    output = capture_exact_replay(replay, tmp_path)
    parser.parse_deep.assert_called_once_with(str(replay), "PlayerTwo")
    exporter.export_engine_observations.assert_called_once_with(replay, 2, progress=None)
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


@pytest.mark.parametrize("marker,match", [
    ("rejected", "server rejected"), ("filtered", "date filter"),
    ("skipped:parse_failed", "could not parse"),
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
