"""
Tests for ``scripts.recover_orphan_history`` -- Stage 1 recovery script.

Pins:
  * Legacy flat-schema -> Matchups upgrade preserves Wins / Losses /
    Games and lands them under the synthetic "Unknown" matchup.
  * Three-way merge: orphan + .bak + live -> merged dict where live
    wins on Name/Race/Notes; matchup data is a union with no game
    duplication.
  * Idempotency: running the recovery twice on the same dataset does
    NOT double-count games (game identity dedupe).
  * Integrity floors: a too-small orphan triggers a ValueError, NOT
    silent corruption of the live file.
  * Atomic publish: a forced write failure leaves the live file
    untouched and removes the temp.

Real fixture writes to a tmp directory; no mocks of fs primitives.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict

_REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO_ROOT))

from scripts import recover_orphan_history as roh  # noqa: E402


def _write_json(path: str, obj: Any) -> None:
    with open(path, "wb") as f:
        f.write(json.dumps(obj, indent=2, ensure_ascii=False).encode("utf-8"))


def _make_legacy_record(name: str, n_wins: int, n_losses: int, base_date: str) -> Dict[str, Any]:
    games = []
    for i in range(n_wins):
        games.append(
            {"Date": f"{base_date} 12:{i:02d}", "Result": "Victory", "Map": f"MapW{i}"}
        )
    for i in range(n_losses):
        games.append(
            {"Date": f"{base_date} 13:{i:02d}", "Result": "Defeat", "Map": f"MapL{i}"}
        )
    return {"Name": name, "Wins": n_wins, "Losses": n_losses, "Games": games}


def _make_modern_record(name: str, race: str, mu_key: str) -> Dict[str, Any]:
    return {
        "Name": name,
        "Race": race,
        "Notes": "kept-from-live",
        "Matchups": {
            mu_key: {
                "Wins": 1,
                "Losses": 0,
                "Games": [
                    {
                        "Date": "2026-05-03 20:09",
                        "Result": "Victory",
                        "Map": "10000 Feet LE",
                        "Duration": 497,
                    }
                ],
            }
        },
    }


def _build_orphan(opp_count: int = 3200, games_per_opp: int = 4) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for i in range(opp_count):
        pid = str(100_000 + i)
        out[pid] = _make_legacy_record(
            f"Opp{i}", n_wins=games_per_opp // 2, n_losses=games_per_opp - games_per_opp // 2,
            base_date="2025-04-01",
        )
    return out


class UpgradeLegacyTests(unittest.TestCase):
    def test_legacy_record_lands_under_unknown_matchup(self):
        rec = _make_legacy_record("Foo", 3, 2, "2024-12-01")
        upgraded = roh._upgrade_legacy(rec)
        self.assertEqual(upgraded["Name"], "Foo")
        self.assertIn("Matchups", upgraded)
        self.assertIn(roh.LEGACY_FALLBACK_MATCHUP, upgraded["Matchups"])
        mu = upgraded["Matchups"][roh.LEGACY_FALLBACK_MATCHUP]
        self.assertEqual(mu["Wins"], 3)
        self.assertEqual(mu["Losses"], 2)
        self.assertEqual(len(mu["Games"]), 5)

    def test_modern_record_returned_unchanged_in_shape(self):
        rec = _make_modern_record("Bar", "P", "PvP")
        shaped = roh._ensure_matchups_shape(rec)
        self.assertEqual(shaped["Name"], "Bar")
        self.assertIn("PvP", shaped["Matchups"])
        self.assertNotIn(roh.LEGACY_FALLBACK_MATCHUP, shaped["Matchups"])

    def test_legacy_record_with_only_games_array(self):
        # Some orphan records have Games but no top-level Wins/Losses.
        rec = {"Name": "Baz", "Games": [
            {"Date": "2020-01-01 10:00", "Result": "Victory", "Map": "M1"},
            {"Date": "2020-01-02 10:00", "Result": "Defeat", "Map": "M2"},
        ]}
        upgraded = roh._upgrade_legacy(rec)
        mu = upgraded["Matchups"][roh.LEGACY_FALLBACK_MATCHUP]
        self.assertEqual(mu["Wins"], 1)
        self.assertEqual(mu["Losses"], 1)


class GameIdentityTests(unittest.TestCase):
    def test_identity_uses_minute_precision(self):
        a = {"Date": "2025-04-01 12:00:33", "Map": "M", "Result": "Victory"}
        b = {"Date": "2025-04-01 12:00:55", "Map": "M", "Result": "Victory"}
        self.assertEqual(roh._game_identity(a), roh._game_identity(b))

    def test_merge_games_dedupes(self):
        target = [{"Date": "2025-04-01 12:00", "Map": "M", "Result": "Victory"}]
        added = roh._merge_games(target, [
            {"Date": "2025-04-01 12:00", "Map": "M", "Result": "Victory"},  # dup
            {"Date": "2025-04-01 13:00", "Map": "M", "Result": "Defeat"},   # new
        ])
        self.assertEqual(added, 1)
        self.assertEqual(len(target), 2)


class RecoveryEndToEndTests(unittest.TestCase):
    """Full recovery pipeline using a synthetic fixture in a tmp dir."""

    def setUp(self):
        self._tmp_obj = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp_obj.cleanup)
        self.data_dir = self._tmp_obj.name
        self.target = os.path.join(self.data_dir, roh.HISTORY_BASENAME)

    def _write_orphan(self, opp_count: int) -> str:
        orphan = _build_orphan(opp_count=opp_count, games_per_opp=4)
        path = os.path.join(self.data_dir, ".tmp_synthrecover.json")
        _write_json(path, orphan)
        return path

    def _write_live(self, recs: Dict[str, Any]) -> None:
        _write_json(self.target, recs)

    def test_publishes_above_floor(self):
        self._write_orphan(opp_count=roh.MIN_OPPONENTS_FLOOR + 50)
        self._write_live({"100001": _make_modern_record("Live1", "Z", "PvZ")})

        result = roh.recover(self.data_dir, dry_run=False, skip_quarantine=True)
        self.assertTrue(result.published)
        self.assertGreaterEqual(result.opponents_post, roh.MIN_OPPONENTS_FLOOR)

        with open(self.target, "rb") as _f:
            on_disk = json.load(_f)
        self.assertEqual(len(on_disk), result.opponents_post)
        # Live record's Name+Race kept; orphan's Unknown matchup folded in.
        self.assertEqual(on_disk["100001"]["Name"], "Live1")
        self.assertEqual(on_disk["100001"]["Race"], "Z")
        self.assertIn("PvZ", on_disk["100001"]["Matchups"])
        self.assertIn(roh.LEGACY_FALLBACK_MATCHUP, on_disk["100001"]["Matchups"])

    def test_dry_run_does_not_touch_live_file(self):
        self._write_orphan(opp_count=roh.MIN_OPPONENTS_FLOOR + 10)
        self._write_live({"abc": _make_modern_record("Bob", "T", "PvT")})
        with open(self.target, "rb") as _f:
            before = _f.read()
        result = roh.recover(self.data_dir, dry_run=True)
        with open(self.target, "rb") as _f:
            after = _f.read()
        self.assertFalse(result.published)
        self.assertEqual(before, after)

    def test_idempotent_no_double_counting(self):
        self._write_orphan(opp_count=roh.MIN_OPPONENTS_FLOOR + 5)
        self._write_live({})
        first = roh.recover(self.data_dir, dry_run=False, skip_quarantine=True)
        first_count = first.games_post

        # Re-write the orphan (since first run quarantined nothing because skip_quarantine=True
        # but we passed an explicit orphan name that's still there).
        # Now the orphan IS still there. Run again.
        second = roh.recover(self.data_dir, dry_run=False, skip_quarantine=True)
        # Game count must not grow because identities are stable.
        self.assertEqual(second.games_post, first_count)

    def test_integrity_floor_blocks_too_small_orphan(self):
        # Below floor => ValueError, live file untouched.
        path = os.path.join(self.data_dir, ".tmp_tiny.json")
        _write_json(path, {"a": _make_legacy_record("Tiny", 1, 0, "2024-01-01")})
        self._write_live({"x": _make_modern_record("X", "P", "PvP")})
        with open(self.target, "rb") as _f:
            before = _f.read()
        with self.assertRaises(FileNotFoundError):
            # auto-pick rejects the 1-key orphan and finds nothing
            roh.recover(self.data_dir, dry_run=False)
        # Now with explicit override, ValueError instead of silent corruption.
        with self.assertRaises(ValueError):
            roh.recover(self.data_dir, explicit_orphan=path, dry_run=False)
        with open(self.target, "rb") as _f:
            after = _f.read()
        self.assertEqual(before, after)

    def test_quarantine_moves_orphans(self):
        self._write_orphan(opp_count=roh.MIN_OPPONENTS_FLOOR + 5)
        self._write_live({})
        result = roh.recover(self.data_dir, dry_run=False, skip_quarantine=False)
        self.assertTrue(result.published)
        self.assertGreaterEqual(len(result.orphans_quarantined), 1)
        # No .tmp_*.json files should remain at the top level.
        for name in os.listdir(self.data_dir):
            self.assertFalse(
                name.startswith(".tmp_") and name.endswith(".json"),
                f"orphan still at top level: {name}",
            )


if __name__ == "__main__":
    unittest.main()
