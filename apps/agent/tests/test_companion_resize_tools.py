from __future__ import annotations

import os
from pathlib import Path
from textwrap import dedent

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest

pytest.importorskip("PySide6")
from PySide6 import QtCore, QtGui, QtWidgets

from sc2tools_agent.build_checkin.models import PostgameCardModel
from sc2tools_agent.ui import theme
from sc2tools_agent.ui.companion_builds import build_companion_builds
from sc2tools_agent.ui.companion_ghost import build_companion_ghost
from sc2tools_agent.ui.companion_randomizer import build_companion_randomizer
from tests._gui_offscreen import run_gui_check
from tests.test_companion_resize_shell import THEMED_SETUP


@pytest.fixture
def themed_app():
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    previous_font = app.font()
    previous_style = app.styleSheet()
    font_ids = []
    fonts = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
    for filename in ("segoeui.ttf", "segoeuib.ttf", "seguisb.ttf"):
        path = fonts / filename
        if path.is_file():
            font_ids.append(QtGui.QFontDatabase.addApplicationFont(str(path)))
    if not QtGui.QFontDatabase.families():
        pytest.skip("A real font is needed to verify readable control widths.")
    app.setFont(QtGui.QFont("Segoe UI", 10))
    app.setStyleSheet(theme.STYLE)
    yield app
    app.setFont(previous_font)
    app.setStyleSheet(previous_style)
    for font_id in font_ids:
        if font_id >= 0:
            QtGui.QFontDatabase.removeApplicationFont(font_id)


def host_page(page):
    host = QtWidgets.QWidget()
    host.setObjectName("companionDesk")
    host.setStyleSheet(theme.COMPANION_PAGE_STYLE)
    layout = QtWidgets.QVBoxLayout(host)
    layout.setContentsMargins(0, 0, 0, 0)
    layout.addWidget(page)
    host.show()
    return host


def settle(app):
    for _ in range(6):
        app.processEvents()


def assert_full_width(controls, container):
    for control in controls:
        label = control.metaObject().className()
        assert control.width() >= control.sizeHint().width(), label
        position = control.mapTo(container, QtCore.QPoint())
        assert position.x() >= 0, label
        assert position.x() + control.width() <= container.width(), label


def close_page(host, page, app):
    if hasattr(page, "shutdown"):
        page.shutdown()
    host.close()
    host.deleteLater()
    settle(app)


def test_build_selectors_reflow_without_truncation_and_preserve_postgame_draft(themed_app):
    app = themed_app
    page = build_companion_builds(
        None, controller_provider=lambda: None, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets,
    )
    page.dispatch("show_postgame", (PostgameCardModel(
        card_id="resize-card", game_key="resize-game", game_id="game", title="Victory vs Opponent",
        matchup="PvZ", notes="Keep this draft while changing size",
    ),))
    page.tabs.setCurrentIndex(1)
    page.notes.setPlainText("An unsaved postgame draft")
    host = host_page(page)
    try:
        controls = (page.loading_toggle, page.postgame_toggle, page.refresh_button)
        for width, height in ((900, 650), (440, 230), (1024, 650), (400, 230), (900, 650)):
            host.setFixedSize(width, height)
            settle(app)
            assert_full_width(controls, page.scroll.widget())
            assert page.scroll.widget().width() == page.scroll.viewport().width()
            if width <= 440:
                assert len({control.y() for control in controls}) > 1
                assert page.scroll.verticalScrollBar().maximum() > 0
            else:
                assert len({control.y() for control in controls}) == 1
            assert page.tabs.currentIndex() == 1
            assert page.notes.toPlainText() == "An unsaved postgame draft"
            postgame_scroll = page.tabs.widget(1)
            assert_full_width((page.confirm, page.no_build, page.later), postgame_scroll.widget())
            assert postgame_scroll.widget().width() == postgame_scroll.viewport().width()
    finally:
        close_page(host, page, app)


def test_randomizer_settings_scroll_instead_of_squeezing_hints_and_pool(themed_app):
    app = themed_app
    page = build_companion_randomizer(None, handler=None, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
    page.matchup_select.setCurrentText("PvZ")
    page.pool.addTopLevelItem(QtWidgets.QTreeWidgetItem(["A saved pool choice", "1"]))
    page.pool.topLevelItem(0).setCheckState(0, QtCore.Qt.Checked)
    host = host_page(page)
    try:
        for width, height in ((900, 650), (400, 230), (1024, 650), (440, 230), (900, 650)):
            host.setFixedSize(width, height)
            settle(app)
            assert_full_width((page.enabled_check, page.refresh_button, page.save_pool_button), page.scroll.widget())
            assert page.scroll.widget().width() == page.scroll.viewport().width()
            assert page.pool.height() >= 180
            for label in page.scroll.widget().findChildren(QtWidgets.QLabel):
                if label.wordWrap() and label.isVisible():
                    assert label.height() >= label.heightForWidth(label.width())
            if width <= 440:
                assert page.scroll.verticalScrollBar().maximum() > 0
                page.scroll.ensureWidgetVisible(page.status)
                settle(app)
                position = page.status.mapTo(page.scroll.viewport(), QtCore.QPoint())
                assert position.y() + page.status.height() <= page.scroll.viewport().height()
            assert page.matchup_select.currentText() == "PvZ"
            assert page.pool.topLevelItem(0).checkState(0) == QtCore.Qt.Checked
            assert not hasattr(page, "roll_button")
    finally:
        close_page(host, page, app)


def test_ghost_replay_library_actions_wrap_and_history_remains_reachable(themed_app):
    app = themed_app
    page = build_companion_ghost(None, handler=None, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
    page.sources.setCurrentIndex(1)
    page.target_name.setText("Keep my replay target draft")
    page.history_toggle.setChecked(True)
    host = host_page(page)
    try:
        controls = (page.refresh_button, page.more_button, page.load_button)
        for width, height in ((900, 650), (440, 230), (1024, 650), (400, 230), (900, 650)):
            host.setFixedSize(width, height)
            settle(app)
            source_scroll = page.sources.widget(1)
            assert_full_width(controls, source_scroll.widget())
            filters = (page.matchup_filter, page.build_filter, page.map_filter, page.result_filter,
                       page.starred_filter, page.clear_filters_button)
            assert_full_width((*filters, page.compare_button), source_scroll.widget())
            assert all(page.filters_widget.rect().contains(control.geometry()) for control in filters)
            assert source_scroll.widget().width() == source_scroll.viewport().width()
            if width <= 440:
                assert len({control.y() for control in controls}) > 1
            else:
                assert len({control.y() for control in controls}) == 1
            assert page.scroll.widget().width() == page.scroll.viewport().width()
            assert_full_width((page.restore_button,), page.history_group)
            page.scroll.ensureWidgetVisible(page.history_status)
            settle(app)
            position = page.history_status.mapTo(page.scroll.viewport(), QtCore.QPoint())
            assert position.y() + page.history_status.height() <= page.scroll.viewport().height()
            assert page.sources.currentIndex() == 1
            assert page.target_name.text() == "Keep my replay target draft"
    finally:
        close_page(host, page, app)


@pytest.mark.parametrize("scale", ["1.25", "1.5"])
def test_companion_tools_fit_the_minimum_window_at_display_scale(tmp_path, monkeypatch, scale):
    monkeypatch.setenv("QT_SCALE_FACTOR", scale)
    run_gui_check(tmp_path, THEMED_SETUP.replace("FONT_SIZE", "10") + dedent('''
        def assert_fits(scroll, controls):
            content = scroll.widget()
            assert content.width() <= scroll.viewport().width(), (content.width(), scroll.viewport().width())
            assert scroll.horizontalScrollBar().maximum() == 0, scroll.objectName()
            for control in controls:
                assert control.isVisible(), control.metaObject().className()
                position = control.mapTo(content, QtCore.QPoint())
                assert content.rect().contains(QtCore.QRect(position, control.size())), control.objectName()
                assert control.width() >= control.minimumSizeHint().width(), control.objectName()

        _ui, window = make_window(window_page="companion", window_animations=False)
        window.setUpdatesEnabled(False)
        window.show()
        window.resize(480, 360)
        page = window._companion_page
        builds, ghost = page.build_selectors, page.ghost_page
        try:
            for route, scroll, controls in (
                ("builds", builds.scroll, (builds.loading_toggle, builds.postgame_toggle, builds.refresh_button)),
                ("ghost", ghost.scroll, (ghost.enabled_toggle, ghost.matchup, ghost.clear_button,
                                         ghost._hud_preview_button, ghost._hud_move_button)),
            ):
                page.console.navigate(route)
                QtTest.QTest.qWait(25)
                assert window.size() == QtCore.QSize(480, 360)
                assert_fits(scroll, controls)
                assert scroll.verticalScrollBar().maximum() > 0, route

            page.open_full_details()
            window.resize(480, 360)
            ghost.sources.setCurrentIndex(1)
            QtTest.QTest.qWait(25)
            assert window.size() == QtCore.QSize(480, 360)
            library = ghost.sources.currentWidget()
            filters = (ghost.matchup_filter, ghost.build_filter, ghost.map_filter, ghost.result_filter,
                       ghost.starred_filter, ghost.clear_filters_button)
            reference_actions = (ghost.reference_button, ghost.reference_side, ghost.compare_button)
            assert_fits(library, (*filters, *reference_actions))
            filter_box = ghost.filters_widget
            assert filter_box.height() >= filter_box.layout().heightForWidth(filter_box.width())
            assert all(filter_box.rect().contains(control.geometry()) for control in filters)
            assert filter_box.geometry().bottom() < ghost.library_count.geometry().top()
            for control in (*filters, *reference_actions):
                library.ensureWidgetVisible(control)
                position = control.mapTo(library.viewport(), QtCore.QPoint())
                assert library.viewport().rect().contains(QtCore.QRect(position, control.size()))
        finally:
            page.shutdown()
            window._race_effects.shutdown()
            window.hide()
    '''))
