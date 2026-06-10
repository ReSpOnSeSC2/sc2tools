/**
 * Seed openings — canonical starting points for the evolutionary
 * search, rebuilt for the 8-worker patch. Seeds don't need perfect
 * supply timing (the engine's auto-supply covers gaps and mutation
 * retunes them); they exist so the search starts from real openings
 * instead of random noise.
 *
 * Workers are produced by the autoWorkers policy, so seeds list only
 * structures, army, tech, and mechanics actions.
 */
import type { BuildAction, SimRace } from "../types";

const A = (
  kind: BuildAction["kind"],
  name: string,
  target?: string,
): BuildAction => ({ kind, name, target });

const PROTOSS_SEEDS: BuildAction[][] = [
  // Gate expand — the standard macro opening
  [
    A("build", "Pylon"),
    A("build", "Gateway"),
    A("build", "Assimilator"),
    A("train", "Zealot"),
    A("build", "Nexus"),
    A("build", "CyberneticsCore"),
    A("train", "Stalker"),
    A("build", "ShieldBattery"),
  ],
  // Defensive gate expand: forge + cannon cover before the nexus
  [
    A("build", "Pylon"),
    A("build", "Gateway"),
    A("build", "Forge"),
    A("train", "Zealot"),
    A("build", "PhotonCannon"),
    A("build", "Nexus"),
    A("build", "Assimilator"),
    A("build", "CyberneticsCore"),
  ],
  // 2-gate defensive opening into expand
  [
    A("build", "Pylon"),
    A("build", "Gateway"),
    A("build", "Gateway"),
    A("train", "Zealot"),
    A("train", "Zealot"),
    A("chrono", "Gateway"),
    A("train", "Zealot"),
    A("build", "Nexus"),
    A("build", "Assimilator"),
  ],
  // Warpgate-rework tech opening (research now lives on the gateway)
  [
    A("build", "Pylon"),
    A("build", "Gateway"),
    A("build", "Assimilator"),
    A("research", "WarpGateResearch"),
    A("train", "Zealot"),
    A("build", "CyberneticsCore"),
    A("train", "Stalker"),
    A("build", "Nexus"),
  ],
];

const TERRAN_SEEDS: BuildAction[][] = [
  // Reaper expand
  [
    A("build", "SupplyDepot"),
    A("build", "Barracks"),
    A("build", "Refinery"),
    A("train", "Reaper"),
    A("morph", "OrbitalCommand"),
    A("build", "CommandCenter"),
    A("train", "Marine"),
    A("build", "Bunker"),
  ],
  // Defensive 1-rax marine + bunker expand
  [
    A("build", "SupplyDepot"),
    A("build", "Barracks"),
    A("train", "Marine"),
    A("morph", "OrbitalCommand"),
    A("train", "Marine"),
    A("build", "Bunker"),
    A("build", "CommandCenter"),
    A("train", "Marine"),
  ],
  // 2-rax pressure-safe opening
  [
    A("build", "SupplyDepot"),
    A("build", "Barracks"),
    A("train", "Marine"),
    A("build", "Barracks"),
    A("morph", "OrbitalCommand"),
    A("train", "Marine"),
    A("train", "Marine"),
    A("build", "Bunker"),
    A("build", "CommandCenter"),
  ],
];

const ZERG_SEEDS: BuildAction[][] = [
  // Hatch first — the greedy line
  [
    A("build", "Hatchery"),
    A("build", "SpawningPool"),
    A("build", "Extractor"),
    A("train", "Queen"),
    A("train", "Zergling"),
    A("train", "Queen"),
  ],
  // Pool first defensive
  [
    A("build", "SpawningPool"),
    A("build", "Extractor"),
    A("train", "Queen"),
    A("train", "Zergling"),
    A("train", "Zergling"),
    A("build", "Hatchery"),
    A("build", "SpineCrawler"),
  ],
  // Pool + speed pressure-absorber into expand
  [
    A("build", "SpawningPool"),
    A("build", "Extractor"),
    A("research", "MetabolicBoost"),
    A("train", "Queen"),
    A("train", "Zergling"),
    A("train", "Zergling"),
    A("build", "Hatchery"),
    A("train", "Queen"),
  ],
];

export function seedsForRace(race: SimRace): BuildAction[][] {
  switch (race) {
    case "Protoss":
      return PROTOSS_SEEDS.map((s) => s.map((a) => ({ ...a })));
    case "Terran":
      return TERRAN_SEEDS.map((s) => s.map((a) => ({ ...a })));
    case "Zerg":
      return ZERG_SEEDS.map((s) => s.map((a) => ({ ...a })));
  }
}

/**
 * Pool of actions the mutation operator may insert, per race —
 * defense, army, tech, economy, and mechanics. Names must exist in
 * the patch profile.
 */
export function insertableActions(race: SimRace): BuildAction[] {
  switch (race) {
    case "Protoss":
      return [
        A("build", "Pylon"),
        A("build", "Gateway"),
        A("build", "Assimilator"),
        A("build", "Forge"),
        A("build", "PhotonCannon"),
        A("build", "ShieldBattery"),
        A("build", "CyberneticsCore"),
        A("build", "Nexus"),
        A("build", "TwilightCouncil"),
        A("build", "RoboticsFacility"),
        A("build", "Stargate"),
        A("train", "Zealot"),
        A("train", "Adept"),
        A("train", "Stalker"),
        A("train", "Sentry"),
        A("train", "Oracle"),
        A("research", "WarpGateResearch"),
        A("chrono", "Gateway"),
        A("transform-warpgate", "Gateway"),
      ];
    case "Terran":
      return [
        A("build", "SupplyDepot"),
        A("build", "Barracks"),
        A("build", "Refinery"),
        A("build", "Bunker"),
        A("build", "EngineeringBay"),
        A("build", "MissileTurret"),
        A("build", "Factory"),
        A("build", "Starport"),
        A("build", "CommandCenter"),
        A("build", "BarracksTechLab"),
        A("build", "BarracksReactor"),
        A("train", "Marine"),
        A("train", "Marauder"),
        A("train", "Reaper"),
        A("train", "Cyclone"),
        A("train", "Viking"),
        A("morph", "OrbitalCommand"),
      ];
    case "Zerg":
      return [
        A("build", "Hatchery"),
        A("build", "SpawningPool"),
        A("build", "Extractor"),
        A("build", "SpineCrawler"),
        A("build", "SporeCrawler"),
        A("build", "RoachWarren"),
        A("build", "BanelingNest"),
        A("train", "Queen"),
        A("train", "Zergling"),
        A("train", "Roach"),
        A("train", "Overlord"),
        A("research", "MetabolicBoost"),
        A("morph", "Lair"),
      ];
  }
}
