"""
core.migrations -- Stage 6 of STAGE_DATA_INTEGRITY_ROADMAP.

Migration registry. Each migration module under this package
contributes one :class:`core.schema_versioning.Migration` per
``(basename, from_version, to_version)`` tuple via the module-level
``register_migration`` helper.

Adding a new migration
----------------------
1. Bump ``REGISTRY[<basename>].current_version`` in
   ``core/schema_versioning.py``.
2. Create a new file under this package named
   ``<basename_safe>_<from>_to_<to>.py``.
3. Implement two pure functions:

       def forward(d: dict) -> dict: ...
       def backward(d: dict) -> dict: ...

4. Register the migration at module import time::

       from core.schema_versioning import Migration, register_migration
       register_migration(Migration(
           basename="MyOpponentHistory.json",
           from_version=1,
           to_version=2,
           forward=forward,
           backward=backward,
           description="Add per-record `last_seen` timestamp.",
       ))

5. Append the new module to :data:`_REGISTERED_MIGRATIONS` so the
   eager-import on first call to ``migrate_dict`` picks it up.
6. Add a unit test under ``tests/core/test_migrations.py`` that
   exercises both directions on a real-shape fixture.

Stage 6 ships at v1 for every tracked file, so this package is
intentionally empty of migrations on day 1. The infrastructure
exists so future bumps cannot regress.
"""

from __future__ import annotations

# Each entry is a module name (relative to this package) that registers
# one or more migrations on import. Keep this list sorted lexically so
# diffs against future PRs are minimal.
_REGISTERED_MIGRATIONS = [
    # e.g. "MyOpponentHistory_v1_to_v2",
]

import importlib

for _m in _REGISTERED_MIGRATIONS:
    importlib.import_module(__name__ + "." + _m)
