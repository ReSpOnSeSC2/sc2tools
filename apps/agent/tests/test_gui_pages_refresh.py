"""The main window's pages after the interface refresh: scrolling, settings controls, folder rows."""
from __future__ import annotations

import os
from textwrap import dedent

import pytest

from tests._gui_offscreen import run_gui_check
from tests.test_companion_resize_shell import THEMED_SETUP

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
pytest.importorskip("PySide6")
from PySide6 import QtCore, QtGui, QtTest, QtWidgets

from sc2tools_agent.ui import theme
from sc2tools_agent.ui.activity_log import build_activity_log
from sc2tools_agent.ui.qt_helpers import scrolling_page
from sc2tools_agent.ui.recent_games import build_recent_games

# The display of the smallest window (480 x 360) less the shell around it.
SMALLEST_DISPLAY = (440, 230)


@pytest.fixture
def app():
    return QtWidgets.QApplication.instance() or QtWidgets.QApplication([])


def settle(app):
    QtTest.QTest.qWait(50)
    app.processEvents()


def build_page(kind, tmp_path):
    if kind == "recent":
        page = build_recent_games(None, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets,
                                  open_game=lambda _value: None, reveal=lambda _path: None,
                                  retry=lambda _paths, _reason: None, open_help=lambda *_args: None)
        page.set_rows([{"gameId": "replay-1", "path": "fixture", "dateIso": "2026-11-10T12:00:00+00:00",
                        "status": "uploaded"}])
        return page
    log_file = tmp_path / "agent.log"
    log_file.write_text("2026-11-10T12:00:00 INFO fixture loaded\n", encoding="utf-8")
    return build_activity_log(None, log_file=log_file, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets,
                              open_folder=lambda: None, open_help=lambda: None,
                              palette={"error": theme.DANGER, "warning": theme.WARNING, "muted": theme.TEXT_MUTED,
                                       "text": theme.TEXT, "accent": theme.ACCENT})


def stacked_widgets(page):
    layout = page.widget().layout()
    items = (layout.itemAt(index).widget() for index in range(layout.count()))
    return sorted((widget for widget in items if widget is not None and not widget.isHidden() and widget.height() > 0),
                  key=lambda widget: widget.geometry().top())


def test_the_scroll_area_receives_content_with_its_layout_already_installed(app):
    class ScrollArea(QtWidgets.QScrollArea):
        def setWidget(self, widget):
            assert isinstance(widget.layout(), QtWidgets.QVBoxLayout)
            super().setWidget(widget)

    scroll = ScrollArea()
    layout = scrolling_page(scroll, QtWidgets=QtWidgets)
    assert scroll.widget().layout() is layout


@pytest.mark.parametrize("kind", ["recent", "log"])
def test_a_page_scrolls_at_the_smallest_window_and_never_overlaps_its_controls(app, tmp_path, kind):
    page = build_page(kind, tmp_path)
    page.setStyleSheet(theme.STYLE)
    try:
        page.resize(*SMALLEST_DISPLAY)
        page.show()
        settle(app)
        assert isinstance(page, QtWidgets.QScrollArea)
        assert page.verticalScrollBar().maximum() > 0
        widgets = stacked_widgets(page)
        assert len(widgets) >= 4
        for above, below in zip(widgets, widgets[1:]):
            assert above.geometry().bottom() < below.geometry().top(), (above, below)
        listing = page.table if kind == "recent" else page.view
        assert listing.height() >= theme.PAGE_LIST_MIN_HEIGHT
    finally:
        page.close()
        page.deleteLater()
        settle(app)


@pytest.mark.parametrize("scale", ["1.25", "1.5"])
def test_log_and_recent_controls_fit_the_smallest_window_at_display_scale(tmp_path, monkeypatch, scale):
    monkeypatch.setenv("QT_SCALE_FACTOR", scale)
    run_gui_check(tmp_path, THEMED_SETUP.replace("FONT_SIZE", "10") + dedent('''
        def check_controls(panel, *controls):
            for index, control in enumerate(controls):
                assert control.isVisible() and control.parentWidget() is panel
                assert panel.rect().contains(control.geometry()), control
                minimum = control.minimumSizeHint().boundedTo(control.maximumSize())
                assert control.width() >= minimum.width(), control
                assert control.height() >= minimum.height(), control
                assert all(not control.geometry().intersects(other.geometry()) for other in controls[:index])

        (base / "agent.log").write_text("".join(
            f"2026-11-10T12:00:00 INFO search target {index}\\n" for index in range(50)
        ), encoding="utf-8")
        ui, win = make_window(window_page="recent", window_animations=False)
        win.show()
        win.resize(480, 360)
        QtTest.QTest.qWait(50)
        recent = win._recent_widget
        recent.set_rows([{"gameId": "fixture", "status": "uploaded"}])
        app.processEvents()
        assert (win.width(), win.height()) == (480, 360)
        assert recent.horizontalScrollBar().maximum() == 0
        check_controls(recent.controls_panel, *recent.filters.values(), recent.date)

        win._go_to_page("log")
        QtTest.QTest.qWait(50)
        log = win._activity_log
        assert log.horizontalScrollBar().maximum() == 0
        check_controls(log.header_panel, log.header_title, log.header_help, log.filter_combo, log.open_folder_button)
        check_controls(log.toolbar_panel, log.search, log.match_count, log.follow, log.copy_button, log.support_copy_button)

        win.activateWindow()
        log.search.setFocus()
        app.processEvents()
        outer_scroll = log.verticalScrollBar()
        outer_scroll.setValue(0)
        log.search.setText("search target")
        assert log.match_count.text() == "1 of 50"
        assert outer_scroll.value() == 0
        QtTest.QTest.keyClick(log.search, QtCore.Qt.Key_F3)
        assert log.match_count.text() == "2 of 50"
        cursor = log.view.cursorRect()
        top_left = log.view.viewport().mapTo(log.viewport(), cursor.topLeft())
        assert outer_scroll.value() > 0
        assert log.viewport().rect().contains(QtCore.QRect(top_left, cursor.size()))
        assert log.search.hasFocus()
        win._companion_page.shutdown()
        win._race_effects.shutdown()
        win._really_quit = True
        win.close()
    '''), timeout=45)


@pytest.mark.parametrize("kind", ["recent", "log"])
def test_a_page_fills_a_tall_window_without_a_scroll_bar(app, tmp_path, kind):
    page = build_page(kind, tmp_path)
    page.setStyleSheet(theme.STYLE)
    try:
        page.resize(900, 800)
        page.show()
        settle(app)
        assert page.verticalScrollBar().maximum() == 0
        assert page.widget().height() == page.viewport().height()
    finally:
        page.close()
        page.deleteLater()
        settle(app)


@pytest.mark.parametrize("skin", list(theme.SKINS))
def test_a_checked_segment_button_wears_the_skin_accent_and_its_own_padding(app, skin):
    button = QtWidgets.QPushButton("2")
    button.setObjectName("segment")
    button.setCheckable(True)
    button.setChecked(True)
    button.setFocusPolicy(QtCore.Qt.NoFocus)
    button.setStyleSheet(theme.STYLE + theme.skin_layer(skin))
    button.resize(64, 36)
    button.show()
    settle(app)
    try:
        edge = button.grab().toImage().pixelColor(0, 18)
        assert edge == QtGui.QColor(theme.SKINS[skin].accent)
        regular = QtWidgets.QPushButton("2")
        regular.setStyleSheet(theme.STYLE)
        assert button.sizeHint().width() > regular.sizeHint().width()
    finally:
        button.close()


def test_the_settings_form_keeps_its_labels_on_the_left_at_every_width(tmp_path):
    run_gui_check(tmp_path, '''
        from sc2tools_agent.ui.qt_helpers import install_responsive_forms
        scroll = QtWidgets.QScrollArea()
        scroll.setWidgetResizable(True)
        page = QtWidgets.QWidget()
        form = QtWidgets.QFormLayout(page)
        form.addRow("Player handle", QtWidgets.QLineEdit())
        scroll.setWidget(page)
        guard = install_responsive_forms(scroll, QtCore=QtCore, QtWidgets=QtWidgets)
        for width in (900, 400):
            scroll.resize(width, 300)
            scroll.show()
            app.processEvents()
            assert form.labelAlignment() & QtCore.Qt.AlignLeft, width
            assert not form.labelAlignment() & QtCore.Qt.AlignRight, width
    ''')


def test_checkin_previews_wrap_without_clipping_at_125_percent(tmp_path, monkeypatch):
    monkeypatch.setenv("QT_SCALE_FACTOR", "1.25")
    run_gui_check(tmp_path, THEMED_SETUP.replace("FONT_SIZE", "10") + dedent('''
        from sc2tools_agent.ui.build_checkin_settings import CheckinSettingsGroup

        group = CheckinSettingsGroup(controller=lambda: None, available=True,
                                     on_preview=lambda _kind: None)
        loading, postgame = group.preview_loading, group.preview_postgame
        group.show()
        for width, wraps in ((320, True), (560, False), (320, True)):
            group.resize(width, 720)
            app.processEvents()
            assert group.width() == width
            assert (postgame.y() > loading.y()) is wraps
            for button in (loading, postgame):
                assert button.width() >= button.sizeHint().width()
                assert group.rect().contains(button.geometry())
        group.close()
    '''))


def amber_pixels(widget):
    image = widget.grab().toImage()
    return sum(image.pixelColor(x, y).red() > 200 and image.pixelColor(x, y).blue() < 120
               for x in range(image.width()) for y in range(image.height()))


def test_a_missing_replay_folder_is_summarised_in_the_warning_colour(app, tmp_path):
    from sc2tools_agent.folder_info import describe_folder
    from sc2tools_agent.ui.folder_rows import build_folder_rows

    present, gone = tmp_path / "Multiplayer", tmp_path / "Gone"
    present.mkdir()
    folders = QtWidgets.QListWidget()
    folders.setStyleSheet(theme.STYLE)
    for path in (present, gone):
        folders.addItem(str(path))
    rows = build_folder_rows(folders, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets, open_folder=lambda _path: None)
    try:
        rows.render()
        rows.pool.waitForDone()
        for path in (present, gone):
            rows.finish(str(path), describe_folder(str(path)))
        folders.resize(420, 220)
        folders.show()
        settle(app)
        summaries = [folders.itemWidget(folders.item(index)).findChild(QtWidgets.QLabel, "folderSummary")
                     for index in range(2)]
        assert [summary.property("missing") for summary in summaries] == [False, True]
        assert amber_pixels(summaries[0]) == 0 and amber_pixels(summaries[1]) > 0
    finally:
        folders.close()


def test_settings_upload_concurrency_buttons_take_the_themes_segment_style(tmp_path):
    run_gui_check(tmp_path, '''
        app.setStyleSheet(gui._STYLE)
        ui, win = make_window(window_page="settings")
        assert [button.objectName() for button in win._upload_conc_buttons.values()] == ["segment", "segment"]
        assert not any(button.styleSheet() for button in win._upload_conc_buttons.values())
        assert win.findChild(QtWidgets.QLabel, "hint") is not None
        win._companion_page.shutdown()
        win.hide()
    ''')
