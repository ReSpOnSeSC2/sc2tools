"""The dashboard status card paints health snapshots: rows, footer, actions and latest-wins delivery."""
from sc2tools_agent.health import HealthSnapshot
from sc2tools_agent.ui.gui import GuiUI, SettingsPayload
from tests._gui_offscreen import run_gui_check
from tests.test_companion_resize_shell import THEMED_SETUP


def test_before_the_window_exists_only_the_newest_snapshot_is_kept(tmp_path):
    ui = GuiUI(
        version="test", dashboard_url="https://example.test/app", pairing_url="https://example.test/devices",
        log_dir=tmp_path, log_file=tmp_path / "agent.log", api_base="https://api.example.test",
        replay_folders=[], initial_paused=False, initial_paired=True, initial_user_id="u1",
        initial_settings=SettingsPayload(), on_pause=lambda _paused: None, on_resync=lambda: None,
        on_choose_folder=lambda _path: None, on_check_updates=lambda: None,
        on_save_settings=lambda _settings: None, on_quit=lambda: None,
    )
    ui.on_unlinked()
    snapshots = [HealthSnapshot(f"Snapshot {index}", 0, "ok", "green") for index in range(300)]
    for snapshot in snapshots:
        ui.on_health(snapshot)
    # A burst larger than the 256-event backlog never pushes the pairing event out.
    assert list(ui._ui_events) == [("unlinked", ())]
    assert ui._take_health() is snapshots[-1]


def test_card_paints_the_newest_snapshot_with_rows_and_a_grey_footer(tmp_path):
    run_gui_check(tmp_path, r"""
import threading, time
from sc2tools_agent.health import HealthFacts, HealthSnapshot, evaluate
now = time.time()
folder = base / "2-S2-1-42" / "Replays"
quiet = dict(phase="ready", paired=True, folders=(str(folder),), live_enabled=False, auto_update=False)
calm = evaluate(HealthFacts(**quiet, heartbeat_ok_at=now, identity_source="cloud", analyzer_ok=True), now)
original = GuiUI.__init__
def construct(self, *args, **kwargs):
    original(self, *args, **kwargs)
    self.show_pairing_code("123456")
    for index in range(300):
        self.on_health(HealthSnapshot(f"Old {index}", 0, "ok", None))
    self.on_health(calm)
GuiUI.__init__ = construct
ui, win = make_window(replay_folders=[folder])
GuiUI.__init__ = original
win.show(); app.processEvents()
view = win._health_view
assert win._pairing_code_label.text() == "123456"  # the queued event survived the burst
assert view.headline.text() == "Everything's working"
assert [line.row.id for line in view.lines] == ["pairing", "cloud", "folders", "identity", "analyzer", "uploads"]
assert [line.sentence.text() for line in view.lines][2:3] == ["Watching 1 replay folder (EU)."]
assert view.lines[2].sentence.toolTip() == str(folder)
assert [line.row.id for line in view.lines if line.help_button] == ["identity", "uploads"]
assert all(line.action_button is None for line in view.lines)
assert view.footer.text() == "Live game features are off. Automatic updates are off."
assert view.footer.isVisible() and view.footer.objectName() == "dim"
assert not win._status_copy.isVisible() and win._sidebar_status.toolTip() == "● Everything's working"

kept = {line.row.id: line for line in view.lines}
applied = []
paint = view.apply
view.apply = lambda snapshot: (applied.append(snapshot), paint(snapshot))
offline = [evaluate(HealthFacts(**quiet, connection="offline", pending=count), now) for count in (1, 2, 312)]
worker = threading.Thread(target=lambda: [ui.on_health(item) for item in offline])
worker.start(); worker.join()
app.processEvents()
assert applied == [offline[-1]]  # three pushes from another thread, one paint of the newest
assert view.headline.text() == "1 thing needs attention"
cloud = view.lines[0]
assert (cloud.row.id, cloud.sentence.text()) == ("cloud", "Can't reach sc2tools.com, so 312 replays are waiting.")
assert cloud.action_button.text() == "Retry now" and cloud.help_button is not None
# Every row keeps its line while its id stays; the cloud line moved up and repainted in place.
assert all(line is kept[line.row.id] for line in view.lines)
# The sidebar mirrors the headline; its hover lists what needs attention.
assert win._sidebar_status.toolTip() == "● 1 thing needs attention\n" + cloud.sentence.text()
win.hide()
""")


def test_a_live_count_keeps_the_rows_button_and_its_focus(tmp_path):
    run_gui_check(tmp_path, r"""
import time
from sc2tools_agent.health import HealthFacts, evaluate
from sc2tools_agent.ui import palette
now = time.time()
retries = []
ui, win = make_window(on_sync_retry=lambda: retries.append(True))
win.show(); app.processEvents()
held = dict(phase="ready", paired=True, connection="offline")
ui.on_health(evaluate(HealthFacts(**held, pending=311), now)); app.processEvents()
view = win._health_view
cloud = view.lines[0]
button, row_help = cloud.action_button, cloud.help_button
button.setFocus()
ui.on_health(evaluate(HealthFacts(**held, pending=312), now)); app.processEvents()
assert view.lines[0] is cloud and cloud.sentence.text() == "Can't reach sc2tools.com, so 312 replays are waiting."
assert (cloud.action_button, cloud.help_button) == (button, row_help) and win.focusWidget() is button
button.click()
assert retries == [True]  # the same button still runs the row's action
assert (cloud.dot.accessibleName(), cloud.dot.styleSheet()) == ("Needs attention", "color: " + palette.AMBER)
# A new level repaints the dot in place; a new action rebuilds only the buttons.
ui.on_health(evaluate(HealthFacts(**dict(held, connection="online"), socket_connected=False), now))
app.processEvents()
assert view.lines[0] is cloud and cloud.sentence.text() == "Actions from the website can't reach this PC right now."
assert (cloud.dot.accessibleName(), cloud.dot.styleSheet()) == ("Info", "color: " + palette.CYAN)
assert cloud.action_button is None and cloud.help_button is None
win.hide()
""")


def test_a_settings_folder_change_reaches_the_folders_row(tmp_path):
    run_gui_check(tmp_path, r"""
import logging
from types import SimpleNamespace
from unittest.mock import Mock
from sc2tools_agent import runner
from sc2tools_agent.config import AgentConfig
from sc2tools_agent.health import HealthMonitor
from sc2tools_agent.state import AgentState
eu, na = base / "2-S2-1-1" / "Replays", base / "1-S2-1-2" / "Replays"
for folder in (eu, na):
    folder.mkdir(parents=True)
ui, win = make_window(replay_folders=[eu])
win.show(); app.processEvents()
# The runner's wiring: Settings saves reach the window and the health card through the multiplexer.
cell = SimpleNamespace(upload=None, watcher=None, tray=None, gui=ui)
cell.ui = runner._Multiplexer(Mock(), None, ui, health=HealthMonitor(schedule=lambda delay, callback: callback()))
cfg = AgentConfig(api_base="https://api.example.test", state_dir=base / "state", replay_folder=eu,
                  poll_interval_sec=10, parse_concurrency=1)

def folders():
    app.processEvents()
    return next(line for line in win._health_view.lines if line.row.id == "folders").sentence

assert folders().text() == "Watching 1 replay folder (EU)."
runner._handle_save_settings(cfg, AgentState(), SettingsPayload(replay_folders=[eu, na]), cell,
                             logging.getLogger("test"))
assert folders().text() == "Watching 2 replay folders (EU, NA)."
assert folders().toolTip() == f"{eu}\n{na}"
win.hide()
""")


def test_rows_with_buttons_fit_the_minimum_window_width(tmp_path):
    run_gui_check(tmp_path, THEMED_SETUP.replace("FONT_SIZE", "10") + r"""
from sc2tools_agent.health import ACTIONS, GAMES_HELP, HealthRow, HealthSnapshot
sentence = "12 games from the last week were skipped because SC2 Tools couldn't tell which player was you."
rows = tuple(HealthRow(action, "warn", sentence, action, GAMES_HELP) for action in sorted(ACTIONS))
ui, win = make_window(window_animations=False)
win._set_window_size("Standard")
ui.on_health(HealthSnapshot("10 things need attention", 10, "warn", "amber", rows))
win._go_to_page("dashboard"); win.show()
scroll = win._stack.currentWidget()
for width in (480, 1300, 480):
    win.resize(width, 600)
    deadline = QtCore.QDeadlineTimer(1000)  # theme changes can queue another layout pass
    while not deadline.hasExpired() and not (win.width() == width and scroll.horizontalScrollBar().maximum() == 0):
        QtTest.QTest.qWait(10)
    assert win.width() == width and scroll.horizontalScrollBar().maximum() == 0, (width, scroll.widget().width())
    for line in win._health_view.lines:
        assert line.action_button.width() >= line.action_button.sizeHint().width()
        for button in (line.action_button, line.help_button):
            assert win._health_view.rect().contains(button.mapTo(win._health_view, button.rect().bottomRight()))
win._companion_page.shutdown()
win._race_effects.shutdown()
win._really_quit = True
win.close()
""", timeout=60)


def test_each_row_action_runs_its_handler(tmp_path):
    run_gui_check(tmp_path, r"""
import threading
from sc2tools_agent.health import ACTIONS, HealthRow, HealthSnapshot
from sc2tools_agent.ui.health_card import ACTION_LABELS
calls = []
installed = threading.Event()
QtWidgets.QFileDialog.getExistingDirectory = lambda *args, **kwargs: calls.append("add_folder") or ""
QtWidgets.QMessageBox.question = lambda *args, **kwargs: QtWidgets.QMessageBox.Yes
ui, win = make_window(on_link_again=lambda: calls.append("link_pc"), on_sync_retry=lambda: calls.append("retry_now"),
                      on_pause=lambda paused: calls.append(("pause", paused)), on_install_update=installed.set,
                      on_restart_agent=lambda: calls.append("restart_agent"))
win.show(); app.processEvents()
assert set(ACTION_LABELS) == ACTIONS == set(win._health_actions())
actions = sorted(ACTIONS)
rows = tuple(HealthRow(action, "warn", f"Needs {action}.", action) for action in actions)
ui.on_health(HealthSnapshot(f"{len(rows)} things need attention", len(rows), "warn", "amber", rows))
app.processEvents()
assert [line.action_button.text() for line in win._health_view.lines] == [ACTION_LABELS[name] for name in actions]

def click(action):
    win._go_to_page("dashboard")
    next(line for line in win._health_view.lines if line.row.action == action).action_button.click()
    QtTest.QTest.qWait(30)

for action in ("link_pc", "retry_now", "add_folder", "restart_agent", "resume"):
    click(action)
assert calls == ["link_pc", "retry_now", "add_folder", "restart_agent", ("pause", False)]
click("install_update"); assert installed.wait(1)
click("open_log"); assert win._stack.currentIndex() == 2
click("open_obs_settings")  # the first visit to Settings, so its layout is fresh
scroll = win._settings_scroll
card_top = win._obs_card.mapTo(scroll.viewport(), QtCore.QPoint(0, 0)).y()
assert win._stack.currentIndex() == 3 and scroll.verticalScrollBar().value() > 0
assert 0 <= card_top < scroll.viewport().height()
click("set_player_name")
assert win._stack.currentIndex() == 3 and win.focusWidget() is win._handle_input
(base / "agent.log").write_text("2026-11-01T12:00:00 ERROR upload broke\n", encoding="utf-8")
click("copy_details")
details = app.clipboard().text()
assert details.startswith("SC2 Tools test\nStatus: 10 things need attention\nwarn: Needs add_folder.\n")
assert "upload broke" in details
win.hide()
""")


def test_link_pc_takes_the_pairing_cards_next_step(tmp_path):
    run_gui_check(tmp_path, r"""
from datetime import datetime, timedelta, timezone
from sc2tools_agent.health import HealthRow, HealthSnapshot
from sc2tools_agent.pairing.flow import PairingUiState
opened = []; links = []
gui.webbrowser.open = lambda url, **kwargs: opened.append(url)
ui, win = make_window(initial_paired=False, on_link_again=lambda: links.append(True))
win.show(); app.processEvents()
ui.on_pairing_state(PairingUiState("showing", "123456", datetime.now(timezone.utc) + timedelta(minutes=5)))
row = HealthRow("pairing", "warn", "Link this PC to your account to start syncing.", "link_pc")
ui.on_health(HealthSnapshot("1 thing needs attention", 1, "warn", "amber", (row,)))
app.processEvents()
win._health_view.lines[0].action_button.click()
assert opened == ["https://example.test/devices?code=123456&src=agent"] and links == []
win.hide()
""")


def test_boot_failure_offers_restart_and_copy_details(tmp_path):
    run_gui_check(tmp_path, r"""
from sc2tools_agent.health import BOOT_HEADLINES, HealthMonitor, classify_boot_error
restarts = []
ui, win = make_window(on_restart_agent=lambda: restarts.append(True))
win.show(); app.processEvents()
monitor = HealthMonitor(schedule=lambda delay, callback: callback())
monitor.subscribe(ui.on_health)
error = PermissionError(13, "Permission denied", str(base / "agent.json"))
monitor.set_boot_error(classify_boot_error(error, state_dir=base))
monitor.set_phase("boot_error")
ui.on_phase("boot_error", str(error)); app.processEvents()
view = win._health_view
assert view.headline.text() == BOOT_HEADLINES["state_dir"]
line, = view.lines
assert line.sentence.text() == "Windows blocked a file or folder SC2 Tools needs (Permission denied)."
assert line.action_button.text() == "Restart agent" and line.help_button is None
assert win._status_copy.isVisible() and not view.footer.isVisible()
answers, defaults = [QtWidgets.QMessageBox.No, QtWidgets.QMessageBox.Yes], []
QtWidgets.QMessageBox.question = lambda *args, **kwargs: defaults.append(args[-1]) or answers.pop(0)
line.action_button.click(); assert restarts == []
line.action_button.click(); assert restarts == [True]
assert defaults == [QtWidgets.QMessageBox.No] * 2  # Enter never restarts by accident
win._status_copy.click()
details = app.clipboard().text()
assert details.startswith(f"SC2 Tools test\nStatus: {BOOT_HEADLINES['state_dir']}\nerror: Windows blocked a file")
assert "agent.json" in details  # the raw error stays in Copy details for a support report
win.hide()
""")
