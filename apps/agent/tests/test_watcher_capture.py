"""Automatic engine capture stays serialized without blocking parser callbacks."""
from concurrent.futures import Future
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
import threading

import pytest

from sc2tools_agent import replay_capture, watcher as watcher_module
from sc2tools_agent.config import AgentConfig
from sc2tools_agent.socket_client import _ENGINE_REBUILD_LOCK
from sc2tools_agent.state import AgentState, save_state


def _game(*, recorded=False, complete=True):
    return SimpleNamespace(date_iso="2026-09-22T12:00:00Z", map_playback={"fidelity": {
        "positions": "engine" if recorded else "tracker", "complete": complete,
        "sampleSeconds": 0.1786 if recorded else None,
        "attacks": "observed" if recorded else "orders",
        "effects": "observed" if recorded else "orders",
        "creep": "observed" if recorded else "estimated",
    }})


@pytest.fixture
def setup(monkeypatch, tmp_path):
    monkeypatch.setenv("SC2TOOLS_PARSE_USE_PROCESSES", "0")
    monkeypatch.setattr(watcher_module, "_wait_for_file_ready", lambda *_: True)
    state = AgentState(replay_capture_enabled=True)
    save_state(tmp_path, state)
    uploaded, notices = [], []
    uploaded_event = threading.Event()

    def submit(job):
        uploaded.append(job)
        uploaded_event.set()
        return True

    upload = SimpleNamespace(submit=submit, is_pending=lambda p: any(j.file_path == p for j in uploaded),
                             pending_count=lambda: 0)
    cfg = AgentConfig(api_base="http://localhost:0", state_dir=tmp_path,
                      replay_folder=None, poll_interval_sec=10, parse_concurrency=1)
    watcher = watcher_module.ReplayWatcher(cfg=cfg, state=state, upload=upload,
                                           on_capture_notice=notices.append)
    path = tmp_path / "game.SC2Replay"
    path.write_bytes(b"fake replay")
    tracker, recorded = _game(), _game(recorded=True)
    parser = Mock(side_effect=[(tracker, None), (recorded, None)])
    monkeypatch.setattr(watcher_module, "parse_replay_for_cloud_ex", parser)
    capture = Mock()
    monkeypatch.setattr(replay_capture, "capture_exact_replay", capture)
    release = threading.Event()
    yield SimpleNamespace(watcher=watcher, path=path, state=state, uploaded=uploaded,
                          uploaded_event=uploaded_event, notices=notices, parser=parser,
                          capture=capture, tracker=tracker, recorded=recorded, release=release)
    release.set()
    watcher.stop()
    watcher._capture_executor.shutdown(wait=True, cancel_futures=True)


@pytest.mark.parametrize("process_result", [False, True])
def test_enabled_sync_captures_before_upload_without_blocking_parser(setup, process_result):
    s = setup
    started = threading.Event()

    def capture(*_args, **kwargs):
        kwargs["notify_start"]("Recording this replay")
        started.set()
        assert s.release.wait(3)

    s.capture.side_effect = capture
    s.watcher._inflight.add(str(s.path))
    if process_result:
        s.parser.side_effect = [(s.recorded, None)]
        result = Future()
        result.set_result(("game", str(s.path), s.tracker))
        s.watcher._on_worker_done(result, str(s.path))
    else:
        s.watcher._handle_replay(s.path, priority=True)
    assert started.wait(2)
    assert str(s.path) in s.watcher._inflight
    assert s.uploaded == []
    assert s.notices == ["Recording this replay"]
    s.release.set()
    assert s.uploaded_event.wait(2)
    s.watcher._capture_executor.shutdown(wait=True)
    assert len(s.uploaded) == 1
    assert s.uploaded[0].game is s.recorded
    assert s.uploaded[0].priority is (not process_result)
    assert str(s.path) not in s.watcher._inflight
    assert s.capture.call_count == 1


def test_disabled_sync_uploads_tracker_without_engine_work(setup):
    s = setup
    s.state.replay_capture_enabled = False
    save_state(s.watcher._cfg.state_dir, s.state)
    s.watcher._handle_replay(s.path)
    s.capture.assert_not_called()
    assert s.uploaded[0].game is s.tracker


@pytest.mark.parametrize("complete", [True, False])
def test_saved_engine_payload_uploads_while_manual_request_owns_capture_lock(setup, complete):
    s = setup
    existing = _game(recorded=True, complete=complete)
    s.parser.side_effect = [(existing, None)]
    with _ENGINE_REBUILD_LOCK:
        s.watcher._handle_replay(s.path)
        assert s.uploaded_event.is_set()
    s.capture.assert_not_called()
    assert s.uploaded[0].game is existing


def test_capture_failure_preserves_normal_analysis_and_notifies(setup):
    s = setup
    s.capture.side_effect = RuntimeError("Missing StarCraft runtime")
    s.watcher._handle_replay(s.path)
    assert s.uploaded_event.wait(2)
    assert s.uploaded[0].game is s.tracker
    assert "Missing StarCraft runtime" in s.notices[0]
    assert "Normal replay analysis will still sync" in s.notices[0]


def test_unuploadable_recording_preserves_original_normal_analysis(setup):
    s = setup
    s.parser.side_effect = [(s.tracker, None), (None, "playback_budget_exceeded")]
    s.watcher._handle_replay(s.path)
    assert s.uploaded_event.wait(2)
    assert s.uploaded[0].game is s.tracker
    assert "playback_budget_exceeded" in s.notices[0]


def test_postcapture_tracker_fallback_is_reported_as_failure(setup):
    s = setup
    s.parser.side_effect = [(s.tracker, None), (_game(), None)]
    s.watcher._handle_replay(s.path)
    assert s.uploaded_event.wait(2)
    assert s.uploaded[0].game is s.tracker
    assert "Recorded movement data could not be loaded" in s.notices[0]


def test_low_resolution_cache_is_recorded_again(setup):
    s = setup
    low_resolution = _game(recorded=True)
    low_resolution.map_playback["fidelity"]["sampleSeconds"] = 1.0
    s.parser.side_effect = [(low_resolution, None), (s.recorded, None)]
    s.watcher._handle_replay(s.path)
    assert s.uploaded_event.wait(2)
    s.capture.assert_called_once()
    assert s.uploaded[0].game is s.recorded


def test_capture_backlog_is_bounded_and_fresh_replays_overtake_history(setup):
    s = setup
    s.watcher._parse_inflight_limit = 2
    started = threading.Event()
    order = []

    def capture(path, *_args, **_kwargs):
        order.append(path)
        if path == s.path:
            started.set()
            assert s.release.wait(3)

    s.capture.side_effect = capture
    s.parser.side_effect = lambda *_args, **_kwargs: (s.recorded, None)

    def enqueue(path, priority=False):
        s.watcher._inflight.add(str(path))
        assert s.watcher._queue_automatic_capture(path, s.tracker, priority=priority)

    enqueue(s.path)
    assert started.wait(2)
    older = s.path.with_name("older.SC2Replay")
    overflow = s.path.with_name("overflow.SC2Replay")
    fresh = s.path.with_name("fresh.SC2Replay")
    enqueue(older)
    enqueue(overflow)
    assert str(overflow) not in s.watcher._inflight
    assert str(overflow) not in s.state.uploaded
    enqueue(fresh, priority=True)
    assert str(older) not in s.watcher._inflight
    assert str(older) not in s.state.uploaded
    assert len(s.watcher._capture_queue) == 1
    assert len(s.watcher._inflight) == 2
    s.release.set()
    s.watcher._capture_executor.shutdown(wait=True)
    assert order == [s.path, fresh]
    assert [job.file_path for job in s.uploaded] == order
    assert s.uploaded[-1].priority is True


def test_disabling_while_waiting_for_manual_capture_uploads_its_saved_recording(setup):
    s = setup
    with _ENGINE_REBUILD_LOCK:
        s.watcher._handle_replay(s.path)
        assert s.uploaded == []
        s.state.replay_capture_enabled = False
        save_state(s.watcher._cfg.state_dir, s.state)
        assert not s.uploaded_event.wait(0.05)
    assert s.uploaded_event.wait(2)
    s.capture.assert_not_called()
    assert s.uploaded[0].game is s.recorded


def test_shutdown_cancels_capture_and_leaves_replay_for_next_sync(setup):
    s = setup
    started, cancelled = threading.Event(), threading.Event()

    def capture(*_args, **kwargs):
        started.set()
        assert s.release.wait(3)
        assert kwargs["cancel_requested"]()
        cancelled.set()
        raise replay_capture.ReplayCaptureDisabled("Stopped")

    s.capture.side_effect = capture
    s.watcher._inflight.add(str(s.path))
    s.watcher._handle_replay(s.path)
    assert started.wait(2)
    s.watcher.stop()
    s.release.set()
    assert cancelled.wait(2)
    s.watcher._capture_executor.shutdown(wait=True)
    assert s.uploaded == []
    assert str(s.path) not in s.state.uploaded
    assert str(s.path) not in s.watcher._inflight


def test_skipped_replay_never_starts_capture(setup):
    s = setup
    s.parser.side_effect = [(None, "not_1v1")]
    s.watcher._handle_replay(s.path)
    s.capture.assert_not_called()
    assert s.uploaded == []
