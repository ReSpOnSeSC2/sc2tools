from __future__ import annotations

import ast
from pathlib import Path
import re

import pytest

from sc2tools_agent.ui import race_visuals, theme
from sc2tools_agent.ui.race_visuals import EXPAND_DURATION_MS, RACE_SKINS, css_for_skin, normalize_skin, palette_for_skin
from tests._gui_offscreen import run_gui_check


def test_options_are_optional_and_imports_remain_qt_free():
    assert RACE_SKINS == (("Default", "default"), ("Protoss", "protoss"), ("Terran", "terran"), ("Zerg", "zerg"))
    imports = [node for node in ast.walk(ast.parse(Path(race_visuals.__file__).read_text()))
               if isinstance(node, (ast.Import, ast.ImportFrom))]
    assert not any("PySide" in ast.unparse(node) or "PyQt" in ast.unparse(node) for node in imports)
    assert 250 <= EXPAND_DURATION_MS <= 500


@pytest.mark.parametrize("value,expected", [(None, "default"), ({}, "default"), (True, "default"),
                                           ("Unknown", "default"), (" Protoss ", "protoss"),
                                           ("TERRAN", "terran"), ("Zerg", "zerg")])
def test_skin_normalization_is_bounded_and_never_infers_a_players_race(value, expected):
    assert normalize_skin(value) == expected


@pytest.mark.parametrize("skin", ["default", "protoss", "terran", "zerg"])
def test_palettes_are_valid_independent_copies_and_keep_dark_readable_surfaces(skin):
    colors = palette_for_skin(skin)
    assert colors["surface"] == theme.SURFACE
    assert all(re.fullmatch(r"#[0-9a-f]{6}", value) for value in colors.values())
    colors["border"] = "changed"
    assert palette_for_skin(skin)["border"] != "changed"


def test_default_is_an_exact_stylesheet_noop_and_race_overrides_leave_semantics_alone():
    assert css_for_skin("default") == css_for_skin(None) == css_for_skin("bad") == ""
    for skin in ("protoss", "terran", "zerg"):
        style = css_for_skin(skin)
        assert style.count("{") == style.count("}")
        assert "QFrame#agentFrame" in style and "QFrame#companionConsole" in style
        assert "QFrame#consoleDisplay" in style and "QFrame#card" in style
        assert "QCheckBox::indicator:checked" in style
        assert "QTableView::item:selected" in style
        assert palette_for_skin(skin)["border"] in style
        assert not any(selector in style for selector in ("#badgeErr", "#badgeOk", 'tone="success"', 'tone="danger"'))
        assert "QPushButton#danger:hover" in style and "QToolButton#windowClose:hover" in style
        assert "background: #8c345d; border-color: " + theme.DANGER in style
        assert all(theme.DANGER in line for line in style.splitlines() if re.search(r"(?<!-)\bcolor:", line))


def test_effects_are_child_only_mouse_transparent_and_never_run_an_idle_timer(tmp_path):
    run_gui_check(tmp_path, '''
from sc2tools_agent.ui.race_visuals import create_race_effects
window = QtWidgets.QWidget()
window.resize(340, 78)
layout = QtWidgets.QHBoxLayout(window)
button = QtWidgets.QPushButton("Underlying control")
layout.addWidget(button)
window.show()
app.processEvents()
effects = create_race_effects(window, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
assert effects.skin == "default" and not effects.overlay.isVisible()
assert not effects.timer.isActive() and not effects.play_expand()
effects.apply_skin("protoss")
app.processEvents()
assert effects.overlay.isVisible() and effects.overlay.parentWidget() is window
assert not effects.overlay.isWindow()
assert not (effects.overlay.windowFlags() & QtCore.Qt.WindowStaysOnTopHint)
assert effects.overlay.testAttribute(QtCore.Qt.WA_TransparentForMouseEvents)
assert effects.overlay.focusPolicy() == QtCore.Qt.NoFocus
assert effects.overlay.geometry() == window.rect()
assert not effects.timer.isActive()
button.setFocus()
app.processEvents()
focused = app.focusWidget()
calls = []
button.clicked.connect(lambda: calls.append(True))
QtTest.QTest.mouseClick(button, QtCore.Qt.LeftButton)
assert calls == [True]
for size in ((280, 68), (520, 480), (1024, 800)):
    window.resize(*size)
    app.processEvents()
    assert effects.overlay.geometry() == window.rect()
    assert not effects.timer.isActive()
    assert app.focusWidget() is focused
effects.apply_skin("default")
assert not effects.overlay.isVisible()
effects.shutdown()
window.close()
''')


@pytest.mark.parametrize("skin", ["protoss", "terran", "zerg"])
def test_each_expansion_finishes_without_geometry_focus_or_persistent_center_paint(tmp_path, skin):
    run_gui_check(tmp_path, f'''
from sc2tools_agent.ui.race_visuals import create_race_effects, EXPAND_DURATION_MS
window = QtWidgets.QWidget()
window.resize(520, 480)
button = QtWidgets.QPushButton("Focusable control", window)
button.setGeometry(100, 100, 180, 40)
window.show()
button.setFocus()
app.processEvents()
effects = create_race_effects(window, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
effects.apply_skin({skin!r})
original_geometry = window.geometry()
focused = app.focusWidget()
assert effects.play_expand()
assert effects.timer.isActive()
QtTest.QTest.qWait(EXPAND_DURATION_MS + 120)
assert not effects.timer.isActive() and effects.overlay.progress is None
assert effects.overlay.isVisible()
assert window.geometry() == original_geometry and app.focusWidget() is focused
pixmap = QtGui.QPixmap(effects.overlay.size())
pixmap.fill(QtCore.Qt.transparent)
painter = QtGui.QPainter(pixmap)
effects.overlay.render(painter, QtCore.QPoint(), QtGui.QRegion(), QtWidgets.QWidget.DrawChildren)
painter.end()
image = pixmap.toImage()
assert image.pixelColor(image.width() // 2, image.height() // 2).alpha() == 0
assert any(image.pixelColor(horizontal, vertical).alpha() > 0
           for vertical in range(2, 30) for horizontal in range(10, image.width() - 10))
effects.shutdown()
window.close()
''')


def test_motion_toggle_cancellation_skin_changes_and_shutdown_are_safe(tmp_path):
    run_gui_check(tmp_path, '''
from sc2tools_agent.ui.race_visuals import create_race_effects
window = QtWidgets.QWidget()
window.resize(340, 78)
window.show()
app.processEvents()
effects = create_race_effects(window, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
effects.apply_skin("terran")
effects.set_motion_enabled(False)
assert not effects.play_expand() and not effects.timer.isActive()
assert effects.overlay.isVisible()
effects.set_motion_enabled(True)
assert not effects.timer.isActive()
assert effects.play_expand()
effects.set_motion_enabled(False)
assert not effects.timer.isActive() and effects.overlay.progress is None
effects.set_motion_enabled(True)
assert effects.play_expand()
effects.apply_skin("zerg")
assert not effects.timer.isActive() and effects.skin == "zerg"
assert effects.play_expand()
window.hide()
app.processEvents()
assert not effects.timer.isActive()
window.show()
app.processEvents()
assert not effects.timer.isActive() and effects.overlay.isVisible()
assert effects.play_expand()
effects.shutdown()
effects.shutdown()
assert not effects.timer.isActive() and not effects.overlay.isVisible()
assert not effects.play_expand()
effects.apply_skin("protoss")
assert not effects.overlay.isVisible()
window.close()
''')


def test_frame_target_tracks_the_real_bezel_without_painting_captions_below_it(tmp_path):
    run_gui_check(tmp_path, '''
from sc2tools_agent.ui.race_visuals import create_race_effects
window = QtWidgets.QWidget()
window.resize(520, 480)
frame = QtWidgets.QFrame(window)
frame.setGeometry(12, 12, 496, 420)
caption = QtWidgets.QLabel("Status below bezel", window)
caption.setGeometry(12, 445, 300, 22)
window.show()
app.processEvents()
effects = create_race_effects(window, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
effects.apply_skin("terran")
effects.set_frame_target(frame)
assert effects.overlay.geometry() == frame.geometry()
assert effects.overlay.geometry().bottom() < caption.y()
frame.move(20, 16)
frame.resize(480, 410)
app.processEvents()
assert effects.overlay.geometry() == frame.geometry()
assert effects.play_expand()
frame.hide()
app.processEvents()
assert not effects.timer.isActive() and not effects.overlay.isVisible()
frame.show()
app.processEvents()
assert effects.overlay.isVisible() and not effects.timer.isActive()
foreign = QtWidgets.QWidget()
try:
    effects.set_frame_target(foreign)
    raise AssertionError("Foreign frame accepted")
except ValueError:
    pass
assert effects.overlay.geometry() == frame.geometry()
effects.set_frame_target(None)
assert effects.overlay.geometry() == window.rect()
effects.shutdown()
window.close()
foreign.close()
''')


def test_protoss_fallback_rails_have_metal_depth_and_cyan_channels_while_the_interior_stays_clear(tmp_path):
    run_gui_check(tmp_path, '''
from types import SimpleNamespace
from sc2tools_agent.ui import race_visuals
from sc2tools_agent.ui.race_visuals import create_race_effects, css_for_skin
race_visuals.create_race_artwork = lambda **kwargs: SimpleNamespace(paint=lambda *args: False)
assert "stop:0 #242329" in css_for_skin("protoss")
window = QtWidgets.QWidget()
window.resize(520, 480)
window.show()
app.processEvents()
effects = create_race_effects(window, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
effects.apply_skin("protoss")
for size in ((520, 480), (1024, 800)):
    window.resize(*size)
    app.processEvents()
    pixmap = QtGui.QPixmap(window.size())
    pixmap.fill(QtCore.Qt.transparent)
    painter = QtGui.QPainter(pixmap)
    effects.overlay.render(painter, QtCore.QPoint(), QtGui.QRegion(), QtWidgets.QWidget.DrawChildren)
    painter.end()
    image = pixmap.toImage()
    rail = [image.pixelColor(image.width() // 4, row) for row in range(2, 15)]
    assert len({color.name() for color in rail if color.alpha() > 0}) >= 6
    assert any(color.green() > 140 and color.blue() > 140 and color.red() < color.green() for color in rail)
    assert any(color.red() > color.blue() * 1.2 and color.red() > 120 for color in rail)
    assert image.pixelColor(16, image.height() // 2).alpha() == 0
    assert image.pixelColor(image.width() // 2, 18).alpha() == 0
    assert not effects.timer.isActive()
effects.shutdown()
window.close()
''')
