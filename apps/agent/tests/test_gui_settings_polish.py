"""Settings recovery uses real Qt signals, timers and worker delivery."""
from tests._gui_offscreen import run_gui_check


def test_save_preserves_runner_summary_and_one_timer(tmp_path):
    run_gui_check(tmp_path, '''
        ui, win = make_window()
        ui._on_save_settings = lambda payload: ui.show_settings_status("Saved. Syncing Season 67 only…")
        win._click_save_settings()
        wait_saved(win)
        assert win._settings_status.text() == "Saved. Syncing Season 67 only…"
        assert win._settings_status.objectName() == "settingsToastOk"
        ui._on_save_settings = lambda payload: None
        win._click_save_settings()
        wait_saved(win)
        assert win._settings_status.text() == "Saved."
        win._show_settings_toast("First", ms=40)
        QtTest.QTest.qWait(20)
        win._show_settings_toast("Second", ms=100)
        QtTest.QTest.qWait(40)
        assert win._settings_status.text() == "Second"
        QtTest.QTest.qWait(100)
        assert win._settings_status.text() == ""
    ''')


def test_api_reset_validation_and_restart_fields(tmp_path):
    run_gui_check(tmp_path, '''
        ui, win = make_window(initial_settings=SettingsPayload(api_base="https://custom.example", log_level="INFO", parse_concurrency=2, background_import_speed="gentle"))
        win._click_save_settings()
        wait_saved(win)
        assert saved[-1].api_base is None
        win._api_reset_btn.click()
        win._click_save_settings()
        wait_saved(win)
        assert saved[-1].api_base == ""
        assert "API address changes after you restart" in win._settings_status.text()
        assert "Log level" not in win._settings_status.text()
        win._api_input.setText("http://remote.example")
        count = len(saved)
        win._click_save_settings()
        wait_saved(win)
        assert len(saved) == count
        assert "Enter a full address" in win._api_error.text()
        assert win._settings_status.text() == "Fix the API address before saving."
        assert win._settings_status.objectName() == "settingsToastErr"
        win._api_reset_btn.click()
        assert win._api_error.text() == ""
        win._log_combo.setCurrentText("DEBUG")
        win._speed_combo.setCurrentIndex(win._speed_combo.findData("maximum"))
        win._click_save_settings()
        wait_saved(win)
        assert "Log level, Import speed and API address change after you restart" in win._settings_status.text()
        ui._on_save_settings = lambda payload: (_ for _ in ()).throw(ValueError("disk unavailable"))
        win._click_save_settings()
        wait_saved(win)
        assert win._settings_status.text() == "Couldn't save settings: disk unavailable"
    ''')


def test_api_health_worker_and_changed_text_result(tmp_path):
    run_gui_check(tmp_path, '''
        ui, win = make_window()
        calls = []
        gui.probe_api_health = lambda address: (calls.append(address) or "Reachable · 142 ms")
        win._api_input.setText("https://custom.example/")
        win._test_api_address()
        assert not win._api_test_btn.isEnabled()
        QtCore.QThreadPool.globalInstance().waitForDone(2000)
        app.processEvents()
        assert calls == ["https://custom.example"]
        assert win._api_test_status.text() == "Reachable · 142 ms"
        generation = win._api_test_generation
        win._api_input.setText("https://another.example")
        win._api_input.setText("https://custom.example/")
        win._on_api_test_done("https://custom.example", generation, "old result")
        assert win._api_test_status.text() == ""
        assert win._api_test_btn.isEnabled()
    ''')


def test_filter_save_keeps_qt_responsive_until_real_durable_commit(tmp_path):
    run_gui_check(tmp_path,r'''
import logging,threading
from sc2tools_agent import runner,replay_finder
from sc2tools_agent.config import AgentConfig
from sc2tools_agent.state import AgentState,load_state,_STATE_SAVE_LOCK
replay_finder.candidate_documents_dirs=lambda:iter(())
runner.autostart.set_enabled=lambda _enabled:True
state=AgentState(device_token="t",user_id="u1",uploaded={"old":"filtered"})
cell=runner._RuntimeCell();cell.no_obs=True
cfg=AgentConfig(api_base="http://localhost:0",state_dir=base,replay_folder=None,poll_interval_sec=10,parse_concurrency=1)
entered,release=threading.Event(),threading.Event()
main_thread=threading.get_ident();writers=[]
original_save=runner.save_state

def held_save(*args,**kwargs):
    with _STATE_SAVE_LOCK:
        writers.append(threading.get_ident())
        entered.set()
        assert release.wait(10), "Test did not release the durable writer"
        return original_save(*args,**kwargs)
runner.save_state=held_save
ui,win=make_window(
    on_save_settings=lambda payload:runner._handle_save_settings(cfg,state,payload,cell,logging.getLogger("test")),
    on_window_state=lambda geometry,page:runner._remember_window_state(base,state,geometry,page))
cell.gui=ui
index=win._filter_combo.findData("season:67");assert index>=0
win._filter_combo.setCurrentIndex(index)
win._go_to_page("settings");win.show();app.processEvents()
try:
    win._click_save_settings()
    assert entered.wait(3)
    assert win._settings_save_pending and not win._save_settings_btn.isEnabled()
    assert not win._pause_btn.isEnabled() and not win._resync_btn.isEnabled() and not win._choose_btn.isEnabled()
    assert win._settings_status.text()=="Saving settings…"
    assert not (base/"agent.json").exists()
    assert writers==[writers[0]] and writers[0]!=main_thread
    ticks=[]
    QtCore.QTimer.singleShot(0,lambda:ticks.append(True))
    QtTest.QTest.mouseClick(win._nav_group.button(2),QtCore.Qt.LeftButton);app.processEvents()
    assert ticks==[True] and win._stack.currentIndex()==2
    win._save_window_state()  # A navigation save must not wait on the held writer lock.
    assert win._window_state_timer.isActive()
    win._click_save_settings()
    assert len(writers)==1
finally:
    release.set()
wait_saved(win)
assert load_state(base).sync_filter_preset=="season:67"
assert load_state(base).uploaded=={}
assert win._settings_status.text().startswith("Saved.")
assert win._save_settings_btn.isEnabled()
win.hide()
''')
