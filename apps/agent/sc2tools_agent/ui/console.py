"""Fallback console UI for headless / debug runs.

Always runs in addition to the tray (or instead of it on Linux/CI).
Prints the pairing code, shows live status updates, and keeps the
process alive until Ctrl-C.
"""

from __future__ import annotations

import threading


class ConsoleUI:
    """Minimal stdout-based UI."""

    def __init__(self) -> None:
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._status = "starting"
        self._uploaded = 0
        self._pending = 0

    def show_pairing_code(self, code: str) -> None:
        bar = "=" * 60
        # Standalone print is intentional UX, not log spam — this is the
        # one place the user sees the code, so it must stand out.
        print(
            f"\n{bar}\n"
            f"  PAIRING CODE: {code}\n"
            f"  Open  https://sc2tools.app/devices  and enter this code.\n"
            f"  (Locally: http://localhost:3000/devices)\n"
            f"{bar}\n"
        )

    def on_paired(self, user_id: str) -> None:
        print(f"[agent] paired userId={user_id}")

    def on_status(self, status: str) -> None:
        with self._lock:
            self._status = status
        print(f"[agent] {status}")

    def on_upload_success(self, filename: str) -> None:
        with self._lock:
            self._uploaded += 1
            self._pending = max(0, self._pending - 1)
        print(f"[agent] uploaded {filename} ({self._uploaded} total)")

    def on_upload_failed(self, filename: str, reason: str) -> None:
        print(f"[agent] upload failed for {filename}: {reason}")

    def on_pending(self, count: int) -> None:
        with self._lock:
            self._pending = count

    def wait_for_exit(self) -> None:
        try:
            while not self._stop.is_set():
                self._stop.wait(timeout=1.0)
        except KeyboardInterrupt:
            print("\n[agent] stopping...")

    def request_stop(self) -> None:
        self._stop.set()
