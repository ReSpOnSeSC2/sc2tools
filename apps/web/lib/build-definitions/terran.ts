import type { BuildDefinition } from "../build-definitions";

export const TERRAN_DEFINITIONS: ReadonlyArray<Omit<BuildDefinition, "id">> = [
  {
    race: "Terran",
    matchup: null,
    name: "Terran - 1-1-1 One Base",
    description:
      "Detected if a Factory (before 6:30) and Starport (before 8:10) are both built BEFORE the second Command Center -- a 1-base 1-Rax / 1-Fact / 1-Port pressure build, not the standard expanding 1-1-1.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - 1-1-1 Standard",
    description:
      "Detected if Factory (before 6:30) and Starport (before 8:10) are built and they are after the second CC.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - 2 Gas 3 Reaper 2 Hellion",
    description: "Detected if 2 Gas, 3 Reapers, and 2 Hellions before 5:30.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - 2-3 Rax Reaper rush",
    description:
      "Detected if 3+ Barracks exist before 6:30 off a single Command Center, no Refineries, and 2+ Reapers have been produced before 6:30 -- early Reaper-heavy aggression.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - 3 Rax",
    description:
      "Detected if 3 Barracks are built after second CC but before any other tech buildings.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - 3-4 Rax Marine rush",
    description:
      "Detected if 3+ Barracks exist before 6:30 off a single Command Center with NO Refineries -- a gas-less, Marine-only mass-Rax all-in.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - BC Rush",
    description: "Detected if a Fusion Core is built before 6:30.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - Banshee Rush",
    description:
      "Detected if a Banshee and Cloak or Hyper Flight Rotors exists before 7:30.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - Bio Comp",
    description:
      "Mid/Late game composition fallback based on heavy Barracks production.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - Cyclone Rush",
    description:
      "Detected if Factory with Tech Lab and Cyclones are built early (< 5:30).",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - Fast 3 CC",
    description:
      "Detected if 3 Command Centers exist before 7:00 (Counting only construction, ignoring Orbitals).",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - Ghost Rush",
    description:
      "Detected if Ghost Academy is built within first 6:30 of the game.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - Hellbat All-in",
    description:
      "Detected if Armory is built early (< 5:00) with high Hellion/Hellbat count.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - Mech Comp",
    description:
      "Mid/Late game composition fallback based on heavy Factory production.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - Proxy 1-1-1",
    description:
      "Detected if Factory (before 6:30) and Starport (before 8:10) and are built away from their base.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - Proxy Starport Hellion Drop",
    description:
      "Detected if a Factory and Starport are built away from the main base, the player has expanded (2nd Command Center started), 2+ Hellions are produced by 6:00, and the FIRST unit produced from the Starport is a Medivac -- an expanding proxy Starport build that uses a Medivac to ferry Hellions into the opponent's mineral line (Yoon-style Hellion drop). Differs from Proxy 1-1-1 by the 2nd CC and the Medivac-first opener.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - Proxy Rax",
    description: "Detected if Barracks are built far from the main base before 4:30.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - SkyTerran",
    description:
      "Mid/Late game composition fallback based on heavy Starport production.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - Standard Bio Tank",
    description:
      "Detected if 3 CCs, Engineering Bays, and Tanks/Medivacs are present.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - Standard Play (Unclassified)",
    description: "Catch-all for unclassified Terran games.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - Widow Mine Drop",
    description:
      "Detected if Medivac and multiple widow mines are built after second CC within the first 6:30.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - Widow Mine Drop into Thor Rush",
    description:
      "Detected if a Medivac and 2+ Widow Mines are built AFTER the second Command Center (within ~6:30), and a Thor has been produced before ~8:10 -- a Mine drop transitioning into Thor pressure.",
  },
  {
    race: "Terran",
    matchup: null,
    name: "Terran - Widow Upgraded Mine Cheese",
    description:
      "Detected if a Medivac and 2+ Widow Mines are built BEFORE the second Command Center -- a 1-base Widow Mine drop cheese.",
  },
];
