import { afterEach, describe, expect, it, vi } from "vitest";
import { API_BASE } from "../clientApi";
import { commandPrivateHref } from "../commandSearchActivation";
import { PrivateCommandSearchError } from "../privateCommandSearch";
import {
  decodeRecentGames, recentGameChoices, recentGamesQuery, recentGamesUrl, requestRecentGames,
} from "../recentGamesCommandSearch";

const BASE = API_BASE.replace(/\/+$/, "");
function row(gameId: string, overrides: Record<string, unknown> = {}) {
  return { gameId, date: "2026-10-29T18:00:00.000Z", result: "Victory", map: "Alcyone LE", durationSec: 612,
    myBuild: "Blink", matchup: "PvT", opponent: { displayName: "Rival", race: "Terran", pulseId: "1-S2-1-9" },
    replayAvailable: true, streams: [], ...overrides };
}
function page(items: unknown[], extra: Record<string, unknown> = {}) {
  return { profile: { handle: "owner-id", displayName: "Me" }, items, page: { nextCursor: null, hasMore: false, ...extra } };
}
function response(body: unknown, url: string, init: ResponseInit & { redirected?: boolean } = {}) {
  const result = new Response(typeof body === "string" ? body : JSON.stringify(body),
    { status: 200, headers: { "content-type": "application/json" }, ...init });
  Object.defineProperty(result, "url", { value: url });
  if (init.redirected) Object.defineProperty(result, "redirected", { value: true });
  return result;
}
afterEach(() => { vi.unstubAllGlobals(); });

describe("recent games query and URL", () => {
  it("keeps the private query literal and refuses what the library would cut", () => {
    expect(recentGamesQuery("  É  [a].*  ")).toBe("É  [a].*");
    expect(recentGamesQuery("a".repeat(80))).toBe("a".repeat(80));
    expect(recentGamesQuery("😀".repeat(51))).toBeNull();
    expect(recentGamesQuery("😀".repeat(50))).toBe("😀".repeat(50));
    expect(recentGamesQuery("a")).toBeNull();
  });
  it("asks for five newest games from the recent window with no enrichment", () => {
    expect(recentGamesUrl("Rival & co")).toBe(
      `${BASE}/v1/replays?search=Rival+%26+co&limit=5&sort=date_desc&enrich=none&window=recent`);
  });
});

describe("recent games decoder", () => {
  it("picks only what a row needs and keeps the server's order", () => {
    const decoded = decodeRecentGames(page([row("g-2"), row("g-1", { result: "Defeat", opponent: null, matchup: null, date: null })]));
    expect(decoded).toEqual({ hasMore: false, items: [
      { gameId: "g-2", date: "2026-10-29T18:00:00.000Z", result: "Win", map: "Alcyone LE", matchup: "PvT", opponent: "Rival" },
      { gameId: "g-1", date: null, result: "Loss", map: "Alcyone LE", matchup: null, opponent: null },
    ] });
    expect(JSON.stringify(decoded)).not.toMatch(/owner-id|1-S2-1-9|Blink/);
  });
  it.each([
    ["an API that ignored enrich=none", page([row("g-1", { streams: [{ platform: "twitch" }] })])],
    ["an API that ignored window=recent", page([row("g-1")], { nextCursor: "next" })],
    ["more than five rows", page(Array.from({ length: 6 }, (_, index) => row(`g-${index}`)))],
    ["hasMore without five rows", page([row("g-1")], { hasMore: true })],
    ["a repeated game", page([row("g-1"), row("g-1")])],
    ["a malformed game id", page([row("..")])],
    ["a control character", page([row("g-1", { map: "Alcyone\u0007" })])],
    ["a non-ISO date", page([row("g-1", { date: "yesterday" })])],
    ["a strange matchup", page([row("g-1", { matchup: "PvX" })])],
    ["a missing page", { items: [] }],
  ])("fails closed on %s", (_label, value) => {
    expect(() => decodeRecentGames(value)).toThrow(PrivateCommandSearchError);
  });
  it("never runs an accessor", () => {
    const item = row("g-1"); let read = false;
    Object.defineProperty(item, "map", { enumerable: true, get() { read = true; return "Alcyone LE"; } });
    expect(decodeRecentGames(page([item])).items[0].map).toBeNull();
    expect(read).toBe(false);
  });
});

describe("recent game choices", () => {
  it("label the opponent, describe the map, result and date, and link the game locally", () => {
    const [first, second] = recentGameChoices(decodeRecentGames(page([row("2026|Rival|Alcyone"), row("g-2", { opponent: null })])));
    expect(first).toEqual({ group: "games", label: "Rival", target: { kind: "game", gameId: "2026|Rival|Alcyone" },
      href: "/app/game/2026%7CRival%7CAlcyone", description: "Alcyone LE · Win · Oct 29, 2026", matchup: "PvT" });
    expect(second).toMatchObject({ label: "Alcyone LE", description: "Win · Oct 29, 2026" });
    expect(commandPrivateHref(first.target)).toBe(first.href);
  });
});

describe("recent games request", () => {
  const ok = () => {};
  it("sends one authenticated GET with no credentials, referrer or redirects", async () => {
    const url = recentGamesUrl("Rival"), fetching = vi.fn<typeof fetch>(async () => response(page([row("g-1")]), url));
    vi.stubGlobal("fetch", fetching);
    const result = await requestRecentGames("Rival", async () => "token", new AbortController().signal, ok);
    expect(result.items.map(item => item.gameId)).toEqual(["g-1"]);
    expect(fetching).toHaveBeenCalledOnce();
    const [target, init] = fetching.mock.calls[0];
    expect(target).toBe(url);
    expect(init).toMatchObject({ method: "GET", credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
      headers: { accept: "application/json", authorization: "Bearer token" } });
  });
  it.each([
    ["a failed status", (url: string) => response({ error: { code: "x" } }, url, { status: 503 }), "unavailable"],
    ["a moved URL", () => response(page([]), `${BASE}/v1/elsewhere`), "invalid_response"],
    ["a redirect", (url: string) => response(page([]), url, { redirected: true }), "invalid_response"],
    ["another type", (url: string) => response(page([]), url, { headers: { "content-type": "text/html" } }), "invalid_response"],
    ["a declared oversize body", (url: string) => response(page([]), url,
      { headers: { "content-type": "application/json", "content-length": String(64 * 1024 + 1) } }), "response_too_large"],
  ])("refuses %s with a fixed code", async (_label, make, code) => {
    const url = recentGamesUrl("Rival");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => make(url)));
    await expect(requestRecentGames("Rival", async () => "token", new AbortController().signal, ok))
      .rejects.toMatchObject({ code });
  });
  it("sends nothing for a query the library would cut, or without a token", async () => {
    const fetching = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetching);
    await expect(requestRecentGames("😀".repeat(51), async () => "token", new AbortController().signal, ok))
      .rejects.toMatchObject({ code: "invalid_query" });
    await expect(requestRecentGames("Rival", async () => null, new AbortController().signal, ok))
      .rejects.toMatchObject({ code: "authentication_required" });
    expect(fetching).not.toHaveBeenCalled();
  });
});
