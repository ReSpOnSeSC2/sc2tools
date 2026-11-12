from dataclasses import replace
from datetime import datetime, timedelta, timezone
import json
import logging
import threading
from types import SimpleNamespace

import pytest
from requests import Response

from sc2tools_agent import milestone_notices, recent_games, runner
from sc2tools_agent.agent_credentials import CredentialIntent
from sc2tools_agent.live.types import LiveLifecycleEvent, LiveLifecyclePhase
from sc2tools_agent.runner import _Multiplexer, _start_milestone_notices
from sc2tools_agent.state import (
    AgentState, _STATE_SAVE_LOCK, commit_state_credentials, credential_revision, load_state, save_state,
)
from sc2tools_agent.sync_retry import replay_ticket
from sc2tools_agent.ui.console import ConsoleUI
from sc2tools_agent.ui.gui import SettingsPayload
from sc2tools_agent.ui.tray import TrayUI
from sc2tools_agent.uploader.queue import UploadQueue
from tests._gui_offscreen import run_gui_check
from tests.test_agent_credentials import MemoryStorage, SyntheticCrypto
from tests.test_upload_queue import _cfg, _game, _StubApi


def synced_game(**changes):
    return {"_owner": "owner-a", "gameId": "game/one", "dateIso": datetime.now(timezone.utc).isoformat(), **changes}


def milestone(**changes):
    return {
        "id": "win-streak", "href": "/app/game/game%2Fone", "kind": "moment.win_streak",
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
    monkeypatch.setattr(milestone_notices, "_SETTLE_DELAY", 0)
    save(tmp_path, state)
    workers = []

    def start(request, *, settings=state):
        calls, toasts = [], []

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

        def wait_done():
            with worker._changed:
                return worker._changed.wait_for(lambda: worker._latest is None, timeout=3)

        def relink(token):
            with _STATE_SAVE_LOCK:
                settings._owner_epoch = object()
                commit_state_credentials(tmp_path, settings, device=CredentialIntent("set", token),
                                         expected_device_revision=credential_revision(settings, "device"),
                                         expected_owner_epoch=settings._owner_epoch,
                                         device_owner=(settings.user_id, datetime.now(timezone.utc).isoformat()),
                                         storage=state_storage, crypto=crypto)

        return SimpleNamespace(
            state=settings, calls=calls, toasts=toasts, wait_done=wait_done,
            worker=worker, ui=ui, relink=relink,
            submit=lambda game: ui.on_game_synced("inert.SC2Replay", game, replay_ticket(settings).epoch),
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
    app = make_worker(lambda call: response(items=rows if call >= 2 else ()))
    app.phase(LiveLifecyclePhase.MENU)
    app.submit(synced_game())
    assert app.wait_done()
    assert app.toasts == [("Winning streak", "Five wins in a row")]
    assert app.calls == [
        ("GET", "https://api.example.test/v1/me/notifications?kind=milestones&unread=true&limit=20", "Bearer fake-device-a"),
    ] * 3


def test_waits_for_the_newest_row_when_bell_inserts_multiple_milestones(make_worker):
    older = milestone()
    newer = milestone(id="personal-best", title="Personal best", body="A new rank")
    app = make_worker(lambda call: response(items=[older] if call == 1 else [newer, older]))
    app.phase(LiveLifecyclePhase.MENU)
    app.submit(synced_game())
    assert app.wait_done()
    assert app.toasts == [("Personal best", "A new rank")]
    assert len(app.calls) == 3


def test_holds_notice_when_game_starts_during_request(make_worker, monkeypatch):
    fetched, release, waiting = threading.Event(), threading.Event(), threading.Event()

    def request(call):
        if call == 2:
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
    assert app.wait_done()
    assert app.toasts == [("Winning streak", "Five wins in a row")]
    assert len(app.calls) == 2


def test_match_start_during_receipt_write_holds_the_notice(make_worker, monkeypatch):
    saving, release, published, holding = (threading.Event() for _ in range(4))
    app = make_worker(lambda _call: response(items=[milestone()]))
    original = milestone_notices.save_state
    wait_for = app.worker._changed.wait_for

    def save(directory, state):
        saving.set()
        assert release.wait(3)
        original(directory, state)

    def track_wait(predicate, timeout=None):
        if timeout is None and saving.is_set() and not predicate():
            holding.set()
        return wait_for(predicate, timeout=timeout)

    def start_match():
        app.phase(LiveLifecyclePhase.MATCH_LOADING)
        published.set()

    monkeypatch.setattr(milestone_notices, "save_state", save)
    monkeypatch.setattr(app.worker._changed, "wait_for", track_wait)
    app.phase(LiveLifecyclePhase.MENU)
    app.submit(synced_game())
    match_thread = threading.Thread(target=start_match)
    try:
        assert saving.wait(3)
        match_thread.start()
        assert published.wait(1)
    finally:
        release.set()
        if match_thread.ident is not None:
            match_thread.join(timeout=3)
    assert holding.wait(3)
    assert app.toasts == []
    app.phase(LiveLifecyclePhase.MATCH_ENDED)
    assert app.wait_done()
    assert app.toasts == [("Winning streak", "Five wins in a row")]


def test_retries_a_fresh_sync_after_a_rate_limited_attempt(make_worker):
    app = make_worker(lambda call: response(429) if call == 1 else response(items=[milestone()]))
    game = synced_game()
    app.phase(LiveLifecyclePhase.MENU)
    app.submit(game)
    assert app.wait_done()
    assert len(app.calls) == 1 and not app.toasts
    app.submit(game)
    assert app.wait_done()
    assert len(app.calls) == 3
    assert app.toasts == [("Winning streak", "Five wins in a row")]


def test_dedupes_repeated_upload_and_survives_real_state_roundtrip(make_worker):
    game = synced_game()
    first = make_worker(lambda _call: response(items=[milestone()]))
    first.phase(LiveLifecyclePhase.IDLE)
    first.submit(game)
    assert first.wait_done()
    first.submit(game)
    first.worker.close()
    assert len(first.toasts) == 1 and len(first.calls) == 2
    restored = first.reload()
    assert restored.notify_milestones is True
    assert len(restored.milestone_notice_receipts) == 1
    second = make_worker(lambda _call: pytest.fail("already delivered"), settings=restored)
    second.submit(game)
    assert second.worker._latest is None


def test_old_api_stops_without_unlinking_or_marking_seen(make_worker):
    app = make_worker(lambda _call: response(404))
    app.phase(LiveLifecyclePhase.MENU)
    app.submit(synced_game())
    assert app.wait_done()
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
    assert app.wait_done()
    assert len(app.calls) == 1
    assert not app.toasts and not app.state.milestone_notice_receipts


def test_same_owner_relink_rejects_retired_upload_context(make_worker, tmp_path, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    app = make_worker(lambda _call: response(items=[milestone()]))
    replay_ticket(app.state)
    queue = UploadQueue(cfg=_cfg(tmp_path), state=app.state, api=_StubApi(),
                        on_game_synced_current=app.ui.on_game_synced)
    job = replace(_game(tmp_path, "accepted.SC2Replay", date_iso=datetime.now(timezone.utc).isoformat()),
                  priority=True)
    original = recent_games.build_game_summary

    def build_summary(*args, **kwargs):
        entered.set()
        assert release.wait(3)
        return original(*args, **kwargs)

    monkeypatch.setattr(recent_games, "build_game_summary", build_summary)
    row = {"gameId": "game/one"}
    callback = threading.Thread(target=queue._notify_game_synced, args=(job, row, "owner-a"),
                                kwargs={"context": queue._upload_context()})
    callback.start()
    try:
        assert entered.wait(3)
        app.relink("fake-device-renewed")
    finally:
        release.set()
        callback.join(timeout=3)
    assert not callback.is_alive()
    assert app.worker._latest is None and not app.calls and not app.toasts

    queue._notify_game_synced(job, row, "owner-a", context=queue._upload_context())
    app.phase(LiveLifecyclePhase.MENU)
    assert app.wait_done()
    assert [call[2] for call in app.calls] == ["Bearer fake-device-renewed"] * 2
    assert app.toasts == [("Winning streak", "Five wins in a row")]


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
    assert app.wait_done()
    assert len(app.calls) == 3 and len(writes) == 2
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
