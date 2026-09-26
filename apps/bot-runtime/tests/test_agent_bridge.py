from types import SimpleNamespace

from pluto_sc2.agent_bridge import handle, public_session


def test_public_session_never_exposes_local_process_paths_or_error_details():
    result = public_session({"session_id": "a" * 32, "status": "failed", "pid": 123,
                             "source_checkpoint": "C:/private", "error": "secret-token"})
    assert result["id"] == "a" * 32
    assert "secret" not in str(result) and "private" not in str(result) and "pid" not in result


def test_busy_or_stopped_engine_cannot_launch(tmp_path):
    calls = []
    lobby = SimpleNamespace(root=tmp_path / "runs/human-matches", launch=lambda *args, **kwargs: calls.append(args))
    request = dict(operation="start", workspace=str(tmp_path), sessionId="a" * 32,
                   botId="b" * 24, mapId="c" * 24, humanRace="Protoss")
    result = handle(request, lobby_factory=lambda path: lobby, active_check=lambda: True)
    assert result["code"] == "sc2_busy" and calls == []
    (tmp_path / "STOP").touch()
    assert handle(request, lobby_factory=lambda path: lobby, active_check=lambda: False)["code"] == "stop_marker"


def test_existing_internal_session_reconciles_without_new_launch(tmp_path):
    root = tmp_path / "runs/human-matches"
    (root / ("a" * 32)).mkdir(parents=True)
    lobby = SimpleNamespace(root=root, status=lambda key: {"session_id": key, "status": "playing"})
    request = dict(operation="start", workspace=str(tmp_path), sessionId="a" * 32,
                   botId="b" * 24, mapId="c" * 24, humanRace="Protoss")
    assert handle(request, lobby_factory=lambda path: lobby, active_check=lambda: True)["session"]["status"] == "playing"
