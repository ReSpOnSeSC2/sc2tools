import threading
import time
from unittest.mock import Mock

import pytest
import requests

from sc2tools_agent.api_client import ApiError, ReplayIngestBusy, DeviceUnauthorized
from sc2tools_agent.errors import classify
from sc2tools_agent.heartbeat import Heartbeat
from sc2tools_agent.state import AgentState
from sc2tools_agent.uploader.queue import UploadQueue, TerminalUploadError
from tests.test_upload_queue import _cfg, _game, _StubApi


@pytest.mark.parametrize("exc,kind,transient", [
    (requests.ConnectionError("DNS"), "offline", True),
    (requests.Timeout("timed out"), "offline", True),
    (TimeoutError(), "offline", True),
    (ApiError(503, "busy"), "server_busy", True),
    (ReplayIngestBusy(5), "server_busy", True),
    (ApiError(429, "wait"), "rate_limited", True),
    (DeviceUnauthorized(401, "revoked"), "signed_out", True),
    (ApiError(403, "forbidden"), "signed_out", True),
    (TerminalUploadError("game_payload_too_large"), "rejected", False),
    (OSError("still writing"), "file", True),
    (RuntimeError("unexpected"), "unknown", True),
])
def test_error_classification_table(exc, kind, transient):
    error = classify(exc)
    assert (error.kind, error.transient, error.detail) == (kind, transient, str(exc))
    assert error.title and error.action
    assert "http_" not in error.title


def test_backoff_grows_caps_resets_and_probe_wakes(tmp_path, monkeypatch):
    states = []
    queue = UploadQueue(cfg=_cfg(tmp_path), state=AgentState(), api=_StubApi(),
                        on_connection_state=lambda *args: states.append(args))
    monkeypatch.setattr("sc2tools_agent.uploader.queue.random.uniform", lambda *_: 1)
    delays = []
    for _ in range(12):
        queue._defer_connection(ConnectionError())
        delays.append(round(queue._retry_at - time.monotonic()))
    assert delays[:5] == [2, 4, 8, 16, 32]
    assert max(delays) == 300
    Heartbeat(Mock(), on_success=queue.retry_now)._send_one()
    assert queue._retry_at == 0 and queue._retry_wake.is_set()
    queue._connection_success()
    queue._defer_connection(ConnectionError())
    assert round(queue._retry_at - time.monotonic()) == 2
    assert states[-2][0] == "online"


def test_real_workers_keep_transients_out_of_failure_feed_and_probe_retries(tmp_path):
    failed = []
    deferred = threading.Event()
    accepted = threading.Event()
    api = _StubApi()
    original = api.upload_games_batch
    attempts = []
    def upload(games):
        attempts.append(games)
        if len(attempts) == 1:
            raise requests.ConnectionError("offline")
        return original(games)
    api.upload_games_batch = upload
    state = AgentState()
    queue = UploadQueue(cfg=_cfg(tmp_path), state=state, api=api,
                        on_failure=lambda *args: failed.append(args),
                        on_connection_state=lambda *args: deferred.set() if args[0] != "online" else None,
                        on_success=lambda _: accepted.set())
    job = _game(tmp_path, "queued.SC2Replay")
    queue.start()
    try:
        queue.submit(job)
        assert deferred.wait(2)
        assert queue.is_pending(job.file_path) and queue.pending_count() == 1
        assert not failed and len(attempts) == 1
        queue.retry_now()
        assert accepted.wait(2)
        assert not failed and len(attempts) == 2
        assert str(job.file_path) in state.uploaded
    finally:
        queue.stop()


def test_live_job_keeps_lane_while_history_waits(tmp_path):
    api = _StubApi()
    queue = UploadQueue(cfg=_cfg(tmp_path), state=AgentState(), api=api)
    history = _game(tmp_path, "history.SC2Replay")
    live = _game(tmp_path, "live.SC2Replay")
    from dataclasses import replace
    live = replace(live, priority=True)
    queue.submit(history)
    queue._defer_connection(ConnectionError())
    # Keep history deferred throughout the assertion, even on a busy runner.
    # Hold the live request until we observe that it bypassed that delay.
    queue._retry_at = time.monotonic() + 60
    live_started = threading.Event()
    release_live = threading.Event()
    upload = api.upload_games_batch

    def hold_live(games):
        if any(game["gameId"] == live.game.game_id for game in games):
            live_started.set()
            assert release_live.wait(5)
        return upload(games)

    api.upload_games_batch = hold_live
    done = threading.Event()
    queue._on_success = lambda _: done.set()
    queue.start()
    try:
        queue.submit(live)
        assert live_started.wait(5)
        assert queue.is_pending(history.file_path)
        release_live.set()
        assert done.wait(5)
        assert api.calls[0]["gameId"] == live.game.game_id
    finally:
        release_live.set()
        queue.stop()


def test_permanent_api_rejection_is_one_terminal_outcome(tmp_path):
    api = _StubApi()
    api.upload_games_batch = Mock(side_effect=ApiError(400, "invalid_game"))
    failed = threading.Event()
    outcomes = []
    state = AgentState()
    queue = UploadQueue(cfg=_cfg(tmp_path), state=state, api=api,
                        on_failure=lambda *args: (outcomes.append(args), failed.set()))
    job = _game(tmp_path, "bad.SC2Replay")
    queue.start()
    try:
        queue.submit(job)
        assert failed.wait(2)
        assert len(outcomes) == 1 and isinstance(outcomes[0][1], TerminalUploadError)
        assert state.uploaded[str(job.file_path)] == "rejected"
        assert not queue.is_pending(job.file_path)
        assert api.upload_games_batch.call_count == 1
    finally:
        queue.stop()


def test_toasts_once_after_ten_minutes_and_actual_recovered_count(monkeypatch):
    from sc2tools_agent.runner import _Multiplexer
    sink = Mock()
    ui = _Multiplexer(sink)
    monkeypatch.setattr(time, "time", lambda: 1700)
    ui.on_connection_state("offline", 1000, 1800, 312)
    ui.on_connection_state("offline", 1000, 1800, 312)
    assert sink.show_notice.call_count == 1
    ui.on_upload_success("one")
    ui.on_upload_success("two")
    ui.on_connection_state("online", 1000, 0, 0)
    assert sink.show_notice.call_count == 2
    assert sink.show_notice.call_args.args == ("Back online: 2 replays synced",)


def test_auth_hold_stops_actual_workers_without_dropping_jobs(tmp_path):
    done = threading.Event()
    api = _StubApi()
    queue = UploadQueue(cfg=_cfg(tmp_path), state=AgentState(), api=api,
                        on_success=lambda _: done.set())
    job = _game(tmp_path, "held.SC2Replay")
    queue.submit(job)
    queue.hold_auth(True)
    queue.start()
    try:
        assert not done.wait(.25)
        assert not api.calls and queue.pending_count() == 1
        assert queue.is_pending(job.file_path)
        queue.replace_api(api)
        queue.hold_auth(False)
        assert done.wait(2)
        assert queue.pending_count() == 0
    finally:
        queue.stop()


def test_queue_honors_retry_after_without_blocking_probe(tmp_path):
    queue = UploadQueue(cfg=_cfg(tmp_path), state=AgentState(), api=_StubApi())
    queue._defer_connection(ApiError(429, "limited", retry_after_seconds=60))
    assert 59 <= queue._retry_at - time.monotonic() <= 60
    queue.retry_now()
    assert queue._retry_at == 0


def test_console_readable_error_and_plain_string(capsys):
    from sc2tools_agent.ui.console import ConsoleUI
    ui = ConsoleUI()
    ui.on_upload_failed("one", "Plain error")
    ui.on_upload_failed("two", classify(TerminalUploadError("technical")))
    output = capsys.readouterr().out
    assert "one: Plain error" in output
    assert "two: This replay could not be accepted" in output
    assert "built-in method" not in output
