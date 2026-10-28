import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { SWRConfig } from "swr";
import { ModeRunner } from "../ModeRunner";
import { AnalysisGamesProvider } from "../hooks/useAnalysisGames";
import { useArcadeData } from "../hooks/useArcadeData";
import { unitProfile } from "../modes/quizzes/unitProfile";
import type { AnyMode } from "../modes";
import type { ArcadeUnitStats } from "../types";

const mocks = vi.hoisted(() => ({ recordPlay: vi.fn(), earnBadge: vi.fn(), token: vi.fn(), rng: () => 0.3 }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({
  userId: "synthetic-history-owner", isLoaded: true, isSignedIn: true, getToken: mocks.token,
}) }));
vi.mock("../hooks/useDailySeed", () => ({ useDailySeed: () => ({ day: "2026-10-28", tz: "UTC", rng: mocks.rng }) }));
vi.mock("../hooks/useArcadeState", () => ({ useArcadeState: () => ({
  recordPlay: mocks.recordPlay, earnBadge: mocks.earnBadge, state: { buildleByDay: {} },
}) }));
vi.mock("@/lib/session-policy", () => ({ useSessionPolicy: () => ({
  policy: null, loading: false, error: null, retry: async () => undefined,
}) }));
const catalog = { data: { items: [] }, isLoading: false, error: null };
vi.mock("@/components/builds/useCustomBuildCatalog", () => ({ useCustomBuildCatalog: () => catalog }));
vi.mock("../ShareCard", () => ({ shareCard: vi.fn() }));

// Real corpus pagination, useApi/SWR, dataset mapping, runner and quiz. Only
// auth, account writes and HTTP transport are synthetic; no answer is submitted.
const history = Array.from({ length: 13_000 }, (_, index) => ({
  gameId: `recorded-${index}`, date: "2026-10-27T00:00:00Z", result: "Victory", myRace: "Terran",
}));
const stats: ArcadeUnitStats = { scannedGames: 1000,
  builtByUnit: { Marine: 500, Marauder: 200, Reaper: 100, SiegeTank: 50 }, totalUnitsLost: 0, lostGames: 0 };
const unitMode = unitProfile as unknown as AnyMode;
const independent: AnyMode = { id: "independent-readiness-specimen", kind: "quiz", category: "macro", difficulty: "easy",
  ttp: "fast", depthTag: "conditional", title: "Independent", blurb: "Unrelated corpus mode",
  generate: async () => ({ ok: true, minDataMet: true, question: "Independent round ready" }),
  render: ctx => <h2>{String(ctx.question)}</h2>, score: () => ({ raw: 0, xp: 0, outcome: "wrong", note: "Unused" }) };
type Held = { promise: Promise<Response>; resolve: (response: Response) => void };
let pending: Set<Held>, queue: Promise<Response>[], requests: { path: string; method: string }[], unexpected: string[];
let generate: MockInstance<typeof unitProfile.generate>;
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
function hold(): Held {
  let resolve!: Held["resolve"];
  const held = { promise: new Promise<Response>(yes => { resolve = yes; }), resolve: (value: Response) => resolve(value) };
  pending.add(held); return held;
}
function transport(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input)), route = url.pathname;
  requests.push({ path: route, method: init?.method || "GET" });
  if (route === "/v1/arcade/unit-stats") return queue.shift() || Promise.resolve(response(stats));
  if (route === "/v1/games/analysis-corpus") {
    const start = Number(url.searchParams.get("cursor")) || 0, end = Math.min(start + 2000, history.length);
    return Promise.resolve(response({ items: history.slice(start, end), nextCursor: end < history.length ? String(end) : null }));
  }
  const routes: Record<string, unknown> = { "/v1/opponents": { items: [] }, "/v1/builds": [],
    "/v1/matchups": [], "/v1/maps": [], "/v1/community/arcade-universe": { items: [] },
    "/v1/seasons": { mapPool: [] }, "/v1/summary": { totals: { total: history.length, wins: history.length, losses: 0, winRate: 1 } } };
  if (Object.hasOwn(routes, route)) return Promise.resolve(response(routes[route]));
  unexpected.push(route); return Promise.resolve(response({}, 500));
}
function Surface({ mode = unitMode }: { mode?: AnyMode }) {
  const source = useArcadeData();
  return <><output aria-label="Available corpus games">{source.baseData?.games.length || 0}</output>
    <ModeRunner mode={mode} isDaily={false} dataSource={source} /></>;
}
function mount(mode = unitMode) {
  return render(<SWRConfig value={{ provider: () => new Map(), revalidateOnFocus: false,
    revalidateOnReconnect: false, shouldRetryOnError: false, dedupingInterval: 0 }}>
    <AnalysisGamesProvider enabled><Surface mode={mode} /></AnalysisGamesProvider>
  </SWRConfig>);
}
async function corpusReady() {
  await waitFor(() => expect(screen.getByLabelText("Available corpus games").textContent).toBe("13000"));
  expect(requests.filter(row => row.path === "/v1/games/analysis-corpus")).toHaveLength(7);
}
async function questionReady() {
  await screen.findByRole("heading", { name: "Unit Profile" });
  for (const name of Object.keys(stats.builtByUnit)) expect(screen.getByRole("button", { name: new RegExp(name) })).toBeTruthy();
  expect(screen.queryByText("Not enough data yet")).toBeNull();
}
beforeEach(() => {
  pending = new Set(); queue = []; requests = []; unexpected = [];
  mocks.token.mockReset().mockResolvedValue("synthetic-token"); mocks.recordPlay.mockReset(); mocks.earnBadge.mockReset();
  generate = vi.spyOn(unitProfile, "generate"); vi.stubGlobal("fetch", vi.fn(transport));
});
afterEach(async () => {
  cleanup();
  await act(async () => { for (const held of pending) held.resolve(response(stats)); });
  expect(unexpected).toEqual([]); expect(requests.every(row => row.method === "GET")).toBe(true);
  expect(mocks.recordPlay).not.toHaveBeenCalled(); expect(mocks.earnBadge).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it("waits for real aggregate readiness with a 13000-game corpus, then generates from its actual counts", async () => {
  const held = hold(); queue.push(held.promise); mount(); await corpusReady();
  expect(screen.getByText("Loading your unit history for this round")).toBeTruthy();
  expect(screen.queryByText("Not enough data yet")).toBeNull(); expect(generate).not.toHaveBeenCalled();
  await act(async () => held.resolve(response(stats))); await questionReady();
  expect(generate).toHaveBeenCalledOnce();
  expect(generate.mock.calls[0][0].data.unitStats).toEqual(stats);
});
it("reports a provider failure, retries only unit history and waits before admitting the real question", async () => {
  queue.push(Promise.resolve(response({ error: { code: "arcade_unit_stats_unavailable", message: "Unit details temporarily unavailable" } }, 503)));
  const retry = hold(); queue.push(retry.promise); mount(); await corpusReady();
  await screen.findByText("Couldn't load unit history"); expect(generate).not.toHaveBeenCalled();
  expect(screen.queryByText("Not enough data yet")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry unit history" }));
  await screen.findByText("Loading your unit history for this round");
  await act(async () => retry.resolve(response(stats))); await questionReady();
  expect(requests.filter(row => row.path === "/v1/arcade/unit-stats")).toHaveLength(2);
  expect(requests.filter(row => row.path === "/v1/summary")).toHaveLength(1);
});
it.each([0, 24])("keeps the original data gate after a successful genuinely insufficient%d-game aggregate", async scannedGames => {
  queue.push(Promise.resolve(response({ ...stats, scannedGames, builtByUnit: scannedGames ? stats.builtByUnit : {} })));
  mount(); await corpusReady(); await screen.findByText("Not enough data yet");
  expect(screen.getByText(/needs detailed build-log history/)).toBeTruthy(); expect(generate).toHaveBeenCalledOnce();
  expect(screen.queryByText("Couldn't load unit history")).toBeNull();
});
it("keeps an unrelated mode usable while the same unit-detail request remains pending", async () => {
  const held = hold(); queue.push(held.promise); mount(independent); await corpusReady();
  await screen.findByRole("heading", { name: "Independent round ready" });
  expect(screen.queryByText("Loading your unit history for this round")).toBeNull();
  expect(generate).not.toHaveBeenCalled();
});
