"""Historical ingest yields during matches without holding fresh replays."""

from dataclasses import replace
from concurrent.futures import ThreadPoolExecutor
import queue
import threading

from sc2tools_agent.game_activity import GameActivityGate
from sc2tools_agent.state import AgentState, _STATE_SAVE_LOCK
from sc2tools_agent.uploader.queue import UploadQueue, _PRIORITY_OVERFLOW_LIMIT
from tests.test_upload_queue import _cfg, _game, _StubApi, _wait_for


def test_match_hold_preserves_history_and_accepts_live_game_then_resumes(tmp_path, monkeypatch):
    clock = [1000.0]
    gate = GameActivityGate(clock=lambda: clock[0])
    gate.on_event("match_loading")
    state = AgentState(device_token="t")
    api = _StubApi()
    failures = []
    q = UploadQueue(cfg=_cfg(tmp_path), state=state, api=api,
                    on_failure=lambda *_args: failures.append(True))
    q.set_activity_gate(gate)
    history = [_game(tmp_path, f"held-{index}.SC2Replay") for index in range(2)]
    live = replace(_game(tmp_path, "fresh.SC2Replay"), priority=True)
    payload_ids = []
    original_payload = q._payload_for_job

    def payload(job):
        payload_ids.append(job.game.game_id)
        return original_payload(job)

    monkeypatch.setattr(q, "_payload_for_job", payload)
    for job in history:
        assert q.submit(job)
    # Cover work retained in both lanes, including a previous transient retry.
    item = q._q.get_nowait()
    q._retry_q.put_nowait(item)
    q._q.task_done()
    q.start()
    try:
        assert _wait_for(lambda: q._retry_q.qsize() > 0)
        assert not api.calls and not payload_ids and not state.uploaded
        assert q.pending_count() == 2

        assert q.submit(live)
        assert _wait_for(lambda: str(live.file_path) in state.uploaded)
        assert [call["gameId"] for call in api.calls] == [live.game.game_id]
        assert payload_ids == [live.game.game_id]
        assert q.pending_count() == 2

        # The shared gate retains its existing post-game grace period.
        gate.on_event("match_ended")
        clock[0] += 19
        assert gate.busy
        q.retry_now()
        assert not any(str(job.file_path) in state.uploaded for job in history)
        clock[0] += 1
        assert not gate.busy
        assert _wait_for(lambda: q.pending_count() == 0)
        assert {call["gameId"] for call in api.calls} == {
            live.game.game_id, *(job.game.game_id for job in history),
        }
        assert len(api.calls) == 3
        assert not failures
        assert _wait_for(lambda: q._q.unfinished_tasks == q._retry_q.unfinished_tasks == 0)
    finally:
        q.stop()


def test_match_hold_can_be_disabled_for_history(tmp_path):
    gate = GameActivityGate()
    gate.on_event("match_started")
    state = AgentState(device_token="t", pause_history_in_game=False)
    api = _StubApi()
    q = UploadQueue(cfg=_cfg(tmp_path), state=state, api=api)
    q.set_activity_gate(gate)
    job = _game(tmp_path, "opted-in-history.SC2Replay")
    q.start()
    try:
        assert q.submit(job)
        assert _wait_for(lambda: str(job.file_path) in state.uploaded)
        assert [call["gameId"] for call in api.calls] == [job.game.game_id]
        assert gate.busy
    finally:
        q.stop()


def test_full_history_queue_cannot_block_a_fresh_priority_game(tmp_path, monkeypatch):
    import sc2tools_agent.uploader.queue as queue_module

    monkeypatch.setattr(queue_module, "_BACKPRESSURE_TIMEOUT_SEC", 0.05)
    gate = GameActivityGate()
    gate.on_event("match_started")
    state = AgentState(device_token="t")
    api = _StubApi()
    q = UploadQueue(cfg=_cfg(tmp_path), state=state, api=api)
    q._q = queue.PriorityQueue(maxsize=1)
    q.set_activity_gate(gate)
    history = _game(tmp_path, "full-history.SC2Replay")
    live = replace(_game(tmp_path, "full-queue-live.SC2Replay"), priority=True)
    assert q.submit(history)
    assert q._q.full()
    assert q.submit(live)
    assert q.pending_count() == 2
    q.start()
    try:
        assert _wait_for(lambda: str(live.file_path) in state.uploaded)
        assert [call["gameId"] for call in api.calls] == [live.game.game_id]
        assert q.pending_count() == 1
        assert str(history.file_path) not in state.uploaded
        gate.enabled = False
        assert _wait_for(lambda: q.pending_count() == 0)
        assert len(api.calls) == 2
        assert _wait_for(lambda: q._q.unfinished_tasks == q._retry_q.unfinished_tasks == 0)
    finally:
        q.stop()


def test_priority_overflow_budget_survives_pause_stop_retry_and_inflight_dequeue(tmp_path, monkeypatch):
    import sc2tools_agent.uploader.queue as queue_module

    monkeypatch.setattr(queue_module, "_BACKPRESSURE_TIMEOUT_SEC", 0.05)
    assert _PRIORITY_OVERFLOW_LIMIT == 8
    request_started = threading.Event()
    finish_request = threading.Event()

    class BlockingApi(_StubApi):
        def upload_games_batch(self, games):
            if not self.calls:
                request_started.set()
                assert finish_request.wait(3)
            return super().upload_games_batch(games)

    gate = GameActivityGate()
    gate.on_event("match_started")
    state = AgentState(device_token="t", paused=True)
    api = BlockingApi()
    q = UploadQueue(cfg=_cfg(tmp_path), state=state, api=api)
    q._q = queue.PriorityQueue(maxsize=1)
    q.set_activity_gate(gate)
    history = _game(tmp_path, "budget-history.SC2Replay")
    assert q.submit(history)
    admitted = [replace(_game(tmp_path, f"budget-{index}.SC2Replay"), priority=True)
                for index in range(_PRIORITY_OVERFLOW_LIMIT)]
    for job in admitted:
        assert q.submit(job)
    deferred = replace(_game(tmp_path, "budget-deferred.SC2Replay"), priority=True)
    dequeued = threading.Event()
    original_next = q._next_queue_item

    def next_item():
        result = original_next()
        dequeued.set()
        return result

    monkeypatch.setattr(q, "_next_queue_item", next_item)
    q.start()
    try:
        assert dequeued.wait(2)
        # Merely dequeuing/requeueing while paused must not free admission.
        assert not q.submit(deferred)
        assert not q.is_pending(deferred.file_path)
        assert str(deferred.file_path) not in q._pending_owners
        assert deferred.file_path.exists() and str(deferred.file_path) not in state.uploaded
        assert q.pending_count() == _PRIORITY_OVERFLOW_LIMIT + 1
        assert not api.calls

        q.stop()
        assert all(q.is_pending(job.file_path) for job in admitted)
        q.set_paused(False)
        q.start()
        assert request_started.wait(2)
        # An in-flight request still owns its pending reservation and slot.
        assert q._q.full()
        assert not q.submit(deferred)
        assert not q.is_pending(deferred.file_path)
        finish_request.set()
        assert _wait_for(lambda: all(str(job.file_path) in state.uploaded for job in admitted))
        assert q.pending_count() == 1

        # Successful terminal cleanup reclaims the allowance automatically.
        assert q.submit(deferred)
        assert _wait_for(lambda: str(deferred.file_path) in state.uploaded)
        assert q.pending_count() == 1
        gate.enabled = False
        assert _wait_for(lambda: q.pending_count() == 0)
        assert len(api.calls) == _PRIORITY_OVERFLOW_LIMIT + 2
        assert _wait_for(lambda: q._q.unfinished_tasks == q._retry_q.unfinished_tasks == 0)
    finally:
        finish_request.set()
        q.stop()


def test_priority_overflow_budget_is_atomic_for_concurrent_new_file_events(tmp_path):
    state = AgentState(device_token="t", paused=True)
    q = UploadQueue(cfg=_cfg(tmp_path), state=state, api=_StubApi())
    q._q = queue.PriorityQueue(maxsize=1)
    assert q.submit(_game(tmp_path, "burst-history.SC2Replay"))
    jobs = [replace(_game(tmp_path, f"burst-{index}.SC2Replay"), priority=True)
            for index in range(_PRIORITY_OVERFLOW_LIMIT * 3)]
    try:
        with ThreadPoolExecutor(max_workers=4) as executor:
            results = list(executor.map(q.submit, jobs))
        assert sum(results) == _PRIORITY_OVERFLOW_LIMIT
        assert q.pending_count() == _PRIORITY_OVERFLOW_LIMIT + 1
        assert q._retry_q.qsize() == _PRIORITY_OVERFLOW_LIMIT
        assert len(q._priority_overflow_paths) == _PRIORITY_OVERFLOW_LIMIT
        for job, accepted in zip(jobs, results):
            assert q.is_pending(job.file_path) is accepted
            assert (str(job.file_path) in q._pending_owners) is accepted
            assert job.file_path.exists() and str(job.file_path) not in state.uploaded
    finally:
        q.stop()


def test_foreign_owner_cleanup_reclaims_priority_overflow_without_retargeting(tmp_path):
    gate = GameActivityGate()
    gate.on_event("match_started")
    state = AgentState(user_id="owner-a", device_token="token-a")
    old_api, new_api = _StubApi(), _StubApi()
    q = UploadQueue(cfg=_cfg(tmp_path), state=state, api=old_api)
    q._q = queue.PriorityQueue(maxsize=1)
    q.set_activity_gate(gate)
    assert q.submit(_game(tmp_path, "old-owner-history.SC2Replay"))
    old_jobs = [replace(_game(tmp_path, f"old-owner-{index}.SC2Replay"), priority=True)
                for index in range(_PRIORITY_OVERFLOW_LIMIT)]
    for job in old_jobs:
        assert q.submit(job)
    with _STATE_SAVE_LOCK:
        state.user_id, state.device_token = "owner-b", "token-b"
        q.replace_api(new_api)
    q.start()
    try:
        assert _wait_for(lambda: all(not q.is_pending(job.file_path) for job in old_jobs))
        assert not old_api.calls and not new_api.calls and not state.uploaded
        replacement = replace(_game(tmp_path, "new-owner-live.SC2Replay"), priority=True)
        assert q._q.full()
        assert q.submit(replacement)
        assert _wait_for(lambda: str(replacement.file_path) in state.uploaded)
        assert [call["gameId"] for call in new_api.calls] == [replacement.game.game_id]
        assert not old_api.calls
        gate.enabled = False
        assert _wait_for(lambda: q.pending_count() == 0)
        assert set(state.uploaded) == {str(replacement.file_path)}
    finally:
        q.stop()


def test_match_start_during_history_batch_assembly_retains_batch(tmp_path, monkeypatch):
    import sc2tools_agent.uploader.queue as queue_module

    # Hold the worker at the coalescing read rather than infer that boundary
    # from an exact float timeout. Coarse Windows clock ticks can make
    # (deadline - now) slightly greater than the configured 0.2 seconds.
    monkeypatch.setattr(queue_module, "_BATCH_COALESCE_SEC", 30.0)
    gate = GameActivityGate()
    entered_coalescing = threading.Event()
    release_coalescing = threading.Event()
    state = AgentState(device_token="t")
    api = _StubApi()
    q = UploadQueue(cfg=_cfg(tmp_path, upload_batch_size=5), state=state, api=api)
    q.set_activity_gate(gate)
    original_get = q._q.get

    def get(*args, **kwargs):
        # The job is queued before start(), so its initial read is nonblocking.
        # The first timed read therefore waits for another batch member.
        if kwargs.get("timeout") is not None and not entered_coalescing.is_set():
            entered_coalescing.set()
            assert release_coalescing.wait(5)
            raise queue.Empty
        return original_get(*args, **kwargs)

    monkeypatch.setattr(q._q, "get", get)
    job = _game(tmp_path, "coalescing.SC2Replay")
    assert q.submit(job)
    q.start()
    try:
        assert entered_coalescing.wait(5)
        assert q.is_pending(job.file_path) and not api.calls
        gate.on_event("match_loading")
        release_coalescing.set()
        assert _wait_for(lambda: q._retry_q.qsize() == 1)
        assert not api.calls and not state.uploaded
        assert q.pending_count() == 1
        gate.enabled = False
        assert _wait_for(lambda: q.pending_count() == 0)
        assert len(api.calls) == 1
    finally:
        release_coalescing.set()
        q.stop()


def test_match_start_while_waiting_for_network_slot_defers_history(tmp_path, monkeypatch):
    gate = GameActivityGate()
    state = AgentState(device_token="t")
    api = _StubApi()
    q = UploadQueue(cfg=_cfg(tmp_path), state=state, api=api)
    q.set_activity_gate(gate)
    payload_built = threading.Event()
    original_payload = q._payload_for_job

    def payload(job):
        result = original_payload(job)
        payload_built.set()
        return result

    monkeypatch.setattr(q, "_payload_for_job", payload)
    job = _game(tmp_path, "network-wait.SC2Replay")
    try:
        with q._network_gate.hold(0), q._network_gate.hold(0):
            q.start()
            assert q.submit(job)
            assert payload_built.wait(2)
            gate.on_event("match_started")
        assert _wait_for(lambda: q._retry_q.qsize() == 1)
        assert not api.calls and not state.uploaded
        assert q.pending_count() == 1
        gate.enabled = False
        assert _wait_for(lambda: q.pending_count() == 0)
        assert len(api.calls) == 1
    finally:
        q.stop()


def test_match_start_keeps_inflight_upload_durable_and_holds_next_batch(tmp_path):
    gate = GameActivityGate()
    request_started = threading.Event()
    finish_request = threading.Event()

    class BlockingApi(_StubApi):
        def upload_games_batch(self, games):
            if not self.calls:
                request_started.set()
                assert finish_request.wait(3)
            return super().upload_games_batch(games)

    state = AgentState(device_token="t")
    api = BlockingApi()
    q = UploadQueue(cfg=_cfg(tmp_path), state=state, api=api)
    q.set_activity_gate(gate)
    jobs = [_game(tmp_path, f"inflight-{index}.SC2Replay") for index in range(2)]
    for job in jobs:
        assert q.submit(job)
    q.start()
    try:
        assert request_started.wait(2)
        gate.on_event("match_started")
        finish_request.set()
        assert _wait_for(lambda: str(jobs[0].file_path) in state.uploaded)
        assert _wait_for(lambda: q._retry_q.qsize() == 1)
        assert len(api.calls) == 1
        assert q.pending_count() == 1
        assert str(jobs[1].file_path) not in state.uploaded
        gate.enabled = False
        assert _wait_for(lambda: q.pending_count() == 0)
        assert len(api.calls) == 2
    finally:
        finish_request.set()
        q.stop()
