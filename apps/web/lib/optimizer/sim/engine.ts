/**
 * Deterministic discrete-event build-order simulator.
 *
 * `simulate()` consumes an ordered action list and a resolved patch
 * profile and plays the opening out: piecewise-constant income (see
 * income.ts), producer/addon scheduling (dispatch.ts), supply, larva,
 * energy-based race mechanics (chrono / MULE / inject), and macro
 * policies (continuous workers, auto-supply, auto-gas-saturation).
 *
 * There is no randomness anywhere — identical inputs produce
 * byte-identical results, which the optimizer's fitness honesty
 * depends on.
 */
import type {
  BuildAction,
  MacroPolicies,
  PatchProfile,
  SimOptions,
  SimRace,
  SimResult,
  UnitDef,
} from "../types";
import {
  applyChrono,
  dispatchStructure,
  dispatchTrain,
  tryDispatch,
} from "./dispatch";
import {
  assignMineralWorker,
  countGasWorkers,
  countMineralWorkers,
  integrateIncome,
  rebalanceWorkers,
  takeMineralWorkers,
} from "./income";
import { updateEnergy } from "./production";
import {
  EPSILON,
  MULE_ENERGY,
  POLICY_TICK_SEC,
  QUEEN_START_ENERGY,
  bump,
  ensureNaturalLarva,
  log,
  makeState,
  pendingSupply,
  pushCompletion,
  round2,
  sample,
  type SimState,
  type Task,
} from "./state";

/* ------------------------------------------------------------------ */
/* Completion handling                                                 */
/* ------------------------------------------------------------------ */

function completeTask(
  state: SimState,
  profile: PatchProfile,
  race: SimRace,
  task: Task,
): void {
  state.tasks.delete(task.id);
  const def = task.def ?? profile.units[task.name];
  if (task.kind === "upgrade") {
    state.upgradesInProgress.delete(task.name);
    state.upgradesDone.add(task.name);
    if (task.name === "WarpGateResearch") state.warpgateDone = true;
    // Upgrades go into the completion timeline too so objectives can
    // score tech progression at a point in time.
    pushCompletion(state, task.name, 1);
    log(state, "complete", task.name);
    return;
  }
  if (task.kind === "transform") {
    const producer = state.producers.find((p) => p.id === task.producerId);
    if (producer) producer.isWarpgate = true;
    log(state, "complete", "WarpGate");
    return;
  }
  if (task.kind === "morph") {
    completeMorph(state, profile, task, def);
    return;
  }
  bump(state.inProgress, task.name, -task.count);
  bump(state.completed, task.name, task.count);
  pushCompletion(state, task.name, task.count);
  if (def?.providesSupply) {
    state.supplyCap = Math.min(
      state.supplyCap + def.providesSupply * task.count,
      profile.starting.maxSupply,
    );
  }
  if (task.kind === "structure") {
    completeStructure(state, profile, race, task, def);
  } else if (def?.isWorker) {
    for (let i = 0; i < task.count; i += 1) assignMineralWorker(state.eco);
  } else if (task.name === "Queen") {
    const hatcheries = state.producers.filter(
      (p) => p.baseId !== null && state.larvaPools.has(p.id),
    );
    const target =
      hatcheries[state.queenRoundRobin % Math.max(1, hatcheries.length)];
    state.queenRoundRobin += 1;
    state.casters.push({
      kind: "Queen",
      attachedTo: target ? target.id : null,
      energy: QUEEN_START_ENERGY,
      lastUpdated: state.time,
    });
  }
  log(state, "complete", task.name);
}

function completeStructure(
  state: SimState,
  profile: PatchProfile,
  race: SimRace,
  task: Task,
  def: UnitDef | undefined,
): void {
  if (def?.isAddon) {
    const parent = state.producers.find((p) => p.id === task.producerId);
    if (parent) {
      parent.addon = task.name.endsWith("Reactor") ? "reactor" : "techlab";
    }
    return;
  }
  if (def?.isGasBuilding) {
    activateGeyser(state);
    return;
  }
  if (def?.isTownHall && task.baseId !== undefined) {
    const base = state.eco.bases[task.baseId];
    if (base) base.active = true;
    rebalanceWorkers(state.eco);
    if (race === "Zerg" && task.newProducerId !== undefined) {
      state.larvaPools.set(task.newProducerId, {
        hatchId: task.newProducerId,
        larvae: 1,
        nextNaturalAt: Infinity,
        pendingInjects: [],
      });
      ensureNaturalLarva(
        state,
        profile,
        state.larvaPools.get(task.newProducerId)!,
      );
    }
    if (race === "Protoss") {
      state.casters.push({
        kind: profile.starting.townHall.Protoss,
        attachedTo: task.newProducerId ?? null,
        energy: profile.mechanics.startingEnergy,
        lastUpdated: state.time,
      });
    }
  }
}

function activateGeyser(state: SimState): void {
  for (const base of state.eco.bases) {
    if (!base.active) continue;
    const geyser = base.geysers.find((g) => !g.active);
    if (geyser) {
      geyser.active = true;
      if (state.policies.autoSaturateGas) {
        geyser.workers = takeMineralWorkers(state.eco, 3);
      }
      return;
    }
  }
}

function completeMorph(
  state: SimState,
  profile: PatchProfile,
  task: Task,
  def: UnitDef | undefined,
): void {
  const source = task.morphSource!;
  const sourceDef = profile.units[source];
  bump(state.inProgress, task.name, -1);
  bump(state.completed, task.name, 1);
  pushCompletion(state, task.name, 1);
  if (sourceDef.isStructure) {
    bump(state.completed, source, -1);
    const producer = state.producers.find((p) => p.id === task.producerId);
    if (producer) producer.name = task.name;
    const supplyDiff =
      (def?.providesSupply ?? 0) - (sourceDef.providesSupply ?? 0);
    if (supplyDiff !== 0) {
      state.supplyCap = Math.min(
        state.supplyCap + supplyDiff,
        profile.starting.maxSupply,
      );
    }
    if (task.name === "OrbitalCommand") {
      state.casters.push({
        kind: "OrbitalCommand",
        attachedTo: task.producerId ?? null,
        energy: profile.mechanics.startingEnergy,
        lastUpdated: state.time,
      });
    }
  }
  log(state, "complete", task.name);
}

/* ------------------------------------------------------------------ */
/* Macro policies                                                      */
/* ------------------------------------------------------------------ */

function runPolicies(
  state: SimState,
  profile: PatchProfile,
  race: SimRace,
  policies: MacroPolicies,
): void {
  const mech = profile.mechanics;
  if (policies.autoInject) {
    for (const queen of state.casters) {
      if (queen.kind !== "Queen" || queen.attachedTo === null) continue;
      updateEnergy(queen, state.time, mech.energyRegenPerSec, mech.maxEnergy);
      const pool = state.larvaPools.get(queen.attachedTo);
      if (!pool) continue;
      if (
        queen.energy >= mech.inject.energy &&
        pool.pendingInjects.length === 0
      ) {
        queen.energy -= mech.inject.energy;
        const landsAt = state.time + mech.inject.delaySec;
        pool.pendingInjects.push(landsAt);
        state.queue.push(landsAt, {
          type: "inject-land",
          hatchId: pool.hatchId,
        });
        log(state, "inject", "Queen");
      }
    }
  }
  if (policies.autoMule) {
    for (const orbital of state.casters) {
      if (orbital.kind !== "OrbitalCommand") continue;
      updateEnergy(orbital, state.time, mech.energyRegenPerSec, mech.maxEnergy);
      while (orbital.energy >= MULE_ENERGY) {
        orbital.energy -= MULE_ENERGY;
        integrateIncome(state.eco, profile.economy, state.time);
        state.eco.mules.push({
          expiresAt: state.time + profile.economy.muleDurationSec,
        });
        state.queue.push(state.time + profile.economy.muleDurationSec, {
          type: "wake",
        });
        log(state, "mule", "MULE");
      }
    }
  }
  if (policies.autoChrono !== "off") {
    autoChrono(state, profile, policies.autoChrono);
  }
  if (policies.autoWorkers) {
    autoWorkers(state, profile, race);
  }
  if (policies.autoSupplyLeadSec > 0) {
    autoSupply(state, profile, race, policies);
  }
}

function autoChrono(
  state: SimState,
  profile: PatchProfile,
  mode: "production" | "economy",
): void {
  const mech = profile.mechanics;
  const thName = profile.starting.townHall.Protoss;
  for (const nexus of state.casters) {
    if (nexus.kind !== thName) continue;
    updateEnergy(nexus, state.time, mech.energyRegenPerSec, mech.maxEnergy);
    if (nexus.energy < mech.chrono.energy) continue;
    const candidates = state.producers.filter(
      (p) =>
        p.readyAt <= state.time &&
        p.busyUntil > state.time + 5 &&
        p.chronoUntil <= state.time,
    );
    const ranked =
      mode === "economy"
        ? candidates.filter((p) => p.name === thName)
        : candidates.filter((p) => p.name !== thName);
    const target = ranked.sort((a, b) => b.busyUntil - a.busyUntil)[0];
    if (!target) continue;
    nexus.energy -= mech.chrono.energy;
    applyChrono(state, profile, target);
  }
}

function autoWorkers(
  state: SimState,
  profile: PatchProfile,
  race: SimRace,
): void {
  const workerName = profile.starting.worker[race];
  const def = profile.units[workerName];
  // Stop at comfortable saturation: 2 per patch + 3 per active geyser.
  let saturation = 0;
  for (const base of state.eco.bases) {
    if (!base.active) continue;
    saturation += 2 * base.patches;
    for (const geyser of base.geysers) if (geyser.active) saturation += 3;
  }
  const current =
    (state.completed.get(workerName) ?? 0) +
    (state.inProgress.get(workerName) ?? 0);
  if (current >= saturation) return;
  for (let guard = 0; guard < 8; guard += 1) {
    const outcome = dispatchTrain(state, profile, workerName, def);
    if (outcome.status !== "done") return;
  }
}

function autoSupply(
  state: SimState,
  profile: PatchProfile,
  race: SimRace,
  policies: MacroPolicies,
): void {
  const pending = pendingSupply(state, profile);
  const effectiveCap = state.supplyCap + pending;
  if (effectiveCap >= profile.starting.maxSupply) return;
  const activeProducers = state.producers.filter(
    (p) => p.readyAt <= state.time && state.producerNames.has(p.name),
  ).length;
  let headroom = Math.max(
    2,
    Math.round(activeProducers * (policies.autoSupplyLeadSec / 10)),
  );
  if (race === "Zerg") {
    // Banked larvae can burst-spend supply the moment they're used,
    // so zerg needs overlords ahead of the larva bank, not the
    // structure count.
    let larvae = 0;
    for (const pool of state.larvaPools.values()) larvae += pool.larvae;
    headroom = Math.max(headroom, 2 * larvae + 2);
  }
  if (effectiveCap - state.supplyUsed >= headroom) return;
  const supplyUnit =
    race === "Protoss"
      ? "Pylon"
      : race === "Terran"
        ? "SupplyDepot"
        : "Overlord";
  const def = profile.units[supplyUnit];
  if (def.isStructure) {
    dispatchStructure(state, profile, race, supplyUnit, def);
  } else {
    dispatchTrain(state, profile, supplyUnit, def);
  }
}

/* ------------------------------------------------------------------ */
/* Main loop                                                           */
/* ------------------------------------------------------------------ */

/** How many upcoming steps may start while the current one is stuck. */
const LOOKAHEAD_STEPS = 4;

/** Bank cost of an action (for the lookahead's resource reservation). */
function actionCost(
  profile: PatchProfile,
  action: BuildAction,
): { minerals: number; gas: number } {
  if (action.kind === "chrono") return { minerals: 0, gas: 0 };
  if (action.kind === "transform-warpgate") {
    return { ...profile.mechanics.warpgate.transformCost };
  }
  if (action.kind === "research") {
    const def = profile.upgrades[action.name];
    return { minerals: def?.minerals ?? 0, gas: def?.gas ?? 0 };
  }
  const def = profile.units[action.name];
  if (!def) return { minerals: 0, gas: 0 };
  const count = def.pairTrained ? 2 : 1;
  return { minerals: def.minerals * count, gas: def.gas * count };
}

export function simulate(
  actions: BuildAction[],
  profile: PatchProfile,
  race: SimRace,
  opts: SimOptions,
): SimResult {
  const state = makeState(profile, race, opts.policies);
  const policies = opts.policies;
  const done: boolean[] = new Array(actions.length).fill(false);
  let firstPending = 0;
  let unexecuted = 0;
  sample(state, profile, true);
  const advancePending = () => {
    while (firstPending < actions.length && done[firstPending]) {
      firstPending += 1;
    }
  };

  const advanceTo = (t: number) => {
    const clamped = Math.min(t, opts.horizonSec);
    if (clamped > state.time) {
      integrateIncome(state.eco, profile.economy, clamped);
      state.time = clamped;
    }
  };

  let guard = 0;
  const maxIterations = 50_000;
  while (state.time <= opts.horizonSec && guard < maxIterations) {
    guard += 1;
    integrateIncome(state.eco, profile.economy, state.time);

    // 1. Try to dispatch as many head actions as possible right now.
    let headRetryAt = Infinity;
    advancePending();
    while (firstPending < actions.length) {
      const outcome = tryDispatch(state, profile, race, actions[firstPending]);
      if (outcome.status === "done") {
        done[firstPending] = true;
        advancePending();
        continue;
      }
      if (outcome.status === "impossible") {
        log(
          state,
          "warning",
          actions[firstPending].name,
          outcome.reason ?? "impossible",
        );
        unexecuted += 1;
        done[firstPending] = true;
        advancePending();
        continue;
      }
      headRetryAt = outcome.retryAt ?? Infinity;
      if (outcome.reason === "supply-blocked") {
        if (state.supplyBlockedSince === null) {
          state.supplyBlockedSince = state.time;
          log(state, "supply-blocked", actions[firstPending].name);
        }
      }
      // Lookahead: a player following a build order doesn't freeze
      // while one step waits on a busy producer or finishing tech —
      // they start the next few steps that are ready. Resource waits
      // are excluded (skipping ahead would steal the head's bank),
      // and lookahead steps must leave the head's cost untouched.
      if (outcome.blockedOn && outcome.blockedOn !== "resources") {
        const reserve = actionCost(profile, actions[firstPending]);
        let scanned = 0;
        for (
          let i = firstPending + 1;
          i < actions.length && scanned < LOOKAHEAD_STEPS;
          i += 1
        ) {
          if (done[i]) continue;
          scanned += 1;
          const cost = actionCost(profile, actions[i]);
          if (
            state.eco.minerals - cost.minerals < reserve.minerals ||
            state.eco.gas - cost.gas < reserve.gas
          ) {
            continue;
          }
          const ahead = tryDispatch(state, profile, race, actions[i]);
          if (ahead.status === "done") done[i] = true;
        }
      }
      break;
    }
    if (
      state.supplyBlockedSince !== null &&
      (firstPending >= actions.length ||
        state.supplyUsed < state.supplyCap + pendingSupply(state, profile))
    ) {
      state.supplyBlockedSec += state.time - state.supplyBlockedSince;
      state.supplyBlockedSince = null;
    }

    // 2. Macro policies (exact-time wakes come from events/ticks).
    runPolicies(state, profile, race, policies);
    sample(state, profile);

    // 3. Advance to the next interesting moment.
    const nextEvent = state.queue.peek();
    const candidates: number[] = [];
    if (nextEvent) candidates.push(nextEvent.time);
    if (Number.isFinite(headRetryAt)) candidates.push(headRetryAt);
    candidates.push(state.time + POLICY_TICK_SEC);
    const nextTime = Math.min(...candidates);
    if (nextTime > opts.horizonSec) break;
    if (
      firstPending >= actions.length &&
      !nextEvent &&
      !policies.autoWorkers &&
      policies.autoSupplyLeadSec <= 0
    ) {
      break;
    }
    advanceTo(Math.max(nextTime, state.time + EPSILON));

    // 4. Pop every event due now.
    while (
      state.queue.peek() &&
      state.queue.peek()!.time <= state.time + EPSILON
    ) {
      const event = state.queue.pop()!;
      const payload = event.payload;
      if (payload.type === "task-complete") {
        const task = state.tasks.get(payload.taskId);
        if (!task) continue;
        if (task.completeAt > event.time + EPSILON) continue; // stale (chrono moved it)
        completeTask(state, profile, race, task);
      } else if (payload.type === "builder-return") {
        for (let i = 0; i < payload.count; i += 1) {
          assignMineralWorker(state.eco);
        }
      } else if (payload.type === "larva-spawn") {
        const pool = state.larvaPools.get(payload.hatchId);
        if (!pool) continue;
        pool.nextNaturalAt = Infinity;
        if (pool.larvae < profile.mechanics.larva.naturalCap) {
          pool.larvae += 1;
        }
        ensureNaturalLarva(state, profile, pool);
      } else if (payload.type === "inject-land") {
        const pool = state.larvaPools.get(payload.hatchId);
        if (!pool) continue;
        pool.pendingInjects = pool.pendingInjects.filter(
          (t) => t > state.time + EPSILON,
        );
        pool.larvae = Math.min(
          pool.larvae + profile.mechanics.inject.larvae,
          19,
        );
        log(state, "inject", "LarvaeSpawned");
      }
      // "wake" needs no handling — reaching the loop is the point.
    }
  }

  if (state.supplyBlockedSince !== null) {
    state.supplyBlockedSec += state.time - state.supplyBlockedSince;
  }
  integrateIncome(
    state.eco,
    profile.economy,
    Math.min(state.time, opts.horizonSec),
  );
  sample(state, profile, true);
  unexecuted += done.filter((d) => !d).length;

  const unitsAtEnd: Record<string, number> = {};
  for (const [name, count] of state.completed) {
    if (count > 0) unitsAtEnd[name] = count;
  }
  const completionTimes: Record<string, number[]> = {};
  for (const [name, list] of state.completionTimes) {
    completionTimes[name] = list;
  }

  return {
    profileId: profile.id,
    race,
    steps: state.steps,
    events: state.events,
    samples: state.samples,
    endTime: round2(Math.min(state.time, opts.horizonSec)),
    finalMinerals: Math.round(state.eco.minerals),
    finalGas: Math.round(state.eco.gas),
    finalWorkers: countMineralWorkers(state.eco) + countGasWorkers(state.eco),
    finalSupplyUsed: Math.floor(state.supplyUsed),
    finalSupplyCap: Math.floor(state.supplyCap),
    unitsAtEnd,
    completionTimes,
    supplyBlockedSec: round2(state.supplyBlockedSec),
    unexecutedActions: unexecuted,
  };
}

/** Defaults shared by UI and optimizer. */
export function defaultPolicies(): MacroPolicies {
  return {
    autoWorkers: true,
    autoSupplyLeadSec: 20,
    autoChrono: "off",
    autoMule: true,
    autoInject: true,
    autoSaturateGas: true,
  };
}
