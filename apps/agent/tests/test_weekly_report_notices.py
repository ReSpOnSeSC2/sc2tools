import asyncio
from datetime import date, datetime, timedelta, timezone
import logging
from threading import Event
from types import SimpleNamespace

import pytest
from requests import ConnectionError

from sc2tools_agent import milestone_notices, runner
from sc2tools_agent.live.types import LiveLifecyclePhase
from sc2tools_agent.socket_client import SocketClient
from sc2tools_agent.state import AgentState, _STATE_SAVE_LOCK
from tests._gui_offscreen import run_gui_check
from tests.test_milestone_notices import make_worker, response


def weekly_row(*, weeks_ago=1, **fields):
    year, week, _day = (datetime.now(timezone.utc) - timedelta(weeks=weeks_ago)).isocalendar()
    return {
        "kind": "report.weekly",
        "readAt": None,
        "href": f"/app/reports/weekly/{year:04d}-W{week:02d}",
        "title": "Private report title",
        "body": "Private map and rating",
        **fields,
    }


class SocketEvents:
    def __init__(self):
        self.handlers = {}

    def event(self, callback):
        self.handlers[callback.__name__] = callback

    def on(self, name):
        def register(callback):
            self.handlers[name] = callback
        return register


async def attach_socket(app):
    cell = SimpleNamespace(ui=app.ui)
    socket = SocketClient(
        base_url="https://api.example.test",
        device_token=app.state.device_token,
        on_recompute_games=lambda _: None,
        on_recompute_opp_build=lambda _: None,
        on_weekly_report=runner._weekly_report_signal(cell, app.state),
    )
    await bind(cell, socket)
    return cell, socket


async def bind(cell, socket):
    cell.socket_client = socket
    socket._sio = SocketEvents()
    socket._wire_handlers()
    await socket._sio.handlers["connect"]()


@pytest.fixture(autouse=True)
def observe_weekly_attempts(monkeypatch):
    run = milestone_notices.MilestoneNotices._check_weekly_report

    def observed(worker, ticket):
        try:
            run(worker, ticket)
        finally:
            with worker._changed:
                worker.completed_weekly_attempts = getattr(worker, "completed_weekly_attempts", 0) + 1
                worker._changed.notify_all()

    monkeypatch.setattr(milestone_notices.MilestoneNotices, "_check_weekly_report", observed)


def wait_settled(app, attempts=1):
    worker = app.worker
    with worker._changed:
        assert worker._changed.wait_for(lambda: getattr(worker, "completed_weekly_attempts", 0) >= attempts, timeout=3)


def assert_not_queued(app):
    with app.worker._changed:
        assert app.worker._weekly_ticket is None
    assert not app.calls


def test_weekly_signal_only_catches_up_after_opt_in(make_worker):
    app = make_worker(lambda _: response(items=[weekly_row()]))
    app.phase(LiveLifecyclePhase.MENU)
    assert app.state.notify_weekly_report is False
    _cell, socket = asyncio.run(attach_socket(app))
    assert_not_queued(app)
    app.state.notify_weekly_report = True
    for raw in ({"kind": "report.weekly.other"}, {"kind": "moment.win_streak"}, None):
        asyncio.run(socket._sio.handlers["notifications:changed"](raw))
    assert_not_queued(app)
    asyncio.run(socket._sio.handlers["notifications:changed"]({"kind": "report.weekly"}))
    wait_settled(app)
    assert app.calls == [
        ("GET", "https://api.example.test/v1/me/notifications?kind=report.weekly&unread=true&limit=1",
         "Bearer fake-device-a"),
    ]
    assert app.toasts == [("SC2 Tools weekly report", milestone_notices._WEEKLY_NOTICE)]
    assert "Private" not in str(app.toasts)


def test_reconnect_reads_once_and_never_repeats_delivered_week(make_worker):
    state = AgentState(user_id="owner-a", device_token="fake-device-a", notify_weekly_report=True)
    app = make_worker(lambda _: response(items=[weekly_row()]), settings=state)
    app.phase(LiveLifecyclePhase.MENU)
    asyncio.run(attach_socket(app))
    wait_settled(app)
    assert len(app.calls) == len(app.toasts) == 1
    restored_state = app.reload()
    assert restored_state.notify_weekly_report is True
    assert len(restored_state.weekly_notice_weeks) == 1
    owner_hash = next(iter(restored_state.weekly_notice_weeks))
    assert len(owner_hash) == 64 and owner_hash != state.user_id

    app.worker.close()
    restored = make_worker(lambda _: response(items=[weekly_row()]), settings=restored_state)
    restored.phase(LiveLifecyclePhase.MENU)
    asyncio.run(attach_socket(restored))
    wait_settled(restored)
    assert len(restored.calls) == 1 and not restored.toasts


def test_retired_socket_and_owner_cannot_queue_weekly_reminder(make_worker):
    first_request, release = Event(), Event()

    def send(_index):
        first_request.set()
        assert release.wait(3)
        return response(items=[weekly_row()])

    state = AgentState(user_id="owner-a", device_token="fake-device-a", notify_weekly_report=True)
    app = make_worker(send, settings=state)
    app.phase(LiveLifecyclePhase.MENU)
    cell, socket = asyncio.run(attach_socket(app))
    assert first_request.wait(3)
    try:
        with _STATE_SAVE_LOCK:
            app.state._owner_epoch = object()
            app.state.device_token = "fake-device-b"
            cell.socket_client = socket.with_device_token("fake-device-b")
        asyncio.run(socket._sio.handlers["notifications:changed"]({"kind": "report.weekly"}))
    finally:
        release.set()
    wait_settled(app)
    assert len(app.calls) == 1 and not app.toasts and not app.state.weekly_notice_weeks


def test_weekly_old_api_and_mute_are_quiet(make_worker):
    state = AgentState(user_id="owner-a", device_token="fake-device-a", notify_weekly_report=True)
    app = make_worker(lambda _: response(404), settings=state)
    app.phase(LiveLifecyclePhase.MENU)
    _cell, socket = asyncio.run(attach_socket(app))
    wait_settled(app)
    assert len(app.calls) == 1 and not app.toasts and not app.state.weekly_notice_weeks
    assert app.state.device_token == "fake-device-a"
    app.state.notifications_muted = True
    socket.request_weekly_report()
    with app.worker._changed:
        assert app.worker._weekly_ticket is None
    assert len(app.calls) == 1


def test_only_reads_one_row_and_retries_bounded_transport_error(make_worker, monkeypatch):
    monkeypatch.setattr(milestone_notices, "_WEEKLY_RETRY_DELAYS", (0, 0, 0))

    def send(index):
        if index < 3:
            raise ConnectionError("fixture")
        return response(items=[weekly_row(kind="report.stream"), weekly_row()])

    state = AgentState(user_id="owner-a", device_token="fake-device-a", notify_weekly_report=True)
    app = make_worker(send, settings=state)
    app.phase(LiveLifecyclePhase.MENU)
    asyncio.run(attach_socket(app))
    wait_settled(app)
    assert len(app.calls) == 3 and not app.toasts and not app.state.weekly_notice_weeks


def test_match_start_during_weekly_receipt_write_defers_dispatch(make_worker, monkeypatch):
    monkeypatch.setattr(milestone_notices, "_WEEKLY_RETRY_DELAYS", (0, 0, 0))
    entered, release = Event(), Event()
    state = AgentState(user_id="owner-a", device_token="fake-device-a", notify_weekly_report=True)
    app = make_worker(lambda _: response(items=[weekly_row()]), settings=state)
    save = milestone_notices.save_state

    def slow_save(*args):
        entered.set()
        assert release.wait(3)
        save(*args)

    monkeypatch.setattr(milestone_notices, "save_state", slow_save)
    app.phase(LiveLifecyclePhase.MENU)
    asyncio.run(attach_socket(app))
    assert entered.wait(3)
    try:
        app.phase(LiveLifecyclePhase.MATCH_LOADING)
    finally:
        release.set()
    assert not app.toasts
    app.phase(LiveLifecyclePhase.MATCH_ENDED)
    wait_settled(app)
    assert len(app.calls) == 2 and len(app.toasts) == 1


def test_disable_during_match_releases_undelivered_week(make_worker, monkeypatch):
    monkeypatch.setattr(milestone_notices, "_WEEKLY_RETRY_DELAYS", (0, 0, 0))
    state = AgentState(user_id="owner-a", device_token="fake-device-a", notify_weekly_report=True)
    candidate = weekly_row(weeks_ago=2)
    app = make_worker(lambda _: response(items=[candidate]), settings=state)
    app.phase(LiveLifecyclePhase.MENU)
    _cell, socket = asyncio.run(attach_socket(app))
    wait_settled(app)
    older_receipts = dict(state.weekly_notice_weeks)

    entered, release = Event(), Event()
    save = milestone_notices.save_state

    def slow_save(*args):
        entered.set()
        assert release.wait(3)
        save(*args)

    monkeypatch.setattr(milestone_notices, "save_state", slow_save)
    candidate = weekly_row()
    socket.request_weekly_report()
    assert entered.wait(3)
    try:
        app.phase(LiveLifecyclePhase.MATCH_LOADING)
    finally:
        release.set()
    with _STATE_SAVE_LOCK:
        state.notify_weekly_report = False
        save(app.worker._state_dir, state)
    app.phase(LiveLifecyclePhase.MATCH_ENDED)
    wait_settled(app, 2)
    assert len(app.calls) == 2 and len(app.toasts) == 1
    assert app.reload().weekly_notice_weeks == older_receipts

    with _STATE_SAVE_LOCK:
        state.notify_weekly_report = True
    socket.request_weekly_report()
    wait_settled(app, 3)
    assert len(app.calls) == 3 and len(app.toasts) == 2
    socket.request_weekly_report()
    wait_settled(app, 4)
    assert len(app.toasts) == 2


@pytest.mark.parametrize("finish_before_response", [False, True])
def test_rechecks_week_read_during_match(make_worker, monkeypatch, finish_before_response):
    monkeypatch.setattr(milestone_notices, "_WEEKLY_RETRY_DELAYS", (0, 0, 0))
    entered, release = Event(), Event()

    def send(index):
        if index == 1:
            entered.set()
            assert release.wait(3)
            return response(items=[weekly_row()])
        return response()

    state = AgentState(user_id="owner-a", device_token="fake-device-a", notify_weekly_report=True)
    app = make_worker(send, settings=state)
    app.phase(LiveLifecyclePhase.MENU)
    asyncio.run(attach_socket(app))
    assert entered.wait(3)
    try:
        app.phase(LiveLifecyclePhase.MATCH_LOADING)
        if finish_before_response:
            app.phase(LiveLifecyclePhase.MATCH_ENDED)
    finally:
        release.set()
    if not finish_before_response:
        app.phase(LiveLifecyclePhase.MATCH_ENDED)
    wait_settled(app)
    assert len(app.calls) == 2 and not app.toasts and not app.reload().weekly_notice_weeks


def test_latest_delivery_fences_older_reports_but_keeps_owner_choice(make_worker):
    candidate = weekly_row()
    state = AgentState(user_id="owner-a", device_token="fake-device-a", notify_weekly_report=True)
    app = make_worker(lambda _: response(items=[candidate]), settings=state)
    app.phase(LiveLifecyclePhase.MENU)
    _cell, socket = asyncio.run(attach_socket(app))
    wait_settled(app)
    candidate = weekly_row(weeks_ago=2)
    socket.request_weekly_report()
    wait_settled(app, 2)
    assert len(app.calls) == 2 and len(app.toasts) == 1


def test_weekly_enable_catches_up_only_after_settings_save(make_worker, tmp_path, monkeypatch):
    app = make_worker(lambda _: response(items=[weekly_row()]))
    app.phase(LiveLifecyclePhase.MENU)
    cell, _socket = asyncio.run(attach_socket(app))
    cell.no_obs = True
    payload = runner.SettingsPayload(notify_weekly_report=True)

    def fail_save(*_args):
        raise OSError("synthetic save failure")

    monkeypatch.setattr(runner, "save_state", fail_save)
    with pytest.raises(OSError, match="synthetic"):
        runner._apply_obs_settings(app.state, payload, cell, logging.getLogger(__name__), state_dir=tmp_path)
    assert app.state.notify_weekly_report is False
    assert_not_queued(app)

    monkeypatch.setattr(runner, "save_state", milestone_notices.save_state)
    runner._apply_obs_settings(app.state, payload, cell, logging.getLogger(__name__), state_dir=tmp_path)
    wait_settled(app)
    assert app.reload().notify_weekly_report is True
    assert len(app.toasts) == 1


@pytest.mark.parametrize("raw", [
    {"kind": "report.stream"},
    {"readAt": "2026-11-09"},
    {"href": "https://example.test/app/reports/weekly/2026-W45"},
    {"href": "/app/reports/weekly/2026-W45?unexpected=true"},
    {"href": "/app/reports/weekly/2021-W53"},
    {"href": "/app/reports/weekly/2026-W00"},
    {"href": "/app/reports/weekly/2026-W46"},
    {"href": "/app/reports/weekly/2026-W01"},
])
def test_rejects_noncanonical_or_out_of_window_week(raw):
    good = weekly_row(href="/app/reports/weekly/2026-W45")
    today = date(2026, 11, 12)
    assert milestone_notices._weekly_report_week({"items": [good]}, today) == "2026-W45"
    assert milestone_notices._weekly_report_week({"items": [{**good, **raw}]}, today) is None


def test_weekly_checkbox_follows_milestones_and_saves_independently(tmp_path):
    run_gui_check(tmp_path, """
ui, win = make_window()
win._go_to_page("settings")
win.show()
app.processEvents()
check = win._weekly_report_check
assert not check.isChecked()
win._milestones_check.setFocus()
QtTest.QTest.keyClick(win._milestones_check, QtCore.Qt.Key_Tab)
assert app.focusWidget() is check
QtTest.QTest.keyClick(check, QtCore.Qt.Key_Space)
assert check.isChecked() and not saved
win._click_save_settings()
wait_saved(win)
assert saved[-1].notify_weekly_report is True
assert saved[-1].notify_milestones is False
win.hide()
_restored_ui, restored = make_window(initial_settings=SettingsPayload(notify_weekly_report=True))
assert restored._weekly_report_check.isChecked()
""")
