"""
Tests for DataStore.link_game() and BlackBookStore.upsert_game().

These tests reproduce the bug seen in production on 2026-04-28:
two back-to-back replays against the same opponent, in the same matchup,
where the second replay's deep-parse fields overwrote the first replay's
record instead of appending a new one. The bug surfaces when:

    - PowerShell's Update-OpponentHistory could not write a stub
      (e.g. opponent played Random and SC2Pulse could not resolve a
      numeric Character ID, so the watcher fell back to a synthetic
      ``unknown:<Name>`` key)
    - Two replays with the same resolved (my_race, opp_race) matchup
      arrive at the deep-parse stage in sequence

The legacy ``update_latest_game`` patched ``Games[-1]`` blindly. We now
match by stable identity (Date prefix + Map + Result) so each replay
finds its own record (or appends a new one).

Real-shaped game payloads — no mocks, no fake structures.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

# Bypass core/__init__.py (which imports sc2reader) by loading the
# data_store module directly. The fix lives in the same module so
# importing it standalone is sufficient.
_REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO_ROOT))

# Late import after sys.path is set up.
from core import data_store  # noqa: E402


# ------------------------------------------------------------------
# Real-shaped fixtures: the two Mirtillo replays from the production
# repro on 2026-04-28. Field shapes match what watchers/replay_watcher.py
# actually produces (see _persist_deep -> link_game).
# ------------------------------------------------------------------
GAME_LOSS = {
    "pulse_id": "unknown:Mirtillo",
    "matchup": "PvP",
    "opp_name": "Mirtillo",
    "opp_race_initial": "P",
    "my_race": "Protoss",
    "my_build": "PvP - Strange's 1 Gate Expand",
    "opp_strategy": "Protoss - Proxy Stargate Opener",
    "result": "Defeat",
    "analyzer_game": {
        "id": "2026-04-28T17:11:42|Mirtillo|10000 Feet LE|534",
        "opponent": "Mirtillo",
        "opp_race": "Protoss",
        "opp_strategy": "Protoss - Proxy Stargate Opener",
        "map": "10000 Feet LE",
        "result": "Loss",
        "date": "2026-04-28T17:11:42",
        "game_length": 534,
        "build_log": ["[0:00] Nexus", "[0:24] Pylon"],
    },
    "black_book_game": {
        "Date": "2026-04-28 17:11",
        "Result": "Defeat",
        "Map": "10000 Feet LE",
        "Duration": 534,
        "opp_strategy": "Protoss - Proxy Stargate Opener",
        "my_build": "PvP - Strange's 1 Gate Expand",
        "build_log": ["[0:00] Nexus", "[0:24] Pylon"],
    },
}

GAME_WIN = {
    "pulse_id": "unknown:Mirtillo",
    "matchup": "PvP",
    "opp_name": "Mirtillo",
    "opp_race_initial": "P",
    "my_race": "Protoss",
    "my_build": "PvP - 1 Gate Nexus into 4 Gate",
    "opp_strategy": "Protoss - Standard Expand",
    "result": "Victory",
    "analyzer_game": {
        "id": "2026-04-28T17:17:40|Mirtillo|Ruby Rock LE|317",
        "opponent": "Mirtillo",
        "opp_race": "Protoss",
        "opp_strategy": "Protoss - Standard Expand",
        "map": "Ruby Rock LE",
        "result": "Win",
        "date": "2026-04-28T17:17:40",
        "game_length": 317,
        "build_log": ["[0:00] Nexus", "[0:27] Pylon"],
    },
    "black_book_game": {
        "Date": "2026-04-28 17:17",
        "Result": "Victory",
        "Map": "Ruby Rock LE",
        "Duration": 317,
        "opp_strategy": "Protoss - Standard Expand",
        "my_build": "PvP - 1 Gate Nexus into 4 Gate",
        "build_log": ["[0:00] Nexus", "[0:27] Pylon"],
    },
}


def _link(store: "data_store.DataStore", payload: dict) -> None:
    """Drive ``DataStore.link_game`` from the canonical payload shape."""
    store.link_game(
        pulse_id=payload["pulse_id"],
        matchup=payload["matchup"],
        opp_name=payload["opp_name"],
        opp_race_initial=payload["opp_race_initial"],
        my_build=payload["my_build"],
        opp_strategy=payload["opp_strategy"],
        analyzer_game=dict(payload["analyzer_game"]),
        black_book_game=dict(payload["black_book_game"]),
        result=payload["result"],
        my_race=payload["my_race"],
    )


class LinkGameBackToBackTest(unittest.TestCase):
    """End-to-end DataStore.link_game smoke."""

    def setUp(self) -> None:
        self.tmpdir = tempfile.mkdtemp(prefix="sc2_data_store_test_")
        self.history_path = os.path.join(self.tmpdir, "MyOpponentHistory.json")
        self.meta_path = os.path.join(self.tmpdir, "meta_database.json")
        # Both stores get isolated tmp paths so the test never touches
        # the real data/ directory.
        self.store = data_store.DataStore()
        self.store.black_book = data_store.BlackBookStore(self.history_path)
        self.store.analyzer = data_store.AnalyzerDBStore(self.meta_path)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    # --- The bug we're fixing ----------------------------------------
    def test_back_to_back_random_opponent_appends_both_games(self) -> None:
        """Both replays must produce two distinct PvP records."""
        _link(self.store, GAME_LOSS)
        _link(self.store, GAME_WIN)

        with open(self.history_path, "r", encoding="utf-8") as f:
            db = json.load(f)

        self.assertIn("unknown:Mirtillo", db)
        pvp = db["unknown:Mirtillo"]["Matchups"]["PvP"]
        self.assertEqual(pvp["Wins"], 1, "Win must be counted")
        self.assertEqual(pvp["Losses"], 1, "Loss must be counted")
        self.assertEqual(len(pvp["Games"]), 2, "Both replays must be appended")

        dates = sorted(g["Date"] for g in pvp["Games"])
        self.assertEqual(dates, ["2026-04-28 17:11", "2026-04-28 17:17"])

    def test_loss_record_keeps_its_own_deep_fields(self) -> None:
        """The Loss record must carry the Loss's deep parse output, not the Win's."""
        _link(self.store, GAME_LOSS)
        _link(self.store, GAME_WIN)

        with open(self.history_path, "r", encoding="utf-8") as f:
            db = json.load(f)
        games = db["unknown:Mirtillo"]["Matchups"]["PvP"]["Games"]
        loss = next(g for g in games if g["Result"] == "Defeat")
        win = next(g for g in games if g["Result"] == "Victory")

        self.assertEqual(loss["Map"], "10000 Feet LE")
        self.assertEqual(loss["Duration"], 534)
        self.assertEqual(loss["my_build"], "PvP - Strange's 1 Gate Expand")
        self.assertEqual(loss["opp_strategy"], "Protoss - Proxy Stargate Opener")

        self.assertEqual(win["Map"], "Ruby Rock LE")
        self.assertEqual(win["Duration"], 317)
        self.assertEqual(win["my_build"], "PvP - 1 Gate Nexus into 4 Gate")
        self.assertEqual(win["opp_strategy"], "Protoss - Standard Expand")

    # --- Existing happy path: PowerShell stub then deep parse --------
    def test_powershell_stub_then_deep_parse_patches_in_place(self) -> None:
        """Pre-existing stub from PowerShell must be patched, not duplicated."""
        # Simulate the live PS write: stub with just Date/Result/Map.
        stub = {
            "Date": "2026-04-28 17:11",
            "Result": "Defeat",
            "Map": "10000 Feet LE",
        }
        self.store.black_book.append_game(
            pulse_id="unknown:Mirtillo",
            opp_name="Mirtillo",
            opp_race_initial="P",
            matchup="PvP",
            game=stub,
            result="Defeat",
        )
        # Now the deep parse arrives.
        _link(self.store, GAME_LOSS)

        with open(self.history_path, "r", encoding="utf-8") as f:
            db = json.load(f)
        pvp = db["unknown:Mirtillo"]["Matchups"]["PvP"]
        self.assertEqual(pvp["Wins"], 0)
        self.assertEqual(pvp["Losses"], 1, "Stub already counted; deep parse must NOT double-count")
        self.assertEqual(len(pvp["Games"]), 1, "Deep parse patches the stub, no new record")
        # Deep fields are present after patching.
        g = pvp["Games"][0]
        self.assertEqual(g["my_build"], "PvP - Strange's 1 Gate Expand")
        self.assertEqual(g["opp_strategy"], "Protoss - Proxy Stargate Opener")
        self.assertEqual(g["Duration"], 534)


class UpsertGameIdentityTest(unittest.TestCase):
    """Direct unit tests for the identity-aware patch-or-append helper."""

    def setUp(self) -> None:
        self.tmpdir = tempfile.mkdtemp(prefix="sc2_upsert_test_")
        self.history_path = os.path.join(self.tmpdir, "MyOpponentHistory.json")
        self.bb = data_store.BlackBookStore(self.history_path)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_upsert_appends_when_no_match(self) -> None:
        new_game = {
            "Date": "2026-04-28 17:11",
            "Result": "Defeat",
            "Map": "10000 Feet LE",
            "Duration": 534,
        }
        appended = self.bb.upsert_game(
            pulse_id="unknown:Mirtillo",
            opp_name="Mirtillo",
            opp_race_initial="P",
            matchup="PvP",
            game=new_game,
            result="Defeat",
        )
        self.assertTrue(appended, "Empty matchup must append")
        db = self.bb.load()
        pvp = db["unknown:Mirtillo"]["Matchups"]["PvP"]
        self.assertEqual(pvp["Losses"], 1)
        self.assertEqual(len(pvp["Games"]), 1)

    def test_upsert_patches_when_identity_matches(self) -> None:
        # Pre-existing stub with identity (Date, Result, Map).
        self.bb.append_game(
            pulse_id="unknown:Mirtillo",
            opp_name="Mirtillo",
            opp_race_initial="P",
            matchup="PvP",
            game={
                "Date": "2026-04-28 17:11",
                "Result": "Defeat",
                "Map": "10000 Feet LE",
            },
            result="Defeat",
        )
        appended = self.bb.upsert_game(
            pulse_id="unknown:Mirtillo",
            opp_name="Mirtillo",
            opp_race_initial="P",
            matchup="PvP",
            game={
                "Date": "2026-04-28 17:11",
                "Result": "Defeat",
                "Map": "10000 Feet LE",
                "Duration": 534,
                "my_build": "PvP - Strange's 1 Gate Expand",
            },
            result="Defeat",
        )
        self.assertFalse(appended, "Identity match must patch in place")
        pvp = self.bb.load()["unknown:Mirtillo"]["Matchups"]["PvP"]
        self.assertEqual(pvp["Losses"], 1, "No double-count on patch")
        self.assertEqual(len(pvp["Games"]), 1)
        self.assertEqual(pvp["Games"][0]["Duration"], 534)
        self.assertEqual(pvp["Games"][0]["my_build"], "PvP - Strange's 1 Gate Expand")

    def test_upsert_appends_when_only_date_matches(self) -> None:
        """Different map ⇒ different game even at the same minute."""
        self.bb.append_game(
            pulse_id="unknown:Mirtillo",
            opp_name="Mirtillo",
            opp_race_initial="P",
            matchup="PvP",
            game={
                "Date": "2026-04-28 17:11",
                "Result": "Defeat",
                "Map": "10000 Feet LE",
            },
            result="Defeat",
        )
        appended = self.bb.upsert_game(
            pulse_id="unknown:Mirtillo",
            opp_name="Mirtillo",
            opp_race_initial="P",
            matchup="PvP",
            game={
                "Date": "2026-04-28 17:11",
                "Result": "Victory",
                "Map": "Ruby Rock LE",
                "Duration": 317,
            },
            result="Victory",
        )
        self.assertTrue(appended)
        pvp = self.bb.load()["unknown:Mirtillo"]["Matchups"]["PvP"]
        self.assertEqual(len(pvp["Games"]), 2)
        self.assertEqual(pvp["Wins"], 1)
        self.assertEqual(pvp["Losses"], 1)


if __name__ == "__main__":
    unittest.main()
