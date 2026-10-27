import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import type { SessionPolicy } from "@/lib/session-policy";

const auth = vi.hoisted(() => ({ owner: "", token: vi.fn<() => Promise<string>>() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({
  userId: auth.owner, isLoaded: true, isSignedIn: true, getToken: auth.token,
}) }));
// Only the catalog is synthetic. Both session generators/renderers, Today,
// ModeRunner, the complete data/policy hooks, SWR and state/providers are real.
vi.mock("../modes", async () => {
  const { createElement } = await import("react");
  const { firstGameOfDay } = await import("../modes/quizzes/firstGameOfDay");
  const { comebackCount } = await import("../modes/quizzes/comebackCount");
  const independent: import("../modes").AnyMode = {
    id: "synthetic-independent", kind: "quiz", category: "macro", difficulty: "easy", ttp: "fast", depthTag: "conditional",
    title: "Independent quiz", blurb: "A bounded synthetic independent round",
    generate: async () => ({ ok: true, minDataMet: true, question: "Recorded independent round" }),
    score: () => ({ raw: 1, xp: 10, outcome: "correct", note: "Recorded" }),
    render: ctx => createElement("section", null,
      createElement("h3", null, String(ctx.question)),
      createElement("output", { "aria-label": "Independent answer" }, ctx.revealed ? "answered" : "unanswered"),
      createElement("button", { type: "button", onClick: () => ctx.onAnswer("yes") }, "Answer independent round")),
  };
  const game: import("../modes").AnyMode = {
    id: "synthetic-daily-game", kind: "game", category: "macro", difficulty: "easy", ttp: "fast", depthTag: "conditional",
    title: "Independent daily game", blurb: "A bounded synthetic game for the actual Today runner graph",
    generate: async () => ({ ok: true, minDataMet: true, question: "Recorded daily game round" }),
    score: () => ({ raw: 1, xp: 10, outcome: "correct", note: "Game recorded" }),
    render: ctx => createElement("section", null,
      createElement("h3", null, String(ctx.question)),
      createElement("output", { "aria-label": "Daily game answer" }, ctx.revealed ? "played" : "unplayed"),
      createElement("button", { type: "button", onClick: () => ctx.onAnswer("played") }, "Play daily game")),
  };
  return { QUIZZES: [firstGameOfDay, comebackCount, independent], GAMES: [game] };
});
vi.mock("../hud/StreakHUD", () => ({ StreakHUD: () => null }));
vi.mock("../hud/XpBar", () => ({ XpBar: () => null }));
vi.mock("../hud/MascotCorner", () => ({ MascotCorner: () => null }));

import { API_BASE } from "@/lib/clientApi";
import { TodaySurface } from "../surfaces/Today";
import { AnalysisGamesProvider } from "../hooks/useAnalysisGames";
import { CustomBuildCatalogProvider } from "@/components/builds/useCustomBuildCatalog";
import { arcadeStoreFor, resetArcadeStoresForTests } from "../hooks/arcadeStore";
import { dailySeed, mulberry32, todayKey } from "../ArcadeEngine";

const policy: SessionPolicy = { gapMinutes: 45, source: "preference", storedGapMinutes: 45 };
const start = Date.parse("2026-10-20T00:00:00Z");
const games = Array.from({ length: 5 }, (_, session) => Array.from({ length: 4 }, (_, position) => ({
  gameId: `${session}-${position}`, date: new Date(start + session * 5 * 3_600_000 + position * 60_000).toISOString(),
  result: "Victory", myRace: "P", opponent: { race: "Z" },
}))).flat();
type Held = { promise: Promise<Response>; resolve: (value: Response) => void };
function deferred(): Held {
  let resolve!: Held["resolve"];
  const promise = new Promise<Response>(yes => { resolve = yes; });
  const held = { promise, resolve }; pending.add(held); return held;
}
const reply = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
let cache: Map<string, { data?: unknown }>;
let pending: Set<Held>;
let heldCorpus: Map<string, Held>;
let heldPolicy: Map<string, Held>;
let policyReads: Map<string, number>;
let requests: { owner: string; path: string; method: string }[];
let unexpected: string[];
let owners: Set<string>;
let remoteState: Map<string, unknown>;

function chooseOwner(days: string[], prefix: string) {
  for (let index = 0; index < 512; index++) {
    const owner = `${prefix}${index}`;
    if (days.every(day => Math.floor(mulberry32(dailySeed(owner, day))() * 3) === 0)) return owner;
  }
  throw new Error("Expected a deterministic first-session-mode seed");
}
function View() {
  return <SWRConfig value={{ provider: () => cache, revalidateOnFocus: false, revalidateOnReconnect: false, shouldRetryOnError: false }}>
    <AnalysisGamesProvider enabled><CustomBuildCatalogProvider><TodaySurface /></CustomBuildCatalogProvider></AnalysisGamesProvider>
  </SWRConfig>;
}
async function advance(ms = 20) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function until(assertion: () => void) {
  let failure: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    await advance();
    try { assertion(); return; } catch (error) { failure = error; }
  }
  throw failure;
}
function attempts(owner: string) {
  return arcadeStoreFor(owner, true).getSnapshot().state.records["synthetic-independent"]?.attempts ?? 0;
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
  resetArcadeStoresForTests(); pending = new Set(); cache = new Map();
  heldCorpus = new Map(); heldPolicy = new Map(); policyReads = new Map(); requests = []; unexpected = []; owners = new Set(); remoteState = new Map();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const days = [todayKey(new Date("2026-10-27T12:00:00Z"), tz), todayKey(new Date("2026-10-28T12:00:00Z"), tz)];
  auth.owner = chooseOwner(days, "graph-owner-"); owners.add(auth.owner);
  auth.token.mockReset().mockImplementation(async () => `jwt-${auth.owner}`);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const token = new Headers(init.headers).get("authorization") ?? "";
    const owner = token.startsWith("Bearer jwt-") ? token.slice("Bearer jwt-".length) : "";
    const reject = () => { const description = `${method} ${url.origin}${url.pathname}${url.search} owner=${owner}`; unexpected.push(description); throw new Error(`Unexpected synthetic transport: ${description}`); };
    if (url.origin !== new URL(API_BASE).origin || !owners.has(owner)) return reject();
    requests.push({ owner, path: `${url.pathname}${url.search}`, method });
    if (url.pathname === "/v1/me/session-policy" && !url.search && method === "GET") {
      const count = (policyReads.get(owner) ?? 0) + 1; policyReads.set(owner, count);
      // A redundant child read is deliberately held. The test must show that
      // it never starts, rather than hiding the parent's validation flicker.
      if (count > 1) return deferred().promise;
      return heldPolicy.get(owner)?.promise ?? reply(policy);
    }
    if (url.pathname === "/v1/games/analysis-corpus" && url.search === "?limit=2000" && method === "GET") {
      return heldCorpus.get(owner)?.promise ?? reply({ items: games, nextCursor: null });
    }
    if (url.pathname === "/v1/me/preferences/arcade" && !url.search) {
      if (method === "GET") return reply(remoteState.get(owner) ?? {});
      if (method === "PUT") { const state: unknown = JSON.parse(String(init.body)); remoteState.set(owner, state); return reply(state); }
      return reject();
    }
    if (method !== "GET") return reject();
    const route = `${url.pathname}${url.search}`;
    if (route === "/v1/opponents?limit=500") return reply({ items: [] });
    if (["/v1/builds", "/v1/matchups", "/v1/maps"].includes(route)) return reply([]);
    if (route === "/v1/summary") return reply({ totals: { total: games.length, wins: games.length, losses: 0, winRate: 1 } });
    if (route === "/v1/custom-builds?view=summary&limit=100") return reply({ items: [], nextCursor: null });
    if (route === "/v1/community/arcade-universe?perMatchup=12") return reply({ items: [] });
    if (route === "/v1/seasons") return reply({ mapPool: [] });
    if (route === "/v1/arcade/unit-stats") return reply({ scannedGames: 0, builtByUnit: {}, totalUnitsLost: 0, lostGames: 0 });
    return reject();
  }));
});
afterEach(async () => {
  try {
    cleanup();
    for (const held of pending) held.resolve(reply({}));
    await advance(1000);
    await Promise.all([...owners].map(owner => arcadeStoreFor(owner, true).whenIdle()));
    expect(unexpected).toEqual([]);
  } finally {
    resetArcadeStoresForTests(); vi.unstubAllGlobals(); vi.useRealTimers();
  }
});

it("real Today and its newly mounted session runner share the admitted parent read without a second GET", async () => {
  const owner = auth.owner, corpus = deferred(); heldCorpus.set(owner, corpus);
  render(<View />);
  await until(() => expect(policyReads.get(owner)).toBe(1));
  await advance(100); // complete policy parsing and SWR's zero-delay settled cleanup
  expect(screen.queryByRole("heading", { name: "First-Game-of-Day" })).toBeNull();
  await act(async () => { corpus.resolve(reply({ items: games, nextCursor: null })); });
  await until(() => expect(screen.getByRole("heading", { name: "First-Game-of-Day" })).toBeTruthy());
  await advance(100); // run any child warm-cache animation-frame revalidation
  expect(policyReads.get(owner)).toBe(1);
  expect(screen.getByRole("heading", { name: "First-Game-of-Day" })).toBeTruthy();
  expect(screen.getByText(/A "session" ends after more than 45 minutes without a game/)).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Recorded independent round" })).toBeNull();
  expect(requests.filter(row => row.owner === owner && row.path.startsWith("/v1/games/analysis-corpus"))).toHaveLength(1);
});

it("real policy arrival preserves the answered independent round, and real owner/day changes retire it", async () => {
  const firstOwner = auth.owner, firstPolicy = deferred(); heldPolicy.set(firstOwner, firstPolicy);
  const view = render(<View />);
  await until(() => expect(screen.getByRole("heading", { name: "Recorded independent round" })).toBeTruthy());
  await until(() => expect(arcadeStoreFor(firstOwner, true).getSnapshot().hydrated).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Answer independent round" }));
  expect(screen.getByRole("status", { name: "Independent answer" }).textContent).toBe("answered");
  expect(attempts(firstOwner)).toBe(1);
  await act(async () => { firstPolicy.resolve(reply(policy)); });
  await advance(100);
  expect(policyReads.get(firstOwner)).toBe(1);
  expect(screen.getByRole("status", { name: "Independent answer" }).textContent).toBe("answered");
  expect(attempts(firstOwner)).toBe(1);

  vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
  await advance(60_001); // the real useDailySeed interval observes the new day
  await until(() => expect(screen.getByRole("heading", { name: "First-Game-of-Day" })).toBeTruthy());
  expect(screen.queryByRole("status", { name: "Independent answer" })).toBeNull();
  expect(attempts(firstOwner)).toBe(1); expect(policyReads.get(firstOwner)).toBe(1);

  const nextOwner = chooseOwner([todayKey(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC")], "next-graph-owner-");
  owners.add(nextOwner); const nextPolicy = deferred(); heldPolicy.set(nextOwner, nextPolicy); auth.owner = nextOwner;
  view.rerender(<View />);
  expect(screen.queryByRole("heading", { name: "First-Game-of-Day" })).toBeNull();
  await until(() => expect(screen.getByRole("status", { name: "Independent answer" }).textContent).toBe("unanswered"));
  await until(() => expect(arcadeStoreFor(nextOwner, true).getSnapshot().hydrated).toBe(true));
  expect(attempts(nextOwner)).toBe(0); expect(attempts(firstOwner)).toBe(1);
  await act(async () => { nextPolicy.resolve(reply(policy)); });
  await advance(100);
  expect(screen.getByRole("status", { name: "Independent answer" }).textContent).toBe("unanswered");
  expect(attempts(nextOwner)).toBe(0); expect(policyReads.get(nextOwner)).toBe(1);
});
it("real Daily Run shares the admitted Today source after policy settles before the game mounts", async () => {
  const owner = auth.owner, corpus = deferred(); heldCorpus.set(owner, corpus);
  render(<View />);
  await until(() => expect(policyReads.get(owner)).toBe(1));
  await advance(100); // settle the real parent policy and completed FETCH cleanup
  expect(screen.queryByRole("heading", { name: "Recorded daily game round" })).toBeNull();
  await act(async () => { corpus.resolve(reply({ items: games, nextCursor: null })); });
  await until(() => expect(screen.getByRole("heading", { name: "Recorded daily game round" })).toBeTruthy());
  await advance(100); // a standalone later reader would start the held second GET
  expect(policyReads.get(owner)).toBe(1);
  expect(screen.getByRole("heading", { name: "Recorded daily game round" })).toBeTruthy();
  expect(screen.getByRole("status", { name: "Daily game answer" }).textContent).toBe("unplayed");
  expect(arcadeStoreFor(owner, true).getSnapshot().state.records["synthetic-daily-game"]?.attempts ?? 0).toBe(0);
  expect(requests.filter(row => row.owner === owner && row.path.startsWith("/v1/games/analysis-corpus"))).toHaveLength(1);
});

it("real Daily Run retains its played round and one store attempt when shared policy arrives", async () => {
  const owner = auth.owner, firstPolicy = deferred(); heldPolicy.set(owner, firstPolicy);
  render(<View />);
  await until(() => expect(screen.getByRole("heading", { name: "Recorded daily game round" })).toBeTruthy());
  await until(() => expect(arcadeStoreFor(owner, true).getSnapshot().hydrated).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Play daily game" }));
  expect(screen.getByRole("status", { name: "Daily game answer" }).textContent).toBe("played");
  expect(arcadeStoreFor(owner, true).getSnapshot().state.records["synthetic-daily-game"]?.attempts).toBe(1);
  await act(async () => { firstPolicy.resolve(reply(policy)); });
  await advance(100);
  expect(policyReads.get(owner)).toBe(1);
  expect(screen.getByRole("heading", { name: "Recorded daily game round" })).toBeTruthy();
  expect(screen.getByRole("status", { name: "Daily game answer" }).textContent).toBe("played");
  expect(arcadeStoreFor(owner, true).getSnapshot().state.records["synthetic-daily-game"]?.attempts).toBe(1);
  expect(requests.filter(row => row.owner === owner && row.path.startsWith("/v1/games/analysis-corpus"))).toHaveLength(1);
});
