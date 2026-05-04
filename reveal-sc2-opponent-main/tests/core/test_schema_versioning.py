"""
Tests for ``core.schema_versioning`` -- Stage 6 of the data-integrity
roadmap.

Pins:
  * Stamping a known basename writes the registry's current_version
    under the registry's version_key (regular `_schema_version`,
    or `version` for custom_builds.json).
  * Reading a v1 file when the registry is at v1 is a no-op.
  * A forward migration from v1 to v2 is invoked when the registry's
    current_version is higher than what's on disk.
  * A backward migration from v2 to v1 is invoked when the registry's
    current_version is lower than what's on disk and a target is
    explicitly passed.
  * A newer-than-expected file raises SchemaTooNewError.
  * Stamping plays nicely with the canonical atomic_write_json:
    every save embeds the version key.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO_ROOT))

from core import atomic_io, schema_versioning  # noqa: E402


class StampVersionTests(unittest.TestCase):
    def test_stamps_canonical_basename(self):
        d = {"a": 1}
        schema_versioning.stamp_version(d, "MyOpponentHistory.json")
        self.assertEqual(d["_schema_version"], 1)

    def test_stamps_under_legacy_version_key_for_custom_builds(self):
        d = {"builds": []}
        schema_versioning.stamp_version(d, "custom_builds.json")
        self.assertEqual(d["version"], 3)
        self.assertNotIn("_schema_version", d)

    def test_unknown_basename_is_noop(self):
        d = {"a": 1}
        schema_versioning.stamp_version(d, "totally_random.json")
        self.assertEqual(d, {"a": 1})


class MigrationChainTests(unittest.TestCase):
    def setUp(self):
        # Snapshot the migration list so we can mutate freely and
        # restore in tearDown (no other test relies on registered
        # migrations as of Stage 6 day-1, but we want the test to
        # be hermetic).
        self._old_list = list(schema_versioning._MIGRATIONS)

    def tearDown(self):
        schema_versioning._MIGRATIONS[:] = self._old_list

    def test_forward_migration_runs(self):
        # Register a synthetic v1->v2 forward migration for a
        # synthetic basename, then exercise migrate_dict.
        BASENAME = "MyOpponentHistory.json"
        # Add to REGISTRY at runtime so the test sees a v2 spec.
        old_spec = schema_versioning.REGISTRY[BASENAME]
        try:
            schema_versioning.REGISTRY[BASENAME] = schema_versioning.SchemaSpec(
                basename=BASENAME, current_version=2,
            )
            schema_versioning.register_migration(
                schema_versioning.Migration(
                    basename=BASENAME, from_version=1, to_version=2,
                    forward=lambda d: {**d, "added_v2": True},
                    backward=lambda d: {k: v for k, v in d.items() if k != "added_v2"},
                    description="add added_v2 flag",
                )
            )
            data = {"_schema_version": 1, "x": 1}
            out = schema_versioning.migrate_dict(data, BASENAME)
            self.assertTrue(out.get("added_v2"))
            self.assertEqual(out["_schema_version"], 2)
        finally:
            schema_versioning.REGISTRY[BASENAME] = old_spec

    def test_backward_migration_runs(self):
        BASENAME = "MyOpponentHistory.json"
        old_spec = schema_versioning.REGISTRY[BASENAME]
        try:
            schema_versioning.REGISTRY[BASENAME] = schema_versioning.SchemaSpec(
                basename=BASENAME, current_version=2,
            )
            schema_versioning.register_migration(
                schema_versioning.Migration(
                    basename=BASENAME, from_version=1, to_version=2,
                    forward=lambda d: {**d, "added_v2": True},
                    backward=lambda d: {k: v for k, v in d.items() if k != "added_v2"},
                )
            )
            data = {"_schema_version": 2, "x": 1, "added_v2": True}
            out = schema_versioning.migrate_dict(
                data, BASENAME, target_version=1)
            self.assertNotIn("added_v2", out)
            self.assertEqual(out["_schema_version"], 1)
        finally:
            schema_versioning.REGISTRY[BASENAME] = old_spec

    def test_missing_forward_step_raises(self):
        BASENAME = "MyOpponentHistory.json"
        old_spec = schema_versioning.REGISTRY[BASENAME]
        try:
            schema_versioning.REGISTRY[BASENAME] = schema_versioning.SchemaSpec(
                basename=BASENAME, current_version=2,
            )
            data = {"_schema_version": 1}
            with self.assertRaises(schema_versioning.SchemaMigrationError):
                schema_versioning.migrate_dict(data, BASENAME)
        finally:
            schema_versioning.REGISTRY[BASENAME] = old_spec


class TooNewTests(unittest.TestCase):
    def test_too_new_raises(self):
        # File on disk says v999 but registry is v1.
        data = {"_schema_version": 999}
        with self.assertRaises(schema_versioning.SchemaTooNewError):
            schema_versioning.assert_not_too_new(
                data, "MyOpponentHistory.json")

    def test_at_or_below_does_not_raise(self):
        schema_versioning.assert_not_too_new(
            {"_schema_version": 1}, "MyOpponentHistory.json")
        # Missing version key is treated as v1 -- still ok.
        schema_versioning.assert_not_too_new({}, "MyOpponentHistory.json")


class ExplicitStampThenWriteTests(unittest.TestCase):
    """Stage 6: writers stamp the version explicitly before saving.

    The canonical atomic helper stays shape-agnostic; the tracked
    writers call ``stamp_version`` immediately before
    ``atomic_write_json``. These tests cover the recommended pattern.
    """

    def test_explicit_stamp_persists_canonical_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "MyOpponentHistory.json")
            data = {str(i): i for i in range(150)}
            schema_versioning.stamp_version(data, "MyOpponentHistory.json")
            atomic_io.atomic_write_json(target, data)
            with open(target, "rb") as f:
                disk = json.load(f)
            self.assertEqual(disk.get("_schema_version"), 1)

    def test_explicit_stamp_persists_legacy_key_on_custom_builds(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "custom_builds.json")
            data = {"builds": []}
            schema_versioning.stamp_version(data, "custom_builds.json")
            atomic_io.atomic_write_json(target, data)
            with open(target, "rb") as f:
                disk = json.load(f)
            self.assertEqual(disk.get("version"), 3)

    def test_canonical_helper_does_not_auto_stamp(self):
        # Stage 6 keeps atomic_write_json shape-neutral so existing
        # iterators that walk db.values() don't see a stray integer.
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "MyOpponentHistory.json")
            atomic_io.atomic_write_json(target, {"a": 1, "b": 2})
            with open(target, "rb") as f:
                disk = json.load(f)
            self.assertNotIn("_schema_version", disk)
            self.assertEqual(disk, {"a": 1, "b": 2})


if __name__ == "__main__":
    unittest.main()
