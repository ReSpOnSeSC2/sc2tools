"""Production main window — PySide6.

The GUI is the primary UX for non-technical users. It opens automatically
on first launch, surfaces the pairing code in a huge readable card, and
exposes Pause / Resync / Choose Folder / Settings without a command
line. The system tray (``ui.tray``) and the console UI (``ui.console``)
remain wired up alongside as additional sinks.

Architectural notes
-------------------

* All public ``on_*`` / ``show_*`` methods on :class:`GuiUI` are
  thread-safe — they emit a Qt signal that is dispatched onto the GUI
  thread by Qt's event loop. Background subsystems (uploader, watcher,
  updater, heartbeat) call these directly without thinking about
  threading.
* The Qt event loop runs on the main thread (a hard Qt requirement).
  The runner pushes the agent boot sequence onto a worker QThread so
  the UI is responsive during pairing, FS scanning, and HTTP retries.
* Imports of ``PySide6`` are guarded so this module can be imported on
  CI / headless boxes without the GUI extras installed — the agent
  degrades to console+tray. ``can_use_gui()`` does the probe.
* Every desktop page and panel shares the Companion console theme.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
import threading
import webbrowser
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Callable, Deque, List, Optional

log = logging.getLogger(__name__)


# Re-export the parse-pool-concurrency ceiling under the legacy
# private name used inside this module. Authoritative definition
# lives in ``config.py`` so the runner and GUI share a single
# ceiling — see the comment block there for why 12.
from .qt_helpers import guard_value_widgets, validate_api_base, probe_api_health
from .help_links import help_url, help_button, site_url
from . import palette
from ..health import GAMES_HELP, SYNC_HELP
from ..config import _DEFAULT_API_BASE
from ..config import PARSE_CONCURRENCY_USEFUL_MAX as _PARSE_CONCURRENCY_USEFUL_MAX  # noqa: E402

# The switcher's default phase → scene map. The settings panel shows it
# whenever the user hasn't picked scenes themselves, so what the form
# displays is what the running switcher will actually do (see
# ``runner._effective_scene_map``) — and a Save round-trips it instead
# of erasing it into six explicit "don't switch" rows. Import is safe
# headless: ``live.obs_scene`` has no Qt dependency.
from ..live.obs_scene import DEFAULT_SCENE_MAP as _OBS_DEFAULT_SCENE_MAP  # noqa: E402


def can_use_gui() -> bool:
    """Whether PySide6 + a usable display are available.

    Returns False when:
      * PySide6 is not installed (source install without GUI extras),
      * the agent is on a headless server with no display server.

    The runner reads this and falls back to console+tray if the GUI
    can't be brought up.
    """
    try:
        import PySide6.QtWidgets  # noqa: F401
    except ImportError:
        return False
    # Headless probes: on Linux we need DISPLAY or WAYLAND_DISPLAY; on
    # Windows / macOS Qt always finds a display, so skip the check.
    if sys.platform.startswith("linux") and not (
        os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")
    ):
        return False
    return True


# ---------------------------------------------------------------------
# Lazy imports — do all PySide6 work inside functions, not at module
# load, so importing this file on a no-GUI install is cheap and safe.
# ---------------------------------------------------------------------


def _qt():
    """Import the PySide6 namespaces lazily and return them."""
    from PySide6 import QtCore, QtGui, QtWidgets

    return QtCore, QtGui, QtWidgets


from . import theme

_BG = theme.BG
_SURFACE = theme.SURFACE
_ELEVATED = theme.ELEVATED
_SUBTLE = theme.SUBTLE
_TEXT = theme.TEXT
_TEXT_MUTED = theme.TEXT_MUTED
_TEXT_DIM = theme.TEXT_DIM
_ACCENT = theme.ACCENT
_ACCENT_HOVER = theme.ACCENT_HOVER
_ACCENT_CYAN = theme.ACCENT_CYAN
_SUCCESS = palette.GREEN
_WARNING = palette.AMBER
_DANGER = palette.RED
_BORDER = theme.BORDER
_BORDER_STRONG = theme.BORDER_STRONG
_STYLE = theme.STYLE


# ---------------------------------------------------------------------
# Settings DTO — what the GUI hands back when the user clicks "Save".
# ---------------------------------------------------------------------


class SettingsPayload:
    """Plain-data settings update from the GUI's Settings tab.

    Kept as a plain class (not a dataclass) so this module imports
    without ``dataclasses`` shenanigans on Python 3.8 / 3.9 stub
    environments. Fields use ``None`` to mean "no change" so the
    runner can update only what the user actually edited.

    ``replay_folders`` carries the full list the Settings tab shows;
    the runner stores it as additions on top of the detected folders.
    ``replay_folders_removed`` names the entries the user removed from
    that list, which the runner keeps unwatched; a detected folder that
    is merely absent (it appeared after the tab was filled) stays
    watched. ``replay_folder`` is the legacy single-path field — still
    accepted on input for back-compat with older callers, but the runner
    reads ``replay_folders`` first and falls back to wrapping the single
    field into a list.
    """

    __slots__ = (
        "background_import_speed", "pause_history_in_game", "pause_on_battery",
        "api_base",
        "log_level",
        "replay_folder",
        "replay_folders",
        "replay_folders_removed",
        "autostart_enabled",
        "start_minimized",
        "notify_every_game",
        "player_handle",
        "parse_concurrency",
        "upload_concurrency",
        "upload_batch_size",
        "sync_filter_preset",
        "sync_filter_since",
        "sync_filter_until",
        "auto_update_enabled",
        "replay_capture_enabled",
        "obs_scene_switch_enabled",
        "obs_host",
        "obs_port",
        "obs_password",
        "obs_scene_map",
        "obs_switch_debounce_sec",
        "obs_switch_on_replays",
        "obs_website_add_enabled",
    )

    def __init__(
        self,
        *,
        background_import_speed: Optional[str] = None,
        pause_history_in_game: Optional[bool] = None,
        pause_on_battery: Optional[bool] = None,
        api_base: Optional[str] = None,
        log_level: Optional[str] = None,
        replay_folder: Optional[Path] = None,
        replay_folders: Optional[List[Path]] = None,
        replay_folders_removed: Optional[List[Path]] = None,
        autostart_enabled: Optional[bool] = None,
        start_minimized: Optional[bool] = None,
        notify_every_game: Optional[bool] = None,
        player_handle: Optional[str] = None,
        parse_concurrency: Optional[int] = None,
        upload_concurrency: Optional[int] = None,
        upload_batch_size: Optional[int] = None,
        sync_filter_preset: Optional[str] = None,
        sync_filter_since: Optional[str] = None,
        sync_filter_until: Optional[str] = None,
        auto_update_enabled: Optional[bool] = None,
        replay_capture_enabled: Optional[bool] = None,
        obs_scene_switch_enabled: Optional[bool] = None,
        obs_host: Optional[str] = None,
        obs_port: Optional[int] = None,
        obs_password: Optional[str] = None,
        obs_scene_map: Optional[dict] = None,
        obs_switch_debounce_sec: Optional[float] = None,
        obs_switch_on_replays: Optional[bool] = None,
        obs_website_add_enabled: Optional[bool] = None,
    ) -> None:
        self.background_import_speed = background_import_speed
        self.pause_history_in_game = pause_history_in_game
        self.pause_on_battery = pause_on_battery
        self.api_base = api_base
        self.log_level = log_level
        self.replay_folder = replay_folder
        # Normalise: if the caller only provided the legacy single-folder
        # field, lift it into the list so the runner has a single
        # authoritative source for "replace".
        if replay_folders is None and replay_folder is not None:
            replay_folders = [replay_folder]
        self.replay_folders = replay_folders
        self.replay_folders_removed = replay_folders_removed
        self.autostart_enabled = autostart_enabled
        self.start_minimized = start_minimized
        self.notify_every_game = notify_every_game
        # Player handle (battleTag without the # discriminator, or any
        # substring that uniquely identifies the user in their own
        # replays). ``None`` means "no change"; an empty string clears
        # the override and falls back to the cloud profile + auto-detect.
        self.player_handle = player_handle
        # How many parse threads the watcher's ThreadPoolExecutor runs.
        # ``None`` means "no change"; the runner's default is 4.
        self.parse_concurrency = parse_concurrency
        # How many parallel HTTP upload workers drain the queue. ``None``
        # means "no change"; the runner's default is 2 (v0.5.8+).
        self.upload_concurrency = upload_concurrency
        # How many games to pack into one ``POST /v1/games`` request.
        # ``None`` means "no change"; the runner's default is 40 (v0.5.8+).
        self.upload_batch_size = upload_batch_size
        # Date-range filter for the watcher. ``None`` means "no change";
        # ``"all"`` (or any unrecognised value) means "no filter". See
        # ``apps/agent/sc2tools_agent/sync_filter.py`` for the preset
        # vocabulary — same ids the website uses on its filter bar.
        self.sync_filter_preset = sync_filter_preset
        self.sync_filter_since = sync_filter_since
        self.sync_filter_until = sync_filter_until
        # Auto-update consent. ``None`` means "no change"; ``True``
        # restores the default install-when-released behaviour and
        # ``False`` turns the updater notify-only (the compatibility
        # floor in ``updater.update_is_mandatory`` still overrides).
        self.auto_update_enabled = auto_update_enabled
        self.replay_capture_enabled = replay_capture_enabled
        # OBS auto scene switching. ``None`` means "no change" for each
        # field, same as everything above. ``obs_password`` uses the
        # empty string to mean "clear it" so a user can remove a saved
        # password without hand-editing agent.json.
        self.obs_scene_switch_enabled = obs_scene_switch_enabled
        self.obs_host = obs_host
        self.obs_port = obs_port
        self.obs_password = obs_password
        # Phase -> scene name. An empty value means "don't switch for
        # this phase"; the full dict replaces whatever was stored.
        self.obs_scene_map = obs_scene_map
        self.obs_switch_debounce_sec = obs_switch_debounce_sec
        self.obs_switch_on_replays = obs_switch_on_replays
        self.obs_website_add_enabled = obs_website_add_enabled


# ---------------------------------------------------------------------
# GuiUI — the interface the runner talks to.
# ---------------------------------------------------------------------


class GuiUI:
    """Headless wrapper around the Qt main window.

    Keep this class pure-Python on the surface. The runner constructs
    one of these, calls ``start()`` (which builds the ``QApplication``
    + window) and then forwards events through the same interface
    the tray and console use.

    Why a wrapper around QMainWindow instead of subclassing it?
    Because the runner imports this module unconditionally — even on
    a no-GUI install — and we don't want a ``class _Window(QMainWindow)``
    declaration to evaluate at import time (it would try to import
    PySide6 and ImportError out before ``can_use_gui()`` ever runs).
    """

    def __init__(
        self,
        *,
        version: str,
        dashboard_url: str,
        pairing_url: str,
        log_dir: Path,
        log_file: Path,
        api_base: str,
        replay_folders: List[Path],
        initial_paused: bool,
        initial_paired: bool,
        initial_user_id: Optional[str],
        initial_settings: SettingsPayload,
        synced_count_provider: Optional[Callable[[], int]] = None,
        on_pause: Callable[[bool], None],
        on_resync: Callable[[], None],
        on_choose_folder: Callable[[Optional[Path]], None],
        on_check_updates: Callable[[], None],
        on_save_settings: Callable[[SettingsPayload], None],
        on_quit: Callable[[], None],
        on_restart_agent: Optional[Callable[[], None]] = None,
        on_obs_probe: Optional[Callable[[str, int, str], dict]] = None,
        on_obs_build: Optional[Callable[[dict], dict]] = None,
        stream_status_provider: Optional[Callable[[], dict]] = None,
        on_stream_action: Optional[Callable[[dict], dict]] = None,
        on_companion_action: Optional[Callable[[dict], dict]] = None,
        start_minimized: bool = False,
        build_checkin_available: bool = False,
        build_checkin_positions: Optional[dict] = None,
        on_build_checkin_moved: Optional[Callable[[str, int, int], None]] = None,
        on_build_checkin_reset: Optional[Callable[[], None]] = None,
        build_checkin_preview_race: Optional[Callable[[], Optional[str]]] = None,
        window_geometry: Optional[str] = None,
        window_page: Optional[str] = None,
        on_window_state: Optional[Callable[[str, str], None]] = None,
        window_information_layout: str = "standard",
        on_window_information_layout: Optional[Callable[[str], None]] = None,
        window_skin: str = "default",
        window_animations: bool = True,
        on_window_appearance: Optional[Callable[[str, bool], None]] = None,
        on_pairing_retry: Optional[Callable[[], None]] = None,
        on_pairing_refresh: Optional[Callable[[], None]] = None,
        on_link_again: Optional[Callable[[], None]] = None,
        on_sync_retry: Optional[Callable[[], None]] = None,
        state_dir: Optional[Path] = None,
        tray_available: bool = True,
        initial_tray_hint_shown: bool = False,
        close_without_tray: Optional[str] = None,
        on_tray_hint: Optional[Callable[[], None]] = None,
        on_close_policy: Optional[Callable[[str], None]] = None,
        on_install_update=None,
        on_update_later=None,
        on_restore_folders=None,
        recent_games_enabled=False,
        on_recent_retry=None,
        on_import_current_season=None,
        companion_panel_positions: Optional[dict] = None,
        on_companion_panel_positions: Optional[Callable[[dict], None]] = None,
    ) -> None:
        self._recent_games_enabled = recent_games_enabled
        self._on_recent_retry = on_recent_retry or (lambda _paths, _reason: None)
        self._on_import_current_season = on_import_current_season or (lambda: None)
        self._on_restore_folders = on_restore_folders
        self._on_install_update = on_install_update or (lambda: None)
        self._on_update_later = on_update_later or (lambda: None)
        self._state_dir = state_dir
        self._tray_available = tray_available
        self._tray_hint_shown = initial_tray_hint_shown
        self._close_without_tray = close_without_tray
        self._on_tray_hint = on_tray_hint or (lambda: None)
        self._on_close_policy = on_close_policy or (lambda _policy: None)
        self._on_pairing_retry = on_pairing_retry or (lambda: None)
        self._on_pairing_refresh = on_pairing_refresh or (lambda: None)
        self._on_link_again = on_link_again or (lambda: None)
        self._on_sync_retry = on_sync_retry or (lambda: None)
        self._ui_event_lock = threading.RLock()
        self._ui_ready = False
        self._ui_events = deque(maxlen=256)
        # Health is latest-wins, outside the backlog: the newest snapshot and
        # whether a paint for it is already queued.
        self._health = None
        self._health_queued = False
        self._window_geometry = window_geometry
        self._window_page = window_page
        self._on_window_state = on_window_state
        from ..panel_positions import normalize_panel_positions
        self._companion_panel_positions = normalize_panel_positions(companion_panel_positions)
        self._on_companion_panel_positions = on_companion_panel_positions
        from .window_sizes import normalize_information_layout
        self._window_information_layout = normalize_information_layout(window_information_layout)
        self._on_window_information_layout = on_window_information_layout
        from .race_visuals import normalize_skin
        self._window_skin = normalize_skin(window_skin)
        self._window_animations = window_animations if type(window_animations) is bool else True
        self._on_window_appearance = on_window_appearance
        self._version = version
        self._dashboard_url = dashboard_url
        self._pairing_url = pairing_url
        self._log_dir = log_dir
        self._log_file = log_file
        self._api_base = api_base
        self._replay_folders = list(replay_folders)
        self._initial_paused = initial_paused
        self._initial_paired = initial_paired
        self._initial_user_id = initial_user_id
        self._initial_settings = initial_settings
        # Authoritative "total replays synced" source. The runner wires
        # this to a count over ``state.uploaded``'s dated entries so the
        # dashboard stat survives agent restarts and stays truthful
        # across resyncs (the old session-local += counter reset to 0
        # on every launch and double-counted re-uploads).
        self._synced_count_provider = synced_count_provider
        self._start_minimized = start_minimized

        self._on_pause = on_pause
        self._on_resync = on_resync
        self._on_choose_folder = on_choose_folder
        self._on_check_updates = on_check_updates
        self._on_save_settings = on_save_settings
        self._on_quit = on_quit
        self._on_restart_agent = on_restart_agent or (lambda: None)
        # OBS helpers. Both block on a network round-trip, so the
        # window calls them from a worker thread and delivers the
        # result back over ``signals.obsProbeDone``. Optional: a build
        # without the OBS dependency installed leaves them None and
        # the panel degrades to "unavailable".
        self._on_obs_probe = on_obs_probe
        self._on_obs_build = on_obs_build
        self._stream_status_provider = stream_status_provider
        self._on_stream_action = on_stream_action
        self._on_companion_action = on_companion_action
        # Build check-in cards (``build_checkin_window``). Unavailable
        # under --no-live, where no controller runs. The proxy is handed
        # to the controller on the boot worker; calls that arrive before
        # the window exists wait in a short backlog.
        self._build_checkin_available = build_checkin_available
        self._build_checkin_positions = dict(build_checkin_positions or {})
        self._on_build_checkin_moved = on_build_checkin_moved
        self._on_build_checkin_reset = on_build_checkin_reset
        self._build_checkin_preview_race = build_checkin_preview_race
        self._checkin_proxy = None
        self._checkin_lock = threading.Lock()
        self._checkin_ready = False
        self._checkin_backlog: Deque[tuple] = deque(maxlen=64)

        # Lazily populated at start()
        self._app = None
        self._window = None
        self._signals = None
        self._started_event = threading.Event()
        self._pending_replay_archive_status: Optional[tuple[int, int]] = None

    def _dispatch(self, name, *args):
        with self._ui_event_lock:
            if not self._ui_ready or self._signals is None:
                self._ui_events.append((name,args))
                return
        getattr(self._signals,name).emit(*args)

    def _flush_ui_events(self):
        with self._ui_event_lock:
            self._ui_ready = True
            events = list(self._ui_events)
            self._ui_events.clear()
            self._pending_replay_archive_status = None
        for name,args in events:
            getattr(self._signals,name).emit(*args)

    # ---------------- public sink interface ----------------

    def confirm_obs_add_source(self, payload):
        import time
        if not self._ui_ready or self._signals is None:
            return False
        from ..live.widget_sizes import widget_sizes
        if payload.get("widget") not in widget_sizes():
            return False
        deadline = min(payload["expiresAt"] / 1000, time.time() + 40)
        request = dict(payload, expiresAt=deadline * 1000, done=threading.Event(), accepted=False,
                       label={"opponent": "Opponent identity", "ghost-build": "Ghost Build coach"}.get(payload["widget"], payload["widget"].replace("-", " ").title()))
        self._signals.obsAddConfirmation.emit(request)
        request["done"].wait(max(0, deadline - time.time()))
        accepted = request["done"].is_set() and request["accepted"]
        request["done"].set()
        return True if accepted else "expired" if time.time() >= deadline else False

    def choose_folder(self):
        self._dispatch("chooseFolderRequested")

    def request_resync(self):
        self._dispatch("resyncRequested")

    def check_updates(self):
        self._dispatch("checkUpdatesRequested")

    def on_phase(self, phase, detail=""):
        self._dispatch("phaseChanged", phase, detail)

    def on_analyzer_probe(self, ok, diag):
        self._dispatch("analyzerProbe", ok, diag)

    def on_health(self, snapshot) -> None:
        """Keep the newest snapshot; at most one paint waits for it.

        Never queued in the pre-window backlog, so a burst of snapshots
        can't push pairing or phase events out of it.
        """
        with self._ui_event_lock:
            self._health = snapshot
            if not self._ui_ready or self._signals is None or self._health_queued:
                return
            self._health_queued = True
        self._signals.healthChanged.emit()

    def _take_health(self):
        with self._ui_event_lock:
            self._health_queued = False
            return self._health

    def on_paused(self, paused, until=None):
        self._dispatch("pauseChanged", paused, float(until or 0))

    def set_release_notes(self, notes):
        self._dispatch("releaseNotes", notes)

    def show_update_state(self, release, state, detail=""):
        self._dispatch("updateState", release, state, detail)

    def show_site_notice(self, notice):
        self._dispatch("siteNotice", notice)

    def show_transient_notice(self, message):
        self._dispatch("transientNotice", message)

    def on_pairing_state(self, state) -> None:
        self._dispatch("pairingState", state)

    def on_unlinked(self) -> None:
        self._dispatch("unlinked")

    def on_connection_state(self, kind, since, next_retry_at, waiting_count) -> None:
        self._dispatch("connectionState", kind, since, next_retry_at, waiting_count)

    def show_pairing_code(self, code: str) -> None:
        self._dispatch("pairingCode", code)

    def on_paired(self, user_id: str) -> None:
        self._dispatch("paired", user_id)

    def on_status(self, status: str) -> None:
        self._dispatch("status", status)

    def on_upload_success(self, filename: str) -> None:
        self._dispatch("uploadSuccess", filename)

    def on_game_synced(self, path, summary) -> None:
        self._dispatch("gameSynced", str(path), dict(summary))

    def on_recent_snapshot(self, snapshot) -> None:
        self._dispatch("recentSnapshot", snapshot)

    def on_import_progress(self, snapshot) -> None:
        self._dispatch("importProgress", snapshot)

    def on_upload_failed(self, filename: str, reason: str) -> None:
        self._dispatch("uploadFailed", filename, reason)

    def on_pending(self, count: int) -> None:
        self._dispatch("pendingChanged", int(count))

    def on_update_available(self, latest: str) -> None:
        self._dispatch("updateAvailable", latest)

    def set_replay_folders(self, folders: List[Path]) -> None:
        self._dispatch("foldersChanged", [str(p) for p in folders])

    def show_settings_status(self, status: str) -> None:
        """Surface a settings-tab status line and refresh the
        dashboard's filter chip from the latest agent state.

        Called by the runner after a Settings → Save click — for the
        date-range filter we want the user to see (a) confirmation
        that the change took effect immediately, and (b) the apply
        summary (queued uploads dropped, previously-filtered replays
        re-enabled). The toast self-dismisses after ~5 s.
        """
        self._dispatch("settingsStatus", str(status))

    def show_update_notice(self, message: str, *, sticky: bool = False) -> None:
        """Surface an update-flow notice on the dashboard status card.

        The runner calls this from ``_handle_update_available`` so the
        window states exactly what the updater is doing — installing
        now, waiting because auto-update is off, or (source installs)
        needing a manual installer run. ``sticky`` notices persist
        until replaced; transient ones self-clear after a few seconds.
        """
        self._dispatch("updateNotice", str(message), bool(sticky))

    def on_replay_archive_status(
        self,
        missing_games: int,
        total_games: int,
    ) -> None:
        """Show the one-time latest-agent/full-Re-sync action.

        The startup worker can finish its status request just before Qt has
        constructed its signals, so retain one pending value and replay it as
        soon as the window exists instead of racing the prompt away.
        """
        status = (max(0, int(missing_games)), max(0, int(total_games)))
        if not self._ui_ready:
            self._pending_replay_archive_status = status
        self._dispatch("replayArchiveStatus", *status)

    def build_checkin_view(self):
        """The view the build check-in controller paints through.

        Called on the boot worker: returns a thread-safe proxy that
        forwards every call over ``signals.buildCheckin``; the card
        windows are created on the GUI thread.
        """
        if self._checkin_proxy is None:
            from .build_checkin_window import CheckinViewProxy

            self._checkin_proxy = CheckinViewProxy(self._emit_build_checkin)
        return self._checkin_proxy

    def _build_checkin_controller(self):
        proxy = self._checkin_proxy
        return proxy.controller if proxy is not None else None

    def _emit_build_checkin(self, method: str, args: tuple) -> None:
        with self._checkin_lock:
            if not self._checkin_ready:
                self._checkin_backlog.append((method, args))
                return
        self._signals.buildCheckin.emit(method, args)

    def _start_build_checkin_delivery(self) -> None:
        """The window is wired: deliver the backlog, then live calls.

        Runs on the GUI thread, so the backlog is painted synchronously
        ahead of any call a worker queues from here on.
        """
        with self._checkin_lock:
            self._checkin_ready = True
            backlog = list(self._checkin_backlog)
            self._checkin_backlog.clear()
        for method, args in backlog:
            self._signals.buildCheckin.emit(method, args)

    # ---------------- lifecycle ----------------

    def run(self) -> int:
        """Build the Qt app + window and block on the event loop.

        Must be called on the main thread.
        Returns the exit code from ``QApplication.exec()``.
        """
        QtCore, QtGui, QtWidgets = _qt()

        app = QtWidgets.QApplication.instance() or QtWidgets.QApplication(
            sys.argv if sys.argv else [""],
        )
        app.setApplicationName("SC2 Tools Agent")
        app.setApplicationDisplayName("SC2 Tools Agent")
        app.setQuitOnLastWindowClosed(False)
        app.setStyleSheet(_STYLE)
        self._app = app

        self._signals = _GuiSignals()
        window = _MainWindow(
            ui=self,
            signals=self._signals,
            QtCore=QtCore,
            QtGui=QtGui,
            QtWidgets=QtWidgets,
        )
        self._window = window
        app.aboutToQuit.connect(window._companion_page.shutdown)
        if self._state_dir is not None:
            from ..activation import listen
            try:
                self._activation_server = listen(self._state_dir, window._on_show_requested, parent=window)
            except OSError:
                log.exception("window_activation_listener_failed")

        if self._pending_replay_archive_status is not None:
            self._signals.replayArchiveStatus.emit(
                *self._pending_replay_archive_status,
            )
            self._pending_replay_archive_status = None
        self._start_build_checkin_delivery()

        if self._start_minimized:
            log.info("gui_starting_minimized")
        else:
            window._prepare_explicit_open()
            window.show()

        self._started_event.set()

        rc = app.exec()
        log.info("gui_event_loop_exited rc=%s", rc)
        return rc

    def request_quit(self) -> None:
        """Ask the GUI to close (e.g. from the tray's Quit menu)."""
        self._dispatch("quitRequested")

    def show_window(self) -> None:
        """Bring the window to the foreground (e.g. from a tray click)."""
        self._dispatch("showRequested")

    def started(self, timeout_sec: float = 10.0) -> bool:
        """Block until ``run()`` has built the window. Used by tests."""
        return self._started_event.wait(timeout=timeout_sec)


# ---------------------------------------------------------------------
# Internal Qt classes — only constructed inside GuiUI.run() so they
# never evaluate at import time on a no-GUI install.
# ---------------------------------------------------------------------


def _make_signals():
    """Construct the GuiSignals QObject with all sink signals.

    Defining this inside a function keeps PySide6 imports lazy.
    """
    from PySide6 import QtCore

    class GuiSignals(QtCore.QObject):
        # All UI-mutating events flow through these signals so the
        # background threads never touch widgets directly. Qt routes
        # them onto the GUI thread automatically via the default
        # AutoConnection.
        phaseChanged = QtCore.Signal(str, str)
        analyzerProbe = QtCore.Signal(bool, str)
        # A newer health snapshot is waiting; the window paints the newest.
        healthChanged = QtCore.Signal()
        pauseChanged = QtCore.Signal(bool, float)
        transientNotice = QtCore.Signal(str)
        updateState = QtCore.Signal(object, str, str)
        releaseNotes = QtCore.Signal(str)
        siteNotice = QtCore.Signal(object)
        chooseFolderRequested = QtCore.Signal()
        resyncRequested = QtCore.Signal()
        checkUpdatesRequested = QtCore.Signal()
        pairingState = QtCore.Signal(object)
        unlinked = QtCore.Signal()
        connectionState = QtCore.Signal(str, float, float, int)
        pairingCode = QtCore.Signal(str)
        paired = QtCore.Signal(str)
        status = QtCore.Signal(str)
        uploadSuccess = QtCore.Signal(str)
        gameSynced = QtCore.Signal(str, object)
        recentSnapshot = QtCore.Signal(object)
        importProgress = QtCore.Signal(object)
        uploadFailed = QtCore.Signal(str, object)
        pendingChanged = QtCore.Signal(int)
        updateAvailable = QtCore.Signal(str)
        # Free-text update-flow notice for the status card. ``sticky``
        # notices persist (pending update); transient ones self-clear.
        updateNotice = QtCore.Signal(str, bool)
        # Result of a user-initiated "Check for updates" round-trip —
        # re-enables the button and surfaces the outcome.
        updateCheckDone = QtCore.Signal(str)
        # One-time original-replay archive backfill prompt. Counts only;
        # never sends filenames or game IDs through the UI layer.
        replayArchiveStatus = QtCore.Signal(int, int)
        foldersChanged = QtCore.Signal(list)
        settingsStatus = QtCore.Signal(str)
        settingsSaveDone = QtCore.Signal(object, object)
        # Result of a Test-connection or Build-scenes round-trip. The
        # payload dict carries ``kind`` plus whatever that operation
        # discovered; see ``_on_obs_probe_done``.
        obsProbeDone = QtCore.Signal(dict)
        obsAddConfirmation = QtCore.Signal(object)
        # Build check-in view calls from the controller's state thread:
        # (BuildCheckinView method name, args tuple of frozen models).
        buildCheckin = QtCore.Signal(str, object)
        quitRequested = QtCore.Signal()
        showRequested = QtCore.Signal()

    return GuiSignals()


def _GuiSignals():  # noqa: N802 — class-style factory
    return _make_signals()


def _ObsBuildDialog(
    *, parent, QtWidgets, webcams, games, update_existing=False,
):  # noqa: N802
    """Confirm-before-write dialog for the scene builder.

    The builder changes a user's OBS, so nothing is sent until they
    have seen which sources will be
    used and what will be created. Source pickers rather than
    auto-detection: guessing wrong puts the desktop on stream.
    """

    class Dialog(QtWidgets.QDialog):
        def __init__(self) -> None:
            super().__init__(parent)
            self.setWindowTitle(
                "Update SC2 Tools scenes"
                if update_existing
                else "Build SC2 Tools scenes"
            )
            self.setMinimumWidth(460)
            outer = QtWidgets.QVBoxLayout(self)
            scroll = QtWidgets.QScrollArea()
            scroll.setWidgetResizable(True)
            scroll.setFrameShape(QtWidgets.QFrame.NoFrame)
            contents = QtWidgets.QWidget()
            scroll.setWidget(contents)
            outer.addWidget(scroll)
            v = QtWidgets.QVBoxLayout(contents)
            v.setContentsMargins(20, 18, 20, 18)
            v.setSpacing(12)

            intro = QtWidgets.QLabel(
                "This creates two new scenes:\n\n"
                "  • SC2 Tools — Between Games: big camera, chat "
                "column, small game inset and the SC2 backdrop.\n"
                "  • SC2 Tools — In Game: game full-screen with the "
                "camera tucked in the corner.\n\n"
                "Both scenes include a topmost Stream Dock cover. It is "
                "transparent during normal play, then displays Starting "
                "Soon or BRB above either layout when you select one.\n\n"
                "Your existing scenes are not touched. Both use the "
                "sources you pick below — the same capture, not a "
                "second copy, so there is no extra CPU cost."
            )
            if update_existing:
                intro.setText(
                    "This adds only the selected missing during-game sources "
                    "to your existing SC2 Tools In Game scene. Existing sources, "
                    "settings and their relative order stay in place.\n\n"
                    "A matching Browser Source is reused to avoid duplicate "
                    "audio. Nothing is removed or rebuilt. A missing generated "
                    "scene can be built separately."
                )
            intro.setWordWrap(True)
            v.addWidget(intro)

            if update_existing:
                picker_note = QtWidgets.QLabel(
                    "The capture choices below are ignored by Update. They "
                    "are used only if you choose Replace instead."
                )
                picker_note.setWordWrap(True)
                picker_note.setObjectName("muted")
                v.addWidget(picker_note)

            form = QtWidgets.QFormLayout()
            form.setHorizontalSpacing(16)
            form.setVerticalSpacing(10)

            self._webcam = QtWidgets.QComboBox()
            self._webcam.addItem("— none —", "")
            for name in webcams:
                self._webcam.addItem(name, name)
            if webcams:
                self._webcam.setCurrentIndex(1)
            form.addRow("Webcam", self._webcam)

            self._game = QtWidgets.QComboBox()
            self._game.addItem("— none —", "")
            for name in games:
                self._game.addItem(name, name)
            if games:
                self._game.setCurrentIndex(1)
            form.addRow("Game capture", self._game)
            v.addLayout(form)

            from ..live.obs_game_overlay import GAME_WIDGETS, GAME_WIDGET_LABELS
            during = QtWidgets.QGroupBox("During games")
            during_layout = QtWidgets.QVBoxLayout(during)
            self._during_game = {}
            for key in GAME_WIDGETS:
                label = GAME_WIDGET_LABELS[key] + (" (1920 × 56)" if key == "stats-ticker" else "")
                if key == "ghost-build":
                    label += " (URL setup needed)"
                checkbox = QtWidgets.QCheckBox(label)
                checkbox.setChecked(key == "overlay")
                self._during_game[key] = checkbox
                during_layout.addWidget(checkbox)
            self._show_credit = QtWidgets.QCheckBox("Show SC2 Tools credit on the all-in-one overlay")
            self._show_credit.setChecked(True)
            during_layout.addWidget(self._show_credit)
            ghost_note = QtWidgets.QLabel("Ghost Build uses your account assignments. Choose Practice on a website build or assign a timed build in Look; this source URL updates automatically.")
            ghost_note.setWordWrap(True)
            during_layout.addWidget(ghost_note)
            v.addWidget(during)

            if not webcams or not games:
                warn = QtWidgets.QLabel(
                    (
                        "Some capture choices weren't found. That does not "
                        "affect Update; it matters only if you choose Replace."
                        if update_existing
                        else "Some sources weren't found in OBS. The scenes "
                        "will still be built — add anything missing "
                        "afterwards; they're ordinary scenes you can edit."
                    )
                )
                warn.setWordWrap(True)
                warn.setObjectName("muted")
                v.addWidget(warn)

            self._rebuild = QtWidgets.QCheckBox(
                (
                    "Replace the scenes instead (resets custom changes)"
                    if update_existing
                    else "Replace them if they already exist"
                ),
            )
            self._rebuild.setToolTip(
                "Only ever removes scenes named \u201cSC2 Tools — …\u201d. "
                "Any customisation you made to those two is lost.",
            )
            v.addWidget(self._rebuild)

            buttons = QtWidgets.QDialogButtonBox(
                QtWidgets.QDialogButtonBox.Ok
                | QtWidgets.QDialogButtonBox.Cancel,
            )
            buttons.button(QtWidgets.QDialogButtonBox.Ok).setText(
                "Update" if update_existing else "Build",
            )
            buttons.button(QtWidgets.QDialogButtonBox.Cancel).setDefault(True)
            buttons.button(QtWidgets.QDialogButtonBox.Cancel).setFocus()
            self._cancel = buttons.button(QtWidgets.QDialogButtonBox.Cancel)
            buttons.accepted.connect(self.accept)
            buttons.rejected.connect(self.reject)
            outer.addWidget(buttons)
            screen = self.screen()
            height = min(720, screen.availableGeometry().height() - 60) if screen else 640
            self.resize(560, max(300, height))

        def showEvent(self, event):
            super().showEvent(event)
            self._cancel.setDefault(True)
            self._cancel.setFocus()

        def webcam(self) -> str:
            return self._webcam.currentData() or ""

        def game(self) -> str:
            return self._game.currentData() or ""

        def during_game_widgets(self):
            return [key for key, checkbox in self._during_game.items() if checkbox.isChecked()]

        def show_overlay_credit(self):
            return self._show_credit.isChecked()

        def rebuild(self) -> bool:
            return self._rebuild.isChecked()

    return Dialog()


def _MainWindow(*, ui, signals, QtCore, QtGui, QtWidgets):  # noqa: N802
    """Build and return the main window."""

    class ObsPortSpinBox(QtWidgets.QSpinBox):
        """Keep scrolling the settings page from editing the connection."""

        def wheelEvent(self, event) -> None:
            # Ignore even while focused, so the enclosing scroll area can
            # handle the wheel. Typing, arrow keys and buttons remain usable.
            event.ignore()

    class MainWindow(QtWidgets.QMainWindow):
        """Top-level window — sidebar nav + stacked content area."""

        # Cap the in-memory recent uploads. Anything past this falls off
        # the table; the cloud is the source of truth for the full list.
        _PAGE_KEYS = ("dashboard", "recent", "log", "settings", "streams", "companion")
        apiTestDone = QtCore.Signal(str, int, str)
        MAX_RECENT = 200
        # Tail parsing and its record cap live in activity_log.py.
        LOG_TAIL_INTERVAL_MS = 1500

        def __init__(self) -> None:
            super().__init__()
            self.setWindowFlag(QtCore.Qt.FramelessWindowHint, True)
            self.setAttribute(QtCore.Qt.WA_TranslucentBackground)
            self.setWindowTitle(f"SC2 Tools Agent  ·  v{ui._version}")
            self.resize(1220, 800)
            self.setMinimumSize(480, 360)

            # Window icon — reuse the tray PNG so the alt-tab thumbnail
            # matches the system tray glyph.
            icon_path = Path(__file__).resolve().parent / "tray_icon.png"
            if icon_path.exists():
                icon = QtGui.QIcon()
                pixmap = QtGui.QPixmap(str(icon_path))
                for size in (16,24,32,48,64,256):
                    icon.addPixmap(pixmap.scaled(size,size,QtCore.Qt.KeepAspectRatio,QtCore.Qt.SmoothTransformation))
                self.setWindowIcon(icon)

            self._status = "starting"
            self._paused = ui._initial_paused
            # Kept only for Copy details; the status card renders health snapshots.
            self._boot_detail = ""
            self._analyzer_diag = ""
            self._paired = ui._initial_paired
            self._window_information_layout = ui._window_information_layout
            self._user_id = ui._initial_user_id
            self._uploaded_count = 0 if ui._recent_games_enabled else self._query_synced_count(default=0)
            self._history_facts = None
            self._import_progress = {"phase": "idle"}
            self._folder_generation = 0
            self._folder_removed_instant = set()
            self._pending_count = 0
            self._last_upload: Optional[tuple[str, datetime]] = None
            self._update_pending: Optional[str] = None
            self._recent: Deque[tuple[datetime, str, bool, str]] = deque(
                maxlen=self.MAX_RECENT,
            )
            # The saved sync filter, which a replay-library Re-sync checks
            # (the status card's filter row comes from health snapshots).
            # Sourced from ``_initial_settings`` at boot and refreshed every
            # time the user clicks Save; never read from the live combo
            # widget, so an in-progress edit (typing a custom date,
            # hovering the dropdown) can't count before the user presses Save.
            self._active_filter_label = self._compute_filter_label(
                preset=ui._initial_settings.sync_filter_preset,
                since_iso=ui._initial_settings.sync_filter_since,
                until_iso=ui._initial_settings.sync_filter_until,
            )

            self._build_layout()
            self._refresh_recent()
            self._settings_toast_timer = QtCore.QTimer(self)
            self._settings_toast_timer.setSingleShot(True)
            self._settings_toast_timer.timeout.connect(self._settings_status.clear)
            self._save_ack = False
            self._settings_save_pending = False
            self._settings_restart_notice = ""
            self.apiTestDone.connect(self._on_api_test_done)
            self._window_state_timer = QtCore.QTimer(self)
            self._window_state_timer.setSingleShot(True)
            self._window_state_timer.setInterval(1000)
            self._window_state_timer.timeout.connect(self._save_window_state)
            self._stats_refresh_timer = QtCore.QTimer(self)
            self._stats_refresh_timer.setSingleShot(True)
            self._stats_refresh_timer.setInterval(250)
            self._stats_refresh_timer.timeout.connect(self._refresh_stats)
            self._find_log_shortcut = QtGui.QShortcut(QtGui.QKeySequence("Ctrl+F"), self)
            self._find_log_shortcut.setContext(QtCore.Qt.WindowShortcut)
            self._find_log_shortcut.activated.connect(self._focus_log_search)
            self._stack.currentChanged.connect(lambda _index: self._schedule_window_state())
            guard_value_widgets(self._stack.widget(3), QtCore, QtWidgets)
            from .build_checkin_window import BuildCheckinHost

            self._checkin_host = BuildCheckinHost(
                controller=ui._build_checkin_controller,
                positions=ui._build_checkin_positions,
                on_moved=ui._on_build_checkin_moved,
                settings=self._checkin_settings,
                preview_race=ui._build_checkin_preview_race,
                on_reset_positions=ui._on_build_checkin_reset,
                assistance_reason=self._companion_page.assistance_off_reason,
            )
            if callable(ui._on_companion_action):
                self._companion_page.assistanceChanged.connect(self._checkin_host.set_panels_enabled)
                self._checkin_host.set_panels_enabled(self._companion_page.assistance_enabled())
                self._companion_page.modesChanged.connect(self._checkin_host.set_feature_gates)
                from .assistance_hotkey import build_assistance_hotkey

                self._assistance_hotkey = build_assistance_hotkey(
                    QtWidgets.QApplication.instance(), self._toggle_assistance,
                    QtCore=QtCore,
                )
                self._companion_page.hotkeyEnabledChanged.connect(self._set_assistance_hotkey)
                QtWidgets.QApplication.instance().aboutToQuit.connect(self._assistance_hotkey.shutdown)
            self._wire_signals()
            self._refresh_controls()
            self._refresh_stats()
            self._refresh_pairing_card()
            self._populate_settings()
            self._saved_api_base = self._api_input.text().strip().rstrip("/")
            self._loaded_restart_values = (
                self._saved_api_base, self._log_combo.currentText(),
                ui._initial_settings.parse_concurrency or int(self._concurrency_slider.value()),
            )
            self._restore_window_state()
            # Unlike the other draft fields, this is a live safety switch: a
            # streamer who unchecks it expects the agent to stop driving OBS
            # now, not after finding and pressing Save at the bottom of the
            # page. Connect only after population so seeding the saved value
            # cannot write state during window construction.
            self._obs_enable_last_saved = self._obs_enable_check.isChecked()
            self._obs_enable_check.toggled.connect(
                self._toggle_obs_scene_switch,
            )
            self._replay_capture_last_saved = (
                self._replay_capture_check.isChecked()
            )
            self._replay_capture_check.toggled.connect(
                self._toggle_replay_capture,
            )
            self._refresh_capture_notice()
            ui._flush_ui_events()
            self._render_health(ui._take_health() or self._health_view.snapshot)
            self._tail_log_now()

            # Periodic log tail. Watchdog FS events on Windows are
            # unreliable for tail-style reads of an actively-rotating
            # file, so we poll. Cheap — the file rarely grows fast.
            self._log_timer = QtCore.QTimer(self)
            self._log_timer.setInterval(self.LOG_TAIL_INTERVAL_MS)
            self._log_timer.timeout.connect(self._tail_log_now)
            self._log_timer.start()

        # ---- layout ----

        def _build_layout(self) -> None:
            central = QtWidgets.QWidget()
            central.setObjectName("agentRoot")
            self.setCentralWidget(central)

            self._outer_layout = QtWidgets.QVBoxLayout(central)
            self._outer_layout.setContentsMargins(10, 10, 10, 10)
            self._outer_layout.setSpacing(0)
            self._agent_frame = QtWidgets.QFrame()
            self._agent_frame.setObjectName("agentFrame")
            self._agent_frame.setProperty("companion", False)
            self._outer_layout.addWidget(self._agent_frame)
            self._frame_layout = QtWidgets.QVBoxLayout(self._agent_frame)
            self._frame_layout.setContentsMargins(14, 12, 14, 14)
            self._frame_layout.setSpacing(10)
            self._agent_brandbar = QtWidgets.QWidget()
            self._agent_brandbar.setObjectName("agentBrandbar")
            brand_row = QtWidgets.QHBoxLayout(self._agent_brandbar)
            brand_row.setContentsMargins(0, 0, 0, 0)
            brand_row.setSpacing(10)
            emblem = QtWidgets.QLabel()
            emblem.setObjectName("agentBrandOrb")
            emblem.setFixedSize(23, 23)
            brand_row.addWidget(emblem)
            brand = QtWidgets.QLabel("SC2 TOOLS")
            brand.setObjectName("agentBrand")
            brand_row.addWidget(brand)
            edition = QtWidgets.QLabel("AGENT")
            edition.setObjectName("agentEdition")
            brand_row.addWidget(edition)
            self._agent_edition = edition
            brand_row.addStretch()
            version = QtWidgets.QLabel(f"v{ui._version}")
            version.setObjectName("agentEdition")
            brand_row.addWidget(version)
            self._agent_version = version
            self._agent_menu_button = QtWidgets.QToolButton()
            self._agent_menu_button.setText("Agent")
            self._agent_menu_button.setAccessibleName("Agent pages and settings")
            self._agent_menu_button.setPopupMode(QtWidgets.QToolButton.InstantPopup)
            self._agent_menu = QtWidgets.QMenu(self)
            menu = self._agent_menu
            for title, route in (("Companion", "companion"), ("Dashboard", "dashboard"), ("Recent games", "recent"), ("Streams", "streams"), ("Activity log", "log"), ("Settings", "settings")):
                menu.addAction(title, lambda _checked=False, destination=route: self._go_to_page(destination))
            menu.addSeparator()
            menu.addAction("Border & animations…", self._open_companion_appearance)
            menu.addAction("Help & support", lambda: self._open_help("desktop-app-overview"))
            self._check_updates_action = menu.addAction("Check for updates", self._check_updates_from_menu)
            menu.addSeparator()
            menu.addAction("Quit SC2 Tools", ui._on_quit)
            self._agent_menu_button.setMenu(menu)
            brand_row.addWidget(self._agent_menu_button)
            from .window_chrome import build_window_controls
            self._agent_window_controls = build_window_controls(self._agent_brandbar, window=self, QtCore=QtCore, QtWidgets=QtWidgets)
            brand_row.addWidget(self._agent_window_controls)
            self._frame_layout.addWidget(self._agent_brandbar)
            body = QtWidgets.QHBoxLayout()
            body.setContentsMargins(0, 0, 0, 0)
            body.setSpacing(12)
            self._frame_layout.addLayout(body, 1)
            self._agent_body = body

            self._sidebar = self._build_sidebar()
            body.addWidget(self._sidebar)

            self._agent_display = QtWidgets.QFrame()
            self._agent_display.setObjectName("agentDisplay")
            self._agent_display.setProperty("companion", False)
            display_layout = QtWidgets.QVBoxLayout(self._agent_display)
            display_layout.setContentsMargins(0, 0, 0, 0)
            display_layout.setSpacing(0)
            self._agent_toolbar = QtWidgets.QWidget()
            self._agent_toolbar.setObjectName("agentPageToolbar")
            toolbar = QtWidgets.QHBoxLayout(self._agent_toolbar)
            toolbar.setContentsMargins(12, 10, 12, 0)
            toolbar.setSpacing(8)
            self._agent_companion_button = QtWidgets.QPushButton("‹ Companion")
            self._agent_companion_button.setToolTip("Return to Companion without losing your place or unsaved settings.")
            self._agent_companion_button.clicked.connect(lambda: self._go_to_page("companion"))
            toolbar.addWidget(self._agent_companion_button)
            home_button = QtWidgets.QPushButton("Home")
            home_button.setAccessibleName("Agent dashboard")
            home_button.clicked.connect(lambda: self._go_to_page("dashboard"))
            toolbar.addWidget(home_button)
            self._agent_section_label = QtWidgets.QLabel()
            self._agent_section_label.setObjectName("agentBreadcrumb")
            self._agent_section_label.setTextFormat(QtCore.Qt.PlainText)
            self._agent_section_label.setMinimumWidth(0)
            self._agent_section_label.setSizePolicy(QtWidgets.QSizePolicy.Ignored, QtWidgets.QSizePolicy.Preferred)
            toolbar.addWidget(self._agent_section_label, 1)
            display_layout.addWidget(self._agent_toolbar)
            self._stack = QtWidgets.QStackedWidget()
            self._stack.setObjectName("agentPageStack")
            display_layout.addWidget(self._stack, stretch=1)
            body.addWidget(self._agent_display, stretch=1)

            self._stack.addWidget(self._build_dashboard())
            self._stack.addWidget(self._build_recent_tab())
            self._stack.addWidget(self._build_logs_tab())
            self._stack.addWidget(self._build_settings_tab())
            from .streams_page import build_streams_page
            self._stack.addWidget(build_streams_page(
                self, provider=ui._stream_status_provider,
                handler=ui._on_stream_action, QtCore=QtCore,
                QtWidgets=QtWidgets,
            ))
            from .companion_page import build_companion_page
            self._companion_page = build_companion_page(
                self, handler=ui._on_companion_action, QtCore=QtCore,
                QtGui=QtGui, QtWidgets=QtWidgets,
                checkin_controller_provider=ui._build_checkin_controller,
                panel_positions=ui._companion_panel_positions,
                on_panel_positions=ui._on_companion_panel_positions,
                agent_menu=self._agent_menu,
            )
            self._stack.addWidget(self._companion_page)
            for index in range(self._stack.count()):
                page = self._stack.widget(index)
                page.setProperty("agentPage", page is not self._companion_page)
            self._normal_stack_policy = self._stack.sizePolicy()
            self._companion_page.windowSizeRequested.connect(self._set_window_size)
            self._companion_page.agentPageRequested.connect(self._go_to_page)
            if hasattr(self._companion_page, "set_density"):
                self._companion_page.set_density(ui._window_information_layout)
                self._companion_page.densityChanged.connect(self._information_layout_changed)
            console = self._companion_page.console
            self._companion_window_controls = build_window_controls(console, window=self, QtCore=QtCore, QtWidgets=QtWidgets)
            console.attach_window_controls(self._companion_window_controls)
            self._companion_page.compact_card.minimizeRequested.connect(self.showMinimized)
            self._companion_page.compact_card.closeRequested.connect(self.close)
            from .window_chrome import install_window_interactions
            self._window_interactions = install_window_interactions(
                self, drag_widgets=[self._agent_brandbar, console.brand_widget, self._companion_page.compact_card],
                QtCore=QtCore, QtWidgets=QtWidgets, can_maximize=lambda: not self._compact_window_active(),
            )
            from .race_visuals import create_race_effects
            self._race_effects = create_race_effects(self, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
            QtWidgets.QApplication.instance().aboutToQuit.connect(self._race_effects.shutdown)
            from .overlay_input import install_overlay_input
            self._overlay_input = install_overlay_input(
                self, panels_provider=lambda: [*self._companion_page.overlays.values(),
                    self._companion_page.ghost_page.panel, self._companion_page.session_panel],
                compact_provider=self._compact_window_active, QtCore=QtCore, QtWidgets=QtWidgets,
                scouting_buttons_provider=self._companion_page.scouting_buttons,
            )
            self._companion_page.inputTargetsChanged.connect(self._coalesce_compact_opponent)
            self._companion_page.inputTargetsChanged.connect(self._overlay_input.refresh)
            QtWidgets.QApplication.instance().aboutToQuit.connect(self._overlay_input.shutdown)
            self._companion_page.set_appearance(ui._window_skin, ui._window_animations)
            self._companion_page.appearanceChanged.connect(self._window_appearance_changed)
            self._apply_window_appearance()

        def _build_sidebar(self) -> QtWidgets.QWidget:
            frame = QtWidgets.QFrame()
            frame.setObjectName("agentSidebar")
            frame.setFixedWidth(240)

            layout = QtWidgets.QVBoxLayout(frame)
            layout.setContentsMargins(10, 10, 10, 10)
            layout.setSpacing(8)

            brand = QtWidgets.QLabel("Your agent")
            brand.setObjectName("h2")
            layout.addWidget(brand)

            tagline = QtWidgets.QLabel("Sync, history and streaming")
            tagline.setObjectName("muted")
            layout.addWidget(tagline)

            layout.addSpacing(8)

            self._nav_group = QtWidgets.QButtonGroup(self)
            self._nav_group.setExclusive(True)

            for index, label in [
                (5, "Companion"), (0, "Dashboard"), (1, "Recent games"),
                (4, "Streams"), (2, "Activity log"), (3, "Settings"),
            ]:
                btn = QtWidgets.QPushButton(label)
                btn.setObjectName("navItem")
                btn.setCheckable(True)
                btn.setCursor(QtCore.Qt.PointingHandCursor)
                if index == 0:
                    btn.setChecked(True)
                btn.clicked.connect(
                    lambda _checked=False, key=self._PAGE_KEYS[index]: self._go_to_page(key),
                )
                self._nav_group.addButton(btn, index)
                layout.addWidget(btn)

            layout.addStretch(1)

            self._sidebar_status = QtWidgets.QLabel()
            self._sidebar_status.setObjectName("muted")
            self._sidebar_status.setWordWrap(False)
            self._sidebar_status.setMinimumWidth(0)
            self._sidebar_status.setSizePolicy(QtWidgets.QSizePolicy.Ignored, QtWidgets.QSizePolicy.Preferred)
            layout.addWidget(self._sidebar_status)

            help_btn = QtWidgets.QPushButton("Help & support")
            help_btn.setFlat(True)
            help_btn.clicked.connect(lambda: self._open_help("desktop-app-overview"))
            layout.addWidget(help_btn)
            quit_btn = QtWidgets.QPushButton("Quit SC2 Tools")
            quit_btn.setFlat(True)
            quit_btn.clicked.connect(ui._on_quit)
            quit_row=QtWidgets.QWidget()
            quit_layout=QtWidgets.QHBoxLayout(quit_row)
            quit_layout.setContentsMargins(0,0,0,0)
            quit_layout.addWidget(quit_btn)
            quit_layout.addWidget(help_button(QtWidgets,"Window and tray",lambda:self._open_help("desktop-app-tray")))
            layout.addWidget(quit_row)

            version_lbl = QtWidgets.QLabel(f"v{ui._version}")
            version_lbl.setObjectName("dim")
            footer = QtWidgets.QHBoxLayout()
            footer.addWidget(version_lbl)
            self._updates_btn = QtWidgets.QPushButton("Updates")
            self._updates_btn.setAccessibleName("Check for updates")
            self._updates_btn.setToolTip("Check for updates")
            self._updates_btn.setFlat(True)
            self._updates_btn.clicked.connect(self._click_check_updates)
            footer.addWidget(self._updates_btn)
            layout.addLayout(footer)

            return frame

        # ---- Dashboard tab ----

        def _build_dashboard(self) -> QtWidgets.QWidget:
            page = QtWidgets.QWidget()
            v = QtWidgets.QVBoxLayout(page)
            v.setContentsMargins(28, 24, 28, 24)
            v.setSpacing(18)

            title = QtWidgets.QLabel("Dashboard")
            title.setObjectName("h1")
            v.addWidget(title)

            from .service_notice import build_service_notice
            self._site_notice_card = build_service_notice(self, QtCore=QtCore, QtWidgets=QtWidgets,
                dashboard_url=ui._dashboard_url, open_browser=lambda url: webbrowser.open(url,new=2))
            v.addWidget(self._site_notice_card)
            v.addWidget(self._build_status_card())
            from .update_card import build_update_card
            self._update_card = build_update_card(self, QtCore=QtCore, QtWidgets=QtWidgets,
                install=lambda: self._run_update_action(ui._on_install_update),
                later=lambda: self._run_update_action(ui._on_update_later),
                download=lambda: webbrowser.open(site_url(ui._dashboard_url,"/download"),new=2),
                help_button=help_button(QtWidgets,"Updates",lambda:self._open_help("desktop-app-updates")))
            v.addWidget(self._update_card)
            # The status card owns offline/busy recovery; the kind picks its help anchor.
            self._connection_kind = "online"
            v.addWidget(self._build_replay_archive_card())
            v.addWidget(self._build_pairing_card())
            self._stats_row = self._build_stats_row()
            v.addWidget(self._stats_row)
            v.addWidget(self._build_action_row())
            from .game_dashboard import build_game_dashboard
            self._game_dashboard = build_game_dashboard(self, QtCore=QtCore, QtWidgets=QtWidgets,
                open_game=self._open_recent_game, pause=self._click_pause,
                current_season=self._import_current_season,
                open_website=self._open_checkin_queue, open_help=self._open_help)
            v.addWidget(self._game_dashboard)
            v.addStretch(1)
            scroll = QtWidgets.QScrollArea()
            scroll.setWidgetResizable(True)
            scroll.setFrameShape(QtWidgets.QFrame.NoFrame)
            scroll.setWidget(page)
            return scroll

        def _build_replay_archive_card(self) -> QtWidgets.QFrame:
            card = QtWidgets.QFrame()
            card.setObjectName("cardArchive")
            card.hide()
            self._replay_archive_card = card

            from .qt_helpers import build_flow_layout
            row = build_flow_layout(card, QtCore=QtCore, QtWidgets=QtWidgets, spacing=18)
            row.setContentsMargins(20, 16, 20, 16)
            copy_body = QtWidgets.QWidget()
            copy = QtWidgets.QVBoxLayout(copy_body)
            copy.setContentsMargins(0, 0, 0, 0)
            copy.setSpacing(4)
            heading = QtWidgets.QLabel("Enable original replay downloads")
            heading.setObjectName("h2")
            heading.setWordWrap(True)
            copy.addWidget(heading)
            self._replay_archive_text = QtWidgets.QLabel("")
            self._replay_archive_text.setObjectName("muted")
            self._replay_archive_text.setWordWrap(True)
            copy.addWidget(self._replay_archive_text)
            row.addWidget(copy_body)

            self._replay_archive_button = QtWidgets.QPushButton(
                "Re-sync replay library",
            )
            self._replay_archive_button.setObjectName("primary")
            self._replay_archive_button.setSizePolicy(
                QtWidgets.QSizePolicy.Maximum,
                QtWidgets.QSizePolicy.Fixed,
            )
            self._replay_archive_button.clicked.connect(
                self._click_archive_resync,
            )
            row.addWidget(self._replay_archive_button)
            return card

        def _build_status_card(self) -> QtWidgets.QFrame:
            card = QtWidgets.QFrame()
            card.setObjectName("card")

            column = QtWidgets.QVBoxLayout(card)
            column.setContentsMargins(20, 18, 20, 18)
            column.setSpacing(8)

            # The newest health snapshot is the card's only source of status.
            from .health_card import build_health_view
            self._health_view = build_health_view(
                card, QtCore=QtCore, QtWidgets=QtWidgets,
                status_help=help_button(QtWidgets, "Status lights", lambda: self._open_help("desktop-app-status")),
                run_action=self._run_health_action, open_row_help=self._open_row_help,
                row_tooltip=self._health_row_tooltip,
            )
            column.addWidget(self._health_view)

            self._update_badge = QtWidgets.QLabel("")
            self._update_badge.setObjectName("badgeWarn")
            self._update_badge.hide()
            column.addWidget(self._update_badge, 0, QtCore.Qt.AlignLeft)

            # Update-flow notice line — populated by the runner's
            # update handler ("installing now…", "auto-update off",
            # "run installer manually") and by the Check-for-updates
            # round-trip result. Hidden while empty so the card stays
            # two rows tall in the common case.
            self._update_notice = QtWidgets.QLabel("")
            self._update_notice.setObjectName("muted")
            self._update_notice.setWordWrap(True)
            self._update_notice.hide()
            column.addWidget(self._update_notice)
            self._replay_capture_notice = QtWidgets.QLabel(
                "Automatic replay capture is on. New and re-synced replays "
                "are recorded with StarCraft II before upload. This can use "
                "substantial CPU. Turn it off in Settings to stop automatic capture."
            )
            self._replay_capture_notice.setObjectName("muted")
            self._replay_capture_notice.setWordWrap(True)
            self._replay_capture_notice.hide()
            column.addWidget(self._replay_capture_notice)
            self._notice_timer = QtCore.QTimer(self)
            self._notice_timer.setSingleShot(True)
            self._notice_timer.timeout.connect(self._clear_update_notice)

            self._status_card = card
            from .qt_helpers import build_flow_layout
            actions = build_flow_layout(QtCore=QtCore, QtWidgets=QtWidgets)
            # Shown for errors, next to a boot failure's Restart agent.
            self._status_copy = QtWidgets.QPushButton("Copy details")
            self._status_copy.clicked.connect(self._copy_status_details)
            self._status_copy.hide()
            actions.addWidget(self._status_copy)
            column.addLayout(actions)
            self._transient_notice = QtWidgets.QLabel()
            self._transient_notice.setTextFormat(QtCore.Qt.PlainText)
            self._transient_notice.setWordWrap(True)
            self._transient_notice.hide()
            column.addWidget(self._transient_notice)
            self._release_notes = ""
            self._whats_new_btn = QtWidgets.QPushButton("What's new")
            self._whats_new_btn.clicked.connect(self._show_release_notes)
            self._whats_new_btn.hide()
            actions.addWidget(self._whats_new_btn)
            self._transient_timer = QtCore.QTimer(self)
            self._transient_timer.setSingleShot(True)
            self._transient_timer.timeout.connect(self._transient_notice.hide)
            self._folder_undo_dash = QtWidgets.QPushButton("Undo folder change")
            self._folder_undo_dash.clicked.connect(self._undo_folder_change)
            self._folder_undo_dash.hide()
            column.addWidget(self._folder_undo_dash, 0, QtCore.Qt.AlignLeft)
            return card

        def _set_update_notice(self, message: str, *, sticky: bool) -> None:
            self._notice_timer.stop()
            if not message:
                self._clear_update_notice()
                return
            self._update_notice.setText(message)
            self._update_notice.show()
            if not sticky:
                self._notice_timer.start(8000)

        def _clear_update_notice(self) -> None:
            self._update_notice.clear()
            self._update_notice.hide()

        def _build_pairing_card(self) -> QtWidgets.QFrame:
            from .pairing_card import build_pairing_card
            self._pairing_card = build_pairing_card(
                self, QtCore=QtCore, QtWidgets=QtWidgets,
                open_browser=lambda url: webbrowser.open(url, new=2),
                copy_text=lambda code: QtWidgets.QApplication.clipboard().setText(code),
                dashboard_url=ui._dashboard_url, retry_now=ui._on_pairing_retry,
                new_code=ui._on_pairing_refresh, link_again=ui._on_link_again,
                open_log=lambda: self.show_log("errors"),
                open_help=lambda: self._open_help("pairing-troubleshooting"),
            )
            self._pairing_code_label = self._pairing_card.code_label
            self._copy_btn = self._pairing_card.copy
            return self._pairing_card

        def _on_connection_state(self, kind, since, next_retry_at, waiting_count):
            self._connection_kind = kind
            self._request_stats_refresh()

        def _build_stats_row(self) -> QtWidgets.QWidget:
            row = QtWidgets.QFrame()
            h = QtWidgets.QGridLayout(row)
            h.setContentsMargins(0, 0, 0, 0)
            h.setSpacing(14)
            self._stats_layout = h

            self._stat_synced = self._make_stat_card("Synced", "0")
            self._stat_queued = self._make_stat_card("Waiting", "0")
            self._stat_last = self._make_stat_card("Last upload", "—")
            self._stat_failed = self._make_stat_card("Failed (24 h)", "0")
            failures = QtWidgets.QPushButton("View problems")
            failures.setFlat(True)
            failures.clicked.connect(self._show_recent_problems)
            self._stat_failed["frame"].layout().addWidget(failures)

            self._stat_cards = (self._stat_synced, self._stat_queued, self._stat_last, self._stat_failed)
            for column, card in enumerate(self._stat_cards):
                h.addWidget(card["frame"], 0, column)
                h.setColumnStretch(column, 1)

            return row

        def _make_stat_card(self, label: str, value: str) -> dict:
            card = QtWidgets.QFrame()
            card.setObjectName("card")
            v = QtWidgets.QVBoxLayout(card)
            v.setContentsMargins(18, 14, 18, 14)
            v.setSpacing(2)

            value_lbl = QtWidgets.QLabel(value)
            value_lbl.setObjectName("stat")
            v.addWidget(value_lbl)

            label_lbl = QtWidgets.QLabel(label)
            label_lbl.setObjectName("muted")
            label_lbl.setWordWrap(True)
            v.addWidget(label_lbl)

            return {"frame": card, "value": value_lbl, "label": label_lbl}

        def _build_action_row(self) -> QtWidgets.QWidget:
            # Two-row layout: cramming five buttons into one row makes
            # Qt shrink labels below their natural width on smaller
            # window sizes (which is what users were seeing — "Re-sync
            # from scratch" rendering with the trailing "scratch"
            # clipped past the button border). Splitting into local
            # actions on top and external actions on the bottom keeps
            # every label fully readable down to the window's minimum
            # size of 820 px.
            outer = QtWidgets.QFrame()
            v = QtWidgets.QVBoxLayout(outer)
            v.setContentsMargins(0, 0, 0, 0)
            v.setSpacing(8)

            local_row = QtWidgets.QHBoxLayout()
            local_row.setSpacing(8)
            local_row.setContentsMargins(0, 0, 0, 0)

            self._pause_btn = QtWidgets.QPushButton(
                "Resume syncing" if self._paused else "Pause syncing",
            )
            self._pause_btn.setSizePolicy(
                QtWidgets.QSizePolicy.Maximum, QtWidgets.QSizePolicy.Fixed,
            )
            self._pause_btn.setToolTip(
                "Pause keeps the watcher running but stops uploads; "
                "resume drains the queue.",
            )
            self._pause_btn.clicked.connect(self._click_pause)
            local_row.addWidget(self._pause_btn)

            resync_btn = QtWidgets.QPushButton("Re-sync")
            self._resync_btn = resync_btn
            resync_btn.setSizePolicy(
                QtWidgets.QSizePolicy.Maximum, QtWidgets.QSizePolicy.Fixed,
            )
            resync_btn.setToolTip(
                "Re-sync from scratch — clear the local upload cursor "
                "and re-upload every replay we can see (the cloud "
                "de-duplicates by game ID).",
            )
            resync_btn.clicked.connect(self._click_resync)
            # Placed in Settings Maintenance below; keep it away from Pause.

            choose_btn = QtWidgets.QPushButton("Add replay folder…")
            self._choose_btn = choose_btn
            choose_btn.setSizePolicy(
                QtWidgets.QSizePolicy.Maximum, QtWidgets.QSizePolicy.Fixed,
            )
            choose_btn.setToolTip(
                "Add another StarCraft II Replays folder to the watch "
                "list. Each region/account has its own folder, so add "
                "one entry per region you play on.",
            )
            choose_btn.clicked.connect(self._click_choose_folder)
            local_row.addWidget(choose_btn)
            local_row.addStretch(1)
            v.addLayout(local_row)

            ext_row = QtWidgets.QHBoxLayout()
            ext_row.setSpacing(8)
            ext_row.setContentsMargins(0, 0, 0, 0)
            ext_row.addStretch(1)

            dash_btn = QtWidgets.QPushButton("Open dashboard")
            dash_btn.setObjectName("primary")
            dash_btn.setSizePolicy(
                QtWidgets.QSizePolicy.Maximum, QtWidgets.QSizePolicy.Fixed,
            )
            dash_btn.clicked.connect(self._open_dashboard)
            ext_row.addWidget(dash_btn)
            v.addLayout(ext_row)

            return outer

        # ---- Recent tab ----

        def _build_recent_tab(self) -> QtWidgets.QWidget:
            from .recent_games import build_recent_games
            self._recent_widget = build_recent_games(self, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets,
                open_game=self._open_recent_game, reveal=self._show_recent_file,
                retry=self._retry_recent,
                open_help=self._open_help)
            self._recent_table, self._recent_empty = self._recent_widget.table, self._recent_widget.empty
            return self._recent_widget

        # ---- Logs tab ----

        def _build_logs_tab(self) -> QtWidgets.QWidget:
            from .activity_log import build_activity_log
            self._activity_log = build_activity_log(
                self, log_file=ui._log_file, QtCore=QtCore, QtGui=QtGui,
                QtWidgets=QtWidgets, open_folder=self._open_log_folder,
                open_help=lambda: self._open_help("desktop-app-activity-log"),
                palette={"error": _DANGER, "warning": _WARNING,
                         "muted": _TEXT_MUTED, "text": _TEXT, "accent": _ACCENT},
            )
            self._log_view = self._activity_log.view
            self._log_filter_combo = self._activity_log.filter_combo
            return self._activity_log

        def _focus_log_search(self):
            self._go_to_page("log")
            self._activity_log.search.setFocus()
            self._activity_log.search.selectAll()

        def show_log(self, filter="errors", jump_to_last=True):
            self._go_to_page("log")
            combo = self._activity_log.filter_combo
            index = combo.findData(filter)
            combo.setCurrentIndex(max(0, index))
            self._tail_log_now()
            if jump_to_last:
                self._activity_log.jump_to_latest()

        # ---- Settings tab ----

        def _build_settings_tab(self) -> QtWidgets.QWidget:
            # The form is taller than the window's minimum height, so
            # everything lives inside a scroll area — otherwise the
            # bottom rows (and the Save button with them) are simply
            # clipped off-screen at small window sizes with no way to
            # reach them.
            scroller = QtWidgets.QScrollArea()
            scroller.setWidgetResizable(True)
            scroller.setFrameShape(QtWidgets.QFrame.NoFrame)
            scroller.setHorizontalScrollBarPolicy(QtCore.Qt.ScrollBarAsNeeded)
            self._settings_scroll = scroller

            page = QtWidgets.QWidget()
            v = QtWidgets.QVBoxLayout(page)
            v.setContentsMargins(10, 18, 10, 18)
            v.setSpacing(14)

            title = QtWidgets.QLabel("Settings")
            title.setObjectName("h1")
            v.addWidget(title)

            form_card = QtWidgets.QFrame()
            form_card.setObjectName("card")
            form = QtWidgets.QFormLayout(form_card)
            form.setContentsMargins(12, 14, 12, 14)
            form.setHorizontalSpacing(20)
            form.setVerticalSpacing(14)
            form.setLabelAlignment(QtCore.Qt.AlignRight | QtCore.Qt.AlignVCenter)
            form.setRowWrapPolicy(QtWidgets.QFormLayout.WrapLongRows)

            self._api_test_generation = 0
            self._api_input = QtWidgets.QLineEdit()
            self._api_input.setPlaceholderText(_DEFAULT_API_BASE)
            self._api_input.setToolTip(
                "Where the agent uploads parsed replays and fetches your "
                "profile. Leave blank to use the production cloud API "
                "(https://sc2tools-api.onrender.com). Override only when "
                "you're running a private API instance — e.g. local dev "
                "or a self-hosted ingest endpoint.",
            )
            api_block = QtWidgets.QWidget()
            api_v = QtWidgets.QVBoxLayout(api_block)
            api_v.setContentsMargins(0, 0, 0, 0)
            api_row = QtWidgets.QHBoxLayout()
            api_row.addWidget(self._api_input, 1)
            api_actions = QtWidgets.QHBoxLayout()
            self._api_reset_btn = QtWidgets.QPushButton("Reset to default")
            self._api_reset_btn.clicked.connect(self._reset_api_address)
            api_actions.addWidget(self._api_reset_btn)
            self._api_test_btn = QtWidgets.QPushButton("Test")
            self._api_test_btn.clicked.connect(self._test_api_address)
            api_actions.addWidget(self._api_test_btn)
            api_v.addLayout(api_row)
            api_actions.addStretch(1)
            api_v.addLayout(api_actions)
            api_hint = QtWidgets.QLabel("Leave blank to use sc2tools.com")
            api_hint.setObjectName("muted")
            api_v.addWidget(api_hint)
            self._api_error = QtWidgets.QLabel("")
            self._api_error.setObjectName("fieldError")
            self._api_error.setWordWrap(True)
            api_v.addWidget(self._api_error)
            self._api_test_status = QtWidgets.QLabel("")
            self._api_test_status.setObjectName("muted")
            self._api_test_status.setWordWrap(True)
            api_v.addWidget(self._api_test_status)
            self._api_input.editingFinished.connect(self._validate_api_address)
            self._api_input.textChanged.connect(self._on_api_text_changed)
            api_label = QtWidgets.QLabel(f"API base URL<br/><span style='color:{_TEXT_MUTED}'>Needs restart</span>")
            form.addRow(api_label, api_block)

            self._handle_input = QtWidgets.QLineEdit()
            self._handle_input.setPlaceholderText(
                "e.g. ReSpOnSe  (leave blank to auto-detect from replays)",
            )
            self._handle_input.setToolTip(
                "Your in-game player name. Used to identify which player "
                "is YOU in each replay. Leave blank to auto-detect from "
                "the most recent replay in your watched folders. The "
                "value can be a clan-tagged display name or just a "
                "unique substring; the parser does a case-sensitive "
                "substring match against in-replay player names.",
            )
            form.addRow("Player handle", self._handle_input)

            # Parse concurrency. Slider capped at the SMALLER of
            # ``cpu_count`` and ``_PARSE_CONCURRENCY_USEFUL_MAX`` —
            # not just ``cpu_count``. Why: the cloud's 120 req/min
            # rate limit × 25-game upload batches caps total
            # throughput at ~50 games/sec end-to-end. One parse
            # worker delivers ~3-5 games/sec depending on replay
            # length, so 8-12 workers already saturate the upload
            # pipeline. Anything above that just queues parsed games
            # in memory while the upload thread drains at the same
            # rate. Capping the slider at the useful ceiling keeps
            # the UI honest — moving it from 12 to 32 produces zero
            # visible speedup, so we don't offer the option. Power
            # users who self-host the cloud API with a higher rate
            # limit can override via ``SC2TOOLS_PARSE_CONCURRENCY``.
            cpu_count = max(1, os.cpu_count() or 4)
            cpu_max = min(cpu_count, _PARSE_CONCURRENCY_USEFUL_MAX)
            default_workers = min(4, cpu_max)
            concurrency_block = QtWidgets.QWidget()
            concurrency_h = QtWidgets.QHBoxLayout(concurrency_block)
            concurrency_h.setContentsMargins(0, 0, 0, 0)
            concurrency_h.setSpacing(10)
            self._concurrency_slider = QtWidgets.QSlider(QtCore.Qt.Horizontal)
            self._concurrency_slider.setRange(1, cpu_max)
            self._concurrency_slider.setValue(default_workers)
            self._concurrency_slider.setTickPosition(
                QtWidgets.QSlider.TicksBelow,
            )
            # Tick every step. The slider only goes up to ~12 now so
            # we don't need the high-density compression we used to
            # apply for 32-thread monsters.
            self._concurrency_slider.setTickInterval(1)
            cpu_hint = (
                f"capped at {cpu_max} (your CPU has {cpu_count} threads "
                f"but uploads max out around {cpu_max} parsers — more "
                f"workers won't speed anything up)"
                if cpu_count > cpu_max
                else f"capped at your CPU's {cpu_max} threads"
            )
            self._concurrency_slider.setToolTip(
                f"How many replays to parse in parallel. Each worker "
                f"is a separate process and consumes one CPU thread "
                f"plus ~150 MB of sc2reader state. The cloud upload "
                f"pipeline tops out near 50 games/sec, so 8-12 parse "
                f"workers already saturate it — {cpu_hint}. Takes "
                f"effect on next agent restart."
            )
            self._concurrency_value_label = QtWidgets.QLabel()
            self._concurrency_value_label.setMinimumWidth(96)

            def _refresh_label(val: int) -> None:
                self._concurrency_value_label.setText(
                    f"{int(val)} / {cpu_max} workers",
                )

            self._concurrency_slider.valueChanged.connect(_refresh_label)
            _refresh_label(default_workers)
            concurrency_h.addWidget(self._concurrency_slider, 1)
            concurrency_h.addWidget(self._concurrency_value_label)
            self._concurrency_slider.setEnabled(False)
            form.addRow("Workers after restart", concurrency_block)

            # Upload concurrency. Replaces the older slider with a
            # 1-or-2 button group: those are the only values worth
            # offering on the production cloud. The 120 req/min rate
            # limit means 1 worker uses ~half the budget and 2 uses
            # the full budget on a typical home connection; 3+ would
            # just produce 429 retries that settle at the same
            # throughput, so there's no reason to expose them in the
            # UI. Power users on a self-hosted API with a higher
            # rate limit can still override via the
            # ``SC2TOOLS_UPLOAD_CONCURRENCY`` env var.
            #
            # Click-to-apply: each button click immediately fires a
            # save (no need to click "Save settings") AND hot-swaps
            # the live upload queue's worker count via the runner's
            # save handler. Takes effect on the next batch the
            # agent issues, no restart required.
            from ..config import (  # local: keeps test imports cheap
                _DEFAULT_UPLOAD_CONCURRENCY,
                UPLOAD_CONCURRENCY_USEFUL_MAX,
                _DEFAULT_UPLOAD_BATCH_SIZE,
                UPLOAD_BATCH_SIZE_USEFUL_MAX,
            )
            upload_conc_block = QtWidgets.QWidget()
            upload_conc_h = QtWidgets.QHBoxLayout(upload_conc_block)
            upload_conc_h.setContentsMargins(0, 0, 0, 0)
            upload_conc_h.setSpacing(8)
            self._upload_conc_group = QtWidgets.QButtonGroup(self)
            self._upload_conc_group.setExclusive(True)
            self._upload_conc_buttons: dict[int, QtWidgets.QPushButton] = {}
            # Two buttons: 1 worker (safe) and 2 workers (max).
            # If we ever want to ship a higher option, add it here
            # — UPLOAD_CONCURRENCY_USEFUL_MAX is still 4 in
            # config.py, but we deliberately only expose 1/2 in
            # the UI because anything past 2 risks 429s on the
            # production rate limit. The state and env var both
            # accept higher; this is just a UI-side choice.
            # Inline stylesheet for the toggle buttons. Inline (per-
            # widget) instead of via the global QSS so the
            # ``:checked`` selector reliably highlights — depending
            # on QSS cascade order against the global QPushButton
            # styling has bitten us before. The colors mirror the
            # main-window's accent palette (``_ACCENT`` / ``_SUBTLE``)
            # so the toggle group looks native.
            _toggle_qss = (
                "QPushButton {"
                f" background: {theme.BUTTON};"
                f" color: {_TEXT_MUTED};"
                f" border: 1px solid {_BORDER_STRONG};"
                " border-radius: 6px;"
                " padding: 6px 14px;"
                " font-weight: 600;"
                "}"
                "QPushButton:hover {"
                f" background: {theme.BUTTON_HOVER};"
                f" color: {_TEXT};"
                "}"
                "QPushButton:checked {"
                f" background: {theme.BUTTON_CHECKED};"
                " color: white;"
                f" border-color: {_ACCENT};"
                "}"
                "QPushButton:checked:hover {"
                f" background: {theme.BUTTON_HOVER};"
                f" border-color: {_ACCENT_HOVER};"
                "}"
            )
            for n in (1, 2):
                btn = QtWidgets.QPushButton(f"{n}")
                btn.setCheckable(True)
                btn.setMinimumWidth(56)
                btn.setCursor(QtCore.Qt.PointingHandCursor)
                btn.setStyleSheet(_toggle_qss)
                btn.setToolTip(
                    f"Use {n} parallel upload "
                    f"worker{'' if n == 1 else 's'}. "
                    + (
                        "Conservative — uses ~half the cloud rate "
                        "limit budget."
                        if n == 1
                        else "Recommended — saturates the 120 req/min "
                             "rate limit without 429s on a typical "
                             "home connection."
                    )
                )
                self._upload_conc_group.addButton(btn, n)
                upload_conc_h.addWidget(btn)
                self._upload_conc_buttons[n] = btn
            # Default selection — overridden in _populate_settings if
            # state has an explicit override.
            initial_default = max(
                1, min(2, _DEFAULT_UPLOAD_CONCURRENCY),
            )
            self._upload_conc_buttons[initial_default].setChecked(True)
            # Track the last value we saved so a no-op click (user
            # clicks the already-selected button) skips the round-
            # trip through _on_save_settings.
            self._upload_conc_last_saved: int = initial_default
            upload_conc_h.addStretch(1)
            # Hint text trailing the buttons — explains the
            # rate-limit reasoning so the user knows why we don't
            # expose more options.
            upload_conc_hint = QtWidgets.QLabel(
                "More than 2 risks rate-limit retries. Click to "
                "apply instantly — no restart needed."
            )
            upload_conc_hint.setWordWrap(True)
            upload_conc_hint.setStyleSheet(
                f"color: {_TEXT_DIM}; font-size: 10pt;"
            )
            upload_conc_h.addWidget(upload_conc_hint, 2)
            form.addRow("Upload concurrency", upload_conc_block)

            # Auto-save handler. Connected via ``buttonClicked``
            # which fires for every click — including a re-click of
            # the already-selected button — so we de-dupe on the
            # ``_upload_conc_last_saved`` cache.
            def _on_upload_conc_clicked(btn: QtWidgets.QAbstractButton) -> None:
                if not btn.isChecked():
                    # Defensive: an exclusive group never reports
                    # the unchecked button via buttonClicked, but
                    # this guard makes the contract explicit.
                    return
                n = self._upload_conc_group.id(btn)
                if n == self._upload_conc_last_saved:
                    return
                self._upload_conc_last_saved = n
                payload = SettingsPayload(upload_concurrency=n)
                try:
                    ui._on_save_settings(payload)
                except Exception:  # noqa: BLE001
                    log.exception("upload_concurrency_save_failed")

            self._upload_conc_group.buttonClicked.connect(
                _on_upload_conc_clicked,
            )

            # Upload batch size. How many games we cram into a single
            # ``POST /v1/games``. Bigger batches = more throughput per
            # rate-limit-budget unit; capped at
            # ``UPLOAD_BATCH_SIZE_USEFUL_MAX`` (50) by the 5 MB body
            # limit on long-Zerg-game outliers.
            upload_batch_block = QtWidgets.QWidget()
            upload_batch_h = QtWidgets.QHBoxLayout(upload_batch_block)
            upload_batch_h.setContentsMargins(0, 0, 0, 0)
            upload_batch_h.setSpacing(10)
            self._upload_batch_slider = QtWidgets.QSlider(QtCore.Qt.Horizontal)
            self._upload_batch_slider.setRange(1, UPLOAD_BATCH_SIZE_USEFUL_MAX)
            self._upload_batch_slider.setValue(_DEFAULT_UPLOAD_BATCH_SIZE)
            self._upload_batch_slider.setTickPosition(
                QtWidgets.QSlider.TicksBelow,
            )
            # Sparser tick marks at 5-game intervals — 50 ticks would
            # turn into a comb on the slider track.
            self._upload_batch_slider.setTickInterval(5)
            self._upload_batch_slider.setToolTip(
                f"How many games to pack into one HTTP request. The "
                f"cloud accepts {UPLOAD_BATCH_SIZE_USEFUL_MAX}-game "
                f"batches up to 5 MB; long Zerg games with full "
                f"build_logs run ~150 KB each, so the default of "
                f"{_DEFAULT_UPLOAD_BATCH_SIZE} leaves margin for "
                f"outliers. Bigger batches × the 120 req/min rate "
                f"limit = more throughput. Applies to the next batch."
            )
            self._upload_batch_value_label = QtWidgets.QLabel()
            self._upload_batch_value_label.setMinimumWidth(96)

            def _refresh_upload_batch_label(val: int) -> None:
                self._upload_batch_value_label.setText(
                    f"{int(val)} games / req",
                )

            self._upload_batch_slider.valueChanged.connect(
                _refresh_upload_batch_label,
            )
            _refresh_upload_batch_label(_DEFAULT_UPLOAD_BATCH_SIZE)
            upload_batch_h.addWidget(self._upload_batch_slider, 1)
            upload_batch_h.addWidget(self._upload_batch_value_label)
            form.addRow("Upload batch size", upload_batch_block)

            # Date-range sync filter — mirrors the website's filter bar
            # (apps/web/lib/datePresets.ts). Restricts which replays the
            # watcher uploads. New users on PCs with thousands of
            # historical replays use this to scope the initial backfill
            # to "Current season" or "Custom range" so they don't grind
            # through years of old games to hydrate today's stats.
            from .. import sync_filter as sf  # local import keeps tests cheap

            filter_block = QtWidgets.QWidget()
            filter_v = QtWidgets.QVBoxLayout(filter_block)
            filter_v.setContentsMargins(0, 0, 0, 0)
            filter_v.setSpacing(6)

            self._filter_combo = QtWidgets.QComboBox()
            cur = sf.current_season()
            # Build the menu with the same vocabulary the website uses.
            # Per-season entries cover the last six seasons — beyond
            # that, "Custom range" is the right escape hatch.
            self._filter_combo.addItem("All time", "all")
            self._filter_combo.addItem(
                f"Current season (Season {cur})", "current_season",
            )
            for n in range(cur, max(cur - 6, 0), -1):
                self._filter_combo.addItem(f"Season {n}", f"season:{n}")
            self._filter_combo.addItem("Custom date range…", "custom")
            self._filter_combo.setToolTip(
                "Restrict which replays get uploaded. The watcher still "
                "watches every folder you've added — replays played "
                "outside the chosen window are skipped, not deleted. "
                "Existing cloud uploads are not removed when you change "
                "this setting; the agent runs a fresh sweep on save."
            )
            filter_v.addWidget(self._filter_combo)

            # Custom range row — visible only when "Custom" is picked.
            self._filter_custom_row = QtWidgets.QWidget()
            custom_h = QtWidgets.QHBoxLayout(self._filter_custom_row)
            custom_h.setContentsMargins(0, 0, 0, 0)
            custom_h.setSpacing(8)
            custom_h.addWidget(QtWidgets.QLabel("From"))
            self._filter_since = QtWidgets.QDateEdit()
            self._filter_since.setCalendarPopup(True)
            self._filter_since.setDisplayFormat("yyyy-MM-dd")
            self._filter_since.setDate(QtCore.QDate.currentDate().addMonths(-1))
            custom_h.addWidget(self._filter_since)
            custom_h.addWidget(QtWidgets.QLabel("to"))
            self._filter_until = QtWidgets.QDateEdit()
            self._filter_until.setCalendarPopup(True)
            self._filter_until.setDisplayFormat("yyyy-MM-dd")
            self._filter_until.setDate(QtCore.QDate.currentDate())
            custom_h.addWidget(self._filter_until)
            custom_h.addStretch(1)
            filter_v.addWidget(self._filter_custom_row)

            def _toggle_custom_visibility() -> None:
                is_custom = self._filter_combo.currentData() == "custom"
                self._filter_custom_row.setVisible(is_custom)

            self._filter_combo.currentIndexChanged.connect(
                lambda _idx: _toggle_custom_visibility(),
            )
            _toggle_custom_visibility()

            form.addRow(self._help_label("Sync date range", "desktop-app-sync-range"), filter_block)

            performance = QtWidgets.QWidget()
            performance_v = QtWidgets.QVBoxLayout(performance)
            performance_v.setContentsMargins(0,0,0,0)
            self._speed_combo = QtWidgets.QComboBox()
            for label, key in (("Gentle", "gentle"),("Balanced", "balanced"),("Maximum", "maximum")):
                self._speed_combo.addItem(label,key)
            mode = ui._initial_settings.background_import_speed or "balanced"
            self._speed_combo.setCurrentIndex(self._speed_combo.findData(mode))
            performance_v.addWidget(self._speed_combo)
            from ..game_activity import background_workers
            self._speed_combo.currentIndexChanged.connect(lambda _index:self._concurrency_slider.setValue(
                background_workers(self._speed_combo.currentData(),_PARSE_CONCURRENCY_USEFUL_MAX)))
            performance_hint = QtWidgets.QLabel("Background worker speed applies after restarting SC2 Tools.")
            performance_hint.setWordWrap(True)
            performance_v.addWidget(performance_hint)
            self._pause_history_check = QtWidgets.QCheckBox("Pause history import while I'm in a game")
            self._pause_history_check.setChecked(ui._initial_settings.pause_history_in_game is not False)
            self._battery_check = QtWidgets.QCheckBox("Pause on battery")
            self._battery_check.setChecked(ui._initial_settings.pause_on_battery is True)
            performance_v.addWidget(self._pause_history_check)
            performance_v.addWidget(self._battery_check)
            form.addRow(self._help_label("Performance", "desktop-app-performance"), performance)

            self._log_combo = QtWidgets.QComboBox()
            self._log_combo.addItems(["INFO", "DEBUG", "WARNING", "ERROR"])
            form.addRow("Log level", self._log_combo)

            # Replay folders: a real list, because StarCraft II writes
            # replays to a separate folder per (region, toon) — players
            # who use multiple regions or BattleTags need more than
            # one entry. Detected folders are always watched unless the
            # user removes them here; saving an empty list resets the
            # agent to detection alone.
            #
            # Unsaved removals, sent with Save so only folders the user
            # removed become exclusions (not ones that appeared later).
            self._folders_removed: List[str] = []
            # Set while the list has unsaved edits, so a folder the agent
            # starts watching meanwhile is appended, not a list rebuild.
            self._folders_dirty = False
            folder_block = QtWidgets.QWidget()
            folder_v = QtWidgets.QVBoxLayout(folder_block)
            folder_v.setContentsMargins(0, 0, 0, 0)
            folder_v.setSpacing(6)

            self._folder_list = QtWidgets.QListWidget()
            self._folder_list.setSelectionMode(
                QtWidgets.QAbstractItemView.ExtendedSelection,
            )
            self._folder_list.setUniformItemSizes(False)
            self._folder_list.setAlternatingRowColors(False)
            self._folder_list.setMinimumHeight(96)
            self._folder_list.setHorizontalScrollBarPolicy(
                QtCore.Qt.ScrollBarAsNeeded,
            )
            self._folder_list.setToolTip(
                "Each region and battle.net handle stores replays in a "
                "different folder. Add every Replays/Multiplayer folder "
                "you want synced.",
            )
            folder_v.addWidget(self._folder_list)
            from .folder_rows import build_folder_rows
            self._folder_rows = build_folder_rows(self._folder_list, QtCore=QtCore, QtGui=QtGui,
                                                  QtWidgets=QtWidgets, open_folder=_open_path_in_explorer)
            self._folder_delete = QtGui.QShortcut(QtGui.QKeySequence.Delete, self._folder_list)
            self._folder_delete.setContext(QtCore.Qt.WidgetWithChildrenShortcut)
            self._folder_delete.activated.connect(self._remove_folder_rows)
            self._folder_empty = QtWidgets.QWidget()
            empty_layout = QtWidgets.QVBoxLayout(self._folder_empty)
            empty_layout.addWidget(QtWidgets.QLabel("We couldn't find StarCraft II replays"))
            locate = QtWidgets.QPushButton("Locate folder…")
            locate.clicked.connect(self._click_choose_folder)
            empty_layout.addWidget(locate)
            folder_v.addWidget(self._folder_empty)
            self._folder_undo = QtWidgets.QPushButton("Undo folder change")
            self._folder_undo.clicked.connect(self._undo_folder_change)
            self._folder_undo.hide()
            folder_v.addWidget(self._folder_undo)

            folder_btns = QtWidgets.QHBoxLayout()
            folder_btns.setSpacing(6)
            add_btn = QtWidgets.QPushButton("Add folder…")
            add_btn.clicked.connect(self._add_folder_row)
            folder_btns.addWidget(add_btn)
            remove_btn = QtWidgets.QPushButton("Remove selected")
            remove_btn.setToolTip(
                "Stop watching the selected folders. A folder found "
                "automatically stays unwatched until Auto-detect or "
                "Add folder… brings it back.",
            )
            remove_btn.clicked.connect(self._remove_folder_rows)
            folder_btns.addWidget(remove_btn)
            auto_btn = QtWidgets.QPushButton("Auto-detect")
            auto_btn.setToolTip(
                "Scan your StarCraft II Accounts folder and add every "
                "Replays/Multiplayer directory found. Existing entries "
                "are preserved; only missing folders are appended.",
            )
            auto_btn.clicked.connect(self._auto_detect_folders)
            folder_btns.addWidget(auto_btn)
            folder_btns.addStretch(1)
            folder_v.addLayout(folder_btns)

            form.addRow(self._help_label("Replay folders", "replay-folders"), folder_block)

            from .. import autostart as autostart_mod  # local import keeps import-time safe

            self._autostart_check = QtWidgets.QCheckBox(
                "Run SC2 Tools Agent on Windows startup",
            )
            self._autostart_check.setEnabled(autostart_mod.is_supported())
            if not autostart_mod.is_supported():
                self._autostart_check.setToolTip(
                    "Only available on Windows. On macOS/Linux configure "
                    "your session manager to launch the agent at login.",
                )
            form.addRow("", self._autostart_check)

            self._minimized_check = QtWidgets.QCheckBox(
                "Start minimised to the system tray",
            )
            form.addRow("", self._minimized_check)

            self._game_notifications_check = QtWidgets.QCheckBox("Notify me after every new game syncs")
            self._game_notifications_check.setToolTip("Shows the result, opponent and map on this PC. Replay-history imports stay quiet.")
            form.addRow("", self._game_notifications_check)

            # Auto-update consent — the state flag shipped in 0.13.4's
            # updater hardening but had no UI surface, so the only way
            # to opt out was hand-editing agent.json. Unchecking turns
            # the updater notify-only (the badge + notice still appear;
            # nothing installs behind the user's back).
            self._autoupdate_check = QtWidgets.QCheckBox(
                "Install agent updates automatically (recommended)",
            )
            self._autoupdate_check.setToolTip(
                "When enabled, new releases download and install "
                "silently and the agent restarts minimised. When "
                "disabled, the agent only notifies — except below the "
                "cloud's minimum supported version, where the update "
                "is required to keep working.",
            )
            form.addRow("", self._autoupdate_check)

            capture_block = QtWidgets.QWidget()
            capture_v = QtWidgets.QVBoxLayout(capture_block)
            capture_v.setContentsMargins(0, 0, 0, 0)
            capture_v.setSpacing(6)
            self._replay_capture_check = QtWidgets.QCheckBox(
                "Automatically capture map replays (uses more CPU)",
            )
            capture_v.addWidget(self._replay_capture_check)
            capture_help = QtWidgets.QLabel(
                "Automatically records detailed movement, attacks, spells and creep "
                "for new and re-synced replays. Uses StarCraft II in the background "
                "and substantial CPU for several minutes per replay. Saved recordings "
                "are reused. For games already synced, use Re-sync once. When off, "
                "Generate accurate playback on the website records one replay. "
                "This switch applies immediately."
            )
            capture_help.setObjectName("muted")
            capture_help.setWordWrap(True)
            capture_v.addWidget(capture_help)
            form.addRow("Map replay", capture_block)

            v.addWidget(form_card)
            from .build_checkin_settings import CheckinSettingsGroup

            # Applies immediately (cloud preference), like the toggles above.
            self._checkin_settings = CheckinSettingsGroup(
                controller=ui._build_checkin_controller,
                available=ui._build_checkin_available,
                on_help=lambda: self._open_help("build-check-in"),
                on_preview=lambda kind: self._checkin_host.show_preview(kind),
                on_reset_positions=lambda: self._checkin_host.reset_positions(),
                on_open_queue=lambda: self._open_checkin_queue(),
            )
            v.addWidget(self._checkin_settings)
            v.addWidget(self._build_obs_card())

            row = QtWidgets.QHBoxLayout()
            row.addStretch(1)
            self._settings_status = QtWidgets.QLabel("")
            self._settings_status.setObjectName("muted")
            row.addWidget(self._settings_status)
            self._settings_page = page
            save_btn = self._save_settings_btn = QtWidgets.QPushButton("Save settings")
            save_btn.setObjectName("primary")
            save_btn.clicked.connect(self._click_save_settings)
            row.addWidget(save_btn)
            v.addLayout(row)

            maintenance = QtWidgets.QGroupBox("Maintenance")
            maintenance_layout = QtWidgets.QVBoxLayout(maintenance)
            warning = QtWidgets.QLabel("Re-sync rebuilds your local upload cursor and revisits your replay library.")
            warning.setWordWrap(True)
            maintenance_layout.addWidget(warning)
            self._resync_btn.setText("Re-sync replay library…")
            self._resync_btn.setObjectName("dangerButton")
            maintenance_layout.addWidget(self._resync_btn)
            v.addWidget(maintenance)
            v.addStretch(1)
            scroller.setWidget(page)
            from .qt_helpers import install_responsive_forms
            self._settings_responsive_forms = install_responsive_forms(scroller, QtCore=QtCore, QtWidgets=QtWidgets)
            return scroller

        def _populate_obs_settings(self, initial) -> None:
            """Seed the OBS card from saved state.

            Scene dropdowns start with only the saved values in them —
            we have not talked to OBS yet at this point, and blocking
            boot on a connect to a program that may not be running
            would be a bad trade. "Test connection" fills in the real
            list.
            """
            self._obs_sources = {"webcam": [], "game": []}
            self._obs_manual_update_scenes = []
            self._obs_needs_manual_update = False
            self._obs_enable_check.setChecked(
                bool(initial.obs_scene_switch_enabled),
            )
            if initial.obs_host:
                self._obs_host_input.setText(str(initial.obs_host))
            if initial.obs_port:
                self._obs_port_input.setValue(int(initial.obs_port))
            if initial.obs_password:
                self._obs_password_input.setText(str(initial.obs_password))
            if initial.obs_switch_debounce_sec is not None:
                self._obs_debounce_spin.setValue(
                    float(initial.obs_switch_debounce_sec),
                )
            self._obs_website_add_check.setChecked(getattr(initial, "obs_website_add_enabled", False) is True)
            self._obs_replay_check.setChecked(
                bool(initial.obs_switch_on_replays),
            )
            saved = dict(initial.obs_scene_map or {})
            if not any(saved.values()):
                # Nothing configured yet (fresh install, or a map of
                # six blanks from an earlier Save). The switcher runs
                # the default map in that case, so show the defaults —
                # a panel full of "don't switch" here both lied about
                # what would happen and, once saved, made it true by
                # persisting the blanks over the defaults.
                saved = dict(_OBS_DEFAULT_SCENE_MAP)
            for phase, combo in self._obs_scene_combos.items():
                name = saved.get(phase) or ""
                if not name:
                    combo.setCurrentIndex(0)
                    continue
                idx = combo.findData(name)
                if idx < 0:
                    combo.addItem(name, name)
                    idx = combo.count() - 1
                combo.setCurrentIndex(idx)

        # ---- OBS scene switching ----

        #: Phase ids the switcher understands, paired with the wording
        #: a streamer actually thinks in. Order is the order a match
        #: goes through, so the panel reads top-to-bottom like a game.
        OBS_PHASE_ROWS = (
            ("menu", "In the menu / queueing"),
            ("match_loading", "Match loading"),
            ("match_started", "Match started"),
            ("match_in_progress", "Match in progress"),
            ("match_ended", "Match ended (score screen)"),
            ("idle", "StarCraft II closed"),
        )

        #: Placeholder for "leave the scene alone for this phase".
        OBS_NO_SWITCH = "— don't switch —"

        def _build_obs_card(self) -> "QtWidgets.QWidget":
            """Settings card for automatic OBS scene switching.

            Scene names come from a dropdown populated by a real
            ``GetSceneList`` rather than a free-text field: a typo'd
            scene name is the single most predictable way for this
            feature to silently do nothing.
            """
            card = QtWidgets.QFrame()
            card.setObjectName("card")
            self._obs_card = card
            outer = QtWidgets.QVBoxLayout(card)
            outer.setContentsMargins(20, 18, 20, 18)
            outer.setSpacing(12)

            heading = QtWidgets.QLabel("OBS scene switching")
            heading.setObjectName("h2")
            heading_row = QtWidgets.QHBoxLayout()
            heading_row.addWidget(heading)
            heading_row.addWidget(help_button(QtWidgets, "OBS scene switching", lambda: self._open_help("obs-auto-scene-switching")))
            heading_row.addStretch(1)
            outer.addLayout(heading_row)

            blurb = QtWidgets.QLabel(
                "Switch OBS scenes automatically when a game starts and "
                "ends. Automatic switching only changes which scene is live. "
                "Scene contents change only when you explicitly build, update, "
                "or replace the two SC2 Tools scenes."
            )
            blurb.setObjectName("muted")
            blurb.setWordWrap(True)
            outer.addWidget(blurb)

            self._obs_enable_check = QtWidgets.QCheckBox(
                "Switch scenes automatically while I play",
            )
            self._obs_enable_check.setToolTip(
                "Requires obs-websocket, which ships with OBS 28 and "
                "later: OBS → Tools → WebSocket Server Settings → "
                "Enable WebSocket server. This switch applies immediately.",
            )
            outer.addWidget(self._obs_enable_check)

            conn = QtWidgets.QFormLayout()
            conn.setRowWrapPolicy(QtWidgets.QFormLayout.WrapLongRows)
            conn.setHorizontalSpacing(20)
            conn.setVerticalSpacing(10)
            conn.setLabelAlignment(
                QtCore.Qt.AlignRight | QtCore.Qt.AlignVCenter,
            )

            self._obs_host_input = QtWidgets.QLineEdit()
            self._obs_host_input.setPlaceholderText("127.0.0.1")
            self._obs_host_input.setToolTip(
                "Leave as 127.0.0.1 when OBS runs on this PC. For a "
                "two-PC setup, enter the stream PC's LAN address and "
                "allow the port through its firewall.",
            )
            conn.addRow("OBS host", self._obs_host_input)

            port_block = QtWidgets.QWidget()
            port_v = QtWidgets.QVBoxLayout(port_block)
            port_v.setContentsMargins(0, 0, 0, 0)
            port_v.setSpacing(6)
            self._obs_port_input = ObsPortSpinBox()
            self._obs_port_input.setRange(1, 65535)
            self._obs_port_input.setValue(4455)
            self._obs_port_input.setToolTip(
                "obs-websocket v5 listens on 4455 by default. The old "
                "v4 plugin's 4444 is not supported.",
            )
            port_v.addWidget(self._obs_port_input)
            port_help = QtWidgets.QLabel(
                "Default: 4455. Match OBS → Tools → WebSocket Server Settings."
            )
            port_help.setObjectName("muted")
            port_help.setWordWrap(True)
            port_v.addWidget(port_help)
            conn.addRow("Port", port_block)

            self._obs_password_input = QtWidgets.QLineEdit()
            self._obs_password_input.setEchoMode(QtWidgets.QLineEdit.Password)
            self._obs_password_input.setPlaceholderText(
                "from OBS → Tools → WebSocket Server Settings",
            )
            conn.addRow("Password", self._obs_password_input)
            outer.addLayout(conn)

            btns = QtWidgets.QHBoxLayout()
            btns.setSpacing(6)
            self._obs_test_btn = QtWidgets.QPushButton("Test connection")
            self._obs_test_btn.clicked.connect(self._click_obs_test)
            btns.addWidget(self._obs_test_btn)
            self._obs_build_btn = QtWidgets.QPushButton("Build my scenes…")
            self._obs_build_btn.setToolTip(
                "Create a Between Games scene (big camera, chat column, "
                "small game inset, SC2 backdrop) and an In Game scene "
                "from the sources you already have. Both get a topmost "
                "Stream Dock cover so Starting Soon and BRB override "
                "automatic switches. Existing generated scenes can be "
                "updated without resetting their layout or added sources.",
            )
            self._obs_build_btn.setEnabled(False)
            self._obs_build_btn.clicked.connect(self._click_obs_build)
            btns.addWidget(self._obs_build_btn)
            btns.addStretch(1)
            self._obs_status = QtWidgets.QLabel("")
            self._obs_status.setObjectName("muted")
            self._obs_status.setWordWrap(True)
            btns.addWidget(self._obs_status)
            outer.addLayout(btns)

            self._obs_website_add_check = QtWidgets.QCheckBox("Allow website requests to add an OBS source")
            self._obs_website_add_check.setToolTip("Off by default. Only this paired account can request a source. Every request still needs your local confirmation.")
            outer.addWidget(self._obs_website_add_check)
            website_note = QtWidgets.QLabel("Off by default. Every request asks for confirmation here before adding a source to the current program scene.")
            website_note.setWordWrap(True)
            website_note.setObjectName("muted")
            outer.addWidget(website_note)

            scenes_form = QtWidgets.QFormLayout()
            scenes_form.setRowWrapPolicy(QtWidgets.QFormLayout.WrapLongRows)
            scenes_form.setHorizontalSpacing(20)
            scenes_form.setVerticalSpacing(8)
            scenes_form.setLabelAlignment(
                QtCore.Qt.AlignRight | QtCore.Qt.AlignVCenter,
            )
            self._obs_scene_combos = {}
            for phase, label in self.OBS_PHASE_ROWS:
                combo = QtWidgets.QComboBox()
                combo.setEditable(False)
                combo.addItem(self.OBS_NO_SWITCH, "")
                self._obs_scene_combos[phase] = combo
                scenes_form.addRow(label, combo)
            outer.addLayout(scenes_form)

            hint = QtWidgets.QLabel(
                "Every row is optional. Leaving one on "
                f"\u201c{self.OBS_NO_SWITCH}\u201d means the scene stays "
                "put for that phase — set just two if that's all you want. "
                "\u201cMatch ended\u201d deliberately holds the gameplay "
                "scene so viewers see the score screen."
            )
            hint.setObjectName("muted")
            hint.setWordWrap(True)
            outer.addWidget(hint)

            self._obs_replay_check = QtWidgets.QCheckBox(
                "Also switch when I watch a replay",
            )
            self._obs_replay_check.setToolTip(
                "Off by default. Replay playback reports the same "
                "phases a real match does, so leaving this off keeps "
                "reviewing games from flipping your scenes.",
            )
            outer.addWidget(self._obs_replay_check)

            delay_row = QtWidgets.QHBoxLayout()
            delay_row.setSpacing(8)
            delay_label = QtWidgets.QLabel("Wait before leaving a match")
            delay_row.addWidget(delay_label)
            self._obs_debounce_spin = QtWidgets.QDoubleSpinBox()
            self._obs_debounce_spin.setRange(0.0, 30.0)
            self._obs_debounce_spin.setSingleStep(0.5)
            self._obs_debounce_spin.setSuffix(" s")
            self._obs_debounce_spin.setValue(3.0)
            self._obs_debounce_spin.setToolTip(
                "How long the agent waits before switching away from "
                "the gameplay scene. Stops a dropped poll or an "
                "alt-tab from yanking your layout mid-game. Entering a "
                "match is never delayed.",
            )
            delay_row.addWidget(self._obs_debounce_spin)
            delay_row.addStretch(1)
            outer.addLayout(delay_row)

            return card

        def _obs_conn_fields(self) -> tuple:
            return (
                self._obs_host_input.text().strip() or "127.0.0.1",
                int(self._obs_port_input.value()),
                self._obs_password_input.text(),
            )

        def _run_obs_job(self, kind: str, fn) -> None:
            """Run a blocking OBS round-trip off the GUI thread.

            A connect attempt can sit for several seconds; doing it
            inline would freeze the window and look like a crash.
            """
            self._obs_test_btn.setEnabled(False)
            self._obs_build_btn.setEnabled(False)

            def _worker() -> None:
                try:
                    result = fn()
                except Exception as exc:  # noqa: BLE001
                    result = {"ok": False, "message": str(exc)}
                result = dict(result or {})
                result["kind"] = kind
                signals.obsProbeDone.emit(result)

            threading.Thread(
                target=_worker, name=f"sc2tools-obs-{kind}", daemon=True,
            ).start()

        def _click_obs_test(self) -> None:
            if ui._on_obs_probe is None:
                self._obs_status.setText(
                    "OBS support unavailable in this build.",
                )
                return
            host, port, password = self._obs_conn_fields()
            self._obs_status.setText("Connecting…")
            self._run_obs_job(
                "probe", lambda: ui._on_obs_probe(host, port, password),
            )

        def _click_obs_build(self) -> None:
            if ui._on_obs_build is None:
                return
            webcam = self._obs_sources.get("webcam", [])
            game = self._obs_sources.get("game", [])
            host, port, password = self._obs_conn_fields()

            confirm = _ObsBuildDialog(
                parent=self,
                QtWidgets=QtWidgets,
                webcams=webcam,
                games=game,
                update_existing=self._obs_needs_manual_update,
            )
            if not confirm.exec():
                return
            request = {
                "host": host,
                "port": port,
                "password": password,
                "webcam_source": confirm.webcam(),
                "game_source": confirm.game(),
                "rebuild": confirm.rebuild(),
                "during_game_widgets": confirm.during_game_widgets(),
                "show_overlay_credit": confirm.show_overlay_credit(),
                # Carry the exact names shown by Test connection so the
                # backend never infers permission to edit an existing scene.
                "update_existing_scenes": list(
                    self._obs_manual_update_scenes
                ),
            }
            self._obs_status.setText(
                "Updating scenes…"
                if self._obs_needs_manual_update
                else "Building scenes…"
            )
            self._run_obs_job("build", lambda: ui._on_obs_build(request))

        def _on_obs_probe_done(self, result: dict) -> None:
            self._obs_test_btn.setEnabled(True)
            ok = bool(result.get("ok"))
            self._obs_status.setText(str(result.get("message") or ""))
            if not ok:
                self._obs_build_btn.setEnabled(False)
                return
            self._obs_build_btn.setEnabled(ui._on_obs_build is not None)
            if result.get("kind") == "probe":
                self._obs_manual_update_scenes = [
                    str(name) for name in (
                        result.get("generated_update_scenes", result.get("manual_override_update_scenes")) or []
                    )
                ]
                self._obs_needs_manual_update = bool(
                    self._obs_manual_update_scenes
                )
            elif result.get("kind") == "build":
                self._obs_manual_update_scenes = []
                self._obs_needs_manual_update = False
            self._obs_build_btn.setText(
                "Update my scenes…"
                if self._obs_needs_manual_update
                else "Build my scenes…"
            )
            # Build/Update responses intentionally contain no source scan.
            # Keep the choices from the last successful probe so a second
            # build or explicit replacement does not lose camera/game inputs.
            if result.get("kind") == "probe":
                self._obs_sources = {
                    "webcam": list(result.get("webcams") or []),
                    "game": list(result.get("games") or []),
                }
            scenes = [str(x) for x in (result.get("scenes") or [])]
            if scenes:
                self._repopulate_obs_scene_combos(scenes)
            if result.get("kind") == "build":
                # The user just built the two layouts; wire the still-
                # blank rows to them so the natural next click — Save —
                # produces a working switcher. Leaving this manual was
                # a trap: Save with untouched dropdowns persisted six
                # blanks, which disabled switching entirely.
                self._autofill_obs_scene_combos()

        def _autofill_obs_scene_combos(self) -> None:
            """Point unset rows at the freshly built scenes.

            Only rows still on "don't switch" are touched — a row the
            user already mapped is their choice, build or no build —
            and only when the target scene really exists in the
            dropdown's just-refreshed list.
            """
            for phase, combo in self._obs_scene_combos.items():
                if combo.currentData():
                    continue
                name = _OBS_DEFAULT_SCENE_MAP.get(phase) or ""
                if not name:
                    continue
                idx = combo.findData(name)
                if idx >= 0:
                    combo.setCurrentIndex(idx)

        def _repopulate_obs_scene_combos(self, scenes: list) -> None:
            """Refresh the dropdowns from the live scene list, keeping
            whatever the user had selected if it still exists."""
            for combo in self._obs_scene_combos.values():
                previous = combo.currentData()
                combo.blockSignals(True)
                combo.clear()
                combo.addItem(self.OBS_NO_SWITCH, "")
                for name in scenes:
                    combo.addItem(name, name)
                if previous:
                    idx = combo.findData(previous)
                    # A scene that vanished from OBS keeps its saved
                    # value rather than silently resetting to "don't
                    # switch" — the user renamed something and should
                    # see that, not lose their configuration.
                    if idx < 0:
                        combo.addItem(f"{previous} (missing)", previous)
                        idx = combo.count() - 1
                    combo.setCurrentIndex(idx)
                combo.blockSignals(False)

        def _obs_scene_map_from_form(self) -> dict:
            return {
                phase: (combo.currentData() or "")
                for phase, combo in self._obs_scene_combos.items()
            }

        # ---- signal wiring ----

        def _wire_signals(self) -> None:
            signals.phaseChanged.connect(self._on_phase)
            signals.analyzerProbe.connect(self._on_analyzer_probe)
            signals.healthChanged.connect(self._paint_health)
            signals.pauseChanged.connect(self._on_paused)
            signals.transientNotice.connect(self._show_transient_notice)
            signals.updateState.connect(self._on_update_state)
            signals.releaseNotes.connect(self._on_release_notes)
            signals.siteNotice.connect(self._site_notice_card.apply)
            signals.chooseFolderRequested.connect(self._click_choose_folder)
            signals.resyncRequested.connect(self._click_archive_resync)
            signals.checkUpdatesRequested.connect(self._click_check_updates)
            signals.pairingState.connect(self._on_pairing_state)
            signals.unlinked.connect(self._on_unlinked)
            signals.connectionState.connect(self._on_connection_state)
            signals.pairingCode.connect(self._on_pairing_code)
            signals.paired.connect(self._on_paired)
            signals.status.connect(self._on_status)
            signals.uploadSuccess.connect(self._on_upload_success)
            signals.gameSynced.connect(self._on_game_synced)
            signals.recentSnapshot.connect(self._on_recent_snapshot)
            signals.importProgress.connect(self._on_import_progress)
            signals.uploadFailed.connect(self._on_upload_failed)
            signals.pendingChanged.connect(self._on_pending_changed)
            signals.updateAvailable.connect(self._on_update_available)
            signals.updateNotice.connect(self._on_update_notice)
            signals.updateCheckDone.connect(self._on_update_check_done)
            signals.replayArchiveStatus.connect(
                self._on_replay_archive_status,
            )
            signals.foldersChanged.connect(self._on_folders_changed)
            signals.settingsStatus.connect(self._on_settings_status)
            signals.settingsSaveDone.connect(self._on_settings_save_done)
            signals.obsProbeDone.connect(self._on_obs_probe_done)
            from .obs_confirmation import show_obs_confirmation
            signals.obsAddConfirmation.connect(lambda request: show_obs_confirmation(request, parent=self, QtCore=QtCore, QtWidgets=QtWidgets))
            signals.buildCheckin.connect(self._on_build_checkin)
            signals.quitRequested.connect(self._on_quit_requested)
            signals.showRequested.connect(self._on_show_requested)

        # ---- signal handlers (always on the GUI thread) ----

        def _toggle_assistance(self) -> None:
            page = self._companion_page
            page.set_preference("overlaysEnabled", not page._preferences["overlaysEnabled"])

        def _set_assistance_hotkey(self, enabled: bool) -> None:
            self._companion_page.set_hotkey_status(self._assistance_hotkey.set_enabled(enabled))

        def _on_build_checkin(self, method: str, args: object) -> None:
            self._checkin_host.dispatch(method, args)
            self._companion_page.dispatch_build_checkin(method, args)

        def _on_pairing_state(self, state):
            self._pairing_card.apply(state)

        def _on_unlinked(self):
            self._paired = False
            self._user_id = None
            self._on_recent_snapshot({"owner": None, "rows": [], "facts": {}, "today": {}, "skipped": []})
            self._pairing_card.apply("unlinked")
            self._refresh_controls()
            self._go_to_page("dashboard")

        def _on_pairing_code(self, code: str) -> None:
            self._paired = False
            self._status = f"Awaiting pairing — code {code}"
            self._pairing_code_label.setText(code)
            self._refresh_pairing_card()
            self._refresh_controls()
            # Bring window forward so the user actually sees the code.
            if not self.isVisible():
                self.showNormal()
                self.raise_()

        def _on_paired(self, user_id: str) -> None:
            was_paired = self._paired
            self._paired = True
            self._user_id = user_id
            self._status = "paired"
            self._pairing_card.apply("paired")
            self._refresh_controls()
            if not was_paired:
                self._go_to_page(self._preferred_paired_page())
            self._companion_page.refresh()

        def _on_status(self, status: str) -> None:
            self._status = status

        def _query_synced_count(self, default: int) -> int:
            """Read the authoritative synced total from the provider.

            The upload queue writes ``state.uploaded`` BEFORE invoking
            the success callback, so re-querying here always includes
            the upload that triggered the signal. Falls back to
            ``default`` (the legacy increment) when no provider is
            wired or the read fails."""
            provider = ui._synced_count_provider
            if provider is None:
                return default
            try:
                return int(provider())
            except Exception:  # noqa: BLE001
                return default

        def _on_upload_success(self, filename: str) -> None:
            self._uploaded_count += 1
            # Pending count comes from the queue's authoritative callback.
            self._last_upload = (filename, datetime.now())
            self._recent.appendleft(
                (datetime.now(), filename, True, "Uploaded"),
            )
            if not ui._recent_games_enabled:
                self._paint_stats()
            self._request_stats_refresh()
            if not ui._recent_games_enabled:
                self._insert_recent(self._recent[0])

        def _on_upload_failed(self, filename: str, reason: str) -> None:
            self._recent.appendleft(
                (datetime.now(), filename, False, reason or "Failed"),
            )
            if not ui._recent_games_enabled:
                self._insert_recent(self._recent[0])

        def _on_pending_changed(self, count: int) -> None:
            self._pending_count = int(count)
            if not ui._recent_games_enabled:
                self._paint_stats()
            self._request_stats_refresh()

        def _on_game_synced(self, path, summary):
            if self._paired and summary.get("_owner", self._user_id) == self._user_id:
                self._recent_widget.append({**summary, "path": path, "status": "uploaded",
                                            "updatedAt": datetime.now().astimezone().isoformat()})
                self._request_stats_refresh()

        def _on_recent_snapshot(self, snapshot):
            if snapshot.get("owner") != self._user_id or not self._paired:
                snapshot = {"rows": [], "facts": {}, "today": {}, "skipped": []}
            self._history_facts = snapshot.get("facts", {})
            self._recent_widget.set_rows(snapshot.get("rows", []), snapshot.get("skipped", []))
            self._game_dashboard.set_snapshot(snapshot)
            self._request_stats_refresh()

        def _on_import_progress(self, snapshot):
            self._import_progress = snapshot
            self._request_stats_refresh()

        def _show_recent_problems(self):
            self._go_to_page("recent")
            self._recent_widget.set_filter("problem")

        def _open_recent_game(self, identifier):
            from urllib.parse import quote
            if isinstance(identifier, str) and identifier:
                webbrowser.open(site_url(ui._dashboard_url, "/app/game/" + quote(identifier, safe="")), new=2)

        def _show_recent_file(self, path):
            if not path:
                return
            target = Path(path)
            if not target.is_file():
                self._show_transient_notice("This replay file is no longer on this PC.")
            elif sys.platform == "win32":
                subprocess.Popen(["explorer.exe", "/select," + str(target.resolve())])
            else:
                QtGui.QDesktopServices.openUrl(QtCore.QUrl.fromLocalFile(str(target.resolve().parent)))

        def _on_release_notes(self, notes):
            self._release_notes = notes
            self._whats_new_btn.setVisible(bool(notes))

        def _show_release_notes(self):
            dialog=QtWidgets.QDialog(self)
            dialog.setWindowTitle("What's new in SC2 Tools")
            dialog.resize(600,450)
            layout=QtWidgets.QVBoxLayout(dialog)
            browser=QtWidgets.QTextBrowser()
            browser.setOpenExternalLinks(True)
            browser.setMarkdown(self._release_notes or "Release notes aren't available yet.")
            layout.addWidget(browser)
            close=QtWidgets.QDialogButtonBox(QtWidgets.QDialogButtonBox.Close)
            close.rejected.connect(dialog.reject)
            layout.addWidget(close)
            dialog.exec()

        def _run_update_action(self, callback):
            threading.Thread(target=callback, name="sc2tools-update-action", daemon=True).start()

        def _on_update_state(self, release, state, detail):
            self._update_card.apply(release,state,detail)

        def _on_update_available(self, latest: str) -> None:
            self._update_pending = latest
            self._update_badge.setText(f"Update available: v{latest}")
            self._update_badge.show()

        def _on_update_notice(self, message: str, sticky: bool) -> None:
            self._set_update_notice(message, sticky=sticky)

        def _on_update_check_done(self, message: str) -> None:
            self._updates_btn.setEnabled(True)
            self._updates_btn.setText("Updates")
            self._check_updates_action.setEnabled(True)
            # Empty message = an update was found and the runner's
            # handler owns the (sticky) notice — leave it alone.
            if message:
                self._show_transient_notice(message)

        def _on_replay_archive_status(
            self,
            missing_games: int,
            total_games: int,
        ) -> None:
            if missing_games <= 0 or total_games <= 0:
                self._replay_archive_card.hide()
                return
            progress = (
                f"One of your {total_games:,} saved games still needs"
                if missing_games == 1
                else (
                    f"{missing_games:,} of your {total_games:,} saved games "
                    "still need"
                )
            )
            self._replay_archive_text.setText(
                f"{progress} the original file archived. Run one full "
                "Re-sync with "
                "this latest agent. Files no longer on this PC will remain "
                "unavailable.",
            )
            self._replay_archive_button.setText("Re-sync replay library")
            self._replay_archive_button.setEnabled(True)
            self._replay_archive_card.show()

        def _on_folders_changed(self, folders: List[str]) -> None:
            self._folder_generation += 1
            folders=[raw for raw in folders if str(raw) not in self._folder_removed_instant]
            ui._replay_folders = [Path(p) for p in folders]
            missing = [str(path) for path in ui._initial_settings.replay_folders or [] if not Path(path).exists() and str(path) not in self._folder_removed_instant]
            folders=list(dict.fromkeys([*folders,*missing]))
            if self._folders_dirty:
                # Keep the user's unsaved edits; only add what is new.
                shown = {
                    self._folder_list.item(i).text()
                    for i in range(self._folder_list.count())
                }
                for raw in folders:
                    if raw not in shown and raw not in self._folders_removed:
                        self._folder_list.addItem(raw)
            else:
                self._sync_folder_list_widget(folders)
            # Same snapshot, fresh folder paths on the folders row's hover.
            self._health_view.apply(self._health_view.snapshot)

        def _on_settings_status(self, status: str) -> None:
            """Render the runner's post-Save toast in the Settings tab.
            The status card's filter row arrives with the next health
            snapshot, which the same Save pushes."""
            self._save_ack = True
            self._show_settings_toast(status + self._settings_restart_notice, "success")

        def _sync_folder_list_widget(self, folders: List[str]) -> None:
            """Mirror the canonical folder list into the Settings list
            widget without disturbing the user's selection state."""
            current = [
                self._folder_list.item(i).text()
                for i in range(self._folder_list.count())
            ]
            if current == list(folders):
                self._folder_rows.render()
                self._folder_empty.setVisible(not current)
                self._folder_list.setVisible(bool(current))
                return
            self._folder_list.clear()
            for raw in folders:
                self._folder_list.addItem(raw)
            self._folder_rows.render()
            self._folder_empty.setVisible(not folders)
            self._folder_list.setVisible(bool(folders))

        def _on_quit_requested(self) -> None:
            self._really_quit = True
            self._checkin_host.close()
            QtWidgets.QApplication.instance().quit()

        def _prepare_explicit_open(self) -> None:
            if self._compact_window_active():
                self._set_window_size("Standard")

        def _on_show_requested(self) -> None:
            self._prepare_explicit_open()
            self.showNormal()
            self.raise_()
            self.activateWindow()

        # ---- click handlers ----

        def _retry_recent(self, paths, reason):
            def retry():
                try:
                    ui._on_recent_retry(paths, reason)
                except Exception:
                    ui.show_transient_notice("Could not retry these files. Check the Activity log and try again.")
            threading.Thread(target=retry, name="sc2tools-recent-retry", daemon=False).start()

        def _import_current_season(self):
            if self._settings_save_pending:
                self._show_transient_notice("Wait for the settings save to finish, then try again.")
                return
            context = dict(api_base=self._saved_api_base, preset="current_season", since_iso=None,
                           until_iso=None, removals=self._folders_removed, dirty=self._folders_dirty,
                           externalFilter=True)
            self._settings_save_pending = True
            self._settings_page.setEnabled(False)
            self._game_dashboard.season.setEnabled(False)
            self._refresh_controls()
            def persist():
                error = None
                try:
                    ui._on_import_current_season()
                except Exception:
                    error = "Could not apply the season filter. Try again in Settings."
                signals.settingsSaveDone.emit(context, error)
            threading.Thread(target=persist, name="sc2tools-import-season", daemon=False).start()

        def _click_pause(self) -> None:
            if self._settings_save_pending:
                self._show_transient_notice("Wait for the settings save to finish, then try again.")
                return
            self._paused = not self._paused
            self._pause_btn.setText(
                "Resume syncing" if self._paused else "Pause syncing",
            )
            try:
                ui._on_pause(self._paused)
            except Exception:  # noqa: BLE001
                log.exception("gui_pause_callback_failed")

        def _click_resync(self) -> None:
            self._click_archive_resync()

        def _click_archive_resync(self) -> None:
            if self._settings_save_pending:
                self._show_transient_notice("Wait for the settings save to finish, then try again.")
                return
            if self._paused:
                QtWidgets.QMessageBox.information(
                    self,
                    "Resume syncing first",
                    "Replay-library Re-sync cannot start while syncing is "
                    "paused. Click Resume syncing, then click Re-sync replay "
                    "library again.",
                )
                return
            filter_block = _replay_archive_filter_block_message(
                self._active_filter_label,
            )
            if filter_block:
                settings_button = self._nav_group.button(3)
                if settings_button is not None:
                    settings_button.setChecked(True)
                self._go_to_page("settings")
                QtWidgets.QMessageBox.information(
                    self,
                    "Select All time first",
                    filter_block,
                )
                return
            if not self._confirm_and_request_resync():
                return
            self._replay_archive_text.setText(
                "Full Re-sync started. Replay analysis continues first while "
                "private original-file backups drain safely in the "
                "background. If the agent restarts, unfinished backups "
                "resume automatically.",
            )
            self._replay_archive_button.setText("Re-sync started")
            self._replay_archive_button.setEnabled(False)

        def _confirm_and_request_resync(self) -> bool:
            confirm = QtWidgets.QMessageBox.question(
                self,
                "Re-sync from scratch?",
                "This clears the local upload cursor and re-uploads every "
                "replay file still on this PC. Existing games are matched "
                "by game ID instead of duplicated, and their original replay "
                "files are archived privately for download. Unfinished "
                "backups resume automatically after an agent restart. This "
                "can take a while if you have hundreds or thousands of "
                "replays.\n\n"
                "Proceed?",
                QtWidgets.QMessageBox.Yes | QtWidgets.QMessageBox.No,
                QtWidgets.QMessageBox.No,
            )
            if confirm != QtWidgets.QMessageBox.Yes:
                return False
            try:
                ui._on_resync()
            except Exception:  # noqa: BLE001
                log.exception("gui_resync_failed")
                return False
            return True

        def _click_choose_folder(self) -> None:
            if self._settings_save_pending:
                self._show_transient_notice("Wait for the settings save to finish, then try again.")
                return
            from .folder_rows import confirm_empty_folder
            while True:
                picked = QtWidgets.QFileDialog.getExistingDirectory(
                    self, "Choose your StarCraft II Replays folder",
                    str(ui._replay_folders[0]) if ui._replay_folders else "")
                if not picked:
                    return
                if confirm_empty_folder(self, picked, QtWidgets):
                    break
            previous = [self._folder_list.item(i).text() for i in range(self._folder_list.count())]
            try:
                generation = self._folder_generation
                token = ui._on_choose_folder(Path(picked))
                self._folder_undo_token = token
                self._folder_removed_instant.discard(picked)
                paths = previous + ([picked] if picked not in previous else [])
                if self._folder_generation == generation:
                    self._sync_folder_list_widget(paths)
                self._folders_dirty = False
                self._show_folder_undo(previous)
                self._show_settings_toast("Replay folder added. You can undo this change.", "success")
            except Exception:
                log.exception("gui_choose_folder_failed")

        def _show_folder_undo(self, previous):
            self._folder_before = list(previous)
            self._folder_undo.show()
            self._folder_undo_dash.show()
            self._show_transient_notice("Replay folder updated. Choose Undo to restore the previous folders.")

        def _undo_folder_change(self):
            before = getattr(self, "_folder_before", None)
            if before is None:
                return
            self._folder_removed_instant.difference_update(before)
            token = getattr(self,"_folder_undo_token",None)
            if ui._on_restore_folders and isinstance(token,dict):
                ui._on_restore_folders(token)
            else:
                ui._on_save_settings(SettingsPayload(replay_folders=[Path(raw) for raw in before]))
                self._sync_folder_list_widget(before)
            self._folder_undo.hide()
            self._folder_undo_dash.hide()
            self._folders_dirty = False
            self._show_settings_toast("Replay folder change undone.", "success")

        def _open_companion_appearance(self):
            self._go_to_page("companion")
            self._companion_page.show_appearance_settings()

        def _check_updates_from_menu(self):
            self._go_to_page("dashboard")
            self._click_check_updates()

        def _click_check_updates(self) -> None:
            if not self._updates_btn.isEnabled():
                return
            # The update check is a blocking HTTP round-trip (up to the
            # urllib timeout). Running it on the Qt thread froze the
            # whole window for the duration — spawn a worker and land
            # the outcome back on the GUI thread via updateCheckDone.
            self._updates_btn.setEnabled(False)
            self._updates_btn.setText("Checking…")
            self._check_updates_action.setEnabled(False)
            self._show_transient_notice("Checking for updates…")

            def _worker() -> None:
                message = "Update check failed — see the activity log."
                try:
                    release = ui._on_check_updates()
                    if release is not None:
                        latest = getattr(release, "latest", None)
                        current = getattr(release, "current", None) or ui._version
                        if getattr(release, "update_available", False) and latest:
                            # The runner's update handler has already
                            # posted a branch-accurate sticky notice
                            # ("installing now…" / "auto-update is
                            # off…") via show_update_notice — emit an
                            # empty message so we re-enable the button
                            # without stomping it.
                            message = ""
                        else:
                            message = (
                                f"You're up to date — v{current} is the "
                                "latest release."
                            )
                except Exception:  # noqa: BLE001
                    log.exception("gui_check_updates_failed")
                signals.updateCheckDone.emit(message)

            threading.Thread(
                target=_worker, name="sc2tools-gui-update-check", daemon=True,
            ).start()

        def _help_url(self, slug):
            return help_url(ui._dashboard_url, slug)

        def _open_checkin_queue(self) -> None:
            from ..build_checkin.links import web_queue_url
            webbrowser.open(web_queue_url(ui._dashboard_url), new=2)

        def _open_help(self, slug, anchor=""):
            webbrowser.open(self._help_url(slug) + ("#" + anchor if anchor else ""), new=2)

        def _help_label(self, topic, slug):
            label = QtWidgets.QWidget()
            row = QtWidgets.QHBoxLayout(label)
            row.setContentsMargins(0, 0, 0, 0)
            row.addWidget(QtWidgets.QLabel(topic))
            row.addWidget(help_button(QtWidgets, topic, lambda: self._open_help(slug)))
            row.addStretch(1)
            return label

        def _show_settings_toast(self, text, tone="info", ms=6000):
            self._settings_toast_timer.stop()
            self._settings_status.setObjectName({"success": "settingsToastOk", "error": "settingsToastErr"}.get(tone, "muted"))
            self._settings_status.style().unpolish(self._settings_status)
            self._settings_status.style().polish(self._settings_status)
            self._settings_status.setText(text)
            if ms > 0:
                self._settings_toast_timer.start(ms)

        def _validate_api_address(self):
            error = validate_api_base(self._api_input.text())
            self._api_error.setText(error or "")
            return error is None

        def _reset_api_address(self):
            self._api_input.clear()
            self._validate_api_address()

        def _on_api_text_changed(self, _text):
            self._api_test_generation += 1
            self._api_test_status.clear()

        def _test_api_address(self):
            if not self._validate_api_address():
                self._api_input.setFocus()
                return
            requested = self._api_input.text().strip().rstrip("/")
            self._api_test_btn.setEnabled(False)
            self._api_test_status.setText("Testing…")
            done = self.apiTestDone
            generation = self._api_test_generation

            class Probe(QtCore.QRunnable):
                def run(self):
                    done.emit(requested, generation, probe_api_health(requested or _DEFAULT_API_BASE))

            QtCore.QThreadPool.globalInstance().start(Probe())

        def _on_api_test_done(self, requested, generation, message):
            self._api_test_btn.setEnabled(True)
            if self._api_test_generation == generation and self._api_input.text().strip().rstrip("/") == requested:
                self._api_test_status.setText(message)

        def _go_to_page(self, key):
            if key != "companion" and self._window_information_layout == "compact":
                if not self._set_window_size("Standard"):
                    return
            index = self._PAGE_KEYS.index(key) if key in self._PAGE_KEYS else 0
            self._stack.setCurrentIndex(index)
            button = self._nav_group.button(index)
            if button is not None:
                button.setChecked(True)
            titles = {"companion": "Companion", "dashboard": "Dashboard", "recent": "Recent games", "log": "Activity log", "settings": "Settings", "streams": "Streams"}
            self._agent_section_label.setText("Agent  /  " + titles.get(key, "Dashboard"))
            self._companion_page.set_active(key == "companion")
            self._apply_window_chrome()
            self._schedule_window_state()

        def _preferred_paired_page(self):
            if ui._window_page in self._PAGE_KEYS:
                return ui._window_page
            return "companion" if ui._window_page is None and callable(ui._on_companion_action) else "dashboard"

        def _schedule_window_state(self):
            timer = getattr(self, "_window_state_timer", None)
            if timer is not None and self.isVisible() and not self.isMinimized():
                timer.start()

        def _save_window_state(self):
            if self._settings_save_pending:
                self._window_state_timer.start()
                return
            if not self.isVisible() or self.isMinimized() or not ui._on_window_state:
                return
            try:
                ui._on_window_state(bytes(self.saveGeometry().toBase64()).decode("ascii"), self._PAGE_KEYS[self._stack.currentIndex()])
            except Exception:
                log.exception("gui_window_state_save_failed")

        def moveEvent(self, event):
            super().moveEvent(event)
            self._schedule_window_state()

        def resizeEvent(self, event):
            super().resizeEvent(event)
            if hasattr(self, "_companion_page"):
                self._update_responsive_chrome()
            self._update_window_size_label()
            self._schedule_window_state()

        def changeEvent(self, event):
            super().changeEvent(event)
            if event.type() == QtCore.QEvent.WindowStateChange:
                self._update_window_size_label()
                self._schedule_window_state()
                effects = getattr(self, "_race_effects", None)
                if effects is not None and self.isMaximized() and not event.oldState() & QtCore.Qt.WindowMaximized:
                    effects.play_expand()

        def showEvent(self, event):
            super().showEvent(event)
            QtCore.QTimer.singleShot(0, self._coalesce_compact_opponent)

        def hideEvent(self, event):
            super().hideEvent(event)
            controller = getattr(self, "_overlay_input", None)
            if controller is not None:
                controller.refresh()

        def _coalesce_compact_opponent(self):
            page = getattr(self, "_companion_page", None)
            if page is None or not self._compact_window_active() or not self.isVisible():
                return
            opponent = page.overlays["opponent"]
            if opponent.isVisible() and not opponent.isMinimized():
                # The pinned HUD already owns the compact identity and scouting
                # control. Keep its saved position; explicit reopen uses Standard.
                self.hide()

        def _window_size_screen(self):
            return self.screen() or QtWidgets.QApplication.primaryScreen()

        def _window_frame_size(self):
            frame = self.frameGeometry()
            return max(0, frame.width() - self.width()), max(0, frame.height() - self.height())

        def _information_layout_changed(self, level):
            from .window_sizes import normalize_information_layout
            self._window_information_layout = normalize_information_layout(level)
            self._apply_window_chrome()
            self._fit_current_window_to_screen()
            self._update_window_size_label()

        def _compact_window_active(self):
            return self._window_information_layout == "compact" and self._stack.currentWidget() is self._companion_page

        def _apply_window_appearance(self):
            from .race_visuals import css_for_skin
            application = QtWidgets.QApplication.instance()
            if application.property("raceBaseStyle") is None:
                application.setProperty("raceBaseStyle", application.styleSheet())
            override = css_for_skin(ui._window_skin)
            application_style = application.property("raceBaseStyle") + override
            if application.styleSheet() != application_style:
                application.setStyleSheet(application_style)
            widgets = [self, *self.findChildren(QtWidgets.QWidget)]
            for widget in widgets:
                base_style = widget.property("raceBaseStyle")
                if base_style is None and widget.styleSheet():
                    base_style = widget.styleSheet()
                    widget.setProperty("raceBaseStyle", base_style)
                if base_style is not None:
                    widget_style = base_style + override
                    if widget.styleSheet() != widget_style:
                        widget.setStyleSheet(widget_style)
                set_skin = getattr(widget, "set_skin", None)
                if callable(set_skin):
                    set_skin(ui._window_skin)
            self._race_effects.apply_skin(ui._window_skin)
            self._race_effects.set_motion_enabled(ui._window_animations)
            panels = [*self._companion_page.overlays.values(), self._companion_page.ghost_page.panel,
                      self._companion_page.session_panel]
            for panel in panels:
                panel.set_appearance(ui._window_skin, ui._window_animations)

        def _window_appearance_changed(self, skin, animations):
            from .race_visuals import normalize_skin
            previous = (ui._window_skin, ui._window_animations)
            requested = (normalize_skin(skin), animations is True)
            if requested == previous:
                return
            try:
                if ui._on_window_appearance:
                    ui._on_window_appearance(*requested)
            except Exception:
                log.exception("gui_window_appearance_save_failed")
                self._companion_page.set_appearance(*previous)
                self._companion_page.set_appearance_notice("Couldn't save appearance. Your previous skin and animation choice are unchanged. Try again.")
                return
            ui._window_skin, ui._window_animations = requested
            self._companion_page.set_appearance_notice("")
            self._apply_window_appearance()

        def _update_responsive_chrome(self):
            narrow = self.width() < 900
            companion = self._stack.currentWidget() is self._companion_page
            self._sidebar.setVisible(not companion and not narrow)
            self._agent_edition.setVisible(not narrow)
            self._agent_version.setVisible(not narrow)
            columns = 2 if narrow else 4
            if getattr(self, "_stats_columns", None) != columns:
                self._stats_columns = columns
                for column in range(4):
                    self._stats_layout.setColumnStretch(column, 1 if column < columns else 0)
                for index, card in enumerate(self._stat_cards):
                    self._stats_layout.removeWidget(card["frame"])
                    self._stats_layout.addWidget(card["frame"], index // columns, index % columns)

        def _apply_window_chrome(self):
            compact = self._compact_window_active()
            companion = self._stack.currentWidget() is self._companion_page
            for surface in (self, self.centralWidget(), self._agent_frame, self._agent_display, self._stack):
                if surface.property("textOverlay") != compact:
                    surface.setProperty("textOverlay", compact)
                    surface.style().unpolish(surface)
                    surface.style().polish(surface)
                    surface.update()
            self._update_responsive_chrome()
            self._agent_brandbar.setVisible(not companion)
            self._agent_toolbar.setVisible(not companion)
            self._outer_layout.setContentsMargins(*((0, 0, 0, 0) if companion else (10, 10, 10, 10)))
            self._frame_layout.setContentsMargins(*((0, 0, 0, 0) if companion else (14, 12, 14, 14)))
            self._frame_layout.setSpacing(0 if companion else 10)
            self._agent_body.setSpacing(0 if companion else 12)
            for widget in (self._agent_frame, self._agent_display):
                if widget.property("companion") != companion:
                    widget.setProperty("companion", companion)
                    widget.style().unpolish(widget)
                    widget.style().polish(widget)
                    widget.update()
            effects = getattr(self, "_race_effects", None)
            if effects is not None:
                effects.set_frame_target(self._companion_page.compact_card if compact else self._companion_page.console if companion else self._agent_frame)
            if compact:
                self._stack.setSizePolicy(QtWidgets.QSizePolicy.Ignored, QtWidgets.QSizePolicy.Ignored)
            else:
                self._stack.setSizePolicy(self._normal_stack_policy)
            from .window_sizes import minimum_window_size
            minimum = minimum_window_size("compact" if compact else "standard")
            screen = self._window_size_screen()
            if screen is not None:
                available = screen.availableGeometry()
                frame = self._window_frame_size()
                self.setMinimumSize(min(minimum[0], max(1, available.width() - frame[0])), min(minimum[1], max(1, available.height() - frame[1])))
            else:
                self.setMinimumSize(*minimum)
            self._coalesce_compact_opponent()
            if hasattr(self, "_overlay_input"):
                self._overlay_input.refresh()

        def _fit_current_window_to_screen(self):
            screen = self._window_size_screen()
            if screen is None or self.isMaximized() or self.isMinimized():
                return
            available = screen.availableGeometry()
            frame = self._window_frame_size()
            width = min(self.width(), max(1, available.width() - frame[0]))
            height = min(self.height(), max(1, available.height() - frame[1]))
            self.resize(width, height)
            position = self.frameGeometry().topLeft()
            left = min(max(position.x(), available.x()), available.x() + max(0, available.width() - width - frame[0]))
            top = min(max(position.y(), available.y()), available.y() + max(0, available.height() - height - frame[1]))
            self.move(left, top)

        def _update_window_size_label(self):
            from .window_sizes import window_size_label
            page = getattr(self, "_companion_page", None)
            screen = self._window_size_screen()
            if page is None or screen is None:
                return
            page.set_window_size_label(window_size_label(
                (self.width(), self.height()), available=screen.availableGeometry().getRect(),
                frame=self._window_frame_size(), layout=self._window_information_layout,
                maximized=self.isMaximized(),
            ))

        def _set_window_size(self, name):
            from .window_sizes import WINDOW_SIZE_PRESETS, fit_window_preset
            preset = next((item for item in WINDOW_SIZE_PRESETS if item[0] == name or item[1] == name), None)
            if preset is None:
                return False
            screen = self._window_size_screen()
            if screen is None:
                return False
            previous_area = self.width() * self.height()
            level = preset[1]
            try:
                if ui._on_window_information_layout:
                    ui._on_window_information_layout(level)
            except Exception:
                log.exception("gui_window_information_layout_save_failed")
                self._companion_page.set_window_size_notice("Couldn't save this layout. Your current size and information layout are unchanged. Try again.")
                self._update_window_size_label()
                return False
            ui._window_information_layout = level
            self._window_information_layout = level
            self._companion_page.set_window_size_notice("")
            if hasattr(self._companion_page, "set_density"):
                self._companion_page.set_density(level)
            if level == "compact":
                self._go_to_page("companion")
            self._apply_window_chrome()
            if preset[2] is None:
                self.showMaximized()
            else:
                if self.isMaximized() or self.isMinimized() or self.isFullScreen():
                    self.showNormal()
                available = screen.availableGeometry()
                frame = self._window_frame_size()
                position = self.frameGeometry().topLeft()
                left, top, width, height = fit_window_preset(
                    preset[0], available.getRect(), position=(position.x(), position.y()), frame=frame,
                )
                self.resize(width, height)
                self.move(left, top)
            self._update_window_size_label()
            QtCore.QTimer.singleShot(0, self._update_window_size_label)
            self._schedule_window_state()
            if self.isVisible() and level != "compact" and self.width() * self.height() > previous_area:
                self._race_effects.play_expand()
            return True

        def _restore_window_state(self):
            from .build_checkin_window import clamp_card_position, screen_rects
            key = "companion" if self._window_information_layout == "compact" else self._preferred_paired_page() if self._paired else "dashboard"
            self._go_to_page(key)
            if ui._window_geometry:
                self.restoreGeometry(QtCore.QByteArray.fromBase64(ui._window_geometry.encode("ascii")))
                if self._compact_window_active() and self.width() <= 360 and self.height() in {68, 78}:
                    self.resize(420, 44)
            screens = QtWidgets.QApplication.screens()
            if screens:
                rects = screen_rects(screens)
                frame = self.frameGeometry()
                point = clamp_card_position((frame.x(), frame.y()), (frame.width(), frame.height()), rects, min_visible=120)
                target = QtWidgets.QApplication.primaryScreen().availableGeometry()
                if point is not None:
                    target = next((screen.availableGeometry() for screen in screens if screen.availableGeometry().contains(QtCore.QPoint(*point))), target)
                from .window_sizes import minimum_window_size
                minimum = minimum_window_size("compact" if self._compact_window_active() else "standard")
                frame_size = self._window_frame_size()
                self.setMinimumSize(min(minimum[0], max(1, target.width() - frame_size[0])), min(minimum[1], max(1, target.height() - frame_size[1])))
                if point is None:
                    self.resize(min(960, target.width()), min(640, target.height()))
                    point = (target.x() + (target.width() - self.width()) // 2, target.y() + (target.height() - self.height()) // 2)
                else:
                    self.resize(min(self.width(), max(1, target.width() - frame_size[0])), min(self.height(), max(1, target.height() - frame_size[1])))
                self.move(*point)
            self._update_window_size_label()

        def _click_save_settings(self) -> None:
            if self._settings_save_pending:
                return
            if not self._validate_api_address():
                self._show_settings_toast("Fix the API address before saving.", "error")
                self._api_input.setFocus()
                return
            api_base = self._api_input.text().strip().rstrip("/")
            loaded_api, loaded_log, loaded_parse = self._loaded_restart_values
            changed = []
            if self._log_combo.currentText() != loaded_log:
                changed.append("Log level")
            if int(self._concurrency_slider.value()) != loaded_parse:
                changed.append("Import speed")
            if api_base != loaded_api:
                changed.append("API address")
            fields = (", ".join(changed[:-1]) + " and " + changed[-1]) if len(changed) > 1 else "".join(changed)
            self._settings_restart_notice = f" {fields} {'changes' if len(changed) == 1 else 'change'} after you restart SC2 Tools." if fields else ""
            folders: List[Path] = []
            for i in range(self._folder_list.count()):
                raw = self._folder_list.item(i).text().strip()
                if raw:
                    folders.append(Path(raw))
            preset = self._filter_combo.currentData() or "all"
            since_iso: Optional[str] = None
            until_iso: Optional[str] = None
            if preset == "custom":
                since_iso = self._filter_since.date().toString("yyyy-MM-dd")
                until_iso = self._filter_until.date().toString("yyyy-MM-dd")
            # Upload concurrency comes from the QButtonGroup's
            # ``checkedId()`` (1 or 2). Falls back to whatever we
            # last saved if no button is checked — should never
            # happen because the group is exclusive and we set a
            # default in __init__, but defensive coding keeps Save
            # Settings from blowing up if Qt ever returns -1.
            checked_upload_conc = self._upload_conc_group.checkedId()
            if checked_upload_conc <= 0:
                checked_upload_conc = self._upload_conc_last_saved
            payload = SettingsPayload(
                background_import_speed=self._speed_combo.currentData(),
                pause_history_in_game=self._pause_history_check.isChecked(),
                pause_on_battery=self._battery_check.isChecked(),
                api_base=api_base if api_base != self._saved_api_base else None,
                log_level=self._log_combo.currentText(),
                replay_folders=folders,
                replay_folders_removed=[
                    Path(raw) for raw in self._folders_removed
                ],
                replay_folder=folders[0] if folders else None,
                autostart_enabled=self._autostart_check.isChecked(),
                start_minimized=self._minimized_check.isChecked(),
                notify_every_game=self._game_notifications_check.isChecked(),
                auto_update_enabled=self._autoupdate_check.isChecked(),
                replay_capture_enabled=self._replay_capture_last_saved,
                player_handle=self._handle_input.text().strip(),
                parse_concurrency=int(self._concurrency_slider.value()),
                upload_concurrency=checked_upload_conc,
                upload_batch_size=int(self._upload_batch_slider.value()),
                sync_filter_preset=preset,
                sync_filter_since=since_iso,
                sync_filter_until=until_iso,
                obs_scene_switch_enabled=self._obs_enable_check.isChecked(),
                obs_host=self._obs_host_input.text().strip() or "127.0.0.1",
                obs_port=int(self._obs_port_input.value()),
                obs_password=self._obs_password_input.text(),
                obs_scene_map=self._obs_scene_map_from_form(),
                obs_switch_debounce_sec=float(
                    self._obs_debounce_spin.value(),
                ),
                obs_switch_on_replays=self._obs_replay_check.isChecked(),
                obs_website_add_enabled=self._obs_website_add_check.isChecked(),
            )
            context = dict(api_base=api_base, preset=preset, since_iso=since_iso,
                           until_iso=until_iso, removals=self._folders_removed,
                           dirty=self._folders_dirty)
            self._folders_removed = []
            self._folders_dirty = False
            self._save_ack = False
            self._settings_save_pending = True
            self._settings_page.setEnabled(False)
            self._save_settings_btn.setText("Saving…")
            self._show_settings_toast("Saving settings…")
            self._settings_toast_timer.stop()
            self._refresh_controls()

            def persist():
                error = None
                try:
                    ui._on_save_settings(payload)
                except Exception as exc:  # noqa: BLE001
                    log.exception("gui_save_settings_failed")
                    error = str(exc) or type(exc).__name__
                try:
                    signals.settingsSaveDone.emit(context, error)
                except RuntimeError:
                    # The durable write still finishes if the window quits.
                    log.debug("settings_save_finished_after_window_closed")

            # Keep this short-lived persistence worker alive through Quit so a
            # completed Save cannot silently lose its atomic state commit.
            threading.Thread(target=persist, name="sc2tools-settings-save", daemon=False).start()

        def _on_settings_save_done(self, context, error):
            self._settings_save_pending = False
            self._settings_page.setEnabled(True)
            self._game_dashboard.season.setEnabled(True)
            self._save_settings_btn.setText("Save settings")
            if error:
                self._folders_removed = context["removals"]
                self._folders_dirty = context["dirty"]
                self._show_settings_toast(f"Couldn't save settings: {error}", "error")
            else:
                self._saved_api_base = context["api_base"]
                preset = context["preset"]
                if context.get("externalFilter"):
                    self._filter_combo.setCurrentIndex(self._filter_combo.findData(preset))
                self._active_filter_label = self._compute_filter_label(
                    preset=None if preset == "all" else preset,
                    since_iso=context["since_iso"], until_iso=context["until_iso"],
                )
                if not self._save_ack:
                    self._show_settings_toast("Saved." + self._settings_restart_notice, "success")
            self._refresh_controls()

        def _refresh_capture_notice(self) -> None:
            self._replay_capture_notice.setVisible(
                self._replay_capture_last_saved,
            )

        def _toggle_replay_capture(self, enabled: bool) -> None:
            desired = bool(enabled)
            if desired == self._replay_capture_last_saved:
                return
            if desired:
                answer = QtWidgets.QMessageBox.warning(
                    self,
                    "Enable automatic replay capture?",
                    "The agent will automatically record new and re-synced "
                    "replays with StarCraft II in the background on this PC. "
                    "It can use substantial CPU for several minutes per replay and slow "
                    "down your game or stream.\n\n"
                    "Saved recordings can be reused without running "
                    "StarCraft II again. You can turn this setting off at "
                    "any time to stop automatic capture.\n\nEnable this feature?",
                    QtWidgets.QMessageBox.Yes | QtWidgets.QMessageBox.No,
                    QtWidgets.QMessageBox.No,
                )
                if answer != QtWidgets.QMessageBox.Yes:
                    self._replay_capture_check.blockSignals(True)
                    self._replay_capture_check.setChecked(False)
                    self._replay_capture_check.blockSignals(False)
                    return
            try:
                ui._on_save_settings(SettingsPayload(
                    replay_capture_enabled=desired,
                ))
            except Exception as exc:  # noqa: BLE001
                log.exception("gui_replay_capture_toggle_failed")
                self._replay_capture_check.blockSignals(True)
                self._replay_capture_check.setChecked(
                    self._replay_capture_last_saved,
                )
                self._replay_capture_check.blockSignals(False)
                self._show_settings_toast(
                    f"Could not save replay capture setting: {exc}", "error",
                )
                return
            self._replay_capture_last_saved = desired
            self._refresh_capture_notice()
            self._show_settings_toast(
                "Automatic replay capture on — new and re-synced replays record automatically"
                if desired
                else "Automatic replay capture off — stopping automatic capture",
            )

        def _toggle_obs_scene_switch(self, enabled: bool) -> None:
            """Persist and hot-apply the OBS master gate immediately."""
            desired = bool(enabled)
            if desired == self._obs_enable_last_saved:
                return
            try:
                # A partial payload changes only the gate. Connection fields,
                # scene mappings, and other unsaved form edits remain drafts.
                ui._on_save_settings(SettingsPayload(
                    obs_scene_switch_enabled=desired,
                ))
            except Exception as exc:  # noqa: BLE001
                log.exception("gui_obs_scene_toggle_failed")
                self._obs_enable_check.blockSignals(True)
                self._obs_enable_check.setChecked(
                    self._obs_enable_last_saved,
                )
                self._obs_enable_check.blockSignals(False)
                self._show_settings_toast(
                    f"Could not {'enable' if desired else 'disable'} "
                    f"automatic scene switching: {exc}", "error",
                )
                return
            self._obs_enable_last_saved = desired
            self._show_settings_toast(
                "Automatic scene switching on"
                if desired
                else "Automatic scene switching off",
            )

        def _copy_pairing_code(self) -> None:
            code = self._pairing_code_label.text()
            if not code or "-" in code and len(set(code)) <= 1:
                return
            QtWidgets.QApplication.clipboard().setText(code)
            # Confirm on the button itself — the status-card line is
            # in a different card and easy to miss mid-pairing.
            self._copy_btn.setText("Copied ✓")
            QtCore.QTimer.singleShot(
                2000, lambda: self._copy_btn.setText("Copy code"),
            )

        def _open_pairing_page(self) -> None:
            try:
                self._pairing_card.act()
            except Exception:  # noqa: BLE001
                log.exception("gui_open_pairing_failed")

        def _open_dashboard(self) -> None:
            try:
                webbrowser.open(ui._dashboard_url, new=2)
            except Exception:  # noqa: BLE001
                log.exception("gui_open_dashboard_failed")

        def _open_log_folder(self) -> None:
            _open_path_in_explorer(ui._log_dir)

        def _add_folder_row(self) -> None:
            self._click_choose_folder()

        def _remove_folder_rows(self) -> None:
            previous = [self._folder_list.item(i).text() for i in range(self._folder_list.count())]
            removed = [item.text() for item in self._folder_list.selectedItems()]
            if not removed:
                return
            paths = [raw for raw in previous if raw not in removed]
            self._folder_removed_instant.update(removed)
            generation = self._folder_generation
            self._folder_undo_token = ui._on_save_settings(SettingsPayload(replay_folders=[Path(raw) for raw in paths],
                                                replay_folders_removed=[Path(raw) for raw in removed]))
            if generation == self._folder_generation:
                self._sync_folder_list_widget(paths)
            self._folders_dirty = False
            self._show_folder_undo(previous)
            self._show_settings_toast("Replay folders removed. You can undo this change.", "success")

        def _auto_detect_folders(self) -> None:
            """Actively scan the StarCraft II Accounts tree and populate
            the list with every Replays/Multiplayer dir we find.

            Previously this just cleared the list and relied on the
            runner doing auto-discovery on the next start — but the
            user couldn't *see* what was about to be watched, and if
            the rediscovery picked up extra (or missed) folders they'd
            only find out by relaunching. Doing the scan inline here
            is fast (just a couple of iterdir calls), and the result
            is dropped straight into the list widget so the user can
            review and Save.
            """
            from .. import replay_finder

            roots = replay_finder.find_all_replays_roots()
            if not roots:
                QtWidgets.QMessageBox.information(
                    self,
                    "Auto-detect",
                    "Couldn't find a StarCraft II Accounts folder. "
                    "Pick one manually with the Add folder… button.",
                )
                return
            multi = replay_finder.all_multiplayer_dirs_anywhere()
            # Final fallback: if no Multiplayer subdirs exist yet
            # (brand-new SC2 install with no replays played), watch
            # every detected Accounts root so they get picked up the
            # moment SC2 writes its first replay.
            if not multi:
                multi = list(roots)
            # Preserve any user-added folders that the auto-scan didn't
            # find — they may be on a removable drive that's currently
            # disconnected, or a custom path the user wants kept.
            existing: list[str] = []
            existing_keys: set[str] = set()
            for i in range(self._folder_list.count()):
                raw = self._folder_list.item(i).text().strip()
                if not raw:
                    continue
                try:
                    key = str(Path(raw).resolve())
                except OSError:
                    key = raw
                if key in existing_keys:
                    continue
                existing_keys.add(key)
                existing.append(raw)

            new_entries: list[str] = []
            for mp in multi:
                try:
                    key = str(mp.resolve())
                except OSError:
                    key = str(mp)
                if key in existing_keys:
                    continue
                existing_keys.add(key)
                new_entries.append(str(mp))

            # If neither the existing list nor the scan found anything,
            # fall back to the detected Accounts roots so the user has a
            # place to start. (This path previously referenced an
            # undefined variable and crashed the button on brand-new
            # SC2 installs with no replays yet.)
            if not existing and not new_entries:
                new_entries.extend(str(r) for r in roots)

            combined = existing + new_entries
            self._folder_list.clear()
            for entry in combined:
                self._folder_list.addItem(entry)

            self._folder_rows.render()
            self._folder_removed_instant.difference_update(new_entries)
            if new_entries:
                self._folder_undo_token=ui._on_save_settings(SettingsPayload(replay_folders=[Path(raw) for raw in combined]))
                self._folders_dirty = False
                self._show_folder_undo(existing)
                self._show_settings_toast(
                    f"Auto-detect added {len(new_entries)} folder"
                    f"{'s' if len(new_entries) != 1 else ''}.", "success")
            else:
                self._show_settings_toast(
                    "Auto-detect: no new folders found",
                )

        def _reveal_replay(
            self, item: "QtWidgets.QTableWidgetItem",
        ) -> None:
            row = item.row()
            name_item = self._recent_table.item(row, 1)
            if not name_item:
                return
            name = name_item.text()
            if not name:
                return
            # The recent list stores filenames, not full paths, so we
            # probe every watched folder — the previous folder[0]-only
            # lookup opened the wrong folder for multi-region players
            # whose replay came from the second or third entry.
            for folder in ui._replay_folders or []:
                try:
                    if (Path(folder) / name).exists():
                        _open_path_in_explorer(Path(folder))
                        return
                except OSError:
                    continue
            if ui._replay_folders:
                _open_path_in_explorer(ui._replay_folders[0])

        # ---- close behaviour ----

        _really_quit = False

        def closeEvent(self, event) -> None:  # noqa: N802 — Qt API
            # Default behaviour: hide-to-tray. Quitting only happens
            # through the tray's Quit action (which calls
            # signals.quitRequested).
            self._save_window_state()
            self._window_state_timer.stop()
            if self._really_quit:
                event.accept()
                return
            if not ui._tray_available:
                policy = ui._close_without_tray
                if policy is None:
                    dialog = QtWidgets.QMessageBox(self)
                    dialog.setWindowTitle("Close SC2 Tools")
                    dialog.setText("No tray icon is available. Quit SC2 Tools or minimize the window?")
                    quit_button = dialog.addButton("Quit", QtWidgets.QMessageBox.AcceptRole)
                    minimize = dialog.addButton("Minimize", QtWidgets.QMessageBox.RejectRole)
                    dialog.setDefaultButton(minimize)
                    dialog.exec()
                    policy = "quit" if dialog.clickedButton() is quit_button else "minimize"
                    ui._close_without_tray = policy
                    ui._on_close_policy(policy)
                if policy == "quit":
                    event.accept()
                    ui._on_quit()
                else:
                    event.ignore()
                    self.showMinimized()
                return
            if not ui._tray_hint_shown:
                ui._tray_hint_shown = True
                ui._on_tray_hint()
            event.ignore()
            self.hide()

        # ---- refresh helpers ----

        def _on_phase(self, phase, detail=""):
            if phase == "boot_error":
                self._boot_detail = detail

        def _on_analyzer_probe(self, ok, diag):
            self._analyzer_diag = diag

        def _on_paused(self, paused, until=0):
            self._paused = paused
            self._pause_btn.setText("Resume syncing" if paused else "Pause syncing")
            self._request_stats_refresh()

        def _show_transient_notice(self, message):
            self._transient_notice.setText(message)
            self._transient_notice.setVisible(bool(message))
            self._transient_timer.start(8000)

        def _refresh_controls(self):
            """While unpaired, hide the totals and lock Pause, Re-sync and Add folder; a pending save locks them too."""
            unpaired = not self._paired
            self._stats_row.setVisible(not unpaired)
            self._game_dashboard.setVisible(not unpaired)
            for button in (self._pause_btn, self._resync_btn, self._choose_btn):
                button.setEnabled(not unpaired and not self._settings_save_pending)

        # ---- status card: health snapshots ----

        def _paint_health(self):
            """Paint the newest snapshot, however many signals were queued for it."""
            snapshot = ui._take_health()
            if snapshot is not None:
                self._render_health(snapshot)

        def _render_health(self, snapshot):
            self._health_view.apply(snapshot)
            self._status_copy.setVisible(snapshot.level == "error")
            full = f"● {snapshot.headline}"
            problems = [row.sentence for row in snapshot.rows if row.level in ("warn", "error")]
            self._sidebar_status.setToolTip("\n".join([full, *problems]))
            width = max(80, self._sidebar_status.width())
            self._sidebar_status.setText(self._sidebar_status.fontMetrics().elidedText(full, QtCore.Qt.ElideRight, width))

        def _health_actions(self):
            return {
                "link_pc": self._link_pc,
                "retry_now": ui._on_sync_retry,
                "add_folder": self._click_choose_folder,
                "set_player_name": self._focus_player_name,
                "resume": self._resume_sync,
                "open_obs_settings": lambda: self._open_settings_at(self._obs_card),
                "install_update": lambda: self._run_update_action(ui._on_install_update),
                "restart_agent": self._confirm_restart,
                "copy_details": self._copy_status_details,
                "open_log": lambda: self.show_log("errors"),
            }

        def _run_health_action(self, action):
            try:
                self._health_actions()[action]()
            except Exception:  # noqa: BLE001 - a failing action must not break the card
                log.exception("gui_health_action_failed action=%s", action)

        def _open_row_help(self, row):
            """A row's own "?": the connection hold it explains, or why a game didn't arrive."""
            if row.help_slug == SYNC_HELP:
                kind = self._connection_kind
                self._open_help("desktop-app-sync-problems", "" if kind == "online" else kind.replace("_", "-"))
            elif row.help_slug == GAMES_HELP:
                self._open_help("my-game-didnt-show-up")

        def _health_row_tooltip(self, row):
            """The folders row lists the watched paths on hover."""
            return "\n".join(str(path) for path in ui._replay_folders) if row.id == "folders" else ""

        def _link_pc(self):
            """The pairing card knows the next linking step; otherwise start Link again."""
            card = self._pairing_card
            if not card.isHidden() and card.primary.isEnabled():
                card.act()
            else:
                ui._on_link_again()

        def _resume_sync(self):
            if self._settings_save_pending:
                self._show_transient_notice("Wait for the settings save to finish, then try again.")
                return
            ui._on_pause(False)

        def _focus_player_name(self):
            self._open_settings_at(self._handle_input)
            self._handle_input.setFocus()
            self._handle_input.selectAll()

        def _open_settings_at(self, widget):
            """Settings is one long scroll area: open it with ``widget`` near the top."""
            self._go_to_page("settings")
            scroll = self._settings_scroll
            # Deferred until the page switch is laid out, so the offset is real.
            QtCore.QTimer.singleShot(0, self, lambda: scroll.verticalScrollBar().setValue(
                max(0, widget.mapTo(scroll.widget(), QtCore.QPoint(0, 0)).y() - 12)))

        def _confirm_restart(self):
            if self._settings_save_pending:
                self._show_transient_notice("Wait for the settings save to finish, then try again.")
                return
            answer = QtWidgets.QMessageBox.question(
                self,
                "Restart SC2 Tools?",
                "SC2 Tools will close and start again. This takes a few seconds.",
                QtWidgets.QMessageBox.Yes | QtWidgets.QMessageBox.No,
                QtWidgets.QMessageBox.No,
            )
            if answer == QtWidgets.QMessageBox.Yes:
                ui._on_restart_agent()

        def _copy_status_details(self):
            lines=[]
            try:
                for line in ui._log_file.read_text(encoding="utf-8",errors="replace").splitlines():
                    if " ERROR " in line:
                        lines.append(line)
                lines=lines[-20:]
            except OSError:
                pass
            snapshot = self._health_view.snapshot
            details = f"SC2 Tools {ui._version}\nStatus: {snapshot.headline}\n"
            details += "".join(f"{row.level}: {row.sentence}\n" for row in snapshot.rows + snapshot.footer)
            details += self._boot_detail or self._analyzer_diag
            if lines: details += "\n" + "\n".join(lines)
            QtWidgets.QApplication.clipboard().setText(details)

        def _compute_filter_label(
            self,
            *,
            preset: Optional[str],
            since_iso: Optional[str],
            until_iso: Optional[str],
        ) -> str:
            """Resolve the user-friendly label for an active filter,
            or an empty string when the filter is fully open. Imported
            lazily so the GUI module stays cheap to import on a
            no-Qt install."""
            from .. import sync_filter as sf
            f = sf.SyncFilter.from_state(
                preset=preset,
                since_iso=since_iso,
                until_iso=until_iso,
            )
            if not f.is_active():
                return ""
            return f.short_label()

        def _refresh_pairing_card(self) -> None:
            # Hide the whole pairing card once we're paired so the
            # dashboard's hero spot is freed up for the live stats.
            if not self._paired:
                self._pairing_card.show()
            elif self._pairing_card.kind != "paired":
                self._pairing_card.hide()

        def _request_stats_refresh(self):
            if not self._stats_refresh_timer.isActive():
                self._stats_refresh_timer.start()

        def _refresh_stats(self) -> None:
            # Re-query on every repaint so a mid-session Re-sync (which
            # wipes the uploaded cursor) is reflected without waiting
            # for the next upload to land.
            if not ui._recent_games_enabled:
                self._uploaded_count = self._query_synced_count(default=self._uploaded_count)
            self._paint_stats()

        def _paint_stats(self):
            from .recent_games import relative_time
            if ui._recent_games_enabled:
                facts = self._history_facts
                self._stat_synced["value"].setText(str(facts.get("synced", 0)) if facts is not None else "…")
                self._stat_synced["label"].setText(f"Synced · +{facts.get('syncedToday', 0)} today" if facts else "Synced")
                self._stat_last["value"].setText(relative_time(facts.get("lastUploadAt")) if facts and facts.get("lastUploadAt") else "—")
                self._stat_failed["value"].setText(str(facts.get("failed24h", 0)) if facts else "0")
                remaining = max(0, int(self._import_progress.get("remaining", 0)))
                waiting = max(self._pending_count, remaining)
                unknown = self._import_progress.get("phase") == "scanning" and not self._import_progress.get("inventoryKnown")
                self._stat_queued["value"].setText("…" if unknown else str(waiting))
                self._game_dashboard.set_progress(self._import_progress, paused=self._paused, connection=self._connection_kind)
                return
            self._stat_synced["value"].setText(str(self._uploaded_count))
            self._stat_queued["value"].setText(str(self._pending_count))
            if self._last_upload:
                _, ts = self._last_upload
                self._stat_last["value"].setText(ts.strftime("%H:%M:%S"))
            else:
                self._stat_last["value"].setText("—")

        def _insert_recent(self, record):
            ts, name, ok, detail = record
            self._recent_widget.append({"path": name, "status": "uploaded" if ok else "problem",
                "errorTitle": (detail if isinstance(detail, str) else detail.title) if not ok else "",
                "errorKind": getattr(detail, "help_anchor", "rejected"),
                "updatedAt": ts.astimezone().isoformat(), "error": getattr(detail, "detail", str(detail)) if not ok else ""})

        def _refresh_recent(self) -> None:
            self._recent_widget.refresh_counts()

        def _populate_settings(self) -> None:
            initial = ui._initial_settings
            self._populate_obs_settings(initial)
            if initial.api_base:
                self._api_input.setText(initial.api_base)
            if initial.player_handle:
                self._handle_input.setText(initial.player_handle)
            if initial.parse_concurrency:
                # Clamp into the slider's [1, cpu_max] range so a state
                # file from a different machine (e.g. user copied their
                # profile from a 16-core box to a 4-core laptop) doesn't
                # leave the slider out of bounds.
                cur = int(initial.parse_concurrency)
                cur = max(
                    self._concurrency_slider.minimum(),
                    min(self._concurrency_slider.maximum(), cur),
                )
                self._concurrency_slider.setValue(cur)
            if initial.upload_concurrency:
                # Map the persisted/effective value (which can be
                # 1..UPLOAD_CONCURRENCY_USEFUL_MAX from the env var
                # path) onto the UI's 1-or-2 button group. Anything
                # >=2 lights the "2" button — we don't expose 3/4
                # in the UI even when the env var pushes higher
                # because the Settings tab is for typical users.
                desired = int(initial.upload_concurrency)
                ui_value = 1 if desired <= 1 else 2
                btn = self._upload_conc_buttons.get(ui_value)
                if btn is not None:
                    btn.setChecked(True)
                # Sync the no-op-click guard to the value we just
                # painted so the user clicking that same button
                # doesn't trigger a redundant save.
                self._upload_conc_last_saved = ui_value
            if initial.upload_batch_size:
                cur = int(initial.upload_batch_size)
                cur = max(
                    self._upload_batch_slider.minimum(),
                    min(self._upload_batch_slider.maximum(), cur),
                )
                self._upload_batch_slider.setValue(cur)
            if initial.log_level:
                idx = self._log_combo.findText(
                    initial.log_level, QtCore.Qt.MatchFixedString,
                )
                if idx >= 0:
                    self._log_combo.setCurrentIndex(idx)
            # Folder list seed order:
            #   1. Settings payload's explicit list (user-saved override)
            #   2. Settings payload's legacy single folder (forward-migrated)
            #   3. Currently watched folders surfaced by the runner
            seeded: List[str] = []
            if initial.replay_folders:
                seeded = [str(p) for p in initial.replay_folders]
            elif initial.replay_folder:
                seeded = [str(initial.replay_folder)]
            elif ui._replay_folders:
                seeded = [str(p) for p in ui._replay_folders]
            self._sync_folder_list_widget(seeded)
            from ..game_activity import background_workers
            self._concurrency_slider.setValue(background_workers(self._speed_combo.currentData(),_PARSE_CONCURRENCY_USEFUL_MAX))
            self._autostart_check.setChecked(
                bool(initial.autostart_enabled),
            )
            self._minimized_check.setChecked(
                bool(initial.start_minimized),
            )
            self._game_notifications_check.setChecked(initial.notify_every_game is True)
            # Default ON when the runner didn't say otherwise — matches
            # the state field's default so a fresh install reads true.
            self._autoupdate_check.setChecked(
                initial.auto_update_enabled is not False,
            )
            self._replay_capture_check.setChecked(
                initial.replay_capture_enabled is True,
            )
            # Date-range filter — match the saved preset id back to the
            # combo entry. Unknown values silently fall through to "All
            # time" (the same fallback SyncFilter applies on the agent
            # side), so a state file from a newer agent build that has
            # presets we don't know about doesn't crash the form.
            preset = initial.sync_filter_preset or "all"
            for idx in range(self._filter_combo.count()):
                if self._filter_combo.itemData(idx) == preset:
                    self._filter_combo.setCurrentIndex(idx)
                    break
            else:
                self._filter_combo.setCurrentIndex(0)
            if initial.sync_filter_since:
                qd = QtCore.QDate.fromString(
                    initial.sync_filter_since[:10], "yyyy-MM-dd",
                )
                if qd.isValid():
                    self._filter_since.setDate(qd)
            if initial.sync_filter_until:
                qd = QtCore.QDate.fromString(
                    initial.sync_filter_until[:10], "yyyy-MM-dd",
                )
                if qd.isValid():
                    self._filter_until.setDate(qd)

        # ---- log tail ----

        def _tail_log_now(self) -> None:
            self._activity_log.tail()

        def _render_log(self) -> None:
            self._activity_log.rebuild()

    return MainWindow()


# ---------------------------------------------------------------------
# Helpers shared with tray.py — mild duplication, but importing tray.py
# from here would couple two presentation layers we want independent.
# ---------------------------------------------------------------------


def _open_path_in_explorer(path: Path) -> None:
    """Open ``path`` in Explorer/Finder/the desktop file manager."""
    if not path:
        return
    if os.name == "nt":
        try:
            subprocess.Popen(["explorer", str(path)])  # noqa: S603,S607
        except Exception:  # noqa: BLE001
            log.exception("open_in_explorer_failed")
        return
    if sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])  # noqa: S603,S607
        return
    if shutil.which("xdg-open"):
        subprocess.Popen(["xdg-open", str(path)])  # noqa: S603,S607
        return
    if shutil.which("gio"):
        subprocess.Popen(["gio", "open", str(path)])  # noqa: S603,S607


def _matches_level(line: str, filter_label: str) -> bool:
    """Filter a log line by its embedded log level marker."""
    if filter_label == "All":
        return True
    levels = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]
    minimums = {
        "INFO+": ["INFO", "WARNING", "ERROR", "CRITICAL"],
        "WARNING+": ["WARNING", "ERROR", "CRITICAL"],
        "ERROR only": ["ERROR", "CRITICAL"],
    }
    keep = minimums.get(filter_label, levels)
    # The agent's logging.Formatter writes "%(levelname)s" as the
    # second field after the timestamp, e.g.
    # "2026-05-04T20:00:00 INFO sc2tools_agent | …"
    parts = line.split(" ", 2)
    if len(parts) < 2:
        return True
    level = parts[1].strip()
    return level in keep


def _replay_archive_filter_block_message(
    active_filter_label: str,
) -> Optional[str]:
    """Explain why an archive backfill cannot run through a date filter."""
    label = str(active_filter_label or "").strip()
    if not label:
        return None
    return (
        f"Your saved replay filter is {label}. A filtered scan cannot archive "
        "your full replay library. In Settings, choose All time and click "
        "Save settings. Then return to Dashboard and click Re-sync replay "
        "library again."
    )


__all__ = [
    "GuiUI",
    "SettingsPayload",
    "can_use_gui",
    "_replay_archive_filter_block_message",
]
