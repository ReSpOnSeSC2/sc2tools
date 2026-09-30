/**
 * SC2 unit catalog — mineral / gas / supply costs and classification flags.
 *
 * Used by the macro-breakdown chart to compute army-value (Σ minerals+gas
 * across all alive non-worker, non-building units) and by the unit
 * composition snapshot below the chart.
 *
 * Costs come from the balance-patch dataset in lib/sc2-patch, resolved
 * for the game's patch era (``profileIdForEra``): the 12-worker game
 * (before 5.0.16, and 5.0.17 on) prices at the LotV base balance, the
 * 8-worker 5.0.16 window at 5.0.16b. Every lookup takes the era and
 * defaults to the live 12-worker game. Morphs price at their morph cost,
 * as the dataset records it (Baneling 25/25), with the unit's own supply
 * (Ravager 3). The map replayer's loss ledger instead prices the full
 * invested cost (lib/mapReplayLosses).
 *
 * Names use the canonical sc2reader form (PascalCase, no spaces). Aliases
 * cover sc2reader's morph/burrow variants so the lookup is resilient
 * regardless of which morph step the tracker emitted.
 */

import type { PatchEra } from "./meta";
import { profileIdForEra, resolveProfile } from "./sc2-patch/profiles";

export interface UnitCost {
  /** Mineral cost. */
  m: number;
  /** Vespene gas cost. */
  g: number;
  /** Supply consumed (0 for buildings). */
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
 * Names the balance dataset doesn't carry, priced by hand for every
 * era. Lifted Terran buildings are priced at
 * zero on purpose: the building was already counted, and the suffix
 * fallback in ``getUnitCost`` would otherwise price a flying Command
 * Center as a new one.
 */
const EXTRA_COSTS: Readonly<Record<string, UnitCost>> = {
  MULE: { m: 0, g: 0, s: 0, isWorker: true, race: T },

  // Zerg free spawns and transients
  Larva: { m: 0, g: 0, s: 0, race: Z },
  Egg: { m: 0, g: 0, s: 0, race: Z },
  Broodling: { m: 0, g: 0, s: 0, race: Z },
  Locust: { m: 0, g: 0, s: 0, race: Z },
  LocustMP: { m: 0, g: 0, s: 0, race: Z },
  LocustMPFlying: { m: 0, g: 0, s: 0, race: Z },
  Changeling: { m: 0, g: 0, s: 0, race: Z },
  NydusCanal: { m: 50, g: 50, s: 0, race: Z },
  NydusWorm: { m: 75, g: 75, s: 0, isBuilding: true, race: Z },
  CreepTumor: { m: 0, g: 0, s: 0, isBuilding: true, race: Z },
  CreepTumorBurrowed: { m: 0, g: 0, s: 0, isBuilding: true, race: Z },
  CreepTumorQueen: { m: 0, g: 0, s: 0, isBuilding: true, race: Z },

  // Protoss
  Interceptor: { m: 15, g: 0, s: 0, race: P },
  AdeptPhaseShift: { m: 0, g: 0, s: 0, race: P },
  // Two High Templar merged; the replay can't tell which templar did.
  Archon: { m: 100, g: 300, s: 4, race: P },
  DisruptorPhased: { m: 0, g: 0, s: 0, race: P },
  OracleStasisTrap: { m: 0, g: 0, s: 0, race: P },
  Mothership: { m: 400, g: 400, s: 8, race: P },

  // Terran
  AutoTurret: { m: 0, g: 0, s: 0, race: T },
  PointDefenseDrone: { m: 0, g: 0, s: 0, race: T },
  SensorTower: { m: 125, g: 100, s: 0, isBuilding: true, race: T },
  CommandCenterFlying: { m: 0, g: 0, s: 0, isBuilding: true, race: T },
  OrbitalCommandFlying: { m: 0, g: 0, s: 0, isBuilding: true, race: T },
  BarracksFlying: { m: 0, g: 0, s: 0, isBuilding: true, race: T },
  FactoryFlying: { m: 0, g: 0, s: 0, isBuilding: true, race: T },
  StarportFlying: { m: 0, g: 0, s: 0, isBuilding: true, race: T },
};

/**
 * Other names sc2reader emits for a unit the dataset carries (modes,
 * burrowed states, data-version spellings, the bare add-on names),
 * priced as that unit.
 */
const ALIASES: Readonly<Record<string, string>> = {
  OverlordTransport: "Overlord",
  OverseerSiegeMode: "Overseer",
  LurkerMP: "Lurker",
  LurkerMPBurrowed: "Lurker",
  SwarmHostMP: "SwarmHost",
  Broodlord: "BroodLord",
  LurkerDenMP: "LurkerDen",
  WarpPrismPhasing: "WarpPrism",
  ObserverSiegeMode: "Observer",
  WarpGate: "Gateway",
  TemplarArchive: "TemplarArchives",
  Hellbat: "Hellion",
  HellionTank: "Hellion",
  WidowMineBurrowed: "WidowMine",
  SiegeTankSieged: "SiegeTank",
  ThorAP: "Thor",
  VikingFighter: "Viking",
  VikingAssault: "Viking",
  LiberatorAG: "Liberator",
  SupplyDepotLowered: "SupplyDepot",
  RefineryRich: "Refinery",
  TechLab: "BarracksTechLab",
  Reactor: "BarracksReactor",
};

/** Canonical name → cost, one table per balance profile, built on first use. */
const costTables = new Map<string, Readonly<Record<string, UnitCost>>>();

function buildCostTable(profileId: string): Record<string, UnitCost> {
  const table: Record<string, UnitCost> = { ...EXTRA_COSTS };
  for (const [name, def] of Object.entries(resolveProfile(profileId).units)) {
    const cost: UnitCost = { m: def.minerals, g: def.gas, s: def.supply, race: def.race };
    if (def.isWorker) cost.isWorker = true;
    if (def.isStructure) cost.isBuilding = true;
    table[name] = cost;
  }
  for (const [alias, canonical] of Object.entries(ALIASES)) {
    if (table[canonical]) table[alias] = table[canonical];
  }
  return table;
}

function costTable(era?: PatchEra | null): Readonly<Record<string, UnitCost>> {
  const profileId = profileIdForEra(era);
  let table = costTables.get(profileId);
  if (!table) {
    table = buildCostTable(profileId);
    costTables.set(profileId, table);
  }
  return table;
}

/** Worker name set (lowercase, alias-folded). */
const WORKER_NAMES = new Set(["drone", "probe", "scv", "mule"]);

/**
 * Look up a unit cost by canonical name, priced for the game's patch
 * ``era`` (default: the live 12-worker game). Returns null when the name
 * isn't in the catalog so callers can opt to skip rather than treat the
 * unit as zero-cost.
 *
 * Example: `getUnitCost("Queen")?.m` → 175; `getUnitCost("Queen", "before")?.m` → 150.
 */
export function getUnitCost(
  name: string | null | undefined,
  era?: PatchEra | null,
): UnitCost | null {
  if (!name) return null;
  const table = costTable(era);
  const direct = table[name];
  if (direct) return direct;
  // Strip common morph/state suffixes the tracker emits but our table
  // doesn't enumerate (e.g. "ZerglingBurrowed", "BanelingBurrowed").
  const stripped = name
    .replace(/(Burrowed|Sieged|Phasing|Flying|Lowered|Cocoon)$/i, "")
    .replace(/^Burrowed/i, "");
  if (stripped !== name && table[stripped]) return table[stripped];
  return null;
}

/**
 * Always returns a numeric cost. Unknown names get zero — useful for
 * summing army value where unknown names should not crash the chart.
 */
export function unitMineralGasCost(name: string, era?: PatchEra | null): number {
  const c = getUnitCost(name, era);
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
 * non-building units in the per-tick composition map, priced for the
 * game's patch ``era``. Unknown names contribute zero rather than
 * crashing — sc2reader occasionally emits cosmetic placeholder units
 * (Beacon*, broodling spawns) that the tab filter doesn't always catch.
 */
export function computeArmyValue(
  composition: Record<string, number> | null | undefined,
  era?: PatchEra | null,
): number {
  if (!composition) return 0;
  let total = 0;
  for (const [name, count] of Object.entries(composition)) {
    if (!count || count <= 0) continue;
    if (isWorkerUnit(name) || isBuildingUnit(name)) continue;
    total += unitMineralGasCost(name, era) * count;
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
  era?: PatchEra | null,
): Array<{ name: string; count: number; cost: number }> {
  if (!composition) return [];
  const entries: Array<{ name: string; count: number; cost: number }> = [];
  for (const [name, count] of Object.entries(composition)) {
    if (!count || count <= 0) continue;
    if (isWorkerUnit(name) || isBuildingUnit(name)) continue;
    entries.push({ name, count, cost: unitMineralGasCost(name, era) });
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
