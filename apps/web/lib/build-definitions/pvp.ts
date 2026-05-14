import type { BuildDefinition } from "../build-definitions";

export const PVP_DEFINITIONS: ReadonlyArray<Omit<BuildDefinition, "id">> = [
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - 1 Gate Expand",
    description:
      "PvP standard 1-gate expand: exactly 1 Gateway finished before the natural Nexus (which goes down before 5:00) and the first warp-in is a Stalker / Adept / Zealot.",
  },
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - 1 Gate Nexus into 4 Gate",
    description:
      "Detected if exactly 1 Gateway is started before the natural Nexus (which goes down before 5:00), 4+ Gateways exist by 6:00, the first warp-in is a Stalker / Adept / Zealot (NOT Sentry), no tech building (Stargate / Robotics Facility / Twilight Council / Templar Archive / Dark Shrine) is started before the 4th Gateway, and Warp Gate research begins by 5:30 -- the 1 Gate Nexus into 4 Gate Stalker timing.",
  },
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - 2 Gate Expand",
    description:
      "PvP safer 2-gate expand: 2 (or more) Gateways are started before the natural Nexus (which goes down before 5:00) AND no tech building (Stargate, Robotics Facility, or Twilight Council) is started before the natural. A Stargate / Robo / Twilight before the natural means it is a tech-first opener, not a pure 2-gate expand. Trades a few seconds of economy for protection vs proxy 2-gate / early aggression.",
  },
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - 4 Stalker Oracle into DT",
    description:
      "Detected if 3+ Stalkers by 6:30, 1+ Oracle by 7:30, and a Dark Shrine is built by 9:00 -- Stalker / Oracle harass transitioning into Dark Templar.",
  },
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - AlphaStar (4 Adept/Oracle)",
    description:
      "Detected if a Stargate is built, 4+ Adepts have been produced by 6:00 AND 1+ Oracle is on the field by 6:30 -- the AlphaStar 4-Adept / Oracle pressure opener. Hallucinated Oracles from a Sentry do not count.",
  },
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - Blink Stalker Style",
    description:
      "Detected if Blink is researched by 9:00, the player has expanded (2+ Nexuses), and they have between 2 and 4 Gateways by 9:00 -- a macro Blink Stalker game.",
  },
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - Macro Transition (Unclassified)",
    description:
      "PvP catch-all: the game reached the macro phase but did not match a more specific PvP pattern.",
  },
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - Phoenix Style",
    description:
      "Detected if a Stargate is built and 3+ Phoenix have been produced by 8:30 -- an air-control / Phoenix-heavy PvP style. Hallucinated Phoenix from Sentries do not count.",
  },
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - Proxy 2 Gate",
    description:
      "Detected if a Gateway is built before 4:30 within 50 units of the OPPONENT's main base -- a proxied 2-Gate aggression.",
  },
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - Proxy Robo Opener",
    description:
      "Detected if a Robotics Facility is built before 6:30 within 50 units of the OPPONENT's main base -- a proxied Robo (Immortal / Warp Prism) opener.",
  },
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - Rail's Blink Stalker (Robo 1st)",
    description:
      "Detected if Robotics Facility goes down BEFORE Twilight Council and BOTH go down before the natural Nexus -- a Robo-first Blink Stalker style.",
  },
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - Standard Stargate Opener",
    description:
      "Detected if a Stargate is built before 6:30 in the player's own base (not proxied) -- the standard Stargate (Oracle / Phoenix) PvP opener.",
  },
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - Strange's 1 Gate Expand",
    description:
      "PvP 1-gate expand variant where exactly 1 Gateway is built before the natural Nexus and the first warp-in is a Sentry.",
  },
];
