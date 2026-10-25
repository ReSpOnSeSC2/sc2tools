import { coerceSavedRules } from "./build-rules";
import { readReferenceBuildOrder } from "./buildOrderReference";
import { BUILD_TOKENS } from "./buildTokens";
import { fromBuildLog, MAX_GHOST_STEPS, normalizeGhostTarget, type GhostTarget } from "./ghostBuild";
const referenceTokens = new Map(BUILD_TOKENS.map(token => [token.token, token.race[0]]));
/** Unknown and untimed reference rows stay in the plan, but are never invented
 * as HUD checkpoints. Approximate supply is omitted from exact Ghost supply. */
export function referenceOrderPracticeTarget(name: string, input: unknown, race?: string): GhostTarget | null {
  const order = readReferenceBuildOrder(input);
  if (!order) return null;
  const steps = order.steps.filter(step => step.t !== null && step.t <= 14400 && referenceTokens.has(step.action) && (!race || referenceTokens.get(step.action) === race[0]))
    .slice(0, MAX_GHOST_STEPS).map(step => ({ t: step.t, supply: step.supplyApprox || step.supply !== null && step.supply > 200 ? null : step.supply, name: step.action.replace(/^(Build|Train|Research|Morph)(?=[A-Z])/, "") }));
  return normalizeGhostTarget({ v: 1, name, steps });
}

/** Only positive deadlines are useful checkpoints. Absence/max/not-before
 * constraints cannot honestly become a produced unit at a target time. */
export function ruleCheckpointTarget(name: string, input: unknown): GhostTarget | null {
  const raw = Array.isArray(input) ? input.slice(0, 30).filter(rule => rule && rule.proxy !== true && typeof rule.time_lt === "number" && Number.isFinite(rule.time_lt) && rule.time_lt >= 1 && rule.time_lt <= 1800) : [];
  const requirements = coerceSavedRules(raw).flatMap(rule => {
    if (rule.type !== "before" && rule.type !== "count_min" && rule.type !== "count_exact") return [];
    if (rule.proxy) return []; // The HUD cannot coach a location constraint.
    const count = rule.type === "before" ? 1 : rule.count;
    if (!Number.isFinite(count) || count < 1) return [];
    const entity = rule.name.replace(/^(Build|Train|Research|Morph)(?=[A-Z])/, "");
    if (!entity || entity.length > 48) return [];
    return [{ t: rule.time_lt, name: entity, count: Math.min(MAX_GHOST_STEPS, Math.floor(count)) }];
  }).sort((a, b) => a.t - b.t);
  const counts = new Map<string, number>();
  const steps: Array<{ supply: null; t: number; name: string }> = [];
  for (const requirement of requirements) {
    const have = counts.get(requirement.name) ?? 0;
    for (let n = have; n < requirement.count && steps.length < MAX_GHOST_STEPS; n++) steps.push({ supply: null, t: requirement.t, name: requirement.name });
    counts.set(requirement.name, Math.max(have, requirement.count));
  }
  return normalizeGhostTarget({ v: 1, name: `${name.slice(0, 65)} (checkpoints)`, steps });
}

export function replayOrderTarget(name: string, events: unknown, sourceGameId?: string): GhostTarget | null {
  if (!Array.isArray(events)) return null;
  const lines = events.slice(0, 5000).flatMap(event => {
    if (!event || typeof event.name !== "string") return [];
    const time = event.category === "upgrade" && Number.isFinite(event.complete_time) ? event.complete_time : event.time;
    if (typeof time !== "number" || !Number.isFinite(time) || time < 0 || time > 14400) return [];
    const seconds = Math.round(time);
    return [`[${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}] ${event.name}`];
  });
  return fromBuildLog(name, lines, { sourceGameId });
}

/** The reference API keeps up to250 steps; the overlay coaches an opening. */
export function referencePracticeTarget(input: unknown): GhostTarget | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  return normalizeGhostTarget({ ...raw, steps: Array.isArray(raw.steps) ? raw.steps.slice(0, MAX_GHOST_STEPS) : raw.steps });
}
