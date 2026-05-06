"""
Tests for ``core.file_lock`` -- cross-process lockfile primitive.

Pins:
  * Single-process happy path: enter the with-block, do work, lockfile
    cleaned up on exit.
  * Re-entrant under contention: a concurrent acquirer waits, doesn't
    spin-fail.
  * Stale lock recovery: a lockfile written by a dead PID is stolen
    automatically.
  * Timeout: a live, slow holder makes the contender raise
    FileLockTimeout instead of waiting forever.
  * Disabled mode: SC2TOOLS_DATA_LOCK_ENABLED=0 turns the lock into a
    no-op.

Real fixture writes to a tmp directory -- no global state, no mocks of
fs / os primitives. The single subprocess used in the contention test
runs a tiny Python snippet via the same interpreter so we're testing
the actual cross-process behavior, not a thread-local imitation.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO_ROOT))

from core import file_lock  # noqa: E402


class FileLockHappyPath(unittest.TestCase):

    def setUp(self) -> None:
        self.tmpdir = tempfile.mkdtemp(prefix="sc2_lock_")
        self.target = os.path.join(self.tmpdir, "MyOpponentHistory.json")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_acquire_and_release(self) -> None:
        with file_lock.file_lock(self.target):
            lock_path = os.path.join(
                self.tmpdir, file_lock.LOCK_DIR_NAME,
                file_lock._safe_lock_name(self.target),
            )
            self.assertTrue(os.path.exists(lock_path), "lockfile must exist while held")
            with open(lock_path) as f:
                meta = json.load(f)
            self.assertEqual(meta["pid"], os.getpid())
            self.assertEqual(meta["lang"], "python")

        self.assertFalse(os.path.exists(lock_path),
                         "lockfile must be removed on exit")

    def test_safe_lock_name_collapses_bak_suffix(self) -> None:
        # MyOpponentHistory.json and MyOpponentHistory.json.bak share a
        # logical lock so the .bak write doesn't race the live write.
        live_lock = file_lock._safe_lock_name("data/MyOpponentHistory.json")
        bak_lock = file_lock._safe_lock_name("data/MyOpponentHistory.json.bak")
        self.assertEqual(live_lock, bak_lock)

    def test_disabled_mode_is_noop(self) -> None:
        old = os.environ.pop(file_lock.ENABLE_ENV_VAR, None)
        os.environ[file_lock.ENABLE_ENV_VAR] = file_lock.DISABLE_VALUE
        try:
            with file_lock.file_lock(self.target):
                pass
            # Nothing should have been written -- no .locks dir even.
            lock_dir = os.path.join(self.tmpdir, file_lock.LOCK_DIR_NAME)
            self.assertFalse(os.path.exists(lock_dir))
        finally:
            if old is not None:
                os.environ[file_lock.ENABLE_ENV_VAR] = old
            else:
                os.environ.pop(file_lock.ENABLE_ENV_VAR, None)


class FileLockStealRaceGuard(unittest.TestCase):
    """Regression for the cross-language steal-race that produced lost
    updates when a contender's first read of the holder's lockfile
    returned ``None`` (transient sharing-violation, happens for real on
    Windows when PowerShell's FileShare.None create races a Python read
    by milliseconds). Before the fix, ``_try_steal(lock_path, None)``
    unlinked a perfectly healthy holder's lockfile."""

    def setUp(self) -> None:
        self.tmpdir = tempfile.mkdtemp(prefix="sc2_lock_steal_race_")
        self.target = os.path.join(self.tmpdir, "MyOpponentHistory.json")
        self.lock_path = os.path.join(
            self.tmpdir, file_lock.LOCK_DIR_NAME,
            file_lock._safe_lock_name(self.target),
        )
        os.makedirs(os.path.dirname(self.lock_path), exist_ok=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_try_steal_refuses_when_expected_is_none_and_current_healthy(self) -> None:
        meta = {
            "pid": os.getpid(),
            "host": "test-host",
            "lang": "python",
            "platform": "Test",
            "since": int(time.time() * 1000),
            "stamp": "2026-05-06T00:00:00Z",
        }
        with open(self.lock_path, "w", encoding="utf-8") as f:
            json.dump(meta, f)

        stole = file_lock._try_steal(self.lock_path, None)
        self.assertFalse(stole)
        self.assertTrue(os.path.exists(self.lock_path))


class FileLockStaleRecovery(unittest.TestCase):

    def setUp(self) -> None:
        self.tmpdir = tempfile.mkdtemp(prefix="sc2_lock_stale_")
        self.target = os.path.join(self.tmpdir, "MyOpponentHistory.json")
        self.lock_path = os.path.join(
            self.tmpdir, file_lock.LOCK_DIR_NAME,
            file_lock._safe_lock_name(self.target),
        )
        os.makedirs(os.path.dirname(self.lock_path), exist_ok=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _write_lock(self, *, pid: int, age_sec: float) -> None:
        meta = {
            "pid": pid,
            "host": "test-host",
            "lang": "python",
            "platform": "Test",
            "since": int((time.time() - age_sec) * 1000),
            "stamp": "2026-05-01T00:00:00Z",
        }
        with open(self.lock_path, "w", encoding="utf-8") as f:
            json.dump(meta, f)

    def test_dead_pid_is_stolen_immediately(self) -> None:
        # PID 1 is reserved on Linux; a high random PID likely doesn't
        # exist. Pick something we KNOW isn't running -- max pid + 1.
        dead_pid = 4_000_000_000  # well above any plausible live PID
        self._write_lock(pid=dead_pid, age_sec=1.0)

        with file_lock.file_lock(self.target, timeout_sec=2.0):
            # We're inside; lockfile metadata is now ours.
            with open(self.lock_path) as f:
                meta = json.load(f)
            self.assertEqual(meta["pid"], os.getpid())

    def test_age_threshold_steals_even_for_live_pid(self) -> None:
        # Live PID, but the lock is older than stale_after_sec -> steal.
        # Use our own PID so we know it's alive.
        self._write_lock(pid=os.getpid(), age_sec=60.0)

        with file_lock.file_lock(self.target, timeout_sec=2.0, stale_after_sec=5.0):
            with open(self.lock_path) as f:
                meta = json.load(f)
            # Note: on the steal path, the new meta has the SAME pid
            # (ours) but a fresh `since`. Compare by since instead.
            self.assertGreater(
                meta["since"], int((time.time() - 5.0) * 1000),
                "freshly written lock should have a recent since",
            )


class FileLockTimeoutBehavior(unittest.TestCase):

    def setUp(self) -> None:
        self.tmpdir = tempfile.mkdtemp(prefix="sc2_lock_timeout_")
        self.target = os.path.join(self.tmpdir, "MyOpponentHistory.json")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_contender_times_out_when_holder_is_alive_and_recent(self) -> None:
        # Hold the lock from a thread; contender can't steal because
        # the holder is alive and the lock is fresh.
        held = threading.Event()
        release = threading.Event()

        def hold():
            with file_lock.file_lock(self.target):
                held.set()
                release.wait(timeout=10.0)

        worker = threading.Thread(target=hold)
        worker.start()
        try:
            held.wait(timeout=2.0)
            t0 = time.monotonic()
            with self.assertRaises(file_lock.FileLockTimeout):
                with file_lock.file_lock(self.target, timeout_sec=0.5):
                    self.fail("should have timed out")
            elapsed = time.monotonic() - t0
            # Allow some slack but enforce that we actually waited.
            self.assertGreaterEqual(elapsed, 0.4)
            self.assertLess(elapsed, 1.5)
        finally:
            release.set()
            worker.join(timeout=5.0)


class FileLockCrossProcessContention(unittest.TestCase):
    """Spin a real subprocess hammering the lock; verify only one wins
    at any instant. This is the only test that requires actual OS-level
    process coordination -- the rest run inside one interpreter."""

    def setUp(self) -> None:
        self.tmpdir = tempfile.mkdtemp(prefix="sc2_lock_xproc_")
        self.target = os.path.join(self.tmpdir, "MyOpponentHistory.json")
        # A counter file that BOTH the parent and the subprocess
        # increment under the lock. With a working lock the final value
        # is num_parent + num_child. Without it, lost updates make it
        # smaller.
        self.counter = os.path.join(self.tmpdir, "counter.json")
        with open(self.counter, "w") as f:
            json.dump({"n": 0}, f)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_two_processes_do_not_lose_updates(self) -> None:
        # 50 increments per side; total expected = 100.
        n_each = 50
        child_script = (
            "import json, os, sys, time\n"
            f"sys.path.insert(0, {str(_REPO_ROOT)!r})\n"
            "from core import file_lock\n"
            f"target = {self.target!r}\n"
            f"counter = {self.counter!r}\n"
            f"for _ in range({n_each}):\n"
            "    with file_lock.file_lock(target, timeout_sec=20.0):\n"
            "        with open(counter) as f: d = json.load(f)\n"
            "        d['n'] += 1\n"
            "        with open(counter, 'w') as f: json.dump(d, f)\n"
            "        time.sleep(0.001)\n"
        )
        proc = subprocess.Popen(
            [sys.executable, "-c", child_script],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        # Parent does its own batch of increments concurrently.
        for _ in range(n_each):
            with file_lock.file_lock(self.target, timeout_sec=20.0):
                with open(self.counter) as f: d = json.load(f)
                d["n"] += 1
                with open(self.counter, "w") as f: json.dump(d, f)
                time.sleep(0.001)

        out, err = proc.communicate(timeout=30.0)
        self.assertEqual(proc.returncode, 0,
                         f"child failed: stdout={out!r} stderr={err!r}")
        with open(self.counter) as f:
            final = json.load(f)["n"]
        self.assertEqual(
            final, 2 * n_each,
            f"lock failed -- expected {2 * n_each}, got {final} "
            f"(stderr={err!r})",
        )


if __name__ == "__main__":
    unittest.main()
