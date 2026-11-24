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


HOLDS = {
    "match": ("Will install after this match", "Installs as soon as this match ends"),
    "stream": ("Will install when OBS stops streaming and recording", "Installs as soon as OBS stops streaming and recording"),
    "capture": ("Will install when the replay capture finishes", "Installs as soon as the replay capture finishes"),
}


@pytest.mark.parametrize("obstacle",sorted(HOLDS))
def test_install_now_waits_for_a_match_stream_or_capture_then_installs_at_once(tmp_path,obstacle):
    clock=Clock(); active=[True]
    gate=SimpleNamespace(busy=obstacle=="match",free_for=0)
    value,install,notices=scheduler(tmp_path,clock,gate=gate,state=AgentState(auto_update_enabled=False),
        streaming=lambda:obstacle=="stream" and active[0],capturing=lambda:obstacle=="capture" and active[0])
    value.offer(release())
    assert not install.called and notices[-1][1:]==("deferred",HOLDS[obstacle][0])
    assert not value.tick(explicit=True) and not install.called
    assert notices[-1][1:]==("queued",HOLDS[obstacle][1])
    value.poll(); assert not install.called and notices[-1][1:]==("queued",HOLDS[obstacle][1])
    # It ends. The quiet period has not run and automatic updates are off, but the
    # remembered click installs on the next background pass.
    gate.busy=False; active[0]=False
    value.poll()
    install.assert_called_once()
    assert notices[-1][1]=="installing"


def test_install_now_skips_the_quiet_period_that_automatic_installs_wait_out(tmp_path):
    clock=Clock(); gate=SimpleNamespace(busy=False,free_for=0)
    value,install,notices=scheduler(tmp_path,clock,gate=gate)
    value.offer(release())
    assert not install.called and notices[-1][1:]==("deferred","Will install in about 2 minutes if no game starts")
    gate.free_for=70
    assert not value.tick() and notices[-1][2]=="Will install in about a minute if no game starts"
    assert value.tick(explicit=True)
    install.assert_called_once()


def test_later_cancels_a_queued_install_now(tmp_path):
    clock=Clock(); gate=SimpleNamespace(busy=True,free_for=0)
    value,install,notices=scheduler(tmp_path,clock,gate=gate)
    value.offer(release()); value.tick(explicit=True)
    assert notices[-1][1]=="queued"
    value.later()
    assert notices[-1][1:]==("deferred","Remind me tomorrow")
    gate.busy=False; gate.free_for=120
    value.poll()
    assert not install.called and notices[-1][1:]==("deferred","Remind me tomorrow")


def test_a_queued_retry_runs_after_a_failed_install(tmp_path):
    clock=Clock(); gate=SimpleNamespace(busy=False,free_for=120)
    value,install,notices=scheduler(tmp_path,clock,gate=gate)
    install.side_effect=RuntimeError("checksum mismatch")
    value.offer(release())
    assert install.call_count==1 and notices[-1][1:]==("failed","checksum mismatch")
    value.poll(); assert install.call_count==1  # a failure waits for Retry
    gate.busy=True; install.side_effect=None
    assert not value.tick(explicit=True) and notices[-1][1:]==("queued","Installs as soon as this match ends")
    gate.busy=False; value.poll()
    assert install.call_count==2 and notices[-1][1]=="installing"


def test_a_running_install_keeps_its_card_when_another_pass_or_offer_arrives(tmp_path):
    clock=Clock(); value,install,notices=scheduler(tmp_path,clock)
    seen=[]
    def downloading(_release):
        before=len(notices)
        value.poll(); value.offer(release())  # the loop and the release feed fire mid-download
        seen.append(notices[before:])
    install.side_effect=downloading
    value.offer(release())
    assert seen==[[]] and notices[-1][1]=="installing"
    value.poll(); value.offer(release())  # handed to the installer: nothing repaints the card
    assert notices[-1][1]=="installing" and install.call_count==1


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
