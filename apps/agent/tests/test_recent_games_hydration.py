from datetime import datetime, timezone
import json
import threading
from types import SimpleNamespace

import pytest

from sc2tools_agent.companion import CompanionClient, CompanionError
from sc2tools_agent.desktop_history import DesktopHistory
from sc2tools_agent.recent_games import RecentGamesStore, summary_from_cloud_game, today_summary


def cloud_game(identifier="legacy", **overrides):
    return {
        "gameId": identifier, "date": "2026-10-23T10:00:00Z", "result": "Victory",
        "myRace": "Protoss", "myLadderRace": "Protoss", "myToonHandle": "1-S2-1-42",
        "opponent": {"displayName": "Historical opponent", "race": "Zerg", "mmr": 8000},
        "map": "Alcyone LE", "durationSec": 600, "myMmr": 5321,
        "isLadderGame": True, "isResumedFromReplay": False, **overrides,
    }


def legacy_store(tmp_path, identifiers=("legacy",)):
    return RecentGamesStore(tmp_path, owner="owner",
                            uploaded={identifier: "2026-10-23T12:00:00Z" for identifier in identifiers},
                            paths_by_id={identifier: identifier for identifier in identifiers})


def history_worker(tmp_path, store, reader, *, session=None, clock=None):
    session = session if session is not None else [("owner", "private-device-token")]
    clock = clock if clock is not None else [0.0]
    worker = DesktopHistory(tmp_path, owner_provider=lambda: session[0][0],
                            session_provider=lambda: session[0], state_provider=lambda: {},
                            on_snapshot=lambda _: None, game_reader=reader, clock=lambda: clock[0])
    worker.store = store
    return worker


def test_cloud_summary_whitelists_owned_metadata_and_never_uses_upload_time_or_opponent_mmr():
    summary = summary_from_cloud_game(cloud_game(device_token="must-not-persist", path="cloud-path"), "legacy")
    assert summary["dateIso"] == "2026-10-23T10:00:00Z"
    assert summary["mmr"] == 5321 and summary["region"] == "NA"
    assert summary["races"] == {"own": "Protoss", "opponent": "Zerg"}
    assert not {"path", "owner", "updatedAt", "device_token", "isHistory"} & summary.keys()
    assert summary_from_cloud_game(cloud_game("different"), "legacy") == {}
    assert summary_from_cloud_game(None, "legacy") == {}
    absent = summary_from_cloud_game(cloud_game(date=None, myMmr=None), "legacy")
    assert absent["dateIso"] is None and absent["mmr"] is None


def test_malformed_cloud_fields_are_not_invented_or_allowed_to_crash_the_worker():
    summary = summary_from_cloud_game(cloud_game(myRace=[], myLadderRace={}, map={}, durationSec=True,
                                                result={}, myMmr=float("nan"),
                                                opponent={"displayName": [], "race": {}},
                                                isLadderGame="true", isResumedFromReplay=None), "legacy")
    assert summary["races"] == {"own": None, "opponent": None}
    assert all(summary[field] is None for field in ("result", "map", "durationSec", "mmr", "oppName", "isLadder", "isResumed"))


def test_seed_enrichment_preserves_receipt_identity_and_restores_played_time_summary(tmp_path):
    store = legacy_store(tmp_path)
    candidate = store.metadata_candidates()[0]
    assert store.enrich_metadata(candidate, summary_from_cloud_game(cloud_game(), "legacy"))
    row = store.snapshot()[0]
    assert all(row[field] == candidate[field] for field in ("owner", "path", "gameId", "status", "updatedAt"))
    assert row["dateIso"] == "2026-10-23T10:00:00Z" and row["result"] == "Victory"
    assert "seeded" not in row and not store.metadata_candidates()
    assert RecentGamesStore(tmp_path, owner="owner").snapshot() == [row]
    assert today_summary([row], now=datetime(2026, 10, 23, 13, tzinfo=timezone.utc))["wins"] == 1
    assert "private-device-token" not in store.path.read_text()


def test_historical_upload_does_not_become_a_game_played_today(tmp_path):
    store = legacy_store(tmp_path)
    store.enrich_metadata(store.metadata_candidates()[0], summary_from_cloud_game(
        cloud_game(date="2026-10-22T10:00:00Z"), "legacy"))
    today = today_summary(store.snapshot(), now=datetime(2026, 10, 23, 13, tzinfo=timezone.utc))
    assert today["games"] == 0 and today["wins"] == 0


def test_enrichment_sorts_by_played_time_while_preserving_receipt_and_skip_identity(tmp_path):
    store = RecentGamesStore(tmp_path, owner="owner",
                            uploaded={"newer-upload": "2026-10-23T12:00:00Z", "older-upload": "2026-10-23T11:00:00Z"},
                            paths_by_id={"old-game": "newer-upload", "new-game": "older-upload"})
    store.record("skipped", {"reason": "ai_game"}, status="skipped",
                 now=datetime(2026, 10, 23, 13, tzinfo=timezone.utc))
    original = {row["path"]: row for row in store.snapshot()}
    for candidate in store.metadata_candidates():
        date = "2026-10-22T10:00:00Z" if candidate["gameId"] == "old-game" else "2026-10-23T10:00:00Z"
        store.enrich_metadata(candidate, summary_from_cloud_game(cloud_game(candidate["gameId"], date=date), candidate["gameId"]))
    rows = store.snapshot()
    assert [row["path"] for row in rows] == ["skipped", "older-upload", "newer-upload"]
    for row in rows:
        assert all(row[field] == original[row["path"]][field] for field in ("owner", "path", "status", "updatedAt"))


def test_enrichment_keeps_fresh_richer_metadata_and_rejects_changed_receipts(tmp_path):
    store = legacy_store(tmp_path)
    candidate = store.metadata_candidates()[0]
    store.record("legacy", {"gameId": "legacy", "oppName": "Fresh name", "mmr": 6000,
                            "races": {"own": "Terran"}})
    assert not store.enrich_metadata(candidate, summary_from_cloud_game(cloud_game(), "legacy"))
    fresh = store.metadata_candidates()[0]
    assert store.enrich_metadata(fresh, summary_from_cloud_game(cloud_game(), "legacy"))
    row = store.snapshot()[0]
    assert row["oppName"] == "Fresh name" and row["mmr"] == 6000
    assert row["races"] == {"own": "Terran", "opponent": "Zerg"}


def test_metadata_enrichment_is_owner_status_and_commit_guard_scoped(tmp_path):
    store = legacy_store(tmp_path)
    candidate = store.metadata_candidates()[0]
    summary = summary_from_cloud_game(cloud_game(), "legacy")
    assert not store.enrich_metadata({**candidate, "owner": "other"}, summary)
    assert not store.enrich_metadata(candidate, summary, can_commit=lambda: False)
    store.record("legacy", {"gameId": "legacy"}, status="problem")
    assert not store.metadata_candidates()
    assert not store.enrich_metadata(candidate, summary)


def test_failed_enrichment_is_atomic_and_never_touches_agent_state_or_replay(tmp_path, monkeypatch):
    store = legacy_store(tmp_path)
    state_file = tmp_path / "agent.json"
    replay_file = tmp_path / "private.SC2Replay"
    state_file.write_text('{"uploaded":{"legacy":"preserved"},"device_token":"private"}')
    replay_file.write_bytes(b"private fixture")
    before, state_before, replay_before = store.path.read_bytes(), state_file.read_bytes(), replay_file.read_bytes()
    rows = store.snapshot()
    def unavailable(*args):
        raise OSError("fixture lock")
    monkeypatch.setattr("sc2tools_agent.recent_games._replace_state_file", unavailable)
    with pytest.raises(OSError):
        store.enrich_metadata(store.metadata_candidates()[0], summary_from_cloud_game(cloud_game(), "legacy"))
    assert store.snapshot() == rows and store.path.read_bytes() == before
    assert state_file.read_bytes() == state_before and replay_file.read_bytes() == replay_before
    assert not list(tmp_path.glob("recent-games-*.tmp"))


def test_session_change_while_flushing_metadata_cancels_the_durable_replacement(tmp_path, monkeypatch):
    import os
    store = legacy_store(tmp_path)
    before, rows, current = store.path.read_bytes(), store.snapshot(), [True]
    original = os.fsync
    def change_session(descriptor):
        original(descriptor)
        current[0] = False
    monkeypatch.setattr(os, "fsync", change_session)
    assert not store.enrich_metadata(store.metadata_candidates()[0], summary_from_cloud_game(cloud_game(), "legacy"),
                                     can_commit=lambda: current[0])
    assert store.snapshot() == rows and store.path.read_bytes() == before
    assert not list(tmp_path.glob("recent-games-*.tmp"))


def test_metadata_requests_are_single_spaced_and_due_work_wakes_within_one_second(tmp_path):
    store = legacy_store(tmp_path, ("first", "second"))
    calls, clock = [], [0.0]
    worker = history_worker(tmp_path, store, lambda identifier: calls.append(identifier) or cloud_game(identifier), clock=clock)
    assert worker._hydrate_metadata("owner") <= 1
    assert len(calls) == 1
    assert worker._hydrate_metadata("owner") <= 1 and len(calls) == 1
    clock[0] = 1
    worker._hydrate_metadata("owner")
    assert len(calls) == 2 and len(set(calls)) == 2
    assert not store.metadata_candidates()


def test_transient_lookup_failures_back_off_without_losing_rows_or_logging_credentials(tmp_path, caplog):
    store = legacy_store(tmp_path)
    before, calls, clock = store.snapshot(), [], [0.0]
    def fail(identifier):
        calls.append(identifier)
        raise RuntimeError("private-device-token private response")
    worker = history_worker(tmp_path, store, fail, clock=clock)
    worker._hydrate_metadata("owner")
    assert worker.metadata_retries[("legacy", "legacy")] == (1, 30)
    clock[0] = 29
    worker._hydrate_metadata("owner")
    assert len(calls) == 1
    clock[0] = 30
    worker._hydrate_metadata("owner")
    assert worker.metadata_retries[("legacy", "legacy")] == (2, 90)
    for _ in range(10):
        clock[0] = worker.metadata_retries[("legacy", "legacy")][1]
        worker._hydrate_metadata("owner")
    assert worker.metadata_retries[("legacy", "legacy")][1] - clock[0] == 1800
    assert store.snapshot() == before and not caplog.records


@pytest.mark.parametrize("change", ["unpair", "other-owner", "rotate-token", "re-pair", "refresh"])
def test_inflight_reply_is_fenced_after_account_session_or_generation_changes(tmp_path, change):
    store = legacy_store(tmp_path)
    before, session = store.snapshot(), [("owner", "old-token")]
    entered, release = threading.Event(), threading.Event()
    def read(identifier):
        entered.set()
        assert release.wait(3)
        return cloud_game(identifier)
    worker = history_worker(tmp_path, store, read, session=session)
    lookup = threading.Thread(target=lambda: worker._hydrate_metadata("owner"))
    lookup.start()
    try:
        assert entered.wait(1)
        if change == "unpair":
            session[0] = (None, None)
        elif change == "other-owner":
            session[0] = ("other", "new-token")
        elif change == "rotate-token":
            session[0] = ("owner", "new-token")
        elif change == "re-pair":
            session[0] = (None, None)
            worker.refresh()
            session[0] = ("owner", "new-token")
        else:
            worker.refresh()
    finally:
        release.set()
        lookup.join(3)
    assert not lookup.is_alive() and store.snapshot() == before


def test_shutdown_discards_an_inflight_metadata_response(tmp_path):
    store = legacy_store(tmp_path)
    before, entered = store.snapshot(), threading.Event()
    def read(identifier):
        entered.set()
        assert worker.stop_event.wait(2)
        return cloud_game(identifier)
    worker = history_worker(tmp_path, store, read)
    worker.thread = threading.Thread(target=lambda: worker._hydrate_metadata("owner"))
    worker.thread.start()
    assert entered.wait(1)
    worker.close()
    assert not worker.thread.is_alive() and store.snapshot() == before


def test_a_pending_fresh_upload_takes_priority_over_legacy_cloud_metadata(tmp_path):
    store = legacy_store(tmp_path)
    before = store.snapshot()
    def read(identifier):
        worker.game_synced("legacy", {"gameId": identifier, "oppName": "Fresh upload"})
        return cloud_game(identifier)
    worker = history_worker(tmp_path, store, read)
    worker._hydrate_metadata("owner")
    assert store.snapshot() == before and worker.live[0]["oppName"] == "Fresh upload"


def test_real_worker_hydrates_and_publishes_only_from_its_background_thread(tmp_path):
    legacy_store(tmp_path)
    calls, published, ready = [], [], threading.Event()
    def read(identifier):
        calls.append(threading.current_thread().name)
        return cloud_game(identifier)
    def snapshot(value):
        published.append(value)
        if value["rows"] and value["rows"][0].get("result") == "Victory":
            ready.set()
    worker = DesktopHistory(tmp_path, owner_provider=lambda: "owner", state_provider=lambda: {},
                            session_provider=lambda: ("owner", "private-token"),
                            game_reader=read, on_snapshot=snapshot)
    worker.start()
    try:
        assert ready.wait(3)
        assert calls == ["sc2tools-desktop-history"]
        assert published[-1]["rows"][0]["result"] == "Victory"
        assert "private-token" not in json.dumps(published)
    finally:
        worker.close()


def test_owned_summary_transport_reuses_current_pairing_https_encoding_timeout_and_no_redirects():
    connection, calls = ["https://api.example.test", "old-token"], []
    def transport(*args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(status_code=200, json=lambda: cloud_game("replay/a?b#c"))
    client = CompanionClient(lambda: connection, transport=transport)
    assert client.action({"action": "game_summary", "gameId": "replay/a?b#c"})["gameId"] == "replay/a?b#c"
    connection[1] = "new-token"
    client.action({"action": "game_summary", "gameId": "legacy"})
    assert calls[0][0] == ("GET", "https://api.example.test/v1/games/replay%2Fa%3Fb%23c")
    assert calls[1][1]["headers"]["Authorization"] == "Bearer new-token"
    assert calls[0][1]["timeout"] == (3.05, 8) and calls[0][1]["allow_redirects"] is False
    connection[0] = "http://untrusted.example.test"
    with pytest.raises(CompanionError):
        client.action({"action": "game_summary", "gameId": "legacy"})
    connection[1] = None
    with pytest.raises(CompanionError):
        client.action({"action": "game_summary", "gameId": "legacy"})
    assert len(calls) == 2


@pytest.mark.parametrize("identifier", [None, "", " ../ ", "..", "bad\nvalue", "x" * 201])
def test_owned_summary_rejects_invalid_ids_without_network(identifier):
    client = CompanionClient(lambda: ("https://api.example.test", "token"),
                             transport=lambda *_args, **_kwargs: pytest.fail("Invalid IDs must not reach network"))
    with pytest.raises(CompanionError):
        client.action({"action": "game_summary", "gameId": identifier})


def test_missing_cloud_game_is_an_unavailable_summary_not_a_resync_request():
    client = CompanionClient(lambda: ("https://api.example.test", "token"),
                             transport=lambda *_args, **_kwargs: SimpleNamespace(status_code=404))
    assert client.action({"action": "game_summary", "gameId": "missing"}) == {}


def test_runner_wires_metadata_reader_to_history_thread_without_mutating_uploaded_cursor(tmp_path, monkeypatch):
    from sc2tools_agent import runner
    from sc2tools_agent.state import AgentState
    calls, ready = [], threading.Event()
    state = AgentState(device_token="private-token", user_id="owner",
                       uploaded={"legacy": "2026-10-23T12:00:00Z"}, path_by_game_id={"legacy": "legacy"})
    before = dict(state.uploaded)
    def action(client, request):
        calls.append((threading.current_thread().name, request, client._connection_provider()))
        return cloud_game(request["gameId"])
    monkeypatch.setattr(CompanionClient, "action", action)
    ui = SimpleNamespace(on_recent_snapshot=lambda value: ready.set() if value.get("rows") and value["rows"][0].get("result") else None)
    worker = runner._start_desktop_history(SimpleNamespace(state_dir=tmp_path, api_base="https://api.example.test"), state, ui)
    try:
        assert ready.wait(3)
        assert calls == [("sc2tools-desktop-history", {"action": "game_summary", "gameId": "legacy"},
                          ("https://api.example.test", "private-token"))]
        assert state.uploaded == before
    finally:
        worker.close()
