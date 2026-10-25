"""Private frozen-GUI check used by packaging, never by normal agent startup."""
from __future__ import annotations

import json
import os
from pathlib import Path
from time import time

from . import __version__

SMOKE_REPORT_ENV = "SC2TOOLS_GUI_SMOKE_REPORT"


def _request_gui_quit(ui, app):
    if ui._window is not None:
        ui._window._on_quit_requested()
    else:
        app.quit()


def _exercise_gui(report):
    # Import Qt directly. can_use_gui() deliberately permits headless fallback
    # for source installs, which must not turn a broken release into a pass.
    report["stage"] = "qt_import"
    from PySide6 import QtCore, QtGui, QtWidgets
    from .ui.gui import GuiUI, SettingsPayload

    report["stage"] = "qt_application"
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    if app.platformName() != "offscreen":
        raise RuntimeError("The packaging smoke check requires offscreen Qt.")
    directory = Path(report["report_path"]).parent
    snapshot = {
        "account_mode": "sc2tools", "configured": False,
        "metadata": {"title": "Packaged GUI smoke check", "description": ""},
        "youtube": {"connected": False}, "platforms": {}, "catalog": {},
        "message": "Offline packaging check",
        "title_automation": {"enabled": False, "template": "SC2 | {mmr}",
            "platforms": {"twitch": True, "kick": True, "youtube": False}, "values": {"mmr": "5000"},
            "message": "Offline packaging fixture; no account requests."},
    }

    def inert(*_args):
        return None

    # This is only the presentation object. There is no StreamService, runner
    # worker, tray, watcher, token, settings loader, OBS client or API client.
    ui = GuiUI(
        version=__version__, dashboard_url="", pairing_url="", api_base="",
        log_dir=directory, log_file=directory / "absent-smoke-log.txt",
        replay_folders=[], initial_paused=True, initial_paired=True,
        initial_user_id="packaging-fixture", initial_settings=SettingsPayload(),
        recent_games_enabled=True,
        on_pause=inert, on_resync=inert, on_choose_folder=inert,
        on_check_updates=inert, on_save_settings=inert, on_quit=app.quit,
        stream_status_provider=lambda: snapshot, on_stream_action=None,
    )
    callback = {"reached": False, "error": None}

    def verify_and_quit():
        callback["reached"] = True
        try:
            report["stage"] = "window_paint"
            window = ui._window
            if window is None or not ui._started_event.is_set():
                raise RuntimeError("The production GUI did not construct its window.")
            stack = window._stack
            streams_index = next(
                (index for index in range(stack.count())
                 if stack.widget(index).objectName() == "streamStudio"), None,
            )
            if streams_index is None:
                raise RuntimeError("The bundled Streams page did not construct.")
            titles = stack.widget(streams_index).title_controls
            if titles.preview.text() != "Preview: SC2 | 5000" or titles.enabled.isChecked() or titles.platforms["youtube"].isChecked():
                raise RuntimeError("The bundled stream-title preview or default-off controls are incorrect.")
            report["stream_title_preview_painted"] = True
            window.resize(1120, 850)
            report["stage"] = "dashboard_recent_paint"
            from datetime import datetime, timezone
            at = datetime.now(timezone.utc).isoformat()
            ui.on_recent_snapshot({"owner": "packaging-fixture", "rows": [{"path": "fixture.SC2Replay",
                "gameId": "offline-fixture", "dateIso": at, "status": "uploaded", "result": "Victory",
                "races": {"own": "Protoss", "opponent": "Zerg"}, "oppName": "Sample opponent", "map": "Sample map"}],
                "facts": {"synced": 1, "syncedToday": 1}, "today": {"wins": 1, "losses": 0, "games": 1}})
            ui.on_import_progress({"phase": "importing", "total": 12, "completed": 4, "remaining": 8})
            app.processEvents(QtCore.QEventLoop.ExcludeUserInputEvents)
            window._refresh_stats()
            if window._game_dashboard.last_id != "offline-fixture" or window._game_dashboard.bar.maximum() != 12:
                raise RuntimeError("The bundled game summary or import card did not render.")
            for page in ("dashboard", "recent"):
                window._go_to_page(page)
                app.processEvents(QtCore.QEventLoop.ExcludeUserInputEvents)
                if window.grab().isNull():
                    raise RuntimeError("The bundled game dashboard did not paint.")
            if not isinstance(window._recent_table.model(), QtCore.QAbstractTableModel) or window._recent_table.model().rowCount() != 1:
                raise RuntimeError("The bundled recent-game model did not load.")
            if window._recent_table.horizontalHeader().sectionResizeMode(3) != QtWidgets.QHeaderView.Interactive:
                raise RuntimeError("The bundled opponent column could not be resized.")
            window._nav_group.button(streams_index).setChecked(True)
            stack.setCurrentIndex(streams_index)
            app.processEvents(QtCore.QEventLoop.ExcludeUserInputEvents)
            painted = window.grab()
            if not isinstance(painted, QtGui.QPixmap) or painted.isNull():
                raise RuntimeError("The bundled window did not paint.")
            report["stage"] = "checkin_preview_paint"
            settings = window._checkin_settings
            for kind, control in (("loading", settings.preview_loading), ("postgame", settings.preview_postgame)):
                control.click()
                card = window._checkin_host.window(kind)
                app.processEvents(QtCore.QEventLoop.ExcludeUserInputEvents)
                if not card.is_preview or not card.isVisible() or card.grab().isNull():
                    raise RuntimeError("The bundled check-in preview did not paint.")
                card._dismiss_preview()
            companion_index = next(
                (index for index in range(stack.count())
                 if stack.widget(index).objectName() == "companionDesk"), None,
            )
            if companion_index is None:
                raise RuntimeError("The bundled Companion page did not construct.")
            window._nav_group.button(companion_index).setChecked(True)
            stack.setCurrentIndex(companion_index)
            app.processEvents(QtCore.QEventLoop.ExcludeUserInputEvents)
            if window.grab().isNull():
                raise RuntimeError("The bundled Companion page did not paint.")
            companion = window._companion_page
            companion.set_density("full")
            for index in range(companion.workspace_tabs.count()):
                companion.workspace_tabs.setCurrentIndex(index)
                app.processEvents(QtCore.QEventLoop.ExcludeUserInputEvents)
                if not companion.workspace_tabs.currentWidget().isVisible() or window.grab().isNull():
                    raise RuntimeError("A bundled Companion tool did not paint.")
            report["stage"] = "window_layouts_and_race_skins"
            if not window.windowFlags() & QtCore.Qt.FramelessWindowHint:
                raise RuntimeError("The bundled agent still uses native window chrome.")
            for title in ("Compact", "Standard", "Detailed", "Full workspace"):
                if not window._set_window_size(title):
                    raise RuntimeError("A bundled Companion layout could not open.")
                app.processEvents(QtCore.QEventLoop.ExcludeUserInputEvents)
                if window.grab().isNull():
                    raise RuntimeError("A bundled Companion layout did not paint.")
            from .ui.race_artwork import create_race_artwork
            artwork = create_race_artwork(QtCore=QtCore, QtGui=QtGui)
            for skin in ("protoss", "terran", "zerg"):
                if artwork.image_for_skin(skin) is None:
                    raise RuntimeError("Bundled race frame artwork is missing or invalid.")
            for skin in ("default", "protoss", "terran", "zerg"):
                window._set_window_size("Compact")
                companion.appearance_skin.setCurrentIndex(companion.appearance_skin.findData(skin))
                window._set_window_size("Standard")
                app.processEvents(QtCore.QEventLoop.ExcludeUserInputEvents)
                if companion.compact_card.property("raceSkin") != skin or window.grab().isNull():
                    raise RuntimeError("A bundled race skin did not paint.")
                effects = window._race_effects
                effects.set_motion_enabled(False)
                if effects.timer.isActive():
                    raise RuntimeError("Disabling animation did not stop its timer.")
                effects.set_motion_enabled(True)
            companion.appearance_skin.setCurrentIndex(companion.appearance_skin.findData("default"))
            report["stage"] = "pinned_panels_and_team_roster"
            companion.session_panel.update_session({"paired": True, "accountKey": "packaging-fixture",
                "source": "overlay-session", "receivedAt": time(),
                "session": {"wins": 2, "losses": 1, "games": 3, "region": "EU", "sessionStartedAt": at},
                "ownRating": {"mmr": 5157, "source": "overlay-session", "status": "latest-known"}})
            companion.session_panel.set_enabled(True)
            app.processEvents(QtCore.QEventLoop.ExcludeUserInputEvents)
            if companion.session_panel.wins_label.text() != "2W" or companion.session_panel._presentation["mmr"] != 5157:
                raise RuntimeError("The bundled Session record or own rating did not paint.")
            panels = [*companion.overlays.values(), companion.ghost_page.panel, companion.session_panel]
            for panel in panels:
                if not panel.windowFlags() & QtCore.Qt.FramelessWindowHint or panel.grab().isNull():
                    raise RuntimeError("A bundled pinned panel did not paint with themed chrome.")
                if any(panel.findChild(QtWidgets.QToolButton, name) is None
                       for name in ("windowMinimize", "windowClose")):
                    raise RuntimeError("A bundled pinned panel is missing its window controls.")
            from .team_roster import TeamRoster
            roster = TeamRoster()
            roster.update({"paired": True, "accountKey": "packaging-fixture", "liveGame": {
                "phase": "match_in_progress", "gameKey": "offline-team-fixture", "isReplay": False,
                "capturedAt": time(), "displayTime": 60, "user": {"name": "Sample player"},
                "players": [{"id": index + 1, "name": name, "race": race, "type": "user"}
                            for index, (name, race) in enumerate((("Sample player", "Protoss"),
                                ("Sample teammate", "Terran"), ("Sample enemy one", "Zerg"),
                                ("Sample enemy two", "Terran")))]}})
            keys = {row["name"]: row["key"] for row in roster.players}
            roster.confirm(keys["Sample player"], [keys["Sample enemy one"], keys["Sample enemy two"]])
            window._set_window_size("Detailed")
            app.processEvents(QtCore.QEventLoop.ExcludeUserInputEvents)
            companion.team_roster_widget.render(roster, [], {})
            companion.team_roster_widget.show()
            app.processEvents(QtCore.QEventLoop.ExcludeUserInputEvents)
            if (not roster.ready or len(companion.team_roster_widget._buttons) != 2
                    or companion.team_roster_widget.grab().isNull() or window.grab().isNull()):
                raise RuntimeError("The bundled confirmed team roster did not paint.")
            report.update(qt_version=QtCore.qVersion(), qt_platform=app.platformName(),
                          page_count=stack.count(), streams_painted=True, companion_painted=True,
                          checkin_previews_painted=True, dashboard_recent_painted=True,
                          window_chrome_painted=True, companion_layouts_painted=4, race_skins_painted=4,
                          race_artwork_loaded=3, pinned_panels_painted=4, session_panel_painted=True, team_roster_painted=True)
        except Exception as error:
            callback["error"] = error
        finally:
            _request_gui_quit(ui, app)

    report["stage"] = "window_startup"
    timer = QtCore.QTimer()
    timer.setSingleShot(True)
    timer.timeout.connect(verify_and_quit)
    timer.start(0)
    try:
        code = ui.run()
        if callback["error"] is not None:
            raise callback["error"]
        if code != 0 or not callback["reached"]:
            raise RuntimeError("The Qt event loop did not complete its smoke check.")
    finally:
        timer.stop()
        if ui._window is not None:
            ui._window._checkin_host.close()
            ui._window._companion_page.session_panel.shutdown()
            for child_timer in ui._window.findChildren(QtCore.QTimer):
                child_timer.stop()
            ui._window.hide()
            ui._window.deleteLater()
            app.sendPostedEvents(None, QtCore.QEvent.DeferredDelete)


def run_gui_smoke(report_path):
    """Return nonzero on an import/plugin/window failure, with a safe JSON report."""
    destination = Path(report_path)
    if not destination.is_absolute():
        return 1
    report = {"schema": 1, "ok": False, "agent_version": __version__,
              "stage": "starting", "report_path": str(destination)}
    previous_platform = os.environ.get("QT_QPA_PLATFORM")
    os.environ["QT_QPA_PLATFORM"] = "offscreen"
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        # A native Qt plugin abort can bypass Python exception handling. Leave
        # a failure report first; the packaging launcher also bounds process time.
        destination.write_text(json.dumps(report), encoding="utf-8")
        _exercise_gui(report)
        report.update(ok=True, stage="complete")
        return_code = 0
    except Exception as error:
        report["error_type"] = type(error).__name__
        return_code = 1
    finally:
        if previous_platform is None:
            os.environ.pop("QT_QPA_PLATFORM", None)
        else:
            os.environ["QT_QPA_PLATFORM"] = previous_platform
    try:
        # Neither environment values nor raw error messages are diagnostic data.
        report.pop("report_path", None)
        destination.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    except OSError:
        return 1
    return return_code
