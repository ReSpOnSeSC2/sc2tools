"""Anti-hallucination prerequisite guard tests.

Covers the rule defended against in the screenshot bug: a Sentry
hallucinates a Phoenix in PvT and the user's build was being mis-tagged
as "PvT - Phoenix Opener". The fix is two-fold and is exercised here:

  1. ``count_real_units`` returns 0 for a Phoenix event whose
     prerequisite Stargate was never built before the unit appeared.
  2. ``UserBuildDetector.detect_my_build`` no longer returns
     "PvT - Phoenix Opener" / "PvT - Phoenix into Robo" when the only
     Phoenix in the replay was a Sentry hallucination.

Pure-function tests over fabricated event lists — no replay parsing,
so this runs without sc2reader in the test environment.
"""
from __future__ import annotations

import os
import sys
from typing import Any, Dict, List
from unittest.mock import MagicMock

# sc2reader is optional in CI; mock it so detector imports succeed.
sys.modules.setdefault("sc2reader", MagicMock())
sys.modules.setdefault("sc2reader.events", MagicMock())
sys.modules.setdefault("sc2reader.events.tracker", MagicMock())
sys.modules.setdefault("sc2reader.events.game", MagicMock())

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import pytest  # noqa: E402

from detectors.base import (  # noqa: E402
    UNIT_TECH_PREREQUISITES,
    count_real_units,
    unit_prereq_met,
)
from detectors.user import UserBuildDetector  # noqa: E402


# -----------------------------------------------------------------------------
# Event helpers
# -----------------------------------------------------------------------------
def _building(name: str, time: int, x: float = 0.0, y: float = 0.0) -> Dict[str, Any]:
    return {
        "type": "building", "name": name, "time": time, "x": x, "y": y,
        "subtype": "init",
    }


def _unit(name: str, time: int, x: float = 0.0, y: float = 0.0) -> Dict[str, Any]:
    return {"type": "unit", "name": name, "time": time, "x": x, "y": y}


def _upgrade(name: str, time: int) -> Dict[str, Any]:
    return {"type": "upgrade", "name": name, "time": time}


# -----------------------------------------------------------------------------
# count_real_units / unit_prereq_met
# -----------------------------------------------------------------------------
class TestUnitPrereqMet:
    def test_phoenix_without_stargate_is_hallucination(self):
        # Cyber Core + Twilight built; Sentry hallucinates a Phoenix.
        # No Stargate has ever been started.
        buildings = [
            _building("Nexus", 0),
            _building("Pylon", 18),
            _building("Gateway", 60),
            _building("Assimilator", 75),
            _building("CyberneticsCore", 100),
            _building("TwilightCouncil", 200),
        ]
        assert unit_prereq_met("Phoenix", 240, buildings) is False

    def test_phoenix_with_stargate_is_real(self):
        buildings = [
            _building("Nexus", 0),
            _building("Stargate", 220),
        ]
        assert unit_prereq_met("Phoenix", 240, buildings) is True

    def test_phoenix_with_only_late_stargate_is_hallucination_for_early_unit(self):
        # Stargate started AFTER the Phoenix appeared cannot have produced it.
        buildings = [
            _building("Nexus", 0),
            _building("Stargate", 300),
        ]
        # A Phoenix at 240s is still a hallucination because the
        # Stargate construction starts later in the game.
        assert unit_prereq_met("Phoenix", 240, buildings) is False

    def test_destroyed_stargate_still_qualifies_later_phoenix(self):
        # User's clarification: the building can be destroyed later.
        # The construction event remains in the events list, so a
        # Phoenix at 7:00 still qualifies even if the Stargate was killed.
        buildings = [
            _building("Nexus", 0),
            _building("Stargate", 240),  # built then died (death not modelled here)
        ]
        assert unit_prereq_met("Phoenix", 420, buildings) is True

    def test_archon_satisfied_by_dark_shrine_alone(self):
        # Archon morphs from 2 DT, so Dark Shrine alone is sufficient.
        buildings = [_building("Nexus", 0), _building("DarkShrine", 360)]
        assert unit_prereq_met("Archon", 420, buildings) is True

    def test_archon_satisfied_by_templar_archives_alone(self):
        buildings = [_building("Nexus", 0), _building("TemplarArchive", 360)]
        assert unit_prereq_met("Archon", 420, buildings) is True

    def test_archon_without_either_path_is_hallucination(self):
        buildings = [_building("Nexus", 0), _building("Gateway", 60)]
        assert unit_prereq_met("Archon", 420, buildings) is False

    def test_carrier_needs_both_stargate_and_fleet_beacon(self):
        # Stargate alone is not enough -- need Fleet Beacon too.
        only_sg = [_building("Stargate", 240)]
        assert unit_prereq_met("Carrier", 600, only_sg) is False
        # Both: real Carrier eligible.
        sg_fb = [_building("Stargate", 240), _building("FleetBeacon", 360)]
        assert unit_prereq_met("Carrier", 600, sg_fb) is True

    def test_high_templar_requires_templar_archives(self):
        no_ta = [_building("Nexus", 0), _building("TwilightCouncil", 200)]
        assert unit_prereq_met("HighTemplar", 360, no_ta) is False
        with_ta = no_ta + [_building("TemplarArchive", 300)]
        assert unit_prereq_met("HighTemplar", 360, with_ta) is True

    def test_unknown_unit_passes_through(self):
        # Names not in the prereq table are counted unconditionally.
        assert unit_prereq_met("Probe", 60, []) is True
        assert unit_prereq_met("SomeFutureUnit", 60, []) is True


class TestCountRealUnits:
    def test_phoenix_count_strips_hallucinations(self):
        buildings = [_building("Nexus", 0), _building("CyberneticsCore", 100)]
        units = [
            _unit("Sentry", 230),
            _unit("Phoenix", 239),  # hallucinated
        ]
        assert count_real_units("Phoenix", 420, units, buildings) == 0

    def test_phoenix_count_keeps_real_phoenix(self):
        buildings = [_building("Stargate", 220)]
        units = [_unit("Phoenix", 280), _unit("Phoenix", 320)]
        assert count_real_units("Phoenix", 420, units, buildings) == 2

    def test_mixed_phoenix_only_real_ones_count(self):
        # First Phoenix is a hallucination (no Stargate yet); second
        # Phoenix is real (Stargate is up).
        buildings = [_building("Stargate", 250)]
        units = [_unit("Phoenix", 200), _unit("Phoenix", 280)]
        assert count_real_units("Phoenix", 420, units, buildings) == 1

    def test_time_limit_respected(self):
        buildings = [_building("Stargate", 100)]
        units = [_unit("Phoenix", 200), _unit("Phoenix", 500)]
        assert count_real_units("Phoenix", 300, units, buildings) == 1


# -----------------------------------------------------------------------------
# UserBuildDetector regression: hallucinated Phoenix must not flip the build
# -----------------------------------------------------------------------------
class TestPvtPhoenixHallucinationRegression:
    """Reproduces the screenshot scenario.

    PvT, user opens Gateway / Cyber / Twilight / Robo / Stargate-NOT-BUILT;
    Sentry hallucinates a Phoenix at ~3:59. Pre-fix the classifier
    returned 'PvT - Phoenix Opener' / 'PvT - Phoenix into Robo'. After
    the fix it must NOT.
    """

    @pytest.fixture
    def detector(self) -> UserBuildDetector:
        return UserBuildDetector(custom_builds=[])

    @pytest.fixture
    def hallucinated_phoenix_pvt_events(self) -> List[Dict[str, Any]]:
        # Loose reconstruction of the screenshot's build:
        return [
            _building("Nexus", 0),
            _building("Pylon", 18),
            _building("Gateway", 75),
            _building("Assimilator", 92),
            _building("CyberneticsCore", 115),
            _building("Nexus", 130),
            _building("Pylon", 165),
            _building("Assimilator", 180),
            _building("Gateway", 240),
            _building("TwilightCouncil", 270),
            _building("RoboticsFacility", 320),
            # NOTE: NO Stargate ever built.
            _unit("Stalker", 200),
            _unit("Sentry", 230),
            _unit("Phoenix", 239),  # <- Sentry hallucination
            _unit("Stalker", 280),
        ]

    def test_pvt_phoenix_opener_not_returned_without_stargate(
        self, detector, hallucinated_phoenix_pvt_events,
    ):
        result = detector.detect_my_build(
            "vs Terran",
            hallucinated_phoenix_pvt_events,
            my_race="Protoss",
        )
        assert result != "PvT - Phoenix Opener"
        assert result != "PvT - Phoenix into Robo"

    def test_pvt_phoenix_opener_returned_with_real_stargate(self, detector):
        events = [
            _building("Nexus", 0),
            _building("Pylon", 18),
            _building("Gateway", 75),
            _building("Assimilator", 92),
            _building("CyberneticsCore", 115),
            _building("Nexus", 130),
            _building("Stargate", 200),
            _building("Gateway", 260),
            _unit("Phoenix", 360),
        ]
        result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
        assert "Phoenix" in result, (
            f"Expected a Phoenix-build classification, got {result!r}"
        )


class TestPvt2BaseTemplarRequiresArchives:
    """A 2-base High Templar / Storm build cannot exist without a
    Templar Archives. The previous rule compared two infinities when
    neither structure was built, which could fire in odd corner cases."""

    @pytest.fixture
    def detector(self) -> UserBuildDetector:
        return UserBuildDetector(custom_builds=[])

    def test_no_templar_archives_does_not_classify_as_2_base_templar(
        self, detector,
    ):
        events = [
            _building("Nexus", 0),
            _building("Pylon", 18),
            _building("Gateway", 75),
            _building("Assimilator", 92),
            _building("CyberneticsCore", 115),
            _building("Gateway", 200),
            _building("Gateway", 220),
            _building("Gateway", 250),
            _building("Gateway", 280),  # 4 gates pre-7:30
            _building("Nexus", 130),
            # No TemplarArchive; no third Nexus either.
        ]
        result = detector.detect_my_build("vs Terran", events, my_race="Protoss")
        assert result != "PvT - 2 Base Templar (Reactive/Delayed 3rd)"


class TestPrereqTableShape:
    """Sanity-check the shared prereq table so a typo doesn't
    silently disable the guard for some unit."""

    def test_all_alternatives_are_lists_of_strings(self):
        for unit_name, alternatives in UNIT_TECH_PREREQUISITES.items():
            assert isinstance(alternatives, list)
            assert alternatives, f"empty alternatives for {unit_name!r}"
            for req_set in alternatives:
                assert isinstance(req_set, list)
                assert req_set, f"empty req-set for {unit_name!r}"
                for req in req_set:
                    assert isinstance(req, str) and req

    def test_phoenix_requires_stargate(self):
        assert UNIT_TECH_PREREQUISITES["Phoenix"] == [["Stargate"]]

    def test_archon_has_two_alternatives(self):
        # Archon morphs from HT or DT, so two alternatives.
        alts = UNIT_TECH_PREREQUISITES["Archon"]
        assert {tuple(a) for a in alts} == {("TemplarArchive",), ("DarkShrine",)}
