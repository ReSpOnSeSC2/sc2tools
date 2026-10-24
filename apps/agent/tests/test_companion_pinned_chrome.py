from __future__ import annotations

import textwrap

import pytest

from tests._gui_offscreen import run_gui_check


def run_panel_check(tmp_path, body):
    setup = '''
from copy import deepcopy
import os
import time
from sc2tools_agent.companion_modes import default_modes
from sc2tools_agent.companion_ghost import normalize_ghost_state
from sc2tools_agent.ui.companion_page import build_companion_page
from sc2tools_agent.ui import theme
fonts = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
for filename in ("segoeui.ttf", "segoeuib.ttf", "seguisb.ttf"):
    font_path = fonts / filename
    if font_path.is_file():
        QtGui.QFontDatabase.addApplicationFont(str(font_path))
app.setStyleSheet(theme.STYLE)
state = {
    "preferences": {"overlaysEnabled": True, "opponentOverlay": True, "scoutingOverlay": True},
    "ghost": {"v": 1, "enabled": False, "slots": {}}, "calls": [],
}
def handler(payload):
    state["calls"].append(deepcopy(payload))
    action = payload["action"]
    if action == "snapshot":
        return {"paired": True, "preferences": deepcopy(state["preferences"]),
                "modes": default_modes(), "liveGame": {"phase": "menu"}}
    if action == "preferences":
        state["preferences"] = deepcopy(payload["preferences"])
        return {"preferences": deepcopy(state["preferences"])}
    if action == "companion_modes":
        return {"modes": default_modes(), "preferences": deepcopy(state["preferences"])}
    if action == "ghost_state":
        return {"ghost": deepcopy(state["ghost"])}
    if action == "ghost_save":
        if "enabled" in payload:
            state["ghost"]["enabled"] = payload["enabled"]
        return {"ghost": deepcopy(state["ghost"])}
    return {"items": []}
def wait_until(predicate):
    deadline = time.monotonic() + 4
    while not predicate() and time.monotonic() < deadline:
        app.processEvents()
        QtTest.QTest.qWait(5)
    assert predicate()
page = build_companion_page(None, handler=handler, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
page.timer.stop()
ghost = page.ghost_page
ghost.timer.stop()
wait_until(lambda: page._paired and not page._requests and not ghost._busy)
page._detail = {"name": "Nightshade", "race": "Zerg", "mmr": 4268,
                "totals": {"wins": 3, "losses": 2}, "last5GamesScouting": []}
page.preview_button.setChecked(True)
page._update_overlays()
target = {"v": 1, "name": "Blink expand", "sourceGameId": "source", "steps": [
    {"t": 50, "name": "Gateway", "kind": "building", "supply": 16},
    {"t": 100, "name": "Stalker", "kind": "unit", "supply": 22},
]}
state["ghost"] = {"v": 1, "enabled": True, "slots": {"PvT": target}}
ghost._state = normalize_ghost_state(state["ghost"])
live = {"liveGame": {"phase": "match_in_progress", "gameKey": "live", "displayTime": 100,
        "capturedAt": time.time(), "players": [{"type": "user"}, {"type": "user"}],
        "user": {"race": "Protoss"}, "opponent": {"name": "Opponent", "race": "Terran"}}}
ghost.update_snapshot(live)
ghost.set_assistance_enabled(True)
panels = {**page.overlays, "ghost": ghost.panel}
app.processEvents()
'''
    cleanup = '''
finally:
    page.shutdown()
    page.deleteLater()
    app.processEvents()
'''
    run_gui_check(tmp_path, setup + "\ntry:\n" + textwrap.indent(textwrap.dedent(body), "    ") + cleanup)


@pytest.mark.parametrize("kind", ["opponent", "scouting", "ghost"])
def test_each_pin_has_themed_controls_native_drag_resize_and_no_windows_titlebar(tmp_path, kind):
    run_panel_check(tmp_path, f'''
        from types import SimpleNamespace
        panel = panels[{kind!r}]
        assert panel.windowFlags() & QtCore.Qt.FramelessWindowHint
        assert panel.windowFlags() & QtCore.Qt.Tool
        assert panel.windowFlags() & QtCore.Qt.WindowStaysOnTopHint
        assert panel.testAttribute(QtCore.Qt.WA_ShowWithoutActivating)
        assert not panel.testAttribute(QtCore.Qt.WA_QuitOnClose)
        controls = panel.identity_card if {kind!r} == "opponent" else panel.window_controls
        assert controls.minimize_button.isVisible() and controls.close_button.isVisible()
        assert controls.minimize_button.accessibleName()
        assert controls.close_button.accessibleName()
        if {kind!r} != "opponent":
            assert controls.maximize_button.isHidden()
        interactions = panel._window_interactions
        title = panel.identity_card.name_label if {kind!r} == "opponent" else panel.title
        assert interactions._drag_target(title)
        assert not interactions._drag_target(controls.minimize_button)
        assert not interactions._drag_target(controls.close_button)
        if {kind!r} != "opponent":
            assert not interactions._drag_target(panel.steps if {kind!r} == "ghost" else panel.comparison.build_chains["my"])
        calls = []
        panel.windowHandle = lambda: SimpleNamespace(
            startSystemMove=lambda: calls.append("move") or True,
            startSystemResize=lambda edges: calls.append(edges) or True,
        )
        def mouse(position):
            return QtGui.QMouseEvent(QtCore.QEvent.MouseButtonPress, QtCore.QPointF(position),
                QtCore.QPointF(position), QtCore.Qt.LeftButton, QtCore.Qt.LeftButton, QtCore.Qt.NoModifier)
        assert interactions.eventFilter(title, mouse(QtCore.QPoint(15, 12)))
        assert interactions.eventFilter(panel, mouse(QtCore.QPoint(1, 45)))
        assert calls == ["move", QtCore.Qt.LeftEdge]
        controls.minimize_button.click()
        app.processEvents()
        assert panel.isMinimized()
    ''')


@pytest.mark.parametrize("kind", ["opponent", "scouting", "ghost"])
def test_each_pin_uses_packaged_race_art_without_idle_motion_or_changing_its_content(tmp_path, kind):
    run_panel_check(tmp_path, f'''
        panel = panels[{kind!r}]
        original_geometry = panel.geometry()
        original_style = panel.styleSheet()
        original_title = panel.identity_card.name_label.full_text if {kind!r} == "opponent" else panel.title.text()
        controls = panel.identity_card if {kind!r} == "opponent" else panel.window_controls
        original_control_style = controls.styleSheet()
        for skin in ("protoss", "terran", "zerg"):
            panel.set_appearance(skin, True)
            app.processEvents()
            effects = panel._race_effects
            assert effects.skin == skin and effects.motion_enabled
            assert effects.overlay.isVisible()
            assert effects.overlay.artwork.image_for_skin(skin) is not None
            assert effects.overlay.testAttribute(QtCore.Qt.WA_TransparentForMouseEvents)
            assert effects.overlay.focusPolicy() == QtCore.Qt.NoFocus
            assert not effects.timer.isActive() and effects.overlay.progress is None
            assert panel.geometry() == original_geometry
            assert (panel.identity_card.name_label.full_text if {kind!r} == "opponent" else panel.title.text()) == original_title
            for button in (controls.minimize_button, controls.close_button):
                position = button.mapTo(panel, QtCore.QPoint())
                assert panel.rect().contains(QtCore.QRect(position, button.size()))
            assert panel.grab().save(str(base / ({kind!r} + "-" + skin + ".png")))
        panel.set_appearance("default", False)
        app.processEvents()
        assert panel.styleSheet() == original_style
        assert controls.styleSheet() == original_control_style
        assert not panel._race_effects.overlay.isVisible()
        assert not panel._race_effects.motion_enabled
        assert not panel._race_effects.timer.isActive()
        assert panel.geometry() == original_geometry
    ''')


@pytest.mark.parametrize("kind", ["opponent", "scouting"])
def test_pinned_panels_keep_minimized_on_poll_restore_on_explicit_pin_and_close_disables_only_that_pin(tmp_path, kind):
    run_panel_check(tmp_path, f'''
        panel = panels[{kind!r}]
        controls = panel.identity_card if {kind!r} == "opponent" else panel.window_controls
        controls.minimize_button.click()
        app.processEvents()
        for tick in range(3):
            page._update_overlays()
            app.processEvents()
            assert panel.isMinimized()
        page.set_preference({kind!r} + "Overlay", True)
        wait_until(lambda: not page._preference_busy)
        assert panel.isVisible() and not panel.isMinimized()
        assert state["preferences"][{kind!r} + "Overlay"]
        controls.close_button.click()
        wait_until(lambda: not page._preference_busy)
        assert not panel.isVisible()
        assert not state["preferences"][{kind!r} + "Overlay"]
        assert state["preferences"]["overlaysEnabled"]
        other = "scouting" if {kind!r} == "opponent" else "opponent"
        assert state["preferences"][other + "Overlay"]
    ''')


def test_ghost_pin_keeps_minimized_on_poll_restores_explicitly_and_close_keeps_targets(tmp_path):
    run_panel_check(tmp_path, '''
        panel = ghost.panel
        panel.window_controls.minimize_button.click()
        app.processEvents()
        for tick in range(3):
            ghost.update_snapshot(live)
            ghost.set_assistance_enabled(True)
            app.processEvents()
            assert panel.isMinimized()
        ghost._set_enabled(True)
        wait_until(lambda: not ghost._busy and not ghost._pending_saves)
        assert panel.isVisible() and not panel.isMinimized()
        panel.window_controls.minimize_button.click()
        ghost.set_assistance_enabled(False)
        assert not panel.isVisible()
        ghost.set_assistance_enabled(True)
        app.processEvents()
        assert panel.isVisible() and not panel.isMinimized()
        panel.window_controls.close_button.click()
        wait_until(lambda: not ghost._busy and not ghost._pending_saves)
        assert not panel.isVisible()
        assert not state["ghost"]["enabled"]
        assert state["ghost"]["slots"]["PvT"] == target
        assert page._preferences["overlaysEnabled"]
    ''')


def test_main_appearance_changes_reach_each_parentless_pin_and_default_restores_original_styles(tmp_path):
    run_gui_check(tmp_path, '''
        from sc2tools_agent.ui import theme
        app.setStyleSheet(theme.STYLE)
        ui, window = make_window(window_page="companion")
        page = window._companion_page
        panels = [*page.overlays.values(), page.ghost_page.panel, page.session_panel]
        original_styles = [panel.styleSheet() for panel in panels]
        for skin in ("protoss", "terran", "zerg", "default"):
            page.appearance_skin.setCurrentIndex(page.appearance_skin.findData(skin))
            app.processEvents()
            for panel in panels:
                assert panel._race_effects.skin == skin
                assert panel._race_effects.motion_enabled
                assert not panel._race_effects.timer.isActive()
        assert [panel.styleSheet() for panel in panels] == original_styles
        page.appearance_animations.setChecked(False)
        assert all(not panel._race_effects.motion_enabled for panel in panels)
        window._race_effects.shutdown()
        page.shutdown()
        window.hide()
    ''', timeout=60)
