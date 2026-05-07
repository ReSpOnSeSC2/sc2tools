/**
 * SC2 unit catalog — mineral / gas / supply costs and classification flags.
 *
 * Used by the macro-breakdown chart to compute army-value (Σ minerals+gas
 * across all alive non-worker, non-building units) and by the unit
 * composition snapshot below the chart. Costs match the live LotV
 * balance patch as of 5.0.x — they're game constants, no per-replay
 * variation, so the table is hand-maintained against Liquipedia.
 *
 * Names use the canonical sc2reader form (PascalCase, no spaces). Aliases
 * cover sc2reader's morph/burrow variants so the lookup is resilient
 * regardless of which morph step the tracker emitted.
 */

export interface UnitCost {
  /** Mineral cost. */
  m: number;
  /** Vespene gas cost. */
  g: number;
  /** Supply consumed (drops to 0 for buildings; halves for some morphs). */
  s: number;
  /** Worker units (Drone/Probe/SCV/MULE) — excluded from army value. */
  isWorker?: boolean;
  /** Buildings — excluded from army value. */
  isBuilding?: boolean;
  /** Race classification. */
  race?: "Zerg" | "Protoss" | "Terran" | "Neutral";
}

const Z = "Zerg" as const;
const P = "Protoss" as const;
const T = "Terran" as const;

/**
 * Canonical name → cost. Lookup goes through ``getUnitCost`` so callers
 * don't need to memorise alias forms (BurrowedX, UprootedX, etc.).
 */
const UNIT_COSTS: Record<string, UnitCost> = {
  // Workers
  Drone: { m: 50, g: 0, s: 1, isWorker: true, race: Z },
  Probe: { m: 50, g: 0, s: 1, isWorker: true, race: P },
  SCV: { m: 50, g: 0, s: 1, isWorker: true, race: T },
  MULE: { m: 0, g: 0, s: 0, isWorker: true, race: T },

  // Zerg supply / detection / utility
  Overlord: { m: 100, g: 0, s: 0, race: Z },
  OverlordTransport: { m: 100, g: 0, s: 0, race: Z },
  Overseer: { m: 50, g: 50, s: 0, race: Z },
  OverseerSiegeMode: { m: 50, g: 50, s: 0, race: Z },
  Larva: { m: 0, g: 0, s: 0, race: Z },
  Egg: { m: 0, g: 0, s: 0, race: Z },
  Broodling: { m: 0, g: 0, s: 0, race: Z },
  Locust: { m: 0, g: 0, s: 0, race: Z },
  LocustMP: { m: 0, g: 0, s: 0, race: Z },
  LocustMPFlying: { m: 0, g: 0, s: 0, race: Z },
  Changeling: { m: 0, g: 0, s: 0, race: Z },

  // Zerg army
  Zergling: { m: 25, g: 0, s: 0.5, race: Z },
  Queen: { m: 150, g: 0, s: 2, race: Z },
  Baneling: { m: 25, g: 25, s: 0.5, race: Z },
  Roach: { m: 75, g: 25, s: 2, race: Z },
  Ravager: { m: 25, g: 75, s: 1, race: Z },
  Hydralisk: { m: 100, g: 50, s: 2, race: Z },
  Lurker: { m: 50, g: 100, s: 1, race: Z },
  LurkerMP: { m: 50, g: 100, s: 1, race: Z },
  LurkerMPBurrowed: { m: 50, g: 100, s: 1, race: Z },
  Infestor: { m: 100, g: 150, s: 2, race: Z },
  SwarmHost: { m: 100, g: 75, s: 3, race: Z },
  SwarmHostMP: { m: 100, g: 75, s: 3, race: Z },
  Ultralisk: { m: 275, g: 200, s: 6, race: Z },
  Mutalisk: { m: 100, g: 100, s: 2, race: Z },
  Corruptor: { m: 150, g: 100, s: 2, race: Z },
  BroodLord: { m: 150, g: 150, s: 2, race: Z },
  Broodlord: { m: 150, g: 150, s: 2, race: Z },
  Viper: { m: 100, g: 200, s: 3, race: Z },
  NydusCanal: { m: 50, g: 50, s: 0, race: Z },
  NydusWorm: { m: 75, g: 75, s: 0, isBuilding: true, race: Z },

  // Protoss support
  WarpPrism: { m: 250, g: 0, s: 2, race: P },
  WarpPrismPhasing: { m: 250, g: 0, s: 2, race: P },
  Observer: { m: 25, g: 75, s: 1, race: P },
  ObserverSiegeMode: { m: 25, g: 75, s: 1, race: P },
  Interceptor: { m: 15, g: 0, s: 0, race: P },

  // Protoss army
  Zealot: { m: 100, g: 0, s: 2, race: P },
  Stalker: { m: 125, g: 50, s: 2, race: P },
  Sentry: { m: 50, g: 100, s: 2, race: P },
  Adept: { m: 100, g: 25, s: 2, race: P },
  AdeptPhaseShift: { m: 0, g: 0, s: 0, race: P },
  HighTemplar: { m: 50, g: 150, s: 2, race: P },
  DarkTemplar: { m: 125, g: 125, s: 2, race: P },
  Archon: { m: 100, g: 300, s: 4, race: P },
  Immortal: { m: 275, g: 100, s: 4, race: P },
  Colossus: { m: 300, g: 200, s: 6, race: P },
  Disruptor: { m: 150, g: 150, s: 3, race: P },
  DisruptorPhased: { m: 0, g: 0, s: 0, race: P },
  Phoenix: { m: 150, g: 100, s: 2, race: P },
  Oracle: { m: 150, g: 150, s: 3, race: P },
  OracleStasisTrap: { m: 0, g: 0, s: 0, race: P },
  VoidRay: { m: 250, g: 150, s: 4, race: P },
  Tempest: { m: 250, g: 175, s: 5, race: P },
  Carrier: { m: 350, g: 250, s: 6, race: P },
  Mothership: { m: 400, g: 400, s: 8, race: P },

  // Terran units
  Marine: { m: 50, g: 0, s: 1, race: T },
  Marauder: { m: 100, g: 25, s: 2, race: T },
  Reaper: { m: 50, g: 50, s: 1, race: T },
  Ghost: { m: 150, g: 125, s: 2, race: T },
  Hellion: { m: 100, g: 0, s: 2, race: T },
  Hellbat: { m: 100, g: 0, s: 2, race: T },
  HellionTank: { m: 100, g: 0, s: 2, race: T },
  WidowMine: { m: 75, g: 25, s: 2, race: T },
  WidowMineBurrowed: { m: 75, g: 25, s: 2, race: T },
  SiegeTank: { m: 150, g: 125, s: 3, race: T },
  SiegeTankSieged: { m: 150, g: 125, s: 3, race: T },
  Cyclone: { m: 150, g: 100, s: 3, race: T },
  Thor: { m: 300, g: 200, s: 6, race: T },
  ThorAP: { m: 300, g: 200, s: 6, race: T },
  Viking: { m: 150, g: 75, s: 2, race: T },
  VikingFighter: { m: 150, g: 75, s: 2, race: T },
  VikingAssault: { m: 150, g: 75, s: 2, race: T },
  Medivac: { m: 100, g: 100, s: 2, race: T },
  Liberator: { m: 150, g: 150, s: 3, race: T },
  LiberatorAG: { m: 150, g: 150, s: 3, race: T },
  Banshee: { m: 150, g: 100, s: 3, race: T },
  Raven: { m: 100, g: 200, s: 2, race: T },
  Battlecruiser: { m: 400, g: 300, s: 6, race: T },
  AutoTurret: { m: 0, g: 0, s: 0, race: T },
  PointDefenseDrone: { m: 0, g: 0, s: 0, race: T },

  // Buildings — Zerg
  Hatchery: { m: 300, g: 0, s: 0, isBuilding: true, race: Z },
  Lair: { m: 150, g: 100, s: 0, isBuilding: true, race: Z },
  Hive: { m: 200, g: 150, s: 0, isBuilding: true, race: Z },
  Extractor: { m: 25, g: 0, s: 0, isBuilding: true, race: Z },
  SpawningPool: { m: 200, g: 0, s: 0, isBuilding: true, race: Z },
  EvolutionChamber: { m: 75, g: 0, s: 0, isBuilding: true, race: Z },
  RoachWarren: { m: 150, g: 0, s: 0, isBuilding: true, race: Z },
  BanelingNest: { m: 100, g: 50, s: 0, isBuilding: true, race: Z },
  HydraliskDen: { m: 100, g: 100, s: 0, isBuilding: true, race: Z },
  LurkerDen: { m: 100, g: 150, s: 0, isBuilding: true, race: Z },
  LurkerDenMP: { m: 100, g: 150, s: 0, isBuilding: true, race: Z },
  InfestationPit: { m: 100, g: 100, s: 0, isBuilding: true, race: Z },
  Spire: { m: 200, g: 200, s: 0, isBuilding: true, race: Z },
  GreaterSpire: { m: 100, g: 150, s: 0, isBuilding: true, race: Z },
  UltraliskCavern: { m: 150, g: 200, s: 0, isBuilding: true, race: Z },
  NydusNetwork: { m: 150, g: 200, s: 0, isBuilding: true, race: Z },
  SpineCrawler: { m: 100, g: 0, s: 0, isBuilding: true, race: Z },
  SporeCrawler: { m: 75, g: 0, s: 0, isBuilding: true, race: Z },
  CreepTumor: { m: 0, g: 0, s: 0, isBuilding: true, race: Z },
  CreepTumorBurrowed: { m: 0, g: 0, s: 0, isBuilding: true, race: Z },
  CreepTumorQueen: { m: 0, g: 0, s: 0, isBuilding: true, race: Z },

  // Buildings — Protoss
  Nexus: { m: 400, g: 0, s: 0, isBuilding: true, race: P },
  Pylon: { m: 100, g: 0, s: 0, isBuilding: true, race: P },
  Assimilator: { m: 75, g: 0, s: 0, isBuilding: true, race: P },
  Gateway: { m: 150, g: 0, s: 0, isBuilding: true, race: P },
  WarpGate: { m: 150, g: 0, s: 0, isBuilding: true, race: P },
  Forge: { m: 150, g: 0, s: 0, isBuilding: true, race: P },
  CyberneticsCore: { m: 150, g: 0, s: 0, isBuilding: true, race: P },
  TwilightCouncil: { m: 150, g: 100, s: 0, isBuilding: true, race: P },
  RoboticsFacility: { m: 150, g: 100, s: 0, isBuilding: true, race: P },
  RoboticsBay: { m: 150, g: 150, s: 0, isBuilding: true, race: P },
  Stargate: { m: 150, g: 150, s: 0, isBuilding: true, race: P },
  FleetBeacon: { m: 300, g: 200, s: 0, isBuilding: true, race: P },
  TemplarArchives: { m: 150, g: 200, s: 0, isBuilding: true, race: P },
  TemplarArchive: { m: 150, g: 200, s: 0, isBuilding: true, race: P },
  DarkShrine: { m: 150, g: 150, s: 0, isBuilding: true, race: P },
  PhotonCannon: { m: 150, g: 0, s: 0, isBuilding: true, race: P },
  ShieldBattery: { m: 100, g: 0, s: 0, isBuilding: true, race: P },

  // Buildings — Terran
  CommandCenter: { m: 400, g: 0, s: 0, isBuilding: true, race: T },
  OrbitalCommand: { m: 150, g: 0, s: 0, isBuilding: true, race: T },
  PlanetaryFortress: { m: 150, g: 150, s: 0, isBuilding: true, race: T },
  CommandCenterFlying: { m: 0, g: 0, s: 0, isBuilding: true, race: T },
  OrbitalCommandFlying: { m: 0, g: 0, s: 0, isBuilding: true, race: T },
  SupplyDepot: { m: 100, g: 0, s: 0, isBuilding: true, race: T },
  SupplyDepotLowered: { m: 100, g: 0, s: 0, isBuilding: true, race: T },
  Refinery: { m: 75, g: 0, s: 0, isBuilding: true, race: T },
  RefineryRich: { m: 75, g: 0, s: 0, isBuilding: true, race: T },
  Barracks: { m: 150, g: 0, s: 0, isBuilding: true, race: T },
  BarracksFlying: { m: 0, g: 0, s: 0, isBuilding: true, race: T },
  EngineeringBay: { m: 125, g: 0, s: 0, isBuilding: true, race: T },
  Factory: { m: 150, g: 100, s: 0, isBuilding: true, race: T },
  FactoryFlying: { m: 0, g: 0, s: 0, isBuilding: true, race: T },
  Starport: { m: 150, g: 100, s: 0, isBuilding: true, race: T },
  StarportFlying: { m: 0, g: 0, s: 0, isBuilding: true, race: T },
  Armory: { m: 150, g: 100, s: 0, isBuilding: true, race: T },
  Bunker: { m: 100, g: 0, s: 0, isBuilding: true, race: T },
  GhostAcademy: { m: 150, g: 50, s: 0, isBuilding: true, race: T },
  FusionCore: { m: 150, g: 150, s: 0, isBuilding: true, race: T },
  MissileTurret: { m: 100, g: 0, s: 0, isBuilding: true, race: T },
  SensorTower: { m: 125, g: 100, s: 0, isBuilding: true, race: T },
  TechLab: { m: 50, g: 25, s: 0, isBuilding: true, race: T },
  Reactor: { m: 50, g: 50, s: 0, isBuilding: true, race: T },
  BarracksTechLab: { m: 50, g: 25, s: 0, isBuilding: true, race: T },
  BarracksReactor: { m: 50, g: 50, s: 0, isBuilding: true, race: T },
  FactoryTechLab: { m: 50, g: 25, s: 0, isBuilding: true, race: T },
  FactoryReactor: { m: 50, g: 50, s: 0, isBuilding: true, race: T },
  StarportTechLab: { m: 50, g: 25, s: 0, isBuilding: true, race: T },
  StarportReactor: { m: 50, g: 50, s: 0, isBuilding: true, race: T },
};

/** Worker name set (lowercase, alias-folded). */
const WORKER_NAMES = new Set(["drone", "probe", "scv", "mule"]);

/**
 * Look up a unit cost by canonical name. Returns null when the name
 * isn't in the catalog so callers can opt to skip rather than treat the
 * unit as zero-cost. Callers that want a "missing == zero" semantic
 * should use ``costsOrZero`` instead.
 */
export function getUnitCost(name: string | null | undefined): UnitCost | null {
  if (!name) return null;
  const direct = UNIT_COSTS[name];
  if (direct) return direct;
  // Strip common morph/state suffixes the tracker emits but our table
  // doesn't enumerate (e.g. "ZerglingBurrowed", "BanelingBurrowed").
  const stripped = name
    .replace(/(Burrowed|Sieged|Phasing|Flying|Lowered|Cocoon)$/i, "")
    .replace(/^Burrowed/i, "");
  if (stripped !== name && UNIT_COSTS[stripped]) return UNIT_COSTS[stripped];
  return null;
}

/**
 * Always returns a numeric cost. Unknown names get zero — useful for
 * summing army value where unknown names should not crash the chart.
 */
export function unitMineralGasCost(name: string): number {
  const c = getUnitCost(name);
  if (!c) return 0;
  return c.m + c.g;
}

/**
 * True for Drone/Probe/SCV/MULE. Catalog flag falls back to a hard-coded
 * lowercase set so the function works even before the catalog is loaded.
 */
export function isWorkerUnit(name: string | null | undefined): boolean {
  if (!name) return false;
  const c = getUnitCost(name);
  if (c?.isWorker) return true;
  return WORKER_NAMES.has(String(name).toLowerCase());
}

/** True when the catalog flags the unit as a building. */
export function isBuildingUnit(name: string | null | undefined): boolean {
  if (!name) return false;
  return Boolean(getUnitCost(name)?.isBuilding);
}

/**
 * Sum the army value (Σ minerals + gas) of all alive non-worker,
 * non-building units in the per-tick composition map. Unknown names
 * contribute zero rather than crashing — sc2reader occasionally emits
 * cosmetic placeholder units (Beacon*, broodling spawns) that the tab
 * filter doesn't always catch.
 */
export function computeArmyValue(
  composition: Record<string, number> | null | undefined,
): number {
  if (!composition) return 0;
  let total = 0;
  for (const [name, count] of Object.entries(composition)) {
    if (!count || count <= 0) continue;
    if (isWorkerUnit(name) || isBuildingUnit(name)) continue;
    total += unitMineralGasCost(name) * count;
  }
  return total;
}

/**
 * Sort unit composition by descending mineral+gas cost (tiebreak by
 * count desc, then name asc) so the snapshot shows the heaviest units
 * first — same ordering sc2replaystats uses for its overview row.
 * Workers and buildings are dropped from the result.
 */
export function sortedArmyComposition(
  composition: Record<string, number> | null | undefined,
): Array<{ name: string; count: number; cost: number }> {
  if (!composition) return [];
  const entries: Array<{ name: string; count: number; cost: number }> = [];
  for (const [name, count] of Object.entries(composition)) {
    if (!count || count <= 0) continue;
    if (isWorkerUnit(name) || isBuildingUnit(name)) continue;
    entries.push({ name, count, cost: unitMineralGasCost(name) });
  }
  entries.sort((a, b) => {
    if (b.cost !== a.cost) return b.cost - a.cost;
    if (b.count !== a.count) return b.count - a.count;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

/**
 * Worker count from a composition map. Only Drone/Probe/SCV count —
 * MULEs are excluded because they're temporary calldown units, not part
 * of the saturated worker line that shows up on the chart's worker
 * dashed series.
 */
export function workerCount(
  composition: Record<string, number> | null | undefined,
): number {
  if (!composition) return 0;
  let total = 0;
  for (const [name, count] of Object.entries(composition)) {
    if (!count || count <= 0) continue;
    const lower = String(name).toLowerCase();
    if (lower === "drone" || lower === "probe" || lower === "scv") {
      total += count;
    }
  }
  return total;
}
