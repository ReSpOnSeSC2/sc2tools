import pytest

from tests._gui_offscreen import run_gui_check
from tests.test_companion_resize_shell import THEMED_SETUP


def test_agent_menu_matches_every_page_and_opens_from_companion(tmp_path):
    run_gui_check(tmp_path, THEMED_SETUP.replace("FONT_SIZE", "10") + '''
ui, win = make_window(window_page="companion", window_animations=False)
win._set_window_size("Standard")
win.show()
app.processEvents()
page = win._companion_page
expected = ["Companion", "Dashboard", "Recent games", "Streams", "Activity log", "Settings",
            "Border & animations…", "Help & support", "Check for updates", "Quit SC2 Tools"]
for route in ("companion", "dashboard", "recent", "streams", "log", "settings", "companion"):
    win._go_to_page(route)
    app.processEvents()
    button = page.agent_menu_button if route == "companion" else win._agent_menu_button
    assert button.isVisible()
    assert [action.text() for action in button.menu().actions() if not action.isSeparator()] == expected
assert page.agent_menu_button.menu() is win._agent_menu_button.menu()
opened = []
def close_popup():
    opened.append(page.agent_menu_button.menu().isVisible())
    page.agent_menu_button.menu().close()
QtCore.QTimer.singleShot(30, close_popup)
page.agent_menu_button.showMenu()
assert opened == [True]
assert not win._agent_brandbar.isVisible()
page.shutdown()
win.hide()
''')


@pytest.mark.parametrize("outcome", ["current", "failed"])
def test_shared_agent_update_action_shows_feedback_and_prevents_duplicate_checks(tmp_path, outcome):
    run_gui_check(tmp_path, THEMED_SETUP.replace("FONT_SIZE", "10") + '''
from types import SimpleNamespace
import threading
entered, release = threading.Event(), threading.Event()
calls = []
outcome = OUTCOME
def check_updates():
    calls.append(threading.get_ident())
    entered.set()
    assert release.wait(5)
    if outcome == "failed":
        raise RuntimeError("Synthetic update check failed")
    return SimpleNamespace(update_available=False, current="test", latest="test")
ui, win = make_window(window_page="companion", on_check_updates=check_updates, window_animations=False)
win._set_window_size("Standard")
win.show()
app.processEvents()
page = win._companion_page
action = next(action for action in page.agent_menu_button.menu().actions() if action.text() == "Check for updates")
try:
    action.trigger()
    assert entered.wait(2)
    app.processEvents()
    assert win._PAGE_KEYS[win._stack.currentIndex()] == "dashboard"
    assert win._transient_notice.isVisible() and win._transient_notice.text() == "Checking for updates…"
    assert not action.isEnabled() and not win._updates_btn.isEnabled()
    win._go_to_page("companion")
    app.processEvents()
    assert not next(entry for entry in page.agent_menu_button.menu().actions() if entry.text() == "Check for updates").isEnabled()
    win._click_check_updates()
    assert len(calls) == 1
    win._go_to_page("dashboard")
    release.set()
    deadline = QtCore.QDeadlineTimer(3000)
    while not action.isEnabled() and not deadline.hasExpired():
        QtTest.QTest.qWait(10)
    assert action.isEnabled() and win._updates_btn.isEnabled()
    assert ("up to date" if outcome == "current" else "Update check failed") in win._transient_notice.text()
    assert win._transient_notice.isVisible()
    assert calls[0] != threading.get_ident()
    action.trigger()
    deadline = QtCore.QDeadlineTimer(3000)
    while (len(calls) < 2 or not action.isEnabled()) and not deadline.hasExpired():
        QtTest.QTest.qWait(10)
    assert len(calls) == 2 and action.isEnabled()
finally:
    release.set()
    page.shutdown()
    win.hide()
'''.replace("OUTCOME", repr(outcome)))


def test_shared_agent_menu_keeps_appearance_help_and_quit_available(tmp_path):
    run_gui_check(tmp_path, THEMED_SETUP.replace("FONT_SIZE", "10") + '''
opened, quit_requests = [], []
gui.webbrowser.open = lambda url, **kwargs: opened.append(url)
ui, win = make_window(window_page="settings", on_quit=lambda: quit_requests.append(True), window_animations=False)
win._set_window_size("Standard")
win.show()
app.processEvents()
page = win._companion_page
win._handle_input.setText("Unsaved player")
for route in ("settings", "companion"):
    win._go_to_page(route)
    app.processEvents()
    button = page.agent_menu_button if route == "companion" else win._agent_menu_button
    actions = {action.text(): action for action in button.menu().actions() if not action.isSeparator()}
    actions["Border & animations…"].trigger()
    app.processEvents()
    assert win._stack.currentWidget() is page
    assert page.console.current_route() == "settings"
    assert page.appearance_controls.isVisible()
    assert win._handle_input.text() == "Unsaved player"
    actions["Help & support"].trigger()
assert len(opened) == 2 and all("desktop-app-overview" in url for url in opened)
actions["Quit SC2 Tools"].trigger()
assert quit_requests == [True]
assert saved == []
page.shutdown()
win.hide()
''')
