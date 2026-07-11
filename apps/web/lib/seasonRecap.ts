// Season Recap — pure client-side aggregation over the user's games.
//
// computeSeasonRecap() folds the analyzer's slim game rows (the same
// ArcadeGame shape every Arcade mode consumes — see
// components/analyzer/arcade/types.ts) into a typed "Wrapped"-style
// summary: totals, MMR journey, signature opener, nemesis / best
// victim, longest win streak, biggest upset, favorite map, and
// matchup splits.
//
// Every stat is optional/null-safe by design: rows in the corpus
// routinely miss myMmr, duration, opponent identity, or map (older
// agent versions, partial ingests), and the recap must degrade to
// whatever survives rather than throw or synthesise. Consumers skip
// null sections instead of rendering placeholders.
//
// No I/O and no React here — everything is deterministic over the
// input array so the vitest fixtures fully specify behavior.

import type { ArcadeGame } from "@/components/analyzer/arcade/types";
import {
  isGameTooShort,
  longestWinStreak,
  outcome,
} from "@/components/analyzer/arcade/ArcadeEngine";
import { currentSeason, seasonRange } from "./seasonCatalog";

/** Recap unlocks at this many games inside the chosen window. */
export const MIN_RECAP_GAMES = 10;

/** A rival needs at least this many losses (nemesis) / wins (victim). */
export const NEMESIS_MIN_LOSSES = 2;
export const VICTIM_MIN_WINS = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

/* ──────────────── types ──────────────── */

export interface SeasonRecapTotals {
  /** Games inside the window (including undecided results). */
  games: number;
  wins: number;
  losses: number;
  /** wins / (wins + losses); null when no decided games. */
  winrate: number | null;
  /** Total in-game time in hours; null when no row carried a duration. */
  hoursPlayed: number | null;
}

export interface RecapMmrJourney {
  start: number;
  end: number;
  peak: number;
  /** end - start (positive = climbed). */
  delta: number;
}

export interface RecapOpener {
  name: string;
  games: number;
  wins: number;
  /** Over decided games with this opener; 0 when none decided. */
  winrate: number;
}

export interface RecapOpponent {
  name: string;
  pulseId: string | null;
  /** The USER's wins vs this opponent. */
  wins: number;
  /** The USER's losses vs this opponent. */
  losses: number;
  /** User-perspective head-to-head, e.g. "2-7". */
  record: string;
}

export interface RecapUpset {
  opponentName: string | null;
  myMmr: number;
  opponentMmr: number;
  /** opponentMmr - myMmr; always > 0 (it's only an upset if they were above you). */
  mmrGap: number;
  map: string | null;
  date: string;
}

export interface RecapMap {
  name: string;
  games: number;
  wins: number;
  /** Over decided games on this map; 0 when none decided. */
  winrate: number;
}

export interface RecapMatchupSplit {
  /** "vs P" | "vs T" | "vs Z" — same labels the /v1/matchups facet uses. */
  matchup: string;
  oppRace: "P" | "T" | "Z";
  games: number;
  wins: number;
  losses: number;
  winrate: number;
}

export interface SeasonRecapResult {
  totals: SeasonRecapTotals;
  mmrJourney: RecapMmrJourney | null;
  topOpener: RecapOpener | null;
  nemesis: RecapOpponent | null;
  bestVictim: RecapOpponent | null;
  longestWinStreak: number;
  biggestUpset: RecapUpset | null;
  favoriteMap: RecapMap | null;
  /** Sorted by games desc; only P/T/Z opponents contribute. */
  matchupSplits: RecapMatchupSplit[];
}

/* ──────────────── window selection ──────────────── */

export interface RecapWindow {
  since: Date;
  /** Human label, e.g. "Season 67" or "Last 90 days". */
  label: string;
  kind: "season" | "days90";
}

/**
 * Default recap window: the in-progress ladder season (via the shared
 * client-side season catalog). When the current season doesn't hold
 * enough games yet (fresh season, thin ladder activity), fall back to
 * a rolling 90-day window so early-season users still get a recap.
 */
export function resolveRecapWindow(
  games: ReadonlyArray<Pick<ArcadeGame, "date">>,
  now: Date = new Date(),
): RecapWindow {
  const season = currentSeason();
  const { start } = seasonRange(season);
  let inSeason = 0;
  for (const g of games) {
    const t = Date.parse(g.date);
    if (Number.isFinite(t) && t >= start.getTime() && t <= now.getTime()) {
      inSeason += 1;
      if (inSeason >= MIN_RECAP_GAMES) break;
    }
  }
  if (inSeason >= MIN_RECAP_GAMES) {
    return { since: start, label: `Season ${season}`, kind: "season" };
  }
  return {
    since: new Date(now.getTime() - 90 * DAY_MS),
    label: "Last 90 days",
    kind: "days90",
  };
}

/* ──────────────── computation ──────────────── */

export function computeSeasonRecap(
  games: ReadonlyArray<ArcadeGame>,
  opts: { since: Date; until?: Date },
): SeasonRecapResult {
  const sinceT = opts.since.getTime();
  const untilT = opts.until ? opts.until.getTime() : Number.POSITIVE_INFINITY;

  // Window filter + chronological sort. Rows with unparseable dates
  // can't be placed in the window (or the streak/MMR timelines), so
  // they're dropped entirely.
  const rows = games
    .map((g) => ({ g, t: Date.parse(g.date) }))
    .filter((r) => Number.isFinite(r.t) && r.t >= sinceT && r.t <= untilT)
    .sort((a, b) => a.t - b.t)
    .map((r) => r.g);

  return {
    totals: computeTotals(rows),
    mmrJourney: computeMmrJourney(rows),
    topOpener: computeTopOpener(rows),
    ...computeRivals(rows),
    longestWinStreak: longestWinStreak(rows),
    biggestUpset: computeBiggestUpset(rows),
    favoriteMap: computeFavoriteMap(rows),
    matchupSplits: computeMatchupSplits(rows),
  };
}

/* ──────────────── per-stat helpers ──────────────── */

function decidedWinrate(wins: number, losses: number): number {
  const decided = wins + losses;
  return decided > 0 ? wins / decided : 0;
}

function computeTotals(rows: ArcadeGame[]): SeasonRecapTotals {
  let wins = 0;
  let losses = 0;
  let seconds = 0;
  let hasDuration = false;
  for (const g of rows) {
    const o = outcome(g);
    if (o === "W") wins += 1;
    else if (o === "L") losses += 1;
    if (typeof g.duration === "number" && Number.isFinite(g.duration) && g.duration > 0) {
      seconds += g.duration;
      hasDuration = true;
    }
  }
  const decided = wins + losses;
  return {
    games: rows.length,
    wins,
    losses,
    winrate: decided > 0 ? wins / decided : null,
    hoursPlayed: hasDuration ? seconds / 3600 : null,
  };
}

function computeMmrJourney(rows: ArcadeGame[]): RecapMmrJourney | null {
  const series: number[] = [];
  for (const g of rows) {
    if (typeof g.myMmr === "number" && Number.isFinite(g.myMmr)) {
      series.push(g.myMmr);
    }
  }
  // A single data point isn't a journey — require two so start/end/
  // delta all mean something.
  if (series.length < 2) return null;
  const start = series[0];
  const end = series[series.length - 1];
  return { start, end, peak: Math.max(...series), delta: end - start };
}

function computeTopOpener(rows: ArcadeGame[]): RecapOpener | null {
  const byName = new Map<string, { name: string; games: number; wins: number; losses: number }>();
  for (const g of rows) {
    const name = typeof g.myBuild === "string" ? g.myBuild.trim() : "";
    // "<Matchup> - Game Too Short" is a filtering artifact, not a real
    // opener — same exclusion every arcade mode applies.
    if (!name || isGameTooShort(name)) continue;
    let rec = byName.get(name.toLowerCase());
    if (!rec) {
      rec = { name, games: 0, wins: 0, losses: 0 };
      byName.set(name.toLowerCase(), rec);
    }
    rec.games += 1;
    const o = outcome(g);
    if (o === "W") rec.wins += 1;
    else if (o === "L") rec.losses += 1;
  }
  const best = [...byName.values()].sort(
    (a, b) =>
      b.games - a.games ||
      decidedWinrate(b.wins, b.losses) - decidedWinrate(a.wins, a.losses) ||
      a.name.localeCompare(b.name),
  )[0];
  if (!best) return null;
  return {
    name: best.name,
    games: best.games,
    wins: best.wins,
    winrate: decidedWinrate(best.wins, best.losses),
  };
}

interface OppAgg {
  name: string;
  pulseId: string | null;
  wins: number;
  losses: number;
  games: number;
}

function computeRivals(rows: ArcadeGame[]): {
  nemesis: RecapOpponent | null;
  bestVictim: RecapOpponent | null;
} {
  const byKey = new Map<string, OppAgg>();
  for (const g of rows) {
    const rawName =
      typeof g.opponent?.displayName === "string" ? g.opponent.displayName.trim() : "";
    const name = rawName || null;
    const pulseId = typeof g.oppPulseId === "string" && g.oppPulseId ? g.oppPulseId : null;
    // Identity: prefer the stable pulseId, fall back to the display
    // name. Rows with neither can't be attributed to a rival.
    const key = pulseId ?? (name ? `name:${name.toLowerCase()}` : null);
    if (!key) continue;
    let rec = byKey.get(key);
    if (!rec) {
      rec = { name: name ?? "Unknown", pulseId, wins: 0, losses: 0, games: 0 };
      byKey.set(key, rec);
    }
    if (rec.name === "Unknown" && name) rec.name = name;
    rec.games += 1;
    const o = outcome(g);
    if (o === "W") rec.wins += 1;
    else if (o === "L") rec.losses += 1;
  }
  const all = [...byKey.values()];

  const nem = all
    .filter((o) => o.losses >= NEMESIS_MIN_LOSSES)
    .sort(
      (a, b) =>
        b.losses - a.losses ||
        a.wins - b.wins ||
        b.games - a.games ||
        a.name.localeCompare(b.name),
    )[0];

  const vic = all
    .filter((o) => o.wins >= VICTIM_MIN_WINS)
    .sort(
      (a, b) =>
        b.wins - a.wins ||
        a.losses - b.losses ||
        b.games - a.games ||
        a.name.localeCompare(b.name),
    )[0];

  return {
    nemesis: nem ? toRecapOpponent(nem) : null,
    bestVictim: vic ? toRecapOpponent(vic) : null,
  };
}

function toRecapOpponent(o: OppAgg): RecapOpponent {
  return {
    name: o.name,
    pulseId: o.pulseId,
    wins: o.wins,
    losses: o.losses,
    record: `${o.wins}-${o.losses}`,
  };
}

function computeBiggestUpset(rows: ArcadeGame[]): RecapUpset | null {
  let best: RecapUpset | null = null;
  for (const g of rows) {
    if (outcome(g) !== "W") continue;
    const my = typeof g.myMmr === "number" && Number.isFinite(g.myMmr) ? g.myMmr : null;
    const oppRaw = typeof g.oppMmr === "number" ? g.oppMmr : g.opponent?.mmr;
    const opp = typeof oppRaw === "number" && Number.isFinite(oppRaw) ? oppRaw : null;
    if (my === null || opp === null) continue;
    const gap = opp - my;
    // Beating someone at/below your own MMR isn't an upset.
    if (gap <= 0) continue;
    if (!best || gap > best.mmrGap) {
      const rawName =
        typeof g.opponent?.displayName === "string" ? g.opponent.displayName.trim() : "";
      best = {
        opponentName: rawName || null,
        myMmr: my,
        opponentMmr: opp,
        mmrGap: gap,
        map: typeof g.map === "string" && g.map.trim() ? g.map.trim() : null,
        date: g.date,
      };
    }
  }
  return best;
}

function computeFavoriteMap(rows: ArcadeGame[]): RecapMap | null {
  const byMap = new Map<string, { name: string; games: number; wins: number; losses: number }>();
  for (const g of rows) {
    const name = typeof g.map === "string" ? g.map.trim() : "";
    if (!name) continue;
    let rec = byMap.get(name.toLowerCase());
    if (!rec) {
      rec = { name, games: 0, wins: 0, losses: 0 };
      byMap.set(name.toLowerCase(), rec);
    }
    rec.games += 1;
    const o = outcome(g);
    if (o === "W") rec.wins += 1;
    else if (o === "L") rec.losses += 1;
  }
  const best = [...byMap.values()].sort(
    (a, b) =>
      b.games - a.games ||
      decidedWinrate(b.wins, b.losses) - decidedWinrate(a.wins, a.losses) ||
      a.name.localeCompare(b.name),
  )[0];
  if (!best) return null;
  return {
    name: best.name,
    games: best.games,
    wins: best.wins,
    winrate: decidedWinrate(best.wins, best.losses),
  };
}

const RACE_ORDER: Array<"P" | "T" | "Z"> = ["P", "T", "Z"];

function computeMatchupSplits(rows: ArcadeGame[]): RecapMatchupSplit[] {
  const agg = new Map<"P" | "T" | "Z", { games: number; wins: number; losses: number }>();
  for (const g of rows) {
    const letter = String(g.oppRace || "").trim().charAt(0).toUpperCase();
    if (letter !== "P" && letter !== "T" && letter !== "Z") continue;
    const race = letter as "P" | "T" | "Z";
    let rec = agg.get(race);
    if (!rec) {
      rec = { games: 0, wins: 0, losses: 0 };
      agg.set(race, rec);
    }
    rec.games += 1;
    const o = outcome(g);
    if (o === "W") rec.wins += 1;
    else if (o === "L") rec.losses += 1;
  }
  return RACE_ORDER.filter((r) => agg.has(r))
    .map((race) => {
      const rec = agg.get(race)!;
      return {
        matchup: `vs ${race}`,
        oppRace: race,
        games: rec.games,
        wins: rec.wins,
        losses: rec.losses,
        winrate: decidedWinrate(rec.wins, rec.losses),
      };
    })
    .sort((a, b) => b.games - a.games || a.oppRace.localeCompare(b.oppRace));
}
