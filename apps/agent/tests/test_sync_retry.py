"""Native reason repair: real cursor transactions, no native process/network."""
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import Mock
import threading

import pytest

from sc2tools_agent.state import AgentState, _STATE_SAVE_LOCK, load_state
from sc2tools_agent.sync_retry import RETRY_REASONS, RetryStopped, SyncRetryController, publish_owned_toons, replay_ticket
from sc2tools_agent.uploader.queue import UploadQueue
from tests.test_upload_queue import _cfg, _game, _StubApi


def queue_fixture(tmp_path, reason="player_unresolved"):
    job = _game(tmp_path, "repair.SC2Replay")
    state = AgentState(user_id="owner", device_token="synthetic", uploaded={str(job.file_path): "skipped:" + reason})
    queue = UploadQueue(cfg=_cfg(tmp_path), state=state, api=_StubApi())
    return job, state, queue


def test_owner_ticket_is_retired_on_aba_and_never_persists_toons(tmp_path):
    _job, state, _queue = queue_fixture(tmp_path)
    ticket = replay_ticket(state)
    with _STATE_SAVE_LOCK:
        assert publish_owned_toons(state, {"pulseIds": ["bad", "1-S2-1-42", "1-S2-1-42", "2-S2-1-43"]}, ticket)
    assert replay_ticket(state).toons == ("1-S2-1-42", "2-S2-1-43")
    from sc2tools_agent.state import save_state
    save_state(tmp_path, state)
    assert "_owned_toons" not in (tmp_path / "agent.json").read_text()
    with _STATE_SAVE_LOCK:
        state._owner_epoch = object()  # even the same account/token gets a new lifetime
    assert not ticket.current(state) and replay_ticket(state).toons == ()
    assert not publish_owned_toons(state, {"pulseId": "1-S2-1-42"}, ticket)


@pytest.mark.parametrize("reason", sorted(RETRY_REASONS))
def test_explicit_update_retry_only_clears_current_matching_existing_nonpending_paths(tmp_path, reason):
    job, state, queue = queue_fixture(tmp_path, reason)
    pending = _game(tmp_path, "pending.SC2Replay")
    other = _game(tmp_path, "other.SC2Replay")
    state.uploaded.update({str(pending.file_path): "skipped:" + reason, str(other.file_path): "skipped:ai_game",
                           "missing": "skipped:" + reason, "success": "2026-11-01T00:00:00Z", "date": "filtered"})
    queue._pending_paths.add(str(pending.file_path))
    before = state.uploaded.copy()
    assert queue.retry_sync_reason(reason, current_guard=lambda: True) == [str(job.file_path)]
    expected = {key: value for key, value in before.items() if key != str(job.file_path)}
    assert state.uploaded == expected == load_state(tmp_path).uploaded
    assert not queue.is_resync_requested()


@pytest.mark.parametrize("reason", ["filtered", "ai_game", "resumed_replay", "no_result", "unknown"])
def test_remote_retry_never_widens_local_retry_policy(tmp_path, reason):
    _job, state, queue = queue_fixture(tmp_path)
    before = state.uploaded.copy()
    with pytest.raises(ValueError):
        queue.retry_sync_reason(reason, current_guard=lambda: True)
    assert state.uploaded == before


@pytest.mark.parametrize("exception", [OSError, ValueError, RuntimeError])
def test_every_failed_state_save_restores_exact_cursor(tmp_path, monkeypatch, exception):
    _job, state, queue = queue_fixture(tmp_path)
    before = state.uploaded.copy()
    monkeypatch.setattr("sc2tools_agent.uploader.queue.save_state", Mock(side_effect=exception("private details")))
    with pytest.raises(exception):
        queue.retry_sync_reason("player_unresolved", current_guard=lambda: True)
    assert state.uploaded == before


def test_held_filesystem_read_rechecks_marker_and_owner_before_mutation(tmp_path, monkeypatch):
    from pathlib import Path
    job, state, queue = queue_fixture(tmp_path)
    original = Path.is_file
    def replaced(path):
        hit = original(path)
        if path == job.file_path:
            with _STATE_SAVE_LOCK:
                state.uploaded[str(path)] = "2026-11-01T00:00:00Z"
        return hit
    monkeypatch.setattr(Path, "is_file", replaced)
    assert queue.retry_sync_reason("player_unresolved", current_guard=lambda: True) == []
    assert state.uploaded[str(job.file_path)] == "2026-11-01T00:00:00Z"
    state.uploaded[str(job.file_path)] = "skipped:player_unresolved"
    ticket = replay_ticket(state)
    def changed(path):
        hit = original(path)
        with _STATE_SAVE_LOCK:
            state._owner_epoch = object()
        return hit
    monkeypatch.setattr(Path, "is_file", changed)
    with pytest.raises(RetryStopped):
        queue.retry_sync_reason("player_unresolved", current_guard=lambda: ticket.current(state))
    assert state.uploaded[str(job.file_path)] == "skipped:player_unresolved"


def test_rollback_cannot_overwrite_concurrent_new_marker(tmp_path, monkeypatch):
    from sc2tools_agent import watcher
    job, state, queue = queue_fixture(tmp_path)
    instance = watcher.ReplayWatcher.__new__(watcher.ReplayWatcher)
    instance._state, instance._stop = state, threading.Event()
    ticket = replay_ticket(state)
    entered, release, writer_started = threading.Event(), threading.Event(), threading.Event()
    def failed_save(*_):
        entered.set(); assert release.wait(3)
        raise OSError("synthetic")
    monkeypatch.setattr("sc2tools_agent.uploader.queue.save_state", failed_save)
    with ThreadPoolExecutor(max_workers=2) as pool:
        repair = pool.submit(queue.retry_sync_reason, "player_unresolved", current_guard=lambda: True)
        assert entered.wait(3)
        def write():
            writer_started.set()
            return instance._mark_replay(job.file_path, "skipped:parse_failed", ticket)
        writer = pool.submit(write); assert writer_started.wait(3)
        assert not writer.done()
        release.set()
        with pytest.raises(OSError): repair.result(timeout=3)
        # Retry restores the old marker before the writer gets the state lock;
        # a held stale parse never overwrites that or a newer terminal outcome.
        assert writer.result(timeout=3) is False
    assert state.uploaded[str(job.file_path)] == "skipped:player_unresolved"


def test_submit_checks_ticket_inside_queue_and_state_locks(tmp_path):
    job, state, queue = queue_fixture(tmp_path)
    state.uploaded.clear()
    ticket = replay_ticket(state)
    entered = threading.Event()
    queue._lock.acquire()
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            def submit():
                entered.set()
                return queue.submit(job, current_guard=lambda: ticket.current(state))
            future = pool.submit(submit); assert entered.wait(3)
            with _STATE_SAVE_LOCK:
                state.device_token, state.user_id, state._owner_epoch = "replacement", "another", object()
            queue._lock.release()
            assert future.result(timeout=3) is False
    finally:
        if queue._lock.locked(): queue._lock.release()
    assert not queue._pending_paths and not queue._pending_owners and queue._q.empty()


@pytest.mark.parametrize("retire", ["owner", "stop", "connection", "expiry"])
def test_profile_refresh_cannot_publish_or_clear_cursor_after_retirement(tmp_path, monkeypatch, retire):
    _job, state, queue = queue_fixture(tmp_path)
    stop = threading.Event(); connected = [True]; now = [1.0]
    cell = SimpleNamespace(upload=queue, watcher=Mock(), recent_history=Mock())
    controller = SyncRetryController(cfg=_cfg(tmp_path), state=state, cell=cell, stop_event=stop, clock=lambda: now[0])
    def profile(_self, **kwargs):
        assert kwargs == {"interactive": True}
        if retire == "owner":
            with _STATE_SAVE_LOCK: state.user_id, state._owner_epoch = "another", object()
        elif retire == "stop": stop.set()
        elif retire == "connection": connected[0] = False
        else: now[0] = 3.0
        return {"pulseIds": ["1-S2-1-42"]}
    monkeypatch.setattr("sc2tools_agent.api_client.ApiClient.get_profile", profile)
    code, count = controller.handle({"reason": "player_unresolved", "expiresAt": 2000}, "synthetic", lambda: connected[0])
    assert (code, count) == ("expired" if retire == "expiry" else "owner_changed", 0)
    assert state.uploaded and not hasattr(state, "_owned_toons")
    cell.watcher.request_immediate_sweep.assert_not_called(); cell.recent_history.refresh.assert_not_called()


def test_refresh_and_durable_repair_survive_observational_hook_failure(tmp_path, monkeypatch):
    _job, state, queue = queue_fixture(tmp_path)
    cell = SimpleNamespace(upload=queue, watcher=Mock(), recent_history=Mock())
    cell.watcher.request_immediate_sweep.side_effect = RuntimeError("private")
    cell.recent_history.refresh.side_effect = RuntimeError("private")
    monkeypatch.setattr("sc2tools_agent.api_client.ApiClient.get_profile", lambda *_a, **_k: {"pulseIds": ["1-S2-1-42", "2-S2-1-43"]})
    controller = SyncRetryController(cfg=_cfg(tmp_path), state=state, cell=cell, stop_event=threading.Event(), clock=lambda: 1.0)
    assert controller.handle({"reason": "player_unresolved", "expiresAt": 2000}, "synthetic", lambda: True) == ("accepted", 1)
    assert replay_ticket(state).toons == ("1-S2-1-42", "2-S2-1-43")
    assert state.uploaded == {} == load_state(tmp_path).uploaded


def test_cloud_name_cache_and_identity_publication_share_owner_guard(tmp_path):
    from sc2tools_agent.player_handle import read_cache, refresh_from_cloud, write_cache
    state = AgentState(user_id="owner", device_token="synthetic")
    ticket = replay_ticket(state); write_cache(tmp_path, "Current")
    def profile():
        with _STATE_SAVE_LOCK: state._owner_epoch = object()
        return {"displayName": "Old private name", "pulseIds": ["1-S2-1-42"]}
    publish = Mock()
    assert refresh_from_cloud(SimpleNamespace(get_profile=profile), tmp_path,
        current_guard=lambda: ticket.current(state), on_profile=publish) is None
    assert read_cache(tmp_path) == "Current"; publish.assert_not_called()


def test_contact_refresh_start_failure_releases_admission_and_recovers_after_backoff(tmp_path, monkeypatch):
    from sc2tools_agent.pairing.recovery import RuntimeRecovery
    from sc2tools_agent.pairing import recovery as recovery_module
    state = AgentState(user_id="owner", device_token="synthetic")
    profile = Mock(return_value={"pulseIds": ["1-S2-1-42"]})
    cell = SimpleNamespace(api=SimpleNamespace(get_profile=profile), upload=Mock(), watcher=Mock(), ui=None)
    recovery = RuntimeRecovery(cell=cell, cfg=_cfg(tmp_path), state=state, ui=Mock(), stop_event=threading.Event())
    now = [100.0]
    monkeypatch.setattr(recovery_module.time, "monotonic", lambda: now[0])
    with monkeypatch.context() as failed:
        start = Mock(side_effect=RuntimeError("synthetic pre-start failure"))
        failed.setattr(threading.Thread, "start", start)
        recovery.connected()  # Must remain an advisory heartbeat success.
        assert not recovery._identity_lock.locked()
        assert recovery._identity_retry_at == 130.0
        profile.assert_not_called()
        now[0] = 110.0
        recovery.connected()
        start.assert_called_once()  # Failure cannot create an immediate spin.
    now[0] = 131.0
    recovery.connected()
    assert recovery._identity_lock.acquire(timeout=3)
    recovery._identity_lock.release()
    profile.assert_called_once_with(interactive=True)
    assert replay_ticket(state).toons == ("1-S2-1-42",)
