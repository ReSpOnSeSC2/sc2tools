import type { BuildDefinition } from "../build-definitions";

export const PVP_DEFINITIONS: ReadonlyArray<Omit<BuildDefinition, "id">> = [
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - 1 Gate Expand",
    description:
      "PvP standard 1-gate expand: exactly 1 Gateway started before the natural Nexus (which goes down before 5:00), the first warp-in is a Stalker / Adept / Zealot, and no Stargate / Robotics Facility / Twilight Council was started before the natural. Tech before the natural makes it a tech-first opener (Standard Stargate Opener, Robo Opener, Rail's Blink Stalker, ...); the 1 Gate Expand label is kept only when no tech rule recognises the game.",
  },
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - 1 Gate Nexus into 4 Gate",
    description:
      "Detected if exactly 1 Gateway is started before the natural Nexus (which goes down before 5:00), 4+ Gateways exist by 6:00, the first warp-in is a Stalker / Adept / Zealot (NOT Sentry), no tech building (Stargate / Robotics Facility / Twilight Council / Templar Archive / Dark Shrine) is started before the 4th Gateway, and Warp Gate research finishes by 5:30 -- the 1 Gate Nexus into 4 Gate Stalker timing.",
  },
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - 2 Gate Expand",
    description:
      "PvP safer 2-gate expand: 2 (or more) Gateways are started before the natural Nexus (which goes down before 5:00) AND no tech building (Stargate, Robotics Facility, or Twilight Council) is started before the natural. A Stargate / Robo / Twilight before the natural means it is a tech-first opener (Standard Stargate Opener, Robo Opener, ...); the 2 Gate Expand label is kept only when no tech rule recognises the game. Trades a few seconds of economy for protection vs proxy 2-gate / early aggression.",
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
      "Detected if a Gateway is started by 1:45 more than 50 units from the player's own main (a proxy) and no natural Nexus is started before 4:30 -- a proxied 2-Gate / 3-Gate aggression. Timing is what separates it from the other forward builds: a true proxy 2-Gate's Gateways go down between ~0:30 and ~1:15 (1:45 leaves a margin), while a proxy Robo proxies at ~2:00-3:00 and a 3-4 Gate (Warp Gate) build with a forward Gateway places it in that same band -- neither counts.",
  },
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - Proxy Robo Opener",
    description:
      "Detected if a Robotics Facility is started before 6:30 more than 50 units from the player's own main (a proxy) -- a proxied Robo (Immortal / Warp Prism) opener. The forward Gateway dropped beside the Robo (~2:00-3:00) is far later than a proxy 2-Gate's Gateways (~0:30-1:15), so it no longer tags the game as Proxy 2 Gate.",
  },
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - Proxy Stargate Opener",
    description:
      "Detected if a Stargate is started before 6:30 more than 50 units from the player's own main (a proxy) -- a proxied Stargate (Void Ray / Oracle) PvP opener, the PvP counterpart of PvT - Proxy Void Ray/Stargate.",
  },
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - Robo into Glaives",
    description:
      "Detected if a Robotics Facility is built BEFORE the Twilight Council and the FIRST upgrade researched out of that Twilight Council is Resonating Glaives (Glaives starts BEFORE Blink and BEFORE Charge) -- the common PvP Robo (Immortal / Observer) opening into a Glaive Adept timing. Classification is purely order-based: the Glaives-first signal is what separates this from Rail's Blink Stalker (Robo 1st), where Blink would be the upgrade instead.",
  },
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - Adept Glaives",
    description:
      "Detected if the Twilight Council is the FIRST tech building (built before any Robotics Facility AND any Stargate -- pure ordering, no time threshold) and the FIRST upgrade researched out of it is Resonating Glaives (Glaives starts BEFORE Blink and BEFORE Charge) -- a pure Gateway Adept Glaive timing. The Glaives-first signal separates it from Blink Stalker Style, where Blink would be researched first.",
  },
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - Rail's Blink Stalker (Robo 1st)",
    description:
      "Detected if Robotics Facility goes down BEFORE Twilight Council, BOTH go down before the natural Nexus, and Blink is researched by 9:00 -- a Robo-first Blink Stalker style. A Robo-first build whose FIRST Twilight upgrade is Glaives tags as PvP - Robo into Glaives instead; a Robo-first build without Blink is the PvP - Robo Opener.",
  },
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - Robo Opener",
    description:
      "Detected if a Robotics Facility in the player's own base is the FIRST tech building (before any Stargate and Twilight Council -- pure ordering, no time threshold) and no more specific Robo label applies (Proxy Robo Opener, Robo into Glaives, Rail's Blink Stalker) -- the standard Robo-first (Immortal / Observer) PvP opener.",
  },
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - Standard Stargate Opener",
    description:
      "Detected if a Stargate is built before 6:30 in the player's own base (not proxied) and is the FIRST tech building (before any Robotics Facility / Twilight Council) -- the standard Stargate (Oracle / Phoenix) PvP opener.",
  },
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - Strange's 1 Gate Expand",
    description:
      "PvP 1-gate expand variant where exactly 1 Gateway is started before the natural Nexus (which goes down before 5:00), the first warp-in is a Sentry, and no Stargate / Robotics Facility / Twilight Council was started before the natural (tech before the natural is a tech-first opener; this label is kept only when no tech rule recognises the game).",
  },
];
