import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
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

describe("actual Recharts series rendering", () => {
  it.each(["mmr-gap", "leads", "breaks", "rematches"] as const)("renders real game-count bars and a win-rate line for %s", async (view) => {
    const { container } = render(<ExplorerVisualization view={view} data={{ ...fixture, view }} display="chart" onSelect={vi.fn()} weighted={false} />);
    await waitFor(() => {
      expect(container.querySelectorAll(".recharts-bar-rectangle path")).toHaveLength(4);
      expect(container.querySelector(".recharts-line-curve")?.getAttribute("d")).toMatch(/^M/);
      expect(container.querySelectorAll(".recharts-line-dot")).toHaveLength(4);
    });
  });
});
