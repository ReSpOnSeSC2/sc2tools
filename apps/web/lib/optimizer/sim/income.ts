/**
 * Economy model — piecewise-constant income integrated lazily.
 *
 * Mining rates are the community-measured LotV per-worker numbers
 * carried in the patch profile (see EconomyConfig): the first two
 * workers on a patch mine at the full rate, a third adds a reduced
 * marginal rate, and beyond 3-per-patch extra workers add nothing.
 * Gas is linear up to 3 workers per geyser. MULEs add a flat stream
 * for their lifetime and ignore saturation slots.
 *
 * Depletion is tracked per base as an aggregate remaining pool —
 * within a build-order horizon (≤ ~12 min) individual patch rotation
 * doesn't measurably matter, but a mined-out base dropping to zero
 * income does.
 */
import type { EconomyConfig } from "../types";

export interface GeyserState {
  /** Gas building completed and collecting. */
  active: boolean;
  workers: number;
  remaining: number;
  rich: boolean;
}

export interface BaseState {
  id: number;
  /** Town hall completed (mining allowed beforehand for zerg macro hatches is ignored). */
  active: boolean;
  mineralWorkers: number;
  mineralRemaining: number;
  patches: number;
  geysers: GeyserState[];
}

export interface MuleState {
  expiresAt: number;
}

export interface EconomyState {
  bases: BaseState[];
  mules: MuleState[];
  /** Bank, integrated up to `lastIntegrated`. */
  minerals: number;
  gas: number;
  lastIntegrated: number;
}

export function createBase(
  id: number,
  economy: EconomyConfig,
  active: boolean,
): BaseState {
  const patches = economy.patchesPerBase.large + economy.patchesPerBase.small;
  const mineralRemaining =
    economy.patchesPerBase.large * economy.patchCapacity.large +
    economy.patchesPerBase.small * economy.patchCapacity.small;
  const geysers: GeyserState[] = [];
  for (let i = 0; i < economy.geysersPerBase; i += 1) {
    geysers.push({
      active: false,
      workers: 0,
      remaining: economy.geyserCapacity,
      rich: false,
    });
  }
  return { id, active, mineralWorkers: 0, mineralRemaining, patches, geysers };
}

/** Minerals/sec for one base given its worker count. */
export function baseMineralRate(base: BaseState, eco: EconomyConfig): number {
  if (!base.active || base.mineralRemaining <= 0) return 0;
  const full = Math.min(base.mineralWorkers, 2 * base.patches);
  const third = Math.max(
    0,
    Math.min(base.mineralWorkers - 2 * base.patches, base.patches),
  );
  return full * eco.mineralRatePerWorker + third * eco.mineralRateThirdWorker;
}

export function geyserGasRate(geyser: GeyserState, eco: EconomyConfig): number {
  if (!geyser.active || geyser.remaining <= 0) return 0;
  const workers = Math.min(geyser.workers, 3);
  const mult = geyser.rich ? eco.richGasMultiplier : 1;
  return workers * eco.gasRatePerWorker * mult;
}

export function totalMineralRate(
  state: EconomyState,
  eco: EconomyConfig,
  now: number,
): number {
  let rate = 0;
  for (const base of state.bases) rate += baseMineralRate(base, eco);
  const muleRate = eco.muleMineralsTotal / eco.muleDurationSec;
  for (const mule of state.mules) {
    if (mule.expiresAt > now) rate += muleRate;
  }
  return rate;
}

export function totalGasRate(state: EconomyState, eco: EconomyConfig): number {
  let rate = 0;
  for (const base of state.bases) {
    for (const geyser of base.geysers) rate += geyserGasRate(geyser, eco);
  }
  return rate;
}

/**
 * Integrate income into the bank from `lastIntegrated` to `now`.
 * Callers must invoke this BEFORE any rate-changing mutation (worker
 * pop, transfer, mule expiry) so each segment uses the rate that was
 * actually in force. Depletion is applied per base proportionally.
 */
export function integrateIncome(
  state: EconomyState,
  eco: EconomyConfig,
  now: number,
): void {
  const dt = now - state.lastIntegrated;
  if (dt <= 0) {
    state.lastIntegrated = Math.max(state.lastIntegrated, now);
    return;
  }
  for (const base of state.bases) {
    const mined = Math.min(
      baseMineralRate(base, eco) * dt,
      base.mineralRemaining,
    );
    base.mineralRemaining -= mined;
    state.minerals += mined;
    for (const geyser of base.geysers) {
      const collected = Math.min(
        geyserGasRate(geyser, eco) * dt,
        geyser.remaining,
      );
      geyser.remaining -= collected;
      state.gas += collected;
    }
  }
  const muleRate = eco.muleMineralsTotal / eco.muleDurationSec;
  for (const mule of state.mules) {
    const activeUntil = Math.min(mule.expiresAt, now);
    const activeFrom = state.lastIntegrated;
    if (activeUntil > activeFrom) {
      state.minerals += muleRate * (activeUntil - activeFrom);
    }
  }
  state.mules = state.mules.filter((m) => m.expiresAt > now);
  state.lastIntegrated = now;
}

/**
 * Earliest time ≥ now at which the bank can afford (m, g) assuming
 * rates stay constant. Returns Infinity when a needed resource has
 * zero income (the caller waits for the next structural event).
 */
export function timeUntilAffordable(
  state: EconomyState,
  eco: EconomyConfig,
  now: number,
  mineralCost: number,
  gasCost: number,
): number {
  const needM = mineralCost - state.minerals;
  const needG = gasCost - state.gas;
  if (needM <= 0 && needG <= 0) return now;
  let waitM = 0;
  let waitG = 0;
  if (needM > 0) {
    const rate = totalMineralRate(state, eco, now);
    if (rate <= 0) return Infinity;
    waitM = needM / rate;
  }
  if (needG > 0) {
    const rate = totalGasRate(state, eco);
    if (rate <= 0) return Infinity;
    waitG = needG / rate;
  }
  return now + Math.max(waitM, waitG);
}

/** Total mineral-line workers across bases. */
export function countMineralWorkers(state: EconomyState): number {
  return state.bases.reduce((sum, b) => sum + b.mineralWorkers, 0);
}

export function countGasWorkers(state: EconomyState): number {
  let total = 0;
  for (const base of state.bases) {
    for (const geyser of base.geysers) total += geyser.workers;
  }
  return total;
}

/** Assign a new mineral worker to the least-saturated active base. */
export function assignMineralWorker(state: EconomyState): void {
  let target: BaseState | null = null;
  let bestRatio = Infinity;
  for (const base of state.bases) {
    if (!base.active || base.mineralRemaining <= 0) continue;
    const ratio = base.mineralWorkers / Math.max(1, base.patches);
    if (ratio < bestRatio) {
      bestRatio = ratio;
      target = base;
    }
  }
  (target ?? state.bases[0]).mineralWorkers += 1;
}

/** Remove `count` mineral workers, preferring the most-saturated base. */
export function takeMineralWorkers(state: EconomyState, count: number): number {
  let taken = 0;
  while (taken < count) {
    let donor: BaseState | null = null;
    let bestRatio = -Infinity;
    for (const base of state.bases) {
      if (base.mineralWorkers <= 0) continue;
      const ratio = base.mineralWorkers / Math.max(1, base.patches);
      if (ratio > bestRatio) {
        bestRatio = ratio;
        donor = base;
      }
    }
    if (!donor) break;
    donor.mineralWorkers -= 1;
    taken += 1;
  }
  return taken;
}

/**
 * Even out mineral saturation across active bases (worker transfer on
 * expansion completion). Moves workers from over- to under-saturated
 * bases until ratios are within one worker of each other.
 */
export function rebalanceWorkers(state: EconomyState): void {
  const active = state.bases.filter((b) => b.active && b.mineralRemaining > 0);
  if (active.length < 2) return;
  for (let guard = 0; guard < 200; guard += 1) {
    active.sort(
      (a, b) =>
        a.mineralWorkers / Math.max(1, a.patches) -
        b.mineralWorkers / Math.max(1, b.patches),
    );
    const lowest = active[0];
    const highest = active[active.length - 1];
    if (highest.mineralWorkers - lowest.mineralWorkers <= 1) return;
    highest.mineralWorkers -= 1;
    lowest.mineralWorkers += 1;
  }
}
