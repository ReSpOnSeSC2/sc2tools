from tests._gui_offscreen import run_gui_check


def test_window_state_roundtrip_navigation_and_offscreen_restore(tmp_path):
    run_gui_check(tmp_path, '''
        ui, win = make_window(window_page="settings")
        win.show()
        app.processEvents()
        assert win._stack.currentIndex() == 3
        assert win._nav_group.button(3).isChecked()
        win._go_to_page("recent")
        win.resize(900, 600)
        app.processEvents()
        assert win._window_state_timer.isActive()
        QtTest.QTest.qWait(1100)
        assert window_states[-1][1] == "recent"
        geometry, page = window_states[-1]
        ui2, restored = make_window(window_geometry=geometry, window_page=page)
        assert restored._stack.currentIndex() == 1
        assert restored._nav_group.button(1).isChecked()
        win.move(5000, 100)
        offscreen = bytes(win.saveGeometry().toBase64()).decode("ascii")
        ui3, clamped = make_window(window_geometry=offscreen)
        screen = app.primaryScreen().availableGeometry()
        assert screen.intersects(clamped.frameGeometry())
        assert clamped.width() <= screen.width()
        ui4, unpaired = make_window(window_page="settings", initial_paired=False)
        assert unpaired._stack.currentIndex() == 0
        ui5, unknown = make_window(window_page="deleted-page")
        assert unknown._stack.currentIndex() == 0
        win.hide()
        before = len(window_states)
        win._save_window_state()
        assert len(window_states) == before
    ''')
