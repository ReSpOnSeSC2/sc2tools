"""Persistence layer for the replay database (`meta_database.json`).

`ReplayAnalyzer` holds the in-memory state and serializes it to JSON.
`migrations` keeps the on-disk format versioned so we can add fields without
breaking older saves.
"""

from .database import ReplayAnalyzer
from .migrations import (
    CURRENT_SCHEMA_VERSION,
    ensure_schema_version,
    migrate,
    stamp_schema_version,
)

__all__ = [
    "ReplayAnalyzer",
    "CURRENT_SCHEMA_VERSION",
    "ensure_schema_version",
    "migrate",
    "stamp_schema_version",
]
