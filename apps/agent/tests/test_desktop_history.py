from datetime import datetime, timezone
import threading

from sc2tools_agent.desktop_history import DesktopHistory
from sc2tools_agent.recent_games import RecentGamesStore


def test_real_history_worker_owns_disk_and_drops_other_account_pending_metadata(tmp_path, monkeypatch):
    owner = ["first"]
    published, changed = [], threading.Event()
    writes = []
    original = RecentGamesStore.record_many
    def save(store, entries):
        writes.append(threading.current_thread().name)
        return original(store, entries)
    monkeypatch.setattr(RecentGamesStore, "record_many", save)
    worker = DesktopHistory(tmp_path, owner_provider=lambda: owner[0],
                            state_provider=lambda: {"uploaded": {}, "paths_by_id": {}},
                            on_snapshot=lambda value: (published.append(value), changed.set()))
    worker.game_synced("first-path", {"gameId": "private-first", "isHistory": False})
    owner[0] = "second"
    worker.game_synced("second-path", {"gameId": "private-second", "isHistory": False})
    worker.start()
    try:
        assert changed.wait(2)
        assert [row["gameId"] for row in published[-1]["rows"]] == ["private-second"]
        assert writes == ["sc2tools-desktop-history"]
    finally:
        worker.close()
    assert not worker.thread.is_alive()


def test_bounded_handoff_preserves_live_game_during_a_large_history_burst(tmp_path):
    worker = DesktopHistory(tmp_path, owner_provider=lambda: "owner", state_provider=lambda: {}, on_snapshot=lambda _: None)
    worker.game_synced("live", {"gameId": "live", "isHistory": False})
    for index in range(1000):
        worker.game_synced(str(index), {"gameId": str(index), "isHistory": True})
    assert len(worker.history) == 512 and len(worker.live) == 1


def test_bulk_history_cannot_evict_the_actual_latest_game_or_write_each_row_separately(tmp_path, monkeypatch):
    store = RecentGamesStore(tmp_path, owner="owner")
    saves = []
    original = store._save
    def save():
        saves.append(True)
        original()
    monkeypatch.setattr(store, "_save", save)
    store.record_many([{"path": "live", "gameId": "live", "dateIso": "2026-10-23T12:00:00Z", "status": "uploaded"}])
    store.record_many([{"path": str(index), "gameId": str(index), "dateIso": "2026-10-22T12:00:00Z", "status": "uploaded"}
                       for index in range(1000)])
    assert len(store.snapshot()) == 200
    assert store.snapshot()[0]["gameId"] == "live"
    assert len(saves) == 2


def test_owner_change_during_slow_write_fences_published_snapshot(tmp_path, monkeypatch):
    owner = ["first"]
    writing, release, changed = threading.Event(), threading.Event(), threading.Event()
    results = []
    original = RecentGamesStore.record_many
    def slow(store, entries):
        writing.set()
        assert release.wait(3)
        return original(store, entries)
    monkeypatch.setattr(RecentGamesStore, "record_many", slow)
    worker = DesktopHistory(tmp_path, owner_provider=lambda: owner[0], state_provider=lambda: {},
                            on_snapshot=lambda value: (results.append(value), changed.set()))
    worker.game_synced("first", {"gameId": "private-first"})
    worker.start()
    try:
        assert writing.wait(1)
        owner[0] = "second"
        release.set()
        assert changed.wait(2)
        assert results[-1]["owner"] == "second" and results[-1]["rows"] == []
        assert "private-first" not in str(results[-1])
    finally:
        release.set()
        worker.close()


def test_temporary_disk_failure_retains_pending_live_rows_and_recovers(tmp_path, monkeypatch):
    failed, recovered = threading.Event(), threading.Event()
    writes, snapshots = [], []
    original = RecentGamesStore.record_many
    def once(store, entries):
        writes.append([row["gameId"] for row in entries])
        if len(writes) == 1:
            failed.set()
            raise OSError("temporary fixture disk lock")
        return original(store, entries)
    monkeypatch.setattr(RecentGamesStore, "record_many", once)
    def published(value):
        snapshots.append(value)
        if len(value.get("rows", [])) == 2:
            recovered.set()
    worker = DesktopHistory(tmp_path, owner_provider=lambda: "owner", state_provider=lambda: {}, on_snapshot=published)
    worker.game_synced("first", {"gameId": "first"})
    worker.start()
    try:
        assert failed.wait(3)
        worker.game_synced("second", {"gameId": "second"})
        assert recovered.wait(15)
        assert {row["gameId"] for row in snapshots[-1]["rows"]} == {"first", "second"}
        assert any(value.get("localError") for value in snapshots)
        assert not snapshots[-1]["localError"]
        assert len(RecentGamesStore(tmp_path, owner="owner").snapshot()) == 2
    finally:
        worker.close()
