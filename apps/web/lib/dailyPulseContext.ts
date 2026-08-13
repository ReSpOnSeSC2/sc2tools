// Daily Pulse — context layer. Computes the per-day PulseContext (the
// derived personal stats every pulse card reads) from the user's slim
// game rows. The card pool + daily selection live in lib/dailyPulse.ts;
// this module owns the tuning constants, the stat types, and the
// deterministic corpus crunching.
//
// Design constraints (mirrors lib/dailyQuests.ts and lib/seasonRecap.ts):
//   - No I/O and no React. Everything is deterministic over the inputs
//     so the vitest fixtures fully specify behavior.
//   - Every stat derives ONLY from fields that exist on the slim
//     ArcadeGame list rows (result, date, myBuild, oppRace, myMmr,
//     myToonHandle, oppMmr, duration, map, macro_score, opponent.*).
//     Nothing here may assume the heavy game_details blob.
//   - Null-safe by design: rows routinely miss myMmr, duration, map or
//     macro_score (older agent versions, partial ingests). Every field
//     is null / zero when the corpus can't support it, and the matching
//     card self-excludes from selection. NOTHING is ever synthesised.
//   - Every window is anchored on `dateKey`, never Date.now(), so the
//     same corpus + (user, day) builds the same context on every device.
//
// Daily-key convention (MATCHES the arcade): the day key is
// ArcadeEngine.todayKey(now, tz) — "YYYY-MM-DD" in the user's IANA
// timezone. "Yesterday" and throwback days shift that key by whole
// days; games are assigned to a day via the same todayKey convention
// (see gamesOnDay in lib/dailyQuests.ts).

import type { ArcadeGame } from "@/components/analyzer/arcade/types";
import {
  activeLossStreak,
  activeWinStreak,
  isGameTooShort,
  longestWinStreak,
  outcome,
} from "@/components/analyzer/arcade/ArcadeEngine";
import { gamesOnDay } from "@/lib/dailyQuests";
import { isBarcodeName } from "@/lib/sc2pulse";
import { isUnclassifiedBuild } from "@/lib/unclassifiedBuilds";

/* ──────────────── tuning constants ──────────────── */

/** Yesterday-recap needs this many games in yesterday's session. */
export const SESSION_MIN_GAMES = 2;

/** Streak cards light up from this run length. */
export const STREAK_MIN = 3;
/** Bounce-back rate needs this many post-loss samples to be honest. */
export const BOUNCE_BACK_MIN_SAMPLES = 20;

/** Peak-watch window and its minimum rated-game support. */
export const PEAK_WINDOW_DAYS = 90;
export const PEAK_MIN_RATED = 10;
/** Climb-recap window, minimum rated games inside it, and floor delta. */
export const CLIMB_WINDOW_DAYS = 7;
export const CLIMB_MIN_GAMES = 5;
export const CLIMB_MIN_DELTA = 20;

/** Rising-build recency window and support thresholds. */
export const RISING_BUILD_WINDOW_DAYS = 21;
export const RISING_BUILD_MIN_RECENT_DECIDED = 5;
export const RISING_BUILD_MIN_CAREER_DECIDED = 10;
export const RISING_BUILD_MIN_DELTA = 0.08;

/** Rusty-build: a proven build untouched for this long. */
export const RUSTY_BUILD_IDLE_DAYS = 14;
export const RUSTY_BUILD_MIN_DECIDED = 10;
export const RUSTY_BUILD_MIN_WINRATE = 0.55;

/** Nemesis: career record vs one player, recently active. */
export const NEMESIS_MIN_DECIDED = 4;
export const NEMESIS_MAX_WINRATE = 0.4;
export const NEMESIS_WINDOW_DAYS = 45;

/** Rival ledger: most-faced opponent inside the window. */
export const RIVAL_WINDOW_DAYS = 30;
export const RIVAL_MIN_DECIDED = 3;

/** Map edge: recent window + support + winrate floor. */
export const MAP_WINDOW_DAYS = 60;
export const MAP_EDGE_MIN_DECIDED = 6;
export const MAP_EDGE_MIN_WINRATE = 0.58;

/** Matchup shift: recent form vs career baseline per opponent race. */
export const MATCHUP_RECENT_DAYS = 14;
export const MATCHUP_MIN_RECENT_DECIDED = 6;
export const MATCHUP_MIN_CAREER_DECIDED = 15;
export const MATCHUP_MIN_DELTA = 0.07;

/** Milestone steps and "within reach" distances. */
export const MILESTONE_STEPS = [
  50, 100, 250, 500, 750, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 7500,
  10000,
] as const;
export const MILESTONE_GAMES_WITHIN = 25;
export const MILESTONE_WINS_WITHIN = 15;

/** Throwback lookbacks, farthest first — the oldest memory wins. */
export const THROWBACK_LOOKBACK_DAYS = [365, 180, 90, 30] as const;

/** Macro trend: recent scored window vs career, minimum support. */
export const MACRO_TREND_RECENT_WINDOW = 15;
export const MACRO_TREND_MIN_SCORED = 20;
export const MACRO_TREND_MIN_DELTA = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/* ──────────────── stat types ──────────────── */

export interface PulseSessionRecap {
  dateKey: string;
  games: number;
  wins: number;
  losses: number;
  /** Sum of per-account (last − first) MMR that day; null when unrated. */
  netMmr: number | null;
}

export interface PulseAccountMmr {
  toonHandle: string;
  /** "NA 12345"-style label matching the server's chart legend. */
  label: string;
  ratedGames: number;
  currentMmr: number;
  peakMmr: number;
  /** currentMmr − first rated MMR inside CLIMB_WINDOW_DAYS; null if <2 rows. */
  climbNet: number | null;
  climbGames: number;
}

export interface PulseBuildStat {
  name: string;
  careerDecided: number;
  careerWinRate: number;
  recentDecided: number;
  recentWinRate: number;
  /** ms timestamp of the most recent game on this build. */
  lastPlayedMs: number;
}

export interface PulseOpponentStat {
  pulseId: string;
  name: string;
  decided: number;
  wins: number;
  losses: number;
  /** ms timestamp of the most recent meeting. */
  lastPlayedMs: number;
  windowDecided: number;
}

export interface PulseMapStat {
  name: string;
  decided: number;
  winRate: number;
  inPool: boolean;
}

export interface PulseMatchupShift {
  race: "P" | "T" | "Z";
  careerDecided: number;
  careerWinRate: number;
  recentDecided: number;
  recentWinRate: number;
  delta: number;
}

export interface PulseMilestone {
  kind: "games" | "wins";
  target: number;
  current: number;
  remaining: number;
}

export interface PulseThrowback {
  lookbackDays: number;
  label: string;
  dateKey: string;
  games: number;
  wins: number;
  losses: number;
  /** Most notable game that day (highest-rated opponent, else longest). */
  notable: {
    opponentName: string | null;
    oppMmr: number | null;
    map: string | null;
    won: boolean;
  } | null;
}

/**
 * Derived personal stats computed once from the full corpus. Every
 * field is null / zero when the corpus can't support it — the matching
 * card then self-excludes from selection.
 */
export interface PulseContext {
  dateKey: string;
  tz: string;
  totalGames: number;
  careerWins: number;
  careerLosses: number;
  yesterday: PulseSessionRecap | null;
  winStreak: number;
  lossStreak: number;
  longestWinStreak: number;
  /** WR of the game immediately after a loss; null under sample floor. */
  bounceBackRate: number | null;
  bounceBackSamples: number;
  /** Most-played rated account inside PEAK_WINDOW_DAYS. */
  mainAccount: PulseAccountMmr | null;
  risingBuild: PulseBuildStat | null;
  rustyBuild: PulseBuildStat | null;
  nemesis: PulseOpponentStat | null;
  rival: PulseOpponentStat | null;
  bestMap: PulseMapStat | null;
  matchupShift: PulseMatchupShift | null;
  milestone: PulseMilestone | null;
  throwback: PulseThrowback | null;
  /** Recent-vs-career macro delta in score points; null under floor. */
  macroDelta: number | null;
  macroRecentAvg: number | null;
  macroCareerAvg: number | null;
}

/* ──────────────── small helpers ──────────────── */

function isFinite_(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function raceLetter(v: unknown): "P" | "T" | "Z" | null {
  const c = String(v ?? "").trim().charAt(0).toUpperCase();
  return c === "P" || c === "T" || c === "Z" ? c : null;
}

/** Leading toon-handle byte → Blizzard region (mirrors trendsRegionExpr). */
const REGION_BY_HEAD: Record<string, string> = {
  "1": "NA",
  "2": "EU",
  "3": "KR",
  "5": "CN",
  "6": "SEA",
};

/**
 * "NA 12345"-style short account label — the exact format the MMR
 * progression chart legend uses (see trendsInsights.shortAccountLabel)
 * so the pulse and the Trends tab describe accounts identically.
 */
export function shortAccountLabel(handle: string): string {
  const trimmed = String(handle || "").trim();
  if (!trimmed) return "Unknown";
  const segments = trimmed.split("-");
  const bnid =
    segments.length >= 4 ? segments[3] : segments[segments.length - 1];
  const region = REGION_BY_HEAD[trimmed.charAt(0)] || "??";
  return `${region} ${bnid}`;
}

export function decidedWinrate(wins: number, losses: number): number {
  const decided = wins + losses;
  return decided > 0 ? wins / decided : 0;
}

/**
 * Comparison key for live-pool names and replay-authored map names.
 * Liquipedia serves names such as "Fear and Faith", while replays commonly
 * append edition tags such as "LE". Roman numerals and the rest of the map
 * name remain significant, so Sanctuary II never aliases Sanctuary III.
 */
function currentMapPoolKey(value: unknown): string {
  const tokens = String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length >= 3 && tokens.slice(-2).join(" ") === "ladder edition") {
    tokens.splice(-2);
  } else if (
    tokens.length >= 2 &&
    ["le", "te", "ce", "re"].includes(tokens.at(-1)!)
  ) {
    tokens.pop();
  }
  return tokens.join("");
}

/** Shift a "YYYY-MM-DD" key by whole days (keys are tz-local already). */
export function shiftDateKey(dateKey: string, days: number): string {
  const anchor = Date.parse(`${dateKey}T00:00:00Z`);
  if (!Number.isFinite(anchor)) return dateKey;
  return new Date(anchor + days * DAY_MS).toISOString().slice(0, 10);
}

interface OrderedGame {
  g: ArcadeGame;
  t: number;
}

/* ──────────────── context builder ──────────────── */

export function buildPulseContext(
  games: ReadonlyArray<ArcadeGame>,
  dateKey: string,
  tz: string,
  mapPool: ReadonlyArray<string> = [],
): PulseContext {
  // Chronological ordering for windows/streaks. Rows with unparseable
  // dates keep counting toward career totals but can't join windows.
  const ordered: OrderedGame[] = games
    .map((g) => ({ g, t: Date.parse(g.date) }))
    .filter((r) => Number.isFinite(r.t))
    .sort((a, b) => a.t - b.t);
  const orderedGames = ordered.map((r) => r.g);

  // Windows anchor on dateKey — never Date.now() — so the same corpus
  // + day always builds the same context on every device.
  const anchor = Date.parse(`${dateKey}T00:00:00Z`);
  const cutoff = (days: number) =>
    Number.isFinite(anchor) ? anchor - days * DAY_MS : Number.NEGATIVE_INFINITY;

  /* career W-L */
  let careerWins = 0;
  let careerLosses = 0;
  for (const g of games) {
    const o = outcome(g);
    if (o === "W") careerWins += 1;
    else if (o === "L") careerLosses += 1;
  }

  return {
    dateKey,
    tz,
    totalGames: games.length,
    careerWins,
    careerLosses,
    yesterday: buildYesterday(games, dateKey, tz),
    winStreak: activeWinStreak(orderedGames),
    lossStreak: activeLossStreak(orderedGames),
    longestWinStreak: longestWinStreak(orderedGames),
    ...buildBounceBack(orderedGames),
    mainAccount: buildMainAccount(ordered, cutoff),
    ...buildBuildCards(ordered, cutoff),
    ...buildOpponentCards(ordered, cutoff),
    bestMap: buildBestMap(ordered, cutoff, mapPool),
    matchupShift: buildMatchupShift(ordered, cutoff),
    milestone: buildMilestone(games.length, careerWins),
    throwback: buildThrowback(games, dateKey, tz),
    ...buildMacroTrend(ordered),
  };
}

function buildYesterday(
  games: ReadonlyArray<ArcadeGame>,
  dateKey: string,
  tz: string,
): PulseSessionRecap | null {
  const yKey = shiftDateKey(dateKey, -1);
  if (yKey === dateKey) return null;
  const rows = gamesOnDay(games, yKey, tz);
  if (rows.length < SESSION_MIN_GAMES) return null;
  let wins = 0;
  let losses = 0;
  for (const g of rows) {
    const o = outcome(g);
    if (o === "W") wins += 1;
    else if (o === "L") losses += 1;
  }
  return { dateKey: yKey, games: rows.length, wins, losses, netMmr: netMmrOf(rows) };
}

/**
 * Net MMR across a chronologically-sorted slice: per-account
 * (last − first), summed over accounts with ≥2 rated rows. Mixing
 * accounts into a single first/last pair would fabricate deltas when a
 * player queues on two ladders in one evening.
 */
export function netMmrOf(rowsAsc: ReadonlyArray<ArcadeGame>): number | null {
  const byAccount = new Map<string, number[]>();
  for (const g of rowsAsc) {
    const handle = typeof g.myToonHandle === "string" ? g.myToonHandle.trim() : "";
    if (!handle || !isFinite_(g.myMmr)) continue;
    const series = byAccount.get(handle) ?? [];
    series.push(g.myMmr);
    byAccount.set(handle, series);
  }
  let net: number | null = null;
  for (const series of byAccount.values()) {
    if (series.length < 2) continue;
    net = (net ?? 0) + (series[series.length - 1] - series[0]);
  }
  return net;
}

function buildBounceBack(
  orderedGames: ReadonlyArray<ArcadeGame>,
): { bounceBackRate: number | null; bounceBackSamples: number } {
  let samples = 0;
  let wins = 0;
  let prev: "W" | "L" | null = null;
  for (const g of orderedGames) {
    const o = outcome(g);
    if (o === "U") continue;
    if (prev === "L") {
      samples += 1;
      if (o === "W") wins += 1;
    }
    prev = o;
  }
  return {
    bounceBackRate: samples >= BOUNCE_BACK_MIN_SAMPLES ? wins / samples : null,
    bounceBackSamples: samples,
  };
}

function buildMainAccount(
  ordered: ReadonlyArray<OrderedGame>,
  cutoff: (days: number) => number,
): PulseAccountMmr | null {
  const peakCutoff = cutoff(PEAK_WINDOW_DAYS);
  const climbCutoff = cutoff(CLIMB_WINDOW_DAYS);
  const byAccount = new Map<
    string,
    { mmrs: number[]; climb: number[] }
  >();
  for (const r of ordered) {
    if (r.t < peakCutoff) continue;
    const handle =
      typeof r.g.myToonHandle === "string" ? r.g.myToonHandle.trim() : "";
    if (!handle || !isFinite_(r.g.myMmr)) continue;
    let rec = byAccount.get(handle);
    if (!rec) {
      rec = { mmrs: [], climb: [] };
      byAccount.set(handle, rec);
    }
    rec.mmrs.push(r.g.myMmr);
    if (r.t >= climbCutoff) rec.climb.push(r.g.myMmr);
  }
  let main: PulseAccountMmr | null = null;
  // Deterministic winner: most rated games, handle as tie-break.
  for (const [handle, rec] of [...byAccount.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    if (rec.mmrs.length < PEAK_MIN_RATED) continue;
    if (main && rec.mmrs.length <= main.ratedGames) continue;
    main = {
      toonHandle: handle,
      label: shortAccountLabel(handle),
      ratedGames: rec.mmrs.length,
      currentMmr: rec.mmrs[rec.mmrs.length - 1],
      peakMmr: Math.max(...rec.mmrs),
      climbNet:
        rec.climb.length >= 2
          ? rec.climb[rec.climb.length - 1] - rec.climb[0]
          : null,
      climbGames: rec.climb.length,
    };
  }
  return main;
}

function buildBuildCards(
  ordered: ReadonlyArray<OrderedGame>,
  cutoff: (days: number) => number,
): { risingBuild: PulseBuildStat | null; rustyBuild: PulseBuildStat | null } {
  const recentCutoff = cutoff(RISING_BUILD_WINDOW_DAYS);
  const rustyCutoff = cutoff(RUSTY_BUILD_IDLE_DAYS);
  const byBuild = new Map<
    string,
    {
      name: string;
      wins: number;
      losses: number;
      recentWins: number;
      recentLosses: number;
      lastPlayedMs: number;
    }
  >();
  for (const r of ordered) {
    const name = typeof r.g.myBuild === "string" ? r.g.myBuild.trim() : "";
    // Detector catch-alls ("Unclassified - Protoss", "PvP - Macro
    // Transition (Unclassified)") are not builds the player can choose
    // to queue with — they must never be crowned rising or rusty.
    if (!name || isGameTooShort(name) || isUnclassifiedBuild(name)) continue;
    const o = outcome(r.g);
    if (o === "U") continue;
    let rec = byBuild.get(name.toLowerCase());
    if (!rec) {
      rec = {
        name,
        wins: 0,
        losses: 0,
        recentWins: 0,
        recentLosses: 0,
        lastPlayedMs: 0,
      };
      byBuild.set(name.toLowerCase(), rec);
    }
    if (o === "W") rec.wins += 1;
    else rec.losses += 1;
    if (r.t >= recentCutoff) {
      if (o === "W") rec.recentWins += 1;
      else rec.recentLosses += 1;
    }
    if (r.t > rec.lastPlayedMs) rec.lastPlayedMs = r.t;
  }

  const stats: PulseBuildStat[] = [...byBuild.values()]
    .map((b) => ({
      name: b.name,
      careerDecided: b.wins + b.losses,
      careerWinRate: decidedWinrate(b.wins, b.losses),
      recentDecided: b.recentWins + b.recentLosses,
      recentWinRate: decidedWinrate(b.recentWins, b.recentLosses),
      lastPlayedMs: b.lastPlayedMs,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  let risingBuild: PulseBuildStat | null = null;
  for (const s of stats) {
    if (s.recentDecided < RISING_BUILD_MIN_RECENT_DECIDED) continue;
    if (s.careerDecided < RISING_BUILD_MIN_CAREER_DECIDED) continue;
    const delta = s.recentWinRate - s.careerWinRate;
    if (delta < RISING_BUILD_MIN_DELTA) continue;
    if (
      !risingBuild ||
      delta > risingBuild.recentWinRate - risingBuild.careerWinRate
    ) {
      risingBuild = s;
    }
  }

  let rustyBuild: PulseBuildStat | null = null;
  for (const s of stats) {
    if (s.careerDecided < RUSTY_BUILD_MIN_DECIDED) continue;
    if (s.careerWinRate < RUSTY_BUILD_MIN_WINRATE) continue;
    if (s.lastPlayedMs >= rustyCutoff) continue;
    if (
      !rustyBuild ||
      s.careerWinRate > rustyBuild.careerWinRate ||
      (s.careerWinRate === rustyBuild.careerWinRate &&
        s.careerDecided > rustyBuild.careerDecided)
    ) {
      rustyBuild = s;
    }
  }

  return { risingBuild, rustyBuild };
}

function buildOpponentCards(
  ordered: ReadonlyArray<OrderedGame>,
  cutoff: (days: number) => number,
): { nemesis: PulseOpponentStat | null; rival: PulseOpponentStat | null } {
  const nemesisCutoff = cutoff(NEMESIS_WINDOW_DAYS);
  const rivalCutoff = cutoff(RIVAL_WINDOW_DAYS);
  const byOpp = new Map<
    string,
    {
      name: string | null;
      wins: number;
      losses: number;
      lastPlayedMs: number;
      rivalDecided: number;
      hasPulseCharacterId: boolean;
    }
  >();
  for (const r of ordered) {
    const id =
      typeof r.g.oppPulseId === "string" ? r.g.oppPulseId.trim() : "";
    if (!id) continue;
    const o = outcome(r.g);
    if (o === "U") continue;
    let rec = byOpp.get(id);
    if (!rec) {
      rec = {
        name: null,
        wins: 0,
        losses: 0,
        lastPlayedMs: 0,
        rivalDecided: 0,
        hasPulseCharacterId: false,
      };
      byOpp.set(id, rec);
    }
    if (o === "W") rec.wins += 1;
    else rec.losses += 1;
    if (r.t >= rivalCutoff) rec.rivalDecided += 1;
    const cid = r.g.opponent?.pulseCharacterId;
    if (typeof cid === "string" && cid.trim()) rec.hasPulseCharacterId = true;
    if (r.t >= rec.lastPlayedMs) {
      rec.lastPlayedMs = r.t;
      // Latest known display name wins — smurf barcodes get healed by
      // whatever the most recent replay recorded.
      const dn = r.g.opponent?.displayName;
      if (typeof dn === "string" && dn.trim()) rec.name = dn.trim();
    }
  }

  let nemesis: PulseOpponentStat | null = null;
  let rival: PulseOpponentStat | null = null;
  for (const [pulseId, rec] of [...byOpp.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    if (!rec.name) continue; // never show an unnamed card
    // Barcode names only headline a card when a resolved SC2Pulse
    // character id confirms who is behind the bars. Without it the
    // card reads "IIIIIl owns the ledger" with no dossier to back it
    // up — an unverifiable identity isn't worth a nemesis/rival slot.
    if (isBarcodeName(rec.name) && !rec.hasPulseCharacterId) continue;
    const decided = rec.wins + rec.losses;
    const stat: PulseOpponentStat = {
      pulseId,
      name: rec.name,
      decided,
      wins: rec.wins,
      losses: rec.losses,
      lastPlayedMs: rec.lastPlayedMs,
      windowDecided: rec.rivalDecided,
    };
    if (
      decided >= NEMESIS_MIN_DECIDED &&
      decidedWinrate(rec.wins, rec.losses) <= NEMESIS_MAX_WINRATE &&
      rec.lastPlayedMs >= nemesisCutoff
    ) {
      if (
        !nemesis ||
        decidedWinrate(stat.wins, stat.losses) <
          decidedWinrate(nemesis.wins, nemesis.losses) ||
        (decidedWinrate(stat.wins, stat.losses) ===
          decidedWinrate(nemesis.wins, nemesis.losses) &&
          decided > nemesis.decided)
      ) {
        nemesis = stat;
      }
    }
    if (rec.rivalDecided >= RIVAL_MIN_DECIDED) {
      if (!rival || stat.windowDecided > rival.windowDecided) rival = stat;
    }
  }

  // Don't serve the same player as both nemesis and rival in one pool —
  // the nemesis framing is stronger, so the rival card yields.
  if (nemesis && rival && nemesis.pulseId === rival.pulseId) rival = null;

  return { nemesis, rival };
}

function buildBestMap(
  ordered: ReadonlyArray<OrderedGame>,
  cutoff: (days: number) => number,
  mapPool: ReadonlyArray<string>,
): PulseMapStat | null {
  const mapCutoff = cutoff(MAP_WINDOW_DAYS);
  const poolKeys = new Set(
    mapPool.map(currentMapPoolKey).filter((key) => key.length > 0),
  );
  // Queue advice must be actionable. If the current pool is unavailable,
  // fail closed instead of crowning a retired map from recent history.
  if (poolKeys.size === 0) return null;

  const byMap = new Map<string, { name: string; wins: number; losses: number }>();
  for (const r of ordered) {
    if (r.t < mapCutoff) continue;
    const name = typeof r.g.map === "string" ? r.g.map.trim() : "";
    if (!name) continue;
    const mapKey = currentMapPoolKey(name);
    if (!mapKey || !poolKeys.has(mapKey)) continue;
    const o = outcome(r.g);
    if (o === "U") continue;
    let rec = byMap.get(mapKey);
    if (!rec) {
      rec = { name, wins: 0, losses: 0 };
      byMap.set(mapKey, rec);
    }
    if (o === "W") rec.wins += 1;
    else rec.losses += 1;
  }
  let best: PulseMapStat | null = null;
  for (const rec of [...byMap.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const decided = rec.wins + rec.losses;
    if (decided < MAP_EDGE_MIN_DECIDED) continue;
    const winRate = decidedWinrate(rec.wins, rec.losses);
    if (winRate < MAP_EDGE_MIN_WINRATE) continue;
    const candidate: PulseMapStat = {
      name: rec.name,
      decided,
      winRate,
      inPool: true,
    };
    // Every candidate is in the live pool; choose the strongest supported
    // edge, then the one backed by more games.
    if (
      !best ||
      candidate.winRate > best.winRate ||
      (candidate.winRate === best.winRate && candidate.decided > best.decided)
    ) {
      best = candidate;
    }
  }
  return best;
}

function buildMatchupShift(
  ordered: ReadonlyArray<OrderedGame>,
  cutoff: (days: number) => number,
): PulseMatchupShift | null {
  const recentCutoff = cutoff(MATCHUP_RECENT_DAYS);
  const byRace = new Map<
    "P" | "T" | "Z",
    { wins: number; losses: number; recentWins: number; recentLosses: number }
  >();
  for (const r of ordered) {
    const race = raceLetter(r.g.oppRace);
    if (!race) continue;
    const o = outcome(r.g);
    if (o === "U") continue;
    let rec = byRace.get(race);
    if (!rec) {
      rec = { wins: 0, losses: 0, recentWins: 0, recentLosses: 0 };
      byRace.set(race, rec);
    }
    if (o === "W") rec.wins += 1;
    else rec.losses += 1;
    if (r.t >= recentCutoff) {
      if (o === "W") rec.recentWins += 1;
      else rec.recentLosses += 1;
    }
  }
  let shift: PulseMatchupShift | null = null;
  for (const race of ["P", "T", "Z"] as const) {
    const rec = byRace.get(race);
    if (!rec) continue;
    const careerDecided = rec.wins + rec.losses;
    const recentDecided = rec.recentWins + rec.recentLosses;
    if (careerDecided < MATCHUP_MIN_CAREER_DECIDED) continue;
    if (recentDecided < MATCHUP_MIN_RECENT_DECIDED) continue;
    const careerWinRate = decidedWinrate(rec.wins, rec.losses);
    const recentWinRate = decidedWinrate(rec.recentWins, rec.recentLosses);
    const delta = recentWinRate - careerWinRate;
    if (Math.abs(delta) < MATCHUP_MIN_DELTA) continue;
    if (!shift || Math.abs(delta) > Math.abs(shift.delta)) {
      shift = { race, careerDecided, careerWinRate, recentDecided, recentWinRate, delta };
    }
  }
  return shift;
}

function nearestMilestone(
  kind: "games" | "wins",
  current: number,
  within: number,
): PulseMilestone | null {
  // Steps ascend — the first unreached one is the nearest.
  for (const step of MILESTONE_STEPS) {
    if (current < step) {
      return step - current <= within
        ? { kind, target: step, current, remaining: step - current }
        : null;
    }
  }
  return null;
}

function buildMilestone(
  totalGames: number,
  careerWins: number,
): PulseMilestone | null {
  const candidates = [
    nearestMilestone("games", totalGames, MILESTONE_GAMES_WITHIN),
    nearestMilestone("wins", careerWins, MILESTONE_WINS_WITHIN),
  ].filter((m): m is PulseMilestone => m !== null);
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (b.remaining < a.remaining ? b : a));
}

const THROWBACK_LABEL: Record<number, string> = {
  365: "One year ago today",
  180: "Six months ago today",
  90: "Three months ago today",
  30: "One month ago today",
};

function buildThrowback(
  games: ReadonlyArray<ArcadeGame>,
  dateKey: string,
  tz: string,
): PulseThrowback | null {
  for (const lookback of THROWBACK_LOOKBACK_DAYS) {
    const key = shiftDateKey(dateKey, -lookback);
    if (key === dateKey) continue;
    const rows = gamesOnDay(games, key, tz);
    if (rows.length === 0) continue;
    let wins = 0;
    let losses = 0;
    for (const g of rows) {
      const o = outcome(g);
      if (o === "W") wins += 1;
      else if (o === "L") losses += 1;
    }
    // Most notable: highest-rated opponent; longest game as fallback.
    let notable: ArcadeGame | null = null;
    let notableScore = Number.NEGATIVE_INFINITY;
    for (const g of rows) {
      const opp = isFinite_(g.oppMmr)
        ? g.oppMmr
        : isFinite_(g.opponent?.mmr)
          ? (g.opponent!.mmr as number)
          : null;
      const score =
        opp !== null ? 1_000_000 + opp : isFinite_(g.duration) ? g.duration : 0;
      if (score > notableScore) {
        notableScore = score;
        notable = g;
      }
    }
    return {
      lookbackDays: lookback,
      label: THROWBACK_LABEL[lookback] ?? `${lookback} days ago`,
      dateKey: key,
      games: rows.length,
      wins,
      losses,
      notable: notable
        ? {
            opponentName: notable.opponent?.displayName?.trim() || null,
            oppMmr: isFinite_(notable.oppMmr)
              ? notable.oppMmr
              : isFinite_(notable.opponent?.mmr)
                ? (notable.opponent!.mmr as number)
                : null,
            map: typeof notable.map === "string" ? notable.map.trim() || null : null,
            won: outcome(notable) === "W",
          }
        : null,
    };
  }
  return null;
}

function buildMacroTrend(ordered: ReadonlyArray<OrderedGame>): {
  macroDelta: number | null;
  macroRecentAvg: number | null;
  macroCareerAvg: number | null;
} {
  const scored = ordered.filter((r) => isFinite_(r.g.macro_score));
  if (scored.length < MACRO_TREND_MIN_SCORED) {
    return { macroDelta: null, macroRecentAvg: null, macroCareerAvg: null };
  }
  const careerAvg =
    scored.reduce((s, r) => s + (r.g.macro_score as number), 0) / scored.length;
  const recent = scored.slice(-MACRO_TREND_RECENT_WINDOW);
  const recentAvg =
    recent.reduce((s, r) => s + (r.g.macro_score as number), 0) / recent.length;
  const delta = recentAvg - careerAvg;
  return {
    macroDelta: Math.abs(delta) >= MACRO_TREND_MIN_DELTA ? delta : null,
    macroRecentAvg: recentAvg,
    macroCareerAvg: careerAvg,
  };
}
