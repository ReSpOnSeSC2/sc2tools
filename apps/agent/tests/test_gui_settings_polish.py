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
        ui._on_save_settings = lambda payload: (_ for _ in ()).throw(ValueError("disk unavailable https://private.example/?token=private-token C:/private/person/agent.json"))
        win._click_save_settings()
        wait_saved(win)
        assert win._settings_status.text() == "Couldn't save settings: The settings write did not finish. Restart the app if this continues."
        assert "disk unavailable" not in win._settings_status.text()
        assert "private.example" not in win._settings_status.text() and "private-token" not in win._settings_status.text()
        assert "C:/private" not in win._settings_status.text()
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
from tests.test_agent_state_credentials import FiniteFileStorage
from tests.test_agent_credentials import SyntheticCrypto
from sc2tools_agent import runner,replay_finder,state as state_module
from sc2tools_agent.config import AgentConfig
from sc2tools_agent.state import AgentState,load_state,_STATE_SAVE_LOCK
test_storage, test_crypto = FiniteFileStorage(base), SyntheticCrypto()
def test_backends(directory,storage=None,crypto=None,*,create=False):
    assert Path(directory)==base
    if create:test_storage.ensure_state_directory()
    return test_storage if storage is None else storage, test_crypto if crypto is None else crypto
state_module._credential_backends=test_backends
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
import json
pointer=(base/"agent.json").read_bytes()
assert "device_token" not in json.loads(pointer) and "obs_password" not in json.loads(pointer)
assert b'"device_token":"t"' not in pointer
assert load_state(base).device_token=="t"
assert win._settings_status.text().startswith("Saved.")
assert win._settings_draft_footer.isHidden()
win.hide()
''')


def test_draft_prompts_on_navigation_and_restart_action_only_after_save(tmp_path):
    run_gui_check(tmp_path, '''
        ui, win = make_window()
        win._go_to_page("settings")
        assert win._settings_draft_footer.isHidden()
        assert win._settings_restart_button.isHidden()
        win._api_input.setText("https://example.test")
        assert not win._settings_draft_footer.isHidden()
        assert win._settings_draft_label.text() == "1 unsaved change"
        win._minimized_check.setChecked(not win._minimized_check.isChecked())
        assert win._settings_draft_label.text() == "2 unsaved changes"
        QtWidgets.QMessageBox.question = lambda *args: QtWidgets.QMessageBox.Cancel
        win._go_to_page("dashboard")
        assert win._PAGE_KEYS[win._stack.currentIndex()] == "settings"
        QtWidgets.QMessageBox.question = lambda *args: QtWidgets.QMessageBox.Discard
        win._go_to_page("dashboard")
        assert win._PAGE_KEYS[win._stack.currentIndex()] == "dashboard"
        assert win._api_input.text() == ""
        assert win._settings_draft_footer.isHidden()
        win._go_to_page("settings")
        win._api_input.setText("https://example.test")
        win._save_settings_shortcut()
        wait_saved(win)
        assert win._settings_draft_footer.isHidden()
        assert not win._settings_restart_button.isHidden()
        win._go_to_page("dashboard")
        win._refresh_open_page()
    ''')


def test_revert_discards_unsaved_secret_entry_without_retaining_text(tmp_path):
    run_gui_check(tmp_path, '''
        ui, win = make_window()
        win._go_to_page("settings")
        win._obs_password_input.setText("synthetic secret")
        assert win._settings_draft.count() == 1
        assert "synthetic secret" not in str(win._settings_draft._saved)
        win._revert_settings_draft()
        assert win._obs_password_input.text() == ""
        assert win._settings_draft.count() == 0
    ''')


def test_grouped_settings_use_jump_or_persistent_index_at_each_size(tmp_path):
    run_gui_check(tmp_path, '''
        for name in ("segoeui.ttf", "seguisb.ttf", "segoeuib.ttf"):
            font = Path("C:/Windows/Fonts") / name
            if font.is_file():
                QtGui.QFontDatabase.addApplicationFont(str(font))
        app.setFont(QtGui.QFont("Segoe UI", 9))
        app.setStyleSheet(gui._STYLE)
        ui, win = make_window()
        win._go_to_page("settings")
        win.show()
        scroll = win._settings_scroll
        jump = next(item for item in scroll.findChildren(QtWidgets.QComboBox)
                    if item.accessibleName() == "Settings section")
        index = next(item for item in scroll.findChildren(QtWidgets.QListWidget)
                     if item.accessibleName() == "Settings section index")
        expected = ["Replays", "App", "Updates", "Streaming & OBS", "Build check-in", "Map replay", "Advanced"]
        assert [index.item(row).text() for row in range(index.count())] == expected
        assert [jump.itemData(row) for row in range(1, jump.count())] == expected
        for width, height, wide in [(820, 540, False), (1280, 800, True)]:
            win.resize(width, height)
            app.processEvents()
            assert jump.isVisible() is not wide
            assert index.isVisible() is wide
            assert scroll.verticalScrollBar().maximum() > 0
            assert scroll.horizontalScrollBar().maximum() == 0
            assert not win._api_input.isVisible()
            scroll.verticalScrollBar().setValue(0)
            app.processEvents()
            assert win.grab().save(str(base / f"settings-{width}x{height}.png"))
            if wide:
                position = index.pos()
                scroll.verticalScrollBar().setValue(scroll.verticalScrollBar().maximum())
                app.processEvents()
                assert index.isVisible() and index.pos() == position
                assert index.geometry().right() < scroll.viewport().x()
                index.setCurrentRow(index.count() - 1)
                index.setFocus()
                QtTest.QTest.keyClick(index, QtCore.Qt.Key_Return)
            else:
                advanced = jump.findData("Advanced")
                jump.setCurrentIndex(advanced)
                jump.activated.emit(advanced)
                assert jump.currentIndex() == 0
            QtTest.QTest.qWait(25)
            assert win._api_input.isVisible()
            advanced_top = win._settings_advanced.mapTo(scroll.viewport(), QtCore.QPoint()).y()
            assert 0 <= advanced_top < scroll.viewport().height(), advanced_top
            assert scroll.horizontalScrollBar().maximum() == 0
            assert win.grab().save(str(base / f"settings-advanced-{width}x{height}.png"))
            win._settings_advanced.setChecked(False)
        win._handle_input.setText("Draft during resize")
        win.resize(820, 540)
        app.processEvents()
        assert jump.isVisible() and not index.isVisible()
        assert win._handle_input.text() == "Draft during resize"
        assert not saved
    ''')


def test_notifications_and_close_behavior_apply_after_save(tmp_path):
    run_gui_check(tmp_path, '''
        quit_calls = []
        ui, win = make_window(tray_available=True, on_quit=lambda: quit_calls.append("quit"))
        win._go_to_page("settings")
        assert win._notifications_combo.currentData() == "important"
        win._notifications_combo.setCurrentIndex(win._notifications_combo.findData("off"))
        win._close_behavior_combo.setCurrentIndex(win._close_behavior_combo.findData(False))
        assert win._close_to_tray_last_saved
        win._click_save_settings()
        wait_saved(win)
        assert saved[-1].notifications_muted is True and saved[-1].notify_every_game is False
        assert saved[-1].close_to_tray is False and not win._close_to_tray_last_saved
        event = QtGui.QCloseEvent()
        win.closeEvent(event)
        assert event.isAccepted() and quit_calls == ["quit"]
    ''')


def test_instant_settings_keep_their_confirmation_next_to_the_controls(tmp_path):
    run_gui_check(tmp_path, '''
        ui, win = make_window()
        win._go_to_page("settings")
        win._obs_enable_check.setChecked(True)
        assert saved[-1].obs_scene_switch_enabled is True
        assert saved[-1].show_summary is False
        assert "scene switching on" in win._obs_toggle_feedback.text()
        QtWidgets.QMessageBox.warning = lambda *args: QtWidgets.QMessageBox.Yes
        win._replay_capture_check.setChecked(True)
        assert saved[-1].replay_capture_enabled is True
        assert saved[-1].show_summary is False
        assert "capture on" in win._replay_capture_feedback.text()
        button = next(item for item in win._upload_conc_group.buttons() if not item.isChecked())
        for control in (win._obs_enable_check, win._replay_capture_check, win._checkin_settings.enabled_box, button):
            assert control.accessibleDescription() == "Applies instantly"
        for control in (win._handle_input, win._filter_combo, win._upload_batch_slider,
                        win._obs_host_input, win._pause_history_check, win._autoupdate_check):
            assert control.accessibleDescription() == "Saved with Save"
        for control in (win._api_input, win._log_combo, win._speed_combo):
            assert control.accessibleDescription() == "Needs restart"
        button.click()
        assert saved[-1].show_summary is False
        assert "Applied instantly" in win._upload_concurrency_feedback.text()
        assert win._settings_draft_footer.isHidden()
        assert win._settings_status.text() == ""
    ''')
