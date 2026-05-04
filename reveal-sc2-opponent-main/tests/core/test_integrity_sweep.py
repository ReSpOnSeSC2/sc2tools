"""
Tests for ``core.integrity_sweep`` -- Stage 5 of the data-integrity
roadmap.

Pins:
  * A clean data dir reports all tracked files as OK and no orphans.
  * A corrupt live file with a usable orphan is staged into
    data/.recovery/<basename>/ for the user to apply.
  * Apply candidate atomic-replaces the live file and creates a .bak
    of the previous version.
  * Apply rejects a too-small candidate via DataIntegrityError; the
    live file stays unchanged.
  * Aged-vs-young orphan filtering works: a 60-second-old .tmp is
    NOT considered for recovery.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO_ROOT))

from core import atomic_io, integrity_sweep  # noqa: E402


def _write(p: str, obj):
    parent = os.path.dirname(p) or "."
    os.makedirs(parent, exist_ok=True)
    with open(p, "wb") as f:
        f.write(json.dumps(obj, ensure_ascii=False).encode("utf-8"))


class CleanDataDirTests(unittest.TestCase):
    def test_all_ok(self):
        with tempfile.TemporaryDirectory() as tmp:
            for name in integrity_sweep.TRACKED_BASENAMES:
                # Hit each file's floor count.
                from core.atomic_io import FILE_FLOORS
                floor = FILE_FLOORS.get(name, 0) or 1
                _write(os.path.join(tmp, name),
                       {str(i): i for i in range(max(floor, 1))})
            report = integrity_sweep.run_sweep(tmp)
            for f in report.findings:
                self.assertEqual(
                    f.status, "ok",
                    f"expected {f.basename} ok, got {f.status}",
                )
            self.assertEqual(report.orphans_seen, [])
            self.assertEqual(report.candidates_staged, [])


class CorruptLiveTests(unittest.TestCase):
    def test_orphan_promoted_to_candidate(self):
        with tempfile.TemporaryDirectory() as tmp:
            live = os.path.join(tmp, "MyOpponentHistory.json")
            # Live = 5 keys (below 100-key floor)
            _write(live, {str(i): {"Name": f"P{i}"} for i in range(5)})
            # Orphan = 200 keys, aged 10 minutes ago
            orphan = os.path.join(tmp, ".tmp_recovered.json")
            _write(orphan, {str(i): {"Name": f"P{i}"} for i in range(200)})
            old = time.time() - 600
            os.utime(orphan, (old, old))

            report = integrity_sweep.run_sweep(tmp, now=time.time())
            mh = next(
                f for f in report.findings if f.basename == "MyOpponentHistory.json"
            )
            self.assertEqual(mh.status, "corrupt_small")
            self.assertIsNotNone(mh.candidate_path)
            self.assertEqual(mh.candidate_source, "orphan")
            self.assertEqual(mh.candidate_keys, 200)
            self.assertTrue(os.path.exists(mh.candidate_path))
            # Candidate landed under data/.recovery/MyOpponentHistory.json/.
            self.assertIn(integrity_sweep.RECOVERY_DIR_NAME, mh.candidate_path)

    def test_young_orphan_not_used(self):
        with tempfile.TemporaryDirectory() as tmp:
            live = os.path.join(tmp, "MyOpponentHistory.json")
            _write(live, {str(i): {"Name": f"P{i}"} for i in range(5)})
            young = os.path.join(tmp, ".tmp_inflight.json")
            _write(young, {str(i): {"Name": f"P{i}"} for i in range(200)})
            # young.mtime ~= now -> below the 5-min threshold

            report = integrity_sweep.run_sweep(tmp, now=time.time())
            mh = next(
                f for f in report.findings if f.basename == "MyOpponentHistory.json"
            )
            self.assertEqual(mh.status, "corrupt_small")
            self.assertIsNone(mh.candidate_path,
                              "young orphan must NOT be promoted")

    def test_unparseable_live_falls_back_to_bak(self):
        with tempfile.TemporaryDirectory() as tmp:
            live = os.path.join(tmp, "MyOpponentHistory.json")
            with open(live, "wb") as f:
                f.write(b'{"a": 1, "b": ')  # truncated
            bak = live + ".bak"
            _write(bak, {str(i): {"Name": f"P{i}"} for i in range(150)})

            report = integrity_sweep.run_sweep(tmp, now=time.time())
            mh = next(
                f for f in report.findings if f.basename == "MyOpponentHistory.json"
            )
            self.assertEqual(mh.status, "corrupt_unparseable")
            self.assertIsNotNone(mh.candidate_path)
            self.assertEqual(mh.candidate_source, "bak")


class ApplyCandidateTests(unittest.TestCase):
    def test_apply_publishes_via_atomic_swap(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "MyOpponentHistory.json")
            _write(target, {"a": 1, "b": 2})
            cand_dir = os.path.join(tmp, integrity_sweep.RECOVERY_DIR_NAME, "MyOpponentHistory.json")
            os.makedirs(cand_dir, exist_ok=True)
            cand = os.path.join(cand_dir, "MyOpponentHistory-2026Z-test.json")
            _write(cand, {str(i): i for i in range(150)})

            integrity_sweep.apply_candidate(cand, target)
            with open(target, "rb") as f:
                self.assertEqual(len(json.load(f)), 150)
            # .bak holds the old 2-key version.
            with open(target + ".bak", "rb") as f:
                self.assertEqual(json.load(f), {"a": 1, "b": 2})

    def test_apply_rejects_below_floor(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "MyOpponentHistory.json")
            _write(target, {str(i): i for i in range(150)})
            cand_dir = os.path.join(tmp, integrity_sweep.RECOVERY_DIR_NAME, "MyOpponentHistory.json")
            os.makedirs(cand_dir, exist_ok=True)
            cand = os.path.join(cand_dir, "MyOpponentHistory-2026Z-test.json")
            _write(cand, {"only-one": 1})

            with self.assertRaises(atomic_io.DataIntegrityError):
                integrity_sweep.apply_candidate(cand, target)
            # Live file unchanged.
            with open(target, "rb") as f:
                self.assertEqual(len(json.load(f)), 150)


if __name__ == "__main__":
    unittest.main()
