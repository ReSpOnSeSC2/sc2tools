import os
import threading
import time
from types import SimpleNamespace
from unittest.mock import Mock
import pytest
from sc2tools_agent.game_activity import GameActivityGate
from sc2tools_agent.state import AgentState,load_state
from sc2tools_agent import runner,watcher as module
from sc2tools_agent.uploader.queue import UploadQueue
from sc2tools_agent.uploader.archive_journal import ReplayArchiveTask
from tests.test_watcher_pool import _cfg,_FakeUploadQueue


def test_history_drain_holds_but_live_parse_lane_runs(tmp_path,monkeypatch):
    monkeypatch.setenv("SC2TOOLS_PARSE_USE_PROCESSES","0")
    clock=[1000.0];gate=GameActivityGate(clock=lambda:clock[0]);gate.on_event("match_started")
    watcher=module.ReplayWatcher(cfg=_cfg(tmp_path),state=AgentState(),upload=_FakeUploadQueue(),activity_gate=gate)
    path=tmp_path/"history.SC2Replay";path.write_bytes(b"fixture")
    watcher._history_backlog.append((path,time.time()))
    original=watcher._submit_parse
    watcher._submit_parse=Mock()
    try:
        watcher._drain_history_inventory()
        watcher._submit_parse.assert_not_called()
        assert len(watcher._history_backlog)==1
        live=threading.Event();watcher._handle_replay=lambda *_args,**_kwargs:live.set()
        original(path,live=True)
        assert live.wait(2)
        gate.on_event("match_ended");clock[0]+=20
        watcher._drain_history_inventory()
        watcher._submit_parse.assert_called_once_with(path,live=False)
    finally:
        watcher.stop()


def test_archive_lane_waits_for_gate_then_drains_same_durable_task(tmp_path):
    gate=GameActivityGate();gate.on_event("match_started")
    done=threading.Event();api=SimpleNamespace(upload_replay_file_durable=lambda *_args:(done.set() or True))
    queue=UploadQueue(cfg=_cfg(tmp_path),state=AgentState(),api=api)
    path=tmp_path/"one.SC2Replay";path.write_bytes(b"fixture")
    task=ReplayArchiveTask(path,"game")
    queue._archive_journal.enqueue_many([task])
    queue.set_activity_gate(gate)
    queue.start()
    try:
        assert not done.wait(.25)
        assert queue.archive_pending_count()==1
        gate.enabled=False
        queue._archive_wake.set()
        assert done.wait(3)
        deadline=time.monotonic()+2
        while queue.archive_pending_count() and time.monotonic()<deadline:time.sleep(.01)
        assert queue.archive_pending_count()==0
    finally:queue.stop()


def test_pause_deadline_resumes_and_broadcasts_without_touching_cursor(tmp_path):
    state=AgentState(device_token="kept",uploaded={"replay":"done"})
    upload=Mock();ui=Mock();stop=threading.Event();resumed=threading.Event()
    ui.on_paused.side_effect=lambda paused, until: resumed.set() if not paused else None
    runner._handle_pause(_cfg(tmp_path),state,upload,True,ui=ui,until=time.time()-.1)
    thread=runner._start_pause_expiry(_cfg(tmp_path),state,lambda:upload,lambda:ui,stop)
    try:
        assert resumed.wait(3)
        assert not state.paused and state.paused_until is None
        assert state.uploaded=={"replay":"done"}
        assert not load_state(tmp_path).paused
        ui.on_paused.assert_called_with(False,None)
    finally:stop.set();thread.join(2)


@pytest.mark.skipif(os.name!="nt",reason="Windows process-pool initializer")
def test_actual_parse_process_pool_lowers_worker_priority(tmp_path,monkeypatch):
    import ctypes
    from ctypes import wintypes
    monkeypatch.setenv("SC2TOOLS_PARSE_USE_PROCESSES","1")
    monkeypatch.setattr(module,"_probe_process_pool",lambda:(True,""))
    watcher=module.ReplayWatcher(cfg=_cfg(tmp_path),state=AgentState(background_import_speed="gentle"),upload=_FakeUploadQueue())
    try:
        pid=watcher._executor.submit(os.getpid).result(timeout=30)
        kernel=ctypes.WinDLL("kernel32",use_last_error=True)
        kernel.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD]
        kernel.OpenProcess.restype=wintypes.HANDLE
        handle=kernel.OpenProcess(0x1000,False,pid)
        assert handle
        try:
            kernel.GetPriorityClass.argtypes=[wintypes.HANDLE]
            assert kernel.GetPriorityClass(handle)==0x40
        finally:
            kernel.CloseHandle.argtypes=[wintypes.HANDLE];kernel.CloseHandle(handle)
    finally:
        watcher.stop();watcher._executor.shutdown(wait=True,cancel_futures=True)
