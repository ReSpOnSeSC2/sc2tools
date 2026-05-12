// ArcadeEngine — pure helpers used by every mode + the surfaces.
//
// Three responsibilities:
//   1. seeded RNG (mulberry32) + day-seed hash so daily content is
//      identical across devices for the same (user, day);
//   2. depth-tag registry — every mode is registered here so the
//      depth-lint test can assert that no mode ships unset/unknown;
//   3. session/streak helpers shared across temporal/conditional
//      quizzes (4-hour gap → session boundary, active win streak,
//      streak veto runs, etc).
//
// The engine deliberately knows nothing about React. Modes import these
// helpers from generate(); render() composes the JSX shells separately.

import { DEPTH_TAGS, type DepthTag, type ArcadeGame } from "./types";

/* ──────────── seeded RNG ──────────── */

/**
 * mulberry32 — small, fast, deterministic PRNG. Same input seed always
 * produces the same output stream, which is what makes Daily Drop /
 * Daily Run share identically across devices.
 */
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return function next() {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 32-bit FNV-1a hash. Stable across runtimes; cheap. Used to derive a
 * mulberry32 seed from the (userId, daySeed) pair.
 */
export function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Build the daily seed string from a date in the user's tz: "YYYY-MM-DD". */
export function todayKey(now: Date, tz: string): string {
  // Format-via-Intl path; falls back to UTC if the tz is invalid.
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return fmt.format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** Build the ISO week key "YYYY-Www" for the user's tz. */
export function weekKey(now: Date, tz: string): string {
  // ISO week: Monday=1..Sunday=7. We compute this in the user's tz so
  // Sunday-night → Monday-morning transitions snap to the right week
  // boundary.
  const day = todayKey(now, tz); // "YYYY-MM-DD" in tz
  const local = new Date(`${day}T00:00:00Z`);
  const dow = (local.getUTCDay() + 6) % 7; // Monday=0..Sunday=6
  const thursday = new Date(local);
  thursday.setUTCDate(local.getUTCDate() - dow + 3);
  const year = thursday.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(
    ((thursday.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Make the per-day, per-user seed for daily content. */
export function dailySeed(userId: string, day: string): number {
  return fnv1a(`${userId}::${day}`);
}

/* ──────────── outcomes / streak helpers ──────────── */

export type Outcome = "W" | "L" | "U";

export function outcome(g: Pick<ArcadeGame, "result">): Outcome {
  const r = String(g.result || "").toLowerCase();
  if (r === "win" || r === "victory") return "W";
  if (r === "loss" || r === "defeat") return "L";
  return "U";
}

/**
 * Active winning streak for a chronologically-sorted game list (oldest
 * first). Walks newest-backward: count consecutive Ws starting at the
 * most-recent decided game; 0 if the most recent decided game is a
 * loss. Undecided games are skipped.
 */
export function activeWinStreak(gamesAsc: Array<Pick<ArcadeGame, "result">>): number {
  let streak = 0;
  for (let i = gamesAsc.length - 1; i >= 0; i--) {
    const o = outcome(gamesAsc[i]);
    if (o === "W") streak += 1;
    else if (o === "L") return streak;
    // undecided → skip
  }
  return streak;
}

/**
 * Active LOSS streak from the user's POV — i.e., the opponent's
 * current active WIN streak against the user. Mirrors
 * activeWinStreak but counts consecutive Ls. Useful when the surface
 * is phrased from the opponent's perspective ("this rival is on an
 * N-game streak against you"), where calling activeWinStreak would
 * silently invert the framing.
 */
export function activeLossStreak(gamesAsc: Array<Pick<ArcadeGame, "result">>): number {
  let streak = 0;
  for (let i = gamesAsc.length - 1; i >= 0; i--) {
    const o = outcome(gamesAsc[i]);
    if (o === "L") streak += 1;
    else if (o === "W") return streak;
  }
  return streak;
}

/**
 * Longest historical W-streak anywhere in a chronologically-sorted
 * games list. Unlike activeWinStreak, this looks at the whole
 * history rather than just the trailing run, so a player who once
 * won 7 in a row and then lost will still register a 7-streak.
 */
export function longestWinStreak(gamesAsc: Array<Pick<ArcadeGame, "result">>): number {
  let max = 0;
  let cur = 0;
  for (const g of gamesAsc) {
    const o = outcome(g);
    if (o === "W") {
      cur += 1;
      if (cur > max) max = cur;
    } else if (o === "L") {
      cur = 0;
    }
  }
  return max;
}

/**
 * Longest historical L-streak — equivalent to the opponent's longest
 * historical W-streak from the user's perspective.
 */
export function longestLossStreak(gamesAsc: Array<Pick<ArcadeGame, "result">>): number {
  let max = 0;
  let cur = 0;
  for (const g of gamesAsc) {
    const o = outcome(g);
    if (o === "L") {
      cur += 1;
      if (cur > max) max = cur;
    } else if (o === "W") {
      cur = 0;
    }
  }
  return max;
}

/**
 * Longest L-streak that was BROKEN by a subsequent W (the run is
 * counted only if a W follows it; a trailing L-streak with no
 * terminating W is not "broken" yet and is excluded). From the
 * user's perspective: how long was the opponent's biggest win streak
 * against you that you eventually snapped.
 */
export function longestBrokenLossStreak(
  gamesAsc: Array<Pick<ArcadeGame, "result">>,
): number {
  let max = 0;
  let run = 0;
  for (const g of gamesAsc) {
    const o = outcome(g);
    if (o === "L") {
      run += 1;
    } else if (o === "W") {
      if (run > max) max = run;
      run = 0;
    }
  }
  return max;
}

/**
 * Longest W-streak that was BROKEN by a subsequent L. From the
 * user's perspective: how long was your biggest win streak against
 * an opponent that they eventually snapped.
 */
export function longestBrokenWinStreak(
  gamesAsc: Array<Pick<ArcadeGame, "result">>,
): number {
  let max = 0;
  let run = 0;
  for (const g of gamesAsc) {
    const o = outcome(g);
    if (o === "W") {
      run += 1;
    } else if (o === "L") {
      if (run > max) max = run;
      run = 0;
    }
  }
  return max;
}

/**
 * Find every maximal winning-streak run in a chronologically-sorted
 * games list, plus the loss that ended it (if any). Returns the runs
 * with their length, the start/end gameId, and the ending loss gameId.
 * The final run is included only if it ended in a loss; a trailing
 * unterminated run is excluded — historical/active streak views use
 * longestWinStreak / activeWinStreak instead.
 */
export interface StreakRun {
  startId: string;
  endId: string;
  length: number;
  /** The loss game that ended the streak. */
  endedById: string;
  endedByDate: string;
}

export function streakVetoRuns(
  gamesAsc: ArcadeGame[],
): StreakRun[] {
  const runs: StreakRun[] = [];
  let runStart = -1;
  let runLen = 0;
  for (let i = 0; i < gamesAsc.length; i++) {
    const o = outcome(gamesAsc[i]);
    if (o === "W") {
      if (runStart < 0) runStart = i;
      runLen += 1;
    } else if (o === "L") {
      if (runLen > 0 && runStart >= 0) {
        runs.push({
          startId: gamesAsc[runStart].gameId,
          endId: gamesAsc[runStart + runLen - 1].gameId,
          length: runLen,
          endedById: gamesAsc[i].gameId,
          endedByDate: gamesAsc[i].date,
        });
      }
      runStart = -1;
      runLen = 0;
    }
  }
  return runs;
}

/* ──────────── session helpers (4 h gap) ──────────── */

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

export interface Session {
  /** Index into the chronologically-sorted games array. */
  startIndex: number;
  endIndex: number;
  startDate: string;
  endDate: string;
  games: ArcadeGame[];
}

/**
 * Walk a chronologically-sorted games list and split into sessions
 * separated by ≥ 4 h of inactivity.
 */
export function sessionize(gamesAsc: ArcadeGame[]): Session[] {
  if (!gamesAsc.length) return [];
  const sessions: Session[] = [];
  let bucket: ArcadeGame[] = [gamesAsc[0]];
  let bucketStart = 0;
  for (let i = 1; i < gamesAsc.length; i++) {
    const prev = new Date(gamesAsc[i - 1].date).getTime();
    const cur = new Date(gamesAsc[i].date).getTime();
    if (cur - prev >= FOUR_HOURS_MS) {
      sessions.push({
        startIndex: bucketStart,
        endIndex: i - 1,
        startDate: bucket[0].date,
        endDate: bucket[bucket.length - 1].date,
        games: bucket,
      });
      bucket = [];
      bucketStart = i;
    }
    bucket.push(gamesAsc[i]);
  }
  if (bucket.length) {
    sessions.push({
      startIndex: bucketStart,
      endIndex: gamesAsc.length - 1,
      startDate: bucket[0].date,
      endDate: bucket[bucket.length - 1].date,
      games: bucket,
    });
  }
  return sessions;
}

/* ──────────── shared predicates ──────────── */

/**
 * Cannon-rush predicate. The Closer's Eye mode excludes any build
 * whose name contains "cannon rush" (case-insensitive) before its
 * mean-win-length scan. Defined here so tests can assert it once
 * and every consumer stays in lockstep.
 */
export function isCannonRush(name: string | null | undefined): boolean {
  if (typeof name !== "string") return false;
  return name.toLowerCase().includes("cannon rush");
}

/* ──────────── shuffle / pick helpers ──────────── */

/**
 * In-place Fisher-Yates shuffle using the supplied RNG. Operates on a
 * copy so the caller's array is preserved (modes are pure generators
 * and can't mutate the dataset).
 */
export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Pick N distinct elements via shuffle-and-take. */
export function pickN<T>(items: readonly T[], n: number, rng: () => number): T[] {
  return shuffle(items, rng).slice(0, Math.min(n, items.length));
}

/* ──────────── XP / level math ──────────── */

/** XP curve: level up every 100 + 50 * (level - 1) XP. */
export function levelForXp(xp: number): number {
  let level = 1;
  let need = 100;
  let acc = 0;
  while (acc + need <= xp) {
    acc += need;
    level += 1;
    need = 100 + 50 * (level - 1);
  }
  return level;
}

export function xpForNextLevel(xp: number): { current: number; needed: number } {
  let level = 1;
  let need = 100;
  let acc = 0;
  while (acc + need <= xp) {
    acc += need;
    level += 1;
    need = 100 + 50 * (level - 1);
  }
  return { current: xp - acc, needed: need };
}

/* ──────────── depthTag registry (depth lint surface) ──────────── */

/**
 * Every mode must register its depthTag at module-eval time. The
 * depthLint test asserts that the registry is non-empty AND that
 * every value is one of the DEPTH_TAGS enum members. Modes that fail
 * to register are caught by the per-mode lint that walks the modes
 * directory.
 */
const REGISTERED: Record<string, DepthTag> = {};

export function registerMode(id: string, depthTag: DepthTag): void {
  if (!DEPTH_TAGS.includes(depthTag)) {
    throw new Error(
      `[arcade] mode "${id}" registered with unknown depthTag "${depthTag}"`,
    );
  }
  REGISTERED[id] = depthTag;
}

export function depthTagFor(id: string): DepthTag | undefined {
  return REGISTERED[id];
}

export function allRegistered(): Record<string, DepthTag> {
  return { ...REGISTERED };
}
