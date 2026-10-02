"""Detection tests for the PvP user-build tree (``core.strategy_detector_pvp``).

Each synthetic event list is the minimal building / unit / upgrade
signature of one PvP opener, with real-looking coordinates so the proxy
geometry (``BaseStrategyDetector._is_proxy``: more than 50 world units
from the player's own main) is exercised the way a replay exercises it.

The proxy cases pin the user-reported bug: a proxy Robo (home Gateways
at 0:38 / 1:11, then a proxy Pylon with a Robotics Facility at 2:16 and
a third Gateway beside it at 2:22, Immortal at 3:34) was labelled
"PvP - Proxy 2 Gate" because the proxied-Gateway rule accepted any
forward Gateway before 4:30. A proxy 2-Gate's Gateways go down by
~1:30, so the rule now keys on that timing.
"""

from __future__ import annotations

import os
import sys
from typing import Any, Dict, List, Tuple

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from core.build_definitions import BUILD_DEFINITIONS  # noqa: E402
from core.strategy_detector_user import UserBuildDetector  # noqa: E402


# World coordinates. The main Nexus sits at MAIN; HOME is a few cells
# away (inside the 50-unit radius), NATURAL is 40 units away (still
# "home" for the proxy test, like a real natural), PROXY is far across
# the map (the opponent's side).
MAIN: Tuple[float, float] = (30.0, 30.0)
HOME: Tuple[float, float] = (34.0, 36.0)
NATURAL: Tuple[float, float] = (30.0, 70.0)
PROXY: Tuple[float, float] = (150.0, 150.0)


def _b(
    name: str, time: int, loc: Tuple[float, float] = HOME, subtype: str = "init",
) -> Dict[str, Any]:
    return {
        "type": "building", "name": name, "time": time,
        "x": loc[0], "y": loc[1], "subtype": subtype,
    }


def _u(name: str, time: int) -> Dict[str, Any]:
    return {"type": "unit", "name": name, "time": time, "x": 0.0, "y": 0.0}


def _up(name: str, time: int) -> Dict[str, Any]:
    return {"type": "upgrade", "name": name, "time": time}


def _main() -> Dict[str, Any]:
    # Real replays only emit a "born" event (no init) for the
    # pre-placed main.
    return _b("Nexus", 0, MAIN, subtype="born")


def _classify(events: List[Dict[str, Any]]) -> str:
    return UserBuildDetector(custom_builds=[]).detect_my_build(
        "vs Protoss", events, my_race="Protoss", game_length_seconds=900,
    )


# --------------------------------------------------------------------------
# Proxy openers
# --------------------------------------------------------------------------
def _proxy_two_gate_robo_user_build() -> List[Dict[str, Any]]:
    """The reported replay: two home Gateways, then a proxy Pylon with a
    Robotics Facility and a third Gateway beside it, Immortal at 3:34."""
    return [
        _main(),
        _b("Pylon", 19), _b("Gateway", 38), _b("Assimilator", 43),
        _b("Assimilator", 55), _b("Gateway", 71), _b("CyberneticsCore", 85),
        _b("Pylon", 95),
        _b("Pylon", 114, PROXY), _b("RoboticsFacility", 136, PROXY),
        _b("Gateway", 142, PROXY),
        _u("Stalker", 149), _u("Stalker", 149), _u("Stalker", 177),
        _b("Pylon", 177), _u("Stalker", 184), _u("Immortal", 214),
        _up("WarpGateResearch", 223),
        _u("Stalker", 235), _u("Stalker", 235), _u("Stalker", 235),
    ]


def test_proxy_robo_with_forward_gateway_is_proxy_robo():
    assert _classify(_proxy_two_gate_robo_user_build()) == "PvP - Proxy Robo Opener"


def test_early_forward_gateways_with_a_robo_are_a_proxy_two_gate():
    # Gateways at proxy 2-Gate timing (0:58 / 1:12) are the proxy
    # 2-Gate signal, whatever tech follows them: timing decides.
    events = [
        _main(), _b("Pylon", 18),
        _b("Pylon", 40, PROXY), _b("Gateway", 58, PROXY), _b("Gateway", 72, PROXY),
        _b("Assimilator", 50), _b("CyberneticsCore", 120),
        _b("RoboticsFacility", 160, PROXY),
        _u("Stalker", 170), _u("Stalker", 172), _u("Immortal", 230),
    ]
    assert _classify(events) == "PvP - Proxy 2 Gate"


def test_forward_gateway_at_proxy_robo_timing_is_not_a_proxy_two_gate():
    # The 2:22 forward Gateway alone (no Robo at all) is outside the
    # proxy 2-Gate window.
    events = [
        _main(), _b("Pylon", 19), _b("Gateway", 38), _b("Assimilator", 43),
        _b("Gateway", 71), _b("CyberneticsCore", 85), _b("Pylon", 114, PROXY),
        _b("Gateway", 142, PROXY), _u("Stalker", 149), _u("Stalker", 177),
    ]
    assert _classify(events) != "PvP - Proxy 2 Gate"


def test_four_gate_with_a_forward_gateway_is_not_a_proxy_two_gate():
    # 3-4 Gate (Warp Gate) with a forward Gateway at 2:30: the forward
    # Gateway sits in the proxy Robo band, not the proxy 2-Gate one.
    events = [
        _main(), _b("Pylon", 18), _b("Gateway", 40), _b("Assimilator", 50),
        _b("CyberneticsCore", 95), _b("Gateway", 130), _b("Gateway", 140),
        _b("Pylon", 135, PROXY), _b("Gateway", 150, PROXY),
        _up("WarpGateResearch", 200), _u("Stalker", 150), _u("Stalker", 180),
        _u("Stalker", 210), _u("Stalker", 212), _u("Stalker", 214),
    ]
    assert _classify(events) != "PvP - Proxy 2 Gate"


def test_proxy_two_gate_window_boundary():
    inside = [
        _main(), _b("Pylon", 45, PROXY), _b("Gateway", 105, PROXY),
        _u("Zealot", 140), _u("Zealot", 160),
    ]
    outside = [
        _main(), _b("Pylon", 45, PROXY), _b("Gateway", 106, PROXY),
        _u("Zealot", 140), _u("Zealot", 160),
    ]
    assert _classify(inside) == "PvP - Proxy 2 Gate"
    assert _classify(outside) != "PvP - Proxy 2 Gate"


def test_proxy_robo_with_home_gateway_is_proxy_robo():
    events = [
        _main(), _b("Pylon", 18), _b("Gateway", 40), _b("Assimilator", 50),
        _b("CyberneticsCore", 95), _b("Pylon", 110, PROXY),
        _b("RoboticsFacility", 140, PROXY), _u("Stalker", 150),
        _u("Immortal", 215),
    ]
    assert _classify(events) == "PvP - Proxy Robo Opener"


def test_proxy_robo_counts_a_born_only_robo_event():
    # If the init event is lost, the born event still carries the
    # proxy position and must still classify the opener.
    events = [
        _main(), _b("Pylon", 18), _b("Gateway", 40), _b("CyberneticsCore", 95),
        _b("RoboticsFacility", 186, PROXY, subtype="born"), _u("Immortal", 240),
    ]
    assert _classify(events) == "PvP - Proxy Robo Opener"


def test_proxy_two_gate_without_tech_is_proxy_two_gate():
    events = [
        _main(), _b("Pylon", 18),
        _b("Pylon", 40, PROXY), _b("Gateway", 58, PROXY), _b("Gateway", 72, PROXY),
        _u("Zealot", 110), _u("Zealot", 125), _u("Zealot", 140), _u("Zealot", 155),
    ]
    assert _classify(events) == "PvP - Proxy 2 Gate"


def test_proxy_two_gate_with_early_natural_is_not_proxy_two_gate():
    # A natural before 4:30 means the forward Gateways were not a
    # committed proxy (the existing guard); the build is a 2-gate expand.
    events = [
        _main(), _b("Pylon", 18),
        _b("Gateway", 58, PROXY), _b("Gateway", 72, PROXY),
        _b("CyberneticsCore", 120), _b("Nexus", 200, NATURAL),
        _u("Stalker", 160), _u("Stalker", 180),
    ]
    label = _classify(events)
    assert label != "PvP - Proxy 2 Gate"
    assert label == "PvP - 2 Gate Expand"


def test_proxy_stargate_with_a_late_forward_gateway_is_proxy_stargate():
    events = [
        _main(), _b("Pylon", 18), _b("Gateway", 40), _b("Assimilator", 50),
        _b("Assimilator", 60), _b("CyberneticsCore", 95),
        _b("Pylon", 120, PROXY), _b("Stargate", 150, PROXY),
        _b("Gateway", 165, PROXY), _u("Stalker", 150), _u("VoidRay", 210),
    ]
    assert _classify(events) == "PvP - Proxy Stargate Opener"


def test_proxy_stargate_without_forward_gateway_is_proxy_stargate():
    events = [
        _main(), _b("Pylon", 18), _b("Gateway", 40), _b("Assimilator", 50),
        _b("CyberneticsCore", 95), _b("Pylon", 120, PROXY),
        _b("Stargate", 150, PROXY), _u("VoidRay", 210), _u("VoidRay", 260),
    ]
    assert _classify(events) == "PvP - Proxy Stargate Opener"


def test_home_robo_is_not_a_proxy_robo():
    events = [
        _main(), _b("Pylon", 18), _b("Gateway", 40), _b("CyberneticsCore", 95),
        _b("RoboticsFacility", 160), _u("Stalker", 150), _u("Immortal", 240),
        _b("Nexus", 330, NATURAL),
    ]
    assert _classify(events) != "PvP - Proxy Robo Opener"


def test_forward_robo_after_the_window_is_not_a_proxy_robo():
    events = [
        _main(), _b("Pylon", 18), _b("Gateway", 40), _b("CyberneticsCore", 95),
        _b("Nexus", 110, NATURAL), _u("Stalker", 150),
        _b("RoboticsFacility", 450, PROXY),
    ]
    assert _classify(events) != "PvP - Proxy Robo Opener"


def test_home_stargate_is_the_standard_stargate_opener():
    events = [
        _main(), _b("Pylon", 18), _b("Gateway", 40), _b("Assimilator", 50),
        _b("Assimilator", 60), _b("CyberneticsCore", 95), _b("Stargate", 180),
        _u("Stalker", 150), _u("Oracle", 240), _b("Nexus", 320, NATURAL),
    ]
    assert _classify(events) == "PvP - Standard Stargate Opener"


# --------------------------------------------------------------------------
# Expand openers
# --------------------------------------------------------------------------
def test_one_gate_expand():
    events = [
        _main(), _b("Pylon", 18), _b("Gateway", 40), _b("Assimilator", 50),
        _b("CyberneticsCore", 95), _b("Nexus", 110, NATURAL),
        _u("Stalker", 150), _b("Gateway", 200), _b("Gateway", 260),
    ]
    assert _classify(events) == "PvP - 1 Gate Expand"


def test_two_gate_expand():
    events = [
        _main(), _b("Pylon", 18), _b("Gateway", 40), _b("Gateway", 70),
        _b("Assimilator", 50), _b("CyberneticsCore", 95),
        _b("Nexus", 150, NATURAL), _u("Stalker", 160), _u("Stalker", 170),
    ]
    assert _classify(events) == "PvP - 2 Gate Expand"


def test_stranges_one_gate_expand_first_unit_sentry():
    events = [
        _main(), _b("Pylon", 18), _b("Gateway", 40), _b("Assimilator", 50),
        _b("CyberneticsCore", 95), _b("Nexus", 120, NATURAL),
        _u("Sentry", 150), _u("Stalker", 190),
    ]
    assert _classify(events) == "PvP - Strange's 1 Gate Expand"


def test_one_gate_nexus_into_four_gate():
    events = [
        _main(), _b("Pylon", 18), _b("Gateway", 40), _b("Assimilator", 50),
        _b("CyberneticsCore", 95), _b("Nexus", 120, NATURAL),
        _u("Stalker", 150), _up("WarpGateResearch", 300),
        _b("Gateway", 200), _b("Gateway", 240), _b("Gateway", 280),
        _u("Stalker", 330), _u("Stalker", 332), _u("Stalker", 334),
    ]
    assert _classify(events) == "PvP - 1 Gate Nexus into 4 Gate"


# --------------------------------------------------------------------------
# Tech openers
# --------------------------------------------------------------------------
def test_rails_blink_stalker_robo_first():
    events = [
        _main(), _b("Pylon", 18), _b("Gateway", 40), _b("Assimilator", 50),
        _b("Assimilator", 60), _b("CyberneticsCore", 95),
        _b("RoboticsFacility", 160), _b("TwilightCouncil", 220),
        _u("Stalker", 150), _u("Observer", 220), _up("BlinkTech", 400),
        _b("Nexus", 320, NATURAL),
    ]
    assert _classify(events) == "PvP - Rail's Blink Stalker (Robo 1st)"


def test_robo_into_glaives():
    events = [
        _main(), _b("Pylon", 18), _b("Gateway", 40), _b("CyberneticsCore", 95),
        _b("RoboticsFacility", 160), _b("TwilightCouncil", 220),
        _u("Stalker", 150), _up("AdeptPiercingAttack", 400),
        _b("Nexus", 320, NATURAL), _u("Adept", 420), _u("Adept", 422),
    ]
    assert _classify(events) == "PvP - Robo into Glaives"


def test_adept_glaives_twilight_first():
    events = [
        _main(), _b("Pylon", 18), _b("Gateway", 40), _b("CyberneticsCore", 95),
        _b("TwilightCouncil", 160), _u("Adept", 150),
        _up("AdeptPiercingAttack", 340), _b("Nexus", 320, NATURAL),
        _u("Adept", 350), _u("Adept", 352),
    ]
    assert _classify(events) == "PvP - Adept Glaives"


def test_phoenix_style():
    events = [
        _main(), _b("Pylon", 18), _b("Gateway", 40), _b("Assimilator", 50),
        _b("Assimilator", 60), _b("CyberneticsCore", 95), _b("Stargate", 180),
        _u("Stalker", 150), _u("Phoenix", 240), _u("Phoenix", 270),
        _u("Phoenix", 300), _b("Nexus", 320, NATURAL),
    ]
    assert _classify(events) == "PvP - Phoenix Style"


def test_blink_stalker_style():
    events = [
        _main(), _b("Pylon", 18), _b("Gateway", 40), _b("Assimilator", 50),
        _b("Assimilator", 60), _b("CyberneticsCore", 95),
        _b("TwilightCouncil", 200), _u("Stalker", 150), _u("Stalker", 180),
        _b("Nexus", 400, NATURAL), _b("Gateway", 250), _b("Gateway", 300),
        _up("BlinkTech", 480),
    ]
    assert _classify(events) == "PvP - Blink Stalker Style"


def test_alphastar_four_adept_oracle():
    events = [
        _main(), _b("Pylon", 18), _b("Gateway", 40), _b("Assimilator", 50),
        _b("Assimilator", 60), _b("CyberneticsCore", 95), _b("Stargate", 180),
        _u("Adept", 200), _u("Adept", 220), _u("Adept", 240), _u("Adept", 260),
        _u("Oracle", 250),
    ]
    assert _classify(events) == "PvP - AlphaStar (4 Adept/Oracle)"


def test_four_stalker_oracle_into_dt():
    events = [
        _main(), _b("Pylon", 18), _b("Gateway", 40), _b("Assimilator", 50),
        _b("Assimilator", 60), _b("CyberneticsCore", 95), _b("Stargate", 180),
        _u("Stalker", 150), _u("Stalker", 180), _u("Stalker", 210),
        _u("Oracle", 250), _b("TwilightCouncil", 300), _b("DarkShrine", 400),
        _u("DarkTemplar", 520),
    ]
    assert _classify(events) == "PvP - 4 Stalker Oracle into DT"


# --------------------------------------------------------------------------
# Tech before the natural: the tech rules claim the game, the expand
# label is only the fallback
# --------------------------------------------------------------------------
def _one_gate_core(natural_at: int) -> List[Dict[str, Any]]:
    return [
        _main(), _b("Pylon", 18), _b("Gateway", 40), _b("Assimilator", 50),
        _b("Assimilator", 60), _b("CyberneticsCore", 95),
        _b("Nexus", natural_at, NATURAL), _u("Stalker", 150),
    ]


def test_stargate_before_an_early_natural_is_the_stargate_opener():
    events = _one_gate_core(200) + [_b("Stargate", 150), _u("Oracle", 215)]
    assert _classify(events) == "PvP - Standard Stargate Opener"


def test_phoenix_style_with_an_early_natural():
    events = _one_gate_core(200) + [
        _b("Stargate", 150), _u("Phoenix", 220), _u("Phoenix", 250),
        _u("Phoenix", 280),
    ]
    assert _classify(events) == "PvP - Phoenix Style"


def test_alphastar_with_an_early_natural():
    events = _one_gate_core(270) + [
        _b("Stargate", 150), _u("Adept", 200), _u("Adept", 220),
        _u("Adept", 240), _u("Adept", 260), _u("Oracle", 250),
    ]
    assert _classify(events) == "PvP - AlphaStar (4 Adept/Oracle)"


def test_rails_blink_stalker_with_an_early_natural():
    events = _one_gate_core(260) + [
        _b("RoboticsFacility", 150), _b("TwilightCouncil", 200),
        _up("BlinkTech", 330), _b("Gateway", 280), _b("Gateway", 290),
    ]
    assert _classify(events) == "PvP - Rail's Blink Stalker (Robo 1st)"


def test_blink_stalker_style_with_an_early_natural():
    events = _one_gate_core(240) + [
        _b("TwilightCouncil", 160), _b("Gateway", 280), _b("Gateway", 300),
        _up("BlinkTech", 400),
    ]
    assert _classify(events) == "PvP - Blink Stalker Style"


def test_robo_first_expand_is_the_robo_opener():
    events = _one_gate_core(200) + [
        _b("RoboticsFacility", 150), _u("Immortal", 250), _u("Observer", 230),
        _b("Gateway", 280), _b("Gateway", 300),
    ]
    assert _classify(events) == "PvP - Robo Opener"


def test_robo_first_one_base_without_blink_is_the_robo_opener():
    # Robo -> Twilight -> Charge, no natural: used to be "Rail's Blink
    # Stalker" because the three-way time comparison held vacuously.
    events = [
        _main(), _b("Pylon", 18), _b("Gateway", 40), _b("CyberneticsCore", 95),
        _b("RoboticsFacility", 150), _u("Stalker", 150), _u("Immortal", 240),
        _b("TwilightCouncil", 300), _up("Charge", 440), _b("Gateway", 200),
    ]
    assert _classify(events) == "PvP - Robo Opener"


def test_robo_then_stargate_is_still_the_robo_opener():
    events = _one_gate_core(200) + [
        _b("RoboticsFacility", 150), _u("Immortal", 250),
        _b("Stargate", 320), _u("Oracle", 380),
    ]
    assert _classify(events) == "PvP - Robo Opener"


def test_two_gate_robo_expand_is_the_robo_opener():
    events = [
        _main(), _b("Pylon", 18), _b("Gateway", 40), _b("Gateway", 70),
        _b("CyberneticsCore", 95), _b("RoboticsFacility", 150),
        _b("Nexus", 200, NATURAL), _u("Stalker", 160), _u("Immortal", 250),
    ]
    assert _classify(events) == "PvP - Robo Opener"


def test_twilight_before_natural_without_a_tech_label_keeps_the_expand_label():
    # Twilight-first, Charge-first, 1 gate, natural at 3:40: no tech rule
    # recognises it, so the expand label is the fallback instead of
    # "Macro Transition (Unclassified)".
    events = _one_gate_core(220) + [
        _b("TwilightCouncil", 160), _up("Charge", 330),
        _b("Gateway", 300), _b("Gateway", 320), _b("Gateway", 340),
        _b("Gateway", 360), _b("Gateway", 380),
    ]
    assert _classify(events) == "PvP - 1 Gate Expand"


def test_tech_after_the_natural_is_still_a_one_gate_expand():
    events = _one_gate_core(110) + [_b("RoboticsFacility", 160), _u("Immortal", 240)]
    assert _classify(events) == "PvP - 1 Gate Expand"


def test_macro_transition_fallback():
    events = [
        _main(), _b("Pylon", 18), _b("Gateway", 40), _b("CyberneticsCore", 95),
        _b("Gateway", 200), _b("Nexus", 400, NATURAL), _u("Stalker", 150),
        _b("Forge", 500),
    ]
    assert _classify(events) == "PvP - Macro Transition (Unclassified)"


# --------------------------------------------------------------------------
# Catalog
# --------------------------------------------------------------------------
import re  # noqa: E402

_PVP_SOURCE = os.path.join(_ROOT, "core", "strategy_detector_pvp.py")


def test_every_emitted_pvp_label_is_in_the_engine_catalog():
    with open(_PVP_SOURCE, encoding="utf-8") as src:
        emitted = set(re.findall(r'"(PvP - [^"\n]+)"', src.read()))
    assert emitted
    missing = sorted(label for label in emitted if label not in BUILD_DEFINITIONS)
    assert missing == []


@pytest.mark.parametrize("label", [
    "PvP - Proxy 2 Gate",
    "PvP - Proxy Robo Opener",
    "PvP - Proxy Stargate Opener",
    "PvP - Standard Stargate Opener",
    "PvP - Robo Opener",
    "PvP - Robo into Glaives",
    "PvP - Adept Glaives",
])
def test_every_proxy_label_has_a_catalog_description(label):
    assert BUILD_DEFINITIONS[label]
