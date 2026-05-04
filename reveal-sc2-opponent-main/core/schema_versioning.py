"""
core.schema_versioning -- Stage 6 of STAGE_DATA_INTEGRITY_ROADMAP.

Single source of truth for the on-disk schema version of every
tracked data file.  Each file embeds a ``_schema_version`` integer
in its top-level dict (the value can be re-aliased to a different
key for legacy compatibility, see :data:`REGISTRY` below).

A file's schema can move forward (V_N -> V_{N+1}) and backward
(V_{N+1} -> V_N) via migrations registered in :mod:`core.migrations`.

Boot-time check
---------------
:func:`read_with_migrations` is the recommended read path for any
caller that needs to load a tracked file:

  * If the on-disk version matches the expected version: return the
    parsed dict unchanged.
  * If the on-disk version is older: chain forward migrations until
    it matches; raise :class:`SchemaMigrationError` if any step is
    missing.
  * If the on-disk version is **newer**: refuse to load and raise
    :class:`SchemaTooNewError`. A downgraded backend that silently
    drops fields it doesn't know about is exactly the wipe pattern
    Stage 4 was designed to prevent. The right response is a clear
    error pointing the user at the version mismatch.

Cross-language coordination
---------------------------
The same registry is mirrored in
``stream-overlay-backend/lib/schema_versioning.js`` so the Express
backend, the Python replay watcher, and the PowerShell scanner all
agree on the current version of every tracked file.
"""

from __future__ import annotations

import dataclasses
import importlib
import logging
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger("schema_versioning")


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------
class SchemaMigrationError(RuntimeError):
    """Raised when a forward migration is missing from a chain."""


class SchemaTooNewError(RuntimeError):
    """Raised when an on-disk file's version exceeds the writer's expected version."""


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------
@dataclasses.dataclass(frozen=True)
class SchemaSpec:
    """Per-tracked-file schema metadata.

    Attributes:
        basename: Filename relative to ``data/``.
        current_version: The integer version this writer emits.
        version_key: Top-level key in the JSON dict that holds the
            integer version. Defaults to ``"_schema_version"``; we
            override to ``"version"`` for ``custom_builds.json`` so
            the existing on-disk shape (already shipped) keeps working.
    """
    basename: str
    current_version: int
    version_key: str = "_schema_version"


# Stage 6 ships at version 1 for every file. Subsequent bumps go
# through ``core.migrations`` -- see the docstring in that package for
# the contract.
REGISTRY: Dict[str, SchemaSpec] = {
    "MyOpponentHistory.json": SchemaSpec(
        basename="MyOpponentHistory.json",
        current_version=1,
    ),
    "meta_database.json": SchemaSpec(
        basename="meta_database.json",
        current_version=1,
    ),
    "custom_builds.json": SchemaSpec(
        basename="custom_builds.json",
        current_version=3,
        # custom_builds.json already shipped at v3 with `version: 3`
        # under the existing settings-pr1o schema-version flow, so
        # we keep the legacy key here instead of adding a parallel
        # `_schema_version` field.
        version_key="version",
    ),
    "profile.json": SchemaSpec(
        basename="profile.json",
        current_version=1,
    ),
    "config.json": SchemaSpec(
        basename="config.json",
        current_version=1,
    ),
}


def get_spec(basename: str) -> Optional[SchemaSpec]:
    return REGISTRY.get(basename)


def expected_version(basename: str) -> Optional[int]:
    spec = get_spec(basename)
    return spec.current_version if spec is not None else None


# ---------------------------------------------------------------------------
# Migration registry
# ---------------------------------------------------------------------------
MigrationFn = Callable[[Dict[str, Any]], Dict[str, Any]]


@dataclasses.dataclass(frozen=True)
class Migration:
    basename: str
    from_version: int
    to_version: int
    forward: MigrationFn
    backward: MigrationFn
    description: str = ""


# Module-level list. Migrations are registered eagerly when a caller
# loads ``core.migrations`` (the package import block). This keeps
# the registry lazy: a writer that doesn't need migrations doesn't
# pay for the import.
_MIGRATIONS: List[Migration] = []


def register_migration(m: Migration) -> None:
    _MIGRATIONS.append(m)


def _load_all_migrations() -> None:
    """Eagerly import the migrations package so its modules register.

    Idempotent: a second call is a no-op once the package is on
    ``sys.modules``.
    """
    try:
        importlib.import_module("core.migrations")
    except ModuleNotFoundError:
        # No migrations registered yet -- writer is at version 1 and
        # nothing has migrated. Treat as empty registry.
        pass


def _chain_forward(basename: str, from_v: int, to_v: int) -> List[Migration]:
    """Return the ordered list of migrations from ``from_v`` to ``to_v``.

    Raises :class:`SchemaMigrationError` if any step is missing.
    """
    if from_v == to_v:
        return []
    if to_v < from_v:
        raise SchemaMigrationError(
            f"_chain_forward: from_v={from_v} > to_v={to_v}; use _chain_backward"
        )
    _load_all_migrations()
    chain: List[Migration] = []
    cur = from_v
    while cur < to_v:
        nxt = _find_step(basename, cur, cur + 1)
        if nxt is None:
            raise SchemaMigrationError(
                f"missing forward migration for {basename}: v{cur} -> v{cur + 1}"
            )
        chain.append(nxt)
        cur += 1
    return chain


def _chain_backward(basename: str, from_v: int, to_v: int) -> List[Migration]:
    """Return the ordered list of backward migrations.

    The migrations are returned in the order they should run; each
    migration's ``backward`` callable steps from its ``to_version``
    down to its ``from_version``.
    """
    if from_v == to_v:
        return []
    if to_v > from_v:
        raise SchemaMigrationError(
            f"_chain_backward: from_v={from_v} < to_v={to_v}; use _chain_forward"
        )
    _load_all_migrations()
    chain: List[Migration] = []
    cur = from_v
    while cur > to_v:
        step = _find_step(basename, cur - 1, cur)
        if step is None:
            raise SchemaMigrationError(
                f"missing backward migration for {basename}: v{cur} -> v{cur - 1}"
            )
        chain.append(step)
        cur -= 1
    return chain


def _find_step(basename: str, from_v: int, to_v: int) -> Optional[Migration]:
    for m in _MIGRATIONS:
        if m.basename == basename and m.from_version == from_v and m.to_version == to_v:
            return m
    return None


# ---------------------------------------------------------------------------
# Read with migrations
# ---------------------------------------------------------------------------
def stamp_version(data: Dict[str, Any], basename: str) -> Dict[str, Any]:
    """Mutate ``data`` in place to carry the registry's current version.

    No-op for unrecognized basenames or non-dict values.
    """
    spec = get_spec(basename)
    if spec is None or not isinstance(data, dict):
        return data
    data[spec.version_key] = spec.current_version
    return data


def get_on_disk_version(data: Dict[str, Any], basename: str) -> Optional[int]:
    """Read the version key for the given basename out of ``data``.

    Returns None when the file lacks a version (treated as v1 by
    callers, since v1 predates schema versioning).
    """
    spec = get_spec(basename)
    if spec is None or not isinstance(data, dict):
        return None
    val = data.get(spec.version_key)
    return val if isinstance(val, int) else None


def migrate_dict(
    data: Dict[str, Any],
    basename: str,
    *,
    target_version: Optional[int] = None,
) -> Dict[str, Any]:
    """Run forward / backward migrations on ``data`` to reach ``target_version``.

    ``target_version`` defaults to the registry's current_version. If
    the on-disk version is newer than ``target_version``, runs the
    backward chain. If older, runs the forward chain. Raises
    :class:`SchemaMigrationError` when a step in the chain is missing.

    Mutates ``data`` in place AND returns it for convenience.
    """
    spec = get_spec(basename)
    if spec is None:
        return data
    target = target_version if target_version is not None else spec.current_version
    on_disk = get_on_disk_version(data, basename)
    if on_disk is None:
        on_disk = 1  # implicit v1 for files written before schema versioning
    if on_disk == target:
        # Idempotent stamp: ensure the registry's version_key carries
        # `target` (handles files that predate schema versioning).
        data[spec.version_key] = target
        return data

    if on_disk < target:
        for step in _chain_forward(basename, on_disk, target):
            data = step.forward(data)
    else:
        for step in _chain_backward(basename, on_disk, target):
            data = step.backward(data)

    if not isinstance(data, dict):
        raise SchemaMigrationError(
            f"migration produced non-dict for {basename}: got {type(data).__name__}"
        )
    # Stamp with the *target* version, not the registry's current_version.
    # When target == current_version (the common case) this is identical
    # to stamp_version(); when an explicit target is passed (the
    # downgrade case), we honour it.
    data[spec.version_key] = target
    return data


def assert_not_too_new(data: Dict[str, Any], basename: str) -> None:
    """Raise :class:`SchemaTooNewError` if on-disk version > expected."""
    spec = get_spec(basename)
    if spec is None or not isinstance(data, dict):
        return
    on_disk = get_on_disk_version(data, basename)
    if on_disk is None:
        return
    if on_disk > spec.current_version:
        raise SchemaTooNewError(
            f"{basename} on disk is v{on_disk} but this writer expects "
            f"v{spec.current_version}; refusing to load. A newer build "
            f"of sc2tools wrote this file -- run that build to read it, "
            f"or restore from a backup."
        )


__all__ = [
    "REGISTRY",
    "SchemaSpec",
    "Migration",
    "SchemaMigrationError",
    "SchemaTooNewError",
    "register_migration",
    "get_spec",
    "expected_version",
    "stamp_version",
    "get_on_disk_version",
    "migrate_dict",
    "assert_not_too_new",
]
