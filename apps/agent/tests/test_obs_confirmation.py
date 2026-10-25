from tests._gui_offscreen import run_gui_check


def test_real_during_game_dialog_choices_and_local_confirmation_default_cancel(tmp_path):
    run_gui_check(tmp_path, '''
        import threading, time
        from sc2tools_agent.ui.gui import _ObsBuildDialog
        from sc2tools_agent.ui.obs_confirmation import show_obs_confirmation
        dialog = _ObsBuildDialog(parent=None, QtWidgets=QtWidgets, webcams=["Camera"], games=["Game"], update_existing=True)
        assert dialog.during_game_widgets() == ["overlay"]
        assert dialog.show_overlay_credit() is True
        assert dialog._during_game["stats-ticker"].text().endswith("1920 × 56)")
        dialog._during_game["stats-ticker"].setChecked(True)
        assert dialog.during_game_widgets() == ["overlay", "stats-ticker"]
        buttons = dialog.findChild(QtWidgets.QDialogButtonBox)
        assert buttons.button(QtWidgets.QDialogButtonBox.Cancel).isDefault()
        dialog.resize(560, 480)
        dialog.show()
        app.processEvents()
        assert buttons.button(QtWidgets.QDialogButtonBox.Cancel).isDefault()
        assert dialog.focusWidget() == buttons.button(QtWidgets.QDialogButtonBox.Cancel)
        assert buttons.geometry().bottom() <= dialog.height()
        assert dialog.findChild(QtWidgets.QScrollArea).verticalScrollBar().maximum() > 0
        QtTest.QTest.keyClick(dialog, QtCore.Qt.Key_Return)
        assert not dialog.isVisible() and dialog.result() == QtWidgets.QDialog.Rejected
        ui, win = make_window()
        assert not win._obs_website_add_check.isChecked()
        req = {"label": "Opponent identity", "scene": "<b>My live scene</b>", "expiresAt": (time.time()+5)*1000, "done": threading.Event(), "accepted": False}
        checks = []
        def cancel():
            box = next(w for w in app.topLevelWidgets() if isinstance(w, QtWidgets.QMessageBox))
            assert box.defaultButton() == box.button(QtWidgets.QMessageBox.Cancel)
            assert box.textFormat() == QtCore.Qt.PlainText
            assert box.text() == "Add Opponent identity to scene <b>My live scene</b>?"
            checks.append(True)
            box.button(QtWidgets.QMessageBox.Cancel).click()
        QtCore.QTimer.singleShot(20, cancel)
        show_obs_confirmation(req, parent=win, QtCore=QtCore, QtWidgets=QtWidgets)
        assert checks == [True] and req["done"].is_set() and req["accepted"] is False
        req["done"] = threading.Event()
        QtCore.QTimer.singleShot(20, lambda: next(w for w in app.topLevelWidgets() if isinstance(w, QtWidgets.QMessageBox) and w.isVisible()).button(QtWidgets.QMessageBox.Yes).click())
        show_obs_confirmation(req, parent=win, QtCore=QtCore, QtWidgets=QtWidgets)
        assert req["done"].is_set() and req["accepted"] is True
        ui._ui_ready = True
        expired = []
        worker = threading.Thread(target=lambda: expired.append(ui.confirm_obs_add_source({"widget": "opponent", "scene": "Local scene", "expiresAt": (time.time()+0.1)*1000})))
        worker.start()
        limit = QtCore.QDeadlineTimer(2000)
        while worker.is_alive() and not limit.hasExpired():
            QtTest.QTest.qWait(10)
        worker.join(timeout=1)
        assert expired == ["expired"]
        win.close()
    ''')
