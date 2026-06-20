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

/** Macro horizon (5:00) at which a probe-cut's long-term cost is judged. */
const ECON_HORIZON_SEC = 300;
/** Short horizon (~3:15) capturing a probe-cut's transient worker dip. */
const SHORT_HORIZON_SEC = 195;
/** Two-horizon economic weights: long-term weighted higher (a delayed
 * expansion is a permanent loss; a 2-3 probe cut recovers by 5:00). */
const W_SHORT = 1;
const W_LONG = 1.5;
/** A worker's mineral value, for the economic score. */
const WORKER_VALUE = 50;
/** Most minerals (at the horizon) a probe-cut may sacrifice to be eligible. */
const ECON_TOLERANCE = 150;
/** Hysteresis (~1.5 probes): only prefer a costlier-to-build option (e.g. a
 * probe-cut) over a simpler one when it's economically better by this much. */
const ECON_DECISION_MARGIN = 75;
/** Freeze-window widths the guard tries when probe-cutting (seconds). */
const PROBE_CUT_WIDTHS = [16, 28];
/** Min first-unit improvement (sec) worth rewriting an order that still can't defend. */
const MIN_IMPROVE_SEC = 3;
/** Max seconds a Zealot fallback may delay the build's first ranged unit. */
const ZEALOT_RANGED_DELAY_TOLERANCE_SEC = 10;

function isCut(s: Scored): boolean {
  return s.candidate.levers.some((l) => l.startsWith("probe-cut"));
}

function isZealotFallback(s: Scored): boolean {
  return s.candidate.levers.includes("zealot-fallback");
}

/**
 * A "ranged" combat unit — one gated behind a tech structure (Adept,
 * Stalker, Sentry all `requires` the Cybernetics Core). The basic
 * Gateway unit (Zealot) has no `requires`. This is the exact split the
 * product owner wants: the guard fields the ranged unit and never
 * defaults to inserting a Zealot. (The data has no `range`/`dpsAir`
 * field that reliably distinguishes them — the Adept has no `dpsAir`.)
 */
function isRangedCombatUnit(profile: PatchProfile, name: string): boolean {
  const def = profile.units[name];
  return isCombatUnit(profile, name) && (def?.requires?.length ?? 0) > 0;
}

/** Index of the first ranged-combat-unit action in the list, or -1. */
function firstRangedActionIndex(
  profile: PatchProfile,
  actions: BuildAction[],
): number {
  for (let i = 0; i < actions.length; i += 1) {
    const a = actions[i];
    if (
      (a.kind === "train" || a.kind === "morph") &&
      isRangedCombatUnit(profile, a.name)
    ) {
      return i;
    }
  }
  return -1;
}

/** Start second of the first ranged unit in a sim, or null. */
function firstRangedUnitStart(
  profile: PatchProfile,
  sim: SimResult,
): number | null {
  for (const step of sim.steps) {
    if (
      (step.kind === "train" || step.kind === "morph") &&
      isRangedCombatUnit(profile, step.name)
    ) {
      return step.startSec;
    }
  }
  return null;
}

/** Completion of the first ranged unit in a sim, or Infinity. */
function firstRangedDone(profile: PatchProfile, sim: SimResult): number {
  for (const step of sim.steps) {
    if (
      (step.kind === "train" || step.kind === "morph") &&
      isRangedCombatUnit(profile, step.name)
    ) {
      return step.doneSec;
    }
  }
  return Infinity;
}

/** The race's basic Gateway melee unit (no tech requirement), e.g. Zealot. */
function basicMeleeUnitName(
  profile: PatchProfile,
  actions: BuildAction[],
): string | null {
  let best: { name: string; cost: number } | null = null;
  for (const [name, def] of Object.entries(profile.units)) {
    if (
      isCombatUnit(profile, name) &&
      (def.requires?.length ?? 0) === 0 &&
      def.builtFrom.some((b) => profile.units[b]?.isStructure)
    ) {
      const cost = def.minerals + def.gas;
      if (!best || cost < best.cost) best = { name, cost };
    }
  }
  return best?.name ?? null;
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
 * Pull the unit at `idx` (carrying a supply structure if one sits
 * between) to its earliest feasible slot. Returns the rewritten list and
 * the names it passed, or null when it can't move.
 */
function pullUnit(
  profile: PatchProfile,
  actions: BuildAction[],
  idx: number,
): { actions: BuildAction[]; past: string[] } | null {
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

/** Insert a chrono cast on the unit-at-`idx`'s producer, right before it. */
function injectChronoBeforeUnit(
  profile: PatchProfile,
  actions: BuildAction[],
  idx: number,
): BuildAction[] | null {
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

/** Start second of the structure named `name` in a sim, or null. */
function structureStart(sim: SimResult, name: string): number | null {
  for (const step of sim.steps) {
    if (step.name === name) return step.startSec;
  }
  return null;
}

/**
 * Insert the basic melee defender (a Zealot) right after the earliest
 * Gateway it can come from. Returns the rewritten list + the unit name,
 * or null when the race has no such unit or no producer in the build.
 */
function insertMeleeDefender(
  profile: PatchProfile,
  actions: BuildAction[],
): { actions: BuildAction[]; name: string } | null {
  const meleeName = basicMeleeUnitName(profile, actions);
  if (!meleeName) return null;
  const producer = producerOf(profile, meleeName);
  if (!producer) return null;
  const prodIdx = actions.findIndex(
    (a) => a.kind === "build" && a.name === producer,
  );
  if (prodIdx < 0) return null;
  const out = [...actions];
  out.splice(prodIdx + 1, 0, { kind: "train", name: meleeName });
  return { actions: out, name: meleeName };
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

/**
 * Two-horizon economic strength: the short horizon captures a probe-cut's
 * transient worker dip; the long horizon (weighted higher) captures a
 * delayed expansion's permanent loss. Used only to choose between options
 * that already field the unit in time — the deadline is a hard gate first.
 */
function dualEconScore(sim: SimResult, request: AdaptRequest): number {
  const shortH = Math.min(request.horizonSec, SHORT_HORIZON_SEC);
  const longH = Math.min(request.horizonSec, ECON_HORIZON_SEC);
  return W_SHORT * econScore(sim, shortH) + W_LONG * econScore(sim, longH);
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
  /** Completion of the first combat unit (any), for verdict/improvement. */
  firstDoneSec: number;
  hitsDeadline: boolean;
  /** Higher = stronger economy (short + long horizon). */
  dualEcon: number;
  /** Long-horizon mineral loss vs the untouched build (probe-cut gate). */
  econLoss: number;
  /** |pre-expand unit count − source's| — soft identity tiebreak. */
  preExpandDelta: number;
  /** Completion of the first RANGED unit (Infinity if none), for gating. */
  rangedDoneSec: number;
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

  // Tier 1: options that field the RANGED unit in time (Option A probe-cut
  // or Option B nexus-delay). Choose the economically better one — the
  // deadline is a hard gate, economics only decides between qualifiers.
  const rangedDefenders = scored.filter(
    (s) => !isZealotFallback(s) && s.rangedDoneSec <= deadline,
  );

  let winner: Scored | undefined;
  if (rangedDefenders.length > 0) {
    winner = pickDefender(rangedDefenders);
  } else {
    // No ranged option holds. A Zealot fallback is allowed ONLY when it
    // defends AND it barely delays the ranged unit (<10s) vs the best we
    // could do — otherwise we never default to a Zealot.
    const bestRangedDone = Math.min(
      Infinity,
      ...scored
        .filter((s) => !isZealotFallback(s))
        .map((s) => s.rangedDoneSec),
    );
    const zealot = scored.find((s) => isZealotFallback(s));
    if (
      zealot &&
      zealot.hitsDeadline &&
      zealot.rangedDoneSec - bestRangedDone < ZEALOT_RANGED_DELAY_TOLERANCE_SEC
    ) {
      winner = zealot;
    } else {
      // Tier 2: nothing defends — apply the biggest non-cut, non-Zealot
      // improvement (don't spend probes/units a build can't be saved by)
      // and flag it honestly.
      winner = scored
        .filter(
          (s) =>
            !isCut(s) &&
            !isZealotFallback(s) &&
            s.firstDoneSec < baseDone - MIN_IMPROVE_SEC,
        )
        .sort(
          (a, b) =>
            a.firstDoneSec - b.firstDoneSec ||
            a.candidate.invasiveness - b.candidate.invasiveness,
        )[0];
    }
  }

  const final = winner ? winner.result : result;
  const levers = winner ? winner.candidate.levers : [];

  const assessment = assess(
    final,
    profile,
    attacker,
    matchupKnown,
    arrival,
    deadline,
    levers,
  );
  const note = defenseNote(assessment, matchupKnown, attacker);
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
  const rangedIdx = firstRangedActionIndex(profile, actions);
  const expIdx = expandIndex(profile, actions, request.race);
  const techIdx =
    rangedIdx >= 0 ? gatingTechIndex(profile, actions, rangedIdx) : -1;
  const gatingTechName = techIdx >= 0 ? actions[techIdx].name : null;

  const score = (c: Candidate) =>
    scoreCandidate(c, profile, request, base, deadline, horizon, baseEcon, srcPreExpand);

  const scored: Scored[] = [];

  // ---- Option A base: keep the Nexus where it is, pull the ranged unit
  // forward (it lands right after its tech). A probe-cut on this base is
  // the user's "17 Nexus / 17 Core" — keeps the early expansion. ----
  const pulledA = rangedIdx > 0 ? pullUnit(profile, actions, rangedIdx) : null;
  const optionABase: Candidate = pulledA
    ? { actions: pulledA.actions, levers: ["pull"], past: pulledA.past, invasiveness: 0.5 }
    : { actions, levers: [], past: [], invasiveness: 0 };
  if (pulledA) scored.push(score(optionABase));

  // ---- Option B: core-before-nexus, and pull the ranged unit to right
  // after the Core (before the Nexus) — the proper PvT opener. Generated
  // always now (no pre-expand-identity gate). ----
  let optionBBase: Candidate | null = null;
  if (expIdx >= 0 && techIdx > expIdx) {
    const reordered = moveBefore(actions, techIdx, expIdx);
    scored.push(
      score({ actions: reordered, levers: ["core-before-nexus"], past: [], invasiveness: 1 }),
    );
    const rIdx = firstRangedActionIndex(profile, reordered);
    const c3 = rIdx > 0 ? pullUnit(profile, reordered, rIdx) : null;
    if (c3) {
      optionBBase = {
        actions: c3.actions,
        levers: ["core-before-nexus", "pull"],
        past: c3.past,
        invasiveness: 1.5,
      };
      scored.push(score(optionBBase));
    }
  }

  // ---- Chrono the ranged unit, on the source order and on Option B. ----
  for (const cb of [optionABase, optionBBase]) {
    if (!cb) continue;
    const rIdx = firstRangedActionIndex(profile, cb.actions);
    const chronoed = rIdx >= 0 ? injectChronoBeforeUnit(profile, cb.actions, rIdx) : null;
    if (chronoed) {
      scored.push(
        score({
          actions: chronoed,
          levers: [...cb.levers, "chrono"],
          past: cb.past,
          invasiveness: cb.invasiveness + 1,
        }),
      );
    }
  }

  // ---- Probe-cut layered on Option A and Option B, aimed so the freeze
  // window precedes the gating tech (Core) so its minerals come early.
  // Kept only when the long-horizon economic loss is within tolerance. ----
  for (const cb of [optionABase, optionBBase]) {
    if (!cb) continue;
    const cbScored = scored.find((s) => s.candidate === cb);
    const cbSim = cbScored ? cbScored.result.sim : score(cb).result.sim;
    // Aim windows at both the gating tech's save-up AND the unit's save-up
    // (the unit is often the real mineral bottleneck once the Core is up),
    // ending the window at the unit so probes resume once it's afforded.
    const techAim = gatingTechName ? structureStart(cbSim, gatingTechName) : null;
    const unitAim = firstRangedUnitStart(profile, cbSim);
    const windows: Array<{ fromSec: number; untilSec: number }> = [];
    for (const aim of [techAim, unitAim]) {
      if (aim === null) continue;
      for (const width of PROBE_CUT_WIDTHS) {
        windows.push({ fromSec: Math.max(0, aim - width), untilSec: aim });
      }
    }
    // Also a single wide cut spanning the tech save-up through the unit.
    if (techAim !== null && unitAim !== null && unitAim > techAim) {
      windows.push({ fromSec: Math.max(0, techAim - 12), untilSec: unitAim });
    }
    const rIdx = firstRangedActionIndex(profile, cb.actions);
    const cbChrono =
      rIdx >= 0 ? injectChronoBeforeUnit(profile, cb.actions, rIdx) : null;
    for (const window of windows) {
      // Both a bare cut and a cut+chrono (chrono speeds the unit's
      // production once the freed minerals have it training).
      const variants: Array<{ actions: BuildAction[]; extra: string[] }> = [
        { actions: cb.actions, extra: [] },
      ];
      if (cbChrono) variants.push({ actions: cbChrono, extra: ["chrono"] });
      for (const variant of variants) {
        const s = score({
          actions: variant.actions,
          policies: { ...request.policies, workerCut: window },
          levers: [...cb.levers, ...variant.extra, "probe-cut"],
          past: cb.past,
          invasiveness: cb.invasiveness + variant.extra.length + 3,
        });
        if (s.econLoss <= ECON_TOLERANCE) {
          const deficit = Math.max(
            1,
            workersBy(base.sim, request.race, profile, horizon) -
              workersBy(s.result.sim, request.race, profile, horizon),
          );
          s.candidate.levers = [...cb.levers, ...variant.extra, `probe-cut:${deficit}`];
          scored.push(s);
        }
      }
    }
  }

  // ---- Zealot fallback: only built so the selector can consider it when
  // no ranged option defends. Strictly gated at selection time. ----
  const zealot = insertMeleeDefender(profile, actions);
  if (zealot) {
    scored.push(
      score({
        actions: zealot.actions,
        levers: ["zealot-fallback"],
        past: [],
        invasiveness: 2,
      }),
    );
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
    dualEcon: dualEconScore(result.sim, request),
    econLoss: baseEcon - econScore(result.sim, horizon),
    preExpandDelta: Math.abs(
      preExpandUnitCount(profile, candidate.actions, request.race) - srcPreExpand,
    ),
    rangedDoneSec: firstRangedDone(profile, result.sim),
  };
}

/**
 * Among options that field the ranged unit in time, take the
 * economically strongest (two-horizon score) — but only let a costlier
 * build (e.g. a probe-cut) beat a simpler one when it's better by more
 * than the hysteresis margin. Within the margin, prefer the least
 * invasive, then the closest to the source's pre-expand identity, then
 * the earliest unit.
 */
function pickDefender(defenders: Scored[]): Scored {
  const bestEcon = Math.max(...defenders.map((d) => d.dualEcon));
  const econBest = defenders.filter(
    (d) => d.dualEcon >= bestEcon - ECON_DECISION_MARGIN,
  );
  econBest.sort(
    (a, b) =>
      a.candidate.invasiveness - b.candidate.invasiveness ||
      a.preExpandDelta - b.preExpandDelta ||
      a.firstDoneSec - b.firstDoneSec,
  );
  return econBest[0];
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

function describeLevers(levers: string[]): string {
  if (levers.includes("zealot-fallback")) return "Added an early Zealot to hold";
  const cut = levers.find((l) => l.startsWith("probe-cut"));
  const n = Number(cut?.split(":")[1]);
  const cutPhrase = cut
    ? `cut ${Number.isFinite(n) && n > 0 ? `${n} probe${n === 1 ? "" : "s"}` : "a few probes"}`
    : "";
  const parts: string[] = [];
  if (levers.includes("core-before-nexus")) {
    parts.push("teched core-before-nexus");
    if (cut) parts.push(cutPhrase);
  } else if (cut) {
    parts.push(`${cutPhrase} for a 17 Nexus / 17 Core`);
  } else if (levers.includes("pull")) {
    parts.push("pulled your ranged unit forward");
  }
  if (levers.includes("chrono")) parts.push("chrono-boosted the unit");
  if (parts.length === 0) parts.push("reordered the build");
  const s = parts.join(", ").replace(/,([^,]*)$/, " and$1");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function defenseNote(
  a: DefenseAssessment,
  matchupKnown: boolean,
  attacker: SimRace,
): string {
  const pressure = matchupKnown
    ? `the ~${mmss(a.arrivalSec)} standard ${attacker} attack`
    : `the ~${mmss(a.arrivalSec)} reaper (no matchup set — assuming Terran)`;
  if (!a.firstUnit) {
    return `No combat unit before ${pressure}. This opening is undefended — add an early unit or a wall/battery.`;
  }
  const unit = humanize(a.firstUnit.name);
  const out = mmss(a.firstUnit.doneSec);
  if (a.leversUsed.length > 0) {
    return a.verdict === "safe"
      ? `${describeLevers(a.leversUsed)} — your first ${unit} is out ${out}, in time for ${pressure}.`
      : `${describeLevers(a.leversUsed)}, but your first ${unit} is still only out ${out} — ${pressure} hits first (~${a.exposedSec}s exposed). Consider an earlier unit or a wall/battery.`;
  }
  return `Greedy opening: your first ${unit} finishes ${out}, but ${pressure} hits first. No reorder, chrono, or affordable probe-cut fields a unit in time — add an earlier unit or a wall/battery.`;
}
