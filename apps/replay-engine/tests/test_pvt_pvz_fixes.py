"""Regressions for the PvT / PvZ user-tree fixes found in the 12-worker
detection audit: shadowed rules, dead rules and missing proxy labels.
"""

from __future__ import annotations

import os
import re
import sys
from typing import Any, Dict, List, Tuple

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from core.build_definitions import BUILD_DEFINITIONS  # noqa: E402
from core.strategy_detector_user import UserBuildDetector  # noqa: E402

MAIN: Tuple[float, float] = (10.0, 10.0)
NATURAL: Tuple[float, float] = (40.0, 10.0)
THIRD: Tuple[float, float] = (70.0, 10.0)
PROXY: Tuple[float, float] = (120.0, 120.0)


def _b(name: str, t: int, loc: Tuple[float, float] = MAIN, subtype: str = "init") -> Dict[str, Any]:
    return {"type": "building", "name": name, "time": t, "x": loc[0], "y": loc[1], "subtype": subtype}


def _u(name: str, t: int, **extra: Any) -> Dict[str, Any]:
    d: Dict[str, Any] = {"type": "unit", "name": name, "time": t, "x": 10.0, "y": 10.0}
    d.update(extra)
    return d


def _up(name: str, t: int) -> Dict[str, Any]:
    return {"type": "upgrade", "name": name, "time": t}


def _opener(nat: int = 85, gates: Tuple[int, ...] = (40,)) -> List[Dict[str, Any]]:
    ev = [_b("Nexus", 0, MAIN, "born"), _b("Pylon", 18)]
    ev += [_b("Gateway", g) for g in gates]
    ev += [_b("Assimilator", 50), _b("Assimilator", 100)]
    if nat is not None:
        ev.append(_b("Nexus", nat, NATURAL))
    ev.append(_b("CyberneticsCore", 90))
    return ev


def _classify(matchup: str, events: List[Dict[str, Any]]) -> str:
    return UserBuildDetector(custom_builds=[]).detect_my_build(
        matchup, events, my_race="Protoss", game_length_seconds=900,
    )


PVT = "vs Terran"
PVZ = "vs Zerg"


# --------------------------------------------------------------------------
# PvT
# --------------------------------------------------------------------------
def test_pvt_two_gate_blink_fast_third_without_a_robo():
    ev = _opener() + [
        _b("TwilightCouncil", 170), _b("Gateway", 190), _up("BlinkTech", 310),
        _b("Nexus", 270, THIRD), _b("Gateway", 380), _b("Gateway", 390),
    ]
    assert _classify(PVT, ev) == "PvT - 2 Gate Blink (Fast 3rd Nexus)"


def test_pvt_two_gate_blink_fast_third_with_a_late_robo():
    ev = _opener() + [
        _b("TwilightCouncil", 170), _b("Gateway", 190), _up("BlinkTech", 310),
        _b("Nexus", 270, THIRD), _b("RoboticsFacility", 490),
        _b("Gateway", 380), _b("Gateway", 390),
    ]
    assert _classify(PVT, ev) == "PvT - 2 Gate Blink (Fast 3rd Nexus)"


def test_pvt_hallucinated_immortal_does_not_block_stargate_into_charge():
    ev = _opener() + [
        _b("Stargate", 160), _u("Sentry", 200), _u("Oracle", 230),
        _u("Immortal", 240, hallucinated=True), _b("TwilightCouncil", 250),
        _b("Gateway", 260), _b("Gateway", 270), _up("Charge", 380),
        _b("Nexus", 330, THIRD),
    ]
    assert _classify(PVT, ev) == "PvT - Stargate into Charge"


def test_pvt_unflagged_immortal_without_a_robo_is_a_hallucination_too():
    ev = _opener() + [
        _b("Stargate", 160), _u("Sentry", 200), _u("Oracle", 230),
        _u("Immortal", 240), _b("TwilightCouncil", 250),
        _b("Gateway", 260), _b("Gateway", 270), _up("BlinkTech", 380),
        _b("Nexus", 330, THIRD),
    ]
    assert _classify(PVT, ev) == "PvT - Stargate into Blink"


def test_pvt_four_gate_blink_with_a_late_templar_archives_stays_blink():
    ev = _opener() + [
        _b("TwilightCouncil", 170), _b("Gateway", 190), _b("Gateway", 200),
        _b("Gateway", 250), _up("BlinkTech", 310), _b("TemplarArchive", 720),
        _u("HighTemplar", 800),
    ]
    assert _classify(PVT, ev) == "PvT - 4 Gate Blink"


def test_pvt_four_gate_blink_with_storm_follow_up_and_late_third_stays_blink():
    ev = _opener() + [
        _b("TwilightCouncil", 170), _b("Gateway", 190), _b("Gateway", 200),
        _b("Gateway", 250), _up("BlinkTech", 310), _b("TemplarArchive", 480),
        _b("Nexus", 540, THIRD), _u("HighTemplar", 560),
    ]
    assert _classify(PVT, ev) == "PvT - 4 Gate Blink"


def test_pvt_three_gate_blink_macro_with_a_support_archives_and_fast_third():
    ev = _opener() + [
        _b("TwilightCouncil", 170), _b("Gateway", 190), _b("Gateway", 200),
        _up("BlinkTech", 310), _b("TemplarArchive", 300), _b("Nexus", 330, THIRD),
        _b("Gateway", 400), _u("HighTemplar", 420),
    ]
    assert _classify(PVT, ev) == "PvT - 3 Gate Blink (Macro)"


def test_pvt_genuine_two_base_templar_still_fires():
    ev = _opener() + [
        _b("TwilightCouncil", 170), _b("Gateway", 190), _b("Gateway", 200),
        _b("Gateway", 250), _b("TemplarArchive", 270), _u("HighTemplar", 320),
        _u("HighTemplar", 322), _up("PsiStorm", 400), _b("Nexus", 420, THIRD),
    ]
    assert _classify(PVT, ev) == "PvT - 2 Base Templar (Reactive/Delayed 3rd)"


def test_pvt_nexus_first_proxy_stargate_is_a_proxy_stargate():
    ev = [
        _b("Nexus", 0, MAIN, "born"), _b("Pylon", 18), _b("Nexus", 60, NATURAL),
        _b("Gateway", 70), _b("Assimilator", 80), _b("CyberneticsCore", 110),
        _b("Pylon", 115, PROXY), _b("Stargate", 130, PROXY), _u("VoidRay", 200),
    ]
    assert _classify(PVT, ev) == "PvT - Proxy Void Ray/Stargate"


def test_pvt_proxy_two_gate():
    ev = [
        _b("Nexus", 0, MAIN, "born"), _b("Pylon", 40, PROXY),
        _b("Gateway", 58, PROXY), _b("Gateway", 72, PROXY),
        _u("Zealot", 100), _u("Zealot", 115), _u("Zealot", 130),
    ]
    assert _classify(PVT, ev) == "PvT - Proxy 2 Gate"


def test_pvt_forward_gateway_at_proxy_stargate_timing_is_not_a_proxy_two_gate():
    ev = _opener(nat=None) + [
        _b("Pylon", 120, PROXY), _b("Stargate", 150, PROXY),
        _b("Gateway", 165, PROXY), _u("VoidRay", 215),
    ]
    assert _classify(PVT, ev) == "PvT - Proxy Void Ray/Stargate"


# --------------------------------------------------------------------------
# PvZ
# --------------------------------------------------------------------------
def test_pvz_archon_drop_with_a_warp_prism_is_an_archon_drop():
    ev = _opener() + [
        _b("Stargate", 150), _u("Oracle", 215), _b("TwilightCouncil", 240),
        _b("TemplarArchive", 330), _b("RoboticsFacility", 300), _u("WarpPrism", 360),
        _u("HighTemplar", 400), _u("HighTemplar", 405), _u("HighTemplar", 430),
        _u("HighTemplar", 435), _u("Archon", 420), _u("Archon", 450),
        _b("Gateway", 200), _b("Nexus", 330, THIRD),
    ]
    assert _classify(PVZ, ev) == "PvZ - Archon Drop"


def test_pvz_three_base_blink_is_not_the_two_base_all_in():
    ev = _opener() + [
        _b("TwilightCouncil", 170), _b("Gateway", 190), _b("Nexus", 270, THIRD),
        _b("Gateway", 300), _up("BlinkTech", 310), _b("RoboticsFacility", 320),
        _b("Forge", 330), _b("Gateway", 400), _b("Gateway", 420),
    ]
    assert _classify(PVZ, ev) != "PvZ - Blink Stalker All-in (2 Base)"


def test_pvz_two_base_blink_all_in_still_fires():
    ev = _opener() + [
        _b("TwilightCouncil", 170), _b("Gateway", 190), _b("Gateway", 300),
        _b("Gateway", 320), _b("Gateway", 340), _up("BlinkTech", 310),
        _u("Stalker", 200), _u("Stalker", 230),
    ]
    assert _classify(PVZ, ev) == "PvZ - Blink Stalker All-in (2 Base)"


def test_pvz_mass_adept_glaives_has_no_gateway_cap():
    ev = _opener() + [_b("TwilightCouncil", 170)]
    ev += [_b("Gateway", 190 + i * 15) for i in range(8)]
    ev += [_up("AdeptPiercingAttack", 300), _u("Adept", 310), _u("Adept", 320)]
    assert _classify(PVZ, ev) == "PvZ - Adept Glaives (No Robo)"


def test_pvz_three_gate_glaives_expand_is_adept_glaives():
    ev = _opener() + [
        _b("TwilightCouncil", 170), _b("Gateway", 190), _b("Gateway", 200),
        _up("AdeptPiercingAttack", 300), _b("Nexus", 320, THIRD), _u("Adept", 310),
    ]
    assert _classify(PVZ, ev) == "PvZ - Adept Glaives (No Robo)"


def test_pvz_late_charge_still_counts_as_standard_charge_macro():
    ev = _opener() + [
        _b("Stargate", 150), _u("Oracle", 215), _b("Nexus", 250, THIRD),
        _b("TwilightCouncil", 330), _up("Charge", 550), _b("RoboticsFacility", 360),
        _b("Gateway", 330), _b("Gateway", 340),
    ]
    assert _classify(PVZ, ev) == "PvZ - Standard charge Macro"


def test_pvz_proxy_two_gate():
    ev = [
        _b("Nexus", 0, MAIN, "born"), _b("Pylon", 40, PROXY),
        _b("Gateway", 58, PROXY), _b("Gateway", 72, PROXY),
        _u("Zealot", 100), _u("Zealot", 115), _u("Zealot", 130),
    ]
    assert _classify(PVZ, ev) == "PvZ - Proxy 2 Gate"


def test_pvz_cannon_rush():
    ev = [
        _b("Nexus", 0, MAIN, "born"), _b("Pylon", 18), _b("Forge", 40),
        _b("Pylon", 60, PROXY), _b("PhotonCannon", 80, PROXY),
        _b("PhotonCannon", 95, PROXY),
    ]
    assert _classify(PVZ, ev) == "PvZ - Cannon Rush"


def test_pvz_proxy_stargate():
    ev = _opener(nat=None) + [
        _b("Pylon", 120, PROXY), _b("Stargate", 150, PROXY), _u("VoidRay", 215),
    ]
    assert _classify(PVZ, ev) == "PvZ - Proxy Stargate Opener"


def test_pvz_home_stargate_is_still_a_stargate_opener():
    ev = _opener() + [_b("Stargate", 150), _u("Oracle", 215), _b("Gateway", 200)]
    assert _classify(PVZ, ev) == "PvZ - Stargate Opener"


# --------------------------------------------------------------------------
# Catalog completeness: every label a Protoss tree can emit is described
# --------------------------------------------------------------------------
@pytest.mark.parametrize("module", ["strategy_detector_pvt", "strategy_detector_pvz"])
def test_every_emitted_label_is_in_the_engine_catalog(module):
    with open(os.path.join(_ROOT, "core", module + ".py"), encoding="utf-8") as src:
        emitted = set(re.findall(r'"((?:Pv[TZ]|TvP) - [^"\n]+)"', src.read()))
    assert emitted
    assert sorted(label for label in emitted if label not in BUILD_DEFINITIONS) == []
