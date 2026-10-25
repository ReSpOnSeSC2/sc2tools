import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MatchupRatingSeries } from "@/lib/strengthAdjusted";
const state = vi.hoisted(() => ({ rows: [] as unknown[], previous: false, error: null as Error | null, paths: [] as string[] }));
vi.mock("@/lib/filterContext", async importOriginal => ({ ...(await importOriginal<typeof import("@/lib/filterContext")>()), useFilters: () => ({ filters: { race: "P", map: "Arena" }, dbRev: 7 }) }));
vi.mock("@/lib/trendsDataContext", () => ({ useTrendsDataScope: () => ({ isGlobal: false }), useTrendsApi: (path: string) => { state.paths.push(path); return { data: { ratingSeries: state.rows }, isLoading: false, isPreviousData: state.previous, error: state.error, mutate: vi.fn() }; } }));
import { MatchupRatingCard } from "../MatchupRatingCard";
const fixture = (): MatchupRatingSeries => ({ matchup: "PvZ", totalGames: 75, sampleGames: 3, windowGames: 10, ratedGames: 2, excludedNoMmr: 1, perfRating: 4100, points: [{ date: "2026-10-01", perfRating: null, games: 1, ratedGames: 1, excludedNoMmr: 0 }, { date: "2026-10-02", perfRating: 4100, games: 2, ratedGames: 2, excludedNoMmr: 0 }, { date: "2026-10-03", perfRating: null, games: 3, ratedGames: 2, excludedNoMmr: 1 }] });
beforeEach(() => { state.rows = [fixture()]; state.previous = false; state.error = null; state.paths = []; });
afterEach(cleanup);

describe("Matchup rating bounded consumer", () => {
  it("uses the existing grouped-matchup resource and exposes measured coverage/window inspection", () => {
    render(<MatchupRatingCard />);
    const url = new URL(state.paths[0], "https://example.test"); expect(url.pathname).toBe("/v1/timeseries/matchups");
    expect(url.searchParams.get("group_by")).toBe("matchup"); expect(url.searchParams.get("interval")).toBe("day"); expect(url.searchParams.get("race")).toBe("P"); expect(url.searchParams.get("map")).toBe("Arena"); expect(url.hash).toBe("#7");
    const panel = screen.getByRole("region", { name: "PvZ performance rating" });
    expect(within(panel).getByText(/2\/3 paired replay ratings · 1 missing · thin sample/)).toBeTruthy();
    expect(panel.querySelectorAll("circle")).toHaveLength(1); expect(screen.getByText(/No finite rating · 2\/3 rated · 1 missing/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("PvZ rating window"), { target: { value: "1" } }); expect(screen.getByText(/4,100 performance rating · 2\/2 rated/)).toBeTruthy();
  });
  it("does not present a previous cohort's rating while filters are refreshing", () => {
    state.previous = true; render(<MatchupRatingCard />); expect(screen.queryByRole("region", { name: "PvZ performance rating" })).toBeNull();
  });
  it("leaves wholly unbounded windows as an explicit empty line, and filters unknown race pairs", () => {
    state.rows = [{ ...fixture(), perfRating: null, points: fixture().points.map(point => ({ ...point, perfRating: null })) }, { ...fixture(), matchup: "UvZ" }];
    render(<MatchupRatingCard />); expect(screen.getByText(/No finite window estimate yet/)).toBeTruthy(); expect(screen.queryByRole("region", { name: "UvZ performance rating" })).toBeNull();
  });
  it("shows recovery and no-data states without inventing zero ratings", () => {
    state.rows = []; const view = render(<MatchupRatingCard />); expect(screen.getByText("No eligible matchup games")).toBeTruthy();
    state.error = new Error("Unavailable"); view.rerender(<MatchupRatingCard />); expect(screen.getByRole("button", { name: /Retry/ })).toBeTruthy();
  });
});
