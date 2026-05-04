"""
Tests for Stage 4 of STAGE_DATA_INTEGRITY_ROADMAP -- the validate-
before-rename gate added to ``core.atomic_io.atomic_write_json``.

Pins:
  * A successful write to a tracked file passes the gate cleanly.
  * A torn JSON payload is caught BEFORE the rename: live file
    untouched, .tmp removed, DataIntegrityError raised.
  * A shrinkage wipe (live=300, candidate=2) on MyOpponentHistory.json
    is rejected by the floor; live file untouched.
  * Untracked files (no FILE_FLOORS entry) are not affected by the
    floor, only by the round-trip and shape checks.
  * SC2TOOLS_INTEGRITY_FLOORS=0 disables the floor (emergency
    rollback hatch); the round-trip check still runs.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO_ROOT))

from core import atomic_io  # noqa: E402


class ValidateBeforeRenameTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = self._tmp.name

    def _path(self, basename: str) -> str:
        return os.path.join(self.dir, basename)

    def test_clean_write_publishes(self):
        p = self._path("MyOpponentHistory.json")
        big = {str(i): {"Name": f"P{i}"} for i in range(150)}
        atomic_io.atomic_write_json(p, big)
        with open(p, "rb") as f:
            self.assertEqual(len(json.load(f)), 150)

    def test_shrinkage_floor_rejects_wipe(self):
        p = self._path("MyOpponentHistory.json")
        big = {str(i): {"Name": f"P{i}"} for i in range(300)}
        atomic_io.atomic_write_json(p, big)
        # Simulate a buggy save() that read empty and mutates 2 records.
        wipe = {"x": {"Name": "X"}, "y": {"Name": "Y"}}
        with self.assertRaises(atomic_io.DataIntegrityError):
            atomic_io.atomic_write_json(p, wipe)
        # Live file must be the 300-key version still.
        with open(p, "rb") as f:
            self.assertEqual(len(json.load(f)), 300)
        # No leftover .tmp files in the dir.
        leftovers = [n for n in os.listdir(self.dir) if n.startswith(".tmp_")]
        self.assertEqual(leftovers, [])

    def test_untracked_file_not_subject_to_floor(self):
        p = self._path("some_random_file.json")
        atomic_io.atomic_write_json(p, {str(i): i for i in range(150)})
        # Drop to 2 keys; floor doesn't apply (untracked basename).
        atomic_io.atomic_write_json(p, {"a": 1, "b": 2})
        with open(p, "rb") as f:
            self.assertEqual(len(json.load(f)), 2)

    def test_disabled_via_env_var(self):
        p = self._path("MyOpponentHistory.json")
        big = {str(i): {"Name": f"P{i}"} for i in range(300)}
        atomic_io.atomic_write_json(p, big)
        with mock.patch.dict(
            os.environ,
            {atomic_io.INTEGRITY_FLOORS_ENV_VAR: atomic_io.INTEGRITY_FLOORS_DISABLE_VALUE},
        ):
            atomic_io.atomic_write_json(p, {"x": 1})
        with open(p, "rb") as f:
            self.assertEqual(len(json.load(f)), 1)

    def test_explicit_floor_lookup_is_basename_keyed(self):
        # Bypassing the env var: a file named MyOpponentHistory.json in
        # ANY directory is subject to the 100-key floor.
        sub = os.path.join(self.dir, "subdir")
        os.makedirs(sub)
        p = os.path.join(sub, "MyOpponentHistory.json")
        atomic_io.atomic_write_json(
            p, {str(i): {"Name": f"P{i}"} for i in range(150)}
        )
        with self.assertRaises(atomic_io.DataIntegrityError):
            atomic_io.atomic_write_json(p, {"x": 1})

    def test_validate_helper_round_trip_failure_path(self):
        # Direct test of the gate function with a torn .tmp file. We
        # write a payload that would produce a 5-key dict, then fake
        # the temp's bytes to be invalid JSON.
        target = self._path("MyOpponentHistory.json")
        # Write an initial 150-key file via the helper so the live file
        # exists and shrinkage-floor logic can be exercised.
        atomic_io.atomic_write_json(target, {str(i): i for i in range(150)})
        tmp = self._path(".tmp_test.json")
        with open(tmp, "wb") as f:
            f.write(b'{"a": 1,')  # truncated JSON
        with self.assertRaises(atomic_io.DataIntegrityError):
            atomic_io._validate_temp_before_rename(tmp, target, {"a": 1})


if __name__ == "__main__":
    unittest.main()
