"""Human matches can use only frozen, committed, local checkpoints."""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import threading
import time
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import psutil
import pytest

from pluto_sc2 import play_lobby as play
from pluto_sc2.replay_browser import Catalogue, ReplayServer


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


@pytest.fixture
def lobby(tmp_path):
    league = tmp_path / "runs/response-league"
    snapshots = {}
    for race in play.RACES:
        snapshots[race] = []
        for updates in (0, 3):
            path = league / "committed" / f"{race}-{updates}.pt"
            path.parent.mkdir(parents=True, exist_ok=True)
            payload = f"{race} policy version {updates}".encode()
            path.write_bytes(payload)
            snapshots[race].append({"path": str(path.relative_to(league)), "updates": updates,
                                    "sha256": hashlib.sha256(payload).hexdigest()})
    # The file exists but is not committed: it must never become a selectable bot.
    (league / "committed/uncommitted.pt").write_bytes(b"incomplete update")
    write(league / "state.json", {"adversary_max_apm": 450, "snapshots": snapshots})
    map_path = tmp_path / "maps" / "Test map & special ' name.SC2Map"
    map_path.parent.mkdir()
    map_path.write_bytes(b"map")
    write(tmp_path / "runs/response-league-monitor/config.json", {"maps": [str(map_path), str(map_path)]})
    return play.PlayLobby(tmp_path)


@pytest.fixture
def launched(monkeypatch):
    calls = []
    process = psutil.Process()
    monkeypatch.setattr(play.subprocess, "Popen", lambda args, **kwargs:
                        calls.append((args, kwargs)) or SimpleNamespace(pid=process.pid))
    return calls


def selection(lobby, race="Protoss"):
    choices = lobby.options()
    bot = next(bot for bot in choices["bots"] if bot["race"] == race)
    return {"human_race": "Protoss", "bot_id": bot["id"], "map_id": choices["maps"][0]["id"]}


def manifest(lobby):
    return lobby.workspace / "runs/response-league/state.json"


def test_catalogue_lists_committed_history_latest_and_per_race_limits(lobby):
    before = {path: path.read_bytes() for path in lobby.workspace.rglob("*") if path.is_file()}
    result = lobby.options()
    assert len(result["bots"]) == 6
    for race in play.RACES:
        rows = [row for row in result["bots"] if row["race"] == race]
        assert [row["updates"] for row in rows] == [3, 0]
        assert [row["latest"] for row in rows] == [True, False]
        assert all(row["max_apm"] == (200 if race == "Protoss" else 450) for row in rows)
        assert all(row["camera_restricted"] == (race == "Protoss") for row in rows)
    assert len(result["maps"]) == 1
    assert result["start_workers"] == 8
    assert result["active_session_id"] is None
    assert before == {path: path.read_bytes() for path in lobby.workspace.rglob("*") if path.is_file()}


def test_internal_session_retry_reuses_durable_reservation(lobby, launched):
    request = selection(lobby)
    first = lobby.launch(request, session_id="a" * 32)
    second = lobby.launch(request, session_id="a" * 32)
    assert first["session_id"] == second["session_id"] == "a" * 32
    assert len(launched) == 1


@pytest.mark.parametrize("session_id", ["../outside", "A" * 32, "a" * 31, 0])
def test_internal_session_identity_is_strict(lobby, launched, session_id):
    with pytest.raises(ValueError, match="Internal session"):
        lobby.launch(selection(lobby), session_id=session_id)
    assert launched == []


def test_missing_latest_does_not_mislabel_older_checkpoint_as_latest(lobby):
    path = manifest(lobby)
    state = json.loads(path.read_text())
    state["snapshots"]["Protoss"].append({"path": "missing.pt", "updates": 4, "sha256": "a" * 64})
    write(path, state)
    rows = [row for row in lobby.options()["bots"] if row["race"] == "Protoss"]
    assert rows[0]["updates"] == 3
    assert rows[0]["latest"] is False


@pytest.mark.parametrize("invalid", [0, 601, True, "600", None])
def test_invalid_adversary_cap_never_becomes_launch_option(lobby, invalid):
    path = manifest(lobby)
    state = json.loads(path.read_text())
    state["adversary_max_apm"] = invalid
    write(path, state)
    with pytest.raises(ValueError, match="APM"):
        lobby.options()


@pytest.mark.parametrize("entry", [None, {"path": "committed/Protoss-3.pt", "sha256": "bad", "updates": 4},
                                 {"path": "committed/Protoss-3.pt", "sha256": "a" * 64, "updates": -1},
                                 {"path": "committed/Protoss-3.pt", "sha256": "a" * 64, "updates": True}])
def test_invalid_checkpoint_entries_are_not_offered(lobby, entry):
    path = manifest(lobby)
    state = json.loads(path.read_text())
    state["snapshots"]["Protoss"].append(entry)
    write(path, state)
    assert len(lobby.options()["bots"]) == 6


def test_launch_freezes_checkpoint_uses_argument_list_and_never_changes_source(lobby, launched):
    request = selection(lobby, "Terran")
    source = lobby.workspace / "runs/response-league/committed/Terran-3.pt"
    before = {path: path.read_bytes() for path in lobby.workspace.rglob("*") if path.is_file()}
    result = lobby.launch(request)
    output = lobby.folder(result["session_id"])
    assert result["ok"] is True and result["status"] == "starting"
    assert result["start_workers"] == 8
    assert result["bot_race"] == "Terran" and result["max_apm"] == 450
    assert (output / "checkpoint.pt").read_bytes() == source.read_bytes()
    assert result["checkpoint_sha256"] == hashlib.sha256(source.read_bytes()).hexdigest()
    assert all(path.read_bytes() == payload for path, payload in before.items())
    command, options = launched[0]
    assert isinstance(command, list) and command[1:3] == ["-m", "pluto_sc2.human_match"]
    assert command[command.index("--checkpoint") + 1] == str(output / "checkpoint.pt")
    assert command[command.index("--bot-race") + 1] == "Terran"
    assert command[command.index("--human-race") + 1] == "Protoss"
    assert command[command.index("--max-apm") + 1] == "450"
    assert command[command.index("--map") + 1].endswith("Test map & special ' name.SC2Map")
    assert options["shell"] is False and options["cwd"] == str(lobby.workspace)
    assert options["creationflags"] == getattr(play.subprocess, "CREATE_NO_WINDOW", 0)
    assert json.loads((output / "control.json").read_text()) == {"close": False}
    receipt = json.loads((output / "launch.json").read_text())
    assert receipt["pid"] == psutil.Process().pid
    assert receipt["process_created_at"] == psutil.Process().create_time()
    source.write_bytes(b"new subsequent policy")
    assert (output / "checkpoint.pt").read_bytes() == before[source]


@pytest.mark.parametrize("human_race", ["Protoss", "Terran", "Zerg"])
def test_each_human_race_is_forwarded_without_shell_interpretation(lobby, launched, human_race):
    request = selection(lobby)
    request["human_race"] = human_race
    result = lobby.launch(request)
    args = launched[0][0]
    assert result["human_race"] == human_race
    assert args[args.index("--human-race") + 1] == human_race
    assert result["max_apm"] == 200 and result["camera_restricted"] is True


@pytest.mark.parametrize("alter", [{"human_race": "Random"}, {"human_race": "Protoss; exit"},
                                  {"bot_id": "../../uncommitted.pt"}, {"map_id": "../secret.SC2Map"},
                                  {"checkpoint": "arbitrary.pt"}, {"max_apm": 999}])
def test_requests_cannot_supply_paths_caps_or_invalid_races(lobby, launched, alter):
    with pytest.raises(ValueError):
        lobby.launch({**selection(lobby), **alter})
    assert not launched
    assert not list(lobby.root.glob("*/checkpoint.pt"))


def test_modified_committed_checkpoint_is_rejected_before_copy_or_launch(lobby, launched):
    request = selection(lobby)
    (lobby.workspace / "runs/response-league/committed/Protoss-3.pt").write_bytes(b"changed")
    with pytest.raises(ValueError, match="committed bot checkpoint changed"):
        lobby.launch(request)
    assert not launched and not list(lobby.root.glob("*/checkpoint.pt"))


def test_concurrent_change_during_copy_is_rejected_and_recorded(lobby, launched, monkeypatch):
    request = selection(lobby)
    source = lobby.workspace / "runs/response-league/committed/Protoss-3.pt"
    read_bytes = Path.read_bytes

    def changed_copy(path):
        return b"new bytes during copy" if path == source else read_bytes(path)

    monkeypatch.setattr(Path, "read_bytes", changed_copy)
    with pytest.raises(ValueError, match="changed while preparing"):
        lobby.launch(request)
    assert not launched
    folders = list(lobby.root.glob("*/status.json"))
    assert len(folders) == 1 and json.loads(folders[0].read_text())["status"] == "failed"


def test_external_training_manifest_path_is_rejected(lobby):
    write(lobby.workspace / "TRAINING_ACTIVE.json", {"league": "../outside"})
    with pytest.raises(ValueError, match="inside"):
        lobby.options()


@pytest.mark.parametrize("location", ["checkpoint", "map"])
def test_manifest_paths_cannot_escape_workspace(lobby, location):
    if location == "checkpoint":
        path = manifest(lobby)
        state = json.loads(path.read_text())
        state["snapshots"]["Protoss"].append({"path": "../../../outside.pt", "updates": 4, "sha256": "a" * 64})
    else:
        path = lobby.workspace / "runs/response-league-monitor/config.json"
        state = {"maps": ["../outside.SC2Map"]}
    write(path, state)
    with pytest.raises(ValueError, match="inside"):
        lobby.options()


def test_checkpoint_inside_workspace_but_outside_league_is_not_offered(lobby):
    external = lobby.workspace / "elsewhere.pt"
    external.write_bytes(b"not a committed league snapshot")
    path = manifest(lobby)
    state = json.loads(path.read_text())
    state["snapshots"]["Protoss"].append({"path": str(external), "updates": 4, "sha256": play.digest(external)})
    write(path, state)
    assert len(lobby.options()["bots"]) == 6


def test_single_active_match_blocks_duplicate_launch_and_close_is_scoped(lobby, launched):
    request = selection(lobby)
    result = lobby.launch(request)
    identifier = result["session_id"]
    assert lobby.active_session() == identifier
    with pytest.raises(ValueError, match="already open"):
        lobby.launch(request)
    assert len(launched) == 1
    before = manifest(lobby).read_bytes()
    assert lobby.close({"id": identifier, "close": True})["ok"]
    assert json.loads((lobby.folder(identifier) / "control.json").read_text()) == {"close": True}
    assert manifest(lobby).read_bytes() == before
    # A close request isn't proof the child exited: duplicate launch stays blocked.
    with pytest.raises(ValueError, match="already open"):
        lobby.launch(request)


@pytest.mark.parametrize("command", [{"id": "../outside", "close": True}, {"id": "a" * 32, "close": False},
                                    {"id": "a" * 32, "close": "true"},
                                    {"id": "a" * 32, "close": True, "pid": 123}])
def test_end_control_rejects_unknown_paths_and_commands(lobby, command):
    with pytest.raises(ValueError):
        lobby.close(command)


def test_reused_pid_is_failed_and_does_not_block_next_match(lobby, launched):
    result = lobby.launch(selection(lobby))
    folder = lobby.folder(result["session_id"])
    receipt = json.loads((folder / "launch.json").read_text())
    receipt["process_created_at"] -= 100
    write(folder / "launch.json", receipt)
    assert lobby.status(result["session_id"])["status"] == "failed"
    assert lobby.active_session() is None
    result2 = lobby.launch(selection(lobby))
    assert result2["session_id"] != result["session_id"] and len(launched) == 2


@pytest.mark.parametrize("terminal", ["finished", "closed", "failed"])
def test_terminal_match_does_not_block_next_launch(lobby, launched, terminal):
    result = lobby.launch(selection(lobby))
    write(lobby.folder(result["session_id"]) / "status.json", {"status": terminal})
    assert lobby.status(result["session_id"])["status"] == terminal
    assert lobby.active_session() is None


def test_launch_failure_is_terminal_and_retryable(lobby, monkeypatch):
    def denied(*args, **kwargs):
        raise PermissionError("launch denied")

    monkeypatch.setattr(play.subprocess, "Popen", denied)
    with pytest.raises(PermissionError, match="launch denied"):
        lobby.launch(selection(lobby))
    records = list(lobby.root.glob("*/status.json"))
    assert len(records) == 1
    assert json.loads(records[0].read_text()) == {"status": "failed", "error": "launch denied"}
    assert lobby.active_session() is None


@contextmanager
def serving(lobby):
    server = ReplayServer(Catalogue(lobby.workspace, inspector=lambda path: {}))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()


def http(server, route, *, data=None, headers=None):
    return urlopen(Request(server.url + route, data=data, headers=headers or {}), timeout=5)


def test_match_endpoints_require_token_local_host_and_same_origin(lobby, launched):
    with serving(lobby) as server:
        data = json.dumps(selection(lobby)).encode()
        for route in ("api/play", "api/play-control"):
            for headers in ({}, {"X-Replay-Token": "wrong"},
                            {"X-Replay-Token": server.token, "Origin": "https://evil.example"},
                            {"X-Replay-Token": server.token, "Host": "evil.example"},
                            {"X-Replay-Token": server.token, "Sec-Fetch-Site": "cross-site"}):
                with pytest.raises(HTTPError) as error:
                    http(server, route, data=data, headers=headers)
                assert error.value.code == 403
        assert not launched
        with http(server, "api/play", data=data,
                  headers={"X-Replay-Token": server.token, "Origin": server.origin}) as response:
            result = json.load(response)
        assert result["ok"] and len(launched) == 1
        with http(server, "api/play-status?id=" + result["session_id"]) as response:
            assert json.load(response)["status"] == "starting"
        with http(server, "api/play-control", data=json.dumps({"id": result["session_id"], "close": True}).encode(),
                  headers={"X-Replay-Token": server.token}) as response:
            assert json.load(response)["close"] is True


def test_malformed_json_and_wrong_object_shapes_cannot_start_games(lobby, launched):
    with serving(lobby) as server:
        for route in ("api/play", "api/play-control"):
            for body in (b"", b"{broken", b"null", b"true", b"[]", b'"arbitrary"', b"{}", b"x" * 4097):
                with pytest.raises(HTTPError) as error:
                    http(server, route, data=body, headers={"X-Replay-Token": server.token})
                assert error.value.code == 400
        assert not launched


def test_options_and_get_cannot_launch_and_status_is_path_scoped(lobby, launched):
    with serving(lobby) as server:
        with http(server, "api/play-options") as response:
            assert len(json.load(response)["bots"]) == 6
        for route, status in (("api/play", 404), ("api/play-control", 404),
                              ("api/play-status?id=../../state.json", 400)):
            with pytest.raises(HTTPError) as error:
                http(server, route)
            assert error.value.code == status
        with pytest.raises(HTTPError) as error:
            urlopen(server.origin + "/api/play-options", timeout=5)
        assert error.value.code == 404
        assert not launched


def test_human_replay_result_uses_human_player_and_does_not_replace_training_progress(lobby):
    process = psutil.Process()
    live = {"pid": process.pid, "process_created_at": process.create_time()}
    league = lobby.workspace / "runs/response-league"
    league_pending = league / "matches/0000001-active"
    write(league_pending / "viewer.json", {**live, "learner_race": "Protoss", "opponent_race": "Zerg"})
    write(lobby.workspace / "runs/response-league-monitor/state.json", {**live, "status": "running"})
    completed = lobby.root / ("b" * 32)
    ongoing = lobby.root / ("c" * 32)
    for folder in (completed, ongoing):
        write(folder / "selection.json", {"human_race": "Terran", "bot_race": "Protoss", "map": "Play map"})
    write(completed / "status.json", {"status": "finished"})
    write(completed / "match.json", {"results": ["Victory", "Defeat"], "game_seconds": [123, 123]})
    (completed / "game.SC2Replay").write_bytes(b"fake replay")
    write(ongoing / "status.json", {**live, "status": "playing"})
    # Force the human game to sort first, which used to risk masking current league game.
    newest = time.time() + 60
    os.utime(ongoing, (newest, newest))
    catalogue = Catalogue(lobby.workspace, inspector=lambda path: {
        "map_name": "Play map", "duration_seconds": 123, "players": [
            {"player_id": 2, "race": "Protoss", "result": "Loss"},
            {"player_id": 1, "race": "Terran", "result": "Win"}]})
    result = catalogue.snapshot()
    assert result["training"]["current_game"] == 1
    assert result["games"][0]["source"] == "Human match"
    rows = [row for row in result["games"] if row["source"] == "Human match"]
    assert len(rows) == 2
    played = next(row for row in rows if row["ready"])
    assert played["result"] == "Victory" and played["committed"]
    assert played["human_race"] == "Terran" and played["bot_race"] == "Protoss"
    assert played["learner"] == "Terran" and played["matchup"] == "TvP"
    assert catalogue.replay(played["id"]) == completed / "game.SC2Replay"
    assert next(row for row in rows if not row["ready"])["status"] == "In progress"


@pytest.mark.parametrize("status,result,display", [("closed", "Ended early", "Replay ready"),
                                                  ("failed", "Victory", "Failed match (replay available)")])
def test_human_replay_closed_and_failed_are_not_successfully_committed(lobby, status, result, display):
    folder = lobby.root / ("d" * 32)
    write(folder / "selection.json", {"human_race": "Terran", "bot_race": "Protoss", "map": "Play map"})
    write(folder / "status.json", {"status": status})
    (folder / "game.SC2Replay").write_bytes(b"fake replay")
    catalogue = Catalogue(lobby.workspace, inspector=lambda path: {
        "players": [{"player_id": 1, "race": "Terran", "result": "Win"}]})
    row = next(row for row in catalogue.snapshot()["games"] if row["source"] == "Human match")
    assert row["status"] == display and row["result"] == result
    assert row["committed"] is False


def test_internal_spawn_without_receipt_keeps_reservation(lobby, launched):
    identifier = "e" * 32
    folder = lobby.root / identifier
    write(folder / "launch-intent.json", {"session_id": identifier})
    write(folder / "status.json", {"status": "starting"})
    assert lobby.status(identifier)["status"] == "unknown"
    assert lobby.active_session() == identifier
    assert lobby.launch(selection(lobby), session_id=identifier)["status"] == "unknown"
    assert not launched
    write(folder / "status.json", {"status": "closed"})
    assert lobby.status(identifier)["status"] == "closed"
