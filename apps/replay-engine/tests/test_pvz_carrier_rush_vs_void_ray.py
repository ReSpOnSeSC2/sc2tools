"""Regression: a Stargate-first Carrier rush with 2 Stargates and ONE
Void Ray is ``PvZ - Carrier Rush``, never ``PvZ - 2 Stargate Void Ray``.

Reported from a real game (2 Stargates, a Fleet Beacon, 1 Carrier,
1 Void Ray) that showed the Void Ray label. The built-in tree was right:
Carrier Rush is checked first and the Void Ray rule needs 4+ Void Rays.
The label came from a saved custom build, which runs before the tree
(here and in the cloud's ingest tagger). A build saved from the web
editor's timeline made one ``before`` rule per token, and ``before``
passes on one event, so "2 Stargate Void Ray" really meant
"1+ Stargate, 1+ Void Ray". The editor now saves a repeated row as
``count_min``; the last test pins that such a build leaves the Carrier
rush alone.
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

GAME_LENGTH = 504  # 8:24


def _building(name: str, time: int) -> Dict[str, Any]:
    return {
        "type": "building", "name": name, "time": time, "x": 0.0, "y": 0.0,
        "subtype": "init",
    }


def _unit(name: str, time: int) -> Dict[str, Any]:
    return {"type": "unit", "name": name, "time": time, "x": 0.0, "y": 0.0}


def _carrier_rush(void_rays: int = 1) -> List[Dict[str, Any]]:
    """Stargate-first, 2 Stargates, Fleet Beacon, one Carrier by 6:20."""
    events = [
        _building("Nexus", 0),
        _building("Pylon", 18),
        _building("Gateway", 40),
        _building("Assimilator", 50),
        _building("Nexus", 80),
        _building("CyberneticsCore", 95),
        _building("Stargate", 170),
        _building("Stargate", 230),
        _building("FleetBeacon", 280),
        _building("Nexus", 330),
        _unit("Oracle", 240),
        _unit("Carrier", 380),
    ]
    events += [_unit("VoidRay", 290 + 40 * i) for i in range(void_rays)]
    return events


CUSTOM_NAME = "My 2 Stargate Void Ray"


def _custom(rules: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [{
        "name": CUSTOM_NAME,
        "race": "Protoss",
        "vs_race": "Zerg",
        "rules": rules,
    }]


def _labels(events, custom_builds=None):
    return [
        det.detect_my_build(
            "vs Zerg", events, my_race="Protoss",
            game_length_seconds=GAME_LENGTH,
        )
        for det in (
            CanonicalUserBuildDetector(custom_builds=custom_builds or []),
            MirrorUserBuildDetector(custom_builds=custom_builds or []),
        )
    ]


def test_one_void_ray_carrier_rush_is_carrier_rush():
    assert _labels(_carrier_rush()) == ["PvZ - Carrier Rush"] * 2


def test_carrier_beats_the_void_ray_label_even_with_four_void_rays():
    assert _labels(_carrier_rush(void_rays=4)) == ["PvZ - Carrier Rush"] * 2


def test_timeline_style_custom_build_still_steals_the_carrier_rush():
    """Documents why the report happened: custom builds run first and a
    ``before`` rule is satisfied by a single Stargate / Void Ray."""
    loose = _custom([
        {"type": "before", "name": "BuildStargate", "time_lt": 200},
        {"type": "before", "name": "BuildVoidRay", "time_lt": 600},
    ])
    assert _labels(_carrier_rush(), loose) == [CUSTOM_NAME] * 2


def test_count_rules_leave_the_carrier_rush_alone():
    """The editor's repeated-row counts: >= 2 Stargates, >= 4 Void Rays."""
    counted = _custom([
        {"type": "count_min", "name": "BuildStargate", "count": 2,
         "time_lt": 260},
        {"type": "count_min", "name": "BuildVoidRay", "count": 4,
         "time_lt": 600},
    ])
    assert _labels(_carrier_rush(), counted) == ["PvZ - Carrier Rush"] * 2
    # A real 2-Stargate Void Ray game (no Carrier) still matches it.
    void_ray_game = [
        e for e in _carrier_rush(void_rays=5)
        if e["name"] not in ("Carrier", "FleetBeacon")
    ]
    assert _labels(void_ray_game, counted) == [CUSTOM_NAME] * 2
