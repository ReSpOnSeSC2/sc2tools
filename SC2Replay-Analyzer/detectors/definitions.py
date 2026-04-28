"""Build/strategy definitions and custom-rule loader.

`BUILD_DEFINITIONS` is the human-readable catalog displayed by the
"Definitions" tab in the UI; it doubles as the seed list of named build keys
in `KNOWN_BUILDS`. The custom-build helpers read/write `custom_builds.json`
so users can add extra rules without touching code.
"""

import json
import os
from typing import Dict, List

from core.paths import CUSTOM_BUILDS_FILE


BUILD_DEFINITIONS = {
    # --- ZERG OPPONENT STRATEGIES ---
    "Zerg - 12 Pool": "Detected if Spawning Pool starts < 50s and NO new drones were built (Strict 12 Supply).",
    "Zerg - 13/12 Baneling Bust": "Early pool and early gas (<70s) leading into Baneling Nest before 3:20.",
    "Zerg - 13/12 Speedling Aggression": "Early pool and early gas (<70s) for aggressive speedlings.",
    "Zerg - Early Pool (14/14 or 15 Pool)": "Detected if Spawning Pool starts < 1:10 but drones were built.",
    "Zerg - 17 Hatch 18 Gas 17 Pool": "Standard modern Zerg macro opener (Hatch < 85s, Gas < 95s, Pool < 105s).",
    "Zerg - 3 Hatch Before Pool": "Detected if a 3rd Hatchery is started before the Spawning Pool.",
    "Zerg - Proxy Hatch": "Detected if a hatchery being built on the opponents side of the map within the first 4:30.",
    "Zerg - 1 Base Roach Rush": "Detected if a Roach Warren is built off 1 base very early (< 3:40).",
    "Zerg - 2 Base Roach/Ravager All-in": "Detected if Roach Warren exists, Lair exists, high Roaches/Ravagers count, low drone count (< 40) off 2 bases.",
    "Zerg - 2 Base Muta Rush": "Detected if a Spire is started before 7:00 with low drone count.",
    "Zerg - 2 Base Nydus": "Detected if a Nydus Network is built before 7:00.",
    "Zerg - 3 Hatch Ling Flood": "Detected 3 bases but >20 lings and <30 drones by 5:00.",
    "Zerg - 3 Base Macro (Hatch First)": "Standard safe Zerg macro reaching 3 bases by 6:30 off a Hatch First.",
    "Zerg - 3 Base Macro (Pool First)": "Standard safe Zerg macro reaching 3 bases by 6:30 off a Pool First.",
    "Zerg - Pool First Opener": "Generic Pool first opener that transitions into standard macro.",
    "Zerg - Muta/Ling/Bane Comp": "Mid/Late game composition fallback based on Mutalisks and Banelings.",
    "Zerg - Roach/Ravager Comp": "Mid/Late game composition fallback heavily focused on Roaches and Ravagers.",
    "Zerg - Hydra Comp": "Mid/Late game composition fallback featuring Hydralisks.",
    "Zerg - Standard Play (Unclassified)": "Catch-all for unclassified Zerg games.",

    # --- PROTOSS OPPONENT STRATEGIES ---
    "Protoss - Cannon Rush": "Detected if a Photon Cannon is built near your base (Proxy) before 4:30.",
    "Protoss - Proxy 4 Gate": "Detected if 3+ Gateways are built far from the main base before 4:30.",
    "Protoss - DT Rush": "Detected if a Dark Shrine is built before 7:30.",
    "Protoss - 4 Gate Rush": "Detected if 4 Gateways exist before 6:00 and before the 2nd Nexus.",
    "Protoss - Glaive Adept Timing": "Detected if Twilight Council + Glaives researched + High Adept count by 6:30.",
    "Protoss - Chargelot All-in": "Detected if Charge is researched, 7+ Gates, and low gas count.",
    "Protoss - Stargate Opener": "Detected if a Stargate is built before 6:30.",
    "Protoss - Robo Opener": "Detected if a Robotics Facility is built before 6:30.",
    "Protoss - Proxy Stargate Opener": "Detected if a Stargate is built away from the opponents base before 6:30.",
    "Protoss - Proxy Robo Opener": "Detected if a Robo is built away from the opponents base before 6:30.",
    "Protoss - Standard Expand": "Detected if the 2nd Nexus starts before 6:30.",
    "PvP - 1 Gate Expand": "PvP standard 1-gate expand: exactly 1 Gateway finished before the natural Nexus (which goes down before 5:00) and the first warp-in is a Stalker / Adept / Zealot.",
    "PvP - 2 Gate Expand": "PvP safer 2-gate expand: 2+ Gateways finished before the natural Nexus (which goes down before 5:00). Trades a few seconds of economy for protection vs proxy 2-gate / early aggression.",
    "PvP - Strange's 1 Gate Expand": "PvP 1-gate expand variant where exactly 1 Gateway is built before the natural Nexus and the first warp-in is a Sentry.",
    "Protoss - Blink All-In": "3 or 4 Gateways have been made along with Blink before 6:30 without a second Nexus.",
    "Protoss - Standard Macro (CIA)": "Detected if Protoss has 3 Bases and Charge/Immortal/Archon tech path.",
    "Protoss - Skytoss Transition": "Mid/Late game composition fallback based on multiple Stargates or Carriers.",
    "Protoss - Robo Comp": "Mid/Late game composition fallback based on Colossi or Disruptors.",
    "Protoss - Chargelot/Archon Comp": "Mid/Late game composition fallback based on Archons and Chargelots.",
    "Protoss - Standard Play (Unclassified)": "Catch-all for unclassified Protoss games.",

    # --- TERRAN OPPONENT STRATEGIES ---
    "Terran - 2 Gas 3 Reaper 2 Hellion": "Detected if 2 Gas, 3 Reapers, and 2 Hellions before 5:30.",
    "Terran - Proxy Rax": "Detected if Barracks are built far from the main base before 4:30.",
    "Terran - Ghost Rush": "Detected if Ghost Academy is built within first 6:30 of the game.",
    "Terran - Cyclone Rush": "Detected if Factory with Tech Lab and Cyclones are built early (< 5:30).",
    "Terran - Hellbat All-in": "Detected if Armory is built early (< 5:00) with high Hellion/Hellbat count.",
    "Terran - Widow Mine Drop": "Detected if Medivac and multiple widow mines are built after second CC within the first 6:30.",
    "Terran - BC Rush": "Detected if a Fusion Core is built before 6:30.",
    "Terran - Banshee Rush": "Detected if a Banshee and Cloak or Hyper Flight Rotors exists before 7:30.",
    "Terran - Fast 3 CC": "Detected if 3 Command Centers exist before 7:00 (Counting only construction, ignoring Orbitals).",
    "Terran - 3 Rax": "Detected if 3 Barracks are built after second CC but before any other tech buildings.",
    "Terran - 1-1-1 Standard": "Detected if Factory (before 6:30) and Starport (before 8:10) are built and they are after the second CC.",
    "Terran - Proxy 1-1-1": "Detected if Factory (before 6:30) and Starport (before 8:10) and are built away from their base.",
    "Terran - Standard Bio Tank": "Detected if 3 CCs, Engineering Bays, and Tanks/Medivacs are present.",
    "Terran - Mech Comp": "Mid/Late game composition fallback based on heavy Factory production.",
    "Terran - Bio Comp": "Mid/Late game composition fallback based on heavy Barracks production.",
    "Terran - SkyTerran": "Mid/Late game composition fallback based on heavy Starport production.",
    "Terran - Standard Play (Unclassified)": "Catch-all for unclassified Terran games.",

    # ----- Matchup-prefixed Zerg & Terran stubs -----
    # TODO(stage-8): replace placeholder signatures in BUILD_SIGNATURES below
    # with real opening detectors and remove the 'Stub - TODO Stage 8' suffix.
    "ZvP - Stub - TODO Stage 8": "Placeholder ZvP entry - real opening signatures land in Stage 8.",
    "ZvT - Stub - TODO Stage 8": "Placeholder ZvT entry - real opening signatures land in Stage 8.",
    "ZvZ - Stub - TODO Stage 8": "Placeholder ZvZ entry - real opening signatures land in Stage 8.",
    "TvP - Stub - TODO Stage 8": "Placeholder TvP entry - real opening signatures land in Stage 8.",
    "TvT - Stub - TODO Stage 8": "Placeholder TvT entry - real opening signatures land in Stage 8.",
    "TvZ - Stub - TODO Stage 8": "Placeholder TvZ entry - real opening signatures land in Stage 8.",
}


KNOWN_BUILDS = sorted(list(set([
    k for k in BUILD_DEFINITIONS.keys()
    if not k.endswith("Unknown") and not k.endswith("Unclassified")
])))

# =========================================================
# BUILD SIGNATURES  (structured catalog -- Stage 8 fills these in)
# =========================================================
# Structured per-build metadata used by the race-aware classifier in
# detectors.user.UserBuildDetector. Mirrors
# reveal-sc2-opponent-main/core/build_definitions.py so both code paths
# stay in sync. Each entry carries:
#
#     race      : the player's race ("Zerg" / "Protoss" / "Terran")
#     vs_race   : the opponent's race
#     signature : list of dicts in the same shape as custom_builds.json
#                 rules ({"type": "building"|"unit"|...}). Empty list means
#                 the entry is a stub the classifier should skip.
#     tier      : "?" until benchmarked against real games in Stage 8.
#
# TODO(stage-8): fill in real `signature` rules for each ZvX / TvX entry
# below and replace the "?" tier with one of "S" / "A" / "B" / "C".
BUILD_SIGNATURES: Dict[str, Dict[str, object]] = {
    "ZvP - Stub - TODO Stage 8": {
        "race": "Zerg", "vs_race": "Protoss",
        "signature": [],  # TODO(stage-8): real rules land here.
        "tier": "?",
        "description": BUILD_DEFINITIONS["ZvP - Stub - TODO Stage 8"],
    },
    "ZvT - Stub - TODO Stage 8": {
        "race": "Zerg", "vs_race": "Terran",
        "signature": [],  # TODO(stage-8): real rules land here.
        "tier": "?",
        "description": BUILD_DEFINITIONS["ZvT - Stub - TODO Stage 8"],
    },
    "ZvZ - Stub - TODO Stage 8": {
        "race": "Zerg", "vs_race": "Zerg",
        "signature": [],  # TODO(stage-8): real rules land here.
        "tier": "?",
        "description": BUILD_DEFINITIONS["ZvZ - Stub - TODO Stage 8"],
    },
    "TvP - Stub - TODO Stage 8": {
        "race": "Terran", "vs_race": "Protoss",
        "signature": [],  # TODO(stage-8): real rules land here.
        "tier": "?",
        "description": BUILD_DEFINITIONS["TvP - Stub - TODO Stage 8"],
    },
    "TvT - Stub - TODO Stage 8": {
        "race": "Terran", "vs_race": "Terran",
        "signature": [],  # TODO(stage-8): real rules land here.
        "tier": "?",
        "description": BUILD_DEFINITIONS["TvT - Stub - TODO Stage 8"],
    },
    "TvZ - Stub - TODO Stage 8": {
        "race": "Terran", "vs_race": "Zerg",
        "signature": [],  # TODO(stage-8): real rules land here.
        "tier": "?",
        "description": BUILD_DEFINITIONS["TvZ - Stub - TODO Stage 8"],
    },
}


def candidate_signatures_for(
    race: str, vs_race: str
) -> Dict[str, Dict[str, object]]:
    """Return BUILD_SIGNATURES entries matching (race, vs_race).

    The classifier in `detectors.user.UserBuildDetector` calls this to
    narrow the candidate set before evaluating signatures, so a TvZ
    replay never gets compared against a ZvP rule.

    Example:
        >>> list(candidate_signatures_for("Zerg", "Protoss"))
        ['ZvP - Stub - TODO Stage 8']
    """
    return {
        name: meta
        for name, meta in BUILD_SIGNATURES.items()
        if meta.get("race") == race and meta.get("vs_race") == vs_race
    }



def initialize_custom_builds():
    """Create a default `custom_builds.json` if none exists yet."""
    if not os.path.exists(CUSTOM_BUILDS_FILE):
        default_data = {
            "instructions": (
                "Add custom Spawning Tool build orders here. 'target' can be 'Opponent' or 'Self'. "
                "'race' is Zerg, Protoss, or Terran. 'matchup' can be 'vs Zerg', 'vs Protoss', "
                "'vs Terran', or 'vs Any'. Rules types: 'building', 'unit', 'unit_max', "
                "'upgrade', 'proxy'."
            ),
            "builds": [
                {
                    "name": "Zerg - 12 Pool (Custom Engine Example)",
                    "target": "Opponent",
                    "race": "Zerg",
                    "matchup": "vs Any",
                    "description": "Custom JSON definition of a 12 pool.",
                    "rules": [
                        {"type": "building", "name": "SpawningPool", "time_lt": 55},
                        {"type": "unit_max", "name": "Drone", "count": 13, "time_lt": 60},
                    ],
                }
            ],
        }
        try:
            with open(CUSTOM_BUILDS_FILE, 'w') as f:
                json.dump(default_data, f, indent=4)
        except Exception:
            pass


def load_custom_builds() -> Dict[str, List[Dict]]:
    """Load user-authored custom builds from disk, bucketed by target side."""
    builds = {"Opponent": [], "Self": []}
    if os.path.exists(CUSTOM_BUILDS_FILE):
        try:
            with open(CUSTOM_BUILDS_FILE, 'r') as f:
                data = json.load(f)
                for b in data.get("builds", []):
                    if b.get("target") in builds:
                        builds[b["target"]].append(b)
        except Exception as e:
            print(f"Failed to load custom builds: {e}")
    return builds
