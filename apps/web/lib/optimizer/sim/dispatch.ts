/**
 * Action dispatch: try to start a build/train/research/morph/chrono/
 * transform action at the current sim time. Outcomes:
 *   - "done"       the action started; resources/supply were spent
 *   - "wait"       blocked on something that resolves later
 *                  (`retryAt` when the time is exactly computable)
 *   - "impossible" no structural path (missing tech with nothing in
 *                  progress) — the caller skips and penalizes
 */
import type { BuildAction, PatchProfile, SimRace, UnitDef } from "../types";
import {
  createBase,
  takeMineralWorkers,
  timeUntilAffordable,
} from "./income";
import {
  applyChronoToTask,
  energyReadyAt,
  pickProducer,
  prereqsMet,
  updateEnergy,
  type Producer,
} from "./production";
import {
  EPSILON,
  PROBE_BUILD_LOSS_SEC,
  bump,
  consumeLarva,
  log,
  pendingSupply,
  pickLarvaPool,
  recordStep,
  scheduleTask,
  spend,
  type SimState,
} from "./state";

export interface DispatchOutcome {
  status: "done" | "wait" | "impossible";
  retryAt?: number;
  reason?: string;
  /** What a "wait" is stuck on — drives the engine's lookahead. */
  blockedOn?: "resources" | "producer" | "tech" | "supply" | "larva";
}

function structuralPathExists(
  state: SimState,
  profile: PatchProfile,
  requires: string[] | undefined,
): boolean {
  if (!requires) return true;
  return requires.every((entry) =>
    entry.split("|").some((alt) => {
      if ((state.completed.get(alt) ?? 0) > 0) return true;
      if ((state.inProgress.get(alt) ?? 0) > 0) return true;
      if (state.upgradesDone.has(alt) || state.upgradesInProgress.has(alt)) {
        return true;
      }
      return false;
    }),
  );
}

export function tryDispatch(
  state: SimState,
  profile: PatchProfile,
  race: SimRace,
  action: BuildAction,
): DispatchOutcome {
  switch (action.kind) {
    case "build":
    case "train":
    case "morph":
      return dispatchUnit(state, profile, race, action.name);
    case "research":
      return dispatchResearch(state, profile, action.name);
    case "chrono":
      return dispatchChrono(state, profile, action.target ?? action.name);
    case "transform-warpgate":
      return dispatchTransform(state, profile);
  }
}

function dispatchUnit(
  state: SimState,
  profile: PatchProfile,
  race: SimRace,
  name: string,
): DispatchOutcome {
  const def = profile.units[name];
  if (!def) return { status: "impossible", reason: `unknown unit ${name}` };
  if (!structuralPathExists(state, profile, def.requires)) {
    return { status: "impossible", reason: `tech path missing for ${name}` };
  }
  if (!prereqsMet(def.requires, state.completed, state.upgradesDone)) {
    return { status: "wait", blockedOn: "tech" };
  }
  if (def.morphFrom) return dispatchMorph(state, profile, name, def);
  if (def.isStructure) {
    return dispatchStructure(state, profile, race, name, def);
  }
  return dispatchTrain(state, profile, name, def);
}

function checkSupply(
  state: SimState,
  profile: PatchProfile,
  needed: number,
): DispatchOutcome | null {
  if (needed <= 0) return null;
  if (state.supplyUsed + needed <= state.supplyCap + EPSILON) return null;
  const pending = pendingSupply(state, profile);
  if (state.supplyUsed + needed <= state.supplyCap + pending + EPSILON) {
    return { status: "wait", blockedOn: "supply" };
  }
  // No provider on the way — the caller's auto-supply policy (or an
  // explicit supply step later in the list) has to fix this.
  return { status: "wait", reason: "supply-blocked", blockedOn: "supply" };
}

function affordOutcome(
  state: SimState,
  profile: PatchProfile,
  minerals: number,
  gas: number,
): DispatchOutcome | null {
  if (
    state.eco.minerals >= minerals - EPSILON &&
    state.eco.gas >= gas - EPSILON
  ) {
    return null;
  }
  const at = timeUntilAffordable(
    state.eco,
    profile.economy,
    state.time,
    minerals,
    gas,
  );
  return {
    status: "wait",
    retryAt: Number.isFinite(at) ? at : undefined,
    blockedOn: "resources",
  };
}

export function dispatchStructure(
  state: SimState,
  profile: PatchProfile,
  race: SimRace,
  name: string,
  def: UnitDef,
): DispatchOutcome {
  const workerName = profile.starting.worker[race];
  if (def.isAddon) return dispatchAddon(state, profile, name, def);
  if ((state.completed.get(workerName) ?? 0) < 1) {
    return { status: "wait", blockedOn: "producer" };
  }
  if (def.isGasBuilding) {
    let open = 0;
    for (const base of state.eco.bases) {
      for (const geyser of base.geysers) if (!geyser.active) open += 1;
    }
    const inProgressGas = state.inProgress.get(name) ?? 0;
    if (open - inProgressGas <= 0) {
      return { status: "impossible", reason: "no open geysers" };
    }
  }
  const afford = affordOutcome(state, profile, def.minerals, def.gas);
  if (afford) return afford;

  spend(state, def.minerals, def.gas);
  if (race === "Zerg") {
    // Drone is consumed: worker gone, its supply freed.
    takeMineralWorkers(state.eco, 1);
    bump(state.completed, workerName, -1);
    state.supplyUsed -= profile.units[workerName].supply;
  } else if (race === "Terran") {
    takeMineralWorkers(state.eco, 1);
    state.queue.push(state.time + def.buildTime, {
      type: "builder-return",
      count: 1,
    });
  } else {
    takeMineralWorkers(state.eco, 1);
    state.queue.push(state.time + PROBE_BUILD_LOSS_SEC, {
      type: "builder-return",
      count: 1,
    });
  }

  const doneAt = state.time + def.buildTime;
  let baseId: number | undefined;
  if (def.isTownHall) {
    baseId = state.eco.bases.length;
    state.eco.bases.push(createBase(baseId, profile.economy, false));
  }
  const producer: Producer = {
    id: state.nextId++,
    name,
    readyAt: doneAt,
    busyUntil: 0,
    reactorBusyUntil: 0,
    addon: null,
    isWarpgate: false,
    chronoUntil: 0,
    baseId: baseId ?? null,
  };
  state.producers.push(producer);
  bump(state.inProgress, name, 1);
  recordStep(state, "build", name, doneAt);
  log(state, "start", name);
  scheduleTask(state, {
    completeAt: doneAt,
    kind: "structure",
    name,
    def,
    newProducerId: producer.id,
    baseId,
    count: 1,
    startedAt: state.time,
  });
  return { status: "done" };
}

function dispatchAddon(
  state: SimState,
  profile: PatchProfile,
  name: string,
  def: UnitDef,
): DispatchOutcome {
  const parent = pickProducer(state.producers, def, state.time);
  if (!parent) {
    const anyBuilding = def.builtFrom.some(
      (b) => (state.inProgress.get(b) ?? 0) > 0,
    );
    return anyBuilding
      ? { status: "wait", blockedOn: "producer" }
      : { status: "impossible", reason: `no ${def.builtFrom.join("/")}` };
  }
  if (parent.producer.addon) {
    return {
      status: "impossible",
      reason: `${parent.producer.name} has addon`,
    };
  }
  if (parent.startAt > state.time + EPSILON) {
    return { status: "wait", retryAt: parent.startAt, blockedOn: "producer" };
  }
  const afford = affordOutcome(state, profile, def.minerals, def.gas);
  if (afford) return afford;
  spend(state, def.minerals, def.gas);
  const doneAt = state.time + def.buildTime;
  parent.producer.busyUntil = doneAt;
  bump(state.inProgress, name, 1);
  recordStep(state, "build", name, doneAt);
  log(state, "start", name);
  scheduleTask(state, {
    completeAt: doneAt,
    kind: "structure",
    name,
    def,
    producerId: parent.producer.id,
    count: 1,
    startedAt: state.time,
  });
  return { status: "done" };
}

export function dispatchTrain(
  state: SimState,
  profile: PatchProfile,
  name: string,
  def: UnitDef,
): DispatchOutcome {
  const count = def.pairTrained ? 2 : 1;
  const supplyNeed = def.supply * count;
  const supplyIssue = checkSupply(state, profile, supplyNeed);
  if (supplyIssue) return supplyIssue;
  const minerals = def.minerals * count;
  const gas = def.gas * count;

  if (def.consumesLarva) {
    const pool = pickLarvaPool(state);
    if (!pool) return { status: "wait", blockedOn: "larva" };
    const afford = affordOutcome(state, profile, minerals, gas);
    if (afford) return afford;
    spend(state, minerals, gas);
    consumeLarva(state, profile, pool);
    state.supplyUsed += supplyNeed;
    const doneAt = state.time + def.buildTime;
    bump(state.inProgress, name, count);
    recordStep(state, "train", name, doneAt);
    log(state, "start", name);
    scheduleTask(state, {
      completeAt: doneAt,
      kind: "unit",
      name,
      def,
      count,
      startedAt: state.time,
    });
    return { status: "done" };
  }

  const pick = pickProducer(state.producers, def, state.time);
  if (!pick) {
    const anyComing = def.builtFrom.some(
      (b) => (state.inProgress.get(b) ?? 0) > 0,
    );
    // A tech-lab-gated unit is also "coming" while the addon builds.
    const addonComing =
      def.requiresAddon &&
      def.builtFrom.some(
        (b) => (state.inProgress.get(`${b}TechLab`) ?? 0) > 0,
      );
    return anyComing || addonComing
      ? { status: "wait", blockedOn: "producer" }
      : { status: "impossible", reason: `no producer for ${name}` };
  }
  if (pick.startAt > state.time + EPSILON) {
    return { status: "wait", retryAt: pick.startAt, blockedOn: "producer" };
  }
  const afford = affordOutcome(state, profile, minerals, gas);
  if (afford) return afford;
  spend(state, minerals, gas);
  state.supplyUsed += supplyNeed;

  const wg = profile.mechanics.warpgate;
  let doneAt: number;
  if (pick.producer.isWarpgate) {
    const cooldown = wg.cooldowns[name] ?? def.buildTime;
    doneAt = state.time + wg.warpInSec;
    pick.producer.busyUntil = applyChronoToTask(
      state.time,
      state.time + cooldown,
      Math.max(0, pick.producer.chronoUntil - state.time),
      profile.mechanics.chrono.rateMultiplier,
    );
  } else {
    let duration = def.buildTime;
    if (pick.producer.name === "Gateway" && state.warpgateDone) {
      duration /= wg.gatewaySpeedMultiplier;
    }
    doneAt = applyChronoToTask(
      state.time,
      state.time + duration,
      Math.max(0, pick.producer.chronoUntil - state.time),
      profile.mechanics.chrono.rateMultiplier,
    );
    if (pick.viaReactor) pick.producer.reactorBusyUntil = doneAt;
    else pick.producer.busyUntil = doneAt;
  }
  bump(state.inProgress, name, count);
  recordStep(state, "train", name, doneAt);
  log(state, "start", name);
  scheduleTask(state, {
    completeAt: doneAt,
    kind: "unit",
    name,
    def,
    producerId: pick.producer.id,
    viaReactor: pick.viaReactor,
    count,
    startedAt: state.time,
  });
  return { status: "done" };
}

function dispatchMorph(
  state: SimState,
  profile: PatchProfile,
  name: string,
  def: UnitDef,
): DispatchOutcome {
  const source = def.morphFrom!;
  const sourceDef = profile.units[source];
  const supplyDelta =
    def.supply * (def.pairTrained ? 2 : 1) - sourceDef.supply;
  const supplyIssue = checkSupply(state, profile, supplyDelta);
  if (supplyIssue) return supplyIssue;

  if (sourceDef.isStructure) {
    const producer = state.producers.find(
      (p) =>
        p.name === source &&
        p.readyAt <= state.time + EPSILON &&
        p.busyUntil <= state.time + EPSILON,
    );
    if (!producer) {
      const exists =
        (state.completed.get(source) ?? 0) > 0 ||
        (state.inProgress.get(source) ?? 0) > 0;
      return exists
        ? { status: "wait", blockedOn: "producer" }
        : { status: "impossible", reason: `no ${source} to morph` };
    }
    const afford = affordOutcome(state, profile, def.minerals, def.gas);
    if (afford) return afford;
    spend(state, def.minerals, def.gas);
    const doneAt = state.time + def.buildTime;
    producer.busyUntil = doneAt;
    bump(state.inProgress, name, 1);
    recordStep(state, "morph", name, doneAt);
    log(state, "start", name);
    scheduleTask(state, {
      completeAt: doneAt,
      kind: "morph",
      name,
      def,
      producerId: producer.id,
      morphSource: source,
      count: 1,
      startedAt: state.time,
    });
    return { status: "done" };
  }

  if ((state.completed.get(source) ?? 0) < 1) {
    const coming = (state.inProgress.get(source) ?? 0) > 0;
    return coming
      ? { status: "wait", blockedOn: "producer" }
      : { status: "impossible", reason: `no ${source} to morph` };
  }
  const afford = affordOutcome(state, profile, def.minerals, def.gas);
  if (afford) return afford;
  spend(state, def.minerals, def.gas);
  bump(state.completed, source, -1);
  state.supplyUsed += supplyDelta;
  const doneAt = state.time + def.buildTime;
  bump(state.inProgress, name, 1);
  recordStep(state, "morph", name, doneAt);
  log(state, "start", name);
  scheduleTask(state, {
    completeAt: doneAt,
    kind: "morph",
    name,
    def,
    morphSource: source,
    count: 1,
    startedAt: state.time,
  });
  return { status: "done" };
}

function dispatchResearch(
  state: SimState,
  profile: PatchProfile,
  name: string,
): DispatchOutcome {
  const def = profile.upgrades[name];
  if (!def) return { status: "impossible", reason: `unknown upgrade ${name}` };
  if (state.upgradesDone.has(name) || state.upgradesInProgress.has(name)) {
    return { status: "done" };
  }
  if (!structuralPathExists(state, profile, def.requires)) {
    return { status: "impossible", reason: `tech path missing for ${name}` };
  }
  if (!prereqsMet(def.requires, state.completed, state.upgradesDone)) {
    return { status: "wait", blockedOn: "tech" };
  }
  // Non-blocking research runs alongside the structure's production
  // queue, so any completed lab qualifies even mid-task.
  const lab = state.producers.find(
    (p) =>
      def.researchedAt.includes(p.name) &&
      p.readyAt <= state.time + EPSILON &&
      (def.nonBlocking || p.busyUntil <= state.time + EPSILON),
  );
  if (!lab) {
    const anyComing = def.researchedAt.some(
      (b) =>
        (state.inProgress.get(b) ?? 0) > 0 ||
        (state.completed.get(b) ?? 0) > 0,
    );
    return anyComing
      ? { status: "wait", blockedOn: "producer" }
      : { status: "impossible", reason: `nowhere to research ${name}` };
  }
  const afford = affordOutcome(state, profile, def.minerals, def.gas);
  if (afford) return afford;
  spend(state, def.minerals, def.gas);
  const doneAt = applyChronoToTask(
    state.time,
    state.time + def.researchTime,
    Math.max(0, lab.chronoUntil - state.time),
    profile.mechanics.chrono.rateMultiplier,
  );
  if (!def.nonBlocking) lab.busyUntil = doneAt;
  state.upgradesInProgress.add(name);
  recordStep(state, "research", name, doneAt);
  log(state, "start", name);
  scheduleTask(state, {
    completeAt: doneAt,
    kind: "upgrade",
    name,
    producerId: lab.id,
    count: 1,
    startedAt: state.time,
  });
  return { status: "done" };
}

function dispatchChrono(
  state: SimState,
  profile: PatchProfile,
  targetName: string,
): DispatchOutcome {
  const mech = profile.mechanics;
  const nexus = state.casters
    .filter((c) => c.kind === profile.starting.townHall.Protoss)
    .map((c) => {
      updateEnergy(c, state.time, mech.energyRegenPerSec, mech.maxEnergy);
      return c;
    })
    .sort((a, b) => b.energy - a.energy)[0];
  if (!nexus) return { status: "impossible", reason: "no nexus" };
  if (nexus.energy < mech.chrono.energy) {
    return {
      status: "wait",
      blockedOn: "producer",
      retryAt: energyReadyAt(
        nexus,
        state.time,
        mech.chrono.energy,
        mech.energyRegenPerSec,
      ),
    };
  }
  const target = state.producers
    .filter((p) => p.name === targetName && p.readyAt <= state.time)
    .sort((a, b) => b.busyUntil - a.busyUntil)[0];
  if (!target) return { status: "wait", blockedOn: "producer" };
  nexus.energy -= mech.chrono.energy;
  applyChrono(state, profile, target);
  return { status: "done" };
}

export function applyChrono(
  state: SimState,
  profile: PatchProfile,
  target: Producer,
): void {
  const mech = profile.mechanics;
  target.chronoUntil =
    Math.max(target.chronoUntil, state.time) + mech.chrono.durationSec;
  for (const task of state.tasks.values()) {
    if (task.producerId !== target.id) continue;
    if (task.kind !== "unit" && task.kind !== "upgrade") continue;
    const next = applyChronoToTask(
      state.time,
      task.completeAt,
      mech.chrono.durationSec,
      mech.chrono.rateMultiplier,
    );
    if (next < task.completeAt - EPSILON) {
      task.completeAt = next;
      state.queue.push(next, { type: "task-complete", taskId: task.id });
      if (task.viaReactor) target.reactorBusyUntil = next;
      else target.busyUntil = next;
    }
  }
  log(state, "chrono", target.name);
}

function dispatchTransform(
  state: SimState,
  profile: PatchProfile,
): DispatchOutcome {
  if (!state.warpgateDone) {
    return state.upgradesInProgress.has("WarpGateResearch")
      ? { status: "wait", blockedOn: "tech" }
      : { status: "impossible", reason: "warpgate not researched" };
  }
  const wg = profile.mechanics.warpgate;
  const gateway = state.producers.find(
    (p) =>
      p.name === "Gateway" &&
      !p.isWarpgate &&
      p.readyAt <= state.time + EPSILON &&
      p.busyUntil <= state.time + EPSILON,
  );
  if (!gateway) {
    const any = state.producers.some((p) => p.name === "Gateway");
    return any
      ? { status: "wait", blockedOn: "producer" }
      : { status: "impossible", reason: "no gateway" };
  }
  const afford = affordOutcome(
    state,
    profile,
    wg.transformCost.minerals,
    wg.transformCost.gas,
  );
  if (afford) return afford;
  spend(state, wg.transformCost.minerals, wg.transformCost.gas);
  const doneAt = state.time + wg.transformTime;
  gateway.busyUntil = doneAt;
  recordStep(state, "transform-warpgate", "WarpGate", doneAt);
  log(state, "start", "WarpGate");
  scheduleTask(state, {
    completeAt: doneAt,
    kind: "transform",
    name: "WarpGate",
    producerId: gateway.id,
    count: 1,
    startedAt: state.time,
  });
  return { status: "done" };
}
