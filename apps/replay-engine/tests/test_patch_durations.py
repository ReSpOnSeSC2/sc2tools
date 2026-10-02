"""Live balance-duration constants shared by replay timestamp recovery."""

import unittest

from core.event_extractor import (
    STRUCTURE_MORPH_SECONDS,
    UNIT_BUILD_SECONDS,
    _start_time,
)
from core.strategy_detector_helpers import UNIT_TECH_PREREQUISITES


class PatchDurationTests(unittest.TestCase):
    """12-worker game (before 5.0.16, and 5.0.17 on) values.

    The 8-worker patch 5.0.16 values live in the API's
    services/buildDurations.js, applied only to 5.0.16 games.
    """

    def test_12_worker_warpgate_transform_duration(self) -> None:
        self.assertEqual(STRUCTURE_MORPH_SECONDS["WarpGate"], 7)

    def test_12_worker_train_durations(self) -> None:
        self.assertEqual(UNIT_BUILD_SECONDS["Adept"], 27)
        self.assertEqual(UNIT_BUILD_SECONDS["HighTemplar"], 39)
        self.assertEqual(UNIT_BUILD_SECONDS["DarkTemplar"], 39)
        self.assertEqual(UNIT_BUILD_SECONDS["Reaper"], 32)

    def test_replay_named_units_rewind_like_their_display_name(self) -> None:
        # Events carry the replay's name for these three.
        self.assertEqual(_start_time("VikingFighter", 300, "unit"), 270)
        self.assertEqual(_start_time("SwarmHostMP", 400, "unit"), 371)
        self.assertEqual(_start_time("LurkerMP", 500, "unit"), 482)
        self.assertEqual(_start_time("Viking", 300, "unit"), 270)
        # A name in no table is left at its recorded time.
        self.assertEqual(_start_time("FlibbertyGibbet", 300, "unit"), 300)

    def test_every_prerequisite_unit_has_a_duration(self) -> None:
        missing = [
            name for name in UNIT_TECH_PREREQUISITES
            if name not in UNIT_BUILD_SECONDS
        ]
        self.assertEqual(missing, [])


if __name__ == "__main__":
    unittest.main()
