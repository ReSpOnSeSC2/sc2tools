"""SC2Replay-Analyzer package metadata.

This module exposes ``__version__`` as the single Python-side reference
to the suite version. The canonical source of truth is
``reveal-sc2-opponent-main/stream-overlay-backend/package.json``; this
file reads it at import time so a release bump only edits one place.

The CI guard ``.github/workflows/version-check.yml`` re-asserts that the
version returned here matches the package.json field on every PR, so a
silent drift (file moved, JSON corrupted, lookup falling through to
``"0.0.0+unknown"``) fails the build instead of shipping.

Example:
    >>> from SC2Replay_Analyzer import __version__
    >>> __version__
    '1.0.0'
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Final

# Repo root is two levels up from this file: <repo>/SC2Replay-Analyzer/__init__.py
_REPO_ROOT: Final[Path] = Path(__file__).resolve().parent.parent
_BACKEND_PACKAGE_JSON: Final[Path] = (
    _REPO_ROOT
    / "reveal-sc2-opponent-main"
    / "stream-overlay-backend"
    / "package.json"
)

# Sentinel used when the canonical file is missing or unreadable. The
# backend's /api/version endpoint and the CI guard both refuse this value,
# so production paths cannot ship with it.
_UNKNOWN_VERSION: Final[str] = "0.0.0+unknown"


def _read_canonical_version() -> str:
    """Return the version string from package.json, or ``_UNKNOWN_VERSION``.

    Errors are swallowed deliberately: importing this package must never
    crash because of metadata I/O. The CI guard catches drift; runtime
    callers can compare against ``_UNKNOWN_VERSION`` if they need to fail
    loud.
    """
    try:
        raw = _BACKEND_PACKAGE_JSON.read_text(encoding="utf-8")
        data = json.loads(raw)
    except (OSError, ValueError):
        return _UNKNOWN_VERSION
    version = data.get("version")
    if not isinstance(version, str) or not version.strip():
        return _UNKNOWN_VERSION
    return version.strip()


__version__: Final[str] = _read_canonical_version()

__all__ = ["__version__"]
