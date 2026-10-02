"""
Build & strategy definitions for the SC2 analyzer/overlay engine.

This module is data-only -- it has no logic. It exposes:
    BUILD_DEFINITIONS  -- {name: human description}
    KNOWN_BUILDINGS    -- structures we track for strategy detection
    MORPH_BUILDINGS    -- structures created via UnitTypeChange (Lair, Hive, etc.)
    SKIP_UNITS         -- unit names to ignore (workers, larva, broodlings, etc.)
    SKIP_BUILDINGS     -- structures to ignore for strategy detection
    KNOWN_BUILDS       -- sorted list of named builds suitable for DB seeding
    EIGHT_WORKER_BUILD_NAMES -- names the 8-worker patch 5.0.16 used instead
"""

from typing import Dict, List, Optional, Set

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
    "Protoss - Proxy 4 Gate": "Detected if 3+ Gateways are started before 4:30 more than 50 units from the opponent's own main (a proxy) and no natural Nexus is started before 4:30.",
    "Protoss - DT Rush": "Detected if a Dark Shrine is built before 5:00 AND at least one real (non-hallucinated) Dark Templar is on the field by 6:00 -- a true DT harass opener. Mid-game DT-tech additions (Shrine going down after a Stargate or Robo opener) and Sentry-hallucinated Dark Templars are excluded.",
    "Protoss - 4 Gate Rush": "Detected if 4 Gateways exist before 6:00 and before the 2nd Nexus.",
    "Protoss - Glaive Adept Timing": "Detected if Twilight Council + Glaives researched + High Adept count by 6:30.",
    "Protoss - Chargelot All-in": "Detected if Charge is researched, 7+ Gates, and low gas count.",
    "Protoss - Stargate Opener": "Detected if a Stargate is built before 6:30.",
    "Protoss - Robo Opener": "Detected if a Robotics Facility is built before 6:30 AND no Twilight Council was started before it (a 2-Gate Expand Blink build with a later Robo is a Twilight-first opener, not a Robo Opener).",
    "Protoss - Proxy Stargate Opener": "Detected if a Stargate is built away from the opponents base before 6:30.",
    "Protoss - Proxy Robo Opener": "Detected if a Robo is built away from the opponents base before 6:30.",
    "Protoss - Standard Expand": "Detected if the 2nd Nexus starts before 6:30.",
    "PvP - 1 Gate Expand": "PvP standard 1-gate expand: exactly 1 Gateway started before the natural Nexus (which goes down before 5:00), the first warp-in is a Stalker / Adept / Zealot, and no Stargate / Robotics Facility / Twilight Council was started before the natural. Tech before the natural makes it a tech-first opener (Standard Stargate Opener, Robo Opener, Rail's Blink Stalker, ...); the 1 Gate Expand label is kept only when no tech rule recognises the game.",
    "PvP - 2 Gate Expand": "PvP safer 2-gate expand: 2 (or more) Gateways are started before the natural Nexus (which goes down before 5:00) AND no tech building (Stargate, Robotics Facility, or Twilight Council) is started before the natural. A Stargate / Robo / Twilight before the natural means it is a tech-first opener (Standard Stargate Opener, Robo Opener, ...); the 2 Gate Expand label is kept only when no tech rule recognises the game. Trades a few seconds of economy for protection vs proxy 2-gate / early aggression.",
    "PvP - Strange's 1 Gate Expand": "PvP 1-gate expand variant where exactly 1 Gateway is started before the natural Nexus (which goes down before 5:00), the first warp-in is a Sentry, and no Stargate / Robotics Facility / Twilight Council was started before the natural (tech before the natural is a tech-first opener; this label is kept only when no tech rule recognises the game).",
    "PvP - 1 Gate Nexus into 4 Gate": "Detected if exactly 1 Gateway is started before the natural Nexus (which goes down before 5:00), 4+ Gateways exist by 6:00, the first warp-in is a Stalker / Adept / Zealot (NOT Sentry), no tech building (Stargate / Robotics Facility / Twilight Council / Templar Archive / Dark Shrine) is started before the 4th Gateway, and Warp Gate research finishes by 5:30 -- the 1 Gate Nexus into 4 Gate Stalker timing.",
    "Protoss - Blink All-In": "3 or 4 Gateways have been made along with Blink before 6:30 without a second Nexus.",
    "Protoss - Standard Macro (CIA)": "Detected if Protoss has 3 Bases and Charge/Immortal/Archon tech path.",
    "Protoss - Skytoss Transition": "Mid/Late game composition fallback based on multiple Stargates or Carriers.",
    "Protoss - Robo Comp": "Mid/Late game composition fallback based on Colossi or Disruptors.",
    "Protoss - Chargelot/Archon Comp": "Mid/Late game composition fallback based on Archons and Chargelots.",
    "PvZ - Carrier Rush": "Detected if a Stargate AND a Fleet Beacon are built and at least 1 Carrier has been produced by 10:00 -- skytoss into Carriers. Carriers without a Stargate + Fleet Beacon are treated as hallucinations.",
    "PvZ - Tempest Rush": "Detected if a Stargate AND a Fleet Beacon are built and at least 1 Tempest has been produced by 10:00 -- long-range Tempest harass / siege.",
    "PvZ - 2 Stargate Void Ray": "Detected if 2+ Stargates and 2+ Nexuses by 10:00, plus 4+ Void Rays produced by 10:00 (Void Rays without a Stargate are ignored as hallucinations). An EARLY Robotics Facility (before 6:00) reroutes to Stargate into Robo; a later Robo is treated as Observer / Immortal support and still counts as Void Ray.",
    "PvZ - 3 Stargate Phoenix": "Detected if 3+ Stargates and 2+ Nexuses by 10:00, plus 4+ Phoenix produced by 10:00 (Phoenix without a Stargate are ignored as hallucinations).",
    "PvZ - 2 Stargate Phoenix": "Detected if 2+ Stargates and 2+ Nexuses by 10:00, plus 4+ Phoenix produced by 10:00 (Phoenix without a Stargate are ignored as hallucinations).",
    "PvZ - Rail's Disruptor Drop": "Detected if a Robotics Facility AND a Robotics Bay are built and at least 1 Disruptor and 1 Warp Prism are produced by 8:00 -- an early Disruptor drop harass build.",
    "PvZ - AlphaStar Style (Oracle/Robo)": "Detected if the Stargate is the first tech building, followed by the third Nexus and then a Robotics Facility that begins by 5:30 and before any Twilight Council, with 2+ Oracles plus a Forge present by 8:30 -- the AlphaStar Oracle / fast-third / fast-Robo composition.",
    "PvZ - 7 Gate Glaive/Immortal All-in": "Detected if a Robotics Facility is built, Glaives is researched by 8:30, 2+ Sentries and 1+ Immortal produced by 8:30, and 6+ Gateways exist by 9:00 -- a heavy Glaive Adept / Immortal all-in.",
    "PvZ - Blink Stalker All-in (2 Base)": "Detected if Blink is researched by 8:00, 5+ Gateways exist by 8:00, the player has at most 2 Nexuses by 8:00, and has NOT built a Stargate or Dark Shrine by 8:00 -- a 2-base Blink all-in. A third Nexus by 8:00 is a Twilight-first Blink macro game, not the all-in.",
    "PvZ - Stargate into Glaives": "Detected if a Stargate is the first tech building, the Twilight Council precedes any Robotics Facility, and Resonating Glaives is the first Twilight upgrade, ahead of Blink and Charge -- a Stargate opener into Glaive Adepts, with no artificial Gateway-count cutoff.",
    "PvZ - Archon Drop": "Detected if Stargate goes down before Twilight Council, a Templar Archives is up by 9:00, and 2+ Archons have been produced by 9:00 -- Stargate opener transitioning into Archon drops. Requires Templar Archives (or Dark Shrine for DT-Archon morph). Checked before Stargate into Robo, so the drop's Warp Prism (Robotics Facility) never hides it.",
    "PvZ - DT drop into Archon Drop": "Detected if Twilight Council goes down before Dark Shrine, a Dark Shrine AND a Robotics Facility are up by 9:00, 3+ Dark Templar are produced by 9:00, and a Warp Prism is on the field by 9:00.",
    "PvZ - Standard Blink Macro": "Detected if a Stargate opener is followed by a third Nexus by 9:00 (the third starts before Twilight or within four minutes after it), Blink is the first Twilight upgrade and completes by 10:00, and any Robotics Facility follows the Twilight -- standard 3-base Blink macro rather than AlphaStar.",
    "PvZ - Standard charge Macro": "Detected if a Stargate opener is followed by a third Nexus by 9:00 (the third starts before Twilight or within four minutes after it), Charge is the first Twilight upgrade and completes by 10:00, and any Robotics Facility follows the Twilight -- standard 3-base Chargelot macro rather than AlphaStar.",
    "PvZ - Robo Opener": "Detected if a Robotics Facility is the FIRST tech building -- built BEFORE any Stargate / Twilight Council / Dark Shrine. Pure ordering, no time threshold: a slow Robo opener with no other tech first still counts.",
    "PvZ - Macro Transition (Unclassified)": "PvZ catch-all: the game reached the macro phase but did not match a more specific PvZ pattern.",
    "PvP - Proxy 2 Gate": "Detected if a Gateway is started by 1:45 more than 50 units from the player's own main (a proxy) and no natural Nexus is started before 4:30 -- a proxied 2-Gate / 3-Gate aggression. Timing is what separates it from the other forward builds: a true proxy 2-Gate's Gateways go down between ~0:30 and ~1:15 (1:45 leaves a margin), while a proxy Robo proxies at ~2:00-3:00 and a 3-4 Gate (Warp Gate) build with a forward Gateway places it in that same band -- neither counts.",
    "PvP - AlphaStar (4 Adept/Oracle)": "Detected if a Stargate is built, 4+ Adepts have been produced by 6:00 AND 1+ Oracle is on the field by 6:30 -- the AlphaStar 4-Adept / Oracle pressure opener. Oracles without a Stargate are treated as hallucinations.",
    "PvP - 4 Stalker Oracle into DT": "Detected if a Stargate is built, 3+ Stalkers by 6:30, 1+ Oracle by 7:30, and a Dark Shrine is built by 9:00 -- Stalker / Oracle harass transitioning into Dark Templar.",
    "PvP - Rail's Blink Stalker (Robo 1st)": "Detected if Robotics Facility goes down BEFORE Twilight Council, BOTH go down before the natural Nexus, and Blink is researched by 9:00 -- a Robo-first Blink Stalker style. A Robo-first build whose FIRST Twilight upgrade is Glaives tags as PvP - Robo into Glaives instead; a Robo-first build without Blink is the PvP - Robo Opener.",
    "PvP - Phoenix Style": "Detected if a Stargate is built and 3+ Phoenix have been produced by 8:30 -- an air-control / Phoenix-heavy PvP style. Hallucinated Phoenix from Sentries do not count.",
    "PvP - Blink Stalker Style": "Detected if Blink is researched by 9:00, the player has expanded (2+ Nexuses), and they have between 2 and 4 Gateways by 9:00 -- a macro Blink Stalker game.",
    "PvP - Proxy Robo Opener": "Detected if a Robotics Facility is started before 6:30 more than 50 units from the player's own main (a proxy) -- a proxied Robo (Immortal / Warp Prism) opener. The forward Gateway dropped beside the Robo (~2:00-3:00) is far later than a proxy 2-Gate's Gateways (~0:30-1:15), so it no longer tags the game as Proxy 2 Gate.",
    "PvP - Proxy Stargate Opener": "Detected if a Stargate is started before 6:30 more than 50 units from the player's own main (a proxy) -- a proxied Stargate (Void Ray / Oracle) PvP opener, the PvP counterpart of PvT - Proxy Void Ray/Stargate.",
    "PvP - Standard Stargate Opener": "Detected if a Stargate is built before 6:30 in the player's own base (not proxied) and is the FIRST tech building (before any Robotics Facility / Twilight Council) -- the standard Stargate (Oracle / Phoenix) PvP opener.",
    "PvP - Robo Opener": "Detected if a Robotics Facility in the player's own base is the FIRST tech building (before any Stargate and Twilight Council -- pure ordering, no time threshold) and no more specific Robo label applies (Proxy Robo Opener, Robo into Glaives, Rail's Blink Stalker) -- the standard Robo-first (Immortal / Observer) PvP opener.",
    "PvP - Robo into Glaives": "Detected if a Robotics Facility is built BEFORE the Twilight Council and the FIRST upgrade researched out of that Twilight Council is Resonating Glaives (Glaives starts BEFORE Blink and BEFORE Charge) -- the common PvP Robo (Immortal / Observer) opening into a Glaive Adept timing. Classification is purely order-based: the Glaives-first signal is what separates this from Rail's Blink Stalker (Robo 1st), where Blink would be the upgrade instead.",
    "PvP - Adept Glaives": "Detected if the Twilight Council is the FIRST tech building (built before any Robotics Facility AND any Stargate -- pure ordering, no time threshold) and the FIRST upgrade researched out of it is Resonating Glaives (Glaives starts BEFORE Blink and BEFORE Charge) -- a pure Gateway Adept Glaive timing. The Glaives-first signal separates it from Blink Stalker Style, where Blink would be researched first.",
    "PvP - Macro Transition (Unclassified)": "PvP catch-all: the game reached the macro phase but did not match a more specific PvP pattern.",
    "PvT - Proxy Void Ray/Stargate": "Detected if a Stargate is started more than 50 units from the player's own main (a proxy) before the natural Nexus, or before 4:30 when the natural came first -- a proxied Stargate (Void Ray) timing.",
    "PvT - Phoenix into Robo": "Detected if Stargate is the FIRST tech building (before Robo AND Twilight), 1+ real (non-hallucinated) Phoenix is on the field by 7:00, AND a Robotics Facility is up by 8:00 -- a Stargate-first Phoenix opener that transitions into Robo tech. The Stargate-first ordering keeps Robo-first openers that ADD a midgame Stargate + real Phoenix off this label (those fall through to Robo First). A Sentry's hallucinated Phoenix does NOT trigger this build, only a Phoenix produced after an actual Stargate.",
    "PvT - Phoenix Opener": "Detected if Stargate is the FIRST tech building (before Robo AND Twilight), 1+ real (non-hallucinated) Phoenix is on the field by 7:00, AND the player's second Gateway was built BEFORE the Robotics Facility -- a pure Stargate-first Phoenix opener. The Stargate-first ordering keeps Robo-first openers with a midgame Stargate + Phoenix harass off this label. Hallucinated Phoenix from Sentries do NOT count.",
    "PvT - 7 Gate Blink All-in": "Detected if Twilight Council is the FIRST tech building (before Robo AND Stargate), Blink is researched by 9:00, 6+ Gateways exist by 9:00, the 5th Gateway was STARTED before the 3rd Nexus, AND no 3rd Nexus was STARTED before 6:00 -- a heavy Twilight-first multi-Gate Blink all-in. The Twilight-first guard keeps Robo-first openers with 6+ Gateways + late Blink off this label (those fall through to Robo First). \"Taken\" the 3rd Nexus means construction was initiated, not finished: a player can drop a LATE 3rd Nexus (6:00 or later) and add Gateways while it is still building and those Gateways are still macro reinforcement. The build is excluded if the 3rd Nexus broke ground before the 5th Gateway, OR if any 3rd Nexus was taken before 6:00 (a fast 3rd Nexus is a macro commitment). A DT Drop opener that later macros into a multi-Gate Blink composition is also excluded -- the DT Drop signature is checked first.",
    "PvT - 8 Gate Charge All-in": "Detected if Twilight Council is the FIRST tech building (before Robo AND Stargate), Charge is researched by 9:00, 7+ Gateways exist by 7:30, AND fewer than 3 Nexuses have been taken -- a 2-base Twilight-first mass-Gate Chargelot all-in. The Twilight-first guard keeps Robo-first openers with 7+ Gateways + late Charge off this label.",
    "PvT - 2 Base Templar (Reactive/Delayed 3rd)": "Detected if Twilight Council is the FIRST tech building (before Robo AND Stargate), a Templar Archives is started by 9:00 and BEFORE the third Nexus, the third Nexus (if any) is delayed to 6:00 or later, the player has 4-6 Gateways by 7:30, AND Blink was not the first Twilight upgrade researched before the Archives (that is a Blink build with a Storm follow-up) -- a reactive 2-base High Templar / Storm timing with a delayed 3rd. The Twilight-first guard keeps Robo-first openers that add a late TA for Storm support off this label. A hallucinated High Templar is not enough; the Templar Archives must actually exist.",
    "PvT - Standard Charge Macro": "Detected if Charge is researched by 9:00, the player has taken 3+ Nexuses, AND Twilight Council is the FIRST tech building -- Twilight goes down before any Robotics Facility AND before any Stargate. The label describes the OPENER, not the entire composition: a Twilight-first Charge macro that later adds Robo (Observer / Immortal support) or transitions into Stargate tech in the midgame (Skytoss tech-switch, end-game Tempests, late Phoenix harass) still classifies as Standard Charge Macro because the opening was Twilight + Charge. Robo-first openers (Robo before Twilight) are caught by Robo First instead; Stargate-led openers are caught earlier by Stargate into Charge / Phoenix into Robo.",
    "PvT - 3 Gate Charge Opener": "Detected if Charge is researched by 9:00 AND Twilight Council was built BEFORE Robotics Facility AND BEFORE Stargate -- a Twilight-first 3-Gate Charge opener.",
    "PvT - 4 Gate Blink": "Detected if Twilight Council goes BEFORE Robo and Stargate, Blink is researched by 9:00, AND 4+ Gateways were STARTED before the 3rd Nexus -- a 4-Gate Blink Stalker timing. Counting gates before the 3rd Nexus (not a fixed 7:30 cutoff) means a fast-3rd-Nexus player who adds more Gateways post-expansion doesn't flip into this label, and a player who delays the 3rd to push out Gateways does.",
    "PvT - 3 Gate Blink (Macro)": "Detected if Twilight Council goes BEFORE Robo and Stargate, Blink is researched by 9:00, AND exactly 3 Gateways were STARTED before the 3rd Nexus -- a macro 3-Gate Blink style.",
    "PvT - 2 Gate Blink (Fast 3rd Nexus)": "Detected if Twilight Council is the FIRST tech building (before Robo AND Stargate), Blink is researched by 8:00, the player has taken 3+ Nexuses, AND exactly 2 Gateways were STARTED before the 3rd Nexus -- a fast-3rd 2-Gate Blink style, with or without a Robotics Facility follow-up for Observer / Immortal support. The Twilight-first ordering keeps Robo-first openers with a midgame Blink tech-switch off this label.",
    "PvT - DT Drop": "Detected if a Dark Shrine is started by 4:15 AND a Robotics Facility is up by 4:30 AND at least one real (non-hallucinated) Dark Templar exists on the field by 5:00 AND a Warp Prism is on the field by 5:15 -- a fast tactical PvT DT drop. Cutoffs calibrated against a real PvT DT Drop replay (Peruano, Taito Citadel LE 2026-05-11: Shrine 3:13, Robo 3:32, DT 3:51, Prism 4:11) with ~60s buffer per signal so slower variants still classify.",
    "PvT - Robo First": "Detected if a Robotics Facility is built before 6:30 AND it is the FIRST tech building (before any Stargate or Twilight Council). The label describes the OPENER, not the entire composition: a Robo opener that transitions into Stargate tech later in the midgame (Skytoss tech-switch, end-game Tempests) still classifies as Robo First because the opening was Robo. Stargate-led openers are caught earlier by Phoenix into Robo / Phoenix Opener / Stargate Opener so they don't fall into this bucket.",
    "PvT - Macro Transition (Unclassified)": "PvT catch-all: the game reached the macro phase but did not match a more specific PvT pattern.",
    "Protoss - Standard Play (Unclassified)": "Catch-all for unclassified Protoss games.",
    "Terran - 2 Gas 3 Reaper 2 Hellion": "Detected if 2 Gas, 3 Reapers, and 2 Hellions before 5:30.",
    "Terran - Proxy Rax": "Detected if Barracks are built far from the main base before 4:30.",
    "Terran - Ghost Rush": "Detected if Ghost Academy is built within first 5:30 of the game -- a true 1-2 base Ghost commitment. Standard Bio macro builds usually add the Academy after 6:00 for mid-game snipes / EMPs and are excluded.",
    "Terran - Cyclone Rush": "Detected if Factory with Tech Lab and Cyclones are built early (< 5:30).",
    "Terran - Hellbat All-in": "Detected if Armory is built early (< 5:00) with high Hellion/Hellbat count.",
    "Terran - Widow Mine Drop": "Detected if Medivac and multiple widow mines are built after second CC within the first 6:30.",
    "Terran - BC Rush": "Detected if a Fusion Core is built before 5:30 AND at least one Battlecruiser is on the field by 7:30 -- a Starport-into-FC BC commitment. A Fusion Core alone is not enough; mech-into-late-game-BC macro games build FC for end-game composition and are excluded by the unit-presence requirement.",
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

    # ----- Matchup-specific Zerg & Terran builds -----
    # Detected by the per-matchup detectors in
    # ``core.strategy_detector_matchups`` (mirrors of the detailed
    # Protoss trees). They take precedence over the generic race tree
    # and fall through to it when no specific build matched.
    # --- TvT ---
    "TvT - Proxy 4 Rax Reaper": "Detected when four Barracks (at least one proxied near the enemy) flood Reapers -- the all-in proxy reaper rush in TvT.",
    "TvT - Proxy Marauder": "Detected when a proxied Barracks pumps Marauders into the enemy base -- the TvT proxy Marauder rush.",
    "TvT - Cyclone Push": "Detected when an early Factory produces Cyclones off two or fewer bases -- the TvT Cyclone push.",
    "TvT - 1-1-1 Cloak Banshee": "Detected when a Factory and Starport are built before any expansion and a Banshee reaches the field on one base -- the classic 1-1-1 cloak-Banshee harass.",
    "TvT - Banshee into Raven": "Detected when cloak Banshees are backed by a Raven for detection and anti-air -- the TvT Banshee/Raven harass.",
    "TvT - Battlecruiser Rush": "Detected when a fast Fusion Core lands Battlecruisers -- the TvT Battlecruiser rush.",
    "TvT - Tank/Thor Mech": "Detected when an Armory backs Thors and Siege Tanks -- the positional TvT mech composition.",
    "TvT - Reaper Expand into Tank/Viking": "Detected when a Reaper-first scout is followed by a single expansion and then Siege Tanks behind Vikings -- the standard TvT positional macro opener that masses tanks for the air-controlled contain.",
    "TvT - 2-1-1 Marine Tank": "Detected when a Starport build fields Siege Tanks and Marines off two bases (no Viking) -- the TvT bio-tank timing.",
    "TvT - 3 Rax Marine": "Detected when 3+ Barracks off one base flood Marines with no Factory -- a gas-light TvT Marine all-in.",
    "TvT - Mass Viking Air": "Detected when a Viking-heavy air composition dominates the skies -- the TvT mass-Viking late game.",
    # --- TvZ ---
    "TvZ - Proxy 4 Rax Reaper": "Detected when four Barracks (at least one proxied near the enemy) flood Reapers -- the all-in proxy reaper rush vs Zerg.",
    "TvZ - 1-1-1 Banshee": "Detected when a Factory and Starport are built before any expansion and a Banshee reaches the field on one base -- the 1-base cloak-Banshee harass vs Zerg.",
    "TvZ - 3 Rax Marine": "Detected when 3+ Barracks off a single base produce a Marine flood with no Factory -- a gas-light Marine all-in vs Zerg.",
    "TvZ - Reaper Hellion Expand": "Detected when a Reaper-first scout and early Hellions back a fast expansion before any air or mech-upgrade tech -- the standard economic Reaper/Hellion opener vs Zerg.",
    "TvZ - 3 CC Bio": "Detected when three Command Centers are taken by 6:00 behind 3+ Barracks of Marine/Marauder with no mech tech (Armory / Fusion Core) -- the standard macro bio opening vs Zerg.",
    "TvZ - 2 Base Hellbat Thor": "Detected when an Armory and two Factories produce Thors behind a wall of Hellions/Hellbats off two bases -- the 2-base mech timing vs Zerg.",
    "TvZ - 2-1-1 Marine Hellbat Timing": "Detected when Armory-backed Hellbats and Marines push off two bases without a Thor -- the 2-1-1 marine/hellbat timing attack.",
    "TvZ - Battlecruiser Mech": "Detected when a Fusion Core produces Battlecruisers as the late-game mech finisher vs Zerg.",
    "TvZ - Hellion Liberator": "Detected when early Hellions plus a Liberator zone the Zerg's bases off two CCs -- the Hellion/Liberator harass opener.",
    "TvZ - Widow Mine Marine": "Detected when a Marine ball with 2+ Widow Mines and a Medivac runs mobile mine drops vs Zerg.",
    "TvZ - 2-1-1 Marine Drop": "Detected when a Starport Medivac drop carries Marines off two bases -- the committed 2-base drop timing (not 3-CC macro).",
    # --- TvP ---
    "TvP - Proxy 4 Rax Reaper": "Detected when four Barracks (at least one proxied near the enemy) flood Reapers -- the all-in proxy reaper rush vs Protoss.",
    "TvP - Proxy Marauder": "Detected when a proxied Barracks pumps Marauders into the Protoss wall -- the proxy Marauder rush vs Protoss.",
    "TvP - Cyclone Push": "Detected when an early Factory produces Cyclones off two or fewer bases -- the lock-on Cyclone pressure vs Protoss.",
    "TvP - 1-1-1 Cloak Banshee": "Detected when a Factory and Starport are built before any expansion and a Banshee reaches the field on one base -- the 1-base cloak-Banshee harass vs Protoss.",
    "TvP - 3 Rax Marine": "Detected when 3+ Barracks off one base flood Marines with no Factory -- a gas-light Marine all-in vs Protoss.",
    "TvP - Battlecruiser Rush": "Detected when a fast Fusion Core lands Battlecruisers -- the Battlecruiser rush vs Protoss.",
    "TvP - Tank/Thor Mech": "Detected when an Armory backs Thors and Siege Tanks -- the positional mech composition vs Protoss.",
    "TvP - Widow Mine Drop": "Detected when a Marine ball with 2+ Widow Mines and a Medivac runs mobile mine drops into the Protoss mineral lines.",
    "TvP - 2-1-1 Reaper Expand": "Detected when a Reaper-first scout takes a single expansion (no fast 3rd CC) and adds a Factory + Starport for the Medivac-drop / Stim bio timing off two bases vs Protoss.",
    "TvP - 2 Base Tank Push": "Detected when a Starport build fields Siege Tanks behind a Marine ball off two bases -- the classic tank-push timing vs Protoss.",
    "TvP - Fast 3 CC Bio": "Detected when three Command Centers are taken by 6:00 behind 3+ Barracks of Marine/Marauder with no mech tech -- the greedy macro bio opening vs Protoss.",
    # --- ZvT ---
    "ZvT - Ling Bane Bust": "Detected when an early Pool and Baneling Nest flood Banelings and Zerglings off two or fewer bases -- the ZvT ling/bane bust.",
    "ZvT - 2 Base Roach Ravager Timing": "Detected when a Roach Warren produces a wall of Roaches and Ravagers off two bases on a low drone count -- the ZvT roach/ravager pressure timing.",
    "ZvT - 2 Base Nydus": "Detected when a Nydus Network goes down off two bases for a drop into the Terran main -- the ZvT Nydus all-in.",
    "ZvT - Mass Queen Defensive": "Detected when a queen-heavy defence (6+ Queens) holds with no Roach/Baneling/Spire aggression -- the ZvT queen-walk / defensive style.",
    "ZvT - Lurker Contain": "Detected when a Lurker Den enables a positional Lurker contain vs Terran.",
    "ZvT - 3 Hatch Ling Bane Muta": "Detected when three bases go down with a Baneling Nest and Spire, defending bio with Banelings and Zerglings while teching to Mutalisks -- the textbook ZvT macro style.",
    "ZvT - Mass Muta Harass": "Detected when a Spire into 6+ Mutalisks (no Baneling Nest) runs pure muta harass vs Terran.",
    "ZvT - Roach Hydra": "Detected when a Roach Warren and Hydralisk Den field a roach/hydra ground army vs Terran.",
    "ZvT - 3 Base Ling Flood": "Detected when three bases pump 20+ Zerglings on a low drone count -- the ZvT ling-flood timing.",
    "ZvT - Hatch First Macro": "Detected when a greedy three-base economy (40+ Drones) opens hatch-first vs Terran.",
    # --- ZvP ---
    "ZvP - 12 Pool Rush": "Detected when the Spawning Pool starts before 0:55 into a wall of Zerglings on one base -- the cheese rush vs Protoss.",
    "ZvP - Ling Bane Bust": "Detected when an early Pool and Baneling Nest flood Banelings and Zerglings off two or fewer bases -- the bust through the Protoss wall.",
    "ZvP - 2 Base Roach Ravager All-in": "Detected when a Roach Warren produces a wall of Roaches and Ravagers off two bases on a low drone count -- the ZvP roach/ravager all-in.",
    "ZvP - 2 Base Nydus": "Detected when a Nydus Network goes down off two bases for a worm into the Protoss main -- the ZvP Nydus all-in.",
    "ZvP - Hydra Timing (3 Base)": "Detected when a Hydralisk Den fields a hydra wave off three bases -- the standard ZvP answer to Stargate openers.",
    "ZvP - Lurker Contain": "Detected when a Lurker Den enables a positional Lurker contain vs Protoss.",
    "ZvP - Ling Bane Muta": "Detected when a Baneling Nest and Spire support Banelings and a wall of Zerglings -- the muta/ling/bane harass style vs Protoss.",
    "ZvP - Mutalisk Harass": "Detected when a Spire into 6+ Mutalisks (no Baneling Nest) runs pure muta harass into the Protoss mineral lines.",
    "ZvP - Speedling Flood": "Detected when three bases pump 20+ Zerglings on a low drone count -- the ZvP ling-flood timing against a greedy third.",
    "ZvP - Hatch First Macro": "Detected when a greedy three-base economy (40+ Drones) opens hatch-first vs Protoss.",
    # --- ZvZ ---
    "ZvZ - 12 Pool into Baneling": "Detected when a sub-55s Pool goes straight into a Baneling Nest and Banelings -- the early ZvZ baneling all-in.",
    "ZvZ - 12 Pool Speedling": "Detected when the Spawning Pool starts before 0:55 into a wall of Zerglings on one base -- the aggressive ZvZ speedling opener.",
    "ZvZ - Ling Bane All-in": "Detected when a Baneling Nest floods Banelings and Zerglings off two or fewer bases -- the ZvZ ling/bane all-in.",
    "ZvZ - Roach Ravager": "Detected when a Roach Warren fields Roaches and Ravagers -- the ZvZ roach/ravager style.",
    "ZvZ - Roach Aggression": "Detected when a Roach Warren produces a wall of Roaches off two bases -- the standard ZvZ roach pressure / all-in.",
    "ZvZ - 2 Base Nydus": "Detected when a Nydus Network goes down off two bases -- the ZvZ Nydus all-in.",
    "ZvZ - Mutalisk vs Mutalisk": "Detected when a Spire into 6+ Mutalisks creates the classic ZvZ muta war.",
    "ZvZ - Hatch First Muta": "Detected when a hatch-first economy (slow Pool) teches to a Spire -- the ZvZ hatch-first muta.",
    "ZvZ - Zergling Flood": "Detected when 20+ Zerglings flood on a low drone count -- the ZvZ ling flood.",
    "ZvZ - Drone Macro (Hatch First)": "Detected when a greedy hatch-first economy (30+ Drones, slow Pool) drones up in ZvZ.",
    # ----- Labels the detectors emit that the catalog used to lack, plus the
    # proxy openers added to the PvT / PvZ user trees and the opponent tree.
    "PvT - Proxy 2 Gate": "Detected if a Gateway is started by 1:45 more than 50 units from the player's own main (a proxy) and no natural Nexus is started before 4:30 -- a proxied 2-Gate / 3-Gate aggression vs Terran. Same timing rule as PvP - Proxy 2 Gate: a true proxy 2-Gate's Gateways go down between ~0:30 and ~1:15; a forward Gateway in the 2:00-3:00 band (proxy Stargate, 3-4 Gate with a proxy Gateway) is not one.",
    "PvZ - Proxy 2 Gate": "Detected if a Gateway is started by 1:45 more than 50 units from the player's own main (a proxy) and no natural Nexus is started before 4:30 -- a proxied 2-Gate / 3-Gate aggression vs Zerg. Same timing rule as PvP - Proxy 2 Gate: a true proxy 2-Gate's Gateways go down between ~0:30 and ~1:15; a forward Gateway in the 2:00-3:00 band (proxy Stargate, 3-4 Gate with a proxy Gateway) is not one.",
    "PvZ - Cannon Rush": "Detected if a Photon Cannon is started before 4:30 more than 50 units from the player's own main (a proxy) -- a cannon rush vs Zerg.",
    "PvZ - Proxy Stargate Opener": "Detected if a Stargate is started before 6:30 more than 50 units from the player's own main (a proxy) -- a proxied Stargate (Void Ray / Oracle) opener vs Zerg, the counterpart of PvT - Proxy Void Ray/Stargate.",
    "Protoss - Proxy 2 Gate": "Detected if a Gateway is started by 1:45 more than 50 units from the opponent's own main (a proxy) and no natural Nexus is started before 4:30 -- a proxied 2-Gate / 3-Gate aggression. Timing separates it from a proxy Robo / Stargate (proxied at ~2:00-3:00); 3+ proxied Gateways before 4:30 are the Proxy 4 Gate.",
    "PvZ - Adept Glaives (No Robo)": "Detected if the Twilight Council is the FIRST tech building after the Cybernetics Core (no Stargate, Robotics Facility, or Dark Shrine is started before Twilight -- pure ordering, no time threshold), the FIRST upgrade researched out of the Twilight Council is Resonating Glaives (Glaives starts BEFORE Blink and BEFORE Charge), AND no Robotics Facility is built by 10:00 -- a pure Gateway Adept Glaive Timing without Robo support. Order-based with no Gateway-count window, like Stargate into Glaives.",
    "PvZ - Adept Glaives (Robo)": "Detected if the Twilight Council is the FIRST tech building after the Cybernetics Core (no Stargate, Robotics Facility, or Dark Shrine is started before Twilight -- pure ordering, no time threshold), the FIRST upgrade researched out of the Twilight Council is Resonating Glaives (Glaives starts BEFORE Blink and BEFORE Charge), AND a Robotics Facility is built by 10:00 (after Twilight, as Observer / Immortal support) -- the Robo variant of Adept Glaive Timing. Order-based with no Gateway-count window, like Stargate into Glaives.",
    "PvT - Stargate Opener": "Catch-all: detected when a Stargate is the FIRST tech building after the Cybernetics Core (before Twilight Council and before Robotics Facility) AND the build did NOT match any more specific Stargate-prefixed PvT rule (Proxy Void Ray / Stargate into Charge / Glaives / Blink / Phoenix into Robo / Phoenix Opener). A custom build rule can refine this further.",
    "PvT - Stargate into Blink": "Detected if a Stargate is built before any Twilight Council (the Stargate unit produced does NOT matter), a Twilight Council is built AFTER the Stargate, AND the FIRST upgrade researched out of the Twilight Council is Blink (i.e. Blink starts before Resonating Glaives and before Charge). Stargate harass into Blink Stalker macro/midgame. Disqualified if a Robotics Facility (or an Immortal / Robotics Bay) lands BEFORE the Twilight Council — those replays are Phoenix into Robo, not Twilight-led.",
    "PvT - Stargate into Charge": "Detected if a Stargate is built before any Twilight Council (the Stargate unit produced — Phoenix / Oracle / Void Ray — does NOT matter), a Twilight Council is built AFTER the Stargate, AND the FIRST upgrade researched out of the Twilight Council is Charge (i.e. Charge starts before Resonating Glaives and before Blink). The build can resolve as a 2-base Chargelot timing OR transition into a 3-base Charge macro game — the rule keys on the Stargate-then-Charge opening only and does NOT require an all-in commitment. Disqualified if a Robotics Facility (or an Immortal / Robotics Bay) lands BEFORE the Twilight Council — those replays are Phoenix into Robo / Robo First, not Twilight-led.",
    "PvT - Stargate into Glaives": "Detected if a Stargate is built before any Twilight Council (typically with Phoenix harass, but the Stargate unit does NOT matter), a Twilight Council is built AFTER the Stargate, AND the FIRST upgrade researched out of the Twilight Council is Resonating Glaives (Glaives starts before Blink and before Charge). The old-school Stargate-Phoenix into Glaive Adept midgame timing. Disqualified if a Robotics Facility (or an Immortal / Robotics Bay) lands BEFORE the Twilight Council — those replays are Phoenix into Robo, not Twilight-led.",
    "TvP - 1-1-1 One Base": "Terran user-side label: Barracks + Factory + Starport all built BEFORE the 2nd Command Center, none of the three proxied -- the classic 1-base 1-1-1 all-in vs Protoss (Cloak Banshee / Marine-Tank / Marine-Medivac-Tank pressure off a single base).",
    "PvZ - DT Opener": "Detected if a Dark Shrine is the player's primary alternative-tech path -- built BEFORE any Stargate / Robotics Facility -- with at least 1 real Dark Templar on the field by 9:00. Pure ordering, no time threshold: a slow Shrine with no earlier Stargate / Robo still counts. (Twilight Council is required as Dark Shrine's prereq, so a Twilight-first ordering is implicit and isn't checked separately.) Catches DT openers that transition to mid- or late-game tech (Skytoss / Mothership / Templar) -- without this rule a DT build that later picked up a Stargate + Carrier used to mis-fire as PvZ - Carrier Rush.",
    "PvZ - Stargate Opener": "Catch-all for any Stargate-first opener (Stargate built BEFORE any Twilight Council / Dark Shrine / Robotics Facility) that didn't match a more specific Stargate-prefixed PvZ rule -- Carrier Rush, Tempest Rush, 2/3 Stargate Phoenix, 2 Stargate Void Ray, AlphaStar Style, Stargate into Robo, Stargate into Glaives, Standard Blink Macro, Standard charge Macro, Archon Drop. Examples that land here: a Stargate that got harassed off before producing a real unit, a Stargate-into-Templar build without 2 Archons by 9:00, or any Stargate opener with an unusual midgame composition the analyzer doesn't have a named bucket for. Mirror of PvT - Stargate Opener.",
    "PvZ - Stargate into Robo": "Detected if the Stargate is the FIRST tech building, at least 1 real Phoenix / Oracle / Void Ray is on the field by 10:00, and a Robotics Facility is built by 10:00. This is the generic Stargate-into-Robo transition only when a clearer three-base Twilight path is absent: Twilight-then-Glaives before the Robo uses PvZ - Stargate into Glaives, while a three-base Twilight build whose first upgrade is Blink or Charge keeps its Standard Blink / Charge Macro label even if a support Robo is added later. Twilight may precede the third only when that Nexus follows within four minutes.",
    "Terran - Proxy Starport Hellion Drop": "Detected if a Factory and Starport are built away from the main base, the player has expanded (2nd Command Center started), 2+ Hellions are produced by 6:00, and the FIRST unit produced from the Starport is a Medivac -- an expanding proxy Starport build that uses a Medivac to ferry Hellions into the opponent's mineral line (Yoon-style Hellion drop). Differs from Proxy 1-1-1 by the 2nd CC and the Medivac-first opener.",
    "Zerg - Hatch First": "Hatch First opener: the natural Hatchery starts before the Spawning Pool, without the 17 Hatch / 18 Gas / 17 Pool gas timing.",
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
# Detection for these matchup builds is performed by the hardcoded
# decision trees in ``core.strategy_detector_matchups`` (keyed off
# building/unit/timing signatures), not by the ``signature`` rule lists
# here -- so ``signature`` stays empty. The entries document the catalog
# metadata (race / vs_race / tier) that the rest of the app reads.
BUILD_SIGNATURES: Dict[str, Dict[str, object]] = {
    name: {
        "race": race,
        "vs_race": vs_race,
        "signature": [],
        "tier": "A",
        "description": BUILD_DEFINITIONS[name],
    }
    for name, race, vs_race in (
        ("TvT - Reaper Expand into Tank/Viking", "Terran", "Terran"),
        ("TvT - 1-1-1 Cloak Banshee", "Terran", "Terran"),
        ("TvZ - 3 CC Bio", "Terran", "Zerg"),
        ("TvZ - 2 Base Hellbat Thor", "Terran", "Zerg"),
        ("TvP - Proxy Marauder", "Terran", "Protoss"),
        ("TvP - Cyclone Push", "Terran", "Protoss"),
        ("TvP - 1-1-1 Cloak Banshee", "Terran", "Protoss"),
        ("TvP - 3 Rax Marine", "Terran", "Protoss"),
        ("TvP - Battlecruiser Rush", "Terran", "Protoss"),
        ("TvP - Tank/Thor Mech", "Terran", "Protoss"),
        ("TvP - Widow Mine Drop", "Terran", "Protoss"),
        ("TvP - 2-1-1 Reaper Expand", "Terran", "Protoss"),
        ("TvP - 2 Base Tank Push", "Terran", "Protoss"),
        ("TvP - Fast 3 CC Bio", "Terran", "Protoss"),
        ("ZvT - 3 Hatch Ling Bane Muta", "Zerg", "Terran"),
        ("ZvT - 2 Base Roach Ravager Timing", "Zerg", "Terran"),
        ("ZvP - 12 Pool Rush", "Zerg", "Protoss"),
        ("ZvP - Ling Bane Bust", "Zerg", "Protoss"),
        ("ZvP - 2 Base Roach Ravager All-in", "Zerg", "Protoss"),
        ("ZvP - 2 Base Nydus", "Zerg", "Protoss"),
        ("ZvP - Hydra Timing (3 Base)", "Zerg", "Protoss"),
        ("ZvP - Lurker Contain", "Zerg", "Protoss"),
        ("ZvP - Ling Bane Muta", "Zerg", "Protoss"),
        ("ZvP - Mutalisk Harass", "Zerg", "Protoss"),
        ("ZvP - Speedling Flood", "Zerg", "Protoss"),
        ("ZvP - Hatch First Macro", "Zerg", "Protoss"),
        ("ZvZ - 12 Pool Speedling", "Zerg", "Zerg"),
        ("ZvZ - Roach Aggression", "Zerg", "Zerg"),
    )
}


# The pool-first openers were "8 Pool" on the 8-worker patch 5.0.16 and
# "12 Pool" before it and again from 5.0.17, which restored 12 starting
# workers. The detection rules are the same; only the name follows the
# patch the replay was played on.
EIGHT_WORKER_VERSION_PREFIX = "5.0.16."
EIGHT_WORKER_BUILD_NAMES: Dict[str, str] = {
    "Zerg - 12 Pool": "Zerg - 8 Pool",
    "ZvP - 12 Pool Rush": "ZvP - 8 Pool Rush",
    "ZvZ - 12 Pool into Baneling": "ZvZ - 8 Pool into Baneling",
    "ZvZ - 12 Pool Speedling": "ZvZ - 8 Pool Speedling",
}


def name_for_game_version(name: Optional[str], game_version: Optional[str]) -> Optional[str]:
    """Return a build name as the replay's patch calls it.

    Example:
        >>> name_for_game_version("Zerg - 12 Pool", "5.0.16.97425")
        'Zerg - 8 Pool'
        >>> name_for_game_version("Zerg - 12 Pool", "5.0.17.98000")
        'Zerg - 12 Pool'
    """
    if (
        name in EIGHT_WORKER_BUILD_NAMES
        and isinstance(game_version, str)
        and game_version.startswith(EIGHT_WORKER_VERSION_PREFIX)
    ):
        return EIGHT_WORKER_BUILD_NAMES[name]
    return name


# First live 5.0.16 build and first 5.0.17 build (None until it ships),
# mirroring PATCH_5_0_16_BUILD / PATCH_5_0_17_BUILD in the API's
# util/patchEra.js.
PATCH_5_0_16_BUILD = 97364
PATCH_5_0_17_BUILD: Optional[int] = None


def is_eight_worker_game(
    game_version: Optional[str], game_build: Optional[int] = None,
) -> bool:
    """True for a replay played on the 8-worker patch 5.0.16.

    Same precedence as ``isEightWorkerGame`` in the API's util/patchEra.js:
    the release string when the replay has one, else the numeric build.
    The API's last fallback, the game date, is for stored rows that
    predate version metadata; a replay file always carries its version.

    Example:
        >>> is_eight_worker_game("5.0.16.97425")
        True
        >>> is_eight_worker_game("5.0.17.98000", 98000)
        False
        >>> is_eight_worker_game(None, 97364)
        True
    """
    if isinstance(game_version, str):
        return game_version.startswith(EIGHT_WORKER_VERSION_PREFIX)
    if isinstance(game_build, int) and not isinstance(game_build, bool):
        return game_build >= PATCH_5_0_16_BUILD and (
            PATCH_5_0_17_BUILD is None or game_build < PATCH_5_0_17_BUILD
        )
    return False


def candidate_signatures_for(
    race: str, vs_race: str
) -> Dict[str, Dict[str, object]]:
    """Return BUILD_SIGNATURES entries matching (race, vs_race).

    The classifier in `core.strategy_detector.UserBuildDetector` calls
    this to narrow the candidate set before evaluating signatures, so a
    TvZ replay never gets compared against a ZvP rule.

    Example:
        >>> "ZvP - Ling Bane Muta" in candidate_signatures_for("Zerg", "Protoss")
        True
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

# Actual construction/build-log tokens eligible for proxy-only custom rules.
# Flying forms are state changes rather than construction events and are not
# emitted by event_extractor's MORPH_BUILDINGS path.
NON_BUILD_EVENT_STRUCTURES: Set[str] = {
    "CommandCenterFlying", "OrbitalCommandFlying", "BarracksFlying",
    "FactoryFlying", "StarportFlying",
}
PROXY_ELIGIBLE_BUILDINGS: Set[str] = (
    KNOWN_BUILDINGS
    - SKIP_BUILDINGS
    - NON_BUILD_EVENT_STRUCTURES
    - MORPH_BUILDINGS
)

# The canonical proxy test: a structure is proxied when it stands farther
# from its owner's main (their first town hall) than its radius below.
# Custom ``proxy: true`` rules on the desktop, the agent's
# ``spatial.*_proxies`` stamp (which the cloud evaluator trusts) and the
# offline proxy heatmap all share it.
#
# 50 world units clears the main and the natural. A standard third base
# sits 50-80 units out on most ladder maps (51.9 on Ever Dream), so the
# structures a macro game places there -- town halls, their gas, and Zerg
# static defence -- need the wider 80-unit test the built-in
# "Zerg - Proxy Hatch" rule already uses. Without it "proxied Hatchery
# before 4:00" matches every three-base game.
#
# Keep the two radii and the set in sync with
# apps/api/src/services/proxyClassification.js, which re-tests rows that
# older agents stamped with a flat 50 units.
PROXY_DISTANCE_DEFAULT: float = 50.0
PROXY_DISTANCE_EXPANSION: float = 80.0
EXPANSION_PROXY_BUILDINGS: Set[str] = {
    "Nexus", "CommandCenter", "Hatchery",
    # Morphed town halls cannot carry a proxy rule (see MORPH_BUILDINGS)
    # but the offline heatmap reads lifecycle rows that are renamed by
    # the morph, so they take the town-hall radius too.
    "OrbitalCommand", "PlanetaryFortress", "Lair", "Hive",
    "Assimilator", "Refinery", "Extractor",
    "SpineCrawler", "SporeCrawler",
}


def proxy_distance_for(name: object) -> float:
    """Distance from the owner's main beyond which ``name`` is a proxy.

    Example:
        >>> proxy_distance_for("Barracks")
        50.0
        >>> proxy_distance_for("Hatchery")
        80.0
    """
    if name in EXPANSION_PROXY_BUILDINGS:
        return PROXY_DISTANCE_EXPANSION
    return PROXY_DISTANCE_DEFAULT

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
