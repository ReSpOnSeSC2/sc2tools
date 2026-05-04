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
from typing import Any, Dict, Optional

from core.file_lock import file_lock  # noqa: E402  (sibling module)

logger = logging.getLogger(__name__)

BAK_SUFFIX = ".bak"

# ---------------------------------------------------------------------------
# Stage 4 of STAGE_DATA_INTEGRITY_ROADMAP -- validate-before-rename gate.
# ---------------------------------------------------------------------------
# Per-basename minimum top-level dict key count. The atomic-write helper
# refuses to rename a temp into a tracked file when the temp would drop
# the live file below the floor. Set the env var
# ``SC2TOOLS_INTEGRITY_FLOORS=0`` to bypass the gate (emergency rollback
# hatch; matches the same opt-out style as the file lock).
#
# Floors are conservative -- the smallest legitimate post-onboarding
# version of each file. Smaller-than-floor writes are the read-modify-
# write wipe pattern from the April-2026 truncation incidents.
FILE_FLOORS: Dict[str, int] = {
    "MyOpponentHistory.json": 100,
    "meta_database.json":     50,
    "custom_builds.json":     0,    # legitimate empty-state
    "profile.json":           1,    # always at least 1 player
    "config.json":            5,    # core keys after onboarding
}
INTEGRITY_FLOORS_ENV_VAR = "SC2TOOLS_INTEGRITY_FLOORS"
INTEGRITY_FLOORS_DISABLE_VALUE = "0"


class DataIntegrityError(RuntimeError):
    """Raised by the validate-before-rename gate.

    Two trip conditions:

    * The temp file failed to parse / round-trip JSON. The on-disk live
      file is unchanged; the temp is removed.
    * The temp would shrink the live file below its registered floor in
      :data:`FILE_FLOORS`. Live file unchanged; temp removed.

    Callers MUST NOT silently retry. The right response is to log the
    error and require operator review -- a retry against the same
    in-memory dict will trip the same gate.
    """


def _floors_disabled() -> bool:
    return os.environ.get(INTEGRITY_FLOORS_ENV_VAR, "1") == INTEGRITY_FLOORS_DISABLE_VALUE


def _resolve_floor(target_path: str) -> Optional[int]:
    """Return the registered floor for ``target_path``, or None if untracked."""
    if _floors_disabled():
        return None
    base = os.path.basename(target_path)
    return FILE_FLOORS.get(base)


def _existing_top_level_key_count(path: str) -> int:
    """Return current top-level dict key count, or 0 on missing/unparseable."""
    try:
        if not os.path.exists(path):
            return 0
        with open(path, "rb") as f:
            raw = f.read()
        if raw.startswith(b"\xef\xbb\xbf"):
            raw = raw[3:]
        raw = raw.strip(b" \t\r\n\x00")
        if not raw:
            return 0
        parsed = json.loads(raw.decode("utf-8"))
        return len(parsed) if isinstance(parsed, dict) else 0
    except Exception:  # noqa: BLE001
        return 0


def _validate_temp_before_rename(
    tmp_path: str,
    target_path: str,
    in_memory_data: Any,
) -> None:
    """Run the Stage 4 gate against the temp file before publishing it.

    Reads the bytes back from disk and verifies:

      1. The JSON parses cleanly (catches torn writes, partial fsyncs,
         encoding-related corruption).
      2. The shape matches the in-memory value at the top-level shape
         (dict vs. list vs. scalar) and, for dicts, the same key set.
         A mismatch here means the on-disk bytes were corrupted between
         the f.write and the fsync -- so the rename would publish junk.
      3. The shrinkage floor in :data:`FILE_FLOORS` is honoured: if the
         live file currently has >= floor keys, the candidate must too.

    Raises :class:`DataIntegrityError` on any failure. Does not unlink
    the temp -- the caller's normal cleanup path handles that.
    """
    # 1) Round-trip parse.
    try:
        with open(tmp_path, "rb") as f:
            raw = f.read()
        if raw.startswith(b"\xef\xbb\xbf"):
            raw = raw[3:]
        round_tripped = json.loads(raw.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise DataIntegrityError(
            f"validate-before-rename: temp {tmp_path} failed JSON parse: {exc}"
        ) from exc

    # 2) Shape match against the in-memory value.
    if isinstance(in_memory_data, dict):
        if not isinstance(round_tripped, dict):
            raise DataIntegrityError(
                f"validate-before-rename: temp {tmp_path} parsed to a "
                f"{type(round_tripped).__name__} but in-memory was dict"
            )
        if len(round_tripped) != len(in_memory_data):
            raise DataIntegrityError(
                f"validate-before-rename: temp {tmp_path} has "
                f"{len(round_tripped)} keys but in-memory has "
                f"{len(in_memory_data)}; refusing rename"
            )
    elif isinstance(in_memory_data, list):
        if not isinstance(round_tripped, list):
            raise DataIntegrityError(
                f"validate-before-rename: temp parsed to "
                f"{type(round_tripped).__name__} but in-memory was list"
            )
        if len(round_tripped) != len(in_memory_data):
            raise DataIntegrityError(
                f"validate-before-rename: temp has {len(round_tripped)} "
                f"items but in-memory has {len(in_memory_data)}"
            )

    # 3) Shrinkage floor.
    floor = _resolve_floor(target_path)
    if floor is not None and isinstance(round_tripped, dict):
        on_disk = _existing_top_level_key_count(target_path)
        if on_disk >= floor and len(round_tripped) < floor:
            raise DataIntegrityError(
                f"validate-before-rename: refusing to publish {target_path}: "
                f"live file currently has {on_disk} top-level keys, "
                f"candidate has {len(round_tripped)} (floor={floor}). "
                f"This is the read-modify-write wipe pattern."
            )


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
    # Cross-process lock: serialize writes against any other writer
    # (Node backend, PowerShell scanner) targeting the same logical
    # file so concurrent renames cannot clobber each other's .bak
    # snapshot. Opt-out via SC2TOOLS_DATA_LOCK_ENABLED=0.
    with file_lock(path):
        parent = os.path.dirname(path) or "."
        os.makedirs(parent, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(prefix=".tmp_", suffix=".json", dir=parent)
        try:
            with os.fdopen(fd, "w", encoding=encoding) as f:
                json.dump(data, f, indent=indent, ensure_ascii=ensure_ascii)
                # Force data to physical disk BEFORE the rename.  Without
                # this the NTFS lazy writer may flush blocks *after*
                # rename, so a kill/sleep/AV-lock between rename and flush
                # leaves the live file with only the bytes already in the
                # page cache.
                f.flush()
                os.fsync(f.fileno())
            # Stage 4: validate-before-rename. Read the temp back and
            # confirm it parses, has the expected shape, and would not
            # shrink the live file below its registered floor. A torn
            # write or accidental wipe is caught HERE, not by the user
            # opening a half-written file in the SPA.
            _validate_temp_before_rename(tmp_path, path, data)
            # Snapshot the current live file to .bak *after* the temp is
            # safely written but *before* the rename. This means .bak
            # always holds the last intact commit so safe_read_json can
            # recover from corruption.
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
    with file_lock(path):
        parent = os.path.dirname(path) or "."
        os.makedirs(parent, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(prefix=".tmp_", suffix=".tmp", dir=parent)
        try:
            with os.fdopen(fd, "w", encoding=encoding) as f:
                f.write(text)
                # See atomic_write_json above: flush+fsync before rename
                # to close the Windows NTFS lazy-writer truncation window.
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
    with file_lock(path):
        parent = os.path.dirname(path) or "."
        os.makedirs(parent, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(prefix=".tmp_", suffix=".bin", dir=parent)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(payload)
                # See atomic_write_json above: flush+fsync before rename
                # to close the Windows NTFS lazy-writer truncation window.
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
