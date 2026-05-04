"""System-tray icon UI.

Pystray draws a tiny indicator with a context menu:

    Status: paired · 437 synced · 0 queued
    Last upload: foo.SC2Replay  (12:34:56)
    Watching: C:\\Users\\…\\Replays\\Multiplayer
    ─────────────────
    Open dashboard
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
import webbrowser
from datetime import datetime
from pathlib import Path
from typing import Callable, List, Optional

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
    ) -> None:
        self._dashboard_url = dashboard_url
        self._log_dir = log_dir
        self._replay_folders: List[Path] = list(replay_folders or [])
        self._on_pause_cb = on_pause
        self._on_resync_cb = on_resync
        self._on_choose_folder_cb = on_choose_folder
        self._on_check_updates_cb = on_check_updates
        self._stop_cb: Optional[Callable[[], None]] = None
        self._icon: Optional[object] = None
        self._lock = threading.Lock()
        self._status = "starting"
        self._uploaded = 0
        self._pending = 0
        self._paired = False
        self._paused = False
        self._last_upload_name: Optional[str] = None
        self._last_upload_at: Optional[datetime] = None
        self._update_pending: Optional[str] = None

    # ---------------- lifecycle ----------------

    def start(self, *, on_quit: Callable[[], None]) -> None:
        import pystray
        from PIL import Image, ImageDraw

        self._stop_cb = on_quit
        icon_img = self._load_icon_image()

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
                img = img.resize((64, 64), Image.LANCZOS)
                return img
            except Exception:  # noqa: BLE001
                # Asset is corrupt — fall through to the procedural icon.
                pass

        icon_img = Image.new("RGB", (64, 64), color=(124, 140, 255))
        draw = ImageDraw.Draw(icon_img)
        draw.text((18, 16), "SC2", fill=(11, 13, 18))
        return icon_img

    # ---------------- callbacks from the runner ----------------

    def show_pairing_code(self, code: str) -> None:
        with self._lock:
            self._status = f"pairing — code {code}"
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
            self._uploaded += 1
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
        return pystray.Menu(
            pystray.MenuItem(self._title, None, enabled=False),
            pystray.MenuItem(self._second_line, None, enabled=False),
            pystray.MenuItem(self._third_line, None, enabled=False),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Open dashboard", self._open_dashboard),
            pystray.MenuItem(self._pause_label, self._toggle_pause),
            pystray.MenuItem(
                "Open log folder",
                self._open_log_folder,
                enabled=self._log_dir_enabled,
            ),
            pystray.MenuItem("Re-sync from scratch", self._resync_clicked),
            pystray.MenuItem("Choose replay folder…", self._choose_folder_clicked),
            pystray.MenuItem(self._check_updates_label, self._check_updates_clicked),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Quit", self._quit_clicked),
        )

    # ---------------- per-menu-item helpers ----------------

    def _title(self, _icon) -> str:
        with self._lock:
            paused_marker = "Paused · " if self._paused else ""
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
            if self._replay_folders:
                root = str(self._replay_folders[0])
                if len(root) > 56:
                    root = "…" + root[-55:]
                return f"Watching: {root}"
            return "Watching: (no folder)"

    def _pause_label(self, _icon) -> str:
        with self._lock:
            return "Resume syncing" if self._paused else "Pause syncing"

    def _check_updates_label(self, _icon) -> str:
        with self._lock:
            if self._update_pending:
                return f"Install update {self._update_pending}"
            return "Check for updates"

    def _log_dir_enabled(self, _menu_item) -> bool:
        return self._log_dir is not None and Path(self._log_dir).exists()

    # ---------------- click handlers ----------------

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
        try:
            self._on_resync_cb()
        except Exception:  # noqa: BLE001
            log.exception("resync_failed")

    def _choose_folder_clicked(self, _icon, _item) -> None:
        if not self._on_choose_folder_cb:
            return
        # Run the picker in a thread so we don't block the tray loop.
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
                self._icon.title = self._tooltip()  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
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
