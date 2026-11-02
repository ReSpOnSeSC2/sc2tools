from tests._gui_offscreen import run_gui_check


def test_status_is_truthful_boot_events_queue_and_errors_copy(tmp_path):
    run_gui_check(tmp_path,r"""
from sc2tools_agent.health import HealthMonitor, classify_boot_error
monitor=HealthMonitor(schedule=lambda delay,callback:callback())
original=GuiUI.__init__
def construct(self,*args,**kwargs):
    original(self,*args,**kwargs)
    # The boot worker's order, before the window exists: the classified failure, then the phase.
    monitor.subscribe(self.on_health)
    monitor.set_boot_error(classify_boot_error(RuntimeError("Analyzer startup exploded\nmore detail")))
    monitor.set_phase("boot_error")
    self.on_phase("boot_error","Analyzer startup exploded\nmore detail")
GuiUI.__init__=construct
ui,win=make_window(replay_folders=[base/"2-S2-1-42"])
win.show(); app.processEvents()
view=win._health_view
assert view.headline.text()=="SC2 Tools couldn't start syncing"
assert [line.sentence.text() for line in view.lines]==["Analyzer startup exploded"]
assert view.lines[0].action_button.text()=="Restart agent" and win._status_copy.isVisible()
(base/"agent.log").write_text("\n".join(f"2026-10-23T12:00:00 ERROR issue {i}" for i in range(30)),encoding="utf-8")
win._copy_status_details()
details=app.clipboard().text()
assert "SC2 Tools test" in details and "issue 29" in details and "issue 0\n" not in details
assert "Analyzer startup exploded\nmore detail" in details
ui.on_status("watching for replays"); app.processEvents()
assert view.headline.text()=="SC2 Tools couldn't start syncing"
win.hide()
""")


def test_unpaired_controls_and_shared_offline_card(tmp_path):
    run_gui_check(tmp_path,r"""
import time
from unittest.mock import Mock
from sc2tools_agent import runner
from sc2tools_agent.health import HealthMonitor
retries=[]
ui,win=make_window(initial_paired=False,replay_folders=[base/"2-S2-1-42"],on_sync_retry=lambda:retries.append(True))
win.show();app.processEvents()
assert not win._stats_row.isVisible()
assert not win._pause_btn.isEnabled() and not win._resync_btn.isEnabled() and not win._choose_btn.isEnabled()
# The runner's fan-out: the window's own events and the health snapshot come from one place.
mux=runner._Multiplexer(Mock(),None,ui,health=HealthMonitor(schedule=lambda delay,callback:callback()))
mux.on_paired("u1"); mux.on_phase("ready"); mux.on_pending(312)
mux.on_connection_state("offline",time.time(),time.time()+30,312)
app.processEvents()
view=win._health_view
assert view.headline.text()=="1 thing needs attention"
cloud=view.lines[0]
assert cloud.sentence.text()=="Can't reach sc2tools.com, so 312 replays are waiting."
assert not hasattr(win,"_connection_banner")
cloud.action_button.click(); assert retries==[True]
assert not win._sidebar_status.wordWrap() and win._sidebar_status.toolTip().startswith("● 1 thing needs attention")
assert win._stats_row.isVisible() and win._pause_btn.isEnabled()
win.hide()
""")


def test_close_policy_is_asked_once_and_tray_hint_once(tmp_path):
    run_gui_check(tmp_path,r"""
policies=[];hints=[];quit_calls=[]
ui,win=make_window(tray_available=False,on_close_policy=policies.append,on_quit=lambda:quit_calls.append(True))
win.show(); app.processEvents()
def choose():
    dialog=next(widget for widget in app.topLevelWidgets() if isinstance(widget,QtWidgets.QMessageBox))
    next(button for button in dialog.buttons() if button.text()=="Minimize").click()
QtCore.QTimer.singleShot(0,choose)
win.close(); app.processEvents()
assert policies==["minimize"] and win.isMinimized()
win.showNormal(); win.close(); app.processEvents()
assert policies==["minimize"] and not quit_calls
ui2,win2=make_window(on_tray_hint=lambda:hints.append(True))
win2.show();win2.close();win2.show();win2.close()
assert hints==[True]
win.hide();win2.hide()
""")


def test_update_card_survives_capture_and_manual_actions(tmp_path):
    run_gui_check(tmp_path,r"""
from types import SimpleNamespace
import threading
installed=threading.Event();later=threading.Event()
ui,win=make_window(on_install_update=installed.set,on_update_later=later.set)
win.show();app.processEvents()
release=SimpleNamespace(latest="0.20.0",release_notes="# Better syncing\n- Reliable pairing")
ui.show_update_state(release,"ready","");app.processEvents()
ui.show_transient_notice("Recording a replay");app.processEvents()
assert win._update_card.title.text()=="Version 0.20.0 is ready"
assert win._transient_notice.text()=="Recording a replay"
from sc2tools_agent.ui import palette
for expanded in (False, True):
    win._update_card.notes_button.setChecked(expanded)
    arrow=win._update_card.notes_button.icon().pixmap(12,12).toImage()
    assert arrow.pixelColor(6,6).name()==palette.CYAN
win._update_card.notes_button.setChecked(True)
assert "Better syncing" in win._update_card.notes.toPlainText()
win._update_card.install_button.click();assert installed.wait(1)
win._update_card.later_button.click();assert later.wait(1)
ui.show_update_state(release,"failed","Checksum mismatch");app.processEvents()
assert win._update_card.message.text()=="Update failed: Checksum mismatch"
assert win._update_card.install_button.text()=="Retry" and win._update_card.download_button.isVisible()
win.hide()
""")
