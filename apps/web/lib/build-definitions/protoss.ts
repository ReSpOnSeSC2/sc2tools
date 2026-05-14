import type { BuildDefinition } from "../build-definitions";

export const PROTOSS_DEFINITIONS: ReadonlyArray<Omit<BuildDefinition, "id">> = [
  {
    race: "Protoss",
    matchup: null,
    name: "Protoss - 4 Gate Rush",
    description:
      "Detected if 4 Gateways exist before 6:00 and before the 2nd Nexus.",
  },
  {
    race: "Protoss",
    matchup: null,
    name: "Protoss - Blink All-In",
    description:
      "3 or 4 Gateways have been made along with Blink before 6:30 without a second Nexus.",
  },
  {
    race: "Protoss",
    matchup: null,
    name: "Protoss - Cannon Rush",
    description:
      "Detected if a Photon Cannon is built near your base (Proxy) before 4:30.",
  },
  {
    race: "Protoss",
    matchup: null,
    name: "Protoss - Chargelot All-in",
    description:
      "Detected if Charge is researched, 7+ Gates, and low gas count.",
  },
  {
    race: "Protoss",
    matchup: null,
    name: "Protoss - Chargelot/Archon Comp",
    description:
      "Mid/Late game composition fallback based on Archons and Chargelots.",
  },
  {
    race: "Protoss",
    matchup: null,
    name: "Protoss - DT Rush",
    description: "Detected if a Dark Shrine is built before 7:30.",
  },
  {
    race: "Protoss",
    matchup: null,
    name: "Protoss - Glaive Adept Timing",
    description:
      "Detected if Twilight Council + Glaives researched + High Adept count by 6:30.",
  },
  {
    race: "Protoss",
    matchup: null,
    name: "Protoss - Proxy 4 Gate",
    description:
      "Detected if 3+ Gateways are built far from the main base before 4:30.",
  },
  {
    race: "Protoss",
    matchup: null,
    name: "Protoss - Proxy Robo Opener",
    description:
      "Detected if a Robo is built away from the opponents base before 6:30.",
  },
  {
    race: "Protoss",
    matchup: null,
    name: "Protoss - Proxy Stargate Opener",
    description:
      "Detected if a Stargate is built away from the opponents base before 6:30.",
  },
  {
    race: "Protoss",
    matchup: null,
    name: "Protoss - Robo Comp",
    description:
      "Mid/Late game composition fallback based on Colossi or Disruptors.",
  },
  {
    race: "Protoss",
    matchup: null,
    name: "Protoss - Robo Opener",
    description: "Detected if a Robotics Facility is built before 6:30.",
  },
  {
    race: "Protoss",
    matchup: null,
    name: "Protoss - Skytoss Transition",
    description:
      "Mid/Late game composition fallback based on multiple Stargates or Carriers.",
  },
  {
    race: "Protoss",
    matchup: null,
    name: "Protoss - Standard Expand",
    description: "Detected if the 2nd Nexus starts before 6:30.",
  },
  {
    race: "Protoss",
    matchup: null,
    name: "Protoss - Standard Macro (CIA)",
    description:
      "Detected if Protoss has 3 Bases and Charge/Immortal/Archon tech path.",
  },
  {
    race: "Protoss",
    matchup: null,
    name: "Protoss - Standard Play (Unclassified)",
    description: "Catch-all for unclassified Protoss games.",
  },
  {
    race: "Protoss",
    matchup: null,
    name: "Protoss - Stargate Opener",
    description: "Detected if a Stargate is built before 6:30.",
  },
];
