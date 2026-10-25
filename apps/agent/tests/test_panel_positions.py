from copy import deepcopy
import textwrap

import pytest

from sc2tools_agent.panel_positions import normalize_panel_positions, restored_panel_position
from sc2tools_agent.state import AgentState, load_state, save_state
from tests._gui_offscreen import run_gui_check


THEMED_SETUP = textwrap.indent('''
import os
from sc2tools_agent.ui import theme
fonts = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
for filename in ("segoeui.ttf", "segoeuib.ttf", "seguisb.ttf"):
    font_path = fonts / filename
    if font_path.is_file():
        QtGui.QFontDatabase.addApplicationFont(str(font_path))
app.setFont(QtGui.QFont("Segoe UI", 10))
app.setStyleSheet(theme.STYLE)
''', "        ")


def test_only_valid_native_panel_integer_positions_are_kept_and_copied():
    source = {"opponent": [-1880, 40], "scouting": [True, 2], "session": (10, -40),
              "ghost": [2.5, 10], "other": [20, 30]}
    result = normalize_panel_positions(source)
    assert result == {"opponent": [-1880, 40], "session": [10, -40]}
    result["opponent"][0] = 10
    assert source["opponent"] == [-1880, 40]
    for value in (None, [], "bad", {"opponent": [10]}, {"ghost": [1_000_000, 0]}):
        assert normalize_panel_positions(value) == {}


@pytest.mark.parametrize("saved,default,size,screens,expected", [
    ([-1880, -100], [20, 60], (340, 78), [(-1920, -200, 1920, 1080), (0, 0, 1920, 1040)], (-1880, -100)),
    ([-1950, -210], [20, 60], (340, 78), [(-1920, -200, 1920, 1080)], (-1920, -200)),
    ([-1880, 40], [1560, 60], (340, 78), [(0, 0, 1920, 1040)], (1560, 60)),
    ([1900, 1030], [20, 60], (340, 78), [(0, 0, 1920, 1040)], (20, 60)),
    (None, [4000, 4000], (150, 138), [(0, 0, 1920, 1040)], (0, 0)),
    (None, [20, 60], (340, 78), [], (20, 60)),
])
def test_positions_restore_safely_for_negative_or_missing_monitors(saved, default, size, screens, expected):
    assert restored_panel_position(saved, default, size, screens) == expected


def test_panel_positions_roundtrip_without_changing_pairing_history_or_layout(tmp_path):
    state = AgentState(device_token="example-token", uploaded={"example.SC2Replay": "2026-10-24"})
    state.window_information_layout = "compact"
    state.companion_panel_positions = {"opponent": [-1800, 80], "session": [20, 50], "invalid": [1, 2]}
    before = deepcopy(state.uploaded)
    save_state(tmp_path, state)
    loaded = load_state(tmp_path)
    assert loaded.companion_panel_positions == {"opponent": [-1800, 80], "session": [20, 50]}
    assert loaded.device_token == "example-token"
    assert loaded.uploaded == before
    assert loaded.window_information_layout == "compact"


def test_native_panel_positions_restore_and_only_user_dragging_is_debounced(tmp_path):
    run_gui_check(tmp_path, THEMED_SETUP + '''
        from copy import deepcopy
        from types import SimpleNamespace
        from sc2tools_agent.ui.companion_page import build_companion_page
        saved = []
        positions = {"opponent": [30, 40], "scouting": [100, 150], "session": [10, 20], "ghost": [50, 60]}
        page = build_companion_page(None, handler=None, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets,
                                    panel_positions=positions, on_panel_positions=saved.append)
        manager = page._panel_positions
        panels = {**page.overlays, "session": page.session_panel, "ghost": page.ghost_page.panel}
        dimensions = {kind: panel.size() for kind, panel in panels.items()}
        for kind, panel in panels.items():
            assert [panel.x(), panel.y()] == positions[kind]
            panel.show()
        QtTest.QTest.qWait(400)
        assert saved == []
        panel = panels["scouting"]
        panel.windowHandle = lambda: SimpleNamespace(startSystemMove=lambda: True, startSystemResize=lambda edges: True)
        panel.move(110, 160)
        QtTest.QTest.qWait(400)
        assert saved == []
        QtTest.QTest.mousePress(panel.header, QtCore.Qt.LeftButton, pos=QtCore.QPoint(80, 10))
        panel.move(120, 170)
        panel.move(130, 180)
        app.processEvents()
        QtTest.QTest.mouseRelease(panel.header, QtCore.Qt.LeftButton, pos=QtCore.QPoint(80, 10))
        QtTest.QTest.qWait(400)
        assert len(saved) == 1 and saved[0]["scouting"] == [130, 180], (saved, manager._pending, manager._dragging)
        assert all(panel.size() == dimensions[kind] for kind, panel in panels.items())
        stable = deepcopy(manager.snapshot())
        panel.hide()
        panel.move(5, 5)
        QtTest.QTest.qWait(400)
        panel.show()
        app.processEvents()
        assert [panel.x(), panel.y()] == stable["scouting"]
        assert len(saved) == 1
        page.preview_button.setChecked(True)
        panel.show()
        QtTest.QTest.mousePress(panel.header, QtCore.Qt.LeftButton, pos=QtCore.QPoint(80, 10))
        panel.move(140, 190)
        QtTest.QTest.mouseRelease(panel.header, QtCore.Qt.LeftButton, pos=QtCore.QPoint(80, 10))
        QtTest.QTest.qWait(400)
        assert len(saved) == 1
        page.preview_button.setChecked(False)
        panel.show()
        QtTest.QTest.mousePress(panel.header, QtCore.Qt.LeftButton, pos=QtCore.QPoint(80, 10))
        panel.move(150, 200)
        app.processEvents()
        page._clear_library()
        QtTest.QTest.qWait(400)
        assert len(saved) == 1
        assert manager.snapshot() == stable
        page.reset_panel_positions.click()
        QtTest.QTest.qWait(400)
        assert saved[-1] == {} and manager.snapshot() == {}
        assert all(panel.size() == dimensions[kind] for kind, panel in panels.items())
        assert len(saved) == 2
        page.shutdown()
        page.deleteLater()
        app.processEvents()
    ''')


def test_position_save_failure_retains_last_saved_map_and_reset_is_retryable(tmp_path):
    run_gui_check(tmp_path, THEMED_SETUP + '''
        from types import SimpleNamespace
        from sc2tools_agent.ui.companion_page import build_companion_page
        calls = []
        def fail(positions):
            calls.append(positions)
            raise OSError("Disk unavailable")
        original = {"opponent": [30, 40]}
        page = build_companion_page(None, handler=None, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets,
                                    panel_positions=original, on_panel_positions=fail)
        manager = page._panel_positions
        panel = page.overlays["opponent"]
        panel.windowHandle = lambda: SimpleNamespace(startSystemMove=lambda: True, startSystemResize=lambda edges: True)
        panel.show()
        QtTest.QTest.qWait(20)
        QtTest.QTest.mousePress(panel.identity_card.name_label, QtCore.Qt.LeftButton)
        panel.move(80, 90)
        app.processEvents()
        QtTest.QTest.mouseRelease(panel.identity_card.name_label, QtCore.Qt.LeftButton)
        QtTest.QTest.qWait(400)
        assert calls and manager.snapshot() == original, (calls, manager._pending, manager._dragging)
        assert "could not be saved" in page.panel_position_notice.text()
        assert not manager.reset()
        assert manager.snapshot() == original
        manager._save = calls.append
        assert manager.reset()
        assert manager.snapshot() == {}
        page.shutdown()
        page.deleteLater()
        app.processEvents()
    ''')


def test_gui_passes_saved_panel_positions_and_callback_to_companion(tmp_path):
    run_gui_check(tmp_path, THEMED_SETUP + '''
        saved_positions = []
        ui, window = make_window(companion_panel_positions={"session": [40, 50]},
                                 on_companion_panel_positions=saved_positions.append)
        assert window._companion_page._panel_positions.snapshot() == {"session": [40, 50]}
        window._companion_page.reset_panel_positions.click()
        assert saved_positions == [{}]
        window._companion_page.shutdown()
        window._really_quit = True
        window.close()
    ''')


def test_qt_restores_negative_monitor_position_and_recovers_after_monitor_removal_without_saving(tmp_path):
    run_gui_check(tmp_path, THEMED_SETUP + '''
        from types import SimpleNamespace
        from sc2tools_agent.ui.companion_page import build_companion_page
        original_screens = app.screens
        negative_screen = SimpleNamespace(availableGeometry=lambda: QtCore.QRect(-1920, -200, 1920, 1080))
        app.screens = lambda: [negative_screen, *original_screens()]
        saved = []
        positions = {"opponent": [-1880, -100]}
        page = build_companion_page(None, handler=None, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets,
                                    panel_positions=positions, on_panel_positions=saved.append)
        panel = page.overlays["opponent"]
        original_size = panel.size()
        panel.show()
        QtTest.QTest.qWait(20)
        assert [panel.x(), panel.y()] == positions["opponent"]
        app.screens = original_screens
        page._panel_positions._screens_changed(None)
        QtTest.QTest.qWait(400)
        rectangle = panel.geometry()
        assert any(screen.availableGeometry().contains(rectangle) for screen in original_screens())
        assert panel.size() == original_size
        assert saved == []
        assert page._panel_positions.snapshot() == positions
        page.shutdown()
        page.deleteLater()
        app.processEvents()
    ''')


def test_native_move_after_system_capture_release_is_saved_but_initial_native_moves_are_not(tmp_path):
    run_gui_check(tmp_path, THEMED_SETUP + '''
        from sc2tools_agent.ui.companion_page import build_companion_page
        class NativeMove(QtGui.QMoveEvent):
            def spontaneous(self):
                return True
        saved = []
        page = build_companion_page(None, handler=None, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets,
                                    on_panel_positions=saved.append)
        panel = page.overlays["opponent"]
        panel.show()
        app.processEvents()
        panel.move(60, 70)
        app.sendEvent(panel, NativeMove(panel.pos(), panel.pos()))
        assert not page._panel_positions._pending
        QtTest.QTest.qWait(300)
        panel.move(80, 90)
        app.sendEvent(panel, NativeMove(panel.pos(), panel.pos()))
        QtTest.QTest.qWait(400)
        assert saved == [{"opponent": [80, 90]}]
        page._clear_library()
        panel.move(90, 100)
        app.sendEvent(panel, NativeMove(panel.pos(), panel.pos()))
        QtTest.QTest.qWait(400)
        assert len(saved) == 1
        page.shutdown()
        page.deleteLater()
        app.processEvents()
    ''')


@pytest.mark.parametrize("finish", ["hide", "minimize", "close", "shutdown"])
def test_admitted_user_move_survives_immediate_hide_minimize_close_or_shutdown(tmp_path, finish):
    run_gui_check(tmp_path, THEMED_SETUP + '''
        from sc2tools_agent.ui.companion_page import build_companion_page
        class NativeMove(QtGui.QMoveEvent):
            def spontaneous(self):
                return True
        saved = []
        page = build_companion_page(None, handler=None, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets,
                                    on_panel_positions=saved.append)
        manager = page._panel_positions
        panels = {**page.overlays, "session": page.session_panel, "ghost": page.ghost_page.panel}
        expected = {}
        for index, (kind, panel) in enumerate(panels.items()):
            panel.show()
            app.processEvents()
            manager._ignore_native_until[kind] = 0
            point = [80 + index * 10, 90 + index * 10]
            panel.move(*point)
            app.sendEvent(panel, NativeMove(panel.pos(), panel.pos()))
            assert manager._pending[kind] == point
            expected[kind] = point
        assert saved == []
        finish = ''' + repr(finish) + '''
        if finish == "shutdown":
            page.shutdown()
        else:
            for panel in panels.values():
                if finish == "minimize":
                    panel.showMinimized()
                else:
                    getattr(panel, finish)()
            QtTest.QTest.qWait(400)
        assert saved and saved[-1] == expected, (finish, saved, manager._pending)
        assert manager.snapshot() == expected
        for panel in panels.values():
            panel.move(5, 5)
        QtTest.QTest.qWait(400)
        assert saved[-1] == expected
        page.shutdown()
        page.deleteLater()
        app.processEvents()
    ''')
