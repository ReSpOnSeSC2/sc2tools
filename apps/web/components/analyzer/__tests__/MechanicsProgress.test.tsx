import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Link from "next/link";
import { FiltersContext, type AnalyzerFilters } from "@/lib/filterContext";
import { MechanicsTrendCard } from "../MechanicsTrendCard";
import { MacroSummaryCard } from "../MacroSummaryCard";
import { MacroTab } from "../MacroTab";
import { MacroTrendChart } from "../charts/MacroTrendChart";

const harness = vi.hoisted(() => ({
  paths: [] as Array<string | null>, apiCall: vi.fn(), mutate: vi.fn(), online: false, empty: false, stale: false,
  leagueMatchup: "PvZ", seriesStale: false, benchmarkN: 50, benchmarkError: null as null | { status: number; message: string },
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: async () => "synthetic" }) }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: () => <Link href="/help/macro#progress">Help</Link> }));
vi.mock("../macro/report/ReportGamesModal", () => ({ ReportGamesModal: () => null }));
vi.mock("@/lib/timeseries", async importOriginal => ({ ...(await importOriginal<typeof import("@/lib/timeseries")>()), clientTimezone: () => "UTC" }));
vi.mock("@/lib/clientApi", () => ({
  apiCall: (...args: unknown[]) => harness.apiCall(...args),
  useApi: (path: string | null) => {
    harness.paths.push(path);
    let data;
    if (path?.startsWith("/v1/timeseries")) data = { interval: path.includes("month") ? "month" : "day", points: [
      { bucket: "2026-01-01T00:00:00Z", total: 20, wins: 10, losses: 10, avgMacroScore: harness.empty ? null : 60, macroN: harness.empty ? 0 : 4, avgApm: 100, apmN: 5, avgSpq: 60, spqN: 3 },
      { bucket: "2026-01-02T00:00:00Z", total: 10, wins: 5, losses: 5, avgMacroScore: harness.empty ? null : 70, macroN: harness.empty ? 0 : 5, avgApm: 150, apmN: 6, avgSpq: null, spqN: 0 },
    ] };
    else if (path?.startsWith("/v1/benchmarks")) data = { table: { leagueId: 4, league: "Diamond", matchup: harness.leagueMatchup, updatedAt: "2026-10-20T00:00:00Z", n: 70, metrics: { macroScore: { n: harness.benchmarkN, deciles: [10,20,30,40,50,60,70,80,90] } } } };
    else if (path === "/v1/me") data = { agentLastSeenAt: harness.online ? new Date().toISOString() : null };
    else if (path?.startsWith("/v1/macro/summary")) data = { gamesTotal: harness.empty ? 0 : 20, gamesWithMacro: 10, gamesMissingMacro: 10, avgScore: 65, leaks: [{ name: "Duplicate leak fixture", count: 2, totalMinerals: 100 }] };
    else if (path?.startsWith("/v1/macro/report")) data = { gamesTotal: 0, gamesScored: 0 };
    else if (path?.startsWith("/v1/macro/backfill/status")) data = { status: "running", done: 1, total: 4 };
    return { data, mutate: harness.mutate, isLoading: false, error: path?.startsWith("/v1/benchmarks") ? harness.benchmarkError : null, isPreviousData: path?.startsWith("/v1/benchmarks") ? harness.stale : path?.startsWith("/v1/timeseries") ? harness.seriesStale : false };
  },
}));

const backfill = { starting: false, running: false, error: null, start: async () => {} };
function scoped(filters: AnalyzerFilters) { return <FiltersContext.Provider value={{ filters: { game_size: "1v1", map_pool: "ladder", ...filters }, dbRev: 1, setFilters: vi.fn(), bumpRev: vi.fn(), seasons: [] }}><MechanicsTrendCard /></FiltersContext.Provider>; }
beforeEach(() => {
  localStorage.clear(); harness.paths = []; harness.online = false; harness.empty = false; harness.stale = false; harness.seriesStale = false; harness.leagueMatchup = "PvZ"; harness.benchmarkN = 50; harness.benchmarkError = null;
  harness.apiCall.mockReset(); harness.apiCall.mockResolvedValue({ jobId: "synthetic-job" }); harness.mutate.mockReset();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("mechanics progress consumers", () => {
  it("measures a narrow plot when switching from initially unmeasured Macro to measured APM", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 280, height: 220, x: 0, y: 0, left: 0, top: 0, right: 280, bottom: 220, toJSON: () => ({}) });
    const series = [{ date: "2026-10-01", games: 6, wins: 3, losses: 3, winRate: .5, avgMacroScore: null, macroN: 0, avgApm: 120, apmN: 6 }];
    const view = render(<MacroTrendChart series={series} metric="macro" />);
    expect(screen.queryByTestId("mechanics-trend-chart")).toBeNull();
    view.rerender(<MacroTrendChart series={series} metric="apm" />);
    await waitFor(() => expect(screen.getByTestId("mechanics-trend-chart").getAttribute("viewBox")).toBe("0 0 280 220"));
  });

  it("switches metrics using one timeseries resource with distinct scored counts and hollow points", () => {
    const view = render(<MechanicsTrendCard />);
    expect(view.container.querySelectorAll('circle[data-hollow="true"]')).toHaveLength(2);
    expect(view.container.querySelector('circle[data-n="4"]')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "APM" }));
    expect(screen.getByRole("img", { name: /APM by calendar/ })).toBeTruthy();
    expect(view.container.querySelectorAll('circle[data-hollow="true"]')).toHaveLength(2);
    expect(screen.getByText("150 · 6 measured games")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Inspect period"), { target: { value: "2026-01-01" } });
    expect(screen.getByText("100 · 5 measured games")).toBeTruthy();
    expect(new Set(harness.paths.filter(path => path?.startsWith("/v1/timeseries"))).size).toBe(1);
    expect(harness.paths.some(path => path?.startsWith("/v1/benchmarks"))).toBe(false);
  });

  it("shares the stored bucket with Trends and rejects an invalid preference", async () => {
    localStorage.setItem("analyzer.trends.bucket", JSON.stringify("month"));
    const view = render(<MechanicsTrendCard />);
    await waitFor(() => expect((screen.getByLabelText("Mechanics period") as HTMLSelectElement).value).toBe("month"));
    fireEvent.change(screen.getByLabelText("Mechanics period"), { target: { value: "day" } });
    expect(localStorage.getItem("analyzer.trends.bucket")).toBe('"day"');
    view.unmount(); localStorage.setItem("analyzer.trends.bucket", JSON.stringify("bad"));
    render(<MechanicsTrendCard />);
    expect((screen.getByLabelText("Mechanics period") as HTMLSelectElement).value).toBe("week");
  });

  it("shows a measured matching league median only after explicit selection", () => {
    const view = render(scoped({ race: "P", opp_race: "Z" }));
    expect(screen.queryByTestId("mechanics-reference")).toBeNull();
    fireEvent.change(screen.getByLabelText("Opponent league reference"), { target: { value: "4" } });
    expect(screen.getByTestId("mechanics-reference")).toBeTruthy();
    expect(screen.getByText(/Diamond opponent bracket · PvZ median · n=50/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "APM" }));
    expect(screen.queryByTestId("mechanics-reference")).toBeNull();
    harness.benchmarkN = 49; fireEvent.click(screen.getByRole("button", { name: "Macro score" }));
    expect(screen.queryByTestId("mechanics-reference")).toBeNull();
    harness.benchmarkN = 50;
    harness.benchmarkError = { status: 404, message: "Band unavailable" }; view.rerender(scoped({ race: "P", opp_race: "Z" }));
    expect(screen.queryByTestId("mechanics-reference")).toBeNull();
    harness.benchmarkError = null;
    harness.leagueMatchup = "PvT"; view.rerender(scoped({ race: "P", opp_race: "Z" }));
    expect(screen.queryByTestId("mechanics-reference")).toBeNull();
    harness.leagueMatchup = "PvZ"; harness.stale = true; view.rerender(scoped({ race: "P", opp_race: "Z" }));
    expect(screen.queryByTestId("mechanics-reference")).toBeNull();
    harness.stale = false; harness.seriesStale = true; view.rerender(scoped({ race: "P", opp_race: "Z" }));
    expect(screen.queryByTestId("mechanics-reference")).toBeNull();
    expect(screen.getByText(/showing the previous periods/)).toBeTruthy();
    harness.seriesStale = false;
    harness.stale = false; view.rerender(scoped({ race: "P", opp_race: "Z", game_size: "team" }));
    expect(screen.queryByTestId("mechanics-reference")).toBeNull();
    expect((screen.getByLabelText("Opponent league reference") as HTMLSelectElement).disabled).toBe(true);
  });

  it("keeps score and coverage without duplicating the leak ledger", () => {
    render(<MacroSummaryCard backfill={backfill} />);
    expect(screen.getByText("65")).toBeTruthy();
    expect(screen.getByText("10 of 20 games scored (50%)")).toBeTruthy();
    expect(screen.queryByText("Duplicate leak fixture")).toBeNull();
  });

  it("offers the real backfill action online and still exposes APM when macro scores are absent", async () => {
    harness.empty = true; harness.online = true;
    render(<MacroTab />);
    expect(screen.getByText("No macro scores yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "APM" }));
    expect(screen.getByRole("img", { name: /APM by calendar/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Score my older games" }));
    await waitFor(() => expect(harness.apiCall).toHaveBeenCalledTimes(1));
    expect(harness.apiCall.mock.calls[0][1]).toBe("/v1/macro/backfill/start");
    expect((await screen.findByRole("status")).textContent).toContain("Scoring older games: 1/4");
  });

  it("offers desktop setup offline without inventing a missing backfill control above", () => {
    harness.empty = true;
    render(<MacroTab />);
    expect(screen.getByRole("link", { name: "Get the desktop app" }).getAttribute("href")).toBe("/download");
    expect(screen.queryByRole("button", { name: "Score my older games" })).toBeNull();
    expect(screen.queryByText(/backfill above/i)).toBeNull();
  });
});
