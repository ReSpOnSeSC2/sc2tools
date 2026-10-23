"""System-tray icon UI.

Pystray draws a tiny indicator with a context menu:

    Status: paired · 437 synced · 0 queued
    Last upload: foo.SC2Replay  (12:34:56)
    Watching: C:\\Users\\…\\Replays\\Multiplayer
    ─────────────────
    Open agent window      (default — double-click the icon)
    Open dashboard
    Build check-in…        (GUI mode — reopens the last end card)
    Pause syncing
    Open log folder
    Re-sync from scratch
    Choose replay folder…
    Check for updates
    ─────────────────
    Quit

We avoid a hard dependency on pystray + Pillow at import time so an
agent install without the GUI extras (e.g. CI environment) degrades to
the console UI rather than crashing. ``can_use_tray()`` does the probe.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from datetime import datetime
from pathlib import Path
from typing import Callable, List, Optional

from .tray_images import _square_pad, render_tray_image, dot_color

log = logging.getLogger(__name__)


def can_use_tray() -> bool:
    try:
        import pystray  # noqa: F401
        import PIL  # noqa: F401
        return True
    except ImportError:
        return False


class TrayUI:
    """Owns the system tray icon, multi-line tooltip, and menu actions.

    Construction is cheap; :meth:`start` builds the underlying pystray
    icon and runs the event loop on a background thread.
    """

    def __init__(
        self,
        *,
        dashboard_url: str,
        log_dir: Optional[Path] = None,
        replay_folders: Optional[List[Path]] = None,
        on_pause: Optional[Callable[[bool], None]] = None,
        on_resync: Optional[Callable[[], None]] = None,
        on_choose_folder: Optional[Callable[[Optional[Path]], None]] = None,
        on_check_updates: Optional[Callable[[], None]] = None,
        on_show_window: Optional[Callable[[], None]] = None,
        on_build_checkin: Optional[Callable[[], None]] = None,
        synced_count_provider: Optional[Callable[[], int]] = None,
        initial_paused: bool = False,
        initial_paused_until=None,
        on_pause_for=None,
        on_install_update=None,
    ) -> None:
        self._on_pause_for = on_pause_for
        self._on_install_update = on_install_update
        self._status_view = None
        self._icon_images = {}
        self._icon_color = object()
        self._base_icon = None
        self._paused_until = initial_paused_until
        self._dashboard_url = dashboard_url
        self._log_dir = log_dir
        self._replay_folders: List[Path] = list(replay_folders or [])
        self._on_pause_cb = on_pause
        self._on_resync_cb = on_resync
        self._on_choose_folder_cb = on_choose_folder
        self._on_check_updates_cb = on_check_updates
        # Brings the main window back after a hide-to-tray close. When
        # provided it becomes the menu's first item AND the icon's
        # default action (double-click). Without it (no-GUI installs)
        # the item is omitted.
        self._on_show_window_cb = on_show_window
        # "Build check-in…": re-opens the newest end card the player has
        # not answered, else the web queue. Omitted when not wired.
        self._on_build_checkin_cb = on_build_checkin
        # Same authoritative synced-total source the GUI stat card
        # uses (count over state.uploaded's dated entries). Without it
        # the tooltip falls back to the legacy session-local counter,
        # which starts at 0 every launch.
        self._synced_count_provider = synced_count_provider
        self._stop_cb: Optional[Callable[[], None]] = None
        self._icon: Optional[object] = None
        self._lock = threading.Lock()
        self._status = "starting"
        self._uploaded = self._query_synced(default=0)
        self._pending = 0
        self._paired = False
        self._paused = initial_paused
        self._last_upload_name: Optional[str] = None
        self._last_upload_at: Optional[datetime] = None
        self._update_pending: Optional[str] = None

    # ---------------- lifecycle ----------------

    def start(self, *, on_quit: Callable[[], None]) -> None:
        import pystray
        from PIL import Image, ImageDraw

        self._stop_cb = on_quit
        icon_img = self._load_icon_image()
        self._base_icon = icon_img

        self._icon = pystray.Icon(
            "sc2tools-agent",
            icon_img,
            self._tooltip(),
            menu=self._build_menu(pystray),
        )
        threading.Thread(
            target=self._icon.run,
            name="sc2tools-tray",
            daemon=True,
        ).start()

    def stop(self) -> None:
        if self._icon and hasattr(self._icon, "stop"):
            try:
                self._icon.stop()
            except Exception:  # noqa: BLE001
                pass

    # ---------------- icon image ----------------

    def _load_icon_image(self):
        """Return a Pillow Image for the tray icon.

        Loads ``sc2tools_agent/ui/tray_icon.png`` if present; falls back
        to a small procedural icon so the agent never crashes if the
        asset is missing or unreadable.
        """
        from PIL import Image, ImageDraw

        icon_path = Path(__file__).resolve().parent / "tray_icon.png"
        if icon_path.exists():
            try:
                img = Image.open(icon_path)
                # Tray icons render best at 64×64 on Windows. RGBA so
                # transparency around the logo doesn't get filled in.
                img = img.convert("RGBA")
                img = _square_pad(img).resize((64, 64), Image.Resampling.LANCZOS)
                return img
            except Exception:  # noqa: BLE001
                # Asset is corrupt — fall through to the procedural icon.
                pass

        icon_img = Image.new("RGB", (64, 64), color=(124, 140, 255))
        draw = ImageDraw.Draw(icon_img)
        draw.text((18, 16), "SC2", fill=(11, 13, 18))
        return icon_img

    def _query_synced(self, default: int) -> int:
        """Read the authoritative synced total; fall back to the
        session-local counter when no provider is wired."""
        provider = self._synced_count_provider
        if provider is None:
            return default
        try:
            return int(provider())
        except Exception:  # noqa: BLE001
            return default

    # ---------------- callbacks from the runner ----------------

    def on_phase(self, phase, detail=""):
        self.on_status(detail if phase=="boot_error" else phase)

    def on_analyzer_probe(self, ok, diag):
        if not ok:
            self.on_status("Replay analyzer unavailable")

    def on_paused(self, paused, until=None):
        with self._lock:
            self._paused, self._paused_until = paused, until
        self._refresh()

    def on_status_view(self, view):
        with self._lock:
            self._status_view = view
        self._refresh()

    def show_notice(self, message: str, *, title: str = "SC2 Tools Agent") -> None:
        """Show an OS notification without opening or focusing a window."""
        icon = self._icon
        if icon is not None and hasattr(icon, "notify"):
            icon.notify(str(message), str(title))

    def show_pairing_code(self, code: str) -> None:
        with self._lock:
            self._status = f"pairing — code {code}"
        self._refresh()

    def on_unlinked(self) -> None:
        with self._lock:
            self._paired = False
            self._status = "This PC was unlinked - link again in SC2 Tools"
        self._refresh()

    def on_paired(self, user_id: str) -> None:  # noqa: ARG002
        with self._lock:
            self._paired = True
            self._status = "paired"
        self._refresh()

    def on_status(self, status: str) -> None:
        with self._lock:
            self._status = status
        self._refresh()

    def on_upload_success(self, filename: str) -> None:
        with self._lock:
            self._uploaded = self._query_synced(default=self._uploaded + 1)
            self._pending = max(0, self._pending - 1)
            self._last_upload_name = filename
            self._last_upload_at = datetime.now()
        self._refresh()

    def on_upload_failed(self, _filename: str, _reason: str) -> None:
        self._refresh()

    def on_pending(self, count: int) -> None:
        with self._lock:
            self._pending = count
        self._refresh()

    def on_update_available(self, latest_version: str) -> None:
        with self._lock:
            self._update_pending = latest_version
        self._refresh()

    def set_replay_folders(self, folders: List[Path]) -> None:
        with self._lock:
            self._replay_folders = list(folders)
        self._refresh()

    # ---------------- menu builders ----------------

    def _build_menu(self, pystray):
        items = [pystray.MenuItem(self._title, None, enabled=False),
                 pystray.MenuItem(self._second_line, None, enabled=False),
                 pystray.MenuItem(self._third_line, None, enabled=False), pystray.Menu.SEPARATOR]
        if self._update_pending and self._on_install_update:
            items.append(pystray.MenuItem(f"Install update v{self._update_pending}", lambda *_: self._on_install_update()))
        if self._on_show_window_cb:
            items.append(pystray.MenuItem("Open SC2 Tools", self._show_window_clicked, default=True))
        items.append(pystray.MenuItem("Open dashboard", self._open_dashboard))
        if self._on_build_checkin_cb:
            items.append(pystray.MenuItem("Build check-in…", self._build_checkin_clicked))
        items.append(pystray.MenuItem(self._pause_label, self._toggle_pause))
        if self._on_pause_for:
            items.append(pystray.MenuItem("Pause", pystray.Menu(
                pystray.MenuItem("Pause for 1 hour", lambda *_: self._on_pause_for(time.time()+3600)),
                pystray.MenuItem("Pause until I resume", lambda *_: self._on_pause_for(None)))))
        items.append(pystray.Menu.SEPARATOR)
        items.append(pystray.MenuItem("More", pystray.Menu(
            pystray.MenuItem("Add replay folder…", self._choose_folder_clicked),
            pystray.MenuItem("Re-sync library…", self._resync_clicked),
            pystray.MenuItem("Open log folder", self._open_log_folder, enabled=self._log_dir_enabled),
            pystray.MenuItem("Check for updates", self._check_updates_clicked))))
        items.extend([pystray.Menu.SEPARATOR,pystray.MenuItem("Quit",self._quit_clicked)])
        return pystray.Menu(*items)

    # ---------------- per-menu-item helpers ----------------

    def _title(self, _icon) -> str:
        with self._lock:
            if self._status_view:
                deadline = " · " + self._status_view.cause if self._paused_until and self._paused else ""
                return f"{self._status_view.badge_text} · {self._status_view.headline}{deadline}"
            paused_marker = "Paused · " if self._paused else ""
            if self._paused and self._paused_until:
                paused_marker = "Paused until " + datetime.fromtimestamp(self._paused_until).strftime("%H:%M") + " · "
            base = "Paired" if self._paired else self._status
            return (
                f"{paused_marker}{base} · {self._uploaded} synced · "
                f"{self._pending} queued"
            )

    def _second_line(self, _icon) -> str:
        with self._lock:
            if self._last_upload_name and self._last_upload_at:
                ts = self._last_upload_at.strftime("%H:%M:%S")
                trimmed = self._last_upload_name
                if len(trimmed) > 40:
                    trimmed = trimmed[:37] + "…"
                return f"Last upload: {trimmed} ({ts})"
            return "Last upload: —"

    def _third_line(self, _icon) -> str:
        with self._lock:
            if self._update_pending:
                return f"Update available: {self._update_pending}"
            if not self._replay_folders:
                return "Watching: (no folder)"
            root = str(self._replay_folders[0])
            if len(root) > 56:
                root = "…" + root[-55:]
            if len(self._replay_folders) > 1:
                extra = len(self._replay_folders) - 1
                return f"Watching: {root}  (+{extra} more)"
            return f"Watching: {root}"

    def _pause_label(self, _icon) -> str:
        with self._lock:
            return "Resume syncing" if self._paused else "Pause syncing"

    def _log_dir_enabled(self, _menu_item) -> bool:
        return self._log_dir is not None and Path(self._log_dir).exists()

    # ---------------- click handlers ----------------

    def _show_window_clicked(self, _icon, _item) -> None:
        if not self._on_show_window_cb:
            return
        try:
            self._on_show_window_cb()
        except Exception:  # noqa: BLE001
            log.exception("show_window_failed")

    def _build_checkin_clicked(self, _icon, _item) -> None:
        if not self._on_build_checkin_cb:
            return
        try:
            self._on_build_checkin_cb()
        except Exception:  # noqa: BLE001
            log.exception("build_checkin_open_failed")

    def _open_dashboard(self, _icon, _item) -> None:
        try:
            webbrowser.open(self._dashboard_url, new=2)
        except Exception:  # noqa: BLE001
            log.exception("dashboard_open_failed")

    def _toggle_pause(self, _icon, _item) -> None:
        with self._lock:
            self._paused = not self._paused
            new_state = self._paused
        self._refresh()
        if self._on_pause_cb:
            try:
                self._on_pause_cb(new_state)
            except Exception:  # noqa: BLE001
                log.exception("pause_callback_failed")

    def _open_log_folder(self, _icon, _item) -> None:
        if not self._log_dir:
            return
        path = Path(self._log_dir)
        if not path.exists():
            return
        try:
            _open_path_in_explorer(path)
        except Exception:  # noqa: BLE001
            log.exception("open_log_folder_failed")

    def _resync_clicked(self, _icon, _item) -> None:
        if not self._on_resync_cb:
            return
        if self._paused:
            self.show_notice("Resume syncing before re-syncing the replay library.")
            return
        try:
            self._on_resync_cb()
        except Exception:  # noqa: BLE001
            log.exception("resync_failed")

    def _choose_folder_clicked(self, _icon, _item) -> None:
        if not self._on_choose_folder_cb:
            return
        if self._on_show_window_cb:
            self._on_show_window_cb()
            self._on_choose_folder_cb(None)
            return
        # Headless mode retains the standalone picker.
        threading.Thread(
            target=self._choose_folder_worker,
            name="sc2tools-folder-pick",
            daemon=True,
        ).start()

    def _choose_folder_worker(self) -> None:
        try:
            picked = _show_folder_picker()
        except Exception:  # noqa: BLE001
            log.exception("folder_picker_failed")
            picked = None
        try:
            if self._on_choose_folder_cb:
                self._on_choose_folder_cb(picked)
        except Exception:  # noqa: BLE001
            log.exception("choose_folder_callback_failed")

    def _check_updates_clicked(self, _icon, _item) -> None:
        if not self._on_check_updates_cb:
            return
        try:
            self._on_check_updates_cb()
        except Exception:  # noqa: BLE001
            log.exception("check_updates_failed")

    def _quit_clicked(self, _icon, _item) -> None:
        self.stop()
        if self._stop_cb:
            self._stop_cb()

    # ---------------- internal refresh ----------------

    def _tooltip(self) -> str:
        return self._title(None)

    def _refresh(self) -> None:
        if not self._icon:
            return
        if hasattr(self._icon, "title"):
            try:
                self._icon.title = "SC2 Tools - " + self._status_view.headline if self._status_view else self._tooltip()
            except Exception:  # noqa: BLE001
                pass
        if self._status_view:
            color = dot_color(self._status_view)
            if color != self._icon_color:
                base = self._base_icon or self._load_icon_image()
                if color not in self._icon_images:
                    self._icon_images[color] = render_tray_image(base, color)
                self._icon.icon = self._icon_images[color]
                self._icon_color = color
        if hasattr(self._icon, "menu"):
            try:
                import pystray
                self._icon.menu = self._build_menu(pystray)
            except ImportError:
                pass
        if hasattr(self._icon, "update_menu"):
            try:
                self._icon.update_menu()  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
                pass


# ---------------- helpers ----------------


def _open_path_in_explorer(path: Path) -> None:
    """Reveal a folder in the OS file manager."""
    if os.name == "nt":
        subprocess.Popen(["explorer", str(path)])  # noqa: S603,S607
        return
    if sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])  # noqa: S603,S607
        return
    if shutil.which("xdg-open"):
        subprocess.Popen(["xdg-open", str(path)])  # noqa: S603,S607
        return
    if shutil.which("gio"):
        subprocess.Popen(["gio", "open", str(path)])  # noqa: S603,S607


def _show_folder_picker() -> Optional[Path]:
    """Native folder picker. Tkinter ships with CPython on every
    platform we care about, so this is dependency-free."""
    try:
        import tkinter
        from tkinter import filedialog
    except ImportError:
        log.warning("tkinter_missing_cannot_show_folder_picker")
        return None
    root = tkinter.Tk()
    try:
        root.withdraw()
        # tkinter's askdirectory blocks on the X11/Win32 main loop.
        # We're on a daemon thread so this is safe.
        chosen = filedialog.askdirectory(
            title="Choose your StarCraft II Replays folder",
            mustexist=True,
        )
    finally:
        try:
            root.destroy()
        except Exception:  # noqa: BLE001
            pass
    if not chosen:
        return None
    return Path(chosen)


__all__ = ["TrayUI", "can_use_tray"]
