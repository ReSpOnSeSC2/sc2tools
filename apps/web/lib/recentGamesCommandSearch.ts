import {
  PRIVATE_COMMAND_SEARCH_BYTES, PrivateCommandSearchError, abortable, apiEndpoint, boundedJson, cancelBody,
  privateCommandHref, privateCommandQuery, safeId, safeText, type PrivateCommandChoice,
} from "./privateCommandSearch";

// Quick search's recent games (ADR 0069, 2026-11-01 amendment): the existing
// replay library read, bounded to the owner's newest games, with no VOD or
// SC2Pulse lookups. This leaf belongs to the intent-loaded command runtime and
// keeps no cache, storage, analytics or navigation.
export const RECENT_GAMES_PATH = "/v1/replays";
export const RECENT_GAMES_LIMIT = 5;
/** The replay library keeps the first 100 UTF-16 units of a search. */
export const RECENT_GAMES_QUERY_UNITS = 100;

export type RecentGame = Readonly<{
  gameId: string; date: string | null; result: "Win" | "Loss" | "Tie" | null;
  map: string | null; matchup: string | null; opponent: string | null;
}>;
export type RecentGamesResponse = Readonly<{ items: readonly RecentGame[]; hasMore: boolean }>;

const invalid = (): never => { throw new PrivateCommandSearchError("invalid_response"); };
const abortError = () => new DOMException("Recent games search is no longer current.", "AbortError");
const RESULTS: Readonly<Record<string, RecentGame["result"]>> = {
  victory: "Win", win: "Win", defeat: "Loss", loss: "Loss", tie: "Tie", draw: "Tie",
};

/** The private query, when the replay library would search all of it. */
export function recentGamesQuery(raw: unknown): string | null {
  const query = privateCommandQuery(raw);
  return query !== null && query.length <= RECENT_GAMES_QUERY_UNITS ? query : null;
}

/** Example: recentGamesUrl("Rival") → "<API>/v1/replays?search=Rival&limit=5&sort=date_desc&enrich=none&window=recent". */
export function recentGamesUrl(query: string): string {
  const url = new URL(apiEndpoint(RECENT_GAMES_PATH));
  url.search = new URLSearchParams([["search", query], ["limit", String(RECENT_GAMES_LIMIT)], ["sort", "date_desc"],
    ["enrich", "none"], ["window", "recent"]]).toString();
  return url.href;
}

/** An own, plain data property; accessors and inherited values never run or count. */
function field(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value as unknown : undefined;
}
function plainObject(value: unknown): object {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value : invalid();
}
function nullableText(value: unknown, maximumUnits: number): string | null {
  if (value === null || value === undefined) return null;
  return safeText(value, maximumUnits) ? value : invalid();
}
function nullableDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (!safeText(value, 32)) return invalid();
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? value : invalid();
}
function game(value: unknown): RecentGame {
  const row = plainObject(value), opponent = field(row, "opponent"), streams = field(row, "streams");
  const gameId = field(row, "gameId"), result = nullableText(field(row, "result"), 24), matchup = field(row, "matchup");
  if (!safeId(gameId, 200) || !Array.isArray(streams) || streams.length !== 0) return invalid();
  if (matchup !== null && matchup !== undefined && (typeof matchup !== "string" || !/^[PTZR]v[PTZR]$/.test(matchup))) return invalid();
  return Object.freeze({
    gameId, date: nullableDate(field(row, "date")), result: result === null ? null : RESULTS[result.toLowerCase()] ?? null,
    map: nullableText(field(row, "map"), 200), matchup: typeof matchup === "string" ? matchup : null,
    opponent: opponent === null || opponent === undefined ? null : nullableText(field(plainObject(opponent), "displayName"), 80),
  });
}

/**
 * Picks only the fields a row needs from the replay library page; every other
 * field is ignored and never copied. `streams: []` and `nextCursor: null` are
 * what enrich=none and window=recent answer, so an API that ignored them fails closed.
 */
export function decodeRecentGames(value: unknown): RecentGamesResponse {
  const root = plainObject(value), items = field(root, "items"), page = plainObject(field(root, "page"));
  const hasMore = field(page, "hasMore");
  if (!Array.isArray(items) || Object.getPrototypeOf(items) !== Array.prototype || items.length > RECENT_GAMES_LIMIT
    || typeof hasMore !== "boolean" || field(page, "nextCursor") !== null || (hasMore && items.length !== RECENT_GAMES_LIMIT)) return invalid();
  const games = Array.from({ length: items.length }, (_, index) => {
    if (!Object.hasOwn(items, index)) return invalid();
    return game(field(items, String(index)));
  });
  if (new Set(games.map(row => row.gameId)).size !== games.length) return invalid();
  return Object.freeze({ items: Object.freeze(games), hasMore });
}

// The viewer's own calendar day, as the rest of the app shows game dates.
const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

/** Rows link to the game page built locally from each validated game id. */
export function recentGameChoices(response: RecentGamesResponse): readonly PrivateCommandChoice[] {
  return Object.freeze(response.items.map(item => {
    const target = Object.freeze({ kind: "game" as const, gameId: item.gameId });
    const label = item.opponent ?? item.map ?? "Game";
    const description = [label === item.map ? null : item.map, item.result, item.date ? DATE.format(new Date(item.date)) : null]
      .filter(Boolean).join(" · ");
    return Object.freeze({ group: "games" as const, label, target, href: privateCommandHref(target),
      ...(description ? { description } : {}), ...(item.matchup ? { matchup: item.matchup } : {}) });
  }));
}

/** Must run inside useOwnerRequestScope; `assertCurrent` also owns the query,
 * opening and route, and runs before and after every asynchronous boundary. */
export async function requestRecentGames(query: string, getToken: () => Promise<string | null>,
  signal: AbortSignal, assertCurrent: () => void): Promise<RecentGamesResponse> {
  let response: Response | undefined;
  try {
    assertCurrent();
    if (recentGamesQuery(query) !== query) throw new PrivateCommandSearchError("invalid_query");
    const token = await getToken();
    assertCurrent();
    if (!token) throw new PrivateCommandSearchError("authentication_required");
    const url = recentGamesUrl(query);
    response = await abortable(fetch(url, {
      method: "GET", headers: { accept: "application/json", authorization: `Bearer ${token}` },
      credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal,
    }), signal, cancelBody);
    assertCurrent();
    if (response.status !== 200) throw new PrivateCommandSearchError("unavailable");
    if (response.redirected || response.url !== url
      || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return invalid();
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) return invalid();
    if (length !== null && Number(length) > PRIVATE_COMMAND_SEARCH_BYTES) throw new PrivateCommandSearchError("response_too_large");
    const raw = await boundedJson(response, signal, assertCurrent);
    assertCurrent();
    return decodeRecentGames(raw);
  } catch (error) {
    if (response && !response.body?.locked) cancelBody(response);
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError();
    if (error instanceof PrivateCommandSearchError) throw error;
    // Never expose a response body, URL, query, token or exception text.
    throw new PrivateCommandSearchError("unavailable");
  }
}
