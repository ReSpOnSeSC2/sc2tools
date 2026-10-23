"""Settings recovery uses real Qt signals, timers and worker delivery."""
from tests._gui_offscreen import run_gui_check


def test_save_preserves_runner_summary_and_one_timer(tmp_path):
    run_gui_check(tmp_path, '''
        ui, win = make_window()
        ui._on_save_settings = lambda payload: ui.show_settings_status("Saved. Syncing Season 67 only…")
        win._click_save_settings()
        assert win._settings_status.text() == "Saved. Syncing Season 67 only…"
        assert win._settings_status.objectName() == "settingsToastOk"
        ui._on_save_settings = lambda payload: None
        win._click_save_settings()
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
        ui, win = make_window(initial_settings=SettingsPayload(api_base="https://custom.example", log_level="INFO", parse_concurrency=2))
        win._click_save_settings()
        assert saved[-1].api_base is None
        win._api_reset_btn.click()
        win._click_save_settings()
        assert saved[-1].api_base == ""
        assert "API address changes after you restart" in win._settings_status.text()
        assert "Log level" not in win._settings_status.text()
        win._api_input.setText("http://remote.example")
        count = len(saved)
        win._click_save_settings()
        assert len(saved) == count
        assert "Enter a full address" in win._api_error.text()
        assert win._settings_status.text() == "Fix the API address before saving."
        assert win._settings_status.objectName() == "settingsToastErr"
        win._api_reset_btn.click()
        assert win._api_error.text() == ""
        win._log_combo.setCurrentText("DEBUG")
        win._concurrency_slider.setValue(1)
        win._click_save_settings()
        assert "Log level, Parse concurrency and API address change after you restart" in win._settings_status.text()
        ui._on_save_settings = lambda payload: (_ for _ in ()).throw(ValueError("disk unavailable"))
        win._click_save_settings()
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
