/**
 * Derive threats from reference builds: the opponent's possible
 * attacks ARE the catalog's openers, so instead of hand-curating
 * wave timings we simulate the attacker's build on the current patch
 * and read its army off the completion timeline. A patch change
 * automatically re-times every threat.
 */
import { actionsFromSteps, referenceBuildsForRace } from "../adapt/adapt";
import { resolveProfile } from "../patch/profiles";
import { defaultPolicies, simulate } from "../sim/engine";
import type { PatchProfile, SimRace, Threat, ThreatWave } from "../types";

/** Seconds for the first attack wave to cross the map. */
const TRAVEL_SEC = 35;
/** Reinforcement cadence after the first wave. */
const WAVE_INTERVAL_SEC = 45;
const MAX_WAVES = 4;
const SIM_HORIZON_SEC = 540;

function matchupLabelFor(attacker: SimRace, defender: SimRace): string {
  return `${attacker[0]}v${defender[0]}`;
}

/** Combat units (no workers/structures) completed by the sim, in time order. */
function armyTimeline(
  profile: PatchProfile,
  completionTimes: Record<string, number[]>,
): { name: string; at: number }[] {
  const out: { name: string; at: number }[] = [];
  for (const [name, times] of Object.entries(completionTimes)) {
    const def = profile.units[name];
    if (!def || def.isWorker || def.isStructure || !def.combat) continue;
    if (!def.combat.dpsGround && !def.combat.dpsAir) continue;
    for (const at of times) out.push({ name, at });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Simulate one attacker build and turn its army production into
 * attack waves. Returns null for builds that never field an army
 * inside the horizon (nothing to defend against).
 */
export function deriveThreatFromBuild(
  profile: PatchProfile,
  build: {
    id: string;
    name: string;
    description: string;
    steps: string[];
    race: SimRace;
  },
  defender: SimRace,
): Threat | null {
  // builds are individual per matchup, so `steps` IS the attacker's
  // line vs this defender (the caller filters by `matchups`)
  const { actions } = actionsFromSteps(profile, build.steps);
  if (actions.length === 0) return null;
  const sim = simulate(actions, profile, build.race, {
    horizonSec: SIM_HORIZON_SEC,
    policies: defaultPolicies(),
  });
  const army = armyTimeline(profile, sim.completionTimes);
  if (army.length === 0) return null;

  // First wave leaves when the opener's second combat unit is out
  // (single-unit harass like a lone reaper still counts for 1-unit
  // builds), and arrives after the map crossing.
  const departIndex = Math.min(1, army.length - 1);
  const firstArrival = army[departIndex].at + TRAVEL_SEC;
  const waves: ThreatWave[] = [];
  let cursor = 0;
  for (let w = 0; w < MAX_WAVES; w += 1) {
    const waveTime = firstArrival + w * WAVE_INTERVAL_SEC;
    const units: Record<string, number> = {};
    let any = false;
    while (cursor < army.length && army[cursor].at + TRAVEL_SEC <= waveTime) {
      units[army[cursor].name] = (units[army[cursor].name] ?? 0) + 1;
      any = true;
      cursor += 1;
    }
    if (any) waves.push({ timeSec: Math.round(waveTime), units });
    if (cursor >= army.length) break;
  }
  if (waves.length === 0) return null;

  const firstWave = waves[0].units;
  const meleeOnly = Object.keys(firstWave).every((name) =>
    ["Zealot", "Zergling", "Baneling", "Ultralisk"].includes(name),
  );
  const smallFirstWave =
    Object.values(firstWave).reduce((s, n) => s + n, 0) <= 3;
  return {
    id: `ref:${build.id}`,
    attackerRace: build.race,
    vsDefender: [defender],
    name: build.name,
    description: build.description,
    earliestArrivalSec: waves[0].timeSec,
    scoutingTells: [],
    waves,
    dangerWindows: [],
    defenderHints: {
      wallRecommended: meleeOnly,
      workerPullViable: smallFirstWave,
    },
    priorProbability: 0.5,
  };
}

/**
 * Every catalog opener the opponent's race can play, simulated on the
 * given patch and expressed as attack waves. Memoized per
 * (profileId, attacker, defender) — ~30 sims at a few ms each.
 */
const cache = new Map<string, Threat[]>();

export function deriveThreatsForMatchup(
  profileId: string,
  defender: SimRace,
  attacker: SimRace,
): Threat[] {
  const key = `${profileId}|${attacker}|${defender}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const profile = resolveProfile(profileId);
  const matchup = matchupLabelFor(attacker, defender);
  const threats: Threat[] = [];
  for (const build of referenceBuildsForRace(attacker)) {
    if (!build.matchups.includes(matchup)) continue;
    const threat = deriveThreatFromBuild(profile, build, defender);
    if (threat) threats.push(threat);
  }
  threats.sort((a, b) => a.earliestArrivalSec - b.earliestArrivalSec);
  cache.set(key, threats);
  return threats;
}
