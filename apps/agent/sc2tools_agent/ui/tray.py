"""System-tray icon UI.

Pystray draws a tiny indicator with a context menu:
  Status: paired · 437 synced · 0 queued
  ─────────────────
  Open dashboard
  Pause
  Quit

We avoid a hard dependency: ``pystray`` and ``Pillow`` import lazily so
``can_use_tray()`` returning False degrades to the console UI rather
than crashing.
"""

from __future__ import annotations

import threading
import webbrowser
from typing import Callable, Optional


def can_use_tray() -> bool:
    try:
        import pystray  # noqa: F401
        import PIL  # noqa: F401
        return True
    except ImportError:
        return False


class TrayUI:
    def __init__(self, *, dashboard_url: str) -> None:
        self._dashboard_url = dashboard_url
        self._stop_cb: Optional[Callable[[], None]] = None
        self._icon: Optional[object] = None
        self._lock = threading.Lock()
        self._status = "starting"
        self._uploaded = 0
        self._pending = 0
        self._paired = False

    def start(self, *, on_quit: Callable[[], None]) -> None:
        import pystray
        from PIL import Image, ImageDraw

        self._stop_cb = on_quit
        # Solid-color 64×64 icon. The exact shade matches the SPA accent.
        icon_img = Image.new("RGB", (64, 64), color=(124, 140, 255))
        draw = ImageDraw.Draw(icon_img)
        draw.text((18, 16), "SC2", fill=(11, 13, 18))

        menu = pystray.Menu(
            pystray.MenuItem(self._title, None, enabled=False),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Open dashboard", self._open_dashboard),
            pystray.MenuItem("Quit", self._quit_clicked),
        )
        self._icon = pystray.Icon(
            "sc2tools-agent",
            icon_img,
            "SC2 Tools Agent",
            menu=menu,
        )
        # ``run_detached`` would be nicer, but pystray's Windows backend
        # crashes on detach in some configurations. Use a thread.
        threading.Thread(
            target=self._icon.run, name="sc2tools-tray", daemon=True,
        ).start()

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

    def on_upload_success(self, _filename: str) -> None:
        with self._lock:
            self._uploaded += 1
            self._pending = max(0, self._pending - 1)
        self._refresh()

    def on_upload_failed(self, _filename: str, _reason: str) -> None:
        self._refresh()

    def on_pending(self, count: int) -> None:
        with self._lock:
            self._pending = count
        self._refresh()

    def stop(self) -> None:
        if self._icon and hasattr(self._icon, "stop"):
            try:
                self._icon.stop()
            except Exception:  # noqa: BLE001
                pass

    # ---------------- internals ----------------
    def _title(self, _icon) -> str:
        with self._lock:
            base = "Paired" if self._paired else self._status
            return f"{base} · {self._uploaded} synced · {self._pending} queued"

    def _open_dashboard(self, _icon, _item) -> None:
        webbrowser.open(self._dashboard_url, new=2)

    def _quit_clicked(self, _icon, _item) -> None:
        self.stop()
        if self._stop_cb:
            self._stop_cb()

    def _refresh(self) -> None:
        if self._icon and hasattr(self._icon, "update_menu"):
            try:
                self._icon.update_menu()
            except Exception:  # noqa: BLE001
                pass
