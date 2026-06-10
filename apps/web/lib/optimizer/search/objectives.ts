/**
 * Objective scorers. Higher is better; scores are roughly normalized
 * so the safety penalty (see optimize.ts) dominates when a build is
 * actually unsafe.
 */
import type { ObjectiveSpec, PatchProfile, SimResult } from "../types";

export interface ObjectiveOption {
  id: ObjectiveSpec["id"];
  label: string;
  description: string;
  usesAtSec: boolean;
}

export const OBJECTIVES: ObjectiveOption[] = [
  {
    id: "earliest-safe-expansion",
    label: "Earliest safe expansion",
    description:
      "Finish your second town hall as early as possible while holding every selected threat.",
    usesAtSec: false,
  },
  {
    id: "max-workers-at-t",
    label: "Max workers at time T",
    description:
      "Greedy economy: the most workers on the line at the target time.",
    usesAtSec: true,
  },
  {
    id: "max-army-value-at-t",
    label: "Max army value at time T",
    description:
      "Strongest army (minerals + gas of completed combat units) at the target time.",
    usesAtSec: true,
  },
];

function secondTownHallTime(
  sim: SimResult,
  profile: PatchProfile,
): number | null {
  const names = Object.entries(profile.units)
    .filter(([, def]) => def.isTownHall && !def.morphFrom)
    .map(([name]) => name);
  const completions: number[] = [];
  for (const name of names) {
    for (const t of sim.completionTimes[name] ?? []) completions.push(t);
  }
  completions.sort((a, b) => a - b);
  // the starting town hall never appears in completionTimes, so the
  // first completion IS the expansion
  return completions.length > 0 ? completions[0] : null;
}

function workersAt(sim: SimResult, profile: PatchProfile, t: number): number {
  let total = profile.starting.workers;
  for (const [name, times] of Object.entries(sim.completionTimes)) {
    if (!profile.units[name]?.isWorker) continue;
    for (const doneAt of times) if (doneAt <= t) total += 1;
  }
  return total;
}

function armyValueAt(sim: SimResult, profile: PatchProfile, t: number): number {
  let total = 0;
  for (const [name, times] of Object.entries(sim.completionTimes)) {
    const def = profile.units[name];
    if (!def || def.isWorker || def.isStructure || !def.combat) continue;
    for (const doneAt of times) {
      if (doneAt <= t) total += def.minerals + def.gas;
    }
  }
  return total;
}

/**
 * Score a sim under an objective. All objectives include small
 * economy tie-breakers so equally-scored builds prefer more workers
 * and less floated money.
 */
export function objectiveScore(
  sim: SimResult,
  profile: PatchProfile,
  objective: ObjectiveSpec,
): number {
  const horizonWorkers = workersAt(sim, profile, sim.endTime);
  // Mild, capped — strong float penalties teach the search to dump
  // money into useless structures instead of banking it.
  const floatPenalty = Math.min(
    30,
    Math.max(0, sim.finalMinerals - 600) * 0.02,
  );
  switch (objective.id) {
    case "earliest-safe-expansion": {
      const expandAt = secondTownHallTime(sim, profile);
      if (expandAt === null) return -500 + horizonWorkers - floatPenalty;
      // every second earlier is a point; workers tiebreak
      return 600 - expandAt + horizonWorkers * 0.5 - floatPenalty;
    }
    case "max-workers-at-t":
      return (
        workersAt(sim, profile, objective.atSec) * 10 -
        floatPenalty +
        armyValueAt(sim, profile, objective.atSec) * 0.001
      );
    case "max-army-value-at-t":
      return (
        armyValueAt(sim, profile, objective.atSec) * 0.1 +
        workersAt(sim, profile, objective.atSec) * 0.5 -
        floatPenalty
      );
  }
}
