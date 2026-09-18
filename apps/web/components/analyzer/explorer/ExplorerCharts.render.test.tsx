import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ExplorerResponse } from "@/lib/trendsExplorer";
import { ExplorerVisualization } from "./ExplorerCharts";

// Use real Recharts components. A mocked chart shell cannot detect series
// being silently ignored when they are not direct chart children.
const fixture: ExplorerResponse = {
  view: "rematches", totalGames: 487, eligibleGames: 487, notes: [], options: {},
  rows: [
    { key: "first", label: "First meeting", games: 150, wins: 85, losses: 65, decided: 150, winRate: 85 / 150, players: 1 },
    { key: "second", label: "Second meeting", games: 100, wins: 60, losses: 40, decided: 100, winRate: 0.6, players: 1 },
    { key: "third", label: "Third meeting", games: 80, wins: 48, losses: 32, decided: 80, winRate: 0.6, players: 1 },
    { key: "fourth-plus", label: "Fourth meeting onward", games: 157, wins: 96, losses: 61, decided: 157, winRate: 96 / 157, players: 1 },
  ],
};

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 720, height: 320, x: 0, y: 0, top: 0, left: 0, right: 720, bottom: 320, toJSON: () => ({}) });
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("human-readable explorer comparisons", () => {
  it.each(["mmr-gap", "leads", "breaks", "rematches", "periods", "groups"] as const)("shows exact records beside each independent %s comparison", (view) => {
    const onSelect = vi.fn();
    const { container } = render(<ExplorerVisualization view={view} data={{ ...fixture, view }} display="chart" onSelect={onSelect} weighted={false} />);
    const list = screen.getByRole("list", { name: "Outcome comparison by group" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    expect(within(list).getByText("56.7%")).toBeTruthy();
    expect(within(list).getByText("150 games · 85W · 65L")).toBeTruthy();
    expect(within(list).getByText("Fourth meeting onward")).toBeTruthy();
    expect(container.querySelector(".recharts-line-curve")).toBeNull();
    fireEvent.click(within(list).getByRole("button", { name: "View games for First meeting" }), { detail: 0 });
    expect(onSelect).toHaveBeenCalledWith(fixture.rows[0]);
  });

  it("retains player-weighted rates, flags few decided results, and reconciles other outcomes", () => {
    const rows = [{ key: "one", label: "Small group", games: 22, wins: 8, losses: 2, decided: 10, winRate: 0.625, players: 2 }];
    render(<ExplorerVisualization view="groups" data={{ ...fixture, rows }} display="chart" onSelect={vi.fn()} weighted />);
    const list = screen.getByRole("list", { name: "Outcome comparison by group" });
    expect(within(list).getByText("62.5%")).toBeTruthy();
    expect(within(list).getByText(/22 games · 8W · 2L · 12 other/)).toBeTruthy();
    expect(within(list).getByText(/Small sample/)).toBeTruthy();
    expect(screen.getByText(/Each player with decided games has equal weight/)).toBeTruthy();
  });

  it("does not turn an empty group into a zero-percent result or clickable game link", () => {
    const rows = [{ key: "empty", label: "Empty group", games: 0, wins: 0, losses: 0, decided: 0, winRate: null, players: 0 }];
    render(<ExplorerVisualization view="leads" data={{ ...fixture, rows }} display="chart" onSelect={vi.fn()} weighted={false} />);
    const list = screen.getByRole("list", { name: "Outcome comparison by group" });
    expect(within(list).getByText("—")).toBeTruthy();
    expect(within(list).getByText("No games")).toBeTruthy();
    expect(within(list).queryByRole("button")).toBeNull();
  });

  it("keeps median timing and the observed middle-half band for execution", () => {
    const rows = fixture.rows.slice(0, 2).map((row, i) => ({ ...row, label: `2026-09-0${i + 1}`, medianSec: 300 + i * 10, p25Sec: 280, p75Sec: 340 }));
    const { container } = render(<ExplorerVisualization view="execution" data={{ ...fixture, rows }} display="chart" onSelect={vi.fn()} weighted={false} />);
    expect(container.querySelector(".recharts-line-curve")?.getAttribute("d")).toMatch(/^M/);
    expect(container.querySelector(".recharts-area-area")?.getAttribute("d")).toMatch(/^M/);
    expect(screen.getByText(/Only games that reached this milestone contribute/)).toBeTruthy();
  });

  it("preserves gaps in calendar time and labels player-weighted timing distributions", () => {
    const rows = ["2026-09-01", "2026-09-02", "2026-09-30"].map((date, i) => ({ ...fixture.rows[i], key: date, label: date, medianSec: 300 + i * 10, p25Sec: 280, p75Sec: 340 }));
    const { container } = render(<ExplorerVisualization view="execution" data={{ ...fixture, rows }} display="chart" onSelect={vi.fn()} weighted />);
    const x = [...container.querySelectorAll(".recharts-line-dot")].map((dot) => Number(dot.getAttribute("cx")));
    expect(x).toHaveLength(3);
    expect(x[2] - x[1]).toBeGreaterThan(20 * (x[1] - x[0]));
    expect(screen.getByText(/Each player has equal weight in the timing distribution/)).toBeTruthy();
    expect(screen.getByText(/player-weighted median/)).toBeTruthy();
  });
});
