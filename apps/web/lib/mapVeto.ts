import { currentMapPoolKey } from "./currentMapPool";
import type { GuideCi, GuideIndexMap } from "./guides/types";

export type MapMatchupStats = { map: string; matchup: string; wins: number; losses: number; total: number; winRate?: number | null };
export type MapFormStats = { name: string; wins: number; losses: number; total: number; recent?: ("win" | "loss")[] };
export type MapRecord = { wins: number; losses: number; total: number; decided: number; winRate: number | null; ci: GuideCi | null };
export type VetoMap = { name: string; gameMap: string; gameMaps: string[]; all: MapRecord; cells: Record<string, MapRecord>; recent?: ("win" | "loss")[] };
const count = (value: number) => Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** Matches the guides API's 95% Wilson primitive; ties never enter the denominator. */
export function mapRecord(wins = 0, losses = 0, total = wins + losses): MapRecord {
  wins = count(wins); losses = count(losses);
  const decided = wins + losses, rate = decided ? wins / decided : null;
  if (rate === null) return { wins, losses, total: Math.max(count(total), decided), decided, winRate: null, ci: null };
  const z2 = 1.96 ** 2, denominator = 1 + z2 / decided;
  const center = (rate + z2 / (2 * decided)) / denominator;
  const margin = 1.96 * Math.sqrt(rate * (1 - rate) / decided + z2 / (4 * decided ** 2)) / denominator;
  return { wins, losses, total: Math.max(count(total), decided), decided, winRate: rate, ci: { low: Math.round(Math.max(0, center - margin) * 10000) / 10000, high: Math.round(Math.min(1, center + margin) * 10000) / 10000 } };
}

export function opponentRace(label: string): string {
  return /(?:vs\s*|v)([PTZR])\s*$/i.exec(label)?.[1]?.toUpperCase() ?? "unknown";
}

export function poolMapRows(pool: readonly string[], cells: readonly MapMatchupStats[], forms: readonly MapFormStats[] = []): VetoMap[] {
  return pool.map((name) => {
    const key = currentMapPoolKey(name), matches = cells.filter((row) => currentMapPoolKey(row.map) === key);
    const formRows = forms.filter((row) => currentMapPoolKey(row.name) === key);
    const all = mapRecord(), byRace: Record<string, MapRecord> = {};
    for (const row of matches) {
      const race = opponentRace(row.matchup), old = byRace[race] ?? mapRecord();
      byRace[race] = mapRecord(old.wins + count(row.wins), old.losses + count(row.losses), old.total + count(row.total));
      all.wins += count(row.wins); all.losses += count(row.losses); all.total += count(row.total);
    }
    return { name, gameMap: matches[0]?.map ?? name, gameMaps: [...new Set(matches.map((row) => row.map))], all: mapRecord(all.wins, all.losses, all.total), cells: byRace,
      recent: formRows.length === 1 ? formRows[0].recent?.slice().reverse() : undefined };
  });
}

/** A map needs this many decided games in the ranking matchup before it can be vetoed. */
export const VETO_MIN_DECIDED = 5;
/** Virtual games at the pool average blended into every map, so a short run moves its rate less than a long record. */
export const VETO_PRIOR_GAMES = 20;
/** One map's record in the ranking matchup; "" ranks all matchups together. */
export const rankedRecord = (row: VetoMap, matchup: string): MapRecord | undefined => matchup ? row.cells[matchup] : row.all;

function poolTotals(rows: readonly VetoMap[], matchup: string) {
  let wins = 0, decided = 0;
  for (const row of rows) { const record = rankedRecord(row, matchup); wins += record?.wins ?? 0; decided += record?.decided ?? 0; }
  return { wins, decided };
}

/** Decided-game win rate across every pool map in the ranking matchup. */
export function poolWinRate(rows: readonly VetoMap[], matchup: string): number | null {
  const pool = poolTotals(rows, matchup);
  return pool.decided ? pool.wins / pool.decided : null;
}

/** Beta-prior posterior mean: the map's wins and decided games plus VETO_PRIOR_GAMES at the pool average. */
export function adjustedWinRate(record: MapRecord, average: number): number {
  return (record.wins + VETO_PRIOR_GAMES * average) / (record.decided + VETO_PRIOR_GAMES);
}

/**
 * Lowest sample-adjusted win rates in the ranking matchup, at most `amount` (1–3). Ladder vetoes apply against every
 * opponent race, so "" (all matchups) is the planner default. Only maps below the pool average qualify, because
 * vetoing a stronger map would lower the expected win rate; fewer maps than requested can come back. Wilson lower
 * bounds are not used: a smaller sample has a lower bound, which would veto short winning runs ahead of long losing
 * records. Ties prefer the longer record, then the name.
 */
export function vetoMaps(rows: readonly VetoMap[], matchup: string, amount: number): string[] {
  const pool = poolTotals(rows, matchup);
  if (!pool.decided) return [];
  const average = pool.wins / pool.decided;
  return rows.flatMap((row) => {
    const record = rankedRecord(row, matchup);
    // wins / decided < the pool rate, cross-multiplied so a map exactly at the average never qualifies.
    return record && record.decided >= VETO_MIN_DECIDED && record.wins * pool.decided < pool.wins * record.decided
      ? [{ name: row.name, decided: record.decided, score: adjustedWinRate(record, average) }] : [];
  }).sort((a, b) => a.score - b.score || b.decided - a.decided || currentMapPoolKey(a.name).localeCompare(currentMapPoolKey(b.name)))
    .slice(0, Math.max(1, Math.min(3, Math.trunc(amount) || 1))).map((row) => row.name);
}

/** The public index already emits both sides; never complement a cell containing ties. */
export function communityMapRate(maps: readonly GuideIndexMap[], map: string, mine: string, opponent: string): number | null {
  if (!/^[PTZ]$/.test(mine) || !/^[PTZ]$/.test(opponent)) return null;
  const row = maps.find((candidate) => currentMapPoolKey(candidate.map) === currentMapPoolKey(map));
  const cell = row?.cells?.find((entry) => entry.matchup === `${mine}v${opponent}`);
  return cell && Number.isFinite(cell.winRate) && cell.winRate >= 0 && cell.winRate <= 1 ? cell.winRate : null;
}
