"""Schema migration helpers for `meta_database.json`.

The on-disk database is a JSON object mapping build names to per-build records
(`{"games": [...], "wins": int, "losses": int}`). To allow non-breaking
additions over time we tag every save with a top-level `_schema_version`
integer. The flow is:

  1. Load raw JSON.
  2. Pop `_schema_version` (defaulting to 1 for unversioned legacy DBs).
  3. Apply `migrate(...)` to bring the dict up to `CURRENT_SCHEMA_VERSION`.
  4. Hand the cleaned dict to `ReplayAnalyzer`.
  5. On save, re-stamp `_schema_version` so the format is round-trippable.

Adding a new schema version
---------------------------
* Bump `CURRENT_SCHEMA_VERSION`.
* Add a branch in `migrate(...)` that handles the upgrade in-place.
* Keep migrations idempotent — re-running a migration on already-migrated data
  must be a no-op.
"""

from typing import Dict, Tuple


CURRENT_SCHEMA_VERSION = 2

# Top-level metadata keys that should never be treated as build-name records.
# `ReplayAnalyzer` keeps these out of `self.db`; they're re-injected on save.
_RESERVED_META_KEYS = ("_schema_version",)


def ensure_schema_version(raw: Dict) -> Tuple[Dict, int]:
    """Strip metadata keys from a raw DB dict and return `(cleaned, version)`.

    `version` defaults to `1` when the file predates schema versioning.
    """
    if not isinstance(raw, dict):
        return {}, 1
    version = raw.pop("_schema_version", 1)
    try:
        version = int(version)
    except (TypeError, ValueError):
        version = 1
    # Drop any other reserved-but-unknown meta keys so they don't pollute
    # build iteration in callers.
    for key in _RESERVED_META_KEYS:
        raw.pop(key, None)
    return raw, version


def migrate(data: Dict, from_version: int) -> Tuple[Dict, int]:
    """Bring `data` up to `CURRENT_SCHEMA_VERSION` and return `(data, new_version)`.

    Migrations are intentionally tiny — each step assumes the previous one ran.
    The function is idempotent so calling it on an already-current DB is safe.
    """
    version = from_version

    # v1 -> v2: introduces the `_schema_version` key. No actual field changes
    # yet; this exists so future upgrades have a known starting point.
    if version < 2:
        version = 2

    # Future migrations slot in here. Example:
    # if version < 3:
    #     for bd in data.values():
    #         for game in bd.get("games", []):
    #             game.setdefault("new_field", default_value)
    #     version = 3

    return data, version


def stamp_schema_version(payload: Dict, version: int = CURRENT_SCHEMA_VERSION) -> Dict:
    """Inject the schema-version key into a payload dict prior to writing JSON."""
    payload["_schema_version"] = int(version)
    return payload
