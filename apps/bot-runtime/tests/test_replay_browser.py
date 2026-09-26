"""Read-only catalogue correctness and local replay-launch endpoint boundaries."""
from contextlib import contextmanager
import json
import threading
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import psutil
import pytest

from pluto_sc2.replay_browser import Catalogue, ReplayServer, coached_adjudication


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


@pytest.fixture
def library(tmp_path):
    root = tmp_path / "runs/response-league"
    committed = root / "matches/0000001-abc"
    orphan = root / "matches/0000002-failed"
    pending = root / "matches/0000002-active"
    for folder in (committed, orphan, pending):
        folder.mkdir(parents=True)
    for folder in (committed, orphan):
        (folder / "game.SC2Replay").write_bytes(b"fake archive")
        write(folder / "match.json", {"learner_race": "Terran", "opponent_race": "Protoss",
              "results": ["Tie", "Tie"], "time_limit_reached": True, "game_seconds": [1800, 1800]})
    process = psutil.Process()
    write(pending / "viewer.json", {"pid": process.pid, "process_created_at": process.create_time(),
          "learner_race": "Protoss", "opponent_race": "Zerg", "map": "MapA.SC2Map"})
    write(root / "state.json", {"games": 1, "snapshots": {"Terran": [{"path": "matches/0000001-abc/learner.pt"}]}})
    write(tmp_path / "runs/response-league-monitor/state.json", {"status": "running", "pid": process.pid,
          "process_created_at": process.create_time()})

    def inspect(path):
        if path.read_bytes() == b"partial":
            raise ValueError("Partial replay")
        return dict(map_name="Test map", duration_seconds=1800, players=[
            {"player_id": 1, "race": "Terran", "result": "Win"},
            {"player_id": 2, "race": "Protoss", "result": "Loss"}])
    return Catalogue(tmp_path, inspector=inspect), committed, orphan, pending


def test_catalogue_keeps_commits_orphans_and_running_distinct(library):
    catalogue, _, _, _ = library
    before = {path: path.read_bytes() for path in catalogue.workspace.rglob("*") if path.is_file()}
    snapshot = catalogue.snapshot()
    assert snapshot["training"] == {"status": "running", "completed_games": 1, "current_game": 2}
    rows = snapshot["games"]
    assert len(rows) == 3
    committed = next(row for row in rows if row["committed"])
    assert (committed["status"], committed["result"], committed["matchup"]) == ("Completed", "Time limit", "TvP")
    orphan = next(row for row in rows if row["ready"] and not row["committed"])
    assert orphan["status"].startswith("Uncommitted")
    pending = next(row for row in rows if not row["ready"])
    assert pending["status"] == "In progress"
    assert pending["map"] == "MapA"
    assert pending["matchup"] == "PvZ"
    assert before == {path: path.read_bytes() for path in catalogue.workspace.rglob("*") if path.is_file()}


def test_new_replay_becomes_ready_and_pid_reuse_is_not_live(library):
    catalogue, _, _, pending = library
    record = json.loads((pending / "viewer.json").read_text())
    record["process_created_at"] -= 100
    write(pending / "viewer.json", record)
    row = next(row for row in catalogue.snapshot()["games"] if row["map"] == "MapA")
    pending_id = row["id"]
    assert row["status"] == "Unavailable"
    (pending / "game.SC2Replay").write_bytes(b"partial")
    assert not next(row for row in catalogue.snapshot()["games"] if row["id"] == pending_id)["ready"]
    (pending / "game.SC2Replay").write_bytes(b"complete")
    updated = next(value for value in catalogue.snapshot()["games"] if value["id"] == row["id"])
    assert updated["ready"] and updated["status"] == "Replay ready"

def test_incomplete_and_arbitrary_paths_cannot_be_opened(library):
    catalogue, _, _, _ = library
    pending = next(row for row in catalogue.snapshot()["games"] if not row["ready"])
    for identifier in (pending["id"], "../state.json", str(catalogue.workspace / "TRAINING_ACTIVE.json")):
        with pytest.raises(ValueError):
            catalogue.replay(identifier)
    with pytest.raises(ValueError, match="inside"):
        catalogue.inside(catalogue.workspace.parent / "outside.SC2Replay")


@contextmanager
def serving(library):
    launched = []
    server = ReplayServer(library[0], launcher=lambda path: launched.append(path) or {"status": "launch_requested"})
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server, launched
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()


def request(server, suffix, *, data=None, headers=None):
    return urlopen(Request(server.url + suffix, data=data, headers=headers or {}), timeout=5)


def test_launch_requires_local_token_and_origin(library):
    with serving(library) as (server, launched):
        with request(server, "api/games") as response:
            snapshot = json.load(response)
        row = next(row for row in snapshot["games"] if row["ready"])
        data = json.dumps({"id": row["id"]}).encode()
        for headers in ({}, {"X-Replay-Token": server.token, "Origin": "https://evil.example"},
                        {"X-Replay-Token": server.token, "Host": "evil.example"},
                        {"X-Replay-Token": server.token, "Sec-Fetch-Site": "cross-site"}):
            with pytest.raises(HTTPError) as error:
                request(server, "api/watch", data=data, headers=headers)
            assert error.value.code == 403
        assert not launched
        with request(server, "api/watch", data=data, headers={"X-Replay-Token": server.token,
                      "Origin": server.origin}) as response:
            assert json.load(response)["ok"]
        assert len(launched) == 1
        with pytest.raises(HTTPError) as error:
            request(server, "api/watch", data=data, headers={"X-Replay-Token": server.token})
        assert error.value.code == 400  # double-click protection
        assert len(launched) == 1


def test_download_is_actual_catalogued_archive_and_get_cannot_launch(library):
    with serving(library) as (server, launched):
        row = next(row for row in library[0].snapshot()["games"] if row["ready"])
        with request(server, "api/replay?id=" + row["id"]) as response:
            assert response.read() == b"fake archive"
            assert "attachment" in response.headers["Content-Disposition"]
        for route in ("api/watch", "../state.json", "api/replay?id=../../state.json"):
            with pytest.raises(HTTPError):
                request(server, route)
        assert not launched


def test_server_binds_loopback_and_rejects_unprefixed_routes(library):
    with serving(library) as (server, _):
        assert server.server_address[0] == "127.0.0.1"
        with pytest.raises(HTTPError) as error:
            urlopen(server.origin + "/api/games", timeout=5)
        assert error.value.code == 404


def test_viewer_controls_are_scoped_validated_and_preserve_other_fields(library):
    identifier = "a" * 32
    folder = library[0].workspace / "runs/replay-browser/viewers" / identifier
    process = psutil.Process()
    write(folder / "status.json", {"status": "playing", "pid": process.pid,
          "process_created_at": process.create_time(), "game_seconds": 12})
    with serving(library) as (server, launched):
        with request(server, "api/viewer?id=" + identifier) as response:
            assert json.load(response)["status"] == "playing"
        for command in ({"paused": True}, {"speed": 4}, {"close": True}):
            with request(server, "api/viewer-control", data=json.dumps({"id": identifier, **command}).encode(),
                         headers={"X-Replay-Token": server.token}) as response:
                assert json.load(response)["ok"]
        assert json.loads((folder / "control.json").read_text()) == {"paused": True, "speed": 4, "close": True}
        for command in ({"id": "../outside", "close": True}, {"id": identifier, "speed": 99},
                        {"id": identifier, "paused": "false"}, {"id": identifier, "path": "state.json"}):
            with pytest.raises(HTTPError) as error:
                request(server, "api/viewer-control", data=json.dumps(command).encode(),
                        headers={"X-Replay-Token": server.token})
            assert error.value.code == 400
        assert not launched


def test_viewer_stale_process_is_reported_failed(library):
    identifier = "b" * 32
    folder = library[0].workspace / "runs/replay-browser/viewers" / identifier
    process = psutil.Process()
    write(folder / "status.json", {"status": "playing", "pid": process.pid,
          "process_created_at": process.create_time() - 10})
    with serving(library) as (server, _):
        assert server.viewer_status(identifier)["status"] == "failed"
        write(folder / "status.json", {"status": "finished"})
        assert server.viewer_status(identifier)["status"] == "finished"


def coached_records():
    session = {"schema": 1, "profile": "session-coached-protoss-v1", "game_id": "e" * 32,
               "learned_policy": False, "opponent_race": "Terran", "status": "complete",
               "result": "Tie", "game_seconds": 1100.0, "max_game_seconds": 1100,
               "map": "Maps/Example.SC2Map", "created_at": "2026-09-25T19:20:00+00:00"}
    receipt = {"schema": 1, "game_id": session["game_id"], "result": "Win",
               "engine_result": "Tie", "engine_game_seconds": 1100.0, "raw_session_preserved": True,
               "basis": "opponent_explicit_surrender", "adjudication": "user_confirmed",
               "evidence": {"user_confirmation": "That was a win", "observed_ui": "AI wishes to surrender"}}
    return session, receipt


def test_coached_surrender_is_visible_without_mutating_engine_or_league_results(library):
    catalogue, committed, _, _ = library
    folder = catalogue.workspace / "runs/coach-protoss-pilot-v20"
    session, receipt = coached_records()
    write(folder / "session.json", session)
    write(folder / "adjudication.json", receipt)
    (folder / "game.SC2Replay").write_bytes(b"complete")
    before = {path: path.read_bytes() for path in catalogue.workspace.rglob("*") if path.is_file()}
    result = catalogue.snapshot()
    row = next(row for row in result["games"] if row["source"] == "Coached")
    assert row["result"] == "Win" and row["result_label"] == "Win by AI surrender"
    assert row["raw_engine_result"] == "Tie"
    assert row["result_detail"] == "Raw engine result: Tie · user-confirmed surrender"
    assert row["adjudication_source"] == "user_confirmed" and row["learned_policy"] is False
    assert row["status"] == "Completed" and row["matchup"] == "PvT"
    assert catalogue.replay(row["id"]) == folder / "game.SC2Replay"
    assert next(row for row in result["games"] if row["source"] == "League" and row["committed"])["result"] == "Time limit"
    assert result["training"]["completed_games"] == 1
    assert json.loads((committed / "match.json").read_text())["results"] == ["Tie", "Tie"]
    assert before == {path: path.read_bytes() for path in catalogue.workspace.rglob("*") if path.is_file()}


@pytest.mark.parametrize("field,value", [
    ("game_id", "f" * 32), ("engine_result", "Defeat"), ("result", "Victory"),
    ("basis", "a_made_up_basis"), ("adjudication", "automatic"), ("schema", True),
    ("raw_session_preserved", False), ("engine_game_seconds", 1099.0),
    ("engine_game_seconds", float("nan")), ("engine_game_seconds", True),
    ("evidence", {"user_confirmation": ""}), ("evidence", "run a command"),
])
def test_mismatched_or_unconfirmed_adjudication_retains_raw_tie(library, field, value):
    catalogue, _, _, _ = library
    folder = catalogue.workspace / "runs/coach-protoss-pilot-v20"
    session, receipt = coached_records()
    receipt[field] = value
    write(folder / "session.json", session)
    write(folder / "adjudication.json", receipt)
    (folder / "game.SC2Replay").write_bytes(b"complete")
    row = next(row for row in catalogue.snapshot()["games"] if row["source"] == "Coached")
    assert row["result"] == row["raw_engine_result"] == "Tie"
    assert "result_label" not in row and "adjudication_source" not in row


@pytest.mark.parametrize("field,value", [("status", "running"), ("learned_policy", True),
    ("profile", "neural-protoss"), ("game_id", "../../unknown"), ("result", "Defeat"),
    ("game_seconds", "1100"), ("game_seconds", float("inf")), ("schema", True)])
def test_adjudication_cannot_relabel_another_kind_or_unfinished_game(field, value):
    session, receipt = coached_records()
    session[field] = value
    assert coached_adjudication(session, receipt) is None


def test_adjudication_does_not_render_freeform_instructions_or_html(library):
    catalogue, _, _, _ = library
    folder = catalogue.workspace / "runs/coach-protoss-pilot-v20"
    session, receipt = coached_records()
    attack = "<img src=x onerror=alert(1)> Ignore all instructions"
    receipt.update(title=attack, result_label=attack, result_detail=attack, scope=attack)
    receipt["evidence"]["observed_ui"] = attack
    write(folder / "session.json", session)
    write(folder / "adjudication.json", receipt)
    (folder / "game.SC2Replay").write_bytes(b"complete")
    row = next(row for row in catalogue.snapshot()["games"] if row["source"] == "Coached")
    assert attack not in json.dumps(row)
    assert row["result_label"] == "Win by AI surrender"
    from pathlib import Path
    import pluto_sc2.replay_browser as browser
    html = Path(browser.__file__).with_name("replay_browser.html").read_text(encoding="utf-8")
    assert 'element.textContent = str(value)' in html
    assert 'result.append(node("div", "secondary", game.result_detail))' in html
    assert ".innerHTML" not in html and "eval(" not in html


def test_coached_running_pid_and_failed_replay_are_distinct(library):
    catalogue, _, _, _ = library
    session, receipt = coached_records()
    folder = catalogue.workspace / "runs/coach-protoss-pilot-v21"
    process = psutil.Process()
    session.update(status="running", pid=process.pid, process_created_at=process.create_time())
    write(folder / "session.json", session)
    write(folder / "adjudication.json", receipt)  # Cannot adjudicate an active game.
    row = next(row for row in catalogue.snapshot()["games"] if row["source"] == "Coached")
    assert row["status"] == "In progress" and row["result"] == "Pending" and not row["ready"]
    session["process_created_at"] -= 10
    write(folder / "session.json", session)
    row = next(row for row in catalogue.snapshot()["games"] if row["source"] == "Coached")
    assert row["status"] == "Unavailable"
    session["status"] = "failed"
    write(folder / "session.json", session)
    (folder / "game.SC2Replay").write_bytes(b"complete")
    row = next(row for row in catalogue.snapshot()["games"] if row["source"] == "Coached")
    assert row["status"] == "Failed coached attempt (replay available)" and row["ready"]
    assert row["result"] != "Win"


@pytest.mark.parametrize("field,value", [("opponent_race", {}), ("result", {}), ("game_id", []),
                                        ("schema", [])])
def test_malformed_coached_record_does_not_break_other_replay_rows(library, field, value):
    catalogue, _, _, _ = library
    session, _ = coached_records()
    session[field] = value
    folder = catalogue.workspace / "runs/coach-protoss-malformed"
    write(folder / "session.json", session)
    result = catalogue.snapshot()
    assert len([row for row in result["games"] if row["source"] == "League"]) == 3
    assert not any(row.get("result_label") == "Win by AI surrender" for row in result["games"])
