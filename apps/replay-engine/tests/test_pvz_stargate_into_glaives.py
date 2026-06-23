"""Regression: a Glaives-first PvZ Stargate opener that ADDS a Robo
must classify as ``PvZ - Stargate into Glaives``, not ``PvZ - Stargate
into Robo``.

The build under test opens Stargate first, then Twilight, researches
Resonating Glaives as the FIRST Twilight upgrade, and only afterwards
drops a Robotics Facility (Observer / Immortal support behind the
Glaive Adepts). The Robo lands AFTER the Twilight, so the Stargate is a
transition INTO Glaives -- the Robo is support, not the headline tech.

Before the fix the ``Stargate into Robo`` rule fired purely on
``Robo present + one Stargate unit``, stealing the replay from the
Glaives label even though Glaives was the defining tech choice. The
fix adds the ``not glaive_first_off_twilight`` guard the sibling
Stargate rules (2/3 SG Phoenix, 2 SG Void Ray) already carry.

Both detector entry points are exercised: the canonical
``core.strategy_detector_user`` decision tree and the
``detectors.user`` mirror.
"""

import os
import sys
from typing import Any, Dict, List
from unittest.mock import MagicMock

# sc2reader is import-time optional for these pure-Python trees.
sys.modules.setdefault("sc2reader", MagicMock())
sys.modules.setdefault("sc2reader.events", MagicMock())
sys.modules.setdefault("sc2reader.events.tracker", MagicMock())
sys.modules.setdefault("sc2reader.events.game", MagicMock())

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from core.strategy_detector_user import (  # noqa: E402
    UserBuildDetector as CanonicalUserBuildDetector,
)
from detectors.user import (  # noqa: E402
    UserBuildDetector as MirrorUserBuildDetector,
)


def _building(name: str, time: int, x: float = 0.0, y: float = 0.0) -> Dict[str, Any]:
    return {
        "type": "building", "name": name, "time": time, "x": x, "y": y,
        "subtype": "init",
    }


def _unit(name: str, time: int) -> Dict[str, Any]:
    return {"type": "unit", "name": name, "time": time, "x": 0.0, "y": 0.0}


def _upgrade(name: str, time: int) -> Dict[str, Any]:
    return {"type": "upgrade", "name": name, "time": time}


def _stargate_into_glaives_events() -> List[Dict[str, Any]]:
    """Stargate first -> Twilight -> Glaives (first upgrade) -> Robo."""
    return [
        _building("Nexus", 0),
        _building("Pylon", 18),
        _building("Gateway", 60),
        _building("Assimilator", 75),
        _building("CyberneticsCore", 100),
        _building("Nexus", 150),
        _building("Stargate", 200),        # first tech building
        _building("TwilightCouncil", 280),  # AFTER the Stargate
        _building("RoboticsFacility", 340),  # AFTER the Twilight (support)
        # Real Phoenix (Stargate exists, so it is not a hallucination) --
        # this is the exact signal the Stargate-into-Robo rule used to
        # grab the replay on.
        _unit("Phoenix", 360),
        # Resonating Glaives is the FIRST (and only) Twilight upgrade.
        _upgrade("AdeptPiercingAttack", 320),
    ]


def test_canonical_glaives_first_with_robo_is_stargate_into_glaives():
    det = CanonicalUserBuildDetector(custom_builds=[])
    result = det.detect_my_build(
        "vs Zerg", _stargate_into_glaives_events(), my_race="Protoss",
    )
    assert result == "PvZ - Stargate into Glaives", result
    assert result != "PvZ - Stargate into Robo"


def test_mirror_glaives_first_with_robo_is_stargate_into_glaives():
    det = MirrorUserBuildDetector(custom_builds=[])
    result = det.detect_my_build(
        "vs Zerg", _stargate_into_glaives_events(), my_race="Protoss",
    )
    assert result == "PvZ - Stargate into Glaives", result
    assert result != "PvZ - Stargate into Robo"


def test_stargate_into_robo_still_fires_without_glaives_first():
    """Guard against over-correction: a Stargate opener that adds a Robo
    but does NOT research Glaives first (no Twilight / no Glaive upgrade)
    must still classify as ``PvZ - Stargate into Robo``."""
    events = [
        _building("Nexus", 0),
        _building("Pylon", 18),
        _building("Gateway", 60),
        _building("Assimilator", 75),
        _building("CyberneticsCore", 100),
        _building("Nexus", 150),
        _building("Stargate", 200),        # first tech building
        _building("RoboticsFacility", 320),  # Robo is the transition tech
        _unit("Phoenix", 360),
        # No Twilight, no Glaive research -- pure Stargate-into-Robo.
    ]
    for det in (
        CanonicalUserBuildDetector(custom_builds=[]),
        MirrorUserBuildDetector(custom_builds=[]),
    ):
        result = det.detect_my_build("vs Zerg", events, my_race="Protoss")
        assert result == "PvZ - Stargate into Robo", result
