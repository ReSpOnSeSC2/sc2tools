"""Live balance-duration constants shared by replay timestamp recovery."""

import unittest

from core.event_extractor import STRUCTURE_MORPH_SECONDS, UNIT_BUILD_SECONDS


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


if __name__ == "__main__":
    unittest.main()
