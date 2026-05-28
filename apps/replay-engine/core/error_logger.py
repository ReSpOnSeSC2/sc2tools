"""Thread-safe error log shared across the analysis pipeline."""

import os
import threading
from datetime import datetime
from typing import Dict, List

from .paths import ERROR_LOG_FILE


class ErrorLogger:
    """Collects per-file processing errors so the UI can show them later.

    Designed to be safe under the worker pool: every mutation is serialized
    with `_lock`. The log is flushed to disk in `save()`.
    """

    def __init__(self):
        self.errors: List[Dict] = []
        self._lock = threading.Lock()

    def log(self, file_path: str, error_msg: str):
        with self._lock:
            self.errors.append({
                'file': os.path.basename(file_path),
                'path': file_path,
                'error': error_msg,
                'time': datetime.now().isoformat(),
            })

    def clear(self):
        with self._lock:
            self.errors.clear()

    def save(self, path: str = ERROR_LOG_FILE):
        with self._lock:
            if not self.errors:
                return
            try:
                with open(path, 'w') as f:
                    for e in self.errors:
                        f.write(f"[{e['time']}] {e['file']}: {e['error']}\n")
            except Exception:
                pass

    @property
    def count(self) -> int:
        with self._lock:
            return len(self.errors)
