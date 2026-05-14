import type { BuildDefinition } from "../build-definitions";

export const PVZ_DEFINITIONS: ReadonlyArray<Omit<BuildDefinition, "id">> = [
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - 2 Stargate Phoenix",
    description:
      "Detected if EXACTLY 2 Stargates and 2+ Nexuses by 10:00, plus 4+ Phoenix produced by 10:00 (Phoenix without a Stargate are ignored as hallucinations). 3+ Stargates falls under PvZ - 3 Stargate Phoenix instead -- the two rules are mutually exclusive on Stargate count.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - 2 Stargate Void Ray",
    description:
      "Detected if 2+ Stargates and 2+ Nexuses by 10:00, plus 4+ Void Rays produced by 10:00 (Void Rays without a Stargate are ignored as hallucinations).",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - 3 Stargate Phoenix",
    description:
      "Detected if 3+ Stargates and 2+ Nexuses by 10:00, plus 4+ Phoenix produced by 10:00 (Phoenix without a Stargate are ignored as hallucinations).",
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
      "Detected if a Stargate is built, 2+ Oracles plus a Robotics Facility plus a Forge are all in place by 8:30, with 3+ Nexuses by 8:30 -- the AlphaStar Oracle / Robo / fast 3rd composition.",
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
      "Detected if a Stargate AND a Fleet Beacon are built and at least 1 Carrier has been produced by 10:00 -- skytoss into Carriers. Carriers without a Stargate + Fleet Beacon are treated as hallucinations.",
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
      "Detected if a Robotics Facility is built before 7:00 AND it is the FIRST tech building (built before any Stargate or Twilight Council).",
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
      "Detected if a Stargate is built before 7:00 (and before any Twilight Council), the FIRST upgrade researched out of the Twilight Council is Resonating Glaives (Glaives starts BEFORE Blink and BEFORE Charge), and the player has 4-8 Gateways by 9:00 -- a Phoenix or Oracle into Glaive Adept timing. The Glaives-first signal is what separates this from Stargate into Blink, where Blink would be researched first instead.",
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
      "Detected if a Stargate AND a Fleet Beacon are built and at least 1 Tempest has been produced by 10:00 -- long-range Tempest harass / siege.",
  },
];
