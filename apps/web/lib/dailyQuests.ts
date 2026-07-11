// Daily Ladder Quests — pure client-side quest selection + verification
// over the user's own games. Bridges the Arcade's retention loop into an
// improvement loop: 3 quests per day, derived from the player's actual
// history, auto-verified from ingested replays, paying Arcade XP.
//
// Design constraints (mirrors lib/seasonRecap.ts):
//   - No I/O and no React. Everything is deterministic over the inputs so
//     the vitest fixtures fully specify behavior.
//   - Every quest verifies ONLY from fields that exist on the slim
//     ArcadeGame list rows (result, date, myBuild, oppRace, myMmr, oppMmr,
//     duration, map, macro_score). There is no detailed macroBreakdown on
//     the client-side list rows, so nothing here may assume one.
//   - Null-safe by design: rows routinely miss myMmr, duration, map or
//     macro_score (older agent versions, partial ingests). Every quest
//     documents its data requirement and self-excludes from selection
//     when the corpus can't support it.
//
// Determinism / cross-device contract:
//   - selectDailyQuests seeds with mulberry32(dailySeed(userId, dateKey))
//     — the EXACT helpers ArcadeEngine's Daily Drop / Daily Run use — so
//     every device shows the same 3 quests for the same (user, day).
//   - Personal thresholds (worst matchup, macro average, struggle map …)
//     are computed relative to `dateKey`, never `Date.now()`, so the same
//     corpus + date always yields the same quests.
//
// Daily-key convention (MATCHES the arcade):
//   - The day key is ArcadeEngine.todayKey(now, tz): "YYYY-MM-DD" in the
//     user's IANA timezone (Intl "en-CA" format — a LOCAL calendar day,
//     the same convention Buildle's buildleByDay map and the daily seed
//     use). A game counts toward `dateKey` when its timestamp formats to
//     that key in the given tz — see gamesOnDay().

import type { ArcadeGame } from "@/components/analyzer/arcade/types";
import {
  dailySeed,
  isGameTooShort,
  mulberry32,
  outcome,
  shuffle,
  todayKey,
} from "@/components/analyzer/arcade/ArcadeEngine";

/* ──────────────── tuning constants ──────────────── */

/** How many quests a day serves by default. */
export const DAILY_QUEST_COUNT = 3;

/** Worst-matchup quest needs this many decided games vs the race. */
export const WORST_MATCHUP_MIN_DECIDED = 10;

/** Macro quests need this many corpus games carrying a macro_score. */
export const MACRO_MIN_SCORED = 5;
/** The 2-game macro quest needs a bit more history. */
export const MACRO_HOLD_MIN_SCORED = 8;
/** Macro average window: the most recent N scored games. */
export const MACRO_RECENT_WINDOW = 20;

/** Signature build needs this many plays to count as "signature". */
export const SIGNATURE_BUILD_MIN_GAMES = 5;

/** Struggle-map quest: window (days before dateKey) proxying "today's pool". */
export const STRUGGLE_MAP_WINDOW_DAYS = 60;
/** …and this many decided games on the map inside that window. */
export const STRUGGLE_MAP_MIN_DECIDED = 4;
/** …and a winrate strictly below this to count as "struggling". */
export const STRUGGLE_MAP_MAX_WINRATE = 0.55;

/** Long-game quest needs this many wins carrying a duration. */
export const LONG_GAME_MIN_TIMED_WINS = 5;

/** MMR quests need this many corpus rows carrying the relevant MMR field(s). */
export const MMR_MIN_GAMES = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

/* ──────────────── types ──────────────── */

/**
 * Selection picks at most one quest per category, so a day never serves
 * two variations of the same idea (e.g. both macro quests).
 */
export type QuestCategory =
  | "participation"
  | "wins"
  | "matchup"
  | "macro"
  | "build"
  | "map"
  | "streak"
  | "mmr"
  | "duration"
  | "mental"
  | "climb";

export interface QuestProgress {
  /** Bounded to [0, target]. */
  progress: number;
  done: boolean;
}

/** One personalized, ready-to-verify quest for a specific day. */
export interface QuestDef {
  /** Stable pool id — the claim ledger keys on (dateKey, id). */
  id: string;
  category: QuestCategory;
  title: string;
  description: string;
  target: number;
  xp: number;
  /**
   * Pure verifier over the games played on the quest's day (already
   * filtered + sorted ascending by evaluateQuests). Personalized
   * parameters (race, thresholds, build/map names) are closed over at
   * build() time; `context` is passed for verifiers that want corpus
   * stats, but most ignore it.
   */
  verify(gamesToday: ArcadeGame[], context: QuestContext): QuestProgress;
}

/** Pool entry: eligibility gate + personalized QuestDef factory. */
export interface QuestSpec {
  id: string;
  category: QuestCategory;
  /** Human note documenting the data this quest requires. */
  requires: string;
  eligible(context: QuestContext): boolean;
  /** Only called when eligible(context) is true. */
  build(context: QuestContext): QuestDef;
}

export interface QuestWorstMatchup {
  race: "P" | "T" | "Z";
  decided: number;
  winRate: number;
}

export interface QuestSignatureBuild {
  name: string;
  games: number;
  wins: number;
  winRate: number;
}

export interface QuestStruggleMap {
  name: string;
  decided: number;
  winRate: number;
}

/**
 * Derived personal stats computed once from the full corpus. Every field
 * is null / zero when the corpus can't support it — the matching quest
 * then self-excludes from selection.
 */
export interface QuestContext {
  dateKey: string;
  totalGames: number;
  /** Lowest-winrate matchup with ≥ WORST_MATCHUP_MIN_DECIDED decided games. */
  worstMatchup: QuestWorstMatchup | null;
  /** Corpus rows carrying a finite macro_score. */
  macroScoredGames: number;
  /** Mean macro_score over the most recent MACRO_RECENT_WINDOW scored games. */
  macroRecentAvg: number | null;
  /** Most-played real build (≥ SIGNATURE_BUILD_MIN_GAMES, too-short excluded). */
  signatureBuild: QuestSignatureBuild | null;
  /** Worst recent map (see STRUGGLE_MAP_* constants). */
  struggleMap: QuestStruggleMap | null;
  /** Wins carrying a finite positive duration. */
  timedWins: number;
  /** Median duration of those wins, in minutes. */
  medianWinMinutes: number | null;
  /** Rows carrying BOTH finite myMmr and opponent MMR. */
  mmrPairGames: number;
  /** Rows carrying a finite myMmr. */
  ratedGames: number;
}

export interface DailyQuestSelection {
  dateKey: string;
  context: QuestContext;
  /** Up to `n` quests, distinct categories, deterministic for (user, day). */
  quests: QuestDef[];
}

export interface QuestEvaluation {
  quest: QuestDef;
  progress: number;
  done: boolean;
}

/* ──────────────── small helpers ──────────────── */

function isFinite_(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Opponent MMR: prefer the top-level field, fall back to opponent.mmr. */
function oppMmrOf(g: ArcadeGame): number | null {
  if (isFinite_(g.oppMmr)) return g.oppMmr;
  const nested = g.opponent?.mmr;
  return isFinite_(nested) ? nested : null;
}

function raceLetter(v: unknown): "P" | "T" | "Z" | null {
  const c = String(v ?? "").trim().charAt(0).toUpperCase();
  return c === "P" || c === "T" || c === "Z" ? c : null;
}

const RACE_NAME: Record<"P" | "T" | "Z", string> = {
  P: "Protoss",
  T: "Terran",
  Z: "Zerg",
};

function clampNumber(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function capped(count: number, target: number): QuestProgress {
  const progress = clampNumber(count, 0, target);
  return { progress, done: progress >= target };
}

/**
 * Games that fall on `dateKey` (the arcade's LOCAL-day convention —
 * ArcadeEngine.todayKey in the user's tz), sorted chronologically
 * ascending. Rows with unparseable dates can't be placed on a day and
 * are dropped.
 */
export function gamesOnDay(
  games: ReadonlyArray<ArcadeGame>,
  dateKey: string,
  tz: string,
): ArcadeGame[] {
  return games
    .map((g) => ({ g, t: Date.parse(g.date) }))
    .filter((r) => Number.isFinite(r.t) && todayKey(new Date(r.t), tz) === dateKey)
    .sort((a, b) => a.t - b.t)
    .map((r) => r.g);
}

/* ──────────────── context builder ──────────────── */

export function buildQuestContext(
  games: ReadonlyArray<ArcadeGame>,
  dateKey: string,
): QuestContext {
  // Chronological ordering for "most recent N" windows. Rows with
  // unparseable dates keep counting toward totals but can't join the
  // ordered windows.
  const ordered = games
    .map((g) => ({ g, t: Date.parse(g.date) }))
    .filter((r) => Number.isFinite(r.t))
    .sort((a, b) => a.t - b.t);

  /* worst matchup */
  const byRace = new Map<"P" | "T" | "Z", { wins: number; losses: number }>();
  for (const g of games) {
    const race = raceLetter(g.oppRace);
    if (!race) continue;
    const o = outcome(g);
    if (o === "U") continue;
    let rec = byRace.get(race);
    if (!rec) {
      rec = { wins: 0, losses: 0 };
      byRace.set(race, rec);
    }
    if (o === "W") rec.wins += 1;
    else rec.losses += 1;
  }
  let worstMatchup: QuestWorstMatchup | null = null;
  for (const race of ["P", "T", "Z"] as const) {
    const rec = byRace.get(race);
    if (!rec) continue;
    const decided = rec.wins + rec.losses;
    if (decided < WORST_MATCHUP_MIN_DECIDED) continue;
    const winRate = rec.wins / decided;
    if (
      !worstMatchup ||
      winRate < worstMatchup.winRate ||
      (winRate === worstMatchup.winRate && decided > worstMatchup.decided)
    ) {
      worstMatchup = { race, decided, winRate };
    }
  }

  /* macro history */
  const scored = ordered.filter((r) => isFinite_(r.g.macro_score));
  const recentScored = scored.slice(-MACRO_RECENT_WINDOW);
  const macroRecentAvg =
    recentScored.length > 0
      ? recentScored.reduce((s, r) => s + (r.g.macro_score as number), 0) /
        recentScored.length
      : null;

  /* signature build */
  const byBuild = new Map<
    string,
    { name: string; games: number; wins: number; losses: number }
  >();
  for (const g of games) {
    const name = typeof g.myBuild === "string" ? g.myBuild.trim() : "";
    if (!name || isGameTooShort(name)) continue;
    let rec = byBuild.get(name.toLowerCase());
    if (!rec) {
      rec = { name, games: 0, wins: 0, losses: 0 };
      byBuild.set(name.toLowerCase(), rec);
    }
    rec.games += 1;
    const o = outcome(g);
    if (o === "W") rec.wins += 1;
    else if (o === "L") rec.losses += 1;
  }
  const bestBuild = [...byBuild.values()]
    .filter((b) => b.games >= SIGNATURE_BUILD_MIN_GAMES)
    .sort(
      (a, b) =>
        b.games - a.games ||
        decidedWinrate(b.wins, b.losses) - decidedWinrate(a.wins, a.losses) ||
        a.name.localeCompare(b.name),
    )[0];
  const signatureBuild: QuestSignatureBuild | null = bestBuild
    ? {
        name: bestBuild.name,
        games: bestBuild.games,
        wins: bestBuild.wins,
        winRate: decidedWinrate(bestBuild.wins, bestBuild.losses),
      }
    : null;

  /* struggle map — recent window anchored on dateKey (NOT Date.now(), so
     selection stays deterministic for a given date) */
  const anchor = Date.parse(`${dateKey}T00:00:00Z`);
  const mapCutoff = Number.isFinite(anchor)
    ? anchor - STRUGGLE_MAP_WINDOW_DAYS * DAY_MS
    : Number.NEGATIVE_INFINITY;
  const byMap = new Map<string, { name: string; wins: number; losses: number }>();
  for (const r of ordered) {
    if (r.t < mapCutoff) continue;
    const name = typeof r.g.map === "string" ? r.g.map.trim() : "";
    if (!name) continue;
    const o = outcome(r.g);
    if (o === "U") continue;
    let rec = byMap.get(name.toLowerCase());
    if (!rec) {
      rec = { name, wins: 0, losses: 0 };
      byMap.set(name.toLowerCase(), rec);
    }
    if (o === "W") rec.wins += 1;
    else rec.losses += 1;
  }
  let struggleMap: QuestStruggleMap | null = null;
  for (const rec of [...byMap.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const decided = rec.wins + rec.losses;
    if (decided < STRUGGLE_MAP_MIN_DECIDED) continue;
    const winRate = rec.wins / decided;
    if (winRate >= STRUGGLE_MAP_MAX_WINRATE) continue;
    if (
      !struggleMap ||
      winRate < struggleMap.winRate ||
      (winRate === struggleMap.winRate && decided > struggleMap.decided)
    ) {
      struggleMap = { name: rec.name, decided, winRate };
    }
  }

  /* long-game median */
  const winDurations = games
    .filter((g) => outcome(g) === "W" && isFinite_(g.duration) && (g.duration as number) > 0)
    .map((g) => g.duration as number)
    .sort((a, b) => a - b);
  const medianWinMinutes =
    winDurations.length >= LONG_GAME_MIN_TIMED_WINS
      ? median(winDurations) / 60
      : null;

  /* MMR coverage */
  let mmrPairGames = 0;
  let ratedGames = 0;
  for (const g of games) {
    const mine = isFinite_(g.myMmr);
    if (mine) ratedGames += 1;
    if (mine && oppMmrOf(g) !== null) mmrPairGames += 1;
  }

  return {
    dateKey,
    totalGames: games.length,
    worstMatchup,
    macroScoredGames: scored.length,
    macroRecentAvg,
    signatureBuild,
    struggleMap,
    timedWins: winDurations.length,
    medianWinMinutes,
    mmrPairGames,
    ratedGames,
  };
}

function decidedWinrate(wins: number, losses: number): number {
  const decided = wins + losses;
  return decided > 0 ? wins / decided : 0;
}

function median(sortedAsc: number[]): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sortedAsc[mid] : (sortedAsc[mid - 1] + sortedAsc[mid]) / 2;
}

/* ──────────────── the quest pool ──────────────── */

/**
 * 12 quest definitions across 11 categories. Every verifier reads ONLY
 * fields present on ArcadeGame list rows; every spec documents its data
 * requirement in `requires` and enforces it in `eligible`.
 */
export const QUEST_POOL: QuestSpec[] = [
  {
    id: "play-3",
    category: "participation",
    requires: "≥1 game ever (result/date only).",
    eligible: (ctx) => ctx.totalGames >= 1,
    build: () => ({
      id: "play-3",
      category: "participation",
      title: "Warm up the ladder",
      description: "Play 3 ladder games today.",
      target: 3,
      xp: 20,
      verify: (today) => capped(today.length, 3),
    }),
  },
  {
    id: "win-2",
    category: "wins",
    requires: "≥3 games ever (result only).",
    eligible: (ctx) => ctx.totalGames >= 3,
    build: () => ({
      id: "win-2",
      category: "wins",
      title: "Double up",
      description: "Win 2 games today.",
      target: 2,
      xp: 30,
      verify: (today) => capped(today.filter((g) => outcome(g) === "W").length, 2),
    }),
  },
  {
    id: "worst-matchup-win",
    category: "matchup",
    requires: `≥${WORST_MATCHUP_MIN_DECIDED} decided games vs one race (oppRace + result).`,
    eligible: (ctx) => ctx.worstMatchup !== null,
    build: (ctx) => {
      const m = ctx.worstMatchup as QuestWorstMatchup;
      const pct = Math.round(m.winRate * 100);
      return {
        id: "worst-matchup-win",
        category: "matchup",
        title: `Face your demons: beat ${RACE_NAME[m.race]}`,
        description: `Win a game against ${RACE_NAME[m.race]} — your toughest matchup at ${pct}% over ${m.decided} games.`,
        target: 1,
        xp: 40,
        verify: (today) =>
          capped(
            today.filter(
              (g) => outcome(g) === "W" && raceLetter(g.oppRace) === m.race,
            ).length,
            1,
          ),
      };
    },
  },
  {
    id: "macro-beat-average",
    category: "macro",
    requires: `≥${MACRO_MIN_SCORED} games carrying macro_score.`,
    eligible: (ctx) =>
      ctx.macroScoredGames >= MACRO_MIN_SCORED && ctx.macroRecentAvg !== null,
    build: (ctx) => {
      const avg = ctx.macroRecentAvg as number;
      // Recent average +5, clamped so the bar stays reachable.
      const threshold = clampNumber(Math.round(avg + 5), 40, 95);
      return {
        id: "macro-beat-average",
        category: "macro",
        title: `Macro up: score ${threshold}+`,
        description: `Finish a game with a macro score of ${threshold} or higher (your recent average is ${Math.round(avg)}).`,
        target: 1,
        xp: 35,
        verify: (today) =>
          capped(
            today.filter(
              (g) => isFinite_(g.macro_score) && (g.macro_score as number) >= threshold,
            ).length,
            1,
          ),
      };
    },
  },
  {
    id: "macro-hold-the-line",
    category: "macro",
    requires: `≥${MACRO_HOLD_MIN_SCORED} games carrying macro_score.`,
    eligible: (ctx) =>
      ctx.macroScoredGames >= MACRO_HOLD_MIN_SCORED && ctx.macroRecentAvg !== null,
    build: (ctx) => {
      const avg = ctx.macroRecentAvg as number;
      const threshold = clampNumber(Math.round(avg), 35, 90);
      return {
        id: "macro-hold-the-line",
        category: "macro",
        title: `Hold the line: 2 games at ${threshold}+ macro`,
        description: `Post a macro score of ${threshold} or better (your recent average) in 2 games today.`,
        target: 2,
        xp: 40,
        verify: (today) =>
          capped(
            today.filter(
              (g) => isFinite_(g.macro_score) && (g.macro_score as number) >= threshold,
            ).length,
            2,
          ),
      };
    },
  },
  {
    id: "signature-build-win",
    category: "build",
    requires: `One build with ≥${SIGNATURE_BUILD_MIN_GAMES} plays (myBuild; too-short excluded).`,
    eligible: (ctx) => ctx.signatureBuild !== null,
    build: (ctx) => {
      const b = ctx.signatureBuild as QuestSignatureBuild;
      return {
        id: "signature-build-win",
        category: "build",
        title: "Trust your signature",
        description: `Win a game with ${b.name} — your most-played build (${b.games} games).`,
        target: 1,
        xp: 35,
        verify: (today) =>
          capped(
            today.filter(
              (g) =>
                outcome(g) === "W" &&
                typeof g.myBuild === "string" &&
                g.myBuild.trim().toLowerCase() === b.name.toLowerCase(),
            ).length,
            1,
          ),
      };
    },
  },
  {
    id: "struggle-map-win",
    category: "map",
    requires: `A map with ≥${STRUGGLE_MAP_MIN_DECIDED} decided games in the last ${STRUGGLE_MAP_WINDOW_DAYS} days at <${Math.round(STRUGGLE_MAP_MAX_WINRATE * 100)}% winrate (map + result).`,
    eligible: (ctx) => ctx.struggleMap !== null,
    build: (ctx) => {
      const m = ctx.struggleMap as QuestStruggleMap;
      const pct = Math.round(m.winRate * 100);
      return {
        id: "struggle-map-win",
        category: "map",
        title: `Map revenge: ${m.name}`,
        description: `Win a game on ${m.name} — you're at ${pct}% there over your recent games.`,
        target: 1,
        xp: 40,
        verify: (today) =>
          capped(
            today.filter(
              (g) =>
                outcome(g) === "W" &&
                typeof g.map === "string" &&
                g.map.trim().toLowerCase() === m.name.toLowerCase(),
            ).length,
            1,
          ),
      };
    },
  },
  {
    id: "win-streak-2",
    category: "streak",
    requires: "≥8 games ever (result only).",
    eligible: (ctx) => ctx.totalGames >= 8,
    build: () => ({
      id: "win-streak-2",
      category: "streak",
      title: "Heat up: win 2 in a row",
      description: "Win two consecutive games today — a loss resets the run.",
      target: 2,
      xp: 35,
      // Progress = the best consecutive-win run today (undecided games
      // are skipped, same as ArcadeEngine's streak helpers).
      verify: (today) => {
        let best = 0;
        let run = 0;
        for (const g of today) {
          const o = outcome(g);
          if (o === "W") {
            run += 1;
            if (run > best) best = run;
          } else if (o === "L") {
            run = 0;
          }
        }
        return capped(best, 2);
      },
    }),
  },
  {
    id: "giant-slayer",
    category: "mmr",
    requires: `≥${MMR_MIN_GAMES} games carrying both myMmr and opponent MMR.`,
    eligible: (ctx) => ctx.mmrPairGames >= MMR_MIN_GAMES,
    build: () => ({
      id: "giant-slayer",
      category: "mmr",
      title: "Giant slayer",
      description: "Beat an opponent rated above your own MMR today.",
      target: 1,
      xp: 40,
      verify: (today) =>
        capped(
          today.filter((g) => {
            if (outcome(g) !== "W" || !isFinite_(g.myMmr)) return false;
            const opp = oppMmrOf(g);
            return opp !== null && opp > (g.myMmr as number);
          }).length,
          1,
        ),
    }),
  },
  {
    id: "long-game-win",
    category: "duration",
    requires: `≥${LONG_GAME_MIN_TIMED_WINS} wins carrying a duration.`,
    eligible: (ctx) => ctx.medianWinMinutes !== null,
    build: (ctx) => {
      // Median win length, clamped to a sane macro-game band.
      const minutes = clampNumber(Math.round(ctx.medianWinMinutes as number), 8, 15);
      return {
        id: "long-game-win",
        category: "duration",
        title: "Go the distance",
        description: `Win a game that lasts ${minutes}+ minutes — no coin-flip cheese.`,
        target: 1,
        xp: 30,
        verify: (today) =>
          capped(
            today.filter(
              (g) =>
                outcome(g) === "W" &&
                isFinite_(g.duration) &&
                (g.duration as number) >= minutes * 60,
            ).length,
            1,
          ),
      };
    },
  },
  {
    id: "bounce-back",
    category: "mental",
    requires: "≥5 games ever (result only).",
    eligible: (ctx) => ctx.totalGames >= 5,
    build: () => ({
      id: "bounce-back",
      category: "mental",
      title: "Bounce back",
      description: "Win the game right after a loss today — tilt control.",
      target: 1,
      xp: 30,
      // Adjacency over the DECIDED sequence (undecided rows skipped).
      verify: (today) => {
        const decided = today.map(outcome).filter((o) => o !== "U");
        for (let i = 1; i < decided.length; i++) {
          if (decided[i - 1] === "L" && decided[i] === "W") {
            return { progress: 1, done: true };
          }
        }
        return { progress: 0, done: false };
      },
    }),
  },
  {
    id: "mmr-climb",
    category: "climb",
    requires: `≥${MMR_MIN_GAMES} games carrying myMmr.`,
    eligible: (ctx) => ctx.ratedGames >= MMR_MIN_GAMES,
    build: () => ({
      id: "mmr-climb",
      category: "climb",
      title: "End the day up",
      description:
        "Finish today with a higher MMR than your first game (needs 2+ rated games).",
      target: 1,
      xp: 35,
      // myMmr is the rating recorded on each game row; last-vs-first
      // approximates the session delta. Needs ≥2 rated games today.
      verify: (today) => {
        const rated = today.filter((g) => isFinite_(g.myMmr));
        if (rated.length < 2) return { progress: 0, done: false };
        const first = rated[0].myMmr as number;
        const last = rated[rated.length - 1].myMmr as number;
        return last > first ? { progress: 1, done: true } : { progress: 0, done: false };
      },
    }),
  },
];

/* ──────────────── selection + evaluation ──────────────── */

/**
 * Pick up to `n` eligible quests for the day, personalized from the full
 * corpus, with distinct categories.
 *
 * Deterministic: seeded by mulberry32(dailySeed(userId, dateKey)) — the
 * same derivation the arcade's Daily Drop / Daily Run use — so every
 * device shows the same quests for the same (user, day). Pass the same
 * userId the arcade uses (useDailySeed falls back to "anonymous" when
 * signed out); the default keeps the pure-module call sites working.
 */
export function selectDailyQuests(
  dateKey: string,
  games: ReadonlyArray<ArcadeGame>,
  n: number = DAILY_QUEST_COUNT,
  userId: string = "anonymous",
): DailyQuestSelection {
  const context = buildQuestContext(games, dateKey);
  const eligible = QUEST_POOL.filter((spec) => spec.eligible(context));
  const rng = mulberry32(dailySeed(userId, dateKey));
  const quests: QuestDef[] = [];
  const seen = new Set<QuestCategory>();
  for (const spec of shuffle(eligible, rng)) {
    if (seen.has(spec.category)) continue;
    seen.add(spec.category);
    quests.push(spec.build(context));
    if (quests.length >= n) break;
  }
  return { dateKey, context, quests };
}

/**
 * Evaluate progress/done for each selected quest, counting ONLY games
 * whose timestamp falls on `dateKey` in the user's tz (the arcade's
 * LOCAL-day convention — ArcadeEngine.todayKey).
 *
 * `context` should be the one returned by selectDailyQuests; when
 * omitted it is recomputed from `allGames` (identical by construction —
 * both derive from the same corpus + dateKey).
 */
export function evaluateQuests(
  selected: ReadonlyArray<QuestDef>,
  allGames: ReadonlyArray<ArcadeGame>,
  dateKey: string,
  tz: string,
  context?: QuestContext,
): QuestEvaluation[] {
  const ctx = context ?? buildQuestContext(allGames, dateKey);
  const today = gamesOnDay(allGames, dateKey, tz);
  return selected.map((quest) => {
    const r = quest.verify(today, ctx);
    const progress = clampNumber(r.progress, 0, quest.target);
    return { quest, progress, done: r.done || progress >= quest.target };
  });
}
