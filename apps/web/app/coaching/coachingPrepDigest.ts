/**
 * The "Since last session" prep digest a booking's coach and student
 * share: facts from synced 1v1 replays only (counts, W-L by matchup,
 * detected builds, newest replays), never grades or scores. The Sessions
 * tab renders it on each upcoming booking; the Locker's React port can
 * reuse ``parsePrepDigest`` and ``PrepDigestView`` as they are.
 */

export type PrepDigestRole = "coach" | "student";

export type PrepDigestReplay = {
  gameId: string;
  playedAt: string | null;
  map: string | null;
  matchup: string | null;
  result: "Win" | "Loss" | null;
  build: string | null;
};

export type PrepDigestMatchup = { matchup: string; games: number; wins: number; losses: number; winRate: number | null };

export type PrepDigestFacts = {
  state: "ready" | "no_games";
  bookingId: string;
  role: PrepDigestRole;
  window: { since: string; until: string; basis: "last_session" | "sharing_started" | "lookback_limit" };
  lastSession: { startAt: string | null; endAt: string | null } | null;
  totals: { games: number; wins: number; losses: number; other: number };
  matchups: PrepDigestMatchup[];
  unknownRaceGames: number;
  builds: Array<{ name: string; games: number }>;
  moreBuilds: number;
  unclassifiedGames: number;
  replays: PrepDigestReplay[];
  moreReplays: number;
  minSample: number;
  lookbackDays: number;
};

export type PrepDigest =
  | { state: "sharing_off"; bookingId: string; role: PrepDigestRole; sharing: string }
  | PrepDigestFacts;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function list<T>(value: unknown, read: (item: Record<string, unknown>) => T | null): T[] {
  return Array.isArray(value) ? value.map((item) => { const row = record(item); return row ? read(row) : null; }).filter((item): item is T => item !== null) : [];
}

/** Accept only the digest's own shape; anything else reads as unavailable. */
export function parsePrepDigest(raw: unknown): PrepDigest | null {
  const body = record(raw);
  const role = body?.role === "coach" || body?.role === "student" ? body.role : null;
  const bookingId = text(body?.bookingId);
  if (!body || !role || !bookingId) return null;
  if (body.state === "sharing_off") return { state: "sharing_off", bookingId, role, sharing: text(body.sharing) ?? "pending" };
  if (body.state !== "ready" && body.state !== "no_games") return null;
  const window = record(body.window);
  const totals = record(body.totals);
  const since = text(window?.since);
  const basis = window?.basis;
  if (!window || !totals || !since || (basis !== "last_session" && basis !== "sharing_started" && basis !== "lookback_limit")) return null;
  const last = record(body.lastSession);
  return {
    state: body.state, bookingId, role,
    window: { since, until: text(window.until) ?? since, basis },
    lastSession: last ? { startAt: text(last.startAt), endAt: text(last.endAt) } : null,
    totals: { games: count(totals.games), wins: count(totals.wins), losses: count(totals.losses), other: count(totals.other) },
    matchups: list(body.matchups, (row) => {
      const matchup = text(row.matchup);
      return matchup ? { matchup, games: count(row.games), wins: count(row.wins), losses: count(row.losses), winRate: typeof row.winRate === "number" ? row.winRate : null } : null;
    }),
    unknownRaceGames: count(body.unknownRaceGames),
    builds: list(body.builds, (row) => { const name = text(row.name); return name ? { name, games: count(row.games) } : null; }),
    moreBuilds: count(body.moreBuilds),
    unclassifiedGames: count(body.unclassifiedGames),
    replays: list(body.replays, (row) => {
      const gameId = text(row.gameId);
      return gameId ? {
        gameId, playedAt: text(row.playedAt), map: text(row.map), matchup: text(row.matchup),
        result: row.result === "Win" || row.result === "Loss" ? row.result : null, build: text(row.build),
      } : null;
    }),
    moreReplays: count(body.moreReplays),
    minSample: count(body.minSample) || 5,
    lookbackDays: count(body.lookbackDays) || 90,
  };
}

function shortDate(iso: string | null, timeZone: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { timeZone, month: "short", day: "numeric" }).format(date);
}

/** "Since your session on Oct 30" (from the viewer's side of the booking). */
export function digestWindowLabel(digest: PrepDigestFacts, timeZone: string): string {
  if (digest.window.basis === "last_session") {
    return `Since ${digest.role === "coach" ? "your last session together" : "your last session"} on ${shortDate(digest.lastSession?.startAt ?? digest.window.since, timeZone)}`;
  }
  if (digest.window.basis === "sharing_started") return `Since practice sharing started on ${shortDate(digest.window.since, timeZone)}`;
  return `Last ${digest.lookbackDays} days`;
}

export function digestRecord(wins: number, losses: number, winRate: number | null): string {
  return winRate === null ? `${wins}–${losses}` : `${wins}–${losses} (${Math.round(winRate * 100)}%)`;
}

export function digestPlayedLabel(iso: string | null, timeZone: string): string {
  return shortDate(iso, timeZone);
}
