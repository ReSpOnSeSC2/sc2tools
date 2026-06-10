/**
 * (μ+λ) evolutionary search over build-order action sequences with an
 * annealed acceptance schedule.
 *
 * Fitness = objective score − Σ p(threat)·hinge(safety margin) −
 * execution penalties (supply-blocked seconds, dead actions). The
 * safety hinge is scaled so an unsafe build can never out-score a
 * safe one — "safest way to expand" means safety is a constraint,
 * not a preference.
 *
 * Pure module: no Worker APIs, no DOM — directly testable in vitest
 * and driven by the worker shell in ../worker/.
 */
import { mulberry32 } from "@/lib/randomizer/engine";
import { resolveProfile } from "../patch/profiles";
import { UNSAFE_MARGIN, evaluateSafety } from "../safety/evaluate";
import { simulate } from "../sim/engine";
import type {
  BuildAction,
  OptimizeProgress,
  OptimizeRequest,
  OptimizeResult,
  PatchProfile,
  SafetyReport,
  SimResult,
} from "../types";
import { objectiveScore } from "./objectives";
import { crossover, mutate, repair, type Rng } from "./mutate";
import { actionForName, seedsForRace } from "./seeds";

const MU = 12;
const LAMBDA = 36;
const MAX_ACTIONS = 40;
/** Per-unit-of-probability penalty scale for unsafe margins. */
const SAFETY_PENALTY_SCALE = 900;
/** Flat probability-weighted penalty for an outright unsafe verdict. */
const UNSAFE_FLAT_PENALTY = 400;
const SUPPLY_BLOCK_PENALTY_PER_SEC = 1.5;
const DEAD_ACTION_PENALTY = 40;
/** Slight pressure toward shorter builds so junk steps get deleted. */
const ACTION_LENGTH_PENALTY = 0.6;

export interface Candidate {
  actions: BuildAction[];
  score: number;
  sim: SimResult;
  safety: SafetyReport;
}

export interface OptimizeHooks {
  /** Called after every generation. */
  onProgress?: (progress: OptimizeProgress) => void;
  /** Return true to stop; best-so-far is returned. */
  shouldCancel?: () => boolean;
  /** Yield between generations (worker uses a macrotask). */
  yieldBetweenGenerations?: () => Promise<void>;
}

function hinge(margin: number, safeAt: number): number {
  return Math.max(0, safeAt - margin);
}

/**
 * Margin the optimizer must reach against a threat, scaled by its
 * probability. A scouted-likely threat (p ≥ 0.6) demands the full
 * safe margin; a baseline-prior threat only demands "not disastrous".
 * Demanding full safety against every 6-15% prior simultaneously
 * made the search buy maximum insurance (mass cheap units) and
 * starve tech/economy — real players hedge proportionately.
 */
function requiredMargin(probability: number): number {
  const t = Math.min(1, probability / 0.6);
  return -0.1 + t * 0.3; // -0.1 → +0.2 as p goes 0 → 0.6
}

export function evaluateCandidate(
  actions: BuildAction[],
  profile: PatchProfile,
  request: OptimizeRequest,
): Candidate {
  const sim = simulate(actions, profile, request.race, {
    horizonSec: request.horizonSec,
    policies: request.policies,
  });
  const safety = evaluateSafety(sim, profile, request.threats, request.safety);
  let penalty = 0;
  for (const report of safety.threats) {
    penalty +=
      report.probability *
      hinge(report.worstMargin, requiredMargin(report.probability)) *
      SAFETY_PENALTY_SCALE;
    // Hedging below the full safe margin is a legitimate trade for a
    // low-probability threat; being outright DEAD to it is not. The
    // flat term makes "unsafe" verdicts bite even at small priors.
    if (report.worstMargin < UNSAFE_MARGIN) {
      penalty += report.probability * UNSAFE_FLAT_PENALTY;
    }
  }
  penalty += sim.supplyBlockedSec * SUPPLY_BLOCK_PENALTY_PER_SEC;
  penalty += sim.unexecutedActions * DEAD_ACTION_PENALTY;
  penalty += actions.length * ACTION_LENGTH_PENALTY;
  const score = objectiveScore(sim, profile, request.objective) - penalty;
  return { actions, score, sim, safety };
}

function summarize(candidate: Candidate): string {
  const expansion = candidate.sim.steps.find(
    (s) =>
      s.kind === "build" &&
      ["Nexus", "CommandCenter", "Hatchery"].includes(s.name),
  );
  const verdict = candidate.safety.overall;
  const expandText = expansion
    ? `expand @ ${Math.round(expansion.doneSec)}s`
    : "no expansion";
  return `${verdict} · ${expandText} · ${candidate.sim.finalWorkers} workers`;
}

function seedPopulation(
  profile: PatchProfile,
  request: OptimizeRequest,
  rng: Rng,
): Candidate[] {
  const seeds = seedsForRace(request.race);
  // Tech-goal runs start every seed already on the target's tech
  // path (repair injects the prerequisite chain) — the search then
  // optimizes the timing instead of having to discover the goal.
  const target = request.objective.targetName;
  if (request.objective.id === "tech-rush-target" && target) {
    const action = actionForName(profile, target);
    if (action) {
      for (const seed of seeds) {
        if (!seed.some((a) => a.name === target)) seed.push({ ...action });
      }
    }
  }
  const population: Candidate[] = [];
  for (const seed of seeds) {
    const repaired = repair(seed, profile, request.race, MAX_ACTIONS);
    population.push(evaluateCandidate(repaired, profile, request));
  }
  // jittered variants of each seed fill the rest of μ
  while (population.length < MU) {
    const parent = population[population.length % seeds.length];
    const child = repair(
      mutate(parent.actions, request.race, rng),
      profile,
      request.race,
      MAX_ACTIONS,
    );
    population.push(evaluateCandidate(child, profile, request));
  }
  return population;
}

export async function optimize(
  request: OptimizeRequest,
  hooks: OptimizeHooks = {},
): Promise<OptimizeResult> {
  const profile = resolveProfile(request.profileId);
  const rng = mulberry32(request.seed);
  const startedAt = Date.now();
  let evaluations = 0;

  let population = seedPopulation(profile, request, rng);
  evaluations += population.length;
  population.sort((a, b) => b.score - a.score);
  let best = population[0];
  let generation = 0;

  const budgetExceeded = () =>
    generation >= request.budget.maxGenerations ||
    Date.now() - startedAt >= request.budget.maxMillis;

  while (!budgetExceeded()) {
    if (hooks.shouldCancel?.()) break;
    generation += 1;
    const temperature = Math.max(
      0.05,
      1 - generation / request.budget.maxGenerations,
    );
    const children: Candidate[] = [];
    for (let i = 0; i < LAMBDA; i += 1) {
      const parentA = population[Math.floor(rng() * population.length)];
      let childActions: BuildAction[];
      if (rng() < 0.15) {
        const parentB = population[Math.floor(rng() * population.length)];
        childActions = crossover(parentA.actions, parentB.actions, rng);
      } else {
        childActions = mutate(parentA.actions, request.race, rng);
      }
      // occasionally stack a second mutation while the search is hot
      if (rng() < temperature * 0.5) {
        childActions = mutate(childActions, request.race, rng);
      }
      const repaired = repair(childActions, profile, request.race, MAX_ACTIONS);
      children.push(evaluateCandidate(repaired, profile, request));
      evaluations += 1;
    }
    // annealed (μ+λ): children may displace better parents while hot
    const pool = [...population, ...children];
    pool.sort((a, b) => b.score - a.score);
    const survivors: Candidate[] = pool.slice(0, MU);
    for (let i = MU; i < pool.length && temperature > 0.3; i += 1) {
      const slot = Math.floor(rng() * survivors.length);
      const challenger = pool[i];
      const delta = challenger.score - survivors[slot].score;
      if (delta > 0) continue;
      const acceptProbability = Math.exp(delta / (temperature * 50));
      if (rng() < acceptProbability * 0.2) survivors[slot] = challenger;
    }
    population = survivors;
    if (population[0].score > best.score) best = population[0];

    hooks.onProgress?.({
      generation,
      evaluations,
      bestScore: Math.round(best.score * 100) / 100,
      bestSummary: summarize(best),
    });
    if (hooks.yieldBetweenGenerations) await hooks.yieldBetweenGenerations();
  }

  return {
    actions: best.actions,
    sim: best.sim,
    safety: best.safety,
    score: Math.round(best.score * 100) / 100,
    generations: generation,
    evaluations,
    seed: request.seed,
    objective: request.objective,
    profileId: request.profileId,
  };
}
