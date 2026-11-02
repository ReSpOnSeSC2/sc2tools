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


def test_recovered_inventory_then_old_unknown_admission_retries_unchanged_history_on_next_poll(
    tmp_path, monkeypatch,
):
    """A late old admission must invalidate the newer scan that skipped it.

    The contact recovery's real immediate sweep is deliberately completed
    first, while the old historical drain still owns this path's reservation.
    Assertions observe actual queue admission, not inventory generation values.
    """
    monkeypatch.setenv("SC2TOOLS_PARSE_USE_PROCESSES", "0")
    monkeypatch.setattr(watcher_module, "_wait_for_file_ready", lambda *_: True)
    root = tmp_path / "Multiplayer"
    root.mkdir()
    replay, genuine = root / "unchanged.SC2Replay", root / "genuine-unresolved.SC2Replay"
    replay.write_bytes(b"synthetic historical replay")
    genuine.write_bytes(b"synthetic existing analyzed replay")
    stamp = time.time() - 86400
    os.utime(replay, (stamp, stamp))
    original_file = replay.stat()
    state = AgentState(user_id="owner", device_token="synthetic",
        uploaded={str(genuine): "skipped:player_unresolved"})
    cfg = AgentConfig(api_base="http://localhost:0", state_dir=tmp_path / "state",
        replay_folder=root, poll_interval_sec=10, parse_concurrency=1)
    upload = UploadQueue(cfg=cfg, state=state, api=_StubApi())
    watcher = watcher_module.ReplayWatcher(cfg=cfg, state=state, upload=upload)
    monkeypatch.setattr(watcher, "_discover_roots", lambda: [root])
    # Logical time never reaches the inventory TTL. Event barriers, rather
    # than sleeps or clock advancement, establish the interleaving below.
    monkeypatch.setattr(watcher_module.time, "monotonic", lambda: 1000.0)
    parse = Mock(return_value=(_make_cloud_game(), None))
    monkeypatch.setattr(watcher_module, "parse_replay_for_cloud_ex", parse)
    old_held, release_old = threading.Event(), threading.Event()
    recovered_inventory_built = threading.Event()
    recovered_sweep_done, submitted, finished = threading.Event(), threading.Event(), threading.Event()
    errors = []
    original_ticket = watcher_module.replay_ticket
    original_sweep, original_finish, original_submit = watcher._sweep_once, watcher._finish_replay, upload.submit
    original_inventory = watcher._refresh_history_inventory

    def hold_unknown_admission(candidate_state):
        ticket = original_ticket(candidate_state)  # Its state lock is already released.
        if threading.current_thread() is old_thread and ticket.toons == ():
            with watcher._inflight_lock:
                reserved = str(replay) in watcher._inflight
            if reserved:
                old_held.set()  # Drain lock held; state/sweep/inflight locks free.
                assert release_old.wait(10), "old historical admission was not released"
        return ticket

    def old_sweep():
        try:
            original_sweep()
        except BaseException as exc:
            errors.append(exc)

    old_thread = threading.Thread(target=old_sweep, name="held-unknown-history", daemon=True)
    monkeypatch.setattr(watcher_module, "replay_ticket", hold_unknown_admission)

    def observed_inventory():
        original_inventory()
        if threading.current_thread() is not old_thread:
            assert replay_ticket(state).toons == ("1-S2-1-42",)
            assert str(replay) in watcher._inflight
            assert all(path != replay for path, _mtime in watcher._history_backlog)
            recovered_inventory_built.set()

    monkeypatch.setattr(watcher, "_refresh_history_inventory", observed_inventory)

    def observed_recovery_sweep():
        try:
            original_sweep()
        except BaseException as exc:
            errors.append(exc)
        finally:
            recovered_sweep_done.set()  # The full real immediate sweep has returned.

    monkeypatch.setattr(watcher, "_sweep_once", observed_recovery_sweep)

    def submit(job, **kwargs):
        accepted = original_submit(job, **kwargs)
        if accepted:
            submitted.set()
        return accepted

    def finish(path):
        original_finish(path)
        if path == replay:
            finished.set()

    monkeypatch.setattr(upload, "submit", submit)
    monkeypatch.setattr(watcher, "_finish_replay", finish)
    api = SimpleNamespace(device_token="synthetic", get_profile=Mock(side_effect=[
        ConnectionError("synthetic offline boot"),
        {"displayName": "Current owner", "pulseIds": ["1-S2-1-42"]},
    ]))
    stop = threading.Event()
    recovery = RuntimeRecovery(cell=SimpleNamespace(api=api, upload=upload, watcher=watcher),
        cfg=cfg, state=state, ui=Mock(), stop_event=stop)
    try:
        write_cache(cfg.state_dir, "Legacy cached name")
        runner._ensure_player_handle(api, cfg, state, [root], Mock())
        assert replay_ticket(state).toons == ()
        old_thread.start()
        assert old_held.wait(3), "historical path was not reserved before recovery"
        assert str(replay) in watcher._inflight
        parse.assert_not_called()

        recovery.connected()
        assert recovered_sweep_done.wait(3), "recovered contact's real sweep did not finish"
        assert not errors
        assert recovered_inventory_built.is_set(), "the recovered inventory must have skipped the held path"
        assert replay_ticket(state).toons == ("1-S2-1-42",)
        assert str(replay) in watcher._inflight  # That newer inventory had to skip it.
        assert not submitted.is_set()
        parse.assert_not_called()

        release_old.set()
        old_thread.join(3)
        assert not old_thread.is_alive() and not errors
        assert not watcher._inflight and not watcher._history_backlog
        assert state.uploaded == {str(genuine): "skipped:player_unresolved"}

        # Ordinary periodic polling: do not call request_immediate_sweep,
        # request_full_resync, touch the replay or advance the cache clock.
        monkeypatch.setattr(watcher, "_refresh_history_inventory", original_inventory)
        original_sweep()
        assert submitted.wait(3), "ordinary polling must revisit the late deferred unchanged replay"
        assert finished.wait(3)
        parse.assert_called_once()
        assert Path(parse.call_args.args[0]) == replay
        assert upload.pending_count() == 1 and upload.is_pending(replay)
        _priority, _sequence, job = upload._q.get_nowait()
        upload._q.task_done()
        assert job.file_path == replay
        assert state.uploaded == {str(genuine): "skipped:player_unresolved"}
        assert not watcher._inflight and not watcher._sweep_live_paths and not watcher._sweep_live_roots
        assert not watcher._capture_queue and not watcher._capture_active
        after = replay.stat()
        assert (after.st_size, after.st_mtime_ns) == (original_file.st_size, original_file.st_mtime_ns)
        assert api.get_profile.call_args_list == [call(), call(interactive=True)]
    finally:
        stop.set()
        release_old.set()
        if old_thread.ident is not None:
            old_thread.join(3)
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
        assert settled and not old_thread.is_alive(), "both recovery workers must settle"
