"""Live balance-duration constants shared by replay timestamp recovery."""

import unittest

from core.event_extractor import STRUCTURE_MORPH_SECONDS, UNIT_BUILD_SECONDS


class PatchDurationTests(unittest.TestCase):
    def test_5016b_warpgate_transform_duration(self) -> None:
        self.assertEqual(STRUCTURE_MORPH_SECONDS["WarpGate"], 4)

    def test_5016_first_hotfix_train_durations_are_carried_forward(self) -> None:
        self.assertEqual(UNIT_BUILD_SECONDS["Adept"], 33)
        self.assertEqual(UNIT_BUILD_SECONDS["HighTemplar"], 40)
        self.assertEqual(UNIT_BUILD_SECONDS["DarkTemplar"], 40)
        self.assertEqual(UNIT_BUILD_SECONDS["Reaper"], 34)


if __name__ == "__main__":
    unittest.main()
