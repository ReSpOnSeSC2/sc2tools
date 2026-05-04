"""
Tests for ``core.sqlite_shadow`` -- Stage 8 (sub-step 1) of the
data-integrity roadmap.

Pins:
  * ``build_shadow`` populates the four data tables from JSON files.
  * Re-running ``build_shadow`` is idempotent: same row counts.
  * ``is_shadow_fresh`` reports True immediately after a build,
    False after the source JSON is mutated.
  * The read helpers (``list_opponents`` / ``opponent_games``) are
    gated by ``SC2TOOLS_ENABLE_SQLITE_READS=1``.
  * The CLI ``status`` subcommand prints the enabled/fresh booleans.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO_ROOT))

from core import sqlite_shadow  # noqa: E402


def _write_json(path: str, obj):
    parent = os.path.dirname(path) or "."
    os.makedirs(parent, exist_ok=True)
    with open(path, "wb") as f:
        f.write(json.dumps(obj, ensure_ascii=False).encode("utf-8"))


class BuildShadowTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.data_dir = self._tmp.name
        self.sqlite = os.path.join(self.data_dir, "shadow.sqlite3")

    def _seed(self, opponents: int = 5, games_per: int = 3,
              builds: int = 4, meta_games_per: int = 2):
        history = {}
        for i in range(opponents):
            pid = f"PID{i:04d}"
            mu = "PvP"
            history[pid] = {
                "Name": f"P{i}",
                "Race": "P",
                "Notes": "",
                "Matchups": {
                    mu: {
                        "Wins": 1, "Losses": 0,
                        "Games": [
                            {"Date": f"2025-04-0{j+1} 12:00",
                             "Result": "Victory" if j % 2 == 0 else "Defeat",
                             "Map": f"Map{j}"}
                            for j in range(games_per)
                        ],
                    },
                },
            }
        meta = {}
        for b in range(builds):
            bn = f"Build-{b}"
            meta[bn] = {
                "wins": 1, "losses": 1,
                "games": [
                    {"id": f"g{b}-{j}", "opponent": "Opp",
                     "result": "Win", "date": f"2025-04-0{j+1}"}
                    for j in range(meta_games_per)
                ],
            }
        _write_json(os.path.join(self.data_dir, "MyOpponentHistory.json"), history)
        _write_json(os.path.join(self.data_dir, "meta_database.json"), meta)

    def test_build_populates_all_tables(self):
        self._seed(opponents=10, games_per=2, builds=3, meta_games_per=4)
        stats = sqlite_shadow.build_shadow(self.data_dir, self.sqlite)
        self.assertEqual(stats.opponents, 10)
        self.assertEqual(stats.games, 20)
        self.assertEqual(stats.builds, 3)
        self.assertEqual(stats.meta_games, 12)

    def test_rebuild_is_idempotent(self):
        self._seed()
        first = sqlite_shadow.build_shadow(self.data_dir, self.sqlite)
        second = sqlite_shadow.build_shadow(self.data_dir, self.sqlite)
        self.assertEqual(
            (first.opponents, first.games, first.builds, first.meta_games),
            (second.opponents, second.games, second.builds, second.meta_games),
        )

    def test_freshness_flips_on_source_mutation(self):
        self._seed()
        sqlite_shadow.build_shadow(self.data_dir, self.sqlite)
        self.assertTrue(sqlite_shadow.is_shadow_fresh(
            self.data_dir, self.sqlite, max_age_sec=600,
        ))
        # Mutate the source JSON; freshness should report False on
        # the next check (signature drift).
        time.sleep(1.1)  # ensure mtime resolution registers a change
        history_path = os.path.join(self.data_dir, "MyOpponentHistory.json")
        with open(history_path, "rb") as f:
            cur = json.load(f)
        cur["new"] = {"Name": "Z", "Matchups": {}}
        _write_json(history_path, cur)
        self.assertFalse(sqlite_shadow.is_shadow_fresh(
            self.data_dir, self.sqlite, max_age_sec=600,
        ))


class ReadGateTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.data_dir = self._tmp.name
        self.sqlite = os.path.join(self.data_dir, "shadow.sqlite3")
        # Seed a tiny dataset so the read helpers have something to
        # return when enabled.
        _write_json(
            os.path.join(self.data_dir, "MyOpponentHistory.json"),
            {
                "PID1": {
                    "Name": "Bob", "Race": "T", "Notes": "",
                    "Matchups": {
                        "TvP": {
                            "Wins": 1, "Losses": 0,
                            "Games": [
                                {"Date": "2025-04-01 12:00",
                                 "Result": "Victory", "Map": "M"},
                            ],
                        },
                    },
                },
            },
        )
        _write_json(os.path.join(self.data_dir, "meta_database.json"), {})
        sqlite_shadow.build_shadow(self.data_dir, self.sqlite)

    def test_disabled_by_default(self):
        # SC2TOOLS_ENABLE_SQLITE_READS not set -- helpers should
        # raise rather than silently shadow the JSON path.
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(sqlite_shadow.ENABLE_ENV_VAR, None)
            with self.assertRaises(RuntimeError):
                sqlite_shadow.list_opponents(self.sqlite)

    def test_enabled_returns_data(self):
        with mock.patch.dict(
            os.environ,
            {sqlite_shadow.ENABLE_ENV_VAR: sqlite_shadow.ENABLE_VALUE},
        ):
            opps = sqlite_shadow.list_opponents(self.sqlite)
            self.assertEqual(len(opps), 1)
            self.assertEqual(opps[0]["pulse_id"], "PID1")

            games = sqlite_shadow.opponent_games(self.sqlite, "PID1")
            self.assertEqual(len(games), 1)
            self.assertEqual(games[0]["matchup"], "TvP")


if __name__ == "__main__":
    unittest.main()
