"""replay-engine package metadata.

This module exposes ``__version__`` as the single Python-side reference
to the suite version. The canonical source of truth is the sibling
``VERSION`` file in this package directory; this module reads it at
import time so a release bump only edits one place.

The CI guard ``.github/workflows/version-check.yml`` re-asserts that the
version returned here matches the ``VERSION`` file on every PR, so a
silent drift (file moved, corrupted, lookup falling through to
``"0.0.0+unknown"``) fails the build instead of shipping.

Example:
    >>> from replay_engine import __version__  # doctest: +SKIP
    >>> __version__
    '1.4.7'
"""

from __future__ import annotations

from pathlib import Path
from typing import Final

# The VERSION file lives next to this module: <repo>/apps/replay-engine/VERSION
_VERSION_FILE: Final[Path] = Path(__file__).resolve().parent / "VERSION"

# Sentinel used when the canonical file is missing or unreadable. The
# CI guard refuses this value, so production paths cannot ship with it.
_UNKNOWN_VERSION: Final[str] = "0.0.0+unknown"


def _read_canonical_version() -> str:
    """Return the version string from the VERSION file, or ``_UNKNOWN_VERSION``.

    Errors are swallowed deliberately: importing this package must never
    crash because of metadata I/O. The CI guard catches drift; runtime
    callers can compare against ``_UNKNOWN_VERSION`` if they need to fail
    loud.
    """
    try:
        raw = _VERSION_FILE.read_text(encoding="utf-8")
    except OSError:
        return _UNKNOWN_VERSION
    version = raw.strip()
    if not version:
        return _UNKNOWN_VERSION
    return version


__version__: Final[str] = _read_canonical_version()

__all__ = ["__version__"]
