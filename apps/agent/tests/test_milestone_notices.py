from datetime import datetime, timedelta, timezone
import json
import logging
from queue import Queue
import threading
from types import SimpleNamespace

import pytest
from requests import Response

from sc2tools_agent import milestone_notices, runner
from sc2tools_agent.live.types import LiveLifecycleEvent, LiveLifecyclePhase
from sc2tools_agent.runner import _Multiplexer, _start_milestone_notices
from sc2tools_agent.state import AgentState, _STATE_SAVE_LOCK, load_state, save_state
from sc2tools_agent.ui.console import ConsoleUI
from sc2tools_agent.ui.gui import SettingsPayload
from sc2tools_agent.ui.tray import TrayUI
from tests._gui_offscreen import run_gui_check
from tests.test_agent_credentials import MemoryStorage, SyntheticCrypto


def synced_game(**changes):
    return {"_owner": "owner-a", "gameId": "game/one", "dateIso": datetime.now(timezone.utc).isoformat(), **changes}


def milestone(**changes):
    return {
        "href": "/app/game/game%2Fone", "kind": "moment.win_streak",
        "title": "Winning streak", "body": "Five wins in a row", "readAt": None,
        **changes,
    }


def response(status=200, *, items=()):
    result = Response()
    result.status_code = status
    result._content = json.dumps({"items": list(items)}).encode("utf-8")
    return result


@pytest.fixture
def make_worker(tmp_path, monkeypatch):
    state_storage, crypto = MemoryStorage(), SyntheticCrypto()
    state = AgentState(user_id="owner-a", device_token="fake-device-a", notify_milestones=True)

    def save(directory, value):
        save_state(directory, value, storage=state_storage, crypto=crypto)

    def reload():
        return load_state(tmp_path, storage=state_storage, crypto=crypto)

    monkeypatch.setattr(milestone_notices, "save_state", save)
    monkeypatch.setattr(milestone_notices, "_RETRY_DELAYS", (0, 0, 0))
    save(tmp_path, state)
    workers = []

    def start(request, *, settings=state):
        calls, toasts, completed = [], [], Queue()

        def http(method, url, *, headers, **_options):
            calls.append((method, url, headers.get("authorization")))
            return request(len(calls))

        monkeypatch.setattr("sc2tools_agent.api_client.requests.request", http)
        tray = TrayUI(dashboard_url="https://example.test/app")
        tray._icon = SimpleNamespace(notify=lambda body, title: toasts.append((title, body)))
        ui = _Multiplexer(ConsoleUI(), tray)
        cfg = SimpleNamespace(state_dir=tmp_path, api_base="https://api.example.test")
        worker = _start_milestone_notices(cfg, settings, ui, tray, threading.Event())
        workers.append(worker)
        original = worker._check_for_notice

        def track(game):
            try:
                original(game)
            finally:
                completed.put(True)

        worker._check_for_notice = track
        return SimpleNamespace(
            state=settings, calls=calls, toasts=toasts, completed=completed,
            worker=worker, submit=lambda game: ui.on_game_synced("inert.SC2Replay", game),
            phase=lambda phase: worker.on_game_event(LiveLifecycleEvent(phase=phase)), reload=reload,
        )

    yield start
    for worker in workers:
        worker.close()


def test_waits_for_async_ingest_then_uses_authenticated_newest_matching_unread(make_worker):
    rows = [
        milestone(href="/app/game/other", title="Different game"),
        milestone(kind="system.example", title="Different notice type"),
        milestone(readAt="2026-11-11T00:00:00Z", title="Already read"),
        milestone(),
        milestone(title="Earlier milestone"),
    ]
    app = make_worker(lambda call: response(items=rows if call == 2 else ()))
    app.phase(LiveLifecyclePhase.MENU)
    app.submit(synced_game())
    assert app.completed.get(timeout=3)
    assert app.toasts == [("Winning streak", "Five wins in a row")]
    assert app.calls == [
        ("GET", "https://api.example.test/v1/me/notifications?kind=milestones&unread=true&limit=20", "Bearer fake-device-a"),
    ] * 2


def test_holds_notice_when_game_starts_during_request(make_worker, monkeypatch):
    fetched, release, waiting = threading.Event(), threading.Event(), threading.Event()

    def request(_call):
        fetched.set()
        assert release.wait(3)
        return response(items=[milestone()])

    app = make_worker(request)
    condition = app.worker._changed
    wait_for = condition.wait_for

    def track_wait(predicate, timeout=None):
        if timeout is None and not predicate():
            waiting.set()
        return wait_for(predicate, timeout=timeout)

    app.phase(LiveLifecyclePhase.MENU)
    app.submit(synced_game())
    try:
        assert fetched.wait(3)
        app.phase(LiveLifecyclePhase.MATCH_LOADING)
        monkeypatch.setattr(condition, "wait_for", track_wait)
    finally:
        release.set()
    assert waiting.wait(3)
    assert app.toasts == []
    app.phase(LiveLifecyclePhase.MATCH_ENDED)
    assert app.completed.get(timeout=3)
    assert app.toasts == [("Winning streak", "Five wins in a row")]
    assert len(app.calls) == 1


def test_dedupes_repeated_upload_and_survives_real_state_roundtrip(make_worker):
    game = synced_game()
    first = make_worker(lambda _call: response(items=[milestone()]))
    first.phase(LiveLifecyclePhase.IDLE)
    first.submit(game)
    assert first.completed.get(timeout=3)
    first.submit(game)
    first.worker.close()
    assert len(first.toasts) == len(first.calls) == 1
    restored = first.reload()
    assert restored.notify_milestones is True
    assert len(restored.milestone_notice_receipts) == 1
    second = make_worker(lambda _call: pytest.fail("already delivered"), settings=restored)
    second.phase(LiveLifecyclePhase.MENU)
    second.submit(game)
    assert second.worker._latest is None


def test_old_api_stops_without_unlinking_or_marking_seen(make_worker):
    app = make_worker(lambda _call: response(404))
    app.phase(LiveLifecyclePhase.MENU)
    app.submit(synced_game())
    assert app.completed.get(timeout=3)
    assert len(app.calls) == 1
    assert not app.toasts and not app.state.milestone_notice_receipts
    assert app.state.is_paired


def test_retired_account_cannot_surface_an_inflight_response(make_worker):
    entered, release = threading.Event(), threading.Event()

    def request(_call):
        entered.set()
        assert release.wait(3)
        return response(items=[milestone()])

    app = make_worker(request)
    app.phase(LiveLifecyclePhase.MENU)
    app.submit(synced_game())
    try:
        assert entered.wait(3)
        with _STATE_SAVE_LOCK:
            app.state.user_id = "owner-b"
            app.state.device_token = "fake-device-b"
            app.state._owner_epoch = object()
    finally:
        release.set()
    assert app.completed.get(timeout=3)
    assert len(app.calls) == 1
    assert not app.toasts and not app.state.milestone_notice_receipts


def test_default_mute_history_and_stale_games_do_not_enqueue(make_worker):
    app = make_worker(lambda _call: pytest.fail("ineligible game"))
    assert AgentState().notify_milestones is False
    app.state.notify_milestones = False
    app.submit(synced_game())
    assert app.worker._latest is None
    app.state.notify_milestones = True
    app.state.notifications_muted = True
    app.submit(synced_game())
    assert app.worker._latest is None
    app.state.notifications_muted = False
    app.submit(synced_game(isHistory=True))
    app.submit(synced_game(isResumed=True))
    app.submit(synced_game(_owner="owner-b"))
    app.submit(synced_game(dateIso=(datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()))
    assert app.worker._latest is None


def test_failed_receipt_save_is_retried_before_notifying(make_worker, monkeypatch):
    app = make_worker(lambda _call: response(items=[milestone()]))
    original = milestone_notices.save_state
    writes = []

    def fail_first(directory, state):
        writes.append(True)
        assert not app.toasts
        if len(writes) == 1:
            raise OSError("synthetic storage error")
        original(directory, state)

    monkeypatch.setattr(milestone_notices, "save_state", fail_first)
    app.phase(LiveLifecyclePhase.MENU)
    app.submit(synced_game())
    assert app.completed.get(timeout=3)
    assert len(app.calls) == len(writes) == 2
    assert len(app.toasts) == 1


def test_local_consent_is_applied_only_after_settings_commit(tmp_path, monkeypatch):
    storage, crypto = MemoryStorage(), SyntheticCrypto()
    state = load_state(tmp_path, storage=storage, crypto=crypto)
    assert state.notify_milestones is False

    def persist(directory, state):
        save_state(directory, state, storage=storage, crypto=crypto)

    def refused(*_args):
        raise OSError("synthetic storage error")

    cell = SimpleNamespace(no_obs=True)
    payload = SettingsPayload(notify_milestones=True)
    log = logging.getLogger(__name__)
    monkeypatch.setattr(runner, "save_state", refused)
    with pytest.raises(OSError, match="synthetic"):
        runner._apply_obs_settings(state, payload, cell, log, state_dir=tmp_path)
    assert state.notify_milestones is False

    monkeypatch.setattr(runner, "save_state", persist)
    runner._apply_obs_settings(state, payload, cell, log, state_dir=tmp_path)
    assert load_state(tmp_path, storage=storage, crypto=crypto).notify_milestones is True


def test_checkbox_beside_result_mode_is_keyboard_reachable_and_saves(tmp_path):
    run_gui_check(tmp_path, '''
ui, win = make_window()
win._go_to_page("settings")
win.show()
app.processEvents()
check = win._milestones_check
combo = win._notifications_combo
assert check.parentWidget().parentWidget() is combo.parentWidget().parentWidget()
assert not check.isChecked() and not saved
combo.setFocus()
QtTest.QTest.keyClick(combo, QtCore.Qt.Key_Tab)
assert app.focusWidget() is check
QtTest.QTest.keyClick(check, QtCore.Qt.Key_Space)
assert check.isChecked() and not saved
win._click_save_settings()
wait_saved(win)
assert saved[-1].notify_milestones is True
assert saved[-1].notify_every_game is False
win.hide()
_restored_ui, restored = make_window(initial_settings=SettingsPayload(notify_milestones=True))
assert restored._milestones_check.isChecked()
''')
