/**
 * Safety evaluation: replay each selected threat's attack waves
 * against the defender's simulated state at the moment each wave
 * lands, and report a margin + verdict per wave and per threat.
 */
import type {
  SafetyOptions,
  SafetyReport,
  SafetyVerdict,
  SimResult,
  PatchProfile,
  Threat,
  ThreatSafetyReport,
  WaveReport,
} from "../types";
import {
  GRACE_WINDOW_SEC,
  attackPower,
  defensePower,
} from "./combat";

export const SAFE_MARGIN = 0.2;
export const UNSAFE_MARGIN = -0.1;

export function verdictFor(margin: number): SafetyVerdict {
  if (margin >= SAFE_MARGIN) return "safe";
  if (margin < UNSAFE_MARGIN) return "unsafe";
  return "risky";
}

/** Worst of two verdicts. */
function worse(a: SafetyVerdict, b: SafetyVerdict): SafetyVerdict {
  const rank: Record<SafetyVerdict, number> = { safe: 0, risky: 1, unsafe: 2 };
  return rank[a] >= rank[b] ? a : b;
}

/** Defender units completed at time t (from the sim's completion timeline). */
export function unitsAt(
  sim: SimResult,
  t: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, times] of Object.entries(sim.completionTimes)) {
    let count = 0;
    for (const doneAt of times) {
      if (doneAt <= t) count += 1;
    }
    if (count > 0) out[name] = count;
  }
  return out;
}

function unitsInWindow(
  sim: SimResult,
  from: number,
  to: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, times] of Object.entries(sim.completionTimes)) {
    let count = 0;
    for (const doneAt of times) {
      if (doneAt > from && doneAt <= to) count += 1;
    }
    if (count > 0) out[name] = count;
  }
  return out;
}

function workersAt(sim: SimResult, profile: PatchProfile, t: number): number {
  const counts = unitsAt(sim, t);
  let total = 0;
  for (const [name, count] of Object.entries(counts)) {
    if (profile.units[name]?.isWorker) total += count;
  }
  // starting workers never appear in completionTimes
  total += profile.starting.workers;
  return total;
}

function describeBinding(
  sim: SimResult,
  waveTime: number,
  margin: number,
): string | undefined {
  if (margin >= SAFE_MARGIN) return undefined;
  // Find the next defender completion after the wave — the classic
  // "your zealot pops 8 seconds too late" diagnosis.
  let bestName: string | null = null;
  let bestDelta = Infinity;
  for (const [name, times] of Object.entries(sim.completionTimes)) {
    for (const doneAt of times) {
      const delta = doneAt - waveTime;
      if (delta > 0 && delta < bestDelta) {
        bestDelta = delta;
        bestName = name;
      }
    }
  }
  if (bestName && bestDelta < 45) {
    return `${bestName} completes ${Math.round(bestDelta)}s after this wave lands`;
  }
  return "No additional defense arrives near this wave";
}

/**
 * Evaluate one threat against a sim. Waves are cumulative: the units
 * of earlier waves are assumed to still be attacking (survivors), so
 * defense must outscale the running total — this is what makes
 * "trickle" rushes like 8-pool dangerous in the report, matching
 * how they play out.
 */
export function evaluateThreat(
  sim: SimResult,
  profile: PatchProfile,
  threat: Threat,
  probability: number,
  options: SafetyOptions,
): ThreatSafetyReport {
  const waves: WaveReport[] = [];
  const runningAttack: Record<string, number> = {};
  let verdict: SafetyVerdict = "safe";
  let worstMargin = Infinity;

  for (const wave of threat.waves) {
    for (const [name, count] of Object.entries(wave.units)) {
      runningAttack[name] = (runningAttack[name] ?? 0) + count;
    }
    const atk = attackPower(profile, runningAttack);
    const completed = unitsAt(sim, wave.timeSec);
    const inGrace = unitsInWindow(
      sim,
      wave.timeSec,
      wave.timeSec + GRACE_WINDOW_SEC,
    );
    const defense = defensePower(profile, {
      completed,
      inGrace,
      workers: options.allowWorkerPull && threat.defenderHints.workerPullViable
        ? workersAt(sim, profile, wave.timeSec)
        : 0,
      hasWall: options.hasWall,
      allowWorkerPull:
        options.allowWorkerPull && Boolean(threat.defenderHints.workerPullViable),
      wave: runningAttack,
    });
    const margin = (defense.total - atk) / Math.max(atk, 1);
    const waveVerdict = verdictFor(margin);
    verdict = worse(verdict, waveVerdict);
    worstMargin = Math.min(worstMargin, margin);
    const defenders: Record<string, number> = {};
    for (const c of defense.contributions) defenders[c.name] = c.count;
    waves.push({
      timeSec: wave.timeSec,
      attackPower: Math.round(atk),
      defensePower: Math.round(defense.total),
      margin: Math.round(margin * 100) / 100,
      verdict: waveVerdict,
      defenders,
      bindingNote: describeBinding(sim, wave.timeSec, margin),
    });
  }

  return {
    threatId: threat.id,
    threatName: threat.name,
    probability,
    verdict,
    worstMargin: Number.isFinite(worstMargin)
      ? Math.round(worstMargin * 100) / 100
      : 0,
    waves,
  };
}

export function evaluateSafety(
  sim: SimResult,
  profile: PatchProfile,
  threats: { threat: Threat; probability: number }[],
  options: SafetyOptions,
): SafetyReport {
  const reports = threats.map(({ threat, probability }) =>
    evaluateThreat(sim, profile, threat, probability, options),
  );
  let overall: SafetyVerdict = "safe";
  for (const report of reports) overall = worse(overall, report.verdict);
  return { overall, threats: reports };
}
