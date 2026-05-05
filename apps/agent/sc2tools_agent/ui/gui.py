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
* Styling intentionally mirrors the website's dark theme tokens
  (``apps/web/app/globals.css``) so users get a coherent look from the
  installer through the desktop window into the dashboard.
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


# ---------------------------------------------------------------------
# Stylesheet — dark theme matched to apps/web/app/globals.css.
# ---------------------------------------------------------------------

# Pulled verbatim from globals.css :root[data-theme="dark"]. Keep these
# in sync if the website palette is rebranded.
_BG = "#0b0d12"
_SURFACE = "#11141b"
_ELEVATED = "#161a23"
_SUBTLE = "#1c2230"
_TEXT = "#e6e8ee"
_TEXT_MUTED = "#9aa3b2"
_TEXT_DIM = "#6b7280"
_ACCENT = "#7c8cff"
_ACCENT_HOVER = "#94a0ff"
_ACCENT_CYAN = "#3ec0c7"
_SUCCESS = "#3ec07a"
_WARNING = "#e6b450"
_DANGER = "#ff6b6b"
_BORDER = "#1f2533"
_BORDER_STRONG = "#2a3142"


_STYLE = f"""
QWidget {{
    background-color: {_BG};
    color: {_TEXT};
    font-family: 'Segoe UI', 'Inter', system-ui, -apple-system, Arial, sans-serif;
    font-size: 13px;
}}
QFrame#card {{
    background-color: {_SURFACE};
    border: 1px solid {_BORDER};
    border-radius: 10px;
}}
QFrame#cardElevated {{
    background-color: {_ELEVATED};
    border: 1px solid {_BORDER_STRONG};
    border-radius: 10px;
}}
QFrame#sidebar {{
    background-color: {_SURFACE};
    border-right: 1px solid {_BORDER};
}}
QLabel#h1 {{
    font-size: 22px;
    font-weight: 600;
    color: {_TEXT};
}}
QLabel#h2 {{
    font-size: 15px;
    font-weight: 600;
    color: {_TEXT};
}}
QLabel#muted {{
    color: {_TEXT_MUTED};
}}
QLabel#dim {{
    color: {_TEXT_DIM};
}}
QLabel#stat {{
    font-size: 24px;
    font-weight: 600;
    color: {_TEXT};
}}
QLabel#code {{
    font-family: 'Cascadia Mono', 'Consolas', 'Menlo', monospace;
    font-size: 44px;
    font-weight: 700;
    letter-spacing: 8px;
    color: {_ACCENT};
    background-color: {_SUBTLE};
    border: 1px solid {_BORDER_STRONG};
    border-radius: 8px;
    padding: 14px 24px;
}}
QLabel#badgeOk {{
    background-color: rgba(62, 192, 122, 0.16);
    color: {_SUCCESS};
    border-radius: 12px;
    padding: 4px 12px;
    font-weight: 600;
}}
QLabel#badgeWarn {{
    background-color: rgba(230, 180, 80, 0.16);
    color: {_WARNING};
    border-radius: 12px;
    padding: 4px 12px;
    font-weight: 600;
}}
QLabel#badgeErr {{
    background-color: rgba(255, 107, 107, 0.16);
    color: {_DANGER};
    border-radius: 12px;
    padding: 4px 12px;
    font-weight: 600;
}}
QLabel#badgeNeutral {{
    background-color: rgba(124, 140, 255, 0.16);
    color: {_ACCENT};
    border-radius: 12px;
    padding: 4px 12px;
    font-weight: 600;
}}
QPushButton {{
    background-color: {_ELEVATED};
    color: {_TEXT};
    border: 1px solid {_BORDER_STRONG};
    border-radius: 6px;
    padding: 7px 14px;
    font-weight: 500;
}}
QPushButton:hover {{
    background-color: {_SUBTLE};
    border-color: {_ACCENT};
}}
QPushButton:pressed {{
    background-color: {_BORDER_STRONG};
}}
QPushButton#primary {{
    background-color: {_ACCENT};
    color: #0b0d12;
    border: 1px solid {_ACCENT};
    font-weight: 600;
}}
QPushButton#primary:hover {{
    background-color: {_ACCENT_HOVER};
    border-color: {_ACCENT_HOVER};
}}
QPushButton#danger {{
    border-color: rgba(255, 107, 107, 0.4);
    color: {_DANGER};
}}
QPushButton#danger:hover {{
    background-color: rgba(255, 107, 107, 0.1);
    border-color: {_DANGER};
}}
QPushButton#navItem {{
    background-color: transparent;
    border: none;
    border-radius: 6px;
    padding: 9px 14px;
    text-align: left;
    color: {_TEXT_MUTED};
    font-weight: 500;
}}
QPushButton#navItem:hover {{
    background-color: {_ELEVATED};
    color: {_TEXT};
}}
QPushButton#navItem:checked {{
    background-color: {_ELEVATED};
    color: {_TEXT};
    border-left: 3px solid {_ACCENT};
}}
QLineEdit, QComboBox, QPlainTextEdit {{
    background-color: {_ELEVATED};
    color: {_TEXT};
    border: 1px solid {_BORDER_STRONG};
    border-radius: 6px;
    padding: 6px 10px;
    selection-background-color: {_ACCENT};
    selection-color: #0b0d12;
}}
QLineEdit:focus, QComboBox:focus, QPlainTextEdit:focus {{
    border-color: {_ACCENT};
}}
QComboBox::drop-down {{
    border: none;
}}
QCheckBox {{
    color: {_TEXT};
    spacing: 8px;
}}
QCheckBox::indicator {{
    width: 16px;
    height: 16px;
    border: 1px solid {_BORDER_STRONG};
    border-radius: 3px;
    background-color: {_ELEVATED};
}}
QCheckBox::indicator:checked {{
    background-color: {_ACCENT};
    border-color: {_ACCENT};
}}
QTableWidget {{
    background-color: {_SURFACE};
    border: 1px solid {_BORDER};
    border-radius: 8px;
    gridline-color: {_BORDER};
    selection-background-color: rgba(124, 140, 255, 0.18);
    selection-color: {_TEXT};
}}
QTableWidget::item {{
    padding: 6px 8px;
    border-bottom: 1px solid {_BORDER};
}}
QHeaderView::section {{
    background-color: {_ELEVATED};
    color: {_TEXT_MUTED};
    border: none;
    border-bottom: 1px solid {_BORDER_STRONG};
    padding: 8px;
    font-weight: 600;
}}
QPlainTextEdit#log {{
    font-family: 'Cascadia Mono', 'Consolas', 'Menlo', monospace;
    font-size: 12px;
    background-color: {_BG};
    border: 1px solid {_BORDER};
    border-radius: 8px;
    color: {_TEXT_MUTED};
}}
QScrollBar:vertical {{
    background: transparent;
    width: 10px;
    margin: 4px 2px;
}}
QScrollBar::handle:vertical {{
    background: {_BORDER_STRONG};
    border-radius: 4px;
    min-height: 24px;
}}
QScrollBar::handle:vertical:hover {{
    background: {_ACCENT};
}}
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{
    height: 0;
}}
"""


# ---------------------------------------------------------------------
# Settings DTO — what the GUI hands back when the user clicks "Save".
# ---------------------------------------------------------------------


class SettingsPayload:
    """Plain-data settings update from the GUI's Settings tab.

    Kept as a plain class (not a dataclass) so this module imports
    without ``dataclasses`` shenanigans on Python 3.8 / 3.9 stub
    environments. Fields use ``None`` to mean "no change" so the
    runner can update only what the user actually edited.
    """

    __slots__ = (
        "api_base",
        "log_level",
        "replay_folder",
        "autostart_enabled",
        "start_minimized",
    )

    def __init__(
        self,
        *,
        api_base: Optional[str] = None,
        log_level: Optional[str] = None,
        replay_folder: Optional[Path] = None,
        autostart_enabled: Optional[bool] = None,
        start_minimized: Optional[bool] = None,
    ) -> None:
        self.api_base = api_base
        self.log_level = log_level
        self.replay_folder = replay_folder
        self.autostart_enabled = autostart_enabled
        self.start_minimized = start_minimized


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
        on_pause: Callable[[bool], None],
        on_resync: Callable[[], None],
        on_choose_folder: Callable[[Optional[Path]], None],
        on_check_updates: Callable[[], None],
        on_save_settings: Callable[[SettingsPayload], None],
        on_quit: Callable[[], None],
        start_minimized: bool = False,
    ) -> None:
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
        self._start_minimized = start_minimized

        self._on_pause = on_pause
        self._on_resync = on_resync
        self._on_choose_folder = on_choose_folder
        self._on_check_updates = on_check_updates
        self._on_save_settings = on_save_settings
        self._on_quit = on_quit

        # Lazily populated at start()
        self._app = None
        self._window = None
        self._signals = None
        self._started_event = threading.Event()

    # ---------------- public sink interface ----------------

    def show_pairing_code(self, code: str) -> None:
        if self._signals:
            self._signals.pairingCode.emit(code)

    def on_paired(self, user_id: str) -> None:
        if self._signals:
            self._signals.paired.emit(user_id)

    def on_status(self, status: str) -> None:
        if self._signals:
            self._signals.status.emit(status)

    def on_upload_success(self, filename: str) -> None:
        if self._signals:
            self._signals.uploadSuccess.emit(filename)

    def on_upload_failed(self, filename: str, reason: str) -> None:
        if self._signals:
            self._signals.uploadFailed.emit(filename, reason)

    def on_pending(self, count: int) -> None:
        if self._signals:
            self._signals.pendingChanged.emit(int(count))

    def on_update_available(self, latest: str) -> None:
        if self._signals:
            self._signals.updateAvailable.emit(latest)

    def set_replay_folders(self, folders: List[Path]) -> None:
        if self._signals:
            self._signals.foldersChanged.emit([str(p) for p in folders])

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

        if self._start_minimized:
            log.info("gui_starting_minimized")
        else:
            window.show()

        self._started_event.set()

        rc = app.exec()
        log.info("gui_event_loop_exited rc=%s", rc)
        return rc

    def request_quit(self) -> None:
        """Ask the GUI to close (e.g. from the tray's Quit menu)."""
        if self._signals:
            self._signals.quitRequested.emit()

    def show_window(self) -> None:
        """Bring the window to the foreground (e.g. from a tray click)."""
        if self._signals:
            self._signals.showRequested.emit()

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
        pairingCode = QtCore.Signal(str)
        paired = QtCore.Signal(str)
        status = QtCore.Signal(str)
        uploadSuccess = QtCore.Signal(str)
        uploadFailed = QtCore.Signal(str, str)
        pendingChanged = QtCore.Signal(int)
        updateAvailable = QtCore.Signal(str)
        foldersChanged = QtCore.Signal(list)
        quitRequested = QtCore.Signal()
        showRequested = QtCore.Signal()

    return GuiSignals()


def _GuiSignals():  # noqa: N802 — class-style factory
    return _make_signals()


def _MainWindow(*, ui, signals, QtCore, QtGui, QtWidgets):  # noqa: N802
    """Build and return the main window."""

    class MainWindow(QtWidgets.QMainWindow):
        """Top-level window — sidebar nav + stacked content area."""

        # Cap the in-memory recent uploads. Anything past this falls off
        # the table; the cloud is the source of truth for the full list.
        MAX_RECENT = 100
        # Cap the live log buffer — the file on disk keeps everything;
        # this is just a tail.
        MAX_LOG_LINES = 800
        LOG_TAIL_INTERVAL_MS = 1500

        def __init__(self) -> None:
            super().__init__()
            self.setWindowTitle(f"SC2 Tools Agent  ·  v{ui._version}")
            self.resize(960, 640)
            self.setMinimumSize(820, 540)

            # Window icon — reuse the tray PNG so the alt-tab thumbnail
            # matches the system tray glyph.
            icon_path = Path(__file__).resolve().parent / "tray_icon.png"
            if icon_path.exists():
                self.setWindowIcon(QtGui.QIcon(str(icon_path)))

            self._status = "starting"
            self._paused = ui._initial_paused
            self._paired = ui._initial_paired
            self._user_id = ui._initial_user_id
            self._uploaded_count = 0
            self._pending_count = 0
            self._last_upload: Optional[tuple[str, datetime]] = None
            self._update_pending: Optional[str] = None
            self._recent: Deque[tuple[datetime, str, bool, str]] = deque(
                maxlen=self.MAX_RECENT,
            )
            self._log_offset = 0

            self._build_layout()
            self._wire_signals()
            self._refresh_status_card()
            self._refresh_pairing_card()
            self._populate_settings()
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
            self.setCentralWidget(central)

            outer = QtWidgets.QHBoxLayout(central)
            outer.setContentsMargins(0, 0, 0, 0)
            outer.setSpacing(0)

            outer.addWidget(self._build_sidebar())

            self._stack = QtWidgets.QStackedWidget()
            outer.addWidget(self._stack, stretch=1)

            self._stack.addWidget(self._build_dashboard())
            self._stack.addWidget(self._build_recent_tab())
            self._stack.addWidget(self._build_logs_tab())
            self._stack.addWidget(self._build_settings_tab())

        def _build_sidebar(self) -> QtWidgets.QWidget:
            frame = QtWidgets.QFrame()
            frame.setObjectName("sidebar")
            frame.setFixedWidth(220)

            layout = QtWidgets.QVBoxLayout(frame)
            layout.setContentsMargins(16, 18, 16, 16)
            layout.setSpacing(6)

            brand = QtWidgets.QLabel("SC2 Tools")
            brand.setObjectName("h2")
            layout.addWidget(brand)

            tagline = QtWidgets.QLabel("Local replay sync")
            tagline.setObjectName("dim")
            layout.addWidget(tagline)

            layout.addSpacing(20)

            self._nav_group = QtWidgets.QButtonGroup(self)
            self._nav_group.setExclusive(True)

            for index, label in enumerate(
                ["Dashboard", "Recent uploads", "Activity log", "Settings"],
            ):
                btn = QtWidgets.QPushButton(label)
                btn.setObjectName("navItem")
                btn.setCheckable(True)
                btn.setCursor(QtCore.Qt.PointingHandCursor)
                if index == 0:
                    btn.setChecked(True)
                btn.clicked.connect(
                    lambda _checked=False, i=index: self._stack.setCurrentIndex(i),
                )
                self._nav_group.addButton(btn, index)
                layout.addWidget(btn)

            layout.addStretch(1)

            self._sidebar_status = QtWidgets.QLabel()
            self._sidebar_status.setObjectName("muted")
            self._sidebar_status.setWordWrap(True)
            layout.addWidget(self._sidebar_status)

            version_lbl = QtWidgets.QLabel(f"v{ui._version}")
            version_lbl.setObjectName("dim")
            layout.addWidget(version_lbl)

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

            v.addWidget(self._build_status_card())
            v.addWidget(self._build_pairing_card())
            v.addWidget(self._build_stats_row())
            v.addWidget(self._build_action_row())
            v.addStretch(1)

            return page

        def _build_status_card(self) -> QtWidgets.QFrame:
            card = QtWidgets.QFrame()
            card.setObjectName("card")

            grid = QtWidgets.QGridLayout(card)
            grid.setContentsMargins(20, 18, 20, 18)
            grid.setHorizontalSpacing(14)
            grid.setVerticalSpacing(8)

            self._status_badge = QtWidgets.QLabel("Starting")
            self._status_badge.setObjectName("badgeNeutral")
            self._status_badge.setAlignment(QtCore.Qt.AlignCenter)
            grid.addWidget(self._status_badge, 0, 0)

            self._status_text = QtWidgets.QLabel("Initialising…")
            self._status_text.setObjectName("h2")
            grid.addWidget(self._status_text, 0, 1)

            self._status_sub = QtWidgets.QLabel("")
            self._status_sub.setObjectName("muted")
            grid.addWidget(self._status_sub, 1, 1)

            self._update_badge = QtWidgets.QLabel("")
            self._update_badge.setObjectName("badgeWarn")
            self._update_badge.hide()
            grid.addWidget(
                self._update_badge, 0, 2, alignment=QtCore.Qt.AlignRight,
            )

            grid.setColumnStretch(1, 1)
            return card

        def _build_pairing_card(self) -> QtWidgets.QFrame:
            card = QtWidgets.QFrame()
            card.setObjectName("cardElevated")
            self._pairing_card = card

            v = QtWidgets.QVBoxLayout(card)
            v.setContentsMargins(20, 18, 20, 20)
            v.setSpacing(12)

            heading = QtWidgets.QLabel("Pair this device")
            heading.setObjectName("h2")
            v.addWidget(heading)

            sub = QtWidgets.QLabel(
                "Enter the code below at the pairing page to link this "
                "agent to your SC2 Tools account.",
            )
            sub.setObjectName("muted")
            sub.setWordWrap(True)
            v.addWidget(sub)

            self._pairing_code_label = QtWidgets.QLabel("------")
            self._pairing_code_label.setObjectName("code")
            self._pairing_code_label.setAlignment(QtCore.Qt.AlignCenter)
            v.addWidget(self._pairing_code_label)

            row = QtWidgets.QHBoxLayout()
            row.setSpacing(8)

            copy_btn = QtWidgets.QPushButton("Copy code")
            copy_btn.clicked.connect(self._copy_pairing_code)
            row.addWidget(copy_btn)

            open_btn = QtWidgets.QPushButton("Open pairing page")
            open_btn.setObjectName("primary")
            open_btn.clicked.connect(self._open_pairing_page)
            row.addWidget(open_btn)

            row.addStretch(1)

            self._pairing_url_label = QtWidgets.QLabel(ui._pairing_url)
            self._pairing_url_label.setObjectName("dim")
            self._pairing_url_label.setTextInteractionFlags(
                QtCore.Qt.TextSelectableByMouse,
            )
            row.addWidget(self._pairing_url_label)

            v.addLayout(row)
            return card

        def _build_stats_row(self) -> QtWidgets.QWidget:
            row = QtWidgets.QFrame()
            h = QtWidgets.QHBoxLayout(row)
            h.setContentsMargins(0, 0, 0, 0)
            h.setSpacing(14)

            self._stat_synced = self._make_stat_card("Synced", "0")
            self._stat_queued = self._make_stat_card("Queued", "0")
            self._stat_last = self._make_stat_card("Last upload", "—")

            for w in (self._stat_synced, self._stat_queued, self._stat_last):
                h.addWidget(w["frame"], stretch=1)

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
            v.addWidget(label_lbl)

            return {"frame": card, "value": value_lbl, "label": label_lbl}

        def _build_action_row(self) -> QtWidgets.QWidget:
            row = QtWidgets.QFrame()
            h = QtWidgets.QHBoxLayout(row)
            h.setContentsMargins(0, 0, 0, 0)
            h.setSpacing(8)

            self._pause_btn = QtWidgets.QPushButton(
                "Resume syncing" if self._paused else "Pause syncing",
            )
            self._pause_btn.clicked.connect(self._click_pause)
            h.addWidget(self._pause_btn)

            resync_btn = QtWidgets.QPushButton("Re-sync from scratch")
            resync_btn.clicked.connect(self._click_resync)
            h.addWidget(resync_btn)

            choose_btn = QtWidgets.QPushButton("Choose replay folder…")
            choose_btn.clicked.connect(self._click_choose_folder)
            h.addWidget(choose_btn)

            h.addStretch(1)

            updates_btn = QtWidgets.QPushButton("Check for updates")
            updates_btn.clicked.connect(self._click_check_updates)
            h.addWidget(updates_btn)

            dash_btn = QtWidgets.QPushButton("Open dashboard")
            dash_btn.setObjectName("primary")
            dash_btn.clicked.connect(self._open_dashboard)
            h.addWidget(dash_btn)

            return row

        # ---- Recent tab ----

        def _build_recent_tab(self) -> QtWidgets.QWidget:
            page = QtWidgets.QWidget()
            v = QtWidgets.QVBoxLayout(page)
            v.setContentsMargins(28, 24, 28, 24)
            v.setSpacing(14)

            title = QtWidgets.QLabel("Recent uploads")
            title.setObjectName("h1")
            v.addWidget(title)

            sub = QtWidgets.QLabel(
                "Most recent first. Double-click a row to reveal the "
                "replay in Explorer.",
            )
            sub.setObjectName("muted")
            v.addWidget(sub)

            self._recent_table = QtWidgets.QTableWidget(0, 3)
            self._recent_table.setHorizontalHeaderLabels(
                ["Time", "Replay", "Status"],
            )
            self._recent_table.verticalHeader().setVisible(False)
            self._recent_table.setEditTriggers(
                QtWidgets.QAbstractItemView.NoEditTriggers,
            )
            self._recent_table.setSelectionBehavior(
                QtWidgets.QAbstractItemView.SelectRows,
            )
            self._recent_table.setShowGrid(False)
            self._recent_table.setAlternatingRowColors(False)
            header = self._recent_table.horizontalHeader()
            header.setSectionResizeMode(
                0, QtWidgets.QHeaderView.ResizeToContents,
            )
            header.setSectionResizeMode(1, QtWidgets.QHeaderView.Stretch)
            header.setSectionResizeMode(
                2, QtWidgets.QHeaderView.ResizeToContents,
            )
            self._recent_table.itemDoubleClicked.connect(self._reveal_replay)
            v.addWidget(self._recent_table, stretch=1)

            return page

        # ---- Logs tab ----

        def _build_logs_tab(self) -> QtWidgets.QWidget:
            page = QtWidgets.QWidget()
            v = QtWidgets.QVBoxLayout(page)
            v.setContentsMargins(28, 24, 28, 24)
            v.setSpacing(14)

            top = QtWidgets.QHBoxLayout()
            top.setSpacing(10)

            title = QtWidgets.QLabel("Activity log")
            title.setObjectName("h1")
            top.addWidget(title)

            top.addStretch(1)

            self._log_filter_combo = QtWidgets.QComboBox()
            self._log_filter_combo.addItems(
                ["All", "INFO+", "WARNING+", "ERROR only"],
            )
            self._log_filter_combo.currentIndexChanged.connect(
                lambda _i: self._render_log(),
            )
            top.addWidget(QtWidgets.QLabel("Filter:"))
            top.addWidget(self._log_filter_combo)

            open_dir_btn = QtWidgets.QPushButton("Open log folder")
            open_dir_btn.clicked.connect(self._open_log_folder)
            top.addWidget(open_dir_btn)

            v.addLayout(top)

            self._log_view = QtWidgets.QPlainTextEdit()
            self._log_view.setObjectName("log")
            self._log_view.setReadOnly(True)
            self._log_view.setLineWrapMode(QtWidgets.QPlainTextEdit.NoWrap)
            v.addWidget(self._log_view, stretch=1)

            self._log_lines: Deque[str] = deque(maxlen=self.MAX_LOG_LINES)
            return page

        # ---- Settings tab ----

        def _build_settings_tab(self) -> QtWidgets.QWidget:
            page = QtWidgets.QWidget()
            v = QtWidgets.QVBoxLayout(page)
            v.setContentsMargins(28, 24, 28, 24)
            v.setSpacing(14)

            title = QtWidgets.QLabel("Settings")
            title.setObjectName("h1")
            v.addWidget(title)

            form_card = QtWidgets.QFrame()
            form_card.setObjectName("card")
            form = QtWidgets.QFormLayout(form_card)
            form.setContentsMargins(20, 18, 20, 18)
            form.setHorizontalSpacing(20)
            form.setVerticalSpacing(14)
            form.setLabelAlignment(QtCore.Qt.AlignRight | QtCore.Qt.AlignVCenter)

            self._api_input = QtWidgets.QLineEdit()
            self._api_input.setPlaceholderText(
                "e.g. https://api.sc2tools.app  (leave blank for default)",
            )
            form.addRow("API base URL", self._api_input)

            self._log_combo = QtWidgets.QComboBox()
            self._log_combo.addItems(["INFO", "DEBUG", "WARNING", "ERROR"])
            form.addRow("Log level", self._log_combo)

            folder_row = QtWidgets.QHBoxLayout()
            folder_row.setSpacing(8)
            self._folder_input = QtWidgets.QLineEdit()
            self._folder_input.setReadOnly(True)
            self._folder_input.setPlaceholderText(
                "Auto-detect SC2 Replays folder",
            )
            folder_row.addWidget(self._folder_input, stretch=1)
            browse_btn = QtWidgets.QPushButton("Browse…")
            browse_btn.clicked.connect(self._browse_folder)
            folder_row.addWidget(browse_btn)
            clear_btn = QtWidgets.QPushButton("Clear")
            clear_btn.clicked.connect(lambda: self._folder_input.setText(""))
            folder_row.addWidget(clear_btn)
            form.addRow("Replay folder", folder_row)

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

            v.addWidget(form_card)

            row = QtWidgets.QHBoxLayout()
            row.addStretch(1)
            self._settings_status = QtWidgets.QLabel("")
            self._settings_status.setObjectName("muted")
            row.addWidget(self._settings_status)
            save_btn = QtWidgets.QPushButton("Save settings")
            save_btn.setObjectName("primary")
            save_btn.clicked.connect(self._click_save_settings)
            row.addWidget(save_btn)
            v.addLayout(row)

            v.addStretch(1)
            return page

        # ---- signal wiring ----

        def _wire_signals(self) -> None:
            signals.pairingCode.connect(self._on_pairing_code)
            signals.paired.connect(self._on_paired)
            signals.status.connect(self._on_status)
            signals.uploadSuccess.connect(self._on_upload_success)
            signals.uploadFailed.connect(self._on_upload_failed)
            signals.pendingChanged.connect(self._on_pending_changed)
            signals.updateAvailable.connect(self._on_update_available)
            signals.foldersChanged.connect(self._on_folders_changed)
            signals.quitRequested.connect(self._on_quit_requested)
            signals.showRequested.connect(self._on_show_requested)

        # ---- signal handlers (always on the GUI thread) ----

        def _on_pairing_code(self, code: str) -> None:
            self._paired = False
            self._status = f"Awaiting pairing — code {code}"
            self._pairing_code_label.setText(code)
            self._refresh_pairing_card()
            self._refresh_status_card()
            # Bring window forward so the user actually sees the code.
            if not self.isVisible():
                self.showNormal()
                self.raise_()

        def _on_paired(self, user_id: str) -> None:
            self._paired = True
            self._user_id = user_id
            self._status = "paired"
            self._refresh_pairing_card()
            self._refresh_status_card()

        def _on_status(self, status: str) -> None:
            self._status = status
            self._refresh_status_card()

        def _on_upload_success(self, filename: str) -> None:
            self._uploaded_count += 1
            self._pending_count = max(0, self._pending_count - 1)
            self._last_upload = (filename, datetime.now())
            self._recent.appendleft(
                (datetime.now(), filename, True, "Uploaded"),
            )
            self._refresh_status_card()
            self._refresh_stats()
            self._refresh_recent()

        def _on_upload_failed(self, filename: str, reason: str) -> None:
            self._recent.appendleft(
                (datetime.now(), filename, False, reason or "Failed"),
            )
            self._refresh_recent()

        def _on_pending_changed(self, count: int) -> None:
            self._pending_count = int(count)
            self._refresh_stats()

        def _on_update_available(self, latest: str) -> None:
            self._update_pending = latest
            self._update_badge.setText(f"Update available: v{latest}")
            self._update_badge.show()

        def _on_folders_changed(self, folders: List[str]) -> None:
            ui._replay_folders = [Path(p) for p in folders]
            if folders:
                self._folder_input.setText(folders[0])
            self._refresh_status_card()

        def _on_quit_requested(self) -> None:
            self._really_quit = True
            QtWidgets.QApplication.instance().quit()

        def _on_show_requested(self) -> None:
            self.showNormal()
            self.raise_()
            self.activateWindow()

        # ---- click handlers ----

        def _click_pause(self) -> None:
            self._paused = not self._paused
            self._pause_btn.setText(
                "Resume syncing" if self._paused else "Pause syncing",
            )
            self._refresh_status_card()
            try:
                ui._on_pause(self._paused)
            except Exception:  # noqa: BLE001
                log.exception("gui_pause_callback_failed")

        def _click_resync(self) -> None:
            confirm = QtWidgets.QMessageBox.question(
                self,
                "Re-sync from scratch?",
                "This clears the local upload cursor and re-uploads every "
                "replay we can see. The cloud de-duplicates by game ID, "
                "so existing records are not overwritten — but it can "
                "take a while if you have hundreds of replays.\n\n"
                "Proceed?",
                QtWidgets.QMessageBox.Yes | QtWidgets.QMessageBox.No,
                QtWidgets.QMessageBox.No,
            )
            if confirm != QtWidgets.QMessageBox.Yes:
                return
            try:
                ui._on_resync()
            except Exception:  # noqa: BLE001
                log.exception("gui_resync_failed")

        def _click_choose_folder(self) -> None:
            picked = QtWidgets.QFileDialog.getExistingDirectory(
                self,
                "Choose your StarCraft II Replays folder",
                str(ui._replay_folders[0]) if ui._replay_folders else "",
            )
            if not picked:
                return
            try:
                ui._on_choose_folder(Path(picked))
            except Exception:  # noqa: BLE001
                log.exception("gui_choose_folder_failed")

        def _click_check_updates(self) -> None:
            try:
                ui._on_check_updates()
            except Exception:  # noqa: BLE001
                log.exception("gui_check_updates_failed")

        def _click_save_settings(self) -> None:
            payload = SettingsPayload(
                api_base=self._api_input.text().strip() or None,
                log_level=self._log_combo.currentText(),
                replay_folder=(
                    Path(self._folder_input.text().strip())
                    if self._folder_input.text().strip()
                    else None
                ),
                autostart_enabled=self._autostart_check.isChecked(),
                start_minimized=self._minimized_check.isChecked(),
            )
            try:
                ui._on_save_settings(payload)
                self._settings_status.setText(
                    "Saved · changes apply on next start",
                )
                QtCore.QTimer.singleShot(
                    4000, lambda: self._settings_status.setText(""),
                )
            except Exception as exc:  # noqa: BLE001
                log.exception("gui_save_settings_failed")
                self._settings_status.setText(f"Save failed: {exc}")

        def _copy_pairing_code(self) -> None:
            code = self._pairing_code_label.text()
            if not code or "-" in code and len(set(code)) <= 1:
                return
            QtWidgets.QApplication.clipboard().setText(code)
            self._status_sub.setText("Pairing code copied to clipboard")

        def _open_pairing_page(self) -> None:
            try:
                webbrowser.open(ui._pairing_url, new=2)
            except Exception:  # noqa: BLE001
                log.exception("gui_open_pairing_failed")

        def _open_dashboard(self) -> None:
            try:
                webbrowser.open(ui._dashboard_url, new=2)
            except Exception:  # noqa: BLE001
                log.exception("gui_open_dashboard_failed")

        def _open_log_folder(self) -> None:
            _open_path_in_explorer(ui._log_dir)

        def _browse_folder(self) -> None:
            picked = QtWidgets.QFileDialog.getExistingDirectory(
                self,
                "Choose your StarCraft II Replays folder",
                self._folder_input.text() or "",
            )
            if picked:
                self._folder_input.setText(picked)

        def _reveal_replay(
            self, item: "QtWidgets.QTableWidgetItem",
        ) -> None:
            row = item.row()
            name_item = self._recent_table.item(row, 1)
            if not name_item:
                return
            payload = name_item.data(QtCore.Qt.UserRole)
            if not payload:
                return
            target = Path(payload)
            # The recent list stores filenames, not full paths, so we
            # fall back to opening the watched folder if we can't find
            # the file. (We don't keep a path-resolved cache to avoid
            # leaking absolute paths in the GUI's in-memory state.)
            if target.exists():
                _open_path_in_explorer(target.parent)
            elif ui._replay_folders:
                _open_path_in_explorer(ui._replay_folders[0])

        # ---- close behaviour ----

        _really_quit = False

        def closeEvent(self, event) -> None:  # noqa: N802 — Qt API
            # Default behaviour: hide-to-tray. Quitting only happens
            # through the tray's Quit action (which calls
            # signals.quitRequested).
            if self._really_quit:
                event.accept()
                return
            event.ignore()
            self.hide()

        # ---- refresh helpers ----

        def _refresh_status_card(self) -> None:
            badge_text, badge_obj = self._classify_status()
            self._status_badge.setText(badge_text)
            self._status_badge.setObjectName(badge_obj)
            self._status_badge.style().unpolish(self._status_badge)
            self._status_badge.style().polish(self._status_badge)

            primary, secondary = self._format_status_lines()
            self._status_text.setText(primary)
            self._status_sub.setText(secondary)
            self._sidebar_status.setText(f"{badge_text} · {primary}")

        def _classify_status(self) -> tuple[str, str]:
            status_lower = (self._status or "").lower()
            if not self._paired:
                return ("Pairing", "badgeWarn")
            if self._paused:
                return ("Paused", "badgeWarn")
            if "error" in status_lower or "fail" in status_lower:
                return ("Error", "badgeErr")
            if "watching" in status_lower or "ready" in status_lower:
                return ("Active", "badgeOk")
            return ("Active", "badgeNeutral")

        def _format_status_lines(self) -> tuple[str, str]:
            if not self._paired:
                primary = "Waiting for you to enter the pairing code"
                secondary = (
                    f"Open {ui._pairing_url} on a logged-in browser "
                    "to finish."
                )
                return primary, secondary
            if self._paused:
                return (
                    "Sync paused",
                    "Replays will keep accumulating; press Resume to "
                    "drain the queue.",
                )
            folder = (
                str(ui._replay_folders[0])
                if ui._replay_folders
                else "(no folder configured)"
            )
            primary = "Watching for replays"
            secondary = f"Folder: {folder}  ·  API: {ui._api_base}"
            return primary, secondary

        def _refresh_pairing_card(self) -> None:
            # Hide the whole pairing card once we're paired so the
            # dashboard's hero spot is freed up for the live stats.
            self._pairing_card.setVisible(not self._paired)

        def _refresh_stats(self) -> None:
            self._stat_synced["value"].setText(str(self._uploaded_count))
            self._stat_queued["value"].setText(str(self._pending_count))
            if self._last_upload:
                _, ts = self._last_upload
                self._stat_last["value"].setText(ts.strftime("%H:%M:%S"))
            else:
                self._stat_last["value"].setText("—")

        def _refresh_recent(self) -> None:
            self._recent_table.setRowCount(len(self._recent))
            for row, (ts, name, ok, detail) in enumerate(self._recent):
                ts_item = QtWidgets.QTableWidgetItem(
                    ts.strftime("%Y-%m-%d %H:%M:%S"),
                )
                ts_item.setForeground(QtGui.QColor(_TEXT_MUTED))

                name_item = QtWidgets.QTableWidgetItem(name)
                # Stash the filename so doubleClick can resolve it
                # against the watched folder.
                if ui._replay_folders:
                    name_item.setData(
                        QtCore.Qt.UserRole,
                        str(ui._replay_folders[0] / name),
                    )

                status_item = QtWidgets.QTableWidgetItem(
                    "✓ " + detail if ok else "✗ " + detail,
                )
                status_item.setForeground(
                    QtGui.QColor(_SUCCESS if ok else _DANGER),
                )

                self._recent_table.setItem(row, 0, ts_item)
                self._recent_table.setItem(row, 1, name_item)
                self._recent_table.setItem(row, 2, status_item)

        def _populate_settings(self) -> None:
            initial = ui._initial_settings
            if initial.api_base:
                self._api_input.setText(initial.api_base)
            if initial.log_level:
                idx = self._log_combo.findText(
                    initial.log_level, QtCore.Qt.MatchFixedString,
                )
                if idx >= 0:
                    self._log_combo.setCurrentIndex(idx)
            if initial.replay_folder:
                self._folder_input.setText(str(initial.replay_folder))
            elif ui._replay_folders:
                self._folder_input.setText(str(ui._replay_folders[0]))
            self._autostart_check.setChecked(
                bool(initial.autostart_enabled),
            )
            self._minimized_check.setChecked(
                bool(initial.start_minimized),
            )

        # ---- log tail ----

        def _tail_log_now(self) -> None:
            try:
                if not ui._log_file.exists():
                    return
                size = ui._log_file.stat().st_size
                if size < self._log_offset:
                    # Log was rotated — start over.
                    self._log_offset = 0
                if size == self._log_offset:
                    return
                with ui._log_file.open("r", encoding="utf-8", errors="replace") as fh:
                    fh.seek(self._log_offset)
                    chunk = fh.read()
                    self._log_offset = fh.tell()
                for line in chunk.splitlines():
                    self._log_lines.append(line)
                self._render_log()
            except OSError:
                # File temporarily unavailable (rotation, permission).
                # We'll catch up on the next tick.
                log.debug("log_tail_failed", exc_info=True)

        def _render_log(self) -> None:
            level = self._log_filter_combo.currentText()
            visible = [line for line in self._log_lines if _matches_level(line, level)]
            scrollbar = self._log_view.verticalScrollBar()
            at_bottom = (
                scrollbar.value() >= scrollbar.maximum() - 4
            )
            self._log_view.setPlainText("\n".join(visible))
            if at_bottom:
                scrollbar.setValue(scrollbar.maximum())

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


__all__ = [
    "GuiUI",
    "SettingsPayload",
    "can_use_gui",
]
