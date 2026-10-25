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

export function vetoMaps(rows: readonly VetoMap[], matchup: string, amount: number): string[] {
  return rows.map((row) => ({ name: row.name, record: matchup ? row.cells[matchup] : row.all }))
    .filter((row) => row.record?.decided >= 5 && row.record.ci !== null)
    .sort((a, b) => a.record.ci!.low - b.record.ci!.low || currentMapPoolKey(a.name).localeCompare(currentMapPoolKey(b.name)))
    .slice(0, Math.max(1, Math.min(3, Math.trunc(amount) || 1))).map((row) => row.name);
}

export function mostPlayedMapMatchup(cells: readonly MapMatchupStats[], random = false): string {
  if (random) return "";
  const totals = new Map<string, number>();
  for (const cell of cells) { const race = opponentRace(cell.matchup); if (/^[PTZ]$/.test(race)) totals.set(race, (totals.get(race) ?? 0) + count(cell.total)); }
  return [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "";
}

/** The public index already emits both sides; never complement a cell containing ties. */
export function communityMapRate(maps: readonly GuideIndexMap[], map: string, mine: string, opponent: string): number | null {
  if (!/^[PTZ]$/.test(mine) || !/^[PTZ]$/.test(opponent)) return null;
  const row = maps.find((candidate) => currentMapPoolKey(candidate.map) === currentMapPoolKey(map));
  const cell = row?.cells?.find((entry) => entry.matchup === `${mine}v${opponent}`);
  return cell && Number.isFinite(cell.winRate) && cell.winRate >= 0 && cell.winRate <= 1 ? cell.winRate : null;
}
