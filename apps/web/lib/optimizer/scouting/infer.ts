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
 * Threats the optimizer should defend against, with probabilities.
 * `forced` ids (user manually pinned a threat) are always included
 * at no less than the active threshold.
 */
export function activeThreatSet(
  threats: Threat[],
  assessments: ThreatAssessment[],
  forced: ReadonlySet<string>,
): { threat: Threat; probability: number }[] {
  const byId = new Map(assessments.map((a) => [a.threatId, a]));
  const out: { threat: Threat; probability: number }[] = [];
  for (const threat of threats) {
    const assessment = byId.get(threat.id);
    const probability = assessment?.probability ?? threat.priorProbability;
    if (forced.has(threat.id)) {
      out.push({ threat, probability: Math.max(probability, ACTIVE_THRESHOLD) });
    } else if (assessment?.active) {
      out.push({ threat, probability });
    }
  }
  return out;
}
