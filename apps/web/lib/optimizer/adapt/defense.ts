/**
 * Defense-aware adaptation guard.
 *
 * Replays carry greedy orderings (a Phoenix build teching Stargate
 * before the first gateway unit) that were fine on their original
 * economy but leave you unit-less inside the standard pressure window
 * once re-timed. The guard simulates the opponent's fastest standard
 * pressure opening ON THE TARGET PATCH (e.g. the 8-worker standard
 * reaper arrives ~2:42), and when the adapted build's first combat
 * unit would finish after that window it pulls the unit to its
 * earliest tech-feasible position in the order, re-simulates, and
 * explains what it did in an adaptation note.
 *
 * It never invents units the build didn't have, and it never touches
 * a build whose first unit is already out in time.
 */
import { resolveProfile } from "../patch/profiles";
import { defaultPolicies, simulate } from "../sim/engine";
import type {
  AdaptRequest,
  AdaptResult,
  BuildAction,
  DefenseAssessment,
  MacroPolicies,
  PatchProfile,
  SimRace,
  SimResult,
} from "../types";
import { actionsFromSteps, adaptBuild } from "./adapt";

/**
 * Cross-map travel time for early pressure units, calibrated so the
 * 8-worker (5.0.16) standard reaper opening arrives at ~2:42: the sim
 * completes the reaper at 2:11, and 2:11 + 31s = 2:42. Used for all
 * races as an approximation (lings are faster, zealots slower, but
 * the windows are minutes apart between tiers, not seconds).
 */
const TRAVEL_SEC = 31;

/** "Unit done by 2:47 for a 2:42 reaper" - the user's margin. */
const GRACE_SEC = 5;

/**
 * Canonical fastest STANDARD pressure opening per attacker race
 * (proxies and all-ins arrive earlier but require scouting to play
 * around, which the adapter doesn't model).
 */
const PRESSURE_OPENINGS: Record<SimRace, { steps: string[]; unit: string }> = {
  Terran: {
    steps: ["SupplyDepot", "Barracks", "Refinery", "Reaper"],
    unit: "Reaper",
  },
  Zerg: { steps: ["SpawningPool", "Zergling"], unit: "Zergling" },
  Protoss: { steps: ["Pylon", "Gateway", "Zealot"], unit: "Zealot" },
};

const arrivalCache = new Map<string, number | null>();

/**
 * Earliest standard pressure arrival (sec) for `attacker` on the
 * given patch, or null when it can't be derived.
 */
export function earliestPressureArrivalSec(
  profileId: string,
  attacker: SimRace,
): number | null {
  const key = `${profileId}:${attacker}`;
  const cached = arrivalCache.get(key);
  if (cached !== undefined) return cached;
  let arrival: number | null = null;
  try {
    const profile = resolveProfile(profileId);
    const opening = PRESSURE_OPENINGS[attacker];
    const { actions } = actionsFromSteps(profile, opening.steps);
    const sim = simulate(actions, profile, attacker, {
      horizonSec: 360,
      policies: defaultPolicies(),
    });
    const done = sim.completionTimes[opening.unit]?.[0];
    arrival = done !== undefined ? Math.round(done + TRAVEL_SEC) : null;
  } catch {
    arrival = null;
  }
  arrivalCache.set(key, arrival);
  return arrival;
}

function isCombatUnit(profile: PatchProfile, name: string): boolean {
  const def = profile.units[name];
  return (
    !!def && !def.isStructure && !def.isWorker && !!def.combat && def.supply > 0
  );
}

/** Completion time of the first combat unit in a sim, or null. */
function firstCombatUnitDone(
  profile: PatchProfile,
  sim: SimResult,
): { name: string; doneSec: number } | null {
  for (const step of sim.steps) {
    if (
      (step.kind === "train" || step.kind === "morph") &&
      isCombatUnit(profile, step.name)
    ) {
      return { name: step.name, doneSec: step.doneSec };
    }
  }
  return null;
}

/** Index of the first combat-unit action in the list, or -1. */
function firstCombatActionIndex(
  profile: PatchProfile,
  actions: BuildAction[],
): number {
  for (let i = 0; i < actions.length; i += 1) {
    const a = actions[i];
    if (
      (a.kind === "train" || a.kind === "morph") &&
      isCombatUnit(profile, a.name)
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Earliest list position the action at `idx` could occupy with its
 * tech requirements (producer structure + requires entries) still
 * satisfied by the actions before it. Returns `idx` when it can't
 * move (a requirement only appears later, or it's already earliest).
 */
function earliestFeasibleIndex(
  profile: PatchProfile,
  actions: BuildAction[],
  idx: number,
): number {
  const def = profile.units[actions[idx].name];
  if (!def) return idx;
  const groups: string[][] = [];
  const producerAlts = def.builtFrom.filter(
    (b) => profile.units[b]?.isStructure,
  );
  if (producerAlts.length > 0) groups.push(producerAlts);
  for (const req of def.requires ?? []) groups.push(req.split("|"));
  let insert = 0;
  for (const group of groups) {
    let at = -1;
    for (let i = 0; i < idx; i += 1) {
      const a = actions[i];
      if (
        (a.kind === "build" || a.kind === "morph") &&
        group.includes(a.name)
      ) {
        at = i;
        break;
      }
    }
    if (at === -1) return idx;
    insert = Math.max(insert, at + 1);
  }
  return Math.min(insert, idx);
}

function mmss(seconds: number): string {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function humanize(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

/* ------------------------------------------------------------------ */
/* Candidate optimizer: reorder + chrono + weighted probe-cut          */
/* ------------------------------------------------------------------ */

/** Macro horizon (5:00) at which a probe-cut's economic cost is judged. */
const ECON_HORIZON_SEC = 300;
/** A worker's mineral value, for the economic score. */
const WORKER_VALUE = 50;
/** Most minerals (at the horizon) a probe-cut may sacrifice to be eligible. */
const ECON_TOLERANCE = 150;
/** Freeze-window widths the guard tries when probe-cutting (seconds). */
const PROBE_CUT_WIDTHS = [16, 28];
/** Min first-unit improvement (sec) worth rewriting an order that still can't defend. */
const MIN_IMPROVE_SEC = 3;

function isCut(s: Scored): boolean {
  return s.candidate.levers.some((l) => l.startsWith("probe-cut"));
}

/** First expansion (a 2nd+ town hall build) in the list, or -1. */
function expandIndex(
  profile: PatchProfile,
  actions: BuildAction[],
  race: SimRace,
): number {
  const townHall = profile.starting.townHall[race];
  return actions.findIndex((a) => a.kind === "build" && a.name === townHall);
}

/**
 * The latest producer/`requires` structure gating the unit at `unitIdx`
 * (the true tech bottleneck), or -1.
 */
function gatingTechIndex(
  profile: PatchProfile,
  actions: BuildAction[],
  unitIdx: number,
): number {
  const def = profile.units[actions[unitIdx]?.name];
  if (!def) return -1;
  const groups: string[][] = [];
  const producerAlts = def.builtFrom.filter(
    (b) => profile.units[b]?.isStructure,
  );
  if (producerAlts.length > 0) groups.push(producerAlts);
  for (const req of def.requires ?? []) groups.push(req.split("|"));
  let latest = -1;
  for (const group of groups) {
    for (let i = 0; i < unitIdx; i += 1) {
      const a = actions[i];
      if ((a.kind === "build" || a.kind === "morph") && group.includes(a.name)) {
        if (i > latest) latest = i;
        break;
      }
    }
  }
  return latest;
}

/** Combat units listed before the first expansion (identity to preserve). */
function preExpandUnitCount(
  profile: PatchProfile,
  actions: BuildAction[],
  race: SimRace,
): number {
  const exp = expandIndex(profile, actions, race);
  const limit = exp < 0 ? actions.length : exp;
  let n = 0;
  for (let i = 0; i < limit; i += 1) {
    const a = actions[i];
    if (
      (a.kind === "train" || a.kind === "morph") &&
      isCombatUnit(profile, a.name)
    ) {
      n += 1;
    }
  }
  return n;
}

/** Move the action at `fromIdx` to just before `beforeIdx`. */
function moveBefore(
  actions: BuildAction[],
  fromIdx: number,
  beforeIdx: number,
): BuildAction[] {
  const out = [...actions];
  const [moved] = out.splice(fromIdx, 1);
  out.splice(fromIdx < beforeIdx ? beforeIdx - 1 : beforeIdx, 0, moved);
  return out;
}

/** The structure that produces `unitName` (first structural builtFrom). */
function producerOf(profile: PatchProfile, unitName: string): string | null {
  const def = profile.units[unitName];
  return def?.builtFrom.find((b) => profile.units[b]?.isStructure) ?? null;
}

/**
 * Pull the first combat unit (carrying a supply structure if one sits
 * between) to its earliest feasible slot. Returns the rewritten list and
 * the names it passed, or null when it can't move.
 */
function pullUnit(
  profile: PatchProfile,
  actions: BuildAction[],
): { actions: BuildAction[]; past: string[] } | null {
  const idx = firstCombatActionIndex(profile, actions);
  if (idx <= 0) return null;
  const k = earliestFeasibleIndex(profile, actions, idx);
  if (k >= idx) return null;
  const reordered = [...actions];
  const [unitAction] = reordered.splice(idx, 1);
  let insertAt = k;
  let movedSupply: string | null = null;
  const supplyIdx = reordered.findIndex(
    (a, i) =>
      i >= k &&
      i < idx &&
      a.kind === "build" &&
      (profile.units[a.name]?.providesSupply ?? 0) > 0,
  );
  if (supplyIdx !== -1) {
    const [supplyAction] = reordered.splice(supplyIdx, 1);
    reordered.splice(k, 0, supplyAction);
    movedSupply = supplyAction.name;
    insertAt = k + 1;
  }
  reordered.splice(insertAt, 0, unitAction);
  const past = actions
    .slice(k, idx)
    .map((a) => a.name)
    .filter((n) => n !== movedSupply);
  return { actions: reordered, past: [...new Set(past)].map(humanize) };
}

/** Insert a chrono cast on the first combat unit's producer, right before it. */
function injectChronoBeforeUnit(
  profile: PatchProfile,
  actions: BuildAction[],
): BuildAction[] | null {
  const idx = firstCombatActionIndex(profile, actions);
  if (idx < 0) return null;
  const producer = producerOf(profile, actions[idx].name);
  if (!producer) return null;
  const out = [...actions];
  out.splice(idx, 0, {
    kind: "chrono",
    name: `Chrono:${producer}`,
    target: producer,
  });
  return out;
}

/** Workers / banked minerals as a single mineral-equivalent at the horizon. */
function econScore(sim: SimResult, horizon: number): number {
  let workers = sim.finalWorkers;
  let minerals = sim.finalMinerals;
  let bestT = -Infinity;
  for (const s of sim.samples) {
    if (s.time <= horizon && s.time > bestT) {
      bestT = s.time;
      workers = s.workers;
      minerals = s.minerals;
    }
  }
  return workers * WORKER_VALUE + minerals;
}

function workersBy(sim: SimResult, race: SimRace, profile: PatchProfile, t: number): number {
  const worker = profile.starting.worker[race];
  return (sim.completionTimes[worker] ?? []).filter((s) => s <= t).length;
}

interface Candidate {
  actions: BuildAction[];
  policies?: MacroPolicies;
  levers: string[];
  past: string[];
  /** Heavier = more invasive; probe-cuts dominate. */
  invasiveness: number;
}

interface Scored {
  candidate: Candidate;
  result: AdaptResult;
  firstDoneSec: number;
  hitsDeadline: boolean;
  preExpandOk: boolean;
  econLoss: number;
}

/**
 * Apply the first-unit defense guard. The guard simulates the opponent's
 * fastest standard pressure on the target patch (Terran's ~2:42 reaper is
 * the tightest, and the assumed default when the matchup is unknown) and,
 * when the adapted build's first combat unit finishes after that window,
 * tries the least-invasive combination of levers that lands a unit in
 * time while preserving the build's identity (how many combat units it
 * built before expanding): reorder the gating tech ahead of the
 * expansion, chrono the unit, and — weighed against its economic cost — a
 * bounded probe-cut. It always records a `defense` verdict, and warns
 * clearly when nothing makes the build defensible.
 */
export function applyFirstUnitDefenseGuard(
  result: AdaptResult,
  request: AdaptRequest,
  vsRace: SimRace | undefined,
): AdaptResult {
  const attacker: SimRace = vsRace ?? "Terran";
  const matchupKnown = vsRace !== undefined;
  const arrival = earliestPressureArrivalSec(request.profileId, attacker);
  if (arrival === null) return result;
  const deadline = arrival + GRACE_SEC;
  const profile = resolveProfile(request.profileId);

  // Fast path: already defensible. Record the verdict, change nothing.
  const baseFirst = firstCombatUnitDone(profile, result.sim);
  if (baseFirst !== null && baseFirst.doneSec <= deadline) {
    return {
      ...result,
      defense: assess(result, profile, attacker, matchupKnown, arrival, deadline, []),
    };
  }

  const horizon = Math.min(ECON_HORIZON_SEC, request.horizonSec);
  const baseEcon = econScore(result.sim, horizon);
  const baseDone = baseFirst ? baseFirst.doneSec : Infinity;
  const srcPreExpand = preExpandUnitCount(profile, request.actions, request.race);

  const scored = evaluateCandidates(
    profile,
    request,
    result,
    deadline,
    horizon,
    baseEcon,
    srcPreExpand,
  );

  // Tier 1: a candidate that actually defends (unit out by the deadline) —
  // pick the least-invasive one (probe-cuts only reach here when they buy
  // the deadline and pass the economic test).
  const defenders = scored.filter((s) => s.hitsDeadline && s.preExpandOk);
  // Tier 2: nothing defends — apply the biggest non-cut improvement (don't
  // spend probes on a build that still can't hold) and flag it honestly.
  const improvers = scored
    .filter(
      (s) =>
        s.preExpandOk &&
        !isCut(s) &&
        s.firstDoneSec < baseDone - MIN_IMPROVE_SEC,
    )
    .sort(
      (a, b) =>
        a.firstDoneSec - b.firstDoneSec ||
        a.candidate.invasiveness - b.candidate.invasiveness,
    );

  let winner: Scored | undefined;
  if (defenders.length > 0) {
    defenders.sort(compareScored);
    winner = defenders[0];
  } else {
    winner = improvers[0];
  }

  const final = winner ? winner.result : result;
  const levers = winner ? winner.candidate.levers : [];
  const past = winner ? winner.candidate.past : [];

  const assessment = assess(
    final,
    profile,
    attacker,
    matchupKnown,
    arrival,
    deadline,
    levers,
  );
  const note = defenseNote(assessment, matchupKnown, attacker, past);
  return {
    ...final,
    adaptationNotes: [note, ...final.adaptationNotes],
    defense: assessment,
  };
}

/** Build, re-simulate and score every candidate transform. */
function evaluateCandidates(
  profile: PatchProfile,
  request: AdaptRequest,
  base: AdaptResult,
  deadline: number,
  horizon: number,
  baseEcon: number,
  srcPreExpand: number,
): Scored[] {
  const actions = request.actions;
  const unitIdx = firstCombatActionIndex(profile, actions);
  const expIdx = expandIndex(profile, actions, request.race);
  const techIdx = unitIdx >= 0 ? gatingTechIndex(profile, actions, unitIdx) : -1;

  const structural: Candidate[] = [];

  // C1 — pull the first combat unit earlier.
  const pulled = pullUnit(profile, actions);
  if (pulled) {
    structural.push({
      actions: pulled.actions,
      levers: ["pull"],
      past: pulled.past,
      invasiveness: 0.5,
    });
  }

  // C2 — tech-before-expand: move the gating tech ahead of the expansion.
  // Identity-safe (moves a structure, not a unit), so preExpand is kept.
  let reordered: BuildAction[] | null = null;
  if (expIdx >= 0 && techIdx > expIdx) {
    const c2 = moveBefore(actions, techIdx, expIdx);
    reordered = c2;
    structural.push({ actions: c2, levers: ["core-before-nexus"], past: [], invasiveness: 1 });
  }

  // C3 — reorder + pull the unit too (only when the source already
  // fielded a unit before expanding, to preserve identity).
  if (reordered && srcPreExpand >= 1) {
    const c3 = pullUnit(profile, reordered);
    if (c3) {
      structural.push({
        actions: c3.actions,
        levers: ["core-before-nexus", "pull"],
        past: c3.past,
        invasiveness: 1.5,
      });
    }
  }

  // C4/C5 — chrono the unit, on the source order and on the reorder.
  for (const baseActions of [actions, reordered].filter(Boolean) as BuildAction[][]) {
    const chronoed = injectChronoBeforeUnit(profile, baseActions);
    if (chronoed) {
      const levers = baseActions === reordered ? ["core-before-nexus", "chrono"] : ["chrono"];
      structural.push({
        actions: chronoed,
        levers,
        past: [],
        invasiveness: (baseActions === reordered ? 1 : 0) + 1,
      });
    }
  }

  const scored: Scored[] = structural.map((c) =>
    scoreCandidate(c, profile, request, base, deadline, horizon, baseEcon, srcPreExpand),
  );

  // C6/C7 — probe-cut layered on the most promising structural base. Aim
  // the freeze window at the first unit's save-up, sized a couple of ways,
  // and keep only those whose economic loss is within tolerance.
  const cutBase = bestSoFar(scored) ?? null;
  if (cutBase) {
    const uStart = firstUnitStart(profile, cutBase.result.sim);
    if (uStart !== null) {
      for (const width of PROBE_CUT_WIDTHS) {
        const fromSec = Math.max(0, uStart - width);
        const cutCandidate: Candidate = {
          actions: cutBase.candidate.actions,
          policies: {
            ...request.policies,
            workerCut: { fromSec, untilSec: uStart },
          },
          levers: [...cutBase.candidate.levers, "probe-cut"],
          past: cutBase.candidate.past,
          invasiveness: cutBase.candidate.invasiveness + 3,
        };
        const s = scoreCandidate(
          cutCandidate,
          profile,
          request,
          base,
          deadline,
          horizon,
          baseEcon,
          srcPreExpand,
        );
        if (s.econLoss <= ECON_TOLERANCE) {
          // Record the measured probe deficit in the lever label.
          const deficit = Math.max(
            1,
            workersBy(base.sim, request.race, profile, horizon) -
              workersBy(s.result.sim, request.race, profile, horizon),
          );
          s.candidate.levers = [
            ...cutBase.candidate.levers,
            `probe-cut:${deficit}`,
          ];
          scored.push(s);
        }
      }
    }
  }

  return scored;
}

function scoreCandidate(
  candidate: Candidate,
  profile: PatchProfile,
  request: AdaptRequest,
  base: AdaptResult,
  deadline: number,
  horizon: number,
  baseEcon: number,
  srcPreExpand: number,
): Scored {
  const result = adaptBuild({
    ...request,
    actions: candidate.actions,
    policies: candidate.policies ?? request.policies,
  });
  const first = firstCombatUnitDone(profile, result.sim);
  // Reject candidates that strand actions (e.g. a chrono that stalls the
  // FIFO tail on energy) — they're never an improvement.
  const stranded = result.sim.unexecutedActions > base.sim.unexecutedActions;
  const firstDoneSec = first ? first.doneSec : Infinity;
  return {
    candidate,
    result,
    firstDoneSec,
    hitsDeadline: !stranded && first !== null && first.doneSec <= deadline,
    preExpandOk:
      preExpandUnitCount(profile, candidate.actions, request.race) === srcPreExpand,
    econLoss: baseEcon - econScore(result.sim, horizon),
  };
}

/** Lowest first-unit time among structural candidates, as a cut base. */
function bestSoFar(scored: Scored[]): Scored | null {
  let best: Scored | null = null;
  for (const s of scored) {
    if (!best || s.firstDoneSec < best.firstDoneSec) best = s;
  }
  return best;
}

function firstUnitStart(profile: PatchProfile, sim: SimResult): number | null {
  for (const step of sim.steps) {
    if (
      (step.kind === "train" || step.kind === "morph") &&
      isCombatUnit(profile, step.name)
    ) {
      return step.startSec;
    }
  }
  return null;
}

/** Best first: defends, keeps identity, least invasive, lower econ loss, earlier. */
function compareScored(a: Scored, b: Scored): number {
  if (a.hitsDeadline !== b.hitsDeadline) return a.hitsDeadline ? -1 : 1;
  if (a.preExpandOk !== b.preExpandOk) return a.preExpandOk ? -1 : 1;
  if (a.candidate.invasiveness !== b.candidate.invasiveness) {
    return a.candidate.invasiveness - b.candidate.invasiveness;
  }
  if (a.econLoss !== b.econLoss) return a.econLoss - b.econLoss;
  return a.firstDoneSec - b.firstDoneSec;
}

function assess(
  result: AdaptResult,
  profile: PatchProfile,
  attacker: SimRace,
  matchupKnown: boolean,
  arrival: number,
  deadline: number,
  leversUsed: string[],
): DefenseAssessment {
  const first = firstCombatUnitDone(profile, result.sim);
  const exposedSec = first ? Math.max(0, first.doneSec - arrival) : Infinity;
  let verdict: DefenseAssessment["verdict"];
  if (first && first.doneSec <= deadline) verdict = "safe";
  else if (first && first.doneSec <= deadline + 10) verdict = "risky";
  else verdict = "unsafe";
  return {
    verdict,
    attacker,
    matchupKnown,
    arrivalSec: arrival,
    deadlineSec: deadline,
    firstUnit: first ? { name: first.name, doneSec: first.doneSec } : null,
    exposedSec: Number.isFinite(exposedSec) ? Math.round(exposedSec) : 999,
    leversUsed,
  };
}

function describeLevers(levers: string[], past: string[]): string {
  const parts: string[] = [];
  if (levers.includes("core-before-nexus")) parts.push("teched core-before-nexus");
  if (levers.includes("pull")) {
    parts.push(
      past.length > 0
        ? `pulled your first unit ahead of ${past.join(", ")}`
        : "pulled your first unit earlier",
    );
  }
  if (levers.includes("chrono")) parts.push("chrono-boosted it");
  const cut = levers.find((l) => l.startsWith("probe-cut"));
  if (cut) {
    const n = cut.split(":")[1];
    parts.push(`cut ${n ? `${n} ` : "a few "}probes to pull it forward`);
  }
  const s = parts.join(" and ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function defenseNote(
  a: DefenseAssessment,
  matchupKnown: boolean,
  attacker: SimRace,
  past: string[],
): string {
  const windowText = matchupKnown
    ? `the earliest standard ${attacker} pressure on this patch arrives ~${mmss(a.arrivalSec)}`
    : `with no matchup set, the fastest standard pressure (a ${attacker} reaper) arrives ~${mmss(a.arrivalSec)}`;
  if (!a.firstUnit) {
    return `No combat unit in the adapted window, and ${windowText}. This opening is undefended - add an early unit or wall.`;
  }
  const unit = humanize(a.firstUnit.name);
  const out = mmss(a.firstUnit.doneSec);
  if (a.leversUsed.length > 0) {
    return a.verdict === "safe"
      ? `${describeLevers(a.leversUsed, past)}: your first ${unit} is out ${out}, in time for ${windowText}.`
      : `${describeLevers(a.leversUsed, past)}, but your first ${unit} is still out ${out} - ${windowText}, ~${a.exposedSec}s exposed. Consider an earlier unit or a wall/battery.`;
  }
  return `Greedy opening: your first combat unit (${unit}) finishes ${out}, but ${windowText}. No reorder, chrono, or affordable probe-cut fields a unit in time - add an earlier unit or a wall/battery.`;
}
