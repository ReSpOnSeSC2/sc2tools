import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { GameLengthWrChart } from "../GameLengthWrChart";
import { MomentumChart } from "../MomentumChart";

const useApiMock = vi.fn();
vi.mock("@/lib/clientApi", () => ({ useApi: (...args: unknown[]) => useApiMock(...args) }));
vi.mock("@/lib/filterContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/filterContext")>();
  return { ...actual, useFilters: () => ({ filters: { race: "P", min_minutes: 3 }, dbRev: 4 }) };
});

beforeEach(() => useApiMock.mockReset());
afterEach(cleanup);

describe("duration comparisons", () => {
  it("keeps duration order, distinguishes empty buckets, and weights its baseline by games", () => {
    useApiMock.mockReturnValue({ isLoading: false, data: { buckets: [
      { bucket: "25m+", wins: 1, losses: 0, total: 1, winRate: 1 },
      { bucket: "3–6m", wins: 8, losses: 6, total: 19, winRate: 8 / 19 },
    ] } });
    render(<GameLengthWrChart />);
    const list = screen.getByRole("list", { name: "Win rate by recorded game duration" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(8);
    expect(within(items[0]).getByText("0–3m")).toBeTruthy();
    expect(within(items[0]).getByText("—")).toBeTruthy();
    expect(within(items[1]).getByText("42%")).toBeTruthy();
    expect(within(items[1]).getByText("19 games · 8W · 6L · 5 other")).toBeTruthy();
    expect(within(items[7]).getByText("25m+")).toBeTruthy();
    expect(within(items[7]).getByText("100%")).toBeTruthy();
    expect(within(items[7]).getByText("Small sample")).toBeTruthy();
    expect(screen.getByText("All lengths 45%")).toBeTruthy();
    expect(screen.getByText(/Other records have no win\/loss result/)).toBeTruthy();
    expect(useApiMock.mock.calls[0][0]).toBe("/v1/length-buckets?race=P&min_minutes=3#4");
  });
});

describe("session comparisons", () => {
  it("reports small samples as observations without diagnosing a player's psychology", () => {
    useApiMock.mockReturnValue({ isLoading: false, data: {
      sessionGapMinutes: 90,
      baseline: { total: 10, wins: 5, losses: 5, winRate: 0.5 },
      postWin: { total: 5, wins: 5, losses: 0, winRate: 1 },
      postLoss: { total: 5, wins: 0, losses: 5, winRate: 0 },
      sessionPositions: [
        { pos: 7, total: 1, wins: 1, losses: 0, winRate: 1 },
        { pos: 2, total: 1, wins: 0, losses: 1, winRate: 0 },
        { pos: 1, total: 10, wins: 5, losses: 5, winRate: 0.5 },
      ],
    } });
    const { container } = render(<MomentumChart />);
    expect(screen.getByText("Session patterns")).toBeTruthy();
    expect(screen.getByText(/Sessions split on a 90-min gap/)).toBeTruthy();
    const after = within(screen.getByRole("list", { name: "Win rate after the previous result" }));
    expect(after.getAllByText("Small sample")).toHaveLength(2);
    expect(after.getByText("5 games · 5W · 0L")).toBeTruthy();
    expect(after.getByText("5 games · 0W · 5L")).toBeTruthy();
    expect(screen.queryByText("Tilt signal:")).toBeNull();
    expect(screen.queryByText("Cool-headed:")).toBeNull();
    expect(screen.getByText(/does not establish tilt/)).toBeTruthy();
    const positions = within(screen.getByRole("list", { name: "Win rate by game number in session" })).getAllByRole("listitem");
    expect(within(positions[0]).getByText("Game 1")).toBeTruthy();
    expect(within(positions[1]).getByText("0%")).toBeTruthy();
    expect(within(positions[1]).getByText("1 game · 0W · 1L")).toBeTruthy();
    const later = container.querySelector("details");
    expect(later?.open).toBe(false);
    expect(later?.querySelector("summary")?.textContent).toBe("Later session game (7)");
    expect(later?.textContent).toContain("1 game · 1W · 0L");
    expect(screen.getByText(/Later positions include only sessions that continued that far/)).toBeTruthy();
  });
});
