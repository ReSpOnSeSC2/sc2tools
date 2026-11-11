import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Link from "next/link";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FiltersContext, type AnalyzerFilters } from "@/lib/filterContext";
import type { LeagueBenchmark } from "@/lib/benchmarks";
import type { TargetsResponse } from "@/lib/leagueTargets";

const deciles = (start: number, step: number) => Array.from({ length: 9 }, (_, i) => start + i * step);
function table(leagueId: number, league: string, sqStart: number): LeagueBenchmark {
  return { leagueId, league, matchup: "PvZ", n: 400, updatedAt: "2026-11-10T00:00:00.000Z", metrics: {
    spq: { n: 400, deciles: deciles(sqStart, 5) }, macroScore: { n: 400, deciles: deciles(40, 5) },
    apm: { n: 400, deciles: deciles(100, 10) }, durationSec: { n: 400, deciles: deciles(400, 60) } } };
}

const harness = vi.hoisted(() => ({
  paths: [] as string[],
  targets: null as unknown,
  prefs: { leagueOverride: null, targetLeague: null, targetMmr: null } as Record<string, number | null>,
  masterMissing: false,
  pulse: null as { race: string; mmr: number | null } | null,
  apiCall: vi.fn(),
  prefsMutate: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: async () => "synthetic" }) }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: () => <Link href="/help/league-targets">Help</Link> }));
vi.mock("@/lib/useSeasons", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/useSeasons")>()),
  useSeasons: () => ({ data: { items: [{ battlenetId: 68, region: "US", year: 2026, number: 4, start: "2026-10-01T00:00:00.000Z", end: new Date(Date.now() + 28 * 86_400_000).toISOString() }], current: 68, source: "pulse", fetchedAt: 0 } }),
}));
vi.mock("@/lib/clientApi", () => ({
  apiCall: (...args: unknown[]) => harness.apiCall(...args),
  useApi: (path: string | null) => {
    if (path) harness.paths.push(path);
    const ok = (data: unknown) => ({ data, error: null, isLoading: false, mutate: vi.fn() });
    if (!path) return ok(undefined);
    if (path.startsWith("/v1/benchmarks/targets")) return ok(harness.targets);
    if (path === "/v1/me/preferences/leagueTargets") return { ...ok(harness.prefs), mutate: harness.prefsMutate };
    if (path.startsWith("/v1/me/mmr?race=")) return ok(harness.pulse);
    const league = /leagueId=(\d)/.exec(path)?.[1];
    if (path.startsWith("/v1/benchmarks/timings")) {
      const p50 = league === "5" ? 90 : 95;
      return ok({ table: { era: "after", leagueId: Number(league), league: league === "5" ? "Master" : "Diamond", matchup: "PvZ", n: 300,
        timings: { natural: { n: 300, deciles: deciles(p50 - 20, 5) }, third: { n: 300, deciles: deciles(200, 5) }, firstUpgrade: { n: league === "5" ? 40 : 300, deciles: league === "5" ? null : deciles(200, 5) }, keyTech: { n: 0, deciles: null } } } });
    }
    if (path.startsWith("/v1/benchmarks?")) {
      if (league === "5" && harness.masterMissing) return { data: undefined, error: { status: 404, message: "not_enough_data" }, isLoading: false, mutate: vi.fn() };
      return ok({ table: league === "5" ? table(5, "Master", 62) : table(4, "Diamond", 55) });
    }
    return ok(undefined);
  },
}));

import { TargetsCard } from "../TargetsCard";

function targets(overrides: Partial<TargetsResponse> = {}): TargetsResponse {
  return {
    matchup: "PvZ", matchups: [{ matchup: "PvZ", games: 40 }, { matchup: "PvT", games: 12 }], sample: { n: 20, limit: 20 },
    medians: { spq: { n: 20, median: 68 }, macroScore: { n: 20, median: 61 }, apm: { n: 20, median: 155 }, durationSec: { n: 20, median: 660 } },
    mmr: { current: 4120, at: "2026-11-09T00:00:00.000Z", region: "NA", ladderRace: "P" },
    netMmr: { pairs: 18, games: 30, perGame: 5, window: 30 },
    timings: { era: "after", n: 12, limit: 20, timings: { natural: { n: 12, median: 102 }, third: { n: 12, median: 230 }, firstUpgrade: { n: 12, median: 230 }, keyTech: { n: 0, median: null } } },
    ...overrides,
  };
}

function renderCard(filters: AnalyzerFilters = {}, onDrill = vi.fn()) {
  render(<FiltersContext.Provider value={{ filters, dbRev: 3, setFilters: vi.fn(), bumpRev: vi.fn(), seasons: [] }}><TargetsCard onDrill={onDrill} /></FiltersContext.Provider>);
  return onDrill;
}

beforeEach(() => {
  harness.paths = []; harness.targets = targets(); harness.masterMissing = false; harness.pulse = null;
  harness.prefs = { leagueOverride: null, targetLeague: null, targetMmr: null };
  harness.apiCall.mockReset(); harness.prefsMutate.mockReset();
});
afterEach(cleanup);

describe("Targets card", () => {
  it("frames each median against the league and the next league, and drills into the games below target", () => {
    const onDrill = renderCard();
    expect(screen.getByText("Diamond PvZ, from your latest replay MMR (4,120 MMR)")).toBeTruthy();
    expect(screen.getByText("Diamond PvZ p36 → Master median needs +14 SQ")).toBeTruthy();
    expect(screen.getByText("Diamond PvZ p53 · Master median 10:40")).toBeTruthy();
    expect(screen.getByText("12 s later than the Master median")).toBeTruthy();
    // Master has a timing table, but its first-upgrade cohort is under the floor.
    expect(screen.getByText("10 s later than the Diamond median")).toBeTruthy();
    expect(screen.getByText("Not enough Master PvZ games yet")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Games below target" })[0]);
    expect(onDrill).toHaveBeenCalledWith(expect.objectContaining({
      params: { race: "P", opp_race: "Z", map_pool: "ladder", game_size: "1v1", sq_max: 82 },
    }));
    // Game length is a profile: no "below target" drill.
    expect(screen.getAllByRole("button", { name: "Games below target" })).toHaveLength(3);
    // The personal side refetches on games:changed through the dbRev fragment.
    expect(harness.paths).toContain("/v1/benchmarks/targets#3");
  });

  it("keeps your absolute values when the next league is under the floor", () => {
    harness.masterMissing = true;
    renderCard();
    expect(screen.getAllByText("Not enough Master PvZ games yet").length).toBeGreaterThan(0);
    expect(screen.getByText("Yours 68.0")).toBeTruthy();
    expect(screen.getByText("Diamond PvZ p36 · median 75.0")).toBeTruthy();
  });

  it("asks for a league without MMR, and saves the choice", async () => {
    harness.targets = targets({ mmr: { current: null, at: null, region: null, ladderRace: "P" } });
    harness.apiCall.mockResolvedValue({ leagueOverride: 5, targetLeague: null, targetMmr: null });
    renderCard();
    expect(screen.getByRole("status").textContent).toMatch(/No MMR yet/);
    expect(harness.paths).toContain("/v1/me/mmr?race=P");
    await act(async () => { fireEvent.change(screen.getByLabelText("Compare with"), { target: { value: "5" } }); });
    expect(harness.apiCall).toHaveBeenCalledWith(expect.any(Function), "/v1/me/preferences/leagueTargets",
      { method: "PUT", body: JSON.stringify({ leagueOverride: 5, targetLeague: null, targetMmr: null }) });
    expect(harness.prefsMutate).toHaveBeenCalledWith({ leagueOverride: 5, targetLeague: null, targetMmr: null }, { revalidate: false });
  });

  it("uses a matching Random-ladder Pulse rating for a concrete matchup", () => {
    harness.targets = targets({ mmr: { current: null, at: null, region: null, ladderRace: "R" } });
    harness.pulse = { race: "R", mmr: 4120 };
    renderCard();
    expect(harness.paths).toContain("/v1/me/mmr?race=R");
    expect(screen.getByText("Diamond PvZ, from SC2Pulse (Random ladder, 4,120 MMR)")).toBeTruthy();
  });

  it("does not place a matchup in a league from a different ladder's Pulse response", () => {
    harness.targets = targets({ mmr: { current: null, at: null, region: null, ladderRace: "R" } });
    harness.pulse = { race: "P", mmr: 6200 };
    renderCard();
    expect(screen.getByRole("status").textContent).toMatch(/No MMR yet/);
    expect(harness.paths.some((path) => path.startsWith("/v1/benchmarks?leagueId="))).toBe(false);
  });

  it("follows the filter bar's matchup", () => {
    renderCard({ race: "P", opp_race: "Z" });
    expect(harness.paths).toContain("/v1/benchmarks/targets?matchup=PvZ#3");
    expect(screen.getByText(/from your filters/)).toBeTruthy();
    expect(screen.queryByLabelText("Matchup")).toBeNull();
  });

  it("estimates the season goal with plain arithmetic", () => {
    harness.prefs = { leagueOverride: null, targetLeague: null, targetMmr: 4600 };
    renderCard();
    expect(screen.getByText("Estimate")).toBeTruthy();
    expect(screen.getByText("480")).toBeTruthy();
    expect(screen.getByText(/About 96 games at that pace: roughly 24 a week/)).toBeTruthy();
  });
});
