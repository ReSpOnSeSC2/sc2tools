"""Replay-folder rows draw their text once: no path painted under the rich row."""

from tests._gui_offscreen import run_gui_check


def test_folder_rows_never_paint_the_path_under_the_row_widget(tmp_path):
    run_gui_check(tmp_path, '''
        ui, win = make_window()
        win._go_to_page("settings")
        win.show()
        missing = str(Path(base) / "Replays" / "Not-mounted")
        win._folder_list.addItem(missing)
        win._folder_rows.render()
        app.processEvents()
        item = win._folder_list.item(win._folder_list.count() - 1)
        # The path stays the item's data: adding, removing and saving read item.text().
        assert item.text() == missing
        # The list's own text would sit under the row's labels (path, status and
        # origin drawn on top of each other), so it must paint invisibly.
        assert item.foreground().color().alpha() == 0
        row = win._folder_list.itemWidget(item)
        assert row is not None
        assert row.findChild(QtWidgets.QLabel, "folderSummary") is not None
        assert item.sizeHint().height() >= row.sizeHint().height()
    ''')
