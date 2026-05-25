import type { BuildDefinition } from "../build-definitions";

export const PVZ_DEFINITIONS: ReadonlyArray<Omit<BuildDefinition, "id">> = [
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - 2 Stargate Phoenix",
    description:
      "Detected if the Stargate is the FIRST tech building (built before any Twilight Council / Dark Shrine / Robotics Facility), EXACTLY 2 Stargates and 2+ Nexuses are up by 10:00, 4+ Phoenix have been produced by 10:00 (Phoenix without a Stargate are ignored as hallucinations), AND Glaives was NOT the first upgrade researched out of the Twilight Council. 3+ Stargates falls under PvZ - 3 Stargate Phoenix instead. A Glaive Adept opener that adds 2 Stargates around 7:00 to counter Lurkers tags as PvZ - Adept Glaives. A Stargate-FIRST opener that adds a Twilight Council and researches Glaives first tags as PvZ - Stargate into Glaives, NOT 2 Stargate Phoenix -- the Glaives-first signal means the Phoenix are scouting / harass support for an Adept timing, not the build's main damage.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - 2 Stargate Void Ray",
    description:
      "Detected if the Stargate is the FIRST tech building (built before any Twilight Council / Dark Shrine / Robotics Facility), 2+ Stargates and 2+ Nexuses are up by 10:00, 4+ Void Rays have been produced by 10:00 (Void Rays without a Stargate are ignored as hallucinations), AND Glaives was NOT the first upgrade researched out of the Twilight Council. A Stargate-into-Glaives build with Void Ray support tags as PvZ - Stargate into Glaives instead.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - 3 Stargate Phoenix",
    description:
      "Detected if the Stargate is the FIRST tech building (built before any Twilight Council / Dark Shrine / Robotics Facility), 3+ Stargates and 2+ Nexuses are up by 10:00, 4+ Phoenix have been produced by 10:00 (Phoenix without a Stargate are ignored as hallucinations), AND Glaives was NOT the first upgrade researched out of the Twilight Council. A Stargate-into-Glaives build with Phoenix support tags as PvZ - Stargate into Glaives instead.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - 7 Gate Glaive/Immortal All-in",
    description:
      "Detected if a Robotics Facility is built, Glaives is researched by 8:30, 2+ Sentries and 1+ Immortal produced by 8:30, and 6+ Gateways exist by 9:00 -- a heavy Glaive Adept / Immortal all-in.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - AlphaStar Style (Oracle/Robo)",
    description:
      "Detected if the Stargate is the FIRST tech building (built before any Twilight Council / Dark Shrine / Robotics Facility), 2+ Oracles plus a Robotics Facility plus a Forge are all in place by 8:30, with 3+ Nexuses by 8:30 -- the AlphaStar Oracle / Robo / fast 3rd composition.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - Archon Drop",
    description:
      "Detected if Stargate goes down before Twilight Council, a Templar Archives is up by 9:00, and 2+ Archons have been produced by 9:00 -- Stargate opener transitioning into Archon drops. Requires Templar Archives (or Dark Shrine for DT-Archon morph).",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - Blink Stalker All-in (2 Base)",
    description:
      "Detected if Blink is researched by 8:00, 5+ Gateways exist by 8:00, and the player has NOT built a Stargate or Dark Shrine by 8:00 -- a 2-base Blink all-in.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - Carrier Rush",
    description:
      "Detected if the Stargate is the FIRST tech building (built before any Twilight Council / Dark Shrine / Robotics Facility), a Fleet Beacon is up by 10:00, and at least 1 Carrier has been produced by 10:00 -- a true Stargate-opener Carrier rush. A DT or Glaives opener that adds a Stargate / Fleet Beacon / Carrier late tags as PvZ - DT Opener or PvZ - Adept Glaives instead. Carriers without a Stargate + Fleet Beacon are treated as hallucinations.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - DT drop into Archon Drop",
    description:
      "Detected if Twilight Council goes down before Dark Shrine, a Dark Shrine AND a Robotics Facility are up by 9:00, 3+ Dark Templar are produced by 9:00, and a Warp Prism is on the field by 9:00.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - Macro Transition (Unclassified)",
    description:
      "PvZ catch-all: the game reached the macro phase but did not match a more specific PvZ pattern.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - Rail's Disruptor Drop",
    description:
      "Detected if a Robotics Facility AND a Robotics Bay are built and at least 1 Disruptor and 1 Warp Prism are produced by 8:00 -- an early Disruptor drop harass build.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - Robo Opener",
    description:
      "Detected if a Robotics Facility is the FIRST tech building -- built BEFORE any Stargate / Twilight Council / Dark Shrine. Pure ordering, no time threshold: a slow Robo opener with no other tech first still counts.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - Standard Blink Macro",
    description:
      "Detected if Stargate goes down before Twilight Council, Blink is researched by 10:00, and 3+ Nexuses are taken by 9:00 -- Stargate opener into 3-base Blink macro.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - Standard charge Macro",
    description:
      "Detected if Stargate goes down before Twilight Council, Charge is researched by 9:00, and 3+ Nexuses are taken by 9:00 -- Stargate opener into 3-base Chargelot macro.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - Stargate into Glaives",
    description:
      "Detected if a Stargate is built BEFORE any Twilight Council (pure ordering, no time threshold -- a slow Stargate opener that transitioned to Glaives still counts), the FIRST upgrade researched out of the Twilight Council is Resonating Glaives (Glaives starts BEFORE Blink and BEFORE Charge), and the player has 4-8 Gateways by 6:00 -- a Phoenix or Oracle into Glaive Adept timing. The Glaives-first signal is what separates this from Stargate into Blink, where Blink would be researched first instead.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - Adept Glaives (No Robo)",
    description:
      "Detected if the Twilight Council is the FIRST tech building after the Cybernetics Core (no Stargate, Robotics Facility, or Dark Shrine is started before Twilight), the FIRST upgrade researched out of the Twilight Council is Resonating Glaives (Glaives starts BEFORE Blink and BEFORE Charge), 4-8 Gateways exist by 9:00, AND no Robotics Facility is built -- a pure Gateway Adept Glaive Timing without Robo support.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - Adept Glaives (Robo)",
    description:
      "Detected if the Twilight Council is the FIRST tech building after the Cybernetics Core (no Stargate or Dark Shrine is started before Twilight), the FIRST upgrade researched out of the Twilight Council is Resonating Glaives (Glaives starts BEFORE Blink and BEFORE Charge), 4-8 Gateways exist by 9:00, AND a Robotics Facility is built -- the Robo variant of Adept Glaive Timing, using Observers for detection and Immortals for armor support.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - Tempest Rush",
    description:
      "Detected if the Stargate is the FIRST tech building (built before any Twilight Council / Dark Shrine / Robotics Facility), a Fleet Beacon is up by 10:00, and at least 1 Tempest has been produced by 10:00 -- long-range Tempest harass / siege opened off a Stargate.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - DT Opener",
    description:
      "Detected if a Dark Shrine is the player's primary alternative-tech path -- built BEFORE any Stargate / Robotics Facility -- with at least 1 real Dark Templar on the field by 9:00. Pure ordering, no time threshold: a slow Shrine with no earlier Stargate / Robo still counts. (Twilight Council is required as Dark Shrine's prereq, so a Twilight-first ordering is implicit and isn't checked separately.) Catches DT openers that transition to mid- or late-game tech (Skytoss / Mothership / Templar) -- without this rule a DT build that later picked up a Stargate + Carrier used to mis-fire as PvZ - Carrier Rush.",
  },
];
