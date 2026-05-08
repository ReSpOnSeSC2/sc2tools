"""
Build & strategy definitions for the SC2 analyzer/overlay engine.

This module is data-only -- it has no logic. It exposes:
    BUILD_DEFINITIONS  -- {name: human description}
    KNOWN_BUILDINGS    -- structures we track for strategy detection
    MORPH_BUILDINGS    -- structures created via UnitTypeChange (Lair, Hive, etc.)
    SKIP_UNITS         -- unit names to ignore (workers, larva, broodlings, etc.)
    SKIP_BUILDINGS     -- structures to ignore for strategy detection
    KNOWN_BUILDS       -- sorted list of named builds suitable for DB seeding
"""

from typing import Dict, List, Set

# =========================================================
# BUILD DEFINITIONS  (50+ named strategies)
# =========================================================
BUILD_DEFINITIONS = {
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
    "PvP - 2 Gate Expand": "PvP safer 2-gate expand: 2 (or more) Gateways are started before the natural Nexus (which goes down before 5:00) AND no tech building (Stargate, Robotics Facility, or Twilight Council) is started before the natural. A Stargate / Robo / Twilight before the natural means it is a tech-first opener, not a pure 2-gate expand. Trades a few seconds of economy for protection vs proxy 2-gate / early aggression.",
    "PvP - Strange's 1 Gate Expand": "PvP 1-gate expand variant where exactly 1 Gateway is built before the natural Nexus and the first warp-in is a Sentry.",
    "PvP - 1 Gate Nexus into 4 Gate": "Detected if exactly 1 Gateway is started before the natural Nexus (which goes down before 5:00), 4+ Gateways exist by 6:00, the first warp-in is a Stalker / Adept / Zealot (NOT Sentry), no tech building (Stargate / Robotics Facility / Twilight Council / Templar Archive / Dark Shrine) is started before the 4th Gateway, and Warp Gate research begins by 5:30 -- the 1 Gate Nexus into 4 Gate Stalker timing.",
    "Protoss - Blink All-In": "3 or 4 Gateways have been made along with Blink before 6:30 without a second Nexus.",
    "Protoss - Standard Macro (CIA)": "Detected if Protoss has 3 Bases and Charge/Immortal/Archon tech path.",
    "Protoss - Skytoss Transition": "Mid/Late game composition fallback based on multiple Stargates or Carriers.",
    "Protoss - Robo Comp": "Mid/Late game composition fallback based on Colossi or Disruptors.",
    "Protoss - Chargelot/Archon Comp": "Mid/Late game composition fallback based on Archons and Chargelots.",
    "PvZ - Carrier Rush": "Detected if a Stargate AND a Fleet Beacon are built and at least 1 Carrier has been produced by 10:00 -- skytoss into Carriers. Carriers without a Stargate + Fleet Beacon are treated as hallucinations.",
    "PvZ - Tempest Rush": "Detected if a Stargate AND a Fleet Beacon are built and at least 1 Tempest has been produced by 10:00 -- long-range Tempest harass / siege.",
    "PvZ - 2 Stargate Void Ray": "Detected if 2+ Stargates and 2+ Nexuses by 10:00, plus 4+ Void Rays produced by 10:00 (Void Rays without a Stargate are ignored as hallucinations).",
    "PvZ - 3 Stargate Phoenix": "Detected if 3+ Stargates and 2+ Nexuses by 10:00, plus 4+ Phoenix produced by 10:00 (Phoenix without a Stargate are ignored as hallucinations).",
    "PvZ - 2 Stargate Phoenix": "Detected if 2+ Stargates and 2+ Nexuses by 10:00, plus 4+ Phoenix produced by 10:00 (Phoenix without a Stargate are ignored as hallucinations).",
    "PvZ - Rail's Disruptor Drop": "Detected if a Robotics Facility AND a Robotics Bay are built and at least 1 Disruptor and 1 Warp Prism are produced by 8:00 -- an early Disruptor drop harass build.",
    "PvZ - AlphaStar Style (Oracle/Robo)": "Detected if a Stargate is built, 2+ Oracles plus a Robotics Facility plus a Forge are all in place by 8:30, with 3+ Nexuses by 8:30 -- the AlphaStar Oracle / Robo / fast 3rd composition.",
    "PvZ - 7 Gate Glaive/Immortal All-in": "Detected if a Robotics Facility is built, Glaives is researched by 8:30, 2+ Sentries and 1+ Immortal produced by 8:30, and 6+ Gateways exist by 9:00 -- a heavy Glaive Adept / Immortal all-in.",
    "PvZ - Blink Stalker All-in (2 Base)": "Detected if Blink is researched by 8:00, 5+ Gateways exist by 8:00, and the player has NOT built a Stargate or Dark Shrine by 8:00 -- a 2-base Blink all-in.",
    "PvZ - Stargate into Glaives": "Detected if a Stargate is built before 7:00 (and before any Twilight Council), Glaives is researched by 10:00, and the player has 4-6 Gateways by 9:00 -- Phoenix or Oracle into Glaive Adept timing.",
    "PvZ - Archon Drop": "Detected if Stargate goes down before Twilight Council, a Templar Archives is up by 9:00, and 2+ Archons have been produced by 9:00 -- Stargate opener transitioning into Archon drops. Requires Templar Archives (or Dark Shrine for DT-Archon morph).",
    "PvZ - DT drop into Archon Drop": "Detected if Twilight Council goes down before Dark Shrine, a Dark Shrine AND a Robotics Facility are up by 9:00, 3+ Dark Templar are produced by 9:00, and a Warp Prism is on the field by 9:00.",
    "PvZ - Standard Blink Macro": "Detected if Stargate goes down before Twilight Council, Blink is researched by 10:00, and 3+ Nexuses are taken by 9:00 -- Stargate opener into 3-base Blink macro.",
    "PvZ - Standard charge Macro": "Detected if Stargate goes down before Twilight Council, Charge is researched by 9:00, and 3+ Nexuses are taken by 9:00 -- Stargate opener into 3-base Chargelot macro.",
    "PvZ - Robo Opener": "Detected if a Robotics Facility is built before 7:00 AND it is the FIRST tech building (built before any Stargate or Twilight Council).",
    "PvZ - Macro Transition (Unclassified)": "PvZ catch-all: the game reached the macro phase but did not match a more specific PvZ pattern.",
    "PvP - Proxy 2 Gate": "Detected if a Gateway is built before 4:30 within 50 units of the OPPONENT's main base -- a proxied 2-Gate aggression.",
    "PvP - AlphaStar (4 Adept/Oracle)": "Detected if a Stargate is built, 4+ Adepts have been produced by 6:00 AND 1+ Oracle is on the field by 6:30 -- the AlphaStar 4-Adept / Oracle pressure opener. Oracles without a Stargate are treated as hallucinations.",
    "PvP - 4 Stalker Oracle into DT": "Detected if a Stargate is built, 3+ Stalkers by 6:30, 1+ Oracle by 7:30, and a Dark Shrine is built by 9:00 -- Stalker / Oracle harass transitioning into Dark Templar.",
    "PvP - Rail's Blink Stalker (Robo 1st)": "Detected if Robotics Facility goes down BEFORE Twilight Council and BOTH go down before the natural Nexus -- a Robo-first Blink Stalker style.",
    "PvP - Phoenix Style": "Detected if a Stargate is built and 3+ Phoenix have been produced by 8:30 -- an air-control / Phoenix-heavy PvP style. Hallucinated Phoenix from Sentries do not count.",
    "PvP - Blink Stalker Style": "Detected if Blink is researched by 9:00, the player has expanded (2+ Nexuses), and they have between 2 and 4 Gateways by 9:00 -- a macro Blink Stalker game.",
    "PvP - Proxy Robo Opener": "Detected if a Robotics Facility is built before 6:30 within 50 units of the OPPONENT's main base -- a proxied Robo (Immortal / Warp Prism) opener.",
    "PvP - Standard Stargate Opener": "Detected if a Stargate is built before 6:30 in the player's own base (not proxied) -- the standard Stargate (Oracle / Phoenix) PvP opener.",
    "PvP - Macro Transition (Unclassified)": "PvP catch-all: the game reached the macro phase but did not match a more specific PvP pattern.",
    "PvT - Proxy Void Ray/Stargate": "Detected if a Stargate is built before the natural Nexus within 50 units of the OPPONENT's main -- a proxied Stargate (Void Ray) timing.",
    "PvT - Phoenix into Robo": "Detected if a Stargate is built, 1+ real (non-hallucinated) Phoenix is on the field by 7:00, AND a Robotics Facility is up by 8:00 -- a Phoenix opener that transitions into Robo tech. A Sentry's hallucinated Phoenix does NOT trigger this build, only a Phoenix produced after an actual Stargate.",
    "PvT - Phoenix Opener": "Detected if a Stargate is built, 1+ real (non-hallucinated) Phoenix is on the field by 7:00, AND the player's second Gateway was built BEFORE the Robotics Facility -- a pure Phoenix opener. Hallucinated Phoenix from Sentries do NOT count.",
    "PvT - 7 Gate Blink All-in": "Detected if Blink is researched by 9:00 AND 6+ Gateways exist by 9:00 -- a heavy multi-Gate Blink all-in.",
    "PvT - 8 Gate Charge All-in": "Detected if Charge is researched by 9:00 AND 7+ Gateways exist by 7:30 AND fewer than 3 Nexuses have been taken -- a 2-base mass-Gate Chargelot all-in.",
    "PvT - 2 Base Templar (Reactive/Delayed 3rd)": "Detected if a Templar Archives is built (required for HighTemplar / Psionic Storm) AND it finishes BEFORE the third Nexus is taken AND the player has 4-6 Gateways by 7:30 -- a reactive 2-base High Templar / Storm timing with a delayed 3rd. A hallucinated High Templar is not enough; the Templar Archives must actually exist.",
    "PvT - Standard Charge Macro": "Detected if Charge is researched by 9:00 AND the player has taken 3+ Nexuses -- standard 3-base Chargelot macro.",
    "PvT - 3 Gate Charge Opener": "Detected if Charge is researched by 9:00 AND Twilight Council was built BEFORE Robotics Facility AND BEFORE Stargate -- a Twilight-first 3-Gate Charge opener.",
    "PvT - 4 Gate Blink": "Detected if Twilight Council goes BEFORE Robo and Stargate, Blink is researched by 9:00, AND 4+ Gateways exist by 7:30 -- a 4-Gate Blink Stalker timing.",
    "PvT - 3 Gate Blink (Macro)": "Detected if Twilight Council goes BEFORE Robo and Stargate, Blink is researched by 9:00, AND fewer than 4 Gateways exist by 7:30 -- a macro 3-Gate Blink style.",
    "PvT - 2 Gate Blink (Fast 3rd Nexus)": "Detected if Blink is researched by 8:00, the player has taken 3+ Nexuses, exactly 2 Gateways exist by 8:00, AND a Robotics Facility is up by 8:00 -- a fast-3rd 2-Gate Blink style.",
    "PvT - DT Drop": "Detected if a Dark Shrine is built by 9:00 AND a Robotics Facility is up by 10:00 AND a Warp Prism is on the field by 10:00 -- a Dark Templar drop in PvT.",
    "PvT - Robo First": "Detected if a Robotics Facility is built before 6:30 AND it is the FIRST tech building (before any Stargate or Twilight Council).",
    "PvT - Macro Transition (Unclassified)": "PvT catch-all: the game reached the macro phase but did not match a more specific PvT pattern.",
    "Protoss - Standard Play (Unclassified)": "Catch-all for unclassified Protoss games.",
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
    "Terran - 1-1-1 One Base": "Detected if a Factory (before 6:30) and Starport (before 8:10) are both built BEFORE the second Command Center -- a 1-base 1-Rax / 1-Fact / 1-Port pressure build, not the standard expanding 1-1-1.",
    "Terran - 2-3 Rax Reaper rush": "Detected if 3+ Barracks exist before 6:30 off a single Command Center, no Refineries, and 2+ Reapers have been produced before 6:30 -- early Reaper-heavy aggression.",
    "Terran - 3-4 Rax Marine rush": "Detected if 3+ Barracks exist before 6:30 off a single Command Center with NO Refineries -- a gas-less, Marine-only mass-Rax all-in.",
    "Terran - Widow Mine Drop into Thor Rush": "Detected if a Medivac and 2+ Widow Mines are built AFTER the second Command Center (within ~6:30), and a Thor has been produced before ~8:10 -- a Mine drop transitioning into Thor pressure.",
    "Terran - Widow Upgraded Mine Cheese": "Detected if a Medivac and 2+ Widow Mines are built BEFORE the second Command Center -- a 1-base Widow Mine drop cheese.",
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

# =========================================================
# BUILD SIGNATURES  (structured catalog -- Stage 8 fills these in)
# =========================================================
# Structured per-build metadata used by the race-aware classifier in
# core.strategy_detector. Keyed by the same name as BUILD_DEFINITIONS so
# the description and the rule data stay aligned. Each entry carries:
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

    The classifier in `core.strategy_detector.UserBuildDetector` calls
    this to narrow the candidate set before evaluating signatures, so a
    TvZ replay never gets compared against a ZvP rule.

    Example:
        >>> list(candidate_signatures_for("Zerg", "Protoss"))
        ['ZvP - Stub - TODO Stage 8']
    """
    return {
        name: meta
        for name, meta in BUILD_SIGNATURES.items()
        if meta.get("race") == race and meta.get("vs_race") == vs_race
    }


# =========================================================
# UNIT / BUILDING WHITELISTS
# =========================================================
KNOWN_BUILDINGS: Set[str] = {
    "Nexus", "Pylon", "Assimilator", "Gateway", "Forge", "CyberneticsCore",
    "PhotonCannon", "ShieldBattery", "TwilightCouncil", "Stargate",
    "RoboticsFacility", "RoboticsBay", "TemplarArchive", "DarkShrine",
    "FleetBeacon", "WarpGate", "CommandCenter", "CommandCenterFlying",
    "OrbitalCommand", "OrbitalCommandFlying", "PlanetaryFortress", "SupplyDepot",
    "SupplyDepotLowered", "Refinery", "Barracks", "BarracksFlying", "Factory",
    "FactoryFlying", "Starport", "StarportFlying", "EngineeringBay", "Armory",
    "GhostAcademy", "FusionCore", "TechLab", "Reactor", "BarracksTechLab",
    "BarracksReactor", "FactoryTechLab", "FactoryReactor", "StarportTechLab",
    "StarportReactor", "MissileTurret", "SensorTower", "Bunker", "Hatchery",
    "Lair", "Hive", "SpawningPool", "EvolutionChamber", "Extractor", "RoachWarren",
    "BanelingNest", "SpineCrawler", "SporeCrawler", "HydraliskDen", "LurkerDen",
    "InfestationPit", "Spire", "GreaterSpire", "NydusNetwork", "NydusCanal",
    "UltraliskCavern", "CreepTumor", "CreepTumorBurrowed", "CreepTumorQueen",
}

MORPH_BUILDINGS: Set[str] = {
    "Lair", "Hive", "GreaterSpire", "OrbitalCommand", "PlanetaryFortress",
    "WarpGate", "LurkerDen",
}

SKIP_UNITS: Set[str] = {
    "MULE", "Larva", "LocustMP", "Probe", "SCV", "Drone", "Egg", "BroodlingEscort",
    "Broodling", "Changeling", "ChangelingMarine", "ChangelingMarineShield",
    "ChangelingZergling", "ChangelingZealot", "InfestedTerran", "AutoTurret",
    "PointDefenseDrone", "Interceptor", "AdeptPhaseShift", "Overlord",
    "OverseerCocoon", "BanelingCocoon", "RavagerCocoon", "LurkerCocoon",
    "TransportOverlordCocoon",
}

SKIP_BUILDINGS: Set[str] = {
    "SupplyDepot", "SupplyDepotLowered", "CreepTumor",
    "CreepTumorBurrowed", "CreepTumorQueen", "ShieldBattery",
}

# Sorted list of named builds (excluding catch-alls), suitable for seeding the DB.
KNOWN_BUILDS: List[str] = sorted(list(set([
    k for k in BUILD_DEFINITIONS.keys()
    if not k.endswith("Unknown") and not k.endswith("Unclassified")
])))
# =========================================================
# STAGE 7.4: MERGED BUILD DEFINITIONS
# =========================================================
# `BUILD_SIGNATURES` above is the *built-in* table. Stage 7.4 adds
# user-authored builds (from data/custom_builds.json) and the
# community-mirror cache (data/community_builds.cache.json) on top.
# The classifier in `scripts/build_classify_cli.py` calls
# `get_active_build_definitions()` to get the merged set.
#
# Collision rules:
#   * Built-in keys (exact id match) always win.
#   * Among customs and community entries, the most recent
#     ``updated_at`` wins -- mirrors the precedence the community
#     service uses for its own ``version`` counter.

from typing import Iterable


def _v2_to_signature_entry(build: Dict[str, object]) -> Dict[str, object]:
    """Convert a v2 build dict into the BUILD_SIGNATURES entry shape.

    Example:
        >>> b = {"race": "Protoss", "vs_race": "Zerg",
        ...      "signature": [], "tier": "A", "description": "x"}
        >>> _v2_to_signature_entry(b)["tier"]
        'A'
    """
    return {
        "race": build.get("race"),
        "vs_race": build.get("vs_race"),
        "signature": build.get("signature", []),
        "tier": build.get("tier") or "?",
        "description": build.get("description", ""),
        "tolerance_sec": build.get("tolerance_sec"),
        "min_match_score": build.get("min_match_score"),
        "source": build.get("source", "user"),
        "id": build.get("id"),
        "updated_at": build.get("updated_at"),
    }


def _pick_most_recent(
    candidates: Iterable[Dict[str, object]],
) -> Dict[str, object]:
    """Return the candidate with the lexicographically-largest
    ``updated_at`` -- ISO 8601 strings sort the same as time.

    Example:
        >>> _pick_most_recent([
        ...     {"id": "x", "updated_at": "2026-01-01T00:00:00Z"},
        ...     {"id": "x", "updated_at": "2026-04-01T00:00:00Z"},
        ... ])["updated_at"]
        '2026-04-01T00:00:00Z'
    """
    best = None
    for cand in candidates:
        if best is None or (
            cand.get("updated_at", "") > best.get("updated_at", "")
        ):
            best = cand
    return best or {}


def get_active_build_definitions() -> Dict[str, Dict[str, object]]:
    """Return the merged classifier table (built-ins + customs + community).

    Keys of the returned dict are stable display ids:
      * Built-ins keep their original BUILD_SIGNATURES key.
      * Customs / community use their slug ``id``.

    Returns:
        Mapping ``{display_id: signature_entry}`` ready for the
        scoring algorithm in :mod:`scripts.build_classify_cli`.

    Example:
        >>> defs = get_active_build_definitions()
        >>> isinstance(defs, dict)
        True
    """
    # Lazy import: at module-load time `core.custom_builds` triggers
    # the v1->v2 migration which writes to disk; we want that to
    # happen only when classification is actually requested.
    from .custom_builds import load_custom_builds_v2, load_community_cache

    merged: Dict[str, Dict[str, object]] = {}
    # Layer 1: built-ins.
    for key, meta in BUILD_SIGNATURES.items():
        entry = dict(meta)
        entry["source"] = "builtin"
        entry["id"] = key
        merged[key] = entry
    # Layer 2: customs + community-cache, picking the most recent
    # updated_at on collision.
    user_builds: Dict[str, list] = {}
    for build in load_custom_builds_v2().get("builds", []):
        user_builds.setdefault(build.get("id"), []).append(
            {**build, "source": "custom"}
        )
    for build in load_community_cache().get("builds", []):
        user_builds.setdefault(build.get("id"), []).append(
            {**build, "source": "community"}
        )
    for build_id, candidates in user_builds.items():
        if build_id in merged:
            continue
        winner = _pick_most_recent(candidates)
        if not winner:
            continue
        merged[build_id] = _v2_to_signature_entry(winner)
    return merged
