from tests._gui_offscreen import run_gui_check


_SETUP = '''
from copy import deepcopy
import time
from sc2tools_agent.companion_modes import default_modes
from sc2tools_agent.ui import theme
from sc2tools_agent.ui.race_visuals import EXPAND_DURATION_MS
from tests.test_companion_page import game

font = Path("C:/Windows/Fonts/segoeui.ttf")
if font.is_file():
    QtGui.QFontDatabase.addApplicationFont(str(font))
app.setStyleSheet(theme.STYLE)
calls = []
preferences = {"overlaysEnabled": False, "opponentOverlay": False,
               "scoutingOverlay": False, "scoutingReadAloud": False}
snapshot = {"paired": True, "preferences": preferences, "modes": default_modes(),
            "liveGame": {"phase": "match_in_progress", "gameKey": "current",
                         "displayTime": 50, "capturedAt": time.time(),
                         "opponent": {"name": "Live opponent", "race": "Terran",
                                      "profile": {"mmr": 4000}}}}

def handler(payload):
    calls.append(deepcopy(payload))
    action = payload["action"]
    if action == "snapshot":
        snapshot["liveGame"]["capturedAt"] = time.time()
        return deepcopy(snapshot)
    if action == "companion_modes":
        return {"modes": default_modes(), "preferences": preferences}
    if action == "opponents":
        return {"items": [{"pulseId": "one", "displayName": "Library opponent",
                           "race": "Terran", "wins": 2, "losses": 1}]}
    if action == "opponent":
        return {"name": "Library opponent", "last5GamesScouting": [game()],
                "notes": "Saved note"}
    if action == "game_build_order":
        return {"ok": True, "game_id": payload["gameId"],
                "events": [], "opp_events": [], "my_status": "empty", "opp_status": "empty"}
    if action == "ghost_state":
        return {"ghost": {"v": 1, "enabled": False, "slots": {}}, "references": {}}
    if action in {"ghost_games", "ghost_examples"}:
        return {"items": []}
    return {}

def wait_until(predicate):
    deadline = QtCore.QDeadlineTimer(5000)
    while not predicate() and not deadline.hasExpired():
        QtTest.QTest.qWait(5)
    assert predicate(), "The Companion worker did not complete"

def ready_window(**overrides):
    options = {"window_page": "companion", "window_skin": "protoss",
               "window_animations": True, "on_companion_action": handler}
    options.update(overrides)
    ui, window = make_window(**options)
    page = window._companion_page
    page.timer.stop()
    page.randomizer_page.timer.stop()
    window.show()
    wait_until(lambda: page._detail.get("name") == "Library opponent" and not page._requests)
    app.processEvents()
    return ui, window, page, window._race_effects

def settle(effects):
    QtTest.QTest.qWait(EXPAND_DURATION_MS + 100)
    assert not effects.timer.isActive() and effects.overlay.progress is None

def finish(window, page, effects):
    effects.shutdown()
    page.shutdown()
    window.hide()
'''


def test_real_window_expands_only_for_a_larger_explicit_preset_and_maximize(tmp_path):
    run_gui_check(tmp_path, _SETUP + '''
ui, win, page, effects = ready_window()
assert not effects.timer.isActive()
assert win._set_window_size("Compact")
app.processEvents()
assert not effects.timer.isActive()
page.compact_card.enlarge_button.click()
app.processEvents()
assert page.current_density() == "standard"
assert effects.timer.isActive() and effects.overlay.progress is not None
settle(effects)
assert win._set_window_size("Standard")
assert not effects.timer.isActive()
assert win._set_window_size("Detailed")
assert effects.timer.isActive() and effects.overlay.progress is not None
settle(effects)
assert win._set_window_size("Standard")
assert not effects.timer.isActive()
page_controls = win._companion_window_controls
page_controls.maximize_button.click()
app.processEvents()
assert win.isMaximized()
assert effects.timer.isActive() and effects.overlay.progress is not None
settle(effects)
page_controls.maximize_button.click()
app.processEvents()
assert not win.isMaximized() and not effects.timer.isActive()
finish(win, page, effects)
''')


def test_poll_routes_manual_resize_and_build_horizon_never_trigger_motion(tmp_path):
    run_gui_check(tmp_path, _SETUP + '''
ui, win, page, effects = ready_window()
win._set_window_size("Standard")
settle(effects)
win._handle_input.setText("Unsaved settings draft")
page.notes.setPlainText("Unsaved opponent note")
for route in ("settings", "dashboard", "recent", "log", "streams", "companion"):
    win._go_to_page(route)
    app.processEvents()
    assert not effects.timer.isActive(), route
for route in ("opponents", "scouting", "builds", "randomizer", "ghost", "scouting"):
    page.console.navigate(route)
    app.processEvents()
    assert not effects.timer.isActive(), route
for horizon in (360, 600, None, 180):
    page.build_time_range.setCurrentIndex(page.build_time_range.findData(horizon))
    app.processEvents()
    assert not effects.timer.isActive(), horizon
win.resize(700, 600)
app.processEvents()
assert not effects.timer.isActive()
snapshot["liveGame"]["displayTime"] = 90
previous_polls = len([call for call in calls if call["action"] == "snapshot"])
page.refresh()
wait_until(lambda: "snapshot" not in page._requests)
assert len([call for call in calls if call["action"] == "snapshot"]) == previous_polls + 1
assert "1:30" in page.live_label.text()
assert not effects.timer.isActive()
assert win._handle_input.text() == "Unsaved settings draft"
assert page.notes.toPlainText() == "Unsaved opponent note"
finish(win, page, effects)
''')


def test_overlay_tracks_only_the_actual_bezel_and_never_steals_focus_or_mouse_input(tmp_path):
    run_gui_check(tmp_path, _SETUP + '''
ui, win, page, effects = ready_window(window_skin="terran")
win._set_window_size("Standard")
settle(effects)
overlay = effects.overlay
assert overlay.parentWidget() is win and not overlay.isWindow()
assert overlay.testAttribute(QtCore.Qt.WA_TransparentForMouseEvents)
assert overlay.testAttribute(QtCore.Qt.WA_ShowWithoutActivating)
assert overlay.focusPolicy() == QtCore.Qt.NoFocus
for size, target in (("Compact", page.compact_card), ("Standard", page.console)):
    win._set_window_size(size)
    app.processEvents()
    assert effects._frame_target is target
    assert overlay.geometry() == QtCore.QRect(target.mapTo(win, QtCore.QPoint()), target.size())
    if size == "Standard":
        caption_position = page.live_label.mapTo(win, QtCore.QPoint())
        assert overlay.geometry().bottom() < caption_position.y()
win._go_to_page("settings")
app.processEvents()
assert effects._frame_target is win._agent_frame
assert overlay.geometry() == QtCore.QRect(win._agent_frame.mapTo(win, QtCore.QPoint()), win._agent_frame.size())
field = win._handle_input
scroller = win._stack.currentWidget()
assert isinstance(scroller, QtWidgets.QScrollArea)
scroller.ensureWidgetVisible(field)
app.processEvents()
center = field.mapTo(win, field.rect().center())
hit = win.childAt(center)
assert hit is field, (hit, center)
QtTest.QTest.mouseClick(hit, QtCore.Qt.LeftButton)
QtTest.QTest.keyClicks(field, "Still editable")
assert field.text() == "Still editable"
focused = app.focusWidget()
win._set_window_size("Detailed")
assert effects.timer.isActive()
assert app.focusWidget() is focused
settle(effects)
assert app.focusWidget() is focused
finish(win, page, effects)
''')


def test_motion_off_cancels_immediately_and_default_never_runs_an_effect(tmp_path):
    run_gui_check(tmp_path, _SETUP + '''
changes = []
ui, win, page, effects = ready_window(on_window_appearance=lambda skin, animations: changes.append((skin, animations)))
win._set_window_size("Compact")
page.compact_card.enlarge_button.click()
assert effects.timer.isActive()
page.appearance_animations.setChecked(False)
assert not ui._window_animations and not effects.motion_enabled
assert not effects.timer.isActive() and effects.overlay.progress is None
assert effects.overlay.isVisible()
assert changes[-1] == ("protoss", False)
win._set_window_size("Detailed")
assert not effects.timer.isActive()
page.appearance_animations.setChecked(True)
assert not effects.timer.isActive()
page.appearance_skin.setCurrentIndex(page.appearance_skin.findData("default"))
assert ui._window_skin == effects.skin == "default"
assert not effects.overlay.isVisible()
assert app.styleSheet() == theme.STYLE
win._set_window_size("Compact")
page.compact_card.enlarge_button.click()
assert not effects.timer.isActive()
win._companion_window_controls.maximize_button.click()
app.processEvents()
assert win.isMaximized() and not effects.timer.isActive()
assert not effects.overlay.isVisible()
finish(win, page, effects)
''')


def test_failed_appearance_persistence_preserves_skin_motion_controls_and_active_effect(tmp_path):
    run_gui_check(tmp_path, _SETUP + '''
attempts = []
def fail(skin, animations):
    attempts.append((skin, animations))
    raise OSError("Read-only settings file")
ui, win, page, effects = ready_window(window_skin="zerg", on_window_appearance=fail)
win._set_window_size("Compact")
page.compact_card.enlarge_button.click()
assert effects.timer.isActive()
original_style = app.styleSheet()
original_geometry = win.geometry()
original_context = page.console.context()
page.appearance_animations.setChecked(False)
assert attempts[-1] == ("zerg", False)
assert page.appearance_animations.isChecked()
assert ui._window_animations and effects.motion_enabled
assert effects.timer.isActive()
page.appearance_skin.setCurrentIndex(page.appearance_skin.findData("protoss"))
assert attempts[-1] == ("protoss", True)
assert page.current_appearance() == {"skin": "zerg", "animations": True}
assert ui._window_skin == effects.skin == effects.overlay.skin == "zerg"
assert effects.timer.isActive()
assert win.geometry() == original_geometry
assert page.console.context() == original_context
assert app.styleSheet() == original_style
assert "Couldn't save appearance" in page.appearance_notice.text()
finish(win, page, effects)
''')
