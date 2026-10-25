from __future__ import annotations

from datetime import datetime, timezone
import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
pytest.importorskip("PySide6")
from PySide6 import QtCore, QtGui, QtWidgets

from sc2tools_agent.ui import theme
from sc2tools_agent.ui.activity_log import build_activity_log
from sc2tools_agent.ui.recent_games import build_recent_games


@pytest.fixture
def app():
    return QtWidgets.QApplication.instance() or QtWidgets.QApplication([])


def settle(app):
    for _index in range(5):
        app.processEvents()


def assert_controls_fit(panel, widgets):
    for widget in widgets:
        assert widget.parentWidget() is panel
        assert widget.geometry().left() >= panel.rect().left()
        assert widget.geometry().right() <= panel.rect().right()
        assert widget.geometry().top() >= panel.rect().top()
        assert widget.geometry().bottom() <= panel.rect().bottom()
    for index, first in enumerate(widgets):
        for second in widgets[index + 1:]:
            assert not first.geometry().intersects(second.geometry())


def test_recent_filters_wrap_at_standard_width_and_restore_wide_row_without_reset(app):
    events = []
    page = build_recent_games(None, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets,
        open_game=lambda value: events.append(("game", value)), reveal=lambda _path: None,
        retry=lambda _paths, _reason: None, open_help=lambda *_args: None)
    page.setStyleSheet(theme.STYLE)
    page.set_rows([{
        "gameId": f"replay-{index}", "path": f"fixture-{index}",
        "dateIso": datetime.now(timezone.utc).isoformat(), "status": "uploaded",
    } for index in range(200)])
    controls = [*page.filters.values(), page.date]
    try:
        page.resize(520, 480)
        page.show()
        settle(app)
        assert page.width() == 520
        assert_controls_fit(page.controls_panel, controls)
        assert page._controls_layout.rowCount() == 2
        page.filters["uploaded"].click()
        page.date.setCurrentIndex(page.date.findData(7))
        for width in (1200, 520, 480):
            page.resize(width, 480)
            settle(app)
            assert page.width() == width
            assert_controls_fit(page.controls_panel, controls)
            assert page.model.status == "uploaded" and page.model.days == 7
            assert page.filters["uploaded"].isChecked()
            if width == 1200:
                assert {page._controls_layout.getItemPosition(page._controls_layout.indexOf(widget))[0]
                        for widget in controls} == {0}
        page.table.doubleClicked.emit(page.model.index(0, 0))
        assert events == [("game", "replay-0")]
    finally:
        page.close()
        page.deleteLater()
        settle(app)


def test_activity_header_and_search_actions_fit_standard_width_and_keep_state(app, tmp_path):
    log_file = tmp_path / "agent.log"
    log_file.write_text("2026-10-23T12:00:00 ERROR fixture failure\n2026-10-23T12:01:00 INFO fixture loaded\n", encoding="utf-8")
    events = []
    page = build_activity_log(None, log_file=log_file, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets,
        open_folder=lambda: events.append("folder"), open_help=lambda: events.append("help"),
        palette={"error": theme.DANGER, "warning": theme.WARNING, "muted": theme.TEXT_MUTED,
                 "text": theme.TEXT, "accent": theme.ACCENT})
    page.setStyleSheet(theme.STYLE)
    header = [page.header_title, page.header_help, page.filter_combo, page.open_folder_button]
    toolbar = [page.search, page.match_count, page.follow, page.copy_button]
    try:
        page.resize(520, 480)
        page.show()
        page.tail()
        page.search.setText("fixture")
        page.filter_combo.setCurrentIndex(page.filter_combo.findData("errors"))
        page.follow.setChecked(False)
        for width in (520, 1200, 520, 480):
            page.resize(width, 480)
            settle(app)
            assert page.width() == width
            assert_controls_fit(page.header_panel, header)
            assert_controls_fit(page.toolbar_panel, toolbar)
            assert page.search.text() == "fixture"
            assert page.filter_combo.currentData() == "errors"
            assert not page.follow.isChecked()
            assert page.match_count.text() == "1 of 1"
            assert "fixture failure" in page.view.toPlainText()
            assert "fixture loaded" not in page.view.toPlainText()
            if width == 1200:
                assert {page._header_layout.getItemPosition(page._header_layout.indexOf(widget))[0]
                        for widget in header} == {0}
                assert {page._toolbar_layout.getItemPosition(page._toolbar_layout.indexOf(widget))[0]
                        for widget in toolbar} == {0}
        page.open_folder_button.click()
        page.header_help.click()
        page.copy_tail()
        assert events == ["folder", "help"]
        assert "fixture failure" in app.clipboard().text()
    finally:
        page.close()
        page.deleteLater()
        settle(app)
