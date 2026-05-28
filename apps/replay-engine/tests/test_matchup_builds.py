"""Detection tests for the Terran/Zerg per-matchup build orders.

Each synthetic event set is the minimal building/unit signature for one
of the pro builds in ``core.strategy_detector_matchups`` (with the
tech-prerequisite structures the anti-hallucination filter requires),
asserting ``classify_by_race`` returns the precise matchup label. A
final test proves custom builds work for a Terran matchup exactly like
they do for Protoss.
"""

import os
import sys
from typing import Any, Dict, List

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from core.strategy_detector_base import BaseStrategyDetector  # noqa: E402
from core.strategy_detector_race import classify_by_race  # noqa: E402
from core.strategy_detector_user import UserBuildDetector  # noqa: E402


def _b(name: str, time: int, x: float = 10.0, y: float = 10.0) -> Dict[str, Any]:
    return {"type": "building", "name": name, "time": time, "x": x, "y": y,
            "subtype": "init"}


def _u(name: str, time: int) -> Dict[str, Any]:
    return {"type": "unit", "name": name, "time": time, "x": 0.0, "y": 0.0}


def _n(name: str, time: int, n: int, step: int = 8) -> List[Dict[str, Any]]:
    return [_u(name, time + i * step) for i in range(n)]


DET = BaseStrategyDetector(custom_builds=[])


def _classify(race: str, opp_race: str, events: List[Dict[str, Any]]) -> str:
    return classify_by_race(race, events, DET, opp_race=opp_race)


# --------------------------------------------------------------------------
# Terran matchups
# --------------------------------------------------------------------------
def test_tvt_reaper_expand_tank_viking():
    events = [
        _b("CommandCenter", 0), _b("CommandCenter", 180),
        _b("Barracks", 60), _b("Factory", 200), _b("Starport", 260),
        _u("Reaper", 150), _u("SiegeTank", 500), _u("VikingFighter", 510),
    ]
    assert _classify("Terran", "Terran", events) == "TvT - Reaper Expand into Tank/Viking"


def test_tvt_1_1_1_cloak_banshee():
    events = [
        _b("CommandCenter", 0),
        _b("Factory", 200), _b("Starport", 280),
        _u("Banshee", 400),
    ]
    assert _classify("Terran", "Terran", events) == "TvT - 1-1-1 Cloak Banshee"


def test_tvz_3_cc_bio():
    events = [
        _b("CommandCenter", 0), _b("CommandCenter", 150), _b("CommandCenter", 280),
        _b("Barracks", 100), _b("Barracks", 200), _b("Barracks", 300),
        *_n("Marine", 220, 10),
    ]
    assert _classify("Terran", "Zerg", events) == "TvZ - 3 CC Bio"


def test_tvz_2_base_hellbat_thor():
    events = [
        _b("CommandCenter", 0), _b("CommandCenter", 180),
        _b("Factory", 200), _b("Factory", 350), _b("Armory", 300),
        *_n("Hellion", 250, 4), _u("Thor", 500),
    ]
    assert _classify("Terran", "Zerg", events) == "TvZ - 2 Base Hellbat Thor"


def test_tvz_1_1_1_banshee():
    events = [
        _b("CommandCenter", 0), _b("Factory", 200), _b("Starport", 300),
        _u("Banshee", 450),
    ]
    assert _classify("Terran", "Zerg", events) == "TvZ - 1-1-1 Banshee"


def test_tvz_3_rax_marine():
    events = [
        _b("CommandCenter", 0),
        _b("Barracks", 100), _b("Barracks", 180), _b("Barracks", 260),
        *_n("Marine", 300, 10),
    ]
    assert _classify("Terran", "Zerg", events) == "TvZ - 3 Rax Marine"


def test_tvz_reaper_hellion_expand():
    events = [
        _b("CommandCenter", 0), _b("CommandCenter", 180),
        _b("Barracks", 60), _b("Factory", 200),
        _u("Reaper", 150), *_n("Hellion", 300, 2),
    ]
    assert _classify("Terran", "Zerg", events) == "TvZ - Reaper Hellion Expand"


def test_tvz_marine_hellbat_timing():
    events = [
        _b("CommandCenter", 0), _b("CommandCenter", 180),
        _b("Barracks", 80), _b("Factory", 200), _b("Armory", 350),
        *_n("Hellion", 250, 4), *_n("Marine", 250, 8),
    ]
    assert _classify("Terran", "Zerg", events) == "TvZ - 2-1-1 Marine Hellbat Timing"


def test_tvz_battlecruiser_mech():
    events = [
        _b("CommandCenter", 0), _b("Starport", 300), _b("FusionCore", 500),
        _u("Battlecruiser", 580),
    ]
    assert _classify("Terran", "Zerg", events) == "TvZ - Battlecruiser Mech"


def test_tvz_hellion_liberator():
    events = [
        _b("CommandCenter", 0), _b("CommandCenter", 180),
        _b("Factory", 200), _b("Starport", 300),
        *_n("Hellion", 300, 2), _u("Liberator", 480),
    ]
    assert _classify("Terran", "Zerg", events) == "TvZ - Hellion Liberator"


def test_tvz_widow_mine_marine():
    events = [
        _b("CommandCenter", 0),
        _b("Barracks", 80), _b("Factory", 200), _b("Starport", 300),
        *_n("WidowMine", 400, 2), *_n("Marine", 250, 8), _u("Medivac", 450),
    ]
    assert _classify("Terran", "Zerg", events) == "TvZ - Widow Mine Marine"


def test_tvz_marine_drop():
    events = [
        _b("CommandCenter", 0), _b("CommandCenter", 180),
        _b("Barracks", 80), _b("Factory", 200), _b("Starport", 300),
        *_n("Marine", 250, 8), _u("Medivac", 450),
    ]
    assert _classify("Terran", "Zerg", events) == "TvZ - 2-1-1 Marine Drop"


def test_tvp_2_1_1_reaper_expand():
    events = [
        _b("CommandCenter", 0), _b("CommandCenter", 180),
        _b("Barracks", 60), _b("Factory", 300), _b("Starport", 380),
        _u("Reaper", 150), _u("Medivac", 500),
    ]
    assert _classify("Terran", "Protoss", events) == "TvP - 2-1-1 Reaper Expand"


def test_tvp_fast_3cc_is_not_misread_as_reaper_expand():
    # A greedy fast-3-CC bio macro must fall through to the generic
    # "Terran - Fast 3 CC" race label, NOT the 2-base reaper timing.
    events = [
        _b("CommandCenter", 0), _b("CommandCenter", 110), _b("CommandCenter", 160),
        _b("Barracks", 60), _b("Factory", 210), _b("Starport", 250),
        _u("Reaper", 120), _u("Medivac", 330),
    ]
    assert _classify("Terran", "Protoss", events) == "Terran - Fast 3 CC"


# --------------------------------------------------------------------------
# Zerg matchups
# --------------------------------------------------------------------------
def test_zvt_3_hatch_ling_bane_muta():
    events = [
        _b("Hatchery", 0), _b("Hatchery", 150), _b("Hatchery", 250),
        _b("SpawningPool", 40), _b("BanelingNest", 280), _b("Spire", 450),
        *_n("Zergling", 350, 6), _u("Baneling", 470),
    ]
    assert _classify("Zerg", "Terran", events) == "ZvT - 3 Hatch Ling Bane Muta"


def test_zvt_2_base_roach_ravager_timing():
    events = [
        _b("Hatchery", 0), _b("Hatchery", 180),
        _b("SpawningPool", 40), _b("RoachWarren", 200),
        *_n("Drone", 60, 10), *_n("Roach", 350, 5), *_n("Ravager", 420, 4),
    ]
    assert _classify("Zerg", "Terran", events) == "ZvT - 2 Base Roach Ravager Timing"


def test_zvp_ling_bane_muta():
    events = [
        _b("Hatchery", 0), _b("SpawningPool", 40),
        _b("BanelingNest", 280), _b("Spire", 450),
        *_n("Zergling", 350, 6), _u("Baneling", 470),
    ]
    assert _classify("Zerg", "Protoss", events) == "ZvP - Ling Bane Muta"


def test_zvz_12_pool_speedling():
    events = [
        _b("Hatchery", 0), _b("SpawningPool", 40),
        *_n("Zergling", 200, 6),
    ]
    assert _classify("Zerg", "Zerg", events) == "ZvZ - 12 Pool Speedling"


def test_zvz_roach_aggression():
    events = [
        _b("Hatchery", 0), _b("Hatchery", 180),
        _b("SpawningPool", 70), _b("RoachWarren", 200),
        *_n("Roach", 300, 6),
    ]
    assert _classify("Zerg", "Zerg", events) == "ZvZ - Roach Aggression"


# --------------------------------------------------------------------------
# Custom builds work for a Terran matchup, same as Protoss
# --------------------------------------------------------------------------
def test_custom_build_for_terran_vs_zerg():
    custom = [{
        "name": "TvZ - My Bunker Rush",
        "race": "Terran",
        "vs_race": "Zerg",
        "rules": [{"type": "building", "name": "Bunker", "time_lt": 150}],
    }]
    det = UserBuildDetector(custom_builds=custom)
    events = [_b("CommandCenter", 0), _b("Bunker", 100)]
    label = det.detect_my_build("vs Zerg", events, my_race="Terran",
                                game_length_seconds=600)
    assert label == "TvZ - My Bunker Rush"
