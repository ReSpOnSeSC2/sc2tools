"""Raw-input helpers for Instant Analysis: zip expansion, digests, staging.

Everything the browser engine does to user-supplied bytes BEFORE the replay
pipeline sees them lives here, so ``instant_analysis`` stays a thin mapping
layer over the unchanged desktop pipeline:

* :func:`expand_replay_zip` pulls ``.SC2Replay`` entries out of a zip with
  zip-bomb guards.
* :func:`replay_digests` hashes the original bytes for the optional backup.
* :func:`staged_replay` writes one replay under a fresh temp dir, recreating
  the sanitised relative path so a ``<region>-S2-<realm>-<id>`` toon folder
  identifies the player exactly like on the desktop.

Entry names and file names are treated as data. They only become real paths
after :func:`sanitized_replay_parts` has removed traversal, drive letters and
characters that are invalid on Windows, POSIX or Emscripten MEMFS.

Example:
    >>> sanitized_replay_parts("C:\\\\Users\\\\me\\\\..\\\\Game.SC2Replay")
    ['Users', 'me', 'Game.SC2Replay']
"""

from __future__ import annotations

import base64
import contextlib
import hashlib
import io
import re
import shutil
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Dict, Iterator, List, Tuple, Union

BytesLike = Union[bytes, bytearray, memoryview]

# ``ValueError`` messages raised by :func:`expand_replay_zip`.
ZIP_INVALID = "zip_invalid"
ZIP_UNSUPPORTED = "zip_unsupported"
ZIP_ENCRYPTED = "zip_encrypted"
ZIP_TOO_MANY_ENTRIES = "zip_too_many_entries"
ZIP_ENTRY_TOO_LARGE = "zip_entry_too_large"
ZIP_TOO_LARGE = "zip_too_large"

#: Zip-bomb guards for :func:`expand_replay_zip`. A ranked replay is well
#: under 1 MiB; 20 MiB per entry leaves room for multi-hour team games.
MAX_ZIP_REPLAY_ENTRIES = 1000
MAX_ZIP_ENTRY_BYTES = 20 * 1024 * 1024
# Extracted entries live in the Pyodide heap and are then copied to JS, so
# keep an archive well inside the worker's ~700 MB budget. Larger libraries
# should use folder import, which streams one file at a time.
MAX_ZIP_TOTAL_BYTES = 128 * 1024 * 1024

REPLAY_SUFFIX = ".sc2replay"
DEFAULT_REPLAY_NAME = "replay.SC2Replay"

_TEMP_DIR_PREFIX = "sc2ia-"
# The toon folder sits five levels above the file in a StarCraft II account
# tree; keeping the 12 deepest folders preserves it while bounding the path.
_MAX_DIR_PARTS = 12
_MAX_PART_CHARS = 100
_PATH_SEPARATORS = re.compile(r"[\\/]+")
_DRIVE_PART = re.compile(r"^[A-Za-z]:$")
_UNSAFE_PART_CHARS = re.compile(r'[\x00-\x1f<>:"|?*]')
_UNSAFE_PART_REPLACEMENT = "_"
_TRAILING_UNSAFE = " ."
_MACOS_METADATA_DIR = "__MACOSX"
_ZIP_FLAG_ENCRYPTED = 0x1


def as_bytes(data: BytesLike) -> bytes:
    """Return ``data`` as immutable bytes (Pyodide may hand over views).

    Args:
        data: ``bytes``, ``bytearray`` or ``memoryview``.

    Returns:
        The same content as ``bytes``.

    Raises:
        TypeError: ``data`` is not bytes-like.

    Example:
        >>> as_bytes(bytearray(b"MPQ"))
        b'MPQ'
    """
    if isinstance(data, bytes):
        return data
    if isinstance(data, (bytearray, memoryview)):
        return bytes(data)
    raise TypeError(f"replay data must be bytes-like, not {type(data).__name__}")


def clean_path_parts(name: str) -> List[str]:
    """Split a user path on ``/`` or ``\\``; drop empty, ``.``, ``..`` and drives.

    Args:
        name: A file name or relative path from the user's device or a zip.

    Returns:
        The remaining parts, root to leaf.

    Example:
        >>> clean_path_parts("../a//./b\\\\c.SC2Replay")
        ['a', 'b', 'c.SC2Replay']
    """
    return [
        part
        for part in _PATH_SEPARATORS.split(name or "")
        if part not in ("", ".", "..") and not _DRIVE_PART.match(part)
    ]


def sanitized_replay_parts(filename: str) -> List[str]:
    """Relative parts to recreate under the temp dir, file name last.

    Unsafe characters become ``_``; the last part must end with
    ``.SC2Replay`` (any case) or it is replaced by ``replay.SC2Replay``.

    Args:
        filename: Name or relative path of the replay on the user's device.

    Returns:
        At most 12 folder parts (the deepest ones) plus the file name.

    Example:
        >>> sanitized_replay_parts("Accounts/1/1-S2-1-267727/x.txt")
        ['Accounts', '1', '1-S2-1-267727', 'replay.SC2Replay']
    """
    parts = [safe for safe in (_safe_part(p) for p in clean_path_parts(filename)) if safe]
    base = parts.pop() if parts else ""
    if not base.lower().endswith(REPLAY_SUFFIX):
        base = DEFAULT_REPLAY_NAME
    return [*parts[-_MAX_DIR_PARTS:], base]


@contextlib.contextmanager
def staged_replay(blob: bytes, filename: str) -> Iterator[Tuple[Path, Path]]:
    """Write ``blob`` under a fresh temp dir; yield (absolute, relative) path.

    A fresh directory guarantees no stale ``*.observations.json`` sibling can
    be picked up by the engine's playback merge. The directory is removed on
    exit, even when the caller raises.

    Args:
        blob: The replay bytes.
        filename: Name or relative path on the user's device.

    Yields:
        ``(path, relative)`` where ``relative`` excludes the temp root.

    Example:
        >>> with staged_replay(b"MPQ\\x1b", "a/b.SC2Replay") as (path, rel):
        ...     rel.as_posix()
        'a/b.SC2Replay'
    """
    root = Path(tempfile.mkdtemp(prefix=_TEMP_DIR_PREFIX))
    try:
        relative = Path(*sanitized_replay_parts(filename))
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(blob)
        yield path, relative
    finally:
        shutil.rmtree(root, ignore_errors=True)


def expand_replay_zip(data: BytesLike) -> List[Dict[str, Any]]:
    """Extract the ``.SC2Replay`` entries of a zip archive, zip-bomb guarded.

    Directories, ``__MACOSX/`` metadata and dotfiles are skipped. Entry
    names are returned with ``/`` separators and without empty, ``.``,
    ``..`` or drive-letter parts; they are data only and never used as real
    paths here.

    Args:
        data: The raw zip bytes.

    Returns:
        ``[{"name": str, "data": bytes}]`` in archive order.

    Raises:
        ValueError: With one of ``zip_invalid``, ``zip_unsupported``,
            ``zip_encrypted``, ``zip_too_many_entries``,
            ``zip_entry_too_large`` or ``zip_too_large``.

    Example:
        >>> buffer = io.BytesIO()
        >>> with zipfile.ZipFile(buffer, "w") as archive:
        ...     archive.writestr("a/b.SC2Replay", b"MPQ")
        >>> [entry["name"] for entry in expand_replay_zip(buffer.getvalue())]
        ['a/b.SC2Replay']
    """
    blob = as_bytes(data)
    try:
        archive = zipfile.ZipFile(io.BytesIO(blob))
    # zipfile reports an unreadable central directory as BadZipFile, OSError,
    # EOFError or ValueError depending on where the damage is.
    except (zipfile.BadZipFile, OSError, EOFError, ValueError) as exc:
        raise ValueError(ZIP_INVALID) from exc
    with archive:
        entries = [info for info in archive.infolist() if _is_replay_entry(info)]
        _check_zip_entries(entries)
        return _read_zip_entries(archive, entries)


def replay_digests(data: BytesLike) -> Dict[str, Any]:
    """Hash the original replay bytes for the optional replay backup.

    Args:
        data: The raw ``.SC2Replay`` bytes.

    Returns:
        ``{"sha256": hex digest, "md5": base64 MD5 (the ``Content-MD5`` R2
        verifies), "sizeBytes": int}``.

    Example:
        >>> replay_digests(b"")["md5"]
        '1B2M2Y8AsgTpgAmY7PhCfg=='
    """
    blob = as_bytes(data)
    md5 = hashlib.md5(blob, usedforsecurity=False).digest()
    return {
        "sha256": hashlib.sha256(blob).hexdigest(),
        "md5": base64.b64encode(md5).decode("ascii"),
        "sizeBytes": len(blob),
    }


def _safe_part(part: str) -> str:
    """Make one path part valid on POSIX, Windows and Emscripten MEMFS."""
    cleaned = _UNSAFE_PART_CHARS.sub(_UNSAFE_PART_REPLACEMENT, part)
    return cleaned[:_MAX_PART_CHARS].rstrip(_TRAILING_UNSAFE)


def _is_replay_entry(info: zipfile.ZipInfo) -> bool:
    if info.is_dir():
        return False
    parts = clean_path_parts(info.filename)
    if not parts or _MACOS_METADATA_DIR in parts:
        return False
    base = parts[-1]
    return not base.startswith(".") and base.lower().endswith(REPLAY_SUFFIX)


def _check_zip_entries(entries: List[zipfile.ZipInfo]) -> None:
    """Reject by declared sizes before inflating anything."""
    if len(entries) > MAX_ZIP_REPLAY_ENTRIES:
        raise ValueError(ZIP_TOO_MANY_ENTRIES)
    declared_total = 0
    for info in entries:
        if info.flag_bits & _ZIP_FLAG_ENCRYPTED:
            raise ValueError(ZIP_ENCRYPTED)
        if info.file_size > MAX_ZIP_ENTRY_BYTES:
            raise ValueError(ZIP_ENTRY_TOO_LARGE)
        declared_total += info.file_size
    if declared_total > MAX_ZIP_TOTAL_BYTES:
        raise ValueError(ZIP_TOO_LARGE)


def _read_zip_entries(
    archive: zipfile.ZipFile,
    entries: List[zipfile.ZipInfo],
) -> List[Dict[str, Any]]:
    """Inflate entries with hard caps (declared sizes can lie)."""
    out: List[Dict[str, Any]] = []
    total = 0
    for info in entries:
        blob = _read_zip_entry(archive, info)
        total += len(blob)
        if total > MAX_ZIP_TOTAL_BYTES:
            raise ValueError(ZIP_TOO_LARGE)
        out.append({"name": "/".join(clean_path_parts(info.filename)), "data": blob})
    return out


def _read_zip_entry(archive: zipfile.ZipFile, info: zipfile.ZipInfo) -> bytes:
    try:
        with archive.open(info) as handle:
            blob = handle.read(MAX_ZIP_ENTRY_BYTES + 1)
    except NotImplementedError as exc:
        raise ValueError(ZIP_UNSUPPORTED) from exc
    # A damaged member surfaces as BadZipFile, zlib.error, lzma.LZMAError,
    # EOFError or OSError depending on the codec; all mean "unreadable".
    except Exception as exc:
        raise ValueError(ZIP_INVALID) from exc
    if len(blob) > MAX_ZIP_ENTRY_BYTES:
        raise ValueError(ZIP_ENTRY_TOO_LARGE)
    return blob
