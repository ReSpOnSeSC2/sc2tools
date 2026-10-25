import logging
import threading
from types import SimpleNamespace
from unittest.mock import Mock

from sc2tools_agent import runner
from sc2tools_agent.state import AgentState, load_state
from sc2tools_agent.ui import SettingsPayload
from tests.test_upload_queue import _cfg


def test_real_history_bridge_initial_inventory_runs_on_its_own_thread(tmp_path):
    reads, result, ready = [], [], threading.Event()
    class Cursor(dict):
        def copy(self):
            reads.append(threading.current_thread().name)
            return super().copy()
    state = AgentState(device_token="fixture", user_id="u1", uploaded=Cursor({"old": "2026-10-23T10:00:00Z"}))
    ui = runner._Multiplexer(Mock())
    ui.on_recent_snapshot = lambda value: (result.append(value), ready.set())
    history = runner._start_desktop_history(_cfg(tmp_path), state, ui)
    try:
        assert ready.wait(3)
        assert reads == ["sc2tools-desktop-history"]
        assert result[-1]["facts"]["synced"] == 1
        assert result[-1]["rows"][0]["seeded"]
    finally:
        history.close()


def test_manual_resync_dispatch_returns_while_disk_work_waits_and_is_single_flight(tmp_path, monkeypatch):
    entered, release, finished = threading.Event(), threading.Event(), threading.Event()
    calls = []
    def resync(*_args):
        calls.append(threading.current_thread().name)
        entered.set()
        assert release.wait(3)
    monkeypatch.setattr(runner, "_handle_replay_archive_resync", resync)
    cell = runner._RuntimeCell()
    cell.watcher = Mock()
    cell.import_ctl = SimpleNamespace(maybe_start_auto_backfill=lambda **kw: (calls.append(kw), finished.set()))
    runner._request_desktop_resync(_cfg(tmp_path), AgentState(), cell)
    try:
        assert entered.wait(1)
        runner._request_desktop_resync(_cfg(tmp_path), AgentState(), cell)
        assert calls == ["sc2tools-desktop-resync"]
    finally:
        release.set()
    assert finished.wait(2)
    assert calls[-1] == {"force_display": True}
    cell.watcher.request_immediate_sweep.assert_called_once()


def test_every_game_notifications_are_opt_in_live_only_deduplicated_and_owner_fenced():
    notices, synced = [], []
    sink = SimpleNamespace(on_game_synced=lambda *args: synced.append(args), show_notice=notices.append)
    ui = runner._Multiplexer(sink)
    ui._recent_history = SimpleNamespace(owner_provider=lambda: "u1", game_synced=lambda *args: None)
    row = {"_owner": "u1", "gameId": "live", "result": "Victory", "oppName": "Test",
           "races": {"opponent": "Zerg"}, "map": "Alcyone LE"}
    ui.on_game_synced("path", row)
    assert not notices
    ui._game_notifications = lambda: True
    ui.on_game_synced("path", {**row, "gameId": "old", "isHistory": True})
    ui.on_game_synced("path", {**row, "gameId": "resume", "isResumed": True})
    ui.on_game_synced("path", {**row, "gameId": "other", "_owner": "u2"})
    ui.on_game_synced("path", row)
    ui.on_game_synced("path", row)
    assert notices == ["Victory vs Test (Z) on Alcyone LE"]
    assert all(args[1]["_owner"] == "u1" for args in synced)


def test_notification_consent_is_persisted_and_default_is_off(tmp_path):
    assert load_state(tmp_path).notify_every_game is False
    cell = SimpleNamespace(upload=None, watcher=None, gui=None, tray=None)
    state = AgentState()
    runner._handle_save_settings(_cfg(tmp_path), state, SettingsPayload(notify_every_game=True), cell, logging.getLogger("test"))
    assert load_state(tmp_path).notify_every_game is True
    runner._handle_save_settings(_cfg(tmp_path), state, SettingsPayload(notify_every_game=False), cell, logging.getLogger("test"))
    assert load_state(tmp_path).notify_every_game is False
