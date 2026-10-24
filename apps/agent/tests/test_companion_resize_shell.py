import pytest

from tests._gui_offscreen import run_gui_check


THEMED_SETUP = '''
import os
from sc2tools_agent.ui import theme
fonts = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
for filename in ("segoeui.ttf", "segoeuib.ttf", "seguisb.ttf"):
    font_path = fonts / filename
    if font_path.is_file():
        QtGui.QFontDatabase.addApplicationFont(str(font_path))
app.setFont(QtGui.QFont("Segoe UI", FONT_SIZE))
app.setStyleSheet(theme.STYLE)
'''


def test_flow_actions_wrap_at_full_size_and_reflow_without_losing_values(tmp_path):
    run_gui_check(tmp_path, THEMED_SETUP.replace("FONT_SIZE", "10") + '''
from sc2tools_agent.ui.qt_helpers import build_flow_layout
scroll = QtWidgets.QScrollArea()
scroll.setWidgetResizable(True)
content = QtWidgets.QWidget()
vertical = QtWidgets.QVBoxLayout(content)
vertical.setSizeConstraint(QtWidgets.QLayout.SetMinimumSize)
actions = QtWidgets.QWidget()
flow = build_flow_layout(actions, QtCore=QtCore, QtWidgets=QtWidgets)
flow.setContentsMargins(4, 3, 4, 3)
controls = [QtWidgets.QCheckBox("Pre-game build selector"),
            QtWidgets.QCheckBox("Post-game build selector"),
            QtWidgets.QPushButton("Refresh replays")]
controls[0].setChecked(True)
for control in controls:
    flow.addWidget(control)
vertical.addWidget(actions)
vertical.addStretch()
scroll.setWidget(content)
scroll.show()
for width in (1024, 380, 480, 1024, 380):
    scroll.resize(width, 280)
    QtTest.QTest.qWait(10)
    assert scroll.horizontalScrollBar().maximum() == 0
    assert actions.height() >= flow.heightForWidth(actions.width())
    assert controls[0].isChecked()
    for index, control in enumerate(controls):
        assert actions.rect().contains(control.geometry())
        assert control.width() >= control.sizeHint().width()
        assert control.height() >= control.sizeHint().height()
        for other in controls[index + 1:]:
            assert not control.geometry().intersects(other.geometry())
    assert len({control.y() for control in controls}) == (1 if width == 1024 else 2)
controls[1].hide()
QtTest.QTest.qWait(10)
assert flow.count() == 3
assert flow.takeAt(1).widget() is controls[1]
assert flow.count() == 2
assert flow.itemAt(2) is None and flow.takeAt(-1) is None
scroll.close()
''')


@pytest.mark.parametrize("font_size,scale_factor", [(10, "1"), (10, "1.25"), (12, "1.5")])
def test_real_themed_shell_preserves_header_navigation_across_all_size_changes(tmp_path, monkeypatch, font_size, scale_factor):
    monkeypatch.setenv("QT_SCALE_FACTOR", scale_factor)
    run_gui_check(tmp_path, THEMED_SETUP.replace("FONT_SIZE", str(font_size)) + '''
from types import SimpleNamespace
ui, win = make_window(
    window_page="companion", window_animations=False,
    on_companion_action=lambda request: {"paired": False, "items": [], "preferences": {}},
)
win._window_size_screen = lambda: SimpleNamespace(availableGeometry=lambda: QtCore.QRect(0, 0, 1920, 1080))
page = win._companion_page
page.timer.stop()
page.randomizer_page.timer.stop()
page.ghost_page.timer.stop()
QtTest.QTest.qWait(50)
console = page.console
win._handle_input.setText("Unsaved player name")
page._selected_id = "opponent-one"
page._detail = {"name": "NightshadeTheLongOpponentName", "race": "Zerg", "mmr": 5132, "totals": {"wins": 3, "losses": 3}}
page._games = [{"gameId": "replay-one", "map": "A long replay and map description", "myRace": "Protoss", "oppRace": "Zerg",
                "myBuild": "A very long selected build description", "oppStrategy": "A long opponent opening description",
                "myTechMilestones": [{"name": "Cybernetics Core", "timeSec": 85, "kind": "building", "timing": "started"}]}]
selection_blocker = QtCore.QSignalBlocker(page.game_select)
page.game_select.addItem("A long replay and map description", "replay-one")
del selection_blocker
console.set_context(opponent_id="opponent-one", game_id="replay-one")
console.set_breadcrumb(opponent_name="NightshadeTheLongOpponentName", game_title="A long replay and map description")
win.show()
for skin in ("default", "protoss", "terran", "zerg"):
    page.appearance_skin.setCurrentIndex(page.appearance_skin.findData(skin))
    for preset in ("Detailed", "Standard", "Compact", "Standard", "Full workspace", "Standard"):
        assert win._set_window_size(preset)
        for iteration in range(5):
            app.processEvents()
        if preset == "Compact":
            assert win.size().toTuple() == (340, 78)
            assert page.compact_card.isVisible()
            continue
        for route in ("home", "profile", "scouting", "builds", "randomizer", "ghost", "opponents", "settings"):
            assert console.navigate(route) or console.current_route() == route
            for iteration in range(5):
                app.processEvents()
            assert console.context()["opponentId"] == "opponent-one", (skin, preset, route, console.context())
            assert console.context()["gameId"] == "replay-one", (skin, preset, route, console.context())
            assert win._handle_input.text() == "Unsaved player name"
            assert console.brand_widget.rect().contains(win._companion_window_controls.geometry())
            for index in range(console.brand_actions.count()):
                action = console.brand_actions.itemAt(index).widget()
                assert console.brand_actions_widget.rect().contains(action.geometry()), (skin, preset, route, action.geometry())
                assert action.width() >= action.minimumSizeHint().width(), (skin, preset, route, action.text())
            assert console.breadcrumb.fontMetrics().horizontalAdvance(console.breadcrumb.text()) <= console.breadcrumb.contentsRect().width()
            assert console.breadcrumb.toolTip() == console.breadcrumb.full_text
            assert console.breadcrumb.accessibleName() == console.breadcrumb.full_text
            if route == "settings":
                assert page.controls_page.horizontalScrollBar().maximum() == 0, (skin, preset, page.controls_page.viewport().size())
            assert not win.grab().isNull()
        if preset == "Standard":
            assert win.size().toTuple() == (520, 480)
page.shutdown()
win._race_effects.shutdown()
win._really_quit = True
win.close()
''', timeout=90)
