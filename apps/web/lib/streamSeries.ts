export interface SeriesSnapshot {
  v: 1; revision: number; format: 1 | 3 | 5 | 7; opponentName: string;
  maps: string[]; score: { you: number; opponent: number }; status: "active" | "complete" | "ended" | "paused";
  startedAt: number; playerRace: string | null; opponentRace: string | null; gamesPlayed: number;
  currentMap: string | null; nextMap: string | null; games: Array<{ result: "win" | "loss" | "draw"; map: string | null }>;
  headToHead: { wins: number; losses: number; draws: number; asOf: number } | null;
}
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown, cap: number): value is string => typeof value === "string" && value.length > 0 && value.length <= cap && !/[<>\u0000-\u001f\u007f-\u009f]/u.test(value);
const count = (value: unknown, cap: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= cap;
const race = (value: unknown): string | null => typeof value === "string" && ["P", "T", "Z", "R"].includes(value) ? value : null;
/** Invalid snapshots are ignored; null is the explicit never-started state.
 * Only public fields are copied, even if a malformed server adds private data. */
export function normalizeSeriesSnapshot(raw: unknown): SeriesSnapshot | null | undefined {
  if (raw === null) return null;
  const row = object(raw), score = object(row?.score);
  if (!row || row.v !== 1 || !count(row.revision, Number.MAX_SAFE_INTEGER) || row.revision === 0 || typeof row.format !== "number" || ![1, 3, 5, 7].includes(row.format)
    || !text(row.opponentName, 80) || !score || !count(score.you, 4) || !count(score.opponent, 4)
    || !["active", "complete", "ended", "paused"].includes(String(row.status)) || typeof row.startedAt !== "number" || !Number.isFinite(row.startedAt) || row.startedAt <= 0
    || !Array.isArray(row.maps) || row.maps.length > 20 || !row.maps.every(map => text(map, 100))
    || !Array.isArray(row.games) || row.games.length > 80 || !count(row.gamesPlayed, 80) || row.gamesPlayed !== row.games.length
    || ![row.currentMap, row.nextMap].every(map => map === null || text(map, 100))) return undefined;
  const needed = Math.ceil(row.format / 2), winner = Math.max(score.you, score.opponent) === needed;
  if (score.you > needed || score.opponent > needed || score.you === needed && score.opponent === needed
    || row.status === "complete" && !winner || row.status === "active" && winner) return undefined;
  const games: SeriesSnapshot["games"] = [];
  for (const item of row.games) {
    const game = object(item);
    if (!game || !["win", "loss", "draw"].includes(String(game.result)) || game.map !== null && !text(game.map, 100)) return undefined;
    games.push({ result: game.result as "win" | "loss" | "draw", map: game.map as string | null });
  }
  const h2h = object(row.headToHead);
  const headToHead = h2h && [h2h.wins, h2h.losses, h2h.draws].every(value => count(value, 10_000_000)) && typeof h2h.asOf === "number" && Number.isFinite(h2h.asOf)
    ? { wins: h2h.wins as number, losses: h2h.losses as number, draws: h2h.draws as number, asOf: h2h.asOf } : null;
  return { v: 1, revision: row.revision, format: row.format as SeriesSnapshot["format"], opponentName: row.opponentName,
    maps: row.maps, score: { you: score.you, opponent: score.opponent }, status: row.status as SeriesSnapshot["status"], startedAt: row.startedAt,
    playerRace: race(row.playerRace), opponentRace: race(row.opponentRace), gamesPlayed: row.gamesPlayed,
    currentMap: row.currentMap as string | null, nextMap: row.nextMap as string | null, games, headToHead };
}
export function newerSeries(current: SeriesSnapshot | null, next: SeriesSnapshot | null) {
  return (current?.revision ?? 0) > (next?.revision ?? 0) ? current : next;
}
/** Silent, local display fixture; it is never sent to a writer. */
export const SERIES_SAMPLE: SeriesSnapshot = {
  v: 1, revision: 1, format: 5, opponentName: "Sample opponent", maps: ["Alcyone", "Goldenaura", "Site Delta", "Oceanborn", "Ghost River"], score: { you: 2, opponent: 1 }, status: "active",
  startedAt: 1, playerRace: "P", opponentRace: "T", gamesPlayed: 3, currentMap: "Oceanborn", nextMap: "Ghost River",
  games: [{ result: "win", map: "Alcyone" }, { result: "loss", map: "Goldenaura" }, { result: "win", map: "Site Delta" }], headToHead: { wins: 7, losses: 5, draws: 0, asOf: 1 },
};
