import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityCalendarChart } from "../ActivityCalendarChart";
import { TimeOfDayHeatmap } from "../TimeOfDayHeatmap";
import { TrendsDataProvider } from "@/lib/trendsDataContext";

const useApiMock = vi.fn();
const useFiltersMock = vi.fn();
vi.mock("@/lib/clientApi", () => ({ useApi: (...args: unknown[]) => useApiMock(...args) }));
vi.mock("@/lib/filterContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/filterContext")>();
  return { ...actual, useFilters: () => useFiltersMock() };
});
vi.mock("@/lib/timeseries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/timeseries")>();
  return { ...actual, clientTimezone: () => "UTC" };
});

beforeEach(() => {
  useFiltersMock.mockReturnValue({ filters: {}, dbRev: 2 });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-18T12:00:00Z"));
});
afterEach(() => { cleanup(); useApiMock.mockReset(); useFiltersMock.mockReset(); vi.useRealTimers(); });

function activity(day: string, wins: number, losses: number, total = wins + losses) {
  return { day, wins, losses, total, winRate: total ? wins / total : 0 };
}
function heatCell(dow: number, hour: number, wins: number, losses: number, total = wins + losses) {
  return { dow, hour, wins, losses, total, winRate: total ? wins / total : 0 };
}

describe("time-of-day grid", () => {
  beforeEach(() => {
    useApiMock.mockReturnValue({ isLoading: false, data: { timezone: "UTC", totalGames: 26, cells: [
      heatCell(0, 0, 1, 0), heatCell(1, 8, 4, 1), heatCell(1, 10, 10, 10),
    ] } });
  });
  it("starts with volume and aggregates counts across the four-hour block", () => {
    render(<TimeOfDayHeatmap />);
    expect(screen.getByRole("button", { name: "Games played" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /Tue .*25 games, 14 wins, 11 losses/ }).textContent).toBe("25");
    expect(screen.getByRole("status").textContent).toContain("14W · 11L · 56.0% win rate");
  });
  it("withholds low-sample cell colors and percentages but exposes raw results on tap", () => {
    render(<TimeOfDayHeatmap />);
    fireEvent.click(screen.getByRole("button", { name: "Win rate" }));
    const sparse = screen.getByRole("button", { name: /Mon .*1 games, 1 wins, 0 losses/ });
    expect(sparse.textContent).toContain("—");
    expect(sparse.textContent).not.toContain("100%");
    expect(sparse.className).not.toContain("bg-accent-cyan");
    expect(screen.getByRole("button", { name: /Tue .*25 games, 14 wins, 11 losses/ }).textContent).toContain("56%");
    fireEvent.click(sparse);
    expect(screen.getByRole("status").textContent).toContain("100.0% win rate · Small sample");
  });
  it("supports arrow navigation with one grid tab stop and readable empty cells", () => {
    render(<TimeOfDayHeatmap />);
    const selected = screen.getByRole("button", { name: /Tue .*25 games/ });
    fireEvent.keyDown(selected, { key: "ArrowRight" });
    expect(screen.getByRole("status").textContent).toContain("No selected games in this time block");
    const buttons = within(screen.getByRole("table")).getAllByRole("button");
    expect(buttons.filter((button) => button.tabIndex === 0)).toHaveLength(1);
  });
  it("preserves unknown outcomes and labels combined player records in global mode", () => {
    useApiMock.mockReturnValue({ isLoading: false, data: { timezone: "UTC", totalGames: 20, cells: [heatCell(0, 0, 9, 1, 20)] } });
    render(<TrendsDataProvider mode="global"><TimeOfDayHeatmap /></TrendsDataProvider>);
    expect(screen.getByRole("status").textContent).toContain("20 player game records");
    expect(screen.getByRole("status").textContent).toContain("9W · 1L · 10 other · 45.0%");
  });
});

describe("activity calendar", () => {
  it("preserves date-only filter boundaries west of UTC", () => {
    useFiltersMock.mockReturnValue({ filters: { since: "2026-07-20", until: "2026-09-18" }, dbRev: 2 });
    useApiMock.mockReturnValue({ isLoading: false, data: { timezone: "America/New_York", days: [
      activity("2026-07-20T04:00:00Z", 1, 0), activity("2026-09-18T04:00:00Z", 0, 1),
    ] } });
    render(<ActivityCalendarChart />);
    const buttons = screen.getAllByRole("button");
    expect(buttons[0].getAttribute("aria-label")).toContain("2026-07-20");
    expect(buttons[buttons.length - 1].getAttribute("aria-label")).toContain("2026-09-18");
    expect(screen.getByText("2 games shown")).toBeTruthy();
  });

  it("anchors historical filters to their end and counts only days actually shown", () => {
    useFiltersMock.mockReturnValue({ filters: { since: "2026-01-08T00:00:00Z", until: "2026-01-10T23:59:59Z" }, dbRev: 2 });
    useApiMock.mockReturnValue({ isLoading: false, data: { timezone: "UTC", days: [
      activity("2026-01-07T00:00:00Z", 10, 0), activity("2026-01-08T00:00:00Z", 2, 1), activity("2026-01-10T00:00:00Z", 0, 2),
    ] } });
    render(<ActivityCalendarChart />);
    expect(screen.getByText("5 games shown")).toBeTruthy();
    expect(screen.getByText("2 active days / 3 shown")).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /2026-01-07/ })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Jan 10, 2026");
  });
  it("encodes equal activity identically regardless of wins or losses", () => {
    useFiltersMock.mockReturnValue({ filters: { since: "2026-09-17", until: "2026-09-18T23:59:59Z" }, dbRev: 2 });
    useApiMock.mockReturnValue({ isLoading: false, data: { timezone: "UTC", days: [
      activity("2026-09-17", 1, 0), activity("2026-09-18", 0, 1),
    ] } });
    render(<ActivityCalendarChart />);
    const winDay = screen.getByRole("button", { name: /2026-09-17/ });
    const lossDay = screen.getByRole("button", { name: /2026-09-18/ });
    expect(winDay.className).toContain("bg-accent/20");
    expect(lossDay.className).toContain("bg-accent/20");
    fireEvent.click(winDay);
    expect(screen.getByRole("status").textContent).toContain("1W · 0L");
    fireEvent.keyDown(winDay, { key: "ArrowDown" });
    expect(screen.getByRole("status").textContent).toContain("0W · 1L");
  });
  it("reports only the visible window rather than all older fetched games", () => {
    useApiMock.mockReturnValue({ isLoading: false, data: { timezone: "UTC", days: [
      activity("2025-01-01", 100, 0), activity("2026-09-18", 2, 1, 4),
    ] } });
    render(<ActivityCalendarChart weeks={2} />);
    expect(screen.getByText("4 games shown")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("2W · 1L · 1 other");
    expect(screen.getAllByRole("button")).toHaveLength(12);
    expect(screen.queryByRole("button", { name: /2026-09-19/ })).toBeNull();
  });
  it("keeps every local calendar day exactly once through a DST clock change", () => {
    vi.setSystemTime(new Date("2026-11-09T12:00:00Z"));
    useFiltersMock.mockReturnValue({ filters: { since: "2026-10-30T04:00:00Z", until: "2026-11-03T04:59:59Z" }, dbRev: 2 });
    useApiMock.mockReturnValue({ isLoading: false, data: { timezone: "America/New_York", days: [
      activity("2026-11-01T04:00:00Z", 1, 0), activity("2026-11-02T05:00:00Z", 0, 1),
    ] } });
    render(<ActivityCalendarChart />);
    const dates = screen.getAllByRole("button").map((button) => button.getAttribute("aria-label")!.slice(0, 10));
    expect(dates).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(screen.getByText("2 games shown")).toBeTruthy();
  });
});
