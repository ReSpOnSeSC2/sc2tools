import os
import subprocess
import sys
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import Mock
import pytest
from sc2tools_agent.game_activity import GameActivityGate, background_workers
from sc2tools_agent.state import AgentState, load_state
from sc2tools_agent.update_scheduler import UpdateScheduler
from sc2tools_agent.updater import ReleaseInfo


class Clock:
    value=1000.0
    def __call__(self): return self.value


def test_match_gate_end_grace_stale_safety_and_no_live():
    clock=Clock(); gate=GameActivityGate(clock=clock)
    gate.on_event("match_loading"); assert gate.busy
    gate.on_event("match_started"); clock.value+=30
    gate.on_event("match_ended"); clock.value+=19; assert gate.busy
    clock.value+=1; assert not gate.busy and gate.free_for==0
    clock.value+=120; assert gate.free_for==120
    gate.on_event("match_in_progress"); clock.value+=120
    assert not gate.busy
    no_live=GameActivityGate(enabled=False,clock=clock)
    no_live.on_event("match_started"); assert not no_live.busy and no_live.free_for>=120


def test_gate_releases_after_45_minutes_even_with_live_ticks():
    clock=Clock(); gate=GameActivityGate(clock=clock)
    gate.on_event("match_loading")
    for _ in range(44):
        clock.value+=60; gate.on_event("match_in_progress"); assert gate.busy
    clock.value+=60; assert not gate.busy
    gate.on_event("match_in_progress"); assert not gate.busy
    gate.on_event("menu"); gate.on_event("match_loading"); assert gate.busy


@pytest.mark.parametrize("mode,workers",[("gentle",2),("balanced",4),("maximum",12)])
def test_worker_modes(mode,workers):
    assert background_workers(mode,12,cpu=32)==workers
    assert background_workers(mode,12,cpu=1)==1


@pytest.mark.skipif(os.name!="nt",reason="Windows process scheduling")
def test_real_child_process_uses_idle_priority_for_gentle():
    script="from sc2tools_agent.game_activity import lower_worker_priority; import ctypes; from ctypes import wintypes; lower_worker_priority('gentle'); k=ctypes.WinDLL('kernel32'); k.GetCurrentProcess.restype=wintypes.HANDLE; k.GetPriorityClass.argtypes=[wintypes.HANDLE]; print(k.GetPriorityClass(k.GetCurrentProcess()))"
    result=subprocess.run([sys.executable,"-c",script],capture_output=True,text=True,timeout=20)
    assert result.returncode==0,result.stderr
    assert int(result.stdout.strip())==0x40


def release(**changes):
    return replace(ReleaseInfo("stable",True,"0.19.0","0.20.0",None,"# Notes",None,None),**changes)


def scheduler(tmp_path,clock,**changes):
    state=changes.pop("state",AgentState())
    installed=Mock()
    notices=[]
    gate=SimpleNamespace(busy=False,free_for=120)
    gate=changes.pop("gate",gate)
    value=UpdateScheduler(gate=gate,state=state,state_dir=tmp_path,install=installed,
        notify=lambda *args:notices.append(args),now=clock,**changes)
    return value,installed,notices


@pytest.mark.parametrize("obstacle",["match","settling","stream","capture"])
def test_scheduler_never_installs_during_activity_even_explicit(tmp_path,obstacle):
    clock=Clock()
    gate=SimpleNamespace(busy=obstacle=="match",free_for=0 if obstacle=="settling" else 120)
    value,install,notices=scheduler(tmp_path,clock,gate=gate,streaming=lambda:obstacle=="stream",capturing=lambda:obstacle=="capture")
    value.offer(release()); assert not install.called
    assert not value.tick(explicit=True) and not install.called
    assert notices[-1][2]=="Will install after this match"


def test_auto_update_opt_out_still_allows_explicit_install_once(tmp_path):
    clock=Clock(); value,install,_=scheduler(tmp_path,clock,state=AgentState(auto_update_enabled=False))
    value.offer(release()); assert not install.called
    assert value.tick(explicit=True)
    assert not value.tick(explicit=True)
    install.assert_called_once()


def test_snooze_persists_and_mandatory_deadline_survives_restart(tmp_path):
    clock=Clock(); state=AgentState()
    busy=SimpleNamespace(busy=True,free_for=0)
    value,install,_=scheduler(tmp_path,clock,state=state,gate=busy)
    required=release(min_supported_version="0.20.0")
    value.offer(required); value.later()
    loaded=load_state(tmp_path)
    assert loaded.update_first_seen_at==1000 and loaded.update_snoozed_until==87400
    clock.value=87401
    again,install,_=scheduler(tmp_path,clock,state=loaded,gate=busy)
    again.offer(required)
    assert again.received_at==1000 and not install.called
    busy.busy=False; busy.free_for=120
    assert again.tick() and install.call_count==1


def test_install_failure_keeps_actionable_reason_and_retry(tmp_path):
    clock=Clock(); state=AgentState(auto_update_enabled=False)
    value,install,notices=scheduler(tmp_path,clock,state=state)
    value.offer(release())
    install.side_effect=RuntimeError("checksum mismatch")
    assert not value.tick(explicit=True)
    assert notices[-1][1:]==("failed","checksum mismatch")
    install.side_effect=None
    assert value.tick(explicit=True) and install.call_count==2


def test_install_failure_without_message_still_has_retry_reason(tmp_path):
    clock=Clock(); value,install,notices=scheduler(tmp_path,clock,state=AgentState(auto_update_enabled=False))
    value.offer(release()); install.side_effect=RuntimeError()
    assert not value.tick(explicit=True)
    assert notices[-1][1]=="failed" and "installer could not start" in notices[-1][2]
