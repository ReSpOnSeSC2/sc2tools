/**
 * Scouting inference: turn concrete observations ("pool started by
 * 0:45", "no barracks in main at 1:30") into per-threat probabilities.
 *
 * Model: each threat starts at its meta prior (log-odds). A matched
 * supporting tell adds weight·SUPPORT_SCALE to the log-odds; a matched
 * contradicting tell subtracts weight·CONTRADICT_SCALE. Observations
 * outside a tell's time window are ignored rather than counted —
 * a pool seen at 1:30 is not evidence of an 8-pool even though
 * "pool" matches the tell.
 */
import type {
  ScoutingObservation,
  Threat,
  ThreatAssessment,
} from "../types";

const SUPPORT_SCALE = 2.6;
const CONTRADICT_SCALE = 3.0;
/** Probability above which a threat is "active" for the optimizer. */
export const ACTIVE_THRESHOLD = 0.3;

function logOdds(p: number): number {
  const clamped = Math.min(0.99, Math.max(0.01, p));
  return Math.log(clamped / (1 - clamped));
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function observationApplies(
  threat: Threat,
  tellId: string,
  atSec: number,
): { matches: boolean; contradicts: boolean; weight: number } | null {
  const tell = threat.scoutingTells.find((t) => t.id === tellId);
  if (!tell) return null;
  if (tell.windowSec) {
    const [from, to] = tell.windowSec;
    if (atSec < from || atSec > to) return null;
  }
  return {
    matches: !tell.contradicts,
    contradicts: Boolean(tell.contradicts),
    weight: tell.weight,
  };
}

/**
 * Assess every threat in the matchup against the observation list.
 * Threats with no relevant observations stay at their prior.
 */
export function assessThreats(
  threats: Threat[],
  observations: ScoutingObservation[],
): ThreatAssessment[] {
  return threats.map((threat) => {
    let odds = logOdds(threat.priorProbability);
    const matchedTells: string[] = [];
    const contradictedTells: string[] = [];
    for (const obs of observations) {
      const applied = observationApplies(threat, obs.tellId, obs.atSec);
      if (!applied) continue;
      if (applied.contradicts) {
        odds -= applied.weight * CONTRADICT_SCALE;
        contradictedTells.push(obs.tellId);
      } else {
        odds += applied.weight * SUPPORT_SCALE;
        matchedTells.push(obs.tellId);
      }
    }
    const probability = Math.round(sigmoid(odds) * 100) / 100;
    return {
      threatId: threat.id,
      probability,
      active: probability >= ACTIVE_THRESHOLD,
      matchedTells,
      contradictedTells,
    };
  });
}

/**
 * Threats the optimizer defends against, with probabilities.
 *
 * EVERY enabled threat in the matchup participates — an unscouted
 * game still has to respect the baseline meta, weighted by each
 * threat's prior. Without this the empty-scouting case has zero
 * safety constraints and the search degenerates into a pure-economy
 * build with no defense at all. Scouting raises (or, for
 * contradicted threats, collapses) the weights; `forced` ids (user
 * pinned a threat) are floored at the active threshold.
 */
export function activeThreatSet(
  threats: Threat[],
  assessments: ThreatAssessment[],
  forced: ReadonlySet<string>,
): { threat: Threat; probability: number }[] {
  const byId = new Map(assessments.map((a) => [a.threatId, a]));
  return threats.map((threat) => {
    const assessment = byId.get(threat.id);
    let probability = assessment?.probability ?? threat.priorProbability;
    if (forced.has(threat.id)) {
      probability = Math.max(probability, ACTIVE_THRESHOLD);
    }
    return { threat, probability };
  });
}
