/**
 * mapReplayLosses — units-lost accounting for the map replayer.
 *
 * Prices every unit death in the playback payload with REAL balance
 * data: costs come from the optimizer's patch dataset (the same
 * layered profiles the build optimizer resolves), so there is one
 * source of truth for unit prices. Morphed units (Baneling, Ravager,
 * Brood Lord, …) price at their FULL invested cost — the morph price
 * plus the consumed unit's full cost, walked through the dataset's
 * ``builtFrom`` chain — because losing a Brood Lord loses the
 * Corruptor too.
 *
 * Everything here is pure math over the playback payload, so the
 * replayer component stays a draw loop and this file unit-tests.
 */

import {
  DEFAULT_PROFILE_ID,
  resolveProfile,
} from "./optimizer/patch/profiles";
import {
  unitAliveAt,
  unitPositionAt,
  type PlaybackBuilding,
  type PlaybackUnit,
} from "./mapReplay";

export interface UnitCost {
  minerals: number;
  gas: number;
}

/** Canonical playback names the balance dataset doesn't carry.
 * Archon assumes the common 2× High Templar merge (the replay can't
 * tell which templar died into it); Hellbat is a Hellion mode. */
const EXTRA_COSTS: Readonly<Record<string, UnitCost>> = {
  Archon: { minerals: 100, gas: 300 },
  Hellbat: { minerals: 100, gas: 0 },
  Mothership: { minerals: 400, gas: 400 },
};

let costTable: Map<string, UnitCost> | null = null;

function buildCostTable(): Map<string, UnitCost> {
  const out = new Map<string, UnitCost>(Object.entries(EXTRA_COSTS));
  let units: Record<
    string,
    { minerals?: number; gas?: number; morphFrom?: string; isStructure?: boolean }
  > = {};
  try {
    units = resolveProfile(DEFAULT_PROFILE_ID).units;
  } catch {
    units = {};
  }
  const fullCost = (name: string, seen: Set<string>): UnitCost | null => {
    const def = units[name];
    if (!def || seen.has(name)) return null;
    seen.add(name);
    let minerals = def.minerals ?? 0;
    let gas = def.gas ?? 0;
    // Morphs consume the unit named in ``morphFrom`` — its full cost
    // is part of what died. (``builtFrom`` is the PRODUCER — using it
    // would price a Marine at Marine + Barracks + SCV + …)
    if (def.morphFrom) {
      const parentCost = fullCost(def.morphFrom, seen);
      if (parentCost) {
        minerals += parentCost.minerals;
        gas += parentCost.gas;
      }
    }
    return { minerals, gas };
  };
  for (const [name, def] of Object.entries(units)) {
    if (def.isStructure) continue; // only unit deaths are priced here
    const cost = fullCost(name, new Set());
    if (cost && (cost.minerals > 0 || cost.gas > 0)) out.set(name, cost);
  }
  return out;
}

/** Full invested cost of one unit by its canonical playback name, or
 * null for structures/unknown/free units (MULEs, larvae). */
export function unitCost(name: string): UnitCost | null {
  if (!costTable) costTable = buildCostTable();
  return costTable.get(name) ?? null;
}

export interface LostUnitGroup {
  name: string;
  count: number;
  /** Total minerals/gas across the group's deaths. */
  minerals: number;
  gas: number;
}

export interface LossSummary {
  /** Priced unit deaths (free units — MULEs, broodlings — excluded). */
  count: number;
  minerals: number;
  gas: number;
  byUnit: LostUnitGroup[];
}

/* ──────────────── spent-not-lost exclusions ────────────────
 *
 * The SC2 tracker emits a REAL UnitDiedEvent for units consumed by
 * their own tech: a Drone the moment it morphs into a structure, and
 * both Templar when an Archon merge completes. Counting those as
 * combat losses would charge Zerg a "lost drone" for every building
 * and double-price every Archon (templar + the Archon's own cost),
 * so deaths that coincide in time AND place with the thing they
 * became are excluded from the loss ledger.
 */

/** How far apart (seconds) a consumption death and its product's
 * birth may be recorded. Tracker stamps them on the same tick;
 * payload rounding is 0.1s — the slack covers both. */
const CONSUMED_TIME_TOL_SEC = 2.5;
/** World-cell radius pairing a death with its product. The death
 * event lands on the building/merge spot, but compaction may drop a
 * final waypoint recorded < 2s after the previous one, leaving the
 * interpolated death position a few cells short. */
const CONSUMED_DIST_TOL = 6;

const near = (
  a: { x: number; y: number } | null,
  bx: number,
  by: number,
): boolean => a !== null && Math.hypot(a.x - bx, a.y - by) <= CONSUMED_DIST_TOL;

/**
 * Indices (into ``units``) of deaths that are resource SPENDING, not
 * losses: Drones consumed by the structure they morphed into, and
 * High/Dark Templar consumed by an Archon merge. Pure and payload-
 * stable — compute once per playback and pass to ``computeLosses``.
 */
export function morphConsumedIndices(
  units: ReadonlyArray<PlaybackUnit>,
  buildings: ReadonlyArray<PlaybackBuilding>,
): Set<number> {
  const out = new Set<number>();
  const archons = units.filter((u) => u.name === "Archon");
  units.forEach((u, idx) => {
    if (u.died === null) return;
    if (u.name === "Drone") {
      const pos = unitPositionAt(u.wp, u.died);
      const morphed = buildings.some(
        (b) =>
          b.owner === u.owner &&
          Math.abs(b.t - (u.died as number)) <= CONSUMED_TIME_TOL_SEC &&
          near(pos, b.x, b.y),
      );
      if (morphed) out.add(idx);
    } else if (u.name === "HighTemplar" || u.name === "DarkTemplar") {
      const pos = unitPositionAt(u.wp, u.died);
      const merged = archons.some((a) => {
        if (a.owner !== u.owner) return false;
        if (Math.abs(a.born - (u.died as number)) > CONSUMED_TIME_TOL_SEC) {
          return false;
        }
        const apos = unitPositionAt(a.wp, a.born);
        return apos !== null && near(pos, apos.x, apos.y);
      });
      if (merged) out.add(idx);
    }
  });
  return out;
}

/**
 * Everything ``owner`` has lost by time ``t``: priced unit deaths
 * grouped by type, most expensive group first. Free units never
 * count — a dead MULE isn't a loss — and neither do units consumed
 * by their own tech (pass ``consumed`` from
 * {@link morphConsumedIndices}).
 */
export function computeLosses(
  units: ReadonlyArray<PlaybackUnit>,
  owner: "me" | "opp",
  t: number,
  consumed?: ReadonlySet<number>,
): LossSummary {
  const groups = new Map<string, LostUnitGroup>();
  let count = 0;
  let minerals = 0;
  let gas = 0;
  for (let idx = 0; idx < units.length; idx += 1) {
    const u = units[idx];
    if (u.owner !== owner || u.died === null || u.died > t) continue;
    if (consumed?.has(idx)) continue;
    const cost = unitCost(u.name);
    if (!cost) continue;
    count += 1;
    minerals += cost.minerals;
    gas += cost.gas;
    const g = groups.get(u.name);
    if (g) {
      g.count += 1;
      g.minerals += cost.minerals;
      g.gas += cost.gas;
    } else {
      groups.set(u.name, {
        name: u.name,
        count: 1,
        minerals: cost.minerals,
        gas: cost.gas,
      });
    }
  }
  const byUnit = [...groups.values()].sort(
    (a, b) => b.minerals + b.gas - (a.minerals + a.gas) || b.count - a.count,
  );
  return { count, minerals, gas, byUnit };
}

/** Combined resource value of a loss summary. */
export function lossValue(s: LossSummary): number {
  return s.minerals + s.gas;
}

/**
 * Trade efficiency for the side whose losses are ``mine``: the value
 * the opponent lost (what this side killed) per resource this side
 * lost. > 1 means this side traded up. Null when nothing died yet on
 * either side (no trades to grade).
 */
export function tradeEfficiency(
  mine: LossSummary,
  theirs: LossSummary,
): number | null {
  const lost = lossValue(mine);
  const killed = lossValue(theirs);
  if (lost <= 0 && killed <= 0) return null;
  if (lost <= 0) return Infinity;
  return killed / lost;
}

/** The three mining workers — MULEs are free and never counted. */
const REAL_WORKERS: ReadonlySet<string> = new Set(["Probe", "SCV", "Drone"]);

/**
 * Live worker head-count from the unit tracks. Fallback for payloads
 * synced by agents whose stats series carried the workers-always-0
 * bug (fixed in engine 1.5.3): the worker units themselves were
 * always in the payload, so counting the alive ones restores a real
 * worker HUD for every previously synced game.
 */
export function workerCountAt(
  units: ReadonlyArray<PlaybackUnit>,
  owner: "me" | "opp",
  t: number,
): number {
  let n = 0;
  for (const u of units) {
    if (u.owner === owner && REAL_WORKERS.has(u.name) && unitAliveAt(u, t)) {
      n += 1;
    }
  }
  return n;
}

/** Does this side's stats series carry a usable worker column? A
 * whole game of zeros is the legacy-agent bug signature — real games
 * start at 12 workers. */
export function statsHaveWorkers(rows: ReadonlyArray<readonly number[]>): boolean {
  return rows.some((r) => (r[2] ?? 0) > 0);
}
