/**
 * Simulator state container and bookkeeping helpers shared by the
 * dispatch layer (dispatch.ts) and the main loop (engine.ts).
 */
import type {
  MacroPolicies,
  PatchProfile,
  SimEvent,
  SimRace,
  SimResult,
  UnitDef,
} from "../types";
import { EventQueue } from "./queue";
import {
  assignMineralWorker,
  countGasWorkers,
  countMineralWorkers,
  createBase,
  totalGasRate,
  totalMineralRate,
  type EconomyState,
} from "./income";
import type { Caster, LarvaPool, Producer } from "./production";

/** Seconds of mining a probe loses placing a structure. */
export const PROBE_BUILD_LOSS_SEC = 4;
/** Queens spawn with enough energy for one inject. */
export const QUEEN_START_ENERGY = 25;
/** Energy cost of a MULE calldown. */
export const MULE_ENERGY = 50;
/** Safety-net policy tick (exact wakes cover the hot paths). */
export const POLICY_TICK_SEC = 1;
export const EPSILON = 1e-6;

export type SimEventPayload =
  | { type: "task-complete"; taskId: number }
  | { type: "builder-return"; count: number }
  | { type: "larva-spawn"; hatchId: number }
  | { type: "inject-land"; hatchId: number }
  | { type: "wake" };

export interface Task {
  id: number;
  completeAt: number;
  kind: "unit" | "structure" | "upgrade" | "morph" | "transform";
  name: string;
  def?: UnitDef;
  producerId?: number;
  viaReactor?: boolean;
  /** Structure tasks: producer id of the structure being built. */
  newProducerId?: number;
  baseId?: number;
  morphSource?: string;
  count: number;
  startedAt: number;
}

export interface SimState {
  time: number;
  eco: EconomyState;
  supplyUsed: number;
  supplyCap: number;
  producers: Producer[];
  larvaPools: Map<number, LarvaPool>;
  casters: Caster[];
  completed: Map<string, number>;
  inProgress: Map<string, number>;
  completionTimes: Map<string, number[]>;
  upgradesDone: Set<string>;
  upgradesInProgress: Set<string>;
  tasks: Map<number, Task>;
  queue: EventQueue<SimEventPayload>;
  events: SimEvent[];
  steps: SimResult["steps"];
  samples: SimResult["samples"];
  nextId: number;
  warpgateDone: boolean;
  supplyBlockedSince: number | null;
  supplyBlockedSec: number;
  queenRoundRobin: number;
  lastSampleAt: number;
  policies: MacroPolicies;
  /** Structure names that can train units (drives supply headroom). */
  producerNames: Set<string>;
}

/**
 * Structures that train units — town halls, gateways, barracks, etc.
 * Pylons/assimilators/tech buildings are NOT producers; counting them
 * toward supply headroom creates a feedback loop where every pylon
 * raises the headroom that demands the next pylon.
 */
export function unitProducerNames(profile: PatchProfile): Set<string> {
  const names = new Set<string>();
  for (const def of Object.values(profile.units)) {
    if (def.isStructure) continue;
    for (const from of def.builtFrom) {
      if (profile.units[from]?.isStructure) names.add(from);
    }
  }
  return names;
}

export function bump(
  map: Map<string, number>,
  key: string,
  delta: number,
): void {
  map.set(key, Math.max(0, (map.get(key) ?? 0) + delta));
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function makeState(
  profile: PatchProfile,
  race: SimRace,
  policies: MacroPolicies,
): SimState {
  const eco: EconomyState = {
    bases: [createBase(0, profile.economy, true)],
    mules: [],
    minerals: profile.starting.minerals,
    gas: profile.starting.gas,
    lastIntegrated: 0,
  };
  const state: SimState = {
    time: 0,
    eco,
    supplyUsed: 0,
    supplyCap: 0,
    producers: [],
    larvaPools: new Map(),
    casters: [],
    completed: new Map(),
    inProgress: new Map(),
    completionTimes: new Map(),
    upgradesDone: new Set(),
    upgradesInProgress: new Set(),
    tasks: new Map(),
    queue: new EventQueue(),
    events: [],
    steps: [],
    samples: [],
    nextId: 1,
    warpgateDone: false,
    supplyBlockedSince: null,
    supplyBlockedSec: 0,
    queenRoundRobin: 0,
    lastSampleAt: -Infinity,
    policies,
    producerNames: unitProducerNames(profile),
  };
  const thName = profile.starting.townHall[race];
  const th = profile.units[thName];
  const townHall: Producer = {
    id: state.nextId++,
    name: thName,
    readyAt: 0,
    busyUntil: 0,
    reactorBusyUntil: 0,
    addon: null,
    isWarpgate: false,
    warpgateTransformPaid: false,
    chronoUntil: 0,
    baseId: 0,
  };
  state.producers.push(townHall);
  bump(state.completed, thName, 1);
  state.supplyCap += th.providesSupply ?? 0;
  if (race === "Protoss") {
    state.casters.push({
      kind: thName,
      attachedTo: townHall.id,
      energy: profile.mechanics.startingEnergy,
      lastUpdated: 0,
    });
  }
  if (race === "Zerg") {
    state.larvaPools.set(townHall.id, {
      hatchId: townHall.id,
      larvae: profile.starting.startingLarvae,
      nextNaturalAt: Infinity,
      pendingInjects: [],
    });
  }
  const workerName = profile.starting.worker[race];
  bump(state.completed, workerName, profile.starting.workers);
  state.supplyUsed +=
    profile.units[workerName].supply * profile.starting.workers;
  for (let i = 0; i < profile.starting.workers; i += 1) {
    assignMineralWorker(eco);
  }
  for (const [unit, count] of Object.entries(
    profile.starting.extraUnits[race] ?? {},
  )) {
    bump(state.completed, unit, count);
    const def = profile.units[unit];
    state.supplyUsed += def.supply * count;
    state.supplyCap += (def.providesSupply ?? 0) * count;
  }
  state.supplyCap = Math.min(state.supplyCap, profile.starting.maxSupply);
  return state;
}

export function log(
  state: SimState,
  kind: SimEvent["kind"],
  name: string,
  detail?: string,
): void {
  state.events.push({
    time: round2(state.time),
    kind,
    name,
    supplyUsed: Math.floor(state.supplyUsed),
    detail,
  });
}

export function sample(
  state: SimState,
  profile: PatchProfile,
  force = false,
): void {
  if (!force && state.time - state.lastSampleAt < 2) return;
  state.lastSampleAt = state.time;
  state.samples.push({
    time: round2(state.time),
    minerals: Math.round(state.eco.minerals),
    gas: Math.round(state.eco.gas),
    mineralRate: round2(
      totalMineralRate(state.eco, profile.economy, state.time) * 60,
    ),
    gasRate: round2(totalGasRate(state.eco, profile.economy) * 60),
    workers: countMineralWorkers(state.eco) + countGasWorkers(state.eco),
    supplyUsed: Math.floor(state.supplyUsed),
    supplyCap: Math.floor(state.supplyCap),
  });
}

/** Supply granted by in-progress providers (pylon mid-build, etc.). */
export function pendingSupply(
  state: SimState,
  profile: PatchProfile,
): number {
  let total = 0;
  for (const task of state.tasks.values()) {
    const def = profile.units[task.name];
    if (def?.providesSupply) total += def.providesSupply * task.count;
  }
  return total;
}

export function spend(
  state: SimState,
  minerals: number,
  gas: number,
): void {
  state.eco.minerals -= minerals;
  state.eco.gas -= gas;
}

export function scheduleTask(state: SimState, task: Omit<Task, "id">): Task {
  const full: Task = { ...task, id: state.nextId++ };
  state.tasks.set(full.id, full);
  state.queue.push(full.completeAt, {
    type: "task-complete",
    taskId: full.id,
  });
  return full;
}

export function recordStep(
  state: SimState,
  kind: SimResult["steps"][number]["kind"],
  name: string,
  doneAt: number,
  /** Pre-step supply when the dispatch already mutated supplyUsed
   *  (zerg structures consume their drone before the step records). */
  supplyAtStart?: number,
): void {
  state.steps.push({
    supply: Math.floor(supplyAtStart ?? state.supplyUsed),
    name,
    kind,
    startSec: round2(state.time),
    doneSec: round2(doneAt),
  });
}

export function pushCompletion(
  state: SimState,
  name: string,
  count: number,
): void {
  const list = state.completionTimes.get(name) ?? [];
  for (let i = 0; i < count; i += 1) list.push(round2(state.time));
  state.completionTimes.set(name, list);
}

/* ------------------------------------------------------------------ */
/* Larva                                                               */
/* ------------------------------------------------------------------ */

export function pickLarvaPool(state: SimState): LarvaPool | null {
  let best: LarvaPool | null = null;
  for (const pool of state.larvaPools.values()) {
    if (pool.larvae < 1) continue;
    if (!best || pool.larvae > best.larvae) best = pool;
  }
  return best;
}

export function consumeLarva(
  state: SimState,
  profile: PatchProfile,
  pool: LarvaPool,
): void {
  pool.larvae -= 1;
  ensureNaturalLarva(state, profile, pool);
}

export function ensureNaturalLarva(
  state: SimState,
  profile: PatchProfile,
  pool: LarvaPool,
): void {
  if (pool.larvae >= profile.mechanics.larva.naturalCap) {
    pool.nextNaturalAt = Infinity;
    return;
  }
  if (!Number.isFinite(pool.nextNaturalAt)) {
    pool.nextNaturalAt = state.time + profile.mechanics.larva.intervalSec;
    state.queue.push(pool.nextNaturalAt, {
      type: "larva-spawn",
      hatchId: pool.hatchId,
    });
  }
}
