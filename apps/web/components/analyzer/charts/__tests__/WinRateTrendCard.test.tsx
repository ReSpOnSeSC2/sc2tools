import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WinRateTrendCard } from "../WinRateTrendCard";
import { FiltersContext, type FiltersValue } from "@/lib/filterContext";
import { TrendsDataProvider } from "@/lib/trendsDataContext";
import type { ApiTimeseriesResponse } from "@/lib/timeseries";

const useApiMock = vi.fn();
vi.mock("@/lib/clientApi", () => ({ useApi: (...args: unknown[]) => useApiMock(...args) }));
vi.mock("@/lib/timeseries", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/timeseries")>(),
  clientTimezone: () => "UTC",
}));

const filters = {
  since: "2026-09-01",
  until: "2026-09-18",
  race: "P",
  opp_race: "T",
  map: "Gold Base",
  min_minutes: 6,
  // Even if a caller carries activity grouping in its filters, form requests days.
  interval: "month",
};
const filterValue: FiltersValue = { filters, dbRev: 7, setFilters: vi.fn(), bumpRev: vi.fn(), seasons: [] };
const response = (wins = [0, 10, 20, 30], interval: ApiTimeseriesResponse["interval"] = "day"): ApiTimeseriesResponse => ({
  interval,
  points: wins.map((count, index) => ({ bucket: `2026-09-0${index + 1}T00:00:00.000Z`, wins: count, losses: 30 - count, total: 30, winRate: count / 30 })),
});

function mount(mode: "personal" | "global" = "personal") {
  return render(
    <FiltersContext.Provider value={filterValue}>
      <TrendsDataProvider mode={mode} cohort={{ included_players: ["player-a", "player-b"], player_selection: "include" }}>
        <WinRateTrendCard />
      </TrendsDataProvider>
    </FiltersContext.Provider>,
  );
}

beforeEach(() => {
  useApiMock.mockReturnValue({ data: response(), isLoading: false, mutate: vi.fn() });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 720, height: 320, x: 0, y: 0, top: 0, left: 0, right: 720, bottom: 320, toJSON: () => ({}) });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); useApiMock.mockReset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("WinRateTrendCard", () => {
  it("recalculates recent form through the 30, 60, and 100 game controls", () => {
    mount();
    expect(screen.getByRole("button", { name: "Target at least 30 games" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("100.0%")).toBeTruthy();
    expect(screen.getByText(/30 games · 30W · 0L/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Target at least 60 games" }));
    expect(screen.getByText("83.3%")).toBeTruthy();
    expect(screen.getByText(/60 games · 50W · 10L/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Target at least 30 games" }).getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Target at least 100 games" }), { detail: 0 });
    expect(screen.getByText("50.0%")).toBeTruthy();
    expect(screen.getByText(/120 games · 60W · 60L/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Target at least 100 games" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/Windows can contain more than 100 games/)).toBeTruthy();
  });

  it("removes the trace and explains the shortfall when a larger sample exceeds history", () => {
    useApiMock.mockReturnValue({ data: response([10, 20]), isLoading: false });
    const { container } = mount();
    expect(container.querySelector(".recharts-surface")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Target at least 100 games" }));
    expect(container.querySelector(".recharts-surface")).toBeNull();
    expect(screen.getByText("Building a sample")).toBeTruthy();
    expect(screen.getByText("60 / 100 games")).toBeTruthy();
    expect(screen.getByText(/40 more games in this date range/)).toBeTruthy();
    expect(screen.getByText(/Recorded so far: 30W · 30L · 50.0%/)).toBeTruthy();
    const progress = screen.getByRole("progressbar", { name: "Games toward recent-form sample" });
    expect(progress.getAttribute("aria-valuenow")).toBe("60");
    expect(progress.getAttribute("aria-valuemax")).toBe("100");
  });

  it("keeps unknown outcomes in both the displayed record and the rate denominator", () => {
    useApiMock.mockReturnValue({ data: { interval: "day", points: [{ bucket: "2026-09-01T00:00:00.000Z", wins: 20, losses: 5, total: 30, winRate: 20 / 30 }] }, isLoading: false });
    mount();
    expect(screen.getByText("66.7%")).toBeTruthy();
    expect(screen.getByText(/30 games · 20W · 5L · 5 other/)).toBeTruthy();
    expect(screen.getByText(/Wins are divided by all records in that window/)).toBeTruthy();
    expect(screen.getByText(/Other records have no win\/loss result and remain in the total/)).toBeTruthy();
  });

  it.each(["week", "month"] as const)("explains the effective %s buckets returned by the server", (interval) => {
    useApiMock.mockReturnValue({ data: response([20], interval), isLoading: false });
    mount();
    expect(screen.getByText(new RegExp(`most recent whole ${interval}s`))).toBeTruthy();
    expect(screen.getByText(new RegExp(`This date range uses ${interval === "week" ? "weekly" : "monthly"} records`))).toBeTruthy();
    expect(screen.getByText(`${interval === "week" ? "Weeks" : "Months"} starting Sep 1, 2026 – Sep 1, 2026`)).toBeTruthy();
  });

  it("requests daily data while preserving filters, timezone, and revision", () => {
    mount();
    const path = String(useApiMock.mock.calls[0][0]);
    const url = new URL(path, "https://example.test");
    expect(url.pathname).toBe("/v1/timeseries");
    expect(url.searchParams.get("interval")).toBe("day");
    expect(url.searchParams.get("tz")).toBe("UTC");
    expect(url.searchParams.get("since")).toBe("2026-09-01");
    expect(url.searchParams.get("until")).toBe("2026-09-18");
    expect(url.searchParams.get("race")).toBe("P");
    expect(url.searchParams.get("opp_race")).toBe("T");
    expect(url.searchParams.get("map")).toBe("Gold Base");
    expect(url.searchParams.get("min_minutes")).toBe("6");
    expect(url.hash).toBe("#7");
    fireEvent.click(screen.getByRole("button", { name: "Target at least 60 games" }));
    expect(new Set(useApiMock.mock.calls.map(call => call[0]))).toEqual(new Set([path]));
  });

  it("labels combined-player samples honestly and preserves the selected cohort", () => {
    mount("global");
    expect(screen.getByText(/30 player game records · 30W · 0L/)).toBeTruthy();
    expect(screen.getByText(/they do not represent an individual player's form/)).toBeTruthy();
    expect(screen.getByText(/Game-weighted windows of at least 30 player game records/)).toBeTruthy();
    const url = new URL(String(useApiMock.mock.calls[0][0]), "https://example.test");
    expect(url.pathname).toBe("/v1/admin/global-trends/timeseries");
    expect(url.searchParams.get("included_players")).toBe("player-a,player-b");
    expect(url.searchParams.get("player_selection")).toBe("include");
    expect(url.searchParams.get("interval")).toBe("day");
  });

  it.each(["personal", "global"] as const)("gives useful %s empty-state guidance without drawing a zero-percent chart", (mode) => {
    useApiMock.mockReturnValue({ data: { interval: "day", points: [] }, isLoading: false });
    const { container } = mount(mode);
    expect(screen.getByText(mode === "global" ? "No player game records match these filters" : "No games match these filters")).toBeTruthy();
    expect(container.querySelector(".recharts-surface")).toBeNull();
    expect(screen.queryByText("0.0%")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("exposes loading status and lets the user retry an independent chart failure", async () => {
    useApiMock.mockReturnValue({ isLoading: true });
    const view = mount();
    expect(screen.getByRole("status", { name: "Loading Win rate" })).toBeTruthy();
    view.unmount();
    const mutate = vi.fn().mockResolvedValue(undefined);
    useApiMock.mockReturnValue({ isLoading: false, error: { code: "request_timeout", message: "The API took too long to respond." }, mutate });
    mount();
    expect(screen.getByRole("alert").textContent).toContain("Your filters are still applied.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mutate).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy());
  });
});
