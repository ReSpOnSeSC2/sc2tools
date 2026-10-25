import pytest

from tests._gui_offscreen import run_gui_check


def test_idle_race_button_opens_the_actual_standard_window_and_preserves_pins(tmp_path):
    run_gui_check(tmp_path, '''
layouts = []
ui, window = make_window(window_page="companion", on_window_information_layout=layouts.append)
window.show()
page = window._companion_page
page.timer.stop()
window._set_window_size("Compact")
app.processEvents()
button = page.compact_card.scouting_button
assert button.property("compactAction") == "expand" and button.isEnabled(), (button.property("compactAction"), button.isEnabled())
assert button.accessibleName() == "Expand Companion"
preferences = dict(page._preferences)
pin = page.overlays["opponent"]
pin_size = pin.size()
button.click()
app.processEvents()
assert window.size().toTuple() == (520, 480), window.size().toTuple()
assert window.property("textOverlay") is False
assert page.current_density() == "standard"
assert layouts == ["compact", "standard"]
assert page._preferences == preferences and pin.size() == pin_size
page.shutdown()
window._race_effects.shutdown()
window.hide()
''')


@pytest.mark.parametrize("minimized", [False, True])
def test_normal_launch_opens_saved_compact_as_standard_while_background_launch_stays_hidden(tmp_path, minimized):
    run_gui_check(tmp_path, f'''
ui, previous = make_window(window_page="companion", window_information_layout="compact", start_minimized={minimized!r})
previous._companion_page.shutdown()
previous._race_effects.shutdown()
previous.deleteLater()
observed = []
def inspect_started_window():
    window = ui._window
    observed.append((window._window_information_layout, window.size().toTuple(), window.isVisible()))
    window._on_quit_requested()
QtCore.QTimer.singleShot(100, inspect_started_window)
ui.run()
assert len(observed) == 1
assert observed[0][0] == {"compact" if minimized else "standard"!r}
assert observed[0][2] is {not minimized!r}
if not {minimized!r}:
    assert observed[0][1] == (520, 480), observed
''', timeout=60)
