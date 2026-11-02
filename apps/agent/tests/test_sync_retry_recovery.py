"""Unknown identity defers real watcher admission until guarded profile recovery."""
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, call
import os
import threading
import time

import pytest

from sc2tools_agent.config import AgentConfig
from sc2tools_agent.pairing.recovery import RuntimeRecovery
from sc2tools_agent.player_handle import write_cache
from sc2tools_agent.state import AgentState
from sc2tools_agent.sync_retry import replay_ticket
from sc2tools_agent.uploader.queue import UploadQueue
from sc2tools_agent import watcher as watcher_module
from sc2tools_agent import runner
from tests.test_upload_queue import _StubApi
from tests.test_watcher_pool import _make_cloud_game


@pytest.mark.parametrize("fresh", [False, True], ids=["history", "sweep-live"])
def test_offline_boot_profile_recovery_submits_same_unchanged_path_without_clearing_real_skips(
    tmp_path, monkeypatch, fresh,
):
    monkeypatch.setenv("SC2TOOLS_PARSE_USE_PROCESSES", "0")
    monkeypatch.setattr(watcher_module, "_wait_for_file_ready", lambda *_: True)
    root = tmp_path / "Multiplayer"
    root.mkdir()
    replay = root / "deferred.SC2Replay"
    genuine = root / "genuine-unresolved.SC2Replay"
    replay.write_bytes(b"synthetic deferred replay")
    genuine.write_bytes(b"synthetic previously analyzed replay")
    stamp = time.time() - (5 if fresh else 86400)
    os.utime(replay, (stamp, stamp))
    original_file = replay.stat()
    state = AgentState(user_id="owner", device_token="synthetic",
        uploaded={str(genuine): "skipped:player_unresolved"})
    cfg = AgentConfig(api_base="http://localhost:0", state_dir=tmp_path / "state",
        replay_folder=root, poll_interval_sec=10, parse_concurrency=1)
    upload = UploadQueue(cfg=cfg, state=state, api=_StubApi())
    watcher = watcher_module.ReplayWatcher(cfg=cfg, state=state, upload=upload)
    monkeypatch.setattr(watcher, "_discover_roots", lambda: [root])
    parse = Mock(return_value=(_make_cloud_game(), None))
    monkeypatch.setattr(watcher_module, "parse_replay_for_cloud_ex", parse)
    submitted = threading.Event()
    original_submit = upload.submit

    def submit(job, **kwargs):
        accepted = original_submit(job, **kwargs)
        if accepted:
            submitted.set()
        return accepted

    monkeypatch.setattr(upload, "submit", submit)
    api = SimpleNamespace(device_token="synthetic", get_profile=Mock(side_effect=[
        ConnectionError("synthetic offline boot"),
        {"displayName": "Current owner", "pulseIds": ["1-S2-1-42"]},
    ]))
    stop = threading.Event()
    cell = SimpleNamespace(api=api, upload=upload, watcher=watcher)
    recovery = RuntimeRecovery(cell=cell, cfg=cfg, state=state, ui=Mock(), stop_event=stop)
    try:
        # Exercise the boot helper, including a legacy cached name that must
        # not gain owner authority merely because the profile read failed.
        write_cache(cfg.state_dir, "Legacy cached name")
        runner._ensure_player_handle(api, cfg, state, [root], Mock())
        assert replay_ticket(state).toons == ()
        watcher._sweep_once()
        assert not submitted.is_set()
        parse.assert_not_called()
        assert str(replay) not in state.uploaded
        assert not watcher._inflight
        assert not watcher._sweep_live_paths and not watcher._sweep_live_roots
        assert not watcher._capture_queue and not watcher._capture_active
        assert upload.pending_count() == 0
        assert state.uploaded[str(genuine)] == "skipped:player_unresolved"

        # A real successful-contact hook fetches the current owner's profile
        # and requests the actual watcher sweep, not a manually simulated
        # marker clear or direct _handle_replay call.
        recovery.connected()
        assert submitted.wait(3), "profile recovery must wake the unchanged replay"
        assert recovery._identity_lock.acquire(timeout=3)
        recovery._identity_lock.release()
        deadline = time.monotonic() + 3
        while watcher._inflight and time.monotonic() < deadline:
            time.sleep(0.005)
        assert not watcher._inflight
        assert not watcher._sweep_live_paths and not watcher._sweep_live_roots
        assert not watcher._capture_queue and not watcher._capture_active
        assert replay_ticket(state).toons == ("1-S2-1-42",)
        assert api.get_profile.call_args_list == [call(), call(interactive=True)]
        parse.assert_called_once()
        assert Path(parse.call_args.args[0]) == replay
        assert upload.pending_count() == 1 and upload.is_pending(replay)
        _priority, _sequence, job = upload._q.get_nowait()
        upload._q.task_done()
        assert job.file_path == replay
        assert state.uploaded == {str(genuine): "skipped:player_unresolved"}
        after = replay.stat()
        assert (after.st_size, after.st_mtime_ns) == (original_file.st_size, original_file.st_mtime_ns)
    finally:
        stop.set()
        settled = recovery._identity_lock.acquire(timeout=3)
        if settled:
            recovery._identity_lock.release()
        try:
            watcher.stop()
        finally:
            watcher._executor.shutdown(wait=True, cancel_futures=True)
            watcher._live_executor.shutdown(wait=True, cancel_futures=True)
            watcher._sweep_live_executor.shutdown(wait=True, cancel_futures=True)
            watcher._capture_executor.shutdown(wait=True, cancel_futures=True)
        assert settled, "the profile recovery worker must settle"
