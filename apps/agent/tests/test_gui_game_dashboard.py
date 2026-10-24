from tests._gui_offscreen import run_gui_check


def test_actual_window_uses_cached_facts_coalesces_bursts_and_clears_account_data(tmp_path):
    run_gui_check(tmp_path, '''
from datetime import datetime, timezone
def forbidden():
    raise AssertionError("Qt must never scan uploaded state")
ui,win=make_window(recent_games_enabled=True,synced_count_provider=forbidden)
win.show();app.processEvents()
at=datetime.now(timezone.utc).isoformat()
row=dict(path="fixture",gameId="one",dateIso=at,result="Victory",oppName="Opponent",map="Alcyone LE",status="uploaded",races={"own":"Protoss","opponent":"Zerg"})
ui.on_recent_snapshot(dict(owner="u1",rows=[row],facts=dict(synced=312,syncedToday=12,lastUploadAt=at,failed24h=3),today=dict(wins=2,losses=1,games=3,netMmr=12)))
paints=[];original=win._paint_stats
win._paint_stats=lambda:(paints.append(True),original())
for index in range(500):
    ui.on_pending(index)
    ui.on_upload_success("fixture")
app.processEvents()
assert paints==[],len(paints)
QtTest.QTest.qWait(300)
assert len(paints)==1,len(paints)
assert win._stat_synced["value"].text()=="312"
assert "+12 today" in win._stat_synced["label"].text()
assert win._stat_last["value"].text()=="Just now"
assert win._stat_failed["value"].text()=="3"
assert "Victory vs Opponent (Z) on Alcyone LE" in win._game_dashboard.last.text()
assert "2W–1L" in win._game_dashboard.today.text() and "+12 MMR" in win._game_dashboard.today.text()
win._show_recent_problems();assert win._recent_widget.model.status=="problem"
ui.on_unlinked();ui.on_paired("u2");ui.on_recent_snapshot(dict(owner="u1",rows=[row],facts=dict(synced=312)))
ui.on_game_synced("stale",dict(row,_owner="u1"));app.processEvents();QtTest.QTest.qWait(300)
assert win._recent_widget.model.rowCount()==0
assert win._game_dashboard.last_id is None
assert win._stat_synced["value"].text()=="0"
win.hide()
''')


def test_import_card_waiting_count_holds_and_zero_done(tmp_path):
    run_gui_check(tmp_path, '''
ui,win=make_window(recent_games_enabled=True)
win.show();app.processEvents()
ui.on_pending(30)
ui.on_import_progress(dict(phase="importing",total=100,completed=20,errors=0,remaining=80,ratePerMinute=12,etaSeconds=400))
app.processEvents();QtTest.QTest.qWait(300)
assert win._stat_queued["value"].text()=="80"  # Inventory includes the queued 30.
assert win._game_dashboard.bar.value()==20
assert "12.0/min" in win._game_dashboard.import_detail.text()
ui.on_paused(True);app.processEvents();QtTest.QTest.qWait(300)
assert win._game_dashboard.import_phase.text()=="Paused"
assert "/min" not in win._game_dashboard.import_detail.text() and "remaining" not in win._game_dashboard.import_detail.text()
ui.on_paused(False);ui.on_connection_state("offline",1,20,30);app.processEvents();QtTest.QTest.qWait(300)
assert win._game_dashboard.import_phase.text()=="Waiting for connection"
assert "/min" not in win._game_dashboard.import_detail.text()
ui.on_connection_state("online",0,0,0)
ui.on_import_progress(dict(phase="done",total=0,completed=0,remaining=0));app.processEvents();QtTest.QTest.qWait(300)
assert win._game_dashboard.bar.maximum()==1 and win._game_dashboard.bar.value()==1
assert win._game_dashboard.import_detail.text()=="0 of 0 replays"
win.hide()
''')


def test_recent_actions_use_exact_file_and_encoded_id_and_maintenance_is_separate(tmp_path):
    run_gui_check(tmp_path, '''
opened=[];revealed=[]
gui.webbrowser.open=lambda url,**kw:opened.append(url)
gui.subprocess.Popen=lambda args,**kw:revealed.append(args)
ui,win=make_window(recent_games_enabled=True)
file=base/"a, game.SC2Replay";file.write_bytes(b"fixture")
win._show_recent_file(str(file));win._open_recent_game("game/a?b#c")
assert revealed==[["explorer.exe","/select,"+str(file.resolve())]]
assert opened==["https://example.test/app/game/game%2Fa%3Fb%23c"]
assert isinstance(win._resync_btn.parentWidget(),QtWidgets.QGroupBox)
assert win._resync_btn.parentWidget().title()=="Maintenance"
assert win._updates_btn.parentWidget() is win._sidebar
assert win._updates_btn.text()=="Updates" and win._updates_btn.accessibleName()=="Check for updates"
win.resize(820,600);win._go_to_page("recent");app.processEvents()
assert win._recent_table.columnWidth(3)>=140
win._game_notifications_check.setChecked(True)
win._click_save_settings();wait_saved(win)
assert saved[-1].notify_every_game is True
win.hide()
''')


def test_only_season_save_is_async_and_does_not_apply_unrelated_unsaved_settings(tmp_path):
    run_gui_check(tmp_path, '''
import threading
entered=threading.Event();release=threading.Event();calls=[]
def season():
    calls.append(threading.current_thread().name);entered.set();assert release.wait(3)
ui,win=make_window(recent_games_enabled=True,on_import_current_season=season)
win._api_input.setText("https://unsaved.example.test")
win._game_dashboard.season.click()
try:
    assert entered.wait(1)
    assert win._settings_save_pending
    ticks=[];QtCore.QTimer.singleShot(0,lambda:ticks.append(True));app.processEvents()
    assert ticks==[True] and not saved
    win._game_dashboard.season.click();assert calls==["sc2tools-import-season"]
finally:
    release.set()
wait_saved(win)
assert win._filter_combo.currentData()=="current_season"
assert win._api_input.text()=="https://unsaved.example.test"
assert win._saved_api_base!="https://unsaved.example.test"
win.hide()
''')
