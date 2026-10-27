/** Mirrored with API services/sessions.js over the same shared fixtures.
 * Supported parity is the JSON-stable schema scalar view, not universal BSON.
 * Stored date is replay END; startedAt is deliberately not substituted. */
export type SessionGame = {
  date?: unknown; gameId?: unknown; result?: unknown; myToonHandle?: unknown;
  myMmr?: unknown; opponent?: unknown;
};
type Descriptor = { rank: number; value: number | string | boolean };
type OrderKey = { time: number; idRank: number; id: string; values: Descriptor[] };
const MAX_DATE_MS = 8_640_000_000_000_000;
const FALLBACK = ["myToonHandle", "opponent.toonHandle", "outcomeRank", "result", "opponent.race", "myMmr"] as const;

export function instant(value: unknown): number | null {
  if (value instanceof Date) value = value.getTime();
  else if (typeof value === "string") {
    if (!/^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
    value = Date.parse(value);
  }
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_DATE_MS ? Math.trunc(value) : null;
}

export function wellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

export function codePoints(left: string, right: string): number {
  const a = left[Symbol.iterator](), b = right[Symbol.iterator]();
  for (;;) {
    const x = a.next(), y = b.next();
    if (x.done || y.done) return x.done === y.done ? 0 : x.done ? -1 : 1;
    const delta = x.value.codePointAt(0)! - y.value.codePointAt(0)!;
    if (delta) return delta < 0 ? -1 : 1;
  }
}

export function outcome(result: unknown): "W" | "L" | "U" {
  const text = String(result || "").toLowerCase();
  return text === "win" || text === "victory" ? "W" : text === "loss" || text === "defeat" ? "L" : "U";
}

function leaf(row: SessionGame, field: typeof FALLBACK[number]): unknown {
  if (field === "outcomeRank") return { U: 0, L: 1, W: 2 }[outcome(row.result)];
  if (field.startsWith("opponent.")) {
    if (row.opponent === null || row.opponent === undefined) return undefined;
    if (typeof row.opponent !== "object" || Array.isArray(row.opponent)) return {};
    return (row.opponent as Record<string, unknown>)[field.slice(9)];
  }
  return row[field as "myToonHandle" | "result" | "myMmr"];
}

function descriptor(value: unknown): Descriptor {
  if (value === undefined) return { rank: 0, value: 0 };
  if (value === null) return { rank: 1, value: 0 };
  if (typeof value === "boolean") return { rank: 2, value };
  if (typeof value === "number" && Number.isFinite(value)) return { rank: 3, value: value === 0 ? 0 : value };
  if (typeof value === "string" && wellFormed(value)) return { rank: 4, value };
  return { rank: 5, value: 0 };
}

function orderKey(row: SessionGame, time: number): OrderKey {
  const validId = typeof row.gameId === "string" && row.gameId.length > 0 && wellFormed(row.gameId);
  return { time, idRank: validId ? 0 : 1, id: validId ? String(row.gameId) : "", values: FALLBACK.map(field => descriptor(leaf(row, field))) };
}

function compareKeys(a: OrderKey, b: OrderKey): number {
  if (a.time !== b.time) return a.time < b.time ? -1 : 1;
  if (a.idRank !== b.idRank) return a.idRank - b.idRank;
  const id = codePoints(a.id, b.id); if (id) return id;
  for (let i = 0; i < a.values.length; i++) {
    const x = a.values[i], y = b.values[i];
    if (x.rank !== y.rank) return x.rank - y.rank;
    if (x.value === y.value) continue;
    if (x.rank === 4) return codePoints(String(x.value), String(y.value));
    return Number(x.value) < Number(y.value) ? -1 : 1;
  }
  return 0;
}

export function ordered<T extends SessionGame>(games: readonly T[]) {
  return games.flatMap(game => {
    const time = instant(game.date);
    return time === null ? [] : [{ game, time, key: orderKey(game, time) }];
  }).sort((a, b) => compareKeys(a.key, b.key));
}

export function validGap(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 15 && value <= 480;
}

/** All eligible rows bridge before consumers count decided results; tz labels
 * instants only. No mutation, deduplication, or hidden insertion/_id tie key. */
export function sessionize<T extends SessionGame>(games: readonly T[], opts: { gapMinutes: number; tz?: string }): { games: T[]; start: number; end: number }[] {
  if (!validGap(opts.gapMinutes)) throw new TypeError("session_gap_invalid");
  const sessions: { games: T[]; start: number; end: number }[] = [];
  for (const row of ordered(games)) {
    const previous = sessions.at(-1);
    if (!previous || row.time - previous.end > opts.gapMinutes * 60_000) sessions.push({ games: [row.game], start: row.time, end: row.time });
    else { previous.games.push(row.game); previous.end = row.time; }
  }
  return sessions;
}
