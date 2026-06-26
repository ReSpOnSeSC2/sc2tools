"""Regression: a 2-Stargate Void Ray opener that adds a LATE Robo must
stay ``PvZ - 2 Stargate Void Ray`` -- only an EARLY Robo reroutes to
``PvZ - Stargate into Robo``.

The Void Ray rule used to reject *any* Robotics Facility started before
10:00 (``not has_building("RoboticsFacility", 600)``). That stole real
2-Stargate Void Ray games the moment the player added a support Robo
(Observers / Immortals behind the air) -- the very next rule, Stargate
into Robo, grabbed them on nothing more than "Robo + one Stargate unit".

The fix narrows the Void Ray rule's Robo guard to an EARLY window
(before 6:00 / 360s). The defining signal for a Void Ray build is the
4+ Void Rays by 10:00 -- a genuine Stargate->Robo transition never has
that many Void Rays out, so a LATER Robo behind a committed air force
is support, not a tech switch, and must not reclassify the game. An
EARLY Robo (before 6:00, before the air is even on the field) is still
a real Robo-first transition and correctly falls to Stargate into Robo.
The Phoenix rules deliberately keep the full 10:00 Robo window.

Both detector entry points are exercised: the canonical
``core.strategy_detector_user`` decision tree and the ``detectors.user``
mirror.
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


def _voidray_opener_with_robo_at(robo_time: int) -> List[Dict[str, Any]]:
    """Stargate-first, exactly 2 Stargates, 2 bases, 4 Void Rays by 10:00,
    no Glaives -- with a Robotics Facility started at ``robo_time``."""
    return [
        _building("Nexus", 0),
        _building("Pylon", 18),
        _building("Gateway", 60),
        _building("Assimilator", 75),
        _building("CyberneticsCore", 100),
        _building("Nexus", 150),
        _building("Stargate", 200),   # FIRST tech building -> stargate-first
        _building("Stargate", 260),   # exactly 2 Stargates by 10:00
        _building("RoboticsFacility", robo_time),
        # Stargate exists before every Void Ray, so none are filtered as
        # Sentry hallucinations. 4 by 10:00 = the headline air commitment.
        _unit("VoidRay", 300),
        _unit("VoidRay", 345),
        _unit("VoidRay", 390),
        _unit("VoidRay", 435),
    ]


def _detectors():
    return (
        CanonicalUserBuildDetector(custom_builds=[]),
        MirrorUserBuildDetector(custom_builds=[]),
    )


def test_late_robo_stays_2_stargate_void_ray():
    """Robo at 7:30 (after 6:00) = Observer / Immortal support behind the
    air -> the build keeps the Void Ray label."""
    events = _voidray_opener_with_robo_at(450)  # 7:30
    for det in _detectors():
        result = det.detect_my_build("vs Zerg", events, my_race="Protoss")
        assert result == "PvZ - 2 Stargate Void Ray", result
        assert result != "PvZ - Stargate into Robo"


def test_early_robo_still_reroutes_to_stargate_into_robo():
    """Guard against over-correction: a Robo at 5:00 (before 6:00) is a
    genuine Robo-first transition and must still fall to Stargate into
    Robo, not the Void Ray label."""
    events = _voidray_opener_with_robo_at(300)  # 5:00
    for det in _detectors():
        result = det.detect_my_build("vs Zerg", events, my_race="Protoss")
        assert result == "PvZ - Stargate into Robo", result
        assert result != "PvZ - 2 Stargate Void Ray"
