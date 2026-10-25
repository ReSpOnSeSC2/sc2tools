"""Historical ingest yields during matches without holding fresh replays."""

from dataclasses import replace
import queue
import threading

from sc2tools_agent.game_activity import GameActivityGate
from sc2tools_agent.state import AgentState
from sc2tools_agent.uploader.queue import UploadQueue
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


def test_match_start_during_history_batch_assembly_retains_batch(tmp_path, monkeypatch):
    import sc2tools_agent.uploader.queue as queue_module

    monkeypatch.setattr(queue_module, "_BATCH_COALESCE_SEC", 0.2)
    gate = GameActivityGate()
    entered_coalescing = threading.Event()
    state = AgentState(device_token="t")
    api = _StubApi()
    q = UploadQueue(cfg=_cfg(tmp_path, upload_batch_size=5), state=state, api=api)
    q.set_activity_gate(gate)
    original_get = q._q.get

    def get(*args, **kwargs):
        timeout = kwargs.get("timeout")
        if kwargs.get("block", True) and timeout is not None and 0 < timeout <= 0.2:
            gate.on_event("match_loading")
            entered_coalescing.set()
        return original_get(*args, **kwargs)

    monkeypatch.setattr(q._q, "get", get)
    job = _game(tmp_path, "coalescing.SC2Replay")
    assert q.submit(job)
    q.start()
    try:
        assert entered_coalescing.wait(2)
        assert _wait_for(lambda: q._retry_q.qsize() == 1)
        assert not api.calls and not state.uploaded
        assert q.pending_count() == 1
        gate.enabled = False
        assert _wait_for(lambda: q.pending_count() == 0)
        assert len(api.calls) == 1
    finally:
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
