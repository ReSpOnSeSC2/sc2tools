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
  unitNameAt,
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

/** Unit names whose killer-less deaths are tech consumption. */
const CONSUMABLE: ReadonlySet<string> = new Set([
  "Drone",
  "HighTemplar",
  "DarkTemplar",
]);

/** Legacy-payload pairing window (seconds). The tracker stamps a
 * morph's drone death and the structure's init on the SAME tick, so
 * a real match sits at ~0; the slack only covers 0.1s payload
 * rounding and timebase jitter. */
const CONSUMED_TIME_TOL_SEC = 1.25;
/** Distance fallback for tie-breaks and sanity: interpolated death
 * positions can sit several cells off the recorded spot when the
 * exact death waypoint was dropped by the payload's 2s waypoint
 * compaction, so this stays generous. */
const CONSUMED_DIST_TOL = 12;

interface ConsumptionCandidate {
  productKey: number;
  unitIdx: number;
  dt: number;
  dist: number;
}

/** Greedy 1:1 assignment: best (dt, dist) pairs first; every product
 * consumes at most ``perProduct`` deaths, every death is consumed at
 * most once. Returns the consumed unit indices. */
function assignConsumption(
  candidates: ConsumptionCandidate[],
  perProduct: number,
): Set<number> {
  candidates.sort((a, b) => a.dt - b.dt || a.dist - b.dist);
  const productUses = new Map<number, number>();
  const consumed = new Set<number>();
  for (const c of candidates) {
    if (consumed.has(c.unitIdx)) continue;
    const used = productUses.get(c.productKey) ?? 0;
    if (used >= perProduct) continue;
    productUses.set(c.productKey, used + 1);
    consumed.add(c.unitIdx);
  }
  return consumed;
}

/**
 * Indices (into ``units``) of deaths that are resource SPENDING, not
 * losses: Drones consumed by the structure they morphed into, and
 * High/Dark Templar consumed by an Archon merge. Pure and payload-
 * stable — compute once per playback and pass to ``computeLosses``.
 *
 * v4+ payloads carry exact killer attribution: ``sd: true`` marks a
 * death with no killer, which for these unit types IS the morph or
 * merge — no pairing needed, and a drone genuinely shot next to its
 * own morphing hatchery stays a loss. Older payloads fall back to
 * 1:1 time-first matching against building starts / Archon births:
 * the tracker records both halves of a consumption on the same tick,
 * so each structure claims the closest-in-time (then closest-in-
 * space) drone death and each Archon claims at most two templar —
 * bounded, so a busy fight can't swallow extra deaths.
 */
export function morphConsumedIndices(
  units: ReadonlyArray<PlaybackUnit>,
  buildings: ReadonlyArray<PlaybackBuilding>,
  payloadVersion = 0,
): Set<number> {
  if (payloadVersion >= 4) {
    const out = new Set<number>();
    units.forEach((u, idx) => {
      if (u.died !== null && u.sd === true && CONSUMABLE.has(u.name)) {
        out.add(idx);
      }
    });
    return out;
  }

  const droneCandidates: ConsumptionCandidate[] = [];
  const templarCandidates: ConsumptionCandidate[] = [];
  const archons = units
    .map((u, idx) => ({ u, idx }))
    .filter(({ u }) => u.name === "Archon");
  units.forEach((u, idx) => {
    if (u.died === null || !CONSUMABLE.has(u.name)) return;
    const pos = unitPositionAt(u.wp, u.died);
    if (u.name === "Drone") {
      buildings.forEach((b, bIdx) => {
        if (b.owner !== u.owner) return;
        const dt = Math.abs(b.t - (u.died as number));
        if (dt > CONSUMED_TIME_TOL_SEC) return;
        const dist = pos === null ? 0 : Math.hypot(pos.x - b.x, pos.y - b.y);
        if (dist > CONSUMED_DIST_TOL) return;
        droneCandidates.push({ productKey: bIdx, unitIdx: idx, dt, dist });
      });
    } else {
      for (const { u: a, idx: aIdx } of archons) {
        if (a.owner !== u.owner) continue;
        const dt = Math.abs(a.born - (u.died as number));
        if (dt > CONSUMED_TIME_TOL_SEC) continue;
        const apos = unitPositionAt(a.wp, a.born);
        const dist =
          pos === null || apos === null
            ? 0
            : Math.hypot(pos.x - apos.x, pos.y - apos.y);
        if (dist > CONSUMED_DIST_TOL) continue;
        templarCandidates.push({ productKey: aIdx, unitIdx: idx, dt, dist });
      }
    }
  });
  const out = assignConsumption(droneCandidates, 1);
  for (const idx of assignConsumption(templarCandidates, 2)) out.add(idx);
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
    const name = unitNameAt(u, u.died);
    const cost = unitCost(name);
    if (!cost) continue;
    count += 1;
    minerals += cost.minerals;
    gas += cost.gas;
    const g = groups.get(name);
    if (g) {
      g.count += 1;
      g.minerals += cost.minerals;
      g.gas += cost.gas;
    } else {
      groups.set(name, {
        name,
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
    if (u.owner === owner && REAL_WORKERS.has(unitNameAt(u, t)) && unitAliveAt(u, t)) {
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
