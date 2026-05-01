"""
Tests for scripts/merge_unknown_pulse_ids.py.

Exercises the full merge path against real-shaped Black Book and
analyzer DB records:

    * planning: which unknown:<Name> records have a numeric twin?
    * merging: games are deduped by identity, W/L counters reflect
      only newly-appended games, deep-parse fields are filled into
      existing records without clobbering set fields, and the
      unknown:<Name> record is removed.
    * cross-DB rewrite: opp_pulse_id fields in meta_database.json
      are rewritten from the unknown key to the numeric ID.
    * dry-run: nothing is written to disk.
    * end-to-end CLI: backups are taken and atomic writes succeed.

No mock data — every fixture matches the schema actually written by
watchers/replay_watcher.py and the SC2Pulse-resolved live overlay
path.
"""

from __future__ import annotations

import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO_ROOT))

from core import data_store  # noqa: E402

# Import the script as a module so we can call its pure helpers and
# the run_merge() entry point directly.
_SCRIPTS = _REPO_ROOT / "scripts"
sys.path.insert(0, str(_SCRIPTS))
import merge_unknown_pulse_ids as merger  # noqa: E402


# ------------------------------------------------------------------
# Fixtures
# ------------------------------------------------------------------
def _ricus_unknown_record() -> dict:
    return {
        "Name": "Ricus",
        "Race": "T",
        "Notes": "",
        "Matchups": {
            "PvT": {
                "Wins": 1,
                "Losses": 0,
                "Games": [
                    {
                        "Date": "2026-05-01 09:14",
                        "Result": "Victory",
                        "Map": "Ultralove LE",
                        "Duration": 412,
                        "my_build": "PvT - Glaives All-In",
                        "opp_strategy": "Terran - 1-1-1",
                        "build_log": ["[0:00] Nexus", "[0:18] Pylon"],
                    },
                ],
            },
        },
    }


def _ricus_numeric_record() -> dict:
    return {
        "Name": "Ricus#545",
        "Race": "T",
        "Notes": "Aggressive 1-1-1 player.",
        "Matchups": {
            "PvT": {
                "Wins": 0,
                "Losses": 1,
                "Games": [
                    {
                        "Date": "2026-04-30 22:01",
                        "Result": "Defeat",
                        "Map": "Goldenaura LE",
                        "Duration": 503,
                    },
                ],
            },
        },
    }


def _yamada_unknown_record_overlapping() -> dict:
    """An ``unknown:Yamada`` record whose game identity collides with a
    later record under the numeric Pulse ID. Used to verify that the
    merge patches the existing record rather than appending a duplicate
    or double-counting the win/loss."""
    return {
        "Name": "Yamada",
        "Race": "Z",
        "Notes": "",
        "Matchups": {
            "PvZ": {
                "Wins": 1,
                "Losses": 0,
                "Games": [
                    {
                        "Date": "2026-05-01 10:30",
                        "Result": "Victory",
                        "Map": "Whispers of Gold LE",
                        "Duration": 280,
                        "my_build": "PvZ - Stargate Opener",
                    },
                ],
            },
        },
    }


def _yamada_numeric_record_overlapping() -> dict:
    return {
        "Name": "Yamada#622",
        "Race": "Z",
        "Notes": "",
        "Matchups": {
            "PvZ": {
                "Wins": 1,
                "Losses": 0,
                "Games": [
                    {
                        "Date": "2026-05-01 10:30",
                        "Result": "Victory",
                        "Map": "Whispers of Gold LE",
                        "Duration": 280,
                        # opp_strategy missing here on purpose -- the
                        # merge fills it in from the unknown record.
                    },
                ],
            },
        },
    }


# ------------------------------------------------------------------
# build_unknown_to_numeric_map
# ------------------------------------------------------------------
class BuildPlanTest(unittest.TestCase):
    def test_pairs_unknown_with_numeric_twin(self) -> None:
        history = {
            "unknown:Ricus": _ricus_unknown_record(),
            "234362": _ricus_numeric_record(),
        }
        plan = merger.build_unknown_to_numeric_map(history)
        self.assertEqual(plan, {"unknown:Ricus": "234362"})

    def test_unknown_without_twin_is_skipped(self) -> None:
        history = {
            "unknown:Mirtillo": {
                "Name": "Mirtillo",
                "Race": "P",
                "Notes": "",
                "Matchups": {},
            },
            "234362": _ricus_numeric_record(),
        }
        plan = merger.build_unknown_to_numeric_map(history)
        self.assertEqual(plan, {})

    def test_only_numeric_records_are_skipped(self) -> None:
        history = {
            "234362": _ricus_numeric_record(),
            "340938838": {
                "Name": "Yamada#622",
                "Race": "Z",
                "Notes": "",
                "Matchups": {},
            },
        }
        self.assertEqual(merger.build_unknown_to_numeric_map(history), {})

    def test_clan_tagged_numeric_still_matches(self) -> None:
        history = {
            "unknown:Ricus": _ricus_unknown_record(),
            "234362": {
                **_ricus_numeric_record(),
                "Name": "[CLAN]Ricus#545",
            },
        }
        self.assertEqual(
            merger.build_unknown_to_numeric_map(history),
            {"unknown:Ricus": "234362"},
        )


# ------------------------------------------------------------------
# merge_records_in_place
# ------------------------------------------------------------------
class MergeRecordsTest(unittest.TestCase):
    def test_appends_disjoint_games_and_bumps_counters(self) -> None:
        history = {
            "unknown:Ricus": _ricus_unknown_record(),
            "234362": _ricus_numeric_record(),
        }
        plan = {"unknown:Ricus": "234362"}
        stats = merger.merge_records_in_place(history, plan)

        self.assertNotIn("unknown:Ricus", history, "unknown key must be removed")
        merged = history["234362"]
        pvt = merged["Matchups"]["PvT"]

        self.assertEqual(pvt["Wins"], 1, "appended Victory must bump Wins")
        self.assertEqual(pvt["Losses"], 1, "pre-existing Defeat preserved")
        self.assertEqual(len(pvt["Games"]), 2)

        # Deep-parse fields preserved on the appended game.
        appended = next(g for g in pvt["Games"] if g["Result"] == "Victory")
        self.assertEqual(appended["my_build"], "PvT - Glaives All-In")
        self.assertEqual(appended["opp_strategy"], "Terran - 1-1-1")

        pair = stats["pairs"][0]
        self.assertEqual(pair["games_appended"], 1)
        self.assertEqual(pair["games_patched"], 0)
        self.assertEqual(pair["wins_added"], 1)
        self.assertEqual(pair["losses_added"], 0)

    def test_dedupes_identity_collision_and_patches_in_place(self) -> None:
        history = {
            "unknown:Yamada": _yamada_unknown_record_overlapping(),
            "340938838": _yamada_numeric_record_overlapping(),
        }
        plan = {"unknown:Yamada": "340938838"}
        stats = merger.merge_records_in_place(history, plan)

        merged = history["340938838"]
        pvz = merged["Matchups"]["PvZ"]
        self.assertEqual(pvz["Wins"], 1, "MUST NOT double-count the colliding Victory")
        self.assertEqual(pvz["Losses"], 0)
        self.assertEqual(len(pvz["Games"]), 1, "identity collision -> patched, not appended")
        # Patched-in field from the unknown side fills the blank.
        game = pvz["Games"][0]
        self.assertEqual(game["my_build"], "PvZ - Stargate Opener")

        pair = stats["pairs"][0]
        self.assertEqual(pair["games_appended"], 0)
        self.assertEqual(pair["games_patched"], 1)
        self.assertEqual(pair["wins_added"], 0)

    def test_carries_race_and_notes_when_numeric_blank(self) -> None:
        history = {
            "unknown:Ricus": _ricus_unknown_record(),
            "234362": {
                "Name": "Ricus#545",
                "Race": "",   # blank — should be filled from unknown.
                "Notes": "",  # blank — should be filled from unknown.
                "Matchups": {},
            },
        }
        # Put a non-empty Notes onto the unknown side so the carry-over
        # is observable.
        history["unknown:Ricus"]["Notes"] = "First met in Day9 cup."
        merger.merge_records_in_place(history, {"unknown:Ricus": "234362"})
        self.assertEqual(history["234362"]["Race"], "T")
        self.assertEqual(history["234362"]["Notes"], "First met in Day9 cup.")

    def test_does_not_overwrite_existing_notes(self) -> None:
        history = {
            "unknown:Ricus": {
                **_ricus_unknown_record(),
                "Notes": "stale note",
            },
            "234362": _ricus_numeric_record(),  # already has Notes set
        }
        merger.merge_records_in_place(history, {"unknown:Ricus": "234362"})
        self.assertEqual(history["234362"]["Notes"], "Aggressive 1-1-1 player.")


# ------------------------------------------------------------------
# rewrite_analyzer_pulse_ids
# ------------------------------------------------------------------
class RewriteAnalyzerPulseIdsTest(unittest.TestCase):
    def test_rewrites_only_matching_keys(self) -> None:
        meta = {
            "PvT - Glaives All-In": {
                "wins": 1, "losses": 0,
                "games": [
                    {"id": "g1", "opponent": "Ricus", "opp_pulse_id": "unknown:Ricus"},
                    {"id": "g2", "opponent": "Other", "opp_pulse_id": "999999"},
                ],
            },
            "PvZ - Stargate Opener": {
                "wins": 1, "losses": 0,
                "games": [
                    {"id": "g3", "opponent": "Yamada", "opp_pulse_id": "unknown:Yamada"},
                ],
            },
        }
        plan = {
            "unknown:Ricus": "234362",
            "unknown:Yamada": "340938838",
        }
        rewritten = merger.rewrite_analyzer_pulse_ids(meta, plan)
        self.assertEqual(rewritten, 2)
        self.assertEqual(
            meta["PvT - Glaives All-In"]["games"][0]["opp_pulse_id"], "234362"
        )
        # Untouched.
        self.assertEqual(
            meta["PvT - Glaives All-In"]["games"][1]["opp_pulse_id"], "999999"
        )
        self.assertEqual(
            meta["PvZ - Stargate Opener"]["games"][0]["opp_pulse_id"], "340938838"
        )

    def test_handles_missing_or_empty_field(self) -> None:
        meta = {
            "B": {
                "games": [
                    {"id": "x"},
                    {"id": "y", "opp_pulse_id": ""},
                    {"id": "z", "opp_pulse_id": None},
                ],
            },
        }
        self.assertEqual(merger.rewrite_analyzer_pulse_ids(meta, {"unknown:Q": "1"}), 0)


# ------------------------------------------------------------------
# run_merge end-to-end
# ------------------------------------------------------------------
class RunMergeEndToEndTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.mkdtemp(prefix="sc2_merge_e2e_")
        self.history_path = os.path.join(self.tmpdir, "MyOpponentHistory.json")
        self.meta_path = os.path.join(self.tmpdir, "meta_database.json")
        # Seed Black Book.
        bb = data_store.BlackBookStore(self.history_path)
        bb.save({
            "unknown:Ricus": _ricus_unknown_record(),
            "234362": _ricus_numeric_record(),
            "unknown:Mirtillo": {
                "Name": "Mirtillo",
                "Race": "P",
                "Notes": "",
                "Matchups": {},
            },
        })
        # Seed analyzer DB with a cross-link to the unknown key.
        with open(self.meta_path, "w", encoding="utf-8") as f:
            json.dump({
                "PvT - Glaives All-In": {
                    "wins": 1,
                    "losses": 0,
                    "games": [
                        {
                            "id": "g1",
                            "opponent": "Ricus",
                            "opp_pulse_id": "unknown:Ricus",
                            "result": "Win",
                        },
                    ],
                },
            }, f)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_dry_run_writes_nothing(self) -> None:
        with open(self.history_path, "rb") as _f:
            before_history = _f.read()
        with open(self.meta_path, "rb") as _f:
            before_meta = _f.read()
        buf = io.StringIO()

        rc = merger.run_merge(
            history_path=self.history_path,
            meta_path=self.meta_path,
            dry_run=True,
            out=buf,
        )
        self.assertEqual(rc, 0)
        with open(self.history_path, "rb") as _f:
            self.assertEqual(_f.read(), before_history)
        with open(self.meta_path, "rb") as _f:
            self.assertEqual(_f.read(), before_meta)
        # No backup files were created.
        siblings = os.listdir(self.tmpdir)
        self.assertFalse(
            any(".pre-merge-unknown-" in s for s in siblings),
            f"dry-run must not write backups, got {siblings}",
        )
        self.assertIn("unknown:Ricus", buf.getvalue())
        self.assertIn("--dry-run", buf.getvalue())

    def test_real_run_merges_writes_backup_and_rewrites_cross_link(self) -> None:
        buf = io.StringIO()
        rc = merger.run_merge(
            history_path=self.history_path,
            meta_path=self.meta_path,
            dry_run=False,
            out=buf,
        )
        self.assertEqual(rc, 0)

        # Backups exist for every mutated file.
        siblings = os.listdir(self.tmpdir)
        self.assertTrue(any(s.startswith("MyOpponentHistory.json.pre-merge-unknown-")
                            for s in siblings))
        self.assertTrue(any(s.startswith("meta_database.json.pre-merge-unknown-")
                            for s in siblings))

        # Black Book: unknown:Ricus folded into 234362; unknown:Mirtillo
        # left intact (no twin).
        with open(self.history_path, "r", encoding="utf-8") as f:
            history = json.load(f)
        self.assertNotIn("unknown:Ricus", history)
        self.assertIn("unknown:Mirtillo", history)
        pvt = history["234362"]["Matchups"]["PvT"]
        self.assertEqual(pvt["Wins"], 1)
        self.assertEqual(pvt["Losses"], 1)
        self.assertEqual(len(pvt["Games"]), 2)

        # Analyzer DB: opp_pulse_id rewritten.
        with open(self.meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
        self.assertEqual(
            meta["PvT - Glaives All-In"]["games"][0]["opp_pulse_id"], "234362"
        )

    def test_idempotent_second_run_is_a_noop(self) -> None:
        merger.run_merge(
            history_path=self.history_path,
            meta_path=self.meta_path,
            dry_run=False,
            out=io.StringIO(),
        )
        with open(self.history_path, "rb") as _f:
            before_history = _f.read()
        with open(self.meta_path, "rb") as _f:
            before_meta = _f.read()
        buf = io.StringIO()
        rc = merger.run_merge(
            history_path=self.history_path,
            meta_path=self.meta_path,
            dry_run=False,
            out=buf,
        )
        self.assertEqual(rc, 0)
        # No more pairs to merge -> no writes.
        with open(self.history_path, "rb") as _f:
            self.assertEqual(_f.read(), before_history)
        with open(self.meta_path, "rb") as _f:
            self.assertEqual(_f.read(), before_meta)
        self.assertIn("nothing to do", buf.getvalue())

    def test_missing_history_returns_error(self) -> None:
        os.unlink(self.history_path)
        rc = merger.run_merge(
            history_path=self.history_path,
            meta_path=self.meta_path,
            dry_run=False,
            out=io.StringIO(),
        )
        self.assertEqual(rc, 1)


if __name__ == "__main__":
    unittest.main()
