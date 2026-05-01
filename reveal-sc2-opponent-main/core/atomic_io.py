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

WRITE FUNCTIONS
---------------
    atomic_write_json(path, data)      -- JSON with fsync + .bak + replace
    atomic_write_text(path, text)      -- plain text with fsync + replace
    atomic_write_bytes(path, payload)  -- binary with fsync + replace

SAFE READ
---------
    safe_read_json(path, default)      -- parse with .bak fallback + default

On any parse failure ``safe_read_json`` tries ``<path>.bak``; if that also
fails it returns ``default``. The app never crashes on a bad read.

STARTUP VALIDATION
------------------
    validate_critical_files(paths, logger)

Call once at app startup to log warnings for unreadable files and
auto-recover from ``.bak`` where possible.

Usage
-----
    from core.atomic_io import atomic_write_json, safe_read_json
    atomic_write_json("data/foo.json", obj, indent=4)
    data = safe_read_json("data/foo.json", {})

The write functions use ``tempfile.mkstemp`` to create the temp file in
the same directory as the target (same filesystem = atomic rename), then
``f.flush()`` + ``os.fsync()`` before ``os.replace`` to close the Windows
NTFS lazy-writer truncation window that caused the April 2026 data loss.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
from typing import Any

logger = logging.getLogger(__name__)

BAK_SUFFIX = ".bak"


def atomic_write_json(
    path: str,
    data: Any,
    indent: int = 4,
    encoding: str = "utf-8",
    ensure_ascii: bool = False,
) -> None:
    """Write ``data`` to ``path`` atomically as JSON.

    Safe because:
    - Payload goes to a mkstemp temp file; the live file is never
      partially overwritten.
    - ``flush`` + ``fsync`` before ``os.replace`` closes the NTFS
      lazy-writer truncation window (the mechanism behind the 2026 data
      loss: rename succeeds but data blocks haven't been flushed yet).
    - A copy of the current live file is saved to ``<path>.bak`` before
      the rename so ``safe_read_json`` can recover from any corruption
      that sneaks through between writes.
    - ``ensure_ascii=False`` preserves Cyrillic / Asian / any non-ASCII
      player names verbatim instead of escaping them as \\uXXXX.
    - On any exception the temp file is unlinked so no junk accumulates.
    """
    parent = os.path.dirname(path) or "."
    os.makedirs(parent, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=".tmp_", suffix=".json", dir=parent)
    try:
        with os.fdopen(fd, "w", encoding=encoding) as f:
            json.dump(data, f, indent=indent, ensure_ascii=ensure_ascii)
            # Force data to physical disk BEFORE the rename.  Without this
            # the NTFS lazy writer may flush blocks *after* rename, so a
            # kill/sleep/AV-lock between rename and flush leaves the live
            # file with only the bytes already in the page cache.
            f.flush()
            os.fsync(f.fileno())
        # Snapshot the current live file to .bak *after* the temp is safely
        # written but *before* the rename.  This means .bak always holds the
        # last intact commit so safe_read_json can recover from corruption.
        _backup_if_exists(path)
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
            # See atomic_write_json above: flush+fsync before rename to
            # close the Windows NTFS lazy-writer truncation window.
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def atomic_write_bytes(
    path: str,
    payload: bytes,
) -> None:
    """Atomic-write a binary payload.

    Same pattern as :func:`atomic_write_json` and :func:`atomic_write_text`
    but for arbitrary bytes (used by callers that need to copy or
    re-emit binary blobs with the same crash-safety guarantee).

    Example:
        atomic_write_bytes("data/custom_builds.json.bak", existing_bytes)
    """
    if not isinstance(payload, (bytes, bytearray)):
        raise TypeError("atomic_write_bytes: payload must be bytes")
    parent = os.path.dirname(path) or "."
    os.makedirs(parent, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=".tmp_", suffix=".bin", dir=parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(payload)
            # See atomic_write_json above: flush+fsync before rename to
            # close the Windows NTFS lazy-writer truncation window.
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def safe_read_json(path: str, default: Any = None) -> Any:
    """Read and parse a JSON file, falling back to ``<path>.bak`` then ``default``.

    Three recovery levels:
    1. Parse the primary file.
    2. If the primary is missing or corrupt, parse ``<path>.bak`` (written
       by :func:`atomic_write_json` before every rename).
    3. If both are unreadable, return ``default`` so the app starts clean
       rather than crashing.

    Strips a leading UTF-8 BOM before parsing (written by some Windows tools).
    Never raises.

    Example:
        history = safe_read_json("data/MyOpponentHistory.json", {})
        config  = safe_read_json("data/config.json", {})
    """
    primary = _try_parse_json_file(path)
    if primary is not None:
        return primary

    bak_path = path + BAK_SUFFIX
    backup = _try_parse_json_file(bak_path)
    if backup is not None:
        logger.warning(
            "safe_read_json: primary %s unreadable; recovered from .bak", path
        )
        return backup

    logger.warning(
        "safe_read_json: both %s and .bak unreadable; using default", path
    )
    return default


def _try_parse_json_file(path: str) -> Any:
    """Internal: return parsed JSON or None on any error (missing, corrupt, etc.)."""
    try:
        if not os.path.exists(path):
            return None
        with open(path, "r", encoding="utf-8-sig") as f:
            raw = f.read()
        raw = raw.strip(" \t\r\n\x00")
        if not raw:
            return None
        return json.loads(raw)
    except Exception:
        return None


def _backup_if_exists(path: str) -> None:
    """Copy ``path`` to ``path.bak`` if it exists; best-effort, never raises."""
    try:
        if os.path.exists(path):
            shutil.copy2(path, path + BAK_SUFFIX)
    except OSError as exc:
        logger.warning(
            "atomic_write_json: could not write .bak for %s: %s", path, exc
        )


def validate_critical_files(
    paths: list,
    log: Any = None,
) -> dict:
    """Check that every critical JSON file is readable at startup.

    For each file that fails to parse, attempt auto-recovery from ``.bak``
    (copy ``.bak`` -> live file).  Call this once before accepting requests
    so problems surface in logs immediately.

    Returns a dict with keys ``"ok"``, ``"recovered"``, ``"corrupt"`` each
    holding a list of file paths.

    Example:
        from core.atomic_io import validate_critical_files
        result = validate_critical_files([
            "data/meta_database.json",
            "data/MyOpponentHistory.json",
            "data/config.json",
        ])
    """
    if log is None:
        log = logger
    result: dict = {"ok": [], "recovered": [], "corrupt": []}

    for file_path in paths:
        if not os.path.exists(file_path):
            # Missing on first run -- not an error.
            result["ok"].append(file_path)
            continue

        parsed = _try_parse_json_file(file_path)
        if parsed is not None:
            result["ok"].append(file_path)
            continue

        # Primary is corrupt; try .bak recovery.
        bak_path = file_path + BAK_SUFFIX
        bak_parsed = _try_parse_json_file(bak_path)
        if bak_parsed is not None:
            try:
                shutil.copy2(bak_path, file_path)
                log.warning(
                    "validate_critical_files: recovered corrupt %s from .bak",
                    file_path,
                )
                result["recovered"].append(file_path)
            except OSError as exc:
                log.warning(
                    "validate_critical_files: could not restore .bak for %s: %s",
                    file_path,
                    exc,
                )
                result["corrupt"].append(file_path)
        else:
            log.warning(
                "validate_critical_files: %s and its .bak are both unreadable"
                " -- manual recovery needed",
                file_path,
            )
            result["corrupt"].append(file_path)

    if not result["corrupt"] and not result["recovered"]:
        log.info("validate_critical_files: all critical JSON files OK")

    return result
