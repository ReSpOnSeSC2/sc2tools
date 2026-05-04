"""
Stage 2 -- atomic-write helper unification.

Pins:
  * ``data_store._atomic_write_json`` is now a thin wrapper around
    the canonical helper. The shrinkage guard still works.
  * ``bulk_import_cli._atomic_write_json`` likewise routes through
    the canonical helper.
  * The cross-process file lock is acquired (lockfile briefly
    appears under data/.locks/) for every write.
  * On a write success the live file is atomically replaced AND the
    .bak snapshot is left holding the previous content.
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

from core import atomic_io  # noqa: E402
from core import data_store  # noqa: E402
from scripts import bulk_import_cli  # noqa: E402


class DataStoreWrapperTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.path = os.path.join(self._tmp.name, "ds.json")

    def test_first_write_publishes_via_canonical(self):
        data_store._atomic_write_json(self.path, {"a": 1})
        with open(self.path, "rb") as f:
            self.assertEqual(json.load(f), {"a": 1})

    def test_second_write_creates_bak(self):
        data_store._atomic_write_json(self.path, {"a": 1})
        data_store._atomic_write_json(self.path, {"a": 2})
        bak = self.path + atomic_io.BAK_SUFFIX
        self.assertTrue(os.path.exists(bak))
        with open(bak, "rb") as f:
            self.assertEqual(json.load(f), {"a": 1})

    def test_shrinkage_guard_still_fires(self):
        big = {str(i): i for i in range(150)}
        data_store._atomic_write_json(self.path, big, min_keep_keys=100)
        # Now try to drop to 5 entries -- guard MUST raise.
        with self.assertRaises(data_store.DataIntegrityError):
            data_store._atomic_write_json(
                self.path, {"only": 1}, min_keep_keys=100
            )
        # Live file must be unchanged.
        with open(self.path, "rb") as f:
            on_disk = json.load(f)
        self.assertEqual(len(on_disk), 150)

    def test_lockfile_briefly_present_during_write(self):
        # The canonical helper goes through file_lock; the lockfile is
        # created under data/.locks/. Verify the lock dir exists after a
        # write (i.e. the file_lock branch ran and created its dir).
        data_store._atomic_write_json(self.path, {"a": 1})
        lock_dir = os.path.join(os.path.dirname(self.path), ".locks")
        self.assertTrue(os.path.isdir(lock_dir))


class BulkImportWrapperTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.path = os.path.join(self._tmp.name, "state.json")

    def test_routes_through_canonical(self):
        bulk_import_cli._atomic_write_json(self.path, {"running": True})
        with open(self.path, "rb") as f:
            self.assertEqual(json.load(f), {"running": True})
        # Canonical helper creates .locks/ dir on first write.
        self.assertTrue(os.path.isdir(os.path.join(self._tmp.name, ".locks")))


if __name__ == "__main__":
    unittest.main()
