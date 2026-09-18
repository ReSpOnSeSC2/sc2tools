import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetMmrByMatchupChart } from "../NetMmrByMatchupChart";

vi.mock("@/lib/trendsDataContext", () => ({
  useTrendsDataScope: () => ({ isGlobal: false }),
  useTrendsApi: () => ({ isLoading: false, data: {
    matchups: [
      { matchup: "PvP", netMmr: -79, avgDelta: -0.7, pairs: 108, winRate: 0.593 },
      { matchup: "PvZ", netMmr: 0, avgDelta: 0, pairs: 20, winRate: 0.5 },
      { matchup: "TvZ", netMmr: -137, avgDelta: -137, pairs: 1, winRate: 0 },
    ],
    coverage: [{ matchup: "PvT", totalGames: 1, measuredGames: 0, dropped: { terminalGame: 1 } }],
  } }),
}));
vi.mock("@/lib/filterContext", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/filterContext")>(),
  useFilters: () => ({ filters: {}, dbRev: 1 }),
}));
vi.mock("../NetMmrRaceOpponentsModal", () => ({ NetMmrRaceOpponentsModal: () => null }));

// Exercise actual SVG geometry: checking a mocked Bar's dataKey cannot catch
// unreadable subpixel averages or disagreement with the summary cards.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 350, height: 260, x: 0, y: 0, top: 0, left: 0, right: 350, bottom: 260, toJSON: () => ({}) });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Net MMR metric rendering", () => {
  it("keeps tiny per-game values legible beside an extreme and switches cards back with the chart", () => {
    const { container } = render(<NetMmrByMatchupChart />);
    const labels = () => [...container.querySelectorAll(".recharts-yAxis")].at(-1)?.textContent;
    const pvpWidth = () => Math.abs(Number(container.querySelector(".recharts-bar-rectangle path")?.getAttribute("width")));
    const pvp = screen.getByRole("button", { name: "View PvP MMR impact by opponent" });
    const totalWidth = pvpWidth();
    expect(labels()).toContain("-79");

    fireEvent.click(screen.getByRole("button", { name: "Per game" }));
    expect(pvpWidth()).toBeLessThan(1);
    expect(labels()).toBe("-0.70.0—-137.0");
    expect(within(pvp).getByText("-0.7").textContent).toBe("-0.7MMR/game");
    expect(within(pvp).getByText(/108 measured games.*-79 MMR total/)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("TvZ sets the scale at -137.0 MMR/game from 1 measured game");
    expect(screen.getByRole("status").textContent).toContain("Small sample");
    expect(container.querySelector(".recharts-yAxis")?.textContent).toContain("108 measured");
    const missing = screen.getByRole("button", { name: "PvT: no measured MMR changes" });
    expect(missing.hasAttribute("disabled")).toBe(true);
    expect(within(missing).getByText("—").textContent).toBe("—MMR/game");

    fireEvent.click(screen.getByRole("button", { name: "Total MMR" }));
    expect(pvpWidth()).toBe(totalWidth);
    expect(labels()).toBe("-790—-137");
    expect(within(pvp).getByText("-79").textContent).toBe("-79MMR");
    expect(screen.queryByRole("status")).toBeNull();
  });
});
