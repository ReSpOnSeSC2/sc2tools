import type { BuildDefinition } from "../build-definitions";

export const PVZ_DEFINITIONS: ReadonlyArray<Omit<BuildDefinition, "id">> = [
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - 2 Stargate Phoenix",
    description:
      "Detected if the Stargate is the FIRST tech building (built before any Twilight Council / Dark Shrine / Robotics Facility), EXACTLY 2 Stargates and 2+ Nexuses are up by 10:00, 4+ Phoenix have been produced by 10:00 (Phoenix without a Stargate are ignored as hallucinations), AND the build did NOT commit to a tech-switch -- Glaives was NOT the first Twilight upgrade AND no Robotics Facility was built by 10:00. 3+ Stargates falls under PvZ - 3 Stargate Phoenix instead. A Stargate-into-Glaives hybrid (Phoenix as Glaive Adept support) tags as PvZ - Stargate into Glaives; a Stargate-into-Robo hybrid (Phoenix + Robo for Immortal / Observer / Disruptor) tags as PvZ - Stargate into Robo. The Glaives-first signal and the Robo presence are both strong intent markers -- the Phoenix count alone isn't enough to claim the pure 2 SG Phoenix label.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - 2 Stargate Void Ray",
    description:
      "Detected if the Stargate is the FIRST tech building (built before any Twilight Council / Dark Shrine / Robotics Facility), 2+ Stargates and 2+ Nexuses are up by 10:00, 4+ Void Rays have been produced by 10:00 (Void Rays without a Stargate are ignored as hallucinations), AND the build did NOT commit to a tech-switch -- Glaives was NOT the first Twilight upgrade AND no Robotics Facility was built before 6:00. A 4+ Void Ray commitment that adds a LATER Robo (after 6:00) for Observer / Immortal support still counts as Void Ray; only an EARLY Robo (before 6:00) reroutes to PvZ - Stargate into Robo. A Stargate-into-Glaives hybrid tags as PvZ - Stargate into Glaives.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - 3 Stargate Phoenix",
    description:
      "Detected if the Stargate is the FIRST tech building (built before any Twilight Council / Dark Shrine / Robotics Facility), 3+ Stargates and 2+ Nexuses are up by 10:00, 4+ Phoenix have been produced by 10:00 (Phoenix without a Stargate are ignored as hallucinations), AND the build did NOT commit to a tech-switch -- Glaives was NOT the first Twilight upgrade AND no Robotics Facility was built by 10:00. A Stargate-into-Glaives hybrid tags as PvZ - Stargate into Glaives; a Stargate-into-Robo hybrid tags as PvZ - Stargate into Robo.",
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
      "Detected if the Stargate is the FIRST tech building, followed by the third Nexus and then a Robotics Facility that begins by 5:30 and before any Twilight Council, with 2+ Oracles plus a Forge present by 8:30 -- the AlphaStar Oracle / fast-third / fast-Robo composition. A missing or later Robo is not AlphaStar and falls to the matching Blink-, Charge-, or Resonating-Glaives-first transition.",
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
      "Detected if a Stargate opener is followed by a third Nexus by 9:00 (the third starts before Twilight or within four minutes after it), Blink is the FIRST Twilight upgrade and completes by 10:00, and any Robotics Facility follows the Twilight -- standard 3-base Blink macro rather than AlphaStar.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - Standard charge Macro",
    description:
      "Detected if a Stargate opener is followed by a third Nexus by 9:00 (the third starts before Twilight or within four minutes after it), Charge is the FIRST Twilight upgrade and completes by 9:00, and any Robotics Facility follows the Twilight -- standard 3-base Chargelot macro rather than AlphaStar.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - Stargate into Glaives",
    description:
      "Detected if a Stargate is the FIRST tech building, Twilight Council is added before any Robotics Facility, and the FIRST Twilight upgrade is Resonating Glaives (completed BEFORE Blink and Charge) -- a Stargate opener into Glaive Adepts. Classification is order-based with no Gateway-count window: a Robo added after Twilight is support and cannot steal the Glaives label, while Robo-before-Twilight remains AlphaStar or Stargate into Robo.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - Adept Glaives (No Robo)",
    description:
      "Detected if the Twilight Council is the FIRST tech building after the Cybernetics Core (no Stargate, Robotics Facility, or Dark Shrine is started before Twilight -- pure ordering, no time threshold, so a slow Twilight with nothing else committed first still qualifies), the FIRST upgrade researched out of the Twilight Council is Resonating Glaives (Glaives starts BEFORE Blink and BEFORE Charge), 4-8 Gateways exist by 6:00, AND no Robotics Facility is built -- a pure Gateway Adept Glaive Timing without Robo support.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - Adept Glaives (Robo)",
    description:
      "Detected if the Twilight Council is the FIRST tech building after the Cybernetics Core (no Stargate, Robotics Facility, or Dark Shrine is started before Twilight -- pure ordering, no time threshold), the FIRST upgrade researched out of the Twilight Council is Resonating Glaives (Glaives starts BEFORE Blink and BEFORE Charge), 4-8 Gateways exist by 6:00, AND a Robotics Facility is built (after Twilight, as Observer / Immortal support) -- the Robo variant of Adept Glaive Timing.",
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
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - Stargate into Robo",
    description:
      "Detected if the Stargate is the FIRST tech building, at least 1 real Phoenix / Oracle / Void Ray is on the field by 10:00, and a Robotics Facility is built by 10:00. This is the generic Stargate-into-Robo transition only when a clearer three-base Twilight path is absent: Twilight-then-Glaives before the Robo uses PvZ - Stargate into Glaives, while a three-base Twilight build whose first upgrade is Blink or Charge keeps its Standard Blink / Charge Macro label even if a support Robo is added later. Twilight may precede the third only when that Nexus follows within four minutes.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - Stargate Opener",
    description:
      "Catch-all for any Stargate-first opener (Stargate built BEFORE any Twilight Council / Dark Shrine / Robotics Facility) that didn't match a more specific Stargate-prefixed PvZ rule -- Carrier Rush, Tempest Rush, 2/3 Stargate Phoenix, 2 Stargate Void Ray, AlphaStar Style, Stargate into Robo, Stargate into Glaives, Standard Blink Macro, Standard charge Macro, Archon Drop. Examples that land here: a Stargate that got harassed off before producing a real unit, a Stargate-into-Templar build without 2 Archons by 9:00, or any Stargate opener with an unusual midgame composition the analyzer doesn't have a named bucket for. Mirror of PvT - Stargate Opener.",
  },
];
