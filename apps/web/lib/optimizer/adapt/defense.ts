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

/**
 * Apply the first-unit defense guard to an adapted result. When the
 * matchup is unknown the guard still runs against the fastest standard
 * pressure on the patch (Terran's ~2:42 reaper, the tightest window) so
 * a greedy order never slips through unchecked - it just labels the note
 * as an assumption. Returns the original result untouched only when the
 * pressure window can't be derived or the first unit is already out in
 * time.
 */
export function applyFirstUnitDefenseGuard(
  result: AdaptResult,
  request: AdaptRequest,
  vsRace: SimRace | undefined,
): AdaptResult {
  // Unknown matchup -> assume the worst standard case: Terran's reaper
  // is the fastest standard pressure, so its window is the safe default.
  const attacker: SimRace = vsRace ?? "Terran";
  const matchupKnown = vsRace !== undefined;
  const arrival = earliestPressureArrivalSec(request.profileId, attacker);
  if (arrival === null) return result;
  const deadline = arrival + GRACE_SEC;
  const profile = resolveProfile(request.profileId);

  const first = firstCombatUnitDone(profile, result.sim);
  if (first !== null && first.doneSec <= deadline) return result;

  // Try pulling the first combat unit to its earliest feasible slot.
  let final = result;
  let pulledPast: string[] = [];
  const idx = firstCombatActionIndex(profile, request.actions);
  if (idx > 0) {
    const k = earliestFeasibleIndex(profile, request.actions, idx);
    if (k < idx) {
      const reordered = [...request.actions];
      const [unitAction] = reordered.splice(idx, 1);
      // The unit usually needs supply as much as tech: if a supply
      // structure sits between its earliest slot and its source
      // position, bring it along so the pull isn't supply-gated.
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
      const retry = adaptBuild({ ...request, actions: reordered });
      const retryFirst = firstCombatUnitDone(profile, retry.sim);
      if (
        retryFirst !== null &&
        (first === null || retryFirst.doneSec < first.doneSec - 1)
      ) {
        const past = request.actions.slice(k, idx).map((a) => a.name);
        if (movedSupply !== null) {
          past.splice(past.indexOf(movedSupply), 1);
        }
        pulledPast = [...new Set(past)].map(humanize);
        final = retry;
      }
    }
  }

  const finalFirst = firstCombatUnitDone(profile, final.sim);
  const windowText = matchupKnown
    ? `the earliest standard ${attacker} pressure on this patch arrives ~${mmss(arrival)}`
    : `with no matchup set, the fastest standard pressure (a ${attacker} reaper) arrives ~${mmss(arrival)}`;
  let note: string;
  if (finalFirst === null) {
    note = `No combat unit in the adapted window, and ${windowText}. This opening is undefended - add an early unit or wall.`;
  } else if (final !== result) {
    const unit = humanize(finalFirst.name);
    const past = pulledPast.join(", ");
    note =
      finalFirst.doneSec <= deadline
        ? `Pulled your first ${unit} ahead of ${past}: it's out by ${mmss(finalFirst.doneSec)}, in time for ${windowText}.`
        : `Pulled your first ${unit} ahead of ${past} (out ${mmss(finalFirst.doneSec)}), but ${windowText} - still ~${Math.round(finalFirst.doneSec - arrival)}s exposed. The source order is greedy on this economy; consider an earlier Zealot/Adept or a defensive structure.`;
  } else {
    note = `Greedy opening: your first combat unit (${humanize(finalFirst.name)}) finishes ${mmss(finalFirst.doneSec)}, but ${windowText}. The source build techs before units; consider an earlier unit or a wall/battery.`;
  }
  return { ...final, adaptationNotes: [note, ...final.adaptationNotes] };
}
