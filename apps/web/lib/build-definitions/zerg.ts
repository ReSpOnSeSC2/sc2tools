import type { BuildDefinition } from "../build-definitions";

export const ZERG_DEFINITIONS: ReadonlyArray<Omit<BuildDefinition, "id">> = [
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - 1 Base Roach Rush",
    description:
      "Detected if a Roach Warren is built off 1 base very early (< 3:40).",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - 12 Pool",
    description:
      "Detected if Spawning Pool starts < 50s and NO new drones were built (Strict 12 Supply).",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - 13/12 Baneling Bust",
    description:
      "Early pool and early gas (<70s) leading into Baneling Nest before 3:20.",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - 13/12 Speedling Aggression",
    description: "Early pool and early gas (<70s) for aggressive speedlings.",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - 17 Hatch 18 Gas 17 Pool",
    description:
      "Standard modern Zerg macro opener (Hatch < 85s, Gas < 95s, Pool < 105s).",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - 2 Base Muta Rush",
    description: "Detected if a Spire is started before 7:00 with low drone count.",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - 2 Base Nydus",
    description: "Detected if a Nydus Network is built before 7:00.",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - 2 Base Roach/Ravager All-in",
    description:
      "Detected if Roach Warren exists, Lair exists, high Roaches/Ravagers count, low drone count (< 40) off 2 bases.",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - 3 Base Macro (Hatch First)",
    description:
      "Standard safe Zerg macro reaching 3 bases by 6:30 off a Hatch First.",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - 3 Base Macro (Pool First)",
    description:
      "Standard safe Zerg macro reaching 3 bases by 6:30 off a Pool First.",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - 3 Hatch Before Pool",
    description: "Detected if a 3rd Hatchery is started before the Spawning Pool.",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - 3 Hatch Ling Flood",
    description: "Detected 3 bases but >20 lings and <30 drones by 5:00.",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - Early Pool (14/14 or 15 Pool)",
    description:
      "Detected if Spawning Pool starts < 1:10 but drones were built.",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - Hydra Comp",
    description: "Mid/Late game composition fallback featuring Hydralisks.",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - Muta/Ling/Bane Comp",
    description:
      "Mid/Late game composition fallback based on Mutalisks and Banelings.",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - Pool First Opener",
    description:
      "Generic Pool first opener that transitions into standard macro.",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - Proxy Hatch",
    description:
      "Detected if a hatchery being built on the opponents side of the map within the first 4:30.",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - Roach/Ravager Comp",
    description:
      "Mid/Late game composition fallback heavily focused on Roaches and Ravagers.",
  },
  {
    race: "Zerg",
    matchup: null,
    name: "Zerg - Standard Play (Unclassified)",
    description: "Catch-all for unclassified Zerg games.",
  },
];
