"""
Tests for ``DataStore.merge_unknown_into_numeric`` -- the inline auto-
merge that runs from the watcher's ``_persist_deep`` once a numeric
SC2Pulse ID is resolved via ``toon_handle``.

The bug this fixes: after a barcode game, the Opponents table in the
SPA showed two rows -- one keyed on ``unknown:<Name>`` (created by
the live phase before SC2Pulse was reachable) and one keyed on the
numeric Pulse ID (created at deep persist time). The duplicate
distorted win-rate, last-played, and the deep-dive view.

Real fixture shapes -- no mocks except for a single
``mock.patch.object`` on ``analyzer.save`` to simulate a disk-full
error; that is the only way to drive the failure path of an atomic
write without producing a real disk-full condition.
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO_ROOT))

from core import data_store  # noqa: E402


class _MergeUnknownTestBase(unittest.TestCase):
    """Spin up a real DataStore pointed at a tmp data dir."""

    def setUp(self) -> None:
        self.tmpdir = tempfile.mkdtemp(prefix="sc2_merge_inline_")
        self.history_path = os.path.join(self.tmpdir, "MyOpponentHistory.json")
        self.meta_path = os.path.join(self.tmpdir, "meta_database.json")
        self.store = data_store.DataStore()
        self.store.black_book = data_store.BlackBookStore(self.history_path)
        self.store.analyzer = data_store.AnalyzerDBStore(self.meta_path)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _seed_history(self, payload: Dict[str, Any]) -> None:
        self.store.black_book.save(payload)

    def _seed_meta(self, payload: Dict[str, Any]) -> None:
        self.store.analyzer.save(payload)


class MergeUnknownIntoNumericHappyPath(_MergeUnknownTestBase):

    def test_folds_unknown_twin_into_numeric(self) -> None:
        self._seed_history({
            "197079": {
                "Name": "XVec",
                "Race": "P",
                "Notes": "",
                "Matchups": {
                    "PvP": {
                        "Wins": 1, "Losses": 0,
                        "Games": [
                            {
                                "Date": "2026-05-01 12:00",
                                "Result": "Victory",
                                "Map": "Tourmaline LE",
                            },
                        ],
                    },
                },
            },
            "unknown:XVec": {
                "Name": "XVec",
                "Race": "P",
                "Notes": "",
                "Matchups": {
                    "PvP": {
                        "Wins": 1, "Losses": 0,
                        "Games": [
                            {
                                "Date": "2026-04-30 18:30",
                                "Result": "Victory",
                                "Map": "Goldenaura",
                            },
                        ],
                    },
                },
            },
        })

        out = self.store.merge_unknown_into_numeric(
            numeric_pulse_id="197079", opp_name="XVec"
        )
        self.assertIsNotNone(out)
        self.assertEqual(out["plan"], {"unknown:XVec": "197079"})

        merged_history = self.store.black_book.load()
        self.assertNotIn("unknown:XVec", merged_history)
        pvp = merged_history["197079"]["Matchups"]["PvP"]
        self.assertEqual(pvp["Wins"], 2)
        self.assertEqual(pvp["Losses"], 0)
        dates = sorted(g["Date"] for g in pvp["Games"])
        self.assertEqual(dates, ["2026-04-30 18:30", "2026-05-01 12:00"])

    def test_dedupes_identical_game_across_keys(self) -> None:
        same_game = {
            "Date": "2026-05-01 12:00",
            "Result": "Victory",
            "Map": "Tourmaline LE",
        }
        self._seed_history({
            "197079": {
                "Name": "XVec",
                "Race": "P",
                "Notes": "",
                "Matchups": {
                    "PvP": {"Wins": 1, "Losses": 0, "Games": [dict(same_game)]},
                },
            },
            "unknown:XVec": {
                "Name": "XVec",
                "Race": "P",
                "Notes": "",
                "Matchups": {
                    "PvP": {"Wins": 1, "Losses": 0, "Games": [dict(same_game)]},
                },
            },
        })
        out = self.store.merge_unknown_into_numeric(
            numeric_pulse_id="197079", opp_name="XVec"
        )
        self.assertIsNotNone(out)
        merged = self.store.black_book.load()
        pvp = merged["197079"]["Matchups"]["PvP"]
        self.assertEqual(len(pvp["Games"]), 1, "identical game must dedupe")
        self.assertEqual(pvp["Wins"], 1)

    def test_rewrites_meta_db_opp_pulse_id(self) -> None:
        self._seed_history({
            "197079": {"Name": "XVec", "Race": "P", "Notes": "", "Matchups": {}},
            "unknown:XVec": {"Name": "XVec", "Race": "P", "Notes": "", "Matchups": {}},
        })
        self._seed_meta({
            "PvP - Cannon Rush": {
                "wins": 1, "losses": 0,
                "games": [
                    {"id": "g-1", "opp_pulse_id": "unknown:XVec", "result": "Win"},
                    {"id": "g-2", "opp_pulse_id": "197079", "result": "Win"},
                    {"id": "g-3", "opp_pulse_id": "unknown:Yamada", "result": "Loss"},
                ],
            },
        })
        out = self.store.merge_unknown_into_numeric(
            numeric_pulse_id="197079", opp_name="XVec"
        )
        self.assertEqual(out["meta_rewritten"], 1)
        meta = self.store.analyzer.load()
        games = meta["PvP - Cannon Rush"]["games"]
        self.assertEqual(games[0]["opp_pulse_id"], "197079")
        self.assertEqual(games[1]["opp_pulse_id"], "197079")
        self.assertEqual(games[2]["opp_pulse_id"], "unknown:Yamada")

    def test_matches_clan_and_discriminator_variants(self) -> None:
        self._seed_history({
            "340938838": {
                "Name": "Yamada#622", "Race": "Z", "Notes": "", "Matchups": {},
            },
            "unknown:Yamada": {
                "Name": "Yamada", "Race": "Z", "Notes": "",
                "Matchups": {
                    "PvZ": {
                        "Wins": 0, "Losses": 1,
                        "Games": [{
                            "Date": "2026-05-01 09:00",
                            "Result": "Defeat",
                            "Map": "Pillars of Gold LE",
                        }],
                    },
                },
            },
        })
        out = self.store.merge_unknown_into_numeric(
            numeric_pulse_id="340938838", opp_name="Yamada"
        )
        self.assertIsNotNone(out)
        merged = self.store.black_book.load()
        self.assertNotIn("unknown:Yamada", merged)
        pvz = merged["340938838"]["Matchups"]["PvZ"]
        self.assertEqual(pvz["Losses"], 1)


class MergeUnknownIntoNumericNoOps(_MergeUnknownTestBase):

    def test_no_op_when_no_unknown_twin(self) -> None:
        self._seed_history({
            "197079": {
                "Name": "XVec", "Race": "P", "Notes": "",
                "Matchups": {"PvP": {"Wins": 1, "Losses": 0, "Games": []}},
            },
        })
        out = self.store.merge_unknown_into_numeric(
            numeric_pulse_id="197079", opp_name="XVec"
        )
        self.assertIsNone(out)

    def test_no_op_when_resolved_id_is_itself_unknown(self) -> None:
        out = self.store.merge_unknown_into_numeric(
            numeric_pulse_id="unknown:Yamada", opp_name="Yamada"
        )
        self.assertIsNone(out)

    def test_no_op_when_blank_pulse_id(self) -> None:
        out = self.store.merge_unknown_into_numeric(
            numeric_pulse_id="", opp_name="Yamada"
        )
        self.assertIsNone(out)

    def test_no_op_when_blank_name(self) -> None:
        self._seed_history({
            "197079": {"Name": "XVec", "Race": "P", "Notes": "", "Matchups": {}},
        })
        out = self.store.merge_unknown_into_numeric(
            numeric_pulse_id="197079", opp_name=""
        )
        self.assertIsNone(out)

    def test_no_op_when_numeric_record_missing(self) -> None:
        self._seed_history({
            "unknown:XVec": {
                "Name": "XVec", "Race": "P", "Notes": "", "Matchups": {},
            },
        })
        out = self.store.merge_unknown_into_numeric(
            numeric_pulse_id="197079", opp_name="XVec"
        )
        self.assertIsNone(out)
        self.assertIn("unknown:XVec", self.store.black_book.load())


class MergeUnknownIntoNumericRobustness(_MergeUnknownTestBase):

    def test_meta_db_rewrite_failure_does_not_revert_history_merge(self) -> None:
        # If the analyzer DB save fails (e.g. AV lock), the Black Book
        # merge must still stand -- callers retry the meta rewrite via
        # the offline tool. The current contract surfaces the
        # exception to the caller; the watcher catches and logs.
        self._seed_history({
            "197079": {"Name": "XVec", "Race": "P", "Notes": "", "Matchups": {}},
            "unknown:XVec": {"Name": "XVec", "Race": "P", "Notes": "", "Matchups": {}},
        })
        # Seed a meta-db game referencing the unknown key so the rewrite
        # path actually runs and the patched save() fires.
        self._seed_meta({
            "PvP - Cannon Rush": {
                "wins": 0, "losses": 0,
                "games": [
                    {"id": "g-1", "opp_pulse_id": "unknown:XVec", "result": "Win"},
                ],
            },
        })

        with mock.patch.object(
            self.store.analyzer, "save",
            side_effect=OSError("disk full"),
        ):
            with self.assertRaises(OSError):
                self.store.merge_unknown_into_numeric(
                    numeric_pulse_id="197079", opp_name="XVec"
                )

        # Black Book merge already committed before the meta save.
        self.assertNotIn("unknown:XVec", self.store.black_book.load())


if __name__ == "__main__":
    unittest.main()
