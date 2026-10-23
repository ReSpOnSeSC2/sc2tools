from tests._gui_offscreen import run_gui_check


def test_live_log_preserves_selection_filters_tracebacks_and_carries_partial_lines(tmp_path):
    run_gui_check(tmp_path, '''
        log_file = base / "agent.log"
        log_file.write_text("2026-10-23T12:00:00 ERROR broken upload\\nTraceback:\\n  frame one\\n", encoding="utf-8")
        ui, win = make_window()
        win._go_to_page("log"); win.show(); app.processEvents()
        log = win._activity_log
        cursor = log.view.textCursor()
        cursor.setPosition(0); cursor.setPosition(10, QtGui.QTextCursor.KeepAnchor)
        log.view.setTextCursor(cursor)
        selected = log.view.textCursor().selectedText()
        assert not log.follow.isChecked()
        with log_file.open("a", encoding="utf-8") as target:
            target.write("  second frame\\n2026-10-23T12:01:00 INFO healthy\\npartial")
        # Any accidental document replacement destroys the selection and fails.
        log.view.setPlainText = lambda _text: (_ for _ in ()).throw(AssertionError("whole document replaced"))
        win._tail_log_now()
        assert log.view.textCursor().selectedText() == selected
        assert log.records[0].lines[-1] == "  second frame"
        assert "partial" not in log.view.toPlainText()
        with log_file.open("a", encoding="utf-8") as target:
            target.write(" line\\n")
        win._tail_log_now()
        assert "partial line" in log.view.toPlainText()
        win.show_log(filter="errors", jump_to_last=False)
        assert "second frame" in log.view.toPlainText()
        assert "healthy" not in log.view.toPlainText()
        assert log.filter_combo.currentText() == "Errors only"
    ''')


def test_log_search_copy_follow_and_help_navigation(tmp_path):
    run_gui_check(tmp_path, '''
        (base / "agent.log").write_text("".join(f"2026-10-23T12:00:00 INFO error detail {i}\\n" for i in range(250)), encoding="utf-8")
        ui, win = make_window()
        win._go_to_page("log"); win.show(); app.processEvents()
        log = win._activity_log
        log.search.setText("ERROR")
        assert log.match_count.text() == "1 of 250"
        assert len(log.view.extraSelections()) == 250
        win.activateWindow(); log.search.setFocus(); app.processEvents()
        QtTest.QTest.keyClick(log.search, QtCore.Qt.Key_Return)
        assert log.match_count.text() == "2 of 250"
        QtTest.QTest.keyClick(log.search, QtCore.Qt.Key_F3, QtCore.Qt.ShiftModifier)
        assert log.match_count.text() == "1 of 250"
        log.copy_selection()
        assert app.clipboard().text() == "error"
        log.copy_tail()
        assert len(app.clipboard().text().splitlines()) == 200
        assert log.copy_button.text() == "Copied ✓"
        log.search.setText("nothing-matches")
        assert log.match_count.text() == "0 matches"
        QtTest.QTest.keyClick(log.search, QtCore.Qt.Key_Escape)
        assert log.search.text() == ""
        log.jump_to_latest()
        assert log.follow.isChecked()
        log.view.verticalScrollBar().setValue(0)
        assert not log.follow.isChecked()
        with (base / "agent.log").open("a", encoding="utf-8") as target:
            target.write("2026-10-23T12:00:00 ERROR newest\\n")
        win._tail_log_now()
        assert log.jump_button.text() == "1 new line - Jump to latest"
        log.jump_button.click()
        assert log.follow.isChecked() and not log.jump_button.isVisible()
        win._go_to_page("dashboard")
        QtTest.QTest.keyClick(win, QtCore.Qt.Key_F, QtCore.Qt.ControlModifier)
        assert win._stack.currentIndex() == 2 and log.search.hasFocus()
        opened = []
        gui.webbrowser.open = lambda url, **kwargs: opened.append(url)
        for button in win.findChildren(QtWidgets.QToolButton):
            if button.objectName() == "helpLink": button.click()
        sidebar = next(button for button in win.findChildren(QtWidgets.QPushButton) if button.text() == "Help & support")
        sidebar.click()
        from sc2tools_agent.ui.help_links import AGENT_HELP_SLUGS
        # Pairing and sync-error help are contextual actions on their cards.
        win._pairing_card.help.click()
        ui.on_connection_state("offline", 1, 1, 1); app.processEvents()
        win._connection_help.click()
        assert {url.split("/help/")[1].split("?")[0] for url in opened} == set(AGENT_HELP_SLUGS)
        assert all(url.startswith("https://example.test/help/") and url.split("#")[0].endswith("?src=agent") for url in opened)
    ''')


def test_missing_log_rotation_and_a_temporary_read_failure(tmp_path):
    run_gui_check(tmp_path, '''
        ui, win = make_window()
        log = win._activity_log
        assert log.empty.text() == "Nothing logged yet"
        path = base / "agent.log"
        path.write_text("2026-10-23T12:00:00 ERROR old entry with a longer line\\npartial", encoding="utf-8")
        win._tail_log_now()
        import sc2tools_agent.ui.activity_log as activity_log
        original = activity_log.read_tail
        activity_log.read_tail = lambda *args: (_ for _ in ()).throw(PermissionError("rotation locked"))
        win._tail_log_now()
        assert "old entry" in log.view.toPlainText()
        activity_log.read_tail = original
        path.write_text("2026-10-23T12:00:01 INFO new\\n", encoding="utf-8")
        win._tail_log_now()
        assert "INFO new" in log.view.toPlainText()
        assert "partial" not in log.view.toPlainText()
        assert log.carry == ""
    ''')


def test_recent_upload_burst_is_incremental_and_coalesces_counts(tmp_path):
    run_gui_check(tmp_path, '''
        counts = []
        def synced_count(): counts.append(True); return 500
        ui, win = make_window(synced_count_provider=synced_count)
        counts.clear()
        rebuilds = []
        win._refresh_recent = lambda: rebuilds.append(True)
        for index in range(500): win._on_upload_success(f"replay-{index}.SC2Replay")
        assert len(counts) <= 2
        assert not rebuilds
        assert win._recent_table.rowCount() == 100
        assert win._recent_table.item(0, 1).text() == "replay-499.SC2Replay"
        assert win._recent_table.item(99, 1).text() == "replay-400.SC2Replay"
        QtTest.QTest.qWait(300)
        assert len(counts) == 1
        assert win._stat_synced["value"].text() == "500"
        win._on_upload_failed("failure.SC2Replay", "network unavailable")
        assert win._recent_table.rowCount() == 100
        assert win._recent_table.item(0, 1).text() == "failure.SC2Replay"
    ''')
