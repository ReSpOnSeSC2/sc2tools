/**
 * Streak detection + recency-weighted momentum for the H2H "Streaks
 * & Momentum" view. Operates on the same `H2HGame[]` array that
 * `h2hSeries` uses, sorted chronologically (oldest → newest).
 *
 * Conventions:
 *   - Tie / unknown rows do NOT extend or break a streak — they are
 *     skipped over entirely. This mirrors the existing analyzer
 *     behavior (`TrendsTab.streakFromSeries`) and reflects how
 *     SC2 ladder views treat unfinished or aborted matches.
 *   - The "current streak" is computed from the newest end of the
 *     array and reaches as far back as the previous result type
 *     differs (or as far as the array goes when all wins/losses).
 *   - Momentum is symmetric: a perfect win streak yields exactly the
 *     opposite of a perfect loss streak, capped at ±100.
 */

import type { H2HGame } from "@/lib/h2hSeries";
import { decidedOnly, gameOutcome } from "@/lib/h2hSeries";

export type StreakKind = "win" | "loss";

export type CurrentStreak = {
  kind: StreakKind | null;
  count: number;
  /** Indexes (into chrono decided[]) covered by the current streak. */
  indexes: number[];
};

export type StreakRun = {
  kind: StreakKind;
  count: number;
  /** First (oldest) index of the run, in chrono decided[]. */
  start: number;
  /** Last (newest) index of the run, in chrono decided[], inclusive. */
  end: number;
  /** Game references for tooltip rendering. */
  games: H2HGame[];
};

export type StreaksSummary = {
  current: CurrentStreak;
  longestWin: StreakRun | null;
  longestLoss: StreakRun | null;
  /** Every run with count ≥ 2, ordered oldest → newest. */
  notableRuns: StreakRun[];
};

/**
 * Compute streak summary statistics from a chronological games array.
 */
export function streaksSummary(chronoGames: H2HGame[]): StreaksSummary {
  const decided = decidedOnly(chronoGames);
  const runs = enumerateRuns(decided);
  const longestWin = pickLongest(runs, "win");
  const longestLoss = pickLongest(runs, "loss");
  const current = currentStreakFromRuns(runs, decided.length);
  const notableRuns = runs.filter((r) => r.count >= 2);
  return { current, longestWin, longestLoss, notableRuns };
}

function enumerateRuns(decided: H2HGame[]): StreakRun[] {
  const runs: StreakRun[] = [];
  let active: StreakRun | null = null;
  for (let i = 0; i < decided.length; i++) {
    const o = gameOutcome(decided[i]);
    if (o !== "W" && o !== "L") continue;
    const kind: StreakKind = o === "W" ? "win" : "loss";
    if (!active || active.kind !== kind) {
      if (active) runs.push(active);
      active = { kind, count: 1, start: i, end: i, games: [decided[i]] };
    } else {
      active.count++;
      active.end = i;
      active.games.push(decided[i]);
    }
  }
  if (active) runs.push(active);
  return runs;
}

function pickLongest(runs: StreakRun[], kind: StreakKind): StreakRun | null {
  let best: StreakRun | null = null;
  for (const r of runs) {
    if (r.kind !== kind) continue;
    if (!best || r.count > best.count) best = r;
  }
  return best;
}

function currentStreakFromRuns(
  runs: StreakRun[],
  decidedLength: number,
): CurrentStreak {
  if (runs.length === 0) return { kind: null, count: 0, indexes: [] };
  const last = runs[runs.length - 1];
  if (last.end !== decidedLength - 1) {
    return { kind: null, count: 0, indexes: [] };
  }
  const indexes: number[] = [];
  for (let i = last.start; i <= last.end; i++) indexes.push(i);
  return { kind: last.kind, count: last.count, indexes };
}

/**
 * Recency-weighted momentum score in [-100, 100]. Operates on the
 * last `windowN` decided games (default 10), exponentially decayed so
 * the most recent game contributes ×1.0 and the n-th newest
 * contributes `decay**(n-1)`.
 *
 * Returns 0 when fewer than 1 decided game exists in the window.
 */
export function momentumScore(
  chronoGames: H2HGame[],
  windowN = 10,
  decay = 0.93,
): number {
  const decided = decidedOnly(chronoGames);
  if (decided.length === 0) return 0;
  const slice = decided.slice(-windowN);
  let weightedSum = 0;
  let totalWeight = 0;
  for (let i = 0; i < slice.length; i++) {
    const o = gameOutcome(slice[i]);
    const distFromNewest = slice.length - 1 - i;
    const w = Math.pow(decay, distFromNewest);
    totalWeight += w;
    weightedSum += (o === "W" ? 1 : -1) * w;
  }
  if (totalWeight === 0) return 0;
  const raw = weightedSum / totalWeight;
  return Math.max(-100, Math.min(100, Math.round(raw * 100)));
}

/**
 * Delta between the most recent `windowN` momentum and the previous
 * `windowN` window. Returns null when there isn't enough history for
 * a comparison (need at least `windowN` games before the recent
 * window, i.e. ≥ `windowN * 2` decided games total).
 */
export function momentumDelta(
  chronoGames: H2HGame[],
  windowN = 10,
  decay = 0.93,
): number | null {
  const decided = decidedOnly(chronoGames);
  if (decided.length < windowN * 2) return null;
  const recent = decided.slice(-windowN);
  const prior = decided.slice(-windowN * 2, -windowN);
  return momentumScore(recent, windowN, decay) - momentumScore(prior, windowN, decay);
}
