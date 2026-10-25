import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GameContext, LeagueBenchmark } from "@/lib/benchmarks";
const state = vi.hoisted(() => ({ data: undefined as { table: LeagueBenchmark } | undefined, error: undefined as { status: number } | undefined }));
vi.mock("@/lib/useBenchmarks", () => ({ useBenchmarks: () => state }));
import { GameContextCard } from "../GameContextCard";
const game = { gameId: "g", macroScore: 62, apm: 0, spq: null, durationSec: 600, opponent: { leagueId: 4 } };
const context: GameContext = { matchup: "PvZ", personal: { n: 12, limit: 50, build: "Blink", expansionTimings: { Nexus: 120 },
  expansionSample: 5, expansionLimit: 25, expansionMinSample: 5, metrics: {
    macroScore: { n: 12, median: 55, p25: 45, p75: 65 }, apm: { n: 12, median: 100, p25: 80, p75: 120 },
    spq: { n: 0, median: null, p25: null, p75: null }, durationSec: { n: 12, median: 500, p25: 400, p75: 600 },
  } }, league: null };
const table: LeagueBenchmark = { leagueId: 4, league: "Diamond", matchup: "PvZ", n: 100, updatedAt: "2026-10-24T00:00:00Z", metrics: {
  macroScore: { n: 100, deciles: [10,20,30,40,50,60,70,80,90] }, apm: { n: 49, deciles: null }, durationSec: { n: 100, deciles: [200,300,400,500,600,700,800,900,1000] },
} };
afterEach(() => { cleanup(); state.data = undefined; state.error = undefined; });
it("keeps personal measurements on a league404 and does not invent missing values", () => {
  state.error = { status: 404 };
  const legacy = { ...context } as Partial<GameContext>; delete legacy.league;
  render(<GameContextCard game={game} context={legacy as GameContext} onRetry={vi.fn()} />);
  expect(screen.getByText(/Your PvZ median55|Your PvZ median 55/)).toBeTruthy();
  expect(screen.getByText(/middle half45|middle half 45/)).toBeTruthy();
  expect(screen.getByText(/No earlier ranked PvZ games with this measurement/)).toBeTruthy();
  expect(screen.queryByText(/percentile ·/)).toBeNull();
  expect(screen.getByText(/Length gives context/)).toBeTruthy();
});
it("always exposes per-metric n, table date and the honest opponent-league band", () => {
  state.data = { table };
  render(<GameContextCard game={game} context={{ ...context, league: { table, percentiles: {} } }} onRetry={vi.fn()} />);
  expect(screen.getByText("62nd percentile · Diamond PvZ")).toBeTruthy();
  expect(screen.getAllByText("n=100 · updated 2026-10-24")).toHaveLength(2);
  expect(screen.getByRole("img", { name: /Macro score: band = opponent's league, Diamond PvZ/ })).toBeTruthy();
  expect(screen.queryByRole("img", { name: /^APM:/ })).toBeNull();
});
it("keeps an explicit context privacy suppression authoritative over a stale SWR table", () => {
  state.data = { table };
  render(<GameContextCard game={game} context={context} onRetry={vi.fn()} />);
  expect(screen.queryByText(/percentile ·/)).toBeNull();
  expect(screen.getByText(/Your PvZ median 55/)).toBeTruthy();
});
it("uses the fresh context table even if SWR holds a cached404 or an older distribution", () => {
  state.error = { status: 404 };
  state.data = { table: { ...table, league: "Stale league", updatedAt: "2020-01-01" } };
  render(<GameContextCard game={game} context={{ ...context, league: { table, percentiles: {} } }} onRetry={vi.fn()} />);
  expect(screen.getByText("62nd percentile · Diamond PvZ")).toBeTruthy();
  expect(screen.queryByText(/Stale league/)).toBeNull();
});
it("uses the reusable league hook only as a fallback for older context responses without the field", () => {
  state.data = { table };
  const { league: _league, ...legacy } = context;
  render(<GameContextCard game={game} context={legacy as GameContext} onRetry={vi.fn()} />);
  expect(screen.getByText("62nd percentile · Diamond PvZ")).toBeTruthy();
});
it("shows retryable comparison errors separately from missing league tables", () => {
  const retry = vi.fn();
  render(<GameContextCard game={game} error={{ status: 503, message: "Unavailable" }} onRetry={retry} />);
  fireEvent.click(screen.getByRole("button", { name: "Retry" })); expect(retry).toHaveBeenCalledOnce();
});
