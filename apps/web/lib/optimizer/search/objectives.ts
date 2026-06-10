/**
 * Objective scorers built from three concave axis scores — economy,
 * tech, army — so optimizing any objective still "threads" all three:
 * diminishing returns mean the marginal fitness point always flows
 * toward whichever axis is lagging, and a corner solution (mass
 * economy with zero tech, or vice versa) scores worse than a real
 * macro opening. Safety is NOT an axis: it stays a hard hinge
 * constraint in the optimizer's fitness (see optimize.ts).
 *
 * Tech is valued by data-driven depth: a structure's tier is its
 * distance up the patch profile's prerequisite graph, so the scorer
 * works for all races and survives balance patches without edits.
 */
import type {
  ObjectiveSpec,
  PatchProfile,
  SimRace,
  SimResult,
  UnitDef,
} from "../types";

export interface ObjectiveOption {
  id: ObjectiveSpec["id"];
  label: string;
  description: string;
  usesAtSec: boolean;
}

export const OBJECTIVES: ObjectiveOption[] = [
  {
    id: "balanced-development",
    label: "Balanced macro (eco + tech + army)",
    description:
      "A standard-game opening: grow workers and bases, climb the tech tree, and field an army — all while holding every selected threat.",
    usesAtSec: true,
  },
  {
    id: "tech-rush-target",
    label: "Reach a tech goal fast",
    description:
      "Hit a chosen tech milestone (structure, upgrade, or unit) as early as possible while keeping workers flowing and every selected threat held.",
    usesAtSec: true,
  },
  {
    id: "earliest-safe-expansion",
    label: "Earliest safe expansion",
    description:
      "Finish your second town hall as early as possible while holding every selected threat. Tech and army still count, just less.",
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

/* ------------------------------------------------------------------ */
/* Axis scores                                                         */
/* ------------------------------------------------------------------ */

function workersAt(sim: SimResult, profile: PatchProfile, t: number): number {
  let total = profile.starting.workers;
  for (const [name, times] of Object.entries(sim.completionTimes)) {
    if (!profile.units[name]?.isWorker) continue;
    for (const doneAt of times) if (doneAt <= t) total += 1;
  }
  return total;
}

/**
 * Time-weighted expansion credit: a town hall is worth its mining
 * time, so a natural finished at 2:30 scores far more than one
 * squeezed in just before the evaluation point. First two
 * expansions only — beyond that it's the float penalty's job.
 */
function expansionCreditAt(
  sim: SimResult,
  profile: PatchProfile,
  t: number,
): number {
  const completions: number[] = [];
  for (const [name, times] of Object.entries(sim.completionTimes)) {
    const def = profile.units[name];
    if (!def?.isTownHall || def.morphFrom) continue;
    for (const doneAt of times) if (doneAt <= t) completions.push(doneAt);
  }
  completions.sort((a, b) => a - b);
  let credit = 0;
  for (const doneAt of completions.slice(0, 2)) {
    credit += 30 * Math.min(1, Math.max(0, (t - doneAt) / 240));
  }
  return credit;
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
 * Tech tier of a structure = depth up the prerequisite graph
 * (Gateway 1 → Cybernetics Core 2 → Robo/Stargate/Twilight 3 → …).
 * Morph chains count too (Pool 1 → Lair 2 → Hive 4 via pit).
 */
function techTier(
  profile: PatchProfile,
  name: string,
  memo: Map<string, number>,
  depth = 0,
): number {
  const cached = memo.get(name);
  if (cached !== undefined) return cached;
  if (depth > 8) return 0;
  const def = profile.units[name];
  if (!def?.isStructure) return 0;
  memo.set(name, 0); // cycle guard
  let parent = 0;
  const ancestors = [...(def.requires ?? []), def.morphFrom ?? ""];
  for (const entry of ancestors) {
    if (!entry) continue;
    for (const alt of entry.split("|")) {
      if (isTechStructure(profile, alt)) {
        parent = Math.max(parent, techTier(profile, alt, memo, depth + 1));
      }
    }
  }
  const tier = parent + 1;
  memo.set(name, tier);
  return tier;
}

/** Structures that represent tech progress (not eco/supply/defense). */
function isTechStructure(profile: PatchProfile, name: string): boolean {
  const def: UnitDef | undefined = profile.units[name];
  if (!def?.isStructure || def.isGasBuilding) return false;
  // static defense is safety, not tech
  if (def.combat?.isStatic && ((def.combat.dpsGround ?? 0) > 0 || (def.combat.dpsAir ?? 0) > 0)) {
    return false;
  }
  // supply providers and base town halls are economy; morphed town
  // halls (Lair, Hive, Orbital) ARE tech milestones
  if ((def.providesSupply ?? 0) > 0 && !def.morphFrom) return false;
  return true;
}

/** Weight of a completed tech structure nothing has used yet. */
const UNUSED_TECH_WEIGHT = 0.4;

function techScoreAt(sim: SimResult, profile: PatchProfile, t: number): number {
  const memo = new Map<string, number>();
  // Names completed by t — used to check whether a tech structure
  // actually enabled something (a unit trained from it, a structure
  // or upgrade gated behind it). Tech breadth for its own sake (an
  // empty stargate next to an empty twilight) is mostly posturing,
  // so unused structures only score a fraction of their tier.
  const completedByT = new Set<string>();
  for (const [name, times] of Object.entries(sim.completionTimes)) {
    if (times.some((doneAt) => doneAt <= t)) completedByT.add(name);
  }
  const usedStructures = new Set<string>();
  const markUse = (entries: (string | undefined)[]) => {
    for (const entry of entries) {
      if (!entry) continue;
      for (const alt of entry.split("|")) usedStructures.add(alt);
    }
  };
  for (const name of completedByT) {
    const def = profile.units[name];
    if (def) markUse([...(def.requires ?? []), ...def.builtFrom, def.morphFrom]);
    const upgrade = profile.upgrades[name];
    if (upgrade) markUse([...(upgrade.requires ?? []), ...upgrade.researchedAt]);
  }

  let score = 0;
  for (const name of completedByT) {
    const upgrade = profile.upgrades[name];
    if (upgrade) {
      // upgrade value scales with its research investment
      score += upgrade.researchTime / 10;
      continue;
    }
    if (!isTechStructure(profile, name)) continue;
    // distinct structures only — a second gateway is production, not tech
    const tier = 7 * techTier(profile, name, memo);
    score += usedStructures.has(name) ? tier : tier * UNUSED_TECH_WEIGHT;
  }
  return score;
}

export interface TechTargetOption {
  name: string;
  kind: "structure" | "upgrade" | "unit";
  tier: number;
}

/**
 * Candidate tech goals for the "reach a tech goal fast" objective,
 * derived from the patch profile so the list survives balance
 * patches: tech structures (with morphs like Lair/Orbital), every
 * race upgrade, and units gated behind tech or addons.
 */
export function listTechTargets(
  profile: PatchProfile,
  race: SimRace,
): TechTargetOption[] {
  const memo = new Map<string, number>();
  const out: TechTargetOption[] = [];
  for (const [name, def] of Object.entries(profile.units)) {
    if (def.race !== race) continue;
    if (def.isStructure) {
      if (isTechStructure(profile, name)) {
        out.push({ name, kind: "structure", tier: techTier(profile, name, memo) });
      }
      continue;
    }
    if ((def.requires?.length ?? 0) > 0 || def.requiresAddon) {
      const gates = (def.requires ?? []).map((entry) =>
        techTier(profile, entry.split("|")[0], memo),
      );
      out.push({ name, kind: "unit", tier: Math.max(1, ...gates) + 1 });
    }
  }
  for (const [name, def] of Object.entries(profile.upgrades)) {
    if (def.race !== race) continue;
    const at = techTier(profile, def.researchedAt[0], memo);
    out.push({ name, kind: "upgrade", tier: at + 1 });
  }
  out.sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name));
  return out;
}

export interface AxisScores {
  econ: number;
  tech: number;
  army: number;
  floatPenalty: number;
}

/** The three concave axis scores at time `t`, on comparable scales. */
export function axisScores(
  sim: SimResult,
  profile: PatchProfile,
  t: number,
): AxisScores {
  const workers = workersAt(sim, profile, t);
  const econ =
    10 * Math.sqrt(workers) + expansionCreditAt(sim, profile, t);
  const tech = techScoreAt(sim, profile, t);
  const army = 1.2 * Math.sqrt(armyValueAt(sim, profile, t));
  // Mild, capped — strong float penalties teach the search to dump
  // money into useless structures instead of banking it. Gas counts
  // too, or the search over-builds collectors it never spends from.
  const floatPenalty = Math.min(
    60,
    Math.max(0, sim.finalMinerals - 600) * 0.02 +
      Math.max(0, sim.finalGas - 300) * 0.03,
  );
  return { econ, tech, army, floatPenalty };
}

/* ------------------------------------------------------------------ */
/* Objectives                                                          */
/* ------------------------------------------------------------------ */

function secondTownHallTime(
  sim: SimResult,
  profile: PatchProfile,
): number | null {
  const completions: number[] = [];
  for (const [name, times] of Object.entries(sim.completionTimes)) {
    const def = profile.units[name];
    if (!def?.isTownHall || def.morphFrom) continue;
    completions.push(...times);
  }
  completions.sort((a, b) => a - b);
  // the starting town hall never appears in completionTimes, so the
  // first completion IS the expansion
  return completions.length > 0 ? completions[0] : null;
}

/**
 * Score a sim under an objective. Every objective blends in the off-
 * axis scores at reduced weight so no output degenerates into a
 * single-axis corner build.
 */
export function objectiveScore(
  sim: SimResult,
  profile: PatchProfile,
  objective: ObjectiveSpec,
): number {
  const t = Math.min(objective.atSec, sim.endTime);
  const axes = axisScores(sim, profile, t);
  switch (objective.id) {
    case "balanced-development":
      return axes.econ + axes.tech + axes.army - axes.floatPenalty;
    case "tech-rush-target": {
      const target = objective.targetName ?? "";
      const doneAt = (sim.completionTimes[target] ?? [])[0];
      // Each second earlier is a point — the same currency as the
      // halved axis scores, so the search trades real shortcuts
      // (cutting a wasted structure, better chrono use) but won't
      // strip the economy to zero for a marginal tech timing.
      const focus = doneAt === undefined ? -500 : 700 - doneAt;
      return (
        focus +
        0.5 * (axes.econ + axes.tech + axes.army) -
        axes.floatPenalty
      );
    }
    case "earliest-safe-expansion": {
      const expandAt = secondTownHallTime(sim, profile);
      const focus =
        expandAt === null ? -500 : 600 - expandAt;
      return (
        focus +
        0.5 * (axes.econ + axes.tech + axes.army) -
        axes.floatPenalty
      );
    }
    case "max-workers-at-t":
      return (
        workersAt(sim, profile, t) * 10 +
        0.35 * (axes.tech + axes.army) -
        axes.floatPenalty
      );
    case "max-army-value-at-t":
      return (
        armyValueAt(sim, profile, t) * 0.1 +
        0.35 * (axes.econ + axes.tech) -
        axes.floatPenalty
      );
  }
}
