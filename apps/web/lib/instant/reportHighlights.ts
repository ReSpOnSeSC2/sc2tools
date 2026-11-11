/**
 * The /try report sections built from data the report already holds:
 * the season-recap highlights, the record by map and the record by game
 * length. Pure, like the rest of the report; every value comes from the
 * visitor's own replays and is null when the data does not support it.
 *
 * Example:
 *   computeRecordByLength(games)?.buckets[0]; // -> { key: "short", label: "Under 8 min", games: 4, … }
 */
import { outcome } from "@/components/analyzer/arcade/ArcadeEngine";
import type { RecapMap, RecapOpponent, RecapUpset, SeasonRecapResult } from "@/lib/seasonRecap";
import type { InstantPayload } from "./reportPayload";

/** A streak is only a highlight from two wins in a row. */
export const HIGHLIGHT_MIN_STREAK = 2;
/** A "favorite" map needs a few games; one game on a map is not a favorite. */
export const HIGHLIGHT_MIN_MAP_GAMES = 3;
/** Label for games whose replay named no map (always the last row). */
export const UNKNOWN_MAP_LABEL = "Unknown map";

export interface ReportHighlights {
  /** Most wins in a row; null below HIGHLIGHT_MIN_STREAK. */
  longestWinStreak: number | null;
  biggestUpset: RecapUpset | null;
  favoriteMap: RecapMap | null;
  /** The recap's own minimums apply (2 losses / 2 wins against one opponent). */
  nemesis: RecapOpponent | null;
  bestVictim: RecapOpponent | null;
}

export interface MapRecordRow {
  map: string;
  /** False for the "Unknown map" bucket. */
  known: boolean;
  games: number;
  wins: number;
  losses: number;
  /** Over decided games; null when none was decided. */
  winrate: number | null;
}

export type LengthBucketKey = "short" | "mid" | "long";

export interface LengthBucketRow {
  key: LengthBucketKey;
  label: string;
  games: number;
  wins: number;
  losses: number;
  winrate: number | null;
}

export interface LengthRecord {
  /** Buckets with at least one game, shortest first. */
  buckets: LengthBucketRow[];
  /** Games without a usable length (left out of the buckets). */
  missing: number;
}

/** Under 8 min, 8–15 min, 15+ min (boundaries in seconds; a bucket includes its lower bound). */
export const LENGTH_BUCKETS: ReadonlyArray<{ key: LengthBucketKey; label: string; minSec: number }> = [
  { key: "short", label: "Under 8 min", minSec: 0 },
  { key: "mid", label: "8–15 min", minSec: 480 },
  { key: "long", label: "15+ min", minSec: 900 },
];

type Tally = { games: number; wins: number; losses: number };

function tally(target: Tally, result: string): void {
  target.games += 1;
  const o = outcome({ result });
  if (o === "W") target.wins += 1;
  else if (o === "L") target.losses += 1;
}

function decidedWinrate(row: Tally): number | null {
  const decided = row.wins + row.losses;
  return decided > 0 ? row.wins / decided : null;
}

/**
 * The recap highlights with their sample floors.
 *
 * Example:
 *   highlightsFromRecap({ ...recap, longestWinStreak: 1 }).longestWinStreak; // -> null
 */
export function highlightsFromRecap(
  recap: Pick<SeasonRecapResult, "longestWinStreak" | "biggestUpset" | "favoriteMap" | "nemesis" | "bestVictim">,
): ReportHighlights {
  return {
    longestWinStreak: recap.longestWinStreak >= HIGHLIGHT_MIN_STREAK ? recap.longestWinStreak : null,
    biggestUpset: recap.biggestUpset,
    favoriteMap: recap.favoriteMap && recap.favoriteMap.games >= HIGHLIGHT_MIN_MAP_GAMES ? recap.favoriteMap : null,
    nemesis: recap.nemesis,
    bestVictim: recap.bestVictim,
  };
}

/** True when no highlight tile has a value. */
export function hasHighlights(highlights: ReportHighlights | null | undefined): boolean {
  return !!highlights && Object.values(highlights).some((value) => value !== null);
}

/**
 * W-L per map, most played first (ties by name). Games without a map are
 * grouped as "Unknown map", always last. Names match case-insensitively.
 *
 * Example:
 *   computeRecordByMap([bare({ map: "Alcyone LE" }), bare()]).map((row) => row.map); // -> ["Alcyone LE", "Unknown map"]
 */
export function computeRecordByMap(games: ReadonlyArray<InstantPayload>): MapRecordRow[] | null {
  const byMap = new Map<string, Tally & { map: string }>();
  const unknown: Tally = { games: 0, wins: 0, losses: 0 };
  for (const game of games) {
    const name = typeof game.map === "string" ? game.map.trim() : "";
    if (!name) {
      tally(unknown, game.result);
      continue;
    }
    const key = name.toLowerCase();
    const row = byMap.get(key) ?? { map: name, games: 0, wins: 0, losses: 0 };
    byMap.set(key, row);
    tally(row, game.result);
  }
  const rows: MapRecordRow[] = [...byMap.values()]
    .sort((a, b) => b.games - a.games || a.map.localeCompare(b.map))
    .map((row) => ({ ...row, known: true, winrate: decidedWinrate(row) }));
  if (unknown.games > 0) rows.push({ map: UNKNOWN_MAP_LABEL, known: false, ...unknown, winrate: decidedWinrate(unknown) });
  return rows.length > 0 ? rows : null;
}

function lengthBucket(durationSec: number): LengthBucketKey {
  let key: LengthBucketKey = "short";
  for (const bucket of LENGTH_BUCKETS) if (durationSec >= bucket.minSec) key = bucket.key;
  return key;
}

/**
 * W-L by game length: under 8 min (< 480 s), 8–15 min (480–899 s) and
 * 15+ min (≥ 900 s). Games without a length are counted in `missing`.
 * Null when there are no games.
 *
 * Example:
 *   computeRecordByLength([bare({ durationSec: 479 }), bare({ durationSec: 480 })])?.buckets.map((row) => row.key); // -> ["short", "mid"]
 */
export function computeRecordByLength(games: ReadonlyArray<InstantPayload>): LengthRecord | null {
  const counts = new Map<LengthBucketKey, Tally>();
  let missing = 0;
  for (const game of games) {
    const seconds = game.durationSec;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
      missing += 1;
      continue;
    }
    const key = lengthBucket(seconds);
    const row = counts.get(key) ?? { games: 0, wins: 0, losses: 0 };
    counts.set(key, row);
    tally(row, game.result);
  }
  const buckets = LENGTH_BUCKETS.flatMap(({ key, label }) => {
    const row = counts.get(key);
    return row ? [{ key, label, ...row, winrate: decidedWinrate(row) }] : [];
  });
  return games.length > 0 ? { buckets, missing } : null;
}
