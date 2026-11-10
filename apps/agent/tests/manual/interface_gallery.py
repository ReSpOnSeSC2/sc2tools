"""Render every main desktop surface in all four skins at two sizes.

Run from any directory with the desktop development Python:

    python apps/agent/tests/manual/interface_gallery.py <output folder> [--scale 1.5]

It saves ``<surface>-<skin>-<size>.png`` for the main window's seven pages,
the loading-screen and post-game check-in cards and the floating scouting
report, in the Default, Protoss, Terran and Zerg skins. Everything is sample
data: no paired account, service, runner, OBS connection, network request or
user setting is loaded. ``--scale`` renders as Windows does at that display
scaling (1.25 or 1.5), to find text that clips.
"""
from __future__ import annotations

import argparse
import os
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

AGENT = Path(__file__).resolve().parents[2]
PAGES = ("dashboard", "recent", "log", "settings", "streams", "companion", "help")
WINDOW_SIZES = (("large", (1100, 760)), ("minimum", (480, 360)))
REPORT_SIZES = (("large", (650, 450)), ("minimum", (420, 300)))
CHECKIN_CARDS = ("loading", "postgame")
FONT_FILES = ("SegUIVar.ttf", "segoeui.ttf", "segoeuib.ttf", "seguisb.ttf", "seguisym.ttf")
REPLAY_FOLDER = "C:/Users/Player/Documents/StarCraft II/Accounts/1/1-S2-1-1/Replays/Multiplayer"
RECENT_GAMES = (
    ("Victory", "NorthStar", "Zerg", "Alcyone LE", 0.4),
    ("Defeat", "Kestrel", "Terran", "Tourmaline LE", 1.2),
    ("Victory", "Aurelia", "Protoss", "Ghost River LE", 2.5),
    ("Victory", "Morrow", "Zerg", "Equilibrium LE", 5.0),
    ("Defeat", "Vexa", "Terran", "Lightshade LE", 26.0),
)
LOG_LINES = (
    ("INFO", "runner", "agent_started"),
    ("INFO", "watcher", "watching_folder path=Multiplayer"),
    ("INFO", "uploader", "upload_ok file=Alcyone LE (2).SC2Replay"),
    ("WARNING", "heartbeat", "heartbeat_slow seconds=4.2"),
    ("INFO", "uploader", "upload_ok file=Tourmaline LE.SC2Replay"),
    ("ERROR", "uploader", "upload_failed file=Lightshade LE.SC2Replay reason=timeout"),
)


def sample_log(folder):
    """An Activity log in the agent's own line format."""
    stamp = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    path = folder / "agent.log"
    path.write_text("".join(f"{stamp} {level} sc2tools_agent.{name} | {message}\n"
                            for level, name, message in LOG_LINES), encoding="utf-8")
    return path


def sample_snapshot():
    """Recent games and today's facts as the library sends them."""
    now = datetime.now(timezone.utc)
    rows = [{"path": f"sample-{index}", "gameId": f"sample-{index}", "result": result,
             "dateIso": (now - timedelta(hours=hours)).isoformat(), "oppName": opponent, "map": map_name,
             "status": "uploaded", "races": {"own": "Protoss", "opponent": race}}
            for index, (result, opponent, race, map_name, hours) in enumerate(RECENT_GAMES)]
    return {"owner": "sample-user", "rows": rows, "skipped": [],
            "facts": {"synced": 1284, "syncedToday": 4, "lastUploadAt": rows[0]["dateIso"], "failed24h": 0},
            "today": {"wins": 3, "losses": 1, "games": 4, "netMmr": 38}}


def sample_health():
    from sc2tools_agent.health import HealthFacts, evaluate

    now = time.time()
    return evaluate(HealthFacts(phase="watching", paired=True, heartbeat_ok_at=now, socket_connected=True,
                                folders=(REPLAY_FOLDER,), analyzer_ok=True, last_upload_at=now - 240,
                                live_enabled=True, live_contact_at=now, auto_update=True), now)


def build_window(folder, *, QtCore, QtGui, QtWidgets):
    """The real main window, paired to a sample account with no services."""
    from sc2tools_agent import __version__
    from sc2tools_agent.ui.gui import GuiUI, SettingsPayload, _GuiSignals, _MainWindow

    ui = GuiUI(version=__version__, dashboard_url="https://example.test/app",
               pairing_url="https://example.test/devices", log_dir=folder, log_file=sample_log(folder),
               api_base="https://api.example.test", replay_folders=[Path(REPLAY_FOLDER)],
               initial_paused=False, initial_paired=True, initial_user_id="sample-user",
               initial_settings=SettingsPayload(), on_pause=lambda _value: None, on_resync=lambda: None,
               on_choose_folder=lambda _path: None, on_check_updates=lambda: None,
               on_save_settings=lambda _payload: None, on_quit=lambda: None,
               recent_games_enabled=True, window_page="dashboard", window_animations=False)
    ui._signals = _GuiSignals()
    window = _MainWindow(ui=ui, signals=ui._signals, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
    window._log_timer.stop()
    ui.on_recent_snapshot(sample_snapshot())
    ui.on_health(sample_health())
    window.show()
    settle(QtCore=QtCore, QtWidgets=QtWidgets)
    return window


def settle(*, QtCore, QtWidgets, milliseconds=400):
    """Let the window's coalescing timers fire, as they do on screen."""
    deadline = QtCore.QDeadlineTimer(milliseconds)
    while not deadline.hasExpired():
        QtWidgets.QApplication.processEvents(QtCore.QEventLoop.AllEvents, 20)


def scroll_to_top(page, *, QtWidgets):
    for area in (page, *page.findChildren(QtWidgets.QScrollArea)):
        if isinstance(area, QtWidgets.QScrollArea):
            area.verticalScrollBar().setValue(0)


def choose_skin(window, skin, *, QtWidgets):
    """Pick the skin the way a player does, in Companion's appearance settings."""
    control = window._companion_page.appearance_skin
    control.setCurrentIndex(control.findData(skin))
    QtWidgets.QApplication.processEvents()


def save(widget, folder, name, *, QtWidgets):
    QtWidgets.QApplication.processEvents()
    target = folder / (name + ".png")
    if not widget.grab().save(str(target)):
        raise RuntimeError(f"Could not save {target}")
    print(target)


def render_pages(window, folder, skin, *, QtWidgets):
    for size_name, size in WINDOW_SIZES:
        window.resize(*size)
        for page in PAGES:
            window._go_to_page(page)
            scroll_to_top(window._stack.currentWidget(), QtWidgets=QtWidgets)
            save(window, folder, f"window-{page}-{skin}-{size_name}", QtWidgets=QtWidgets)
    window._go_to_page("dashboard")


def render_checkin_cards(window, folder, skin, *, QtWidgets):
    host = window._checkin_host
    for kind in CHECKIN_CARDS:
        refusal = host.show_preview(kind)
        if refusal is not None:
            raise RuntimeError(f"The {kind} preview was refused: {refusal}")
        save(host.window(kind), folder, f"checkin-{kind}-{skin}-natural", QtWidgets=QtWidgets)
        host.window(kind).hide()


def render_scouting_report(window, folder, skin, *, QtWidgets):
    import scouting_report_preview as scouting

    page = window._companion_page
    panel = page.overlays["scouting"]
    panel.update_context({})
    panel.update_context(scouting.context(5, 5))
    scouting.load_stored_events(page, panel)
    for size_name, size in REPORT_SIZES:
        panel.resize(*size)
        panel.show()
        QtWidgets.QApplication.processEvents()
        panel.render_build_data()
        save(panel, folder, f"scouting-report-{skin}-{size_name}", QtWidgets=QtWidgets)
    panel.hide()


def capture(folder):
    from PySide6 import QtCore, QtGui, QtWidgets
    from sc2tools_agent.ui import theme
    from sc2tools_agent.ui.race_visuals import RACE_SKINS

    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    for name in FONT_FILES:
        QtGui.QFontDatabase.addApplicationFont("C:/Windows/Fonts/" + name)
    app.setFont(QtGui.QFont("Segoe UI", 9))
    app.setStyleSheet(theme.STYLE)
    folder.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as logs:
        window = build_window(Path(logs), QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
        for _title, skin in RACE_SKINS:
            choose_skin(window, skin, QtWidgets=QtWidgets)
            render_pages(window, folder, skin, QtWidgets=QtWidgets)
            render_checkin_cards(window, folder, skin, QtWidgets=QtWidgets)
            render_scouting_report(window, folder, skin, QtWidgets=QtWidgets)
        window._companion_page.shutdown()
        window.hide()
        app.processEvents()


def arguments(argv):
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("folder", type=Path, help="where the pictures are saved")
    parser.add_argument("--scale", type=float, default=1.0, help="display scaling, such as 1.25 or 1.5")
    return parser.parse_args(argv)


if __name__ == "__main__":
    options = arguments(sys.argv[1:])
    os.environ["QT_QPA_PLATFORM"] = "offscreen"
    os.environ["QT_SCALE_FACTOR"] = str(options.scale)
    sys.path.insert(0, str(AGENT))
    capture(options.folder.resolve())
