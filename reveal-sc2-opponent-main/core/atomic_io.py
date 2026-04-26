"""Atomic-write helpers shared across the project.

Why this exists
---------------
Both ``meta_database.json`` and ``MyOpponentHistory.json`` got truncated
mid-write at some point in April 2026: the writer process was killed
before it had finished streaming the JSON to disk, leaving the file with
unclosed braces and brackets. The Python data layer in ``core/data_store.py``
already does atomic writes (``tempfile.mkstemp`` + ``os.replace``), but
half a dozen other writers around the project did not:

* ``UpdateHistory.py`` (backfills MyOpponentHistory.json)
* ``replay_watcher.py``
* ``gui/analyzer_app.py``
* ``core/custom_builds.py``
* ``scripts/buildorder_cli.py``

This module gives all of them a single shared helper so we don't ever
ship a half-written JSON file again, no matter how the writer dies (kill,
power loss, OneDrive sync collision, etc.).

Usage
-----
    from core.atomic_io import atomic_write_json
    atomic_write_json("data/foo.json", obj, indent=4)

The function writes to a sibling ``.tmp_xxx.json`` file in the same
directory, then atomically renames it into place. ``os.replace`` is
atomic on POSIX and on Windows (NTFS / ReFS).
"""

from __future__ import annotations

import json
import os
import tempfile
from typing import Any


def atomic_write_json(
    path: str,
    data: Any,
    indent: int = 4,
    encoding: str = "utf-8",
    ensure_ascii: bool = False,
) -> None:
    """Write ``data`` to ``path`` atomically as JSON.

    Dumps to a sibling temp file in the same directory and then
    ``os.replace``s it into place. Survives a mid-write kill without
    leaving a half-written JSON on disk.
    """
    parent = os.path.dirname(path) or "."
    os.makedirs(parent, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=".tmp_", suffix=".json", dir=parent)
    try:
        with os.fdopen(fd, "w", encoding=encoding) as f:
            json.dump(data, f, indent=indent, ensure_ascii=ensure_ascii)
        os.replace(tmp_path, path)
    except Exception:
        # On any failure, scrub the temp file so we don't leak it.
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def atomic_write_text(
    path: str,
    text: str,
    encoding: str = "utf-8",
) -> None:
    """Atomic-write a plain text payload.

    Same pattern as ``atomic_write_json`` but for arbitrary text (used
    by callers that build their own JSON string or write non-JSON data
    that needs the same crash-safety guarantee).
    """
    parent = os.path.dirname(path) or "."
    os.makedirs(parent, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=".tmp_", suffix=".tmp", dir=parent)
    try:
        with os.fdopen(fd, "w", encoding=encoding) as f:
            f.write(text)
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
