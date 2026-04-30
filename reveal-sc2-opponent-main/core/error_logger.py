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

from .atomic_io import atomic_write_text
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
        """Write the accumulated errors to disk. No-op if empty.

        Routes through :func:`core.atomic_io.atomic_write_text` so a
        crash mid-flush cannot leave a half-written log on disk.
        """
        with self._lock:
            if not self.errors:
                return
            try:
                lines = [
                    f"[{e['time']}] {e['file']}: {e['error']}\n"
                    for e in self.errors
                ]
                atomic_write_text(path, "".join(lines))
            except Exception as exc:  # pragma: no cover - best-effort logging
                print(f"[ErrorLogger] Failed to save: {exc}")

    def append(self, path: str = ERROR_LOG_FILE) -> None:
        """Append errors to the log without truncating prior content.

        Atomic semantics are preserved by reading the existing log,
        concatenating new lines, and rewriting via
        :func:`core.atomic_io.atomic_write_text`. A crash mid-flush
        leaves either the pre-write or post-write file on disk.
        """
        with self._lock:
            if not self.errors:
                return
            try:
                existing = ""
                if os.path.exists(path):
                    with open(path, "r", encoding="utf-8") as f:
                        existing = f.read()
                new_lines = "".join(
                    f"[{e['time']}] {e['file']}: {e['error']}\n"
                    for e in self.errors
                )
                atomic_write_text(path, existing + new_lines)
                self.errors.clear()
            except Exception as exc:  # pragma: no cover
                print(f"[ErrorLogger] Failed to append: {exc}")

    @property
    def count(self) -> int:
        with self._lock:
            return len(self.errors)
