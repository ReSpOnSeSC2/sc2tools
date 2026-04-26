"""
Thread-safe error logger for replay parse failures.

Used by both the analyzer (collects errors during a batch run, then
saves them at the end) and the live replay watcher (logs broken
replays without halting the overlay).
"""

import os
import threading
from datetime import datetime
from typing import List, Dict

from .paths import ERROR_LOG_FILE


class ErrorLogger:
    """Collects parse errors. Append-safe across threads."""

    def __init__(self):
        self.errors: List[Dict] = []
        self._lock = threading.Lock()

    def log(self, file_path: str, error_msg: str) -> None:
        with self._lock:
            self.errors.append({
                "file": os.path.basename(file_path),
                "path": file_path,
                "error": error_msg,
                "time": datetime.now().isoformat(),
            })

    def clear(self) -> None:
        with self._lock:
            self.errors.clear()

    def save(self, path: str = ERROR_LOG_FILE) -> None:
        """Write the accumulated errors to disk. No-op if empty."""
        with self._lock:
            if not self.errors:
                return
            try:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "w", encoding="utf-8") as f:
                    for e in self.errors:
                        f.write(f"[{e['time']}] {e['file']}: {e['error']}\n")
            except Exception as exc:  # pragma: no cover - best-effort logging
                print(f"[ErrorLogger] Failed to save: {exc}")

    def append(self, path: str = ERROR_LOG_FILE) -> None:
        """Append errors to the log without truncating prior content."""
        with self._lock:
            if not self.errors:
                return
            try:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "a", encoding="utf-8") as f:
                    for e in self.errors:
                        f.write(f"[{e['time']}] {e['file']}: {e['error']}\n")
                self.errors.clear()
            except Exception as exc:  # pragma: no cover
                print(f"[ErrorLogger] Failed to append: {exc}")

    @property
    def count(self) -> int:
        with self._lock:
            return len(self.errors)
