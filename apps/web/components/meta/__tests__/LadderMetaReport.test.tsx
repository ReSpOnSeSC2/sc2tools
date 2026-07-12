import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LadderMetaReport } from "../LadderMetaReport";
import type { MetaRow } from "@/lib/meta";

// recharts' ResponsiveContainer observes its parent unconditionally;
// jsdom has no ResizeObserver.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ||
  ResizeObserverStub;

afterEach(cleanup);

const ROW: MetaRow = {
  era: "after",
  bandType: "league",
  band: 4,
  bandLabel: "Diamond",
  leagueBand: 4,
  league: "Diamond",
  matchup: "PvZ",
  n: 67,
  updatedAt: "2026-07-10T00:00:00.000Z",
  prevUpdatedAt: "2026-07-03T00:00:00.000Z",
  openers: [
    {
      build: "PvZ - Gateway Expand",
      games: 30,
      wins: 21,
      losses: 9,
      winRate: 0.7,
      frequency: 30 / 67,
      winRateDelta: 0.05,
      freqDelta: 0.02,
      isNew: false,
    },
    {
      build: "PvZ - 4 Gate",
      games: 20,
      wins: 8,
      losses: 12,
      winRate: 0.4,
      frequency: 20 / 67,
      winRateDelta: -0.03,
      freqDelta: -0.01,
      isNew: false,
    },
    {
      build: "PvZ - Cannon Rush",
      games: 12,
      wins: 6,
      losses: 6,
      winRate: 0.5,
      frequency: 12 / 67,
      winRateDelta: null,
      freqDelta: null,
      isNew: true,
    },
  ],
};

function renderLeagueReport(row: MetaRow = ROW) {
  return render(<LadderMetaReport row={row} axis="league" band={4} />);
}

describe("LadderMetaReport", () => {
  it("shows the headline sample size and league/matchup", () => {
    renderLeagueReport();
    expect(screen.getByText("67")).toBeTruthy();
    expect(screen.getAllByText(/vs Diamond opponents/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("PvZ").length).toBeGreaterThan(0);
  });

  it("lists top openers with matchup prefix stripped, ranked", () => {
    renderLeagueReport();
    // Rendered in both the table and the mobile cards.
    expect(screen.getAllByText("Gateway Expand").length).toBeGreaterThan(0);
    expect(screen.getAllByText("4 Gate").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Cannon Rush").length).toBeGreaterThan(0);
  });

  it("renders win rates as percentages", () => {
    renderLeagueReport();
    expect(screen.getAllByText("70%").length).toBeGreaterThan(0);
    expect(screen.getAllByText("40%").length).toBeGreaterThan(0);
    expect(screen.getAllByText("50%").length).toBeGreaterThan(0);
  });

  it("shows week-over-week movement: up, down, and new", () => {
    renderLeagueReport();
    // +0.05 winrate delta -> +5 pts; -0.03 -> -3 pts.
    expect(screen.getAllByText(/\+5 pts/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/-3 pts/).length).toBeGreaterThan(0);
    // The newly-surfaced opener gets a "New" badge instead of an arrow.
    expect(screen.getAllByText("New").length).toBeGreaterThan(0);
  });

  it("exposes an accessible summary on the chart", () => {
    renderLeagueReport();
    const img = screen.getByRole("img", {
      name: /Top openers for PvZ vs Diamond opponents/,
    });
    expect(img.getAttribute("aria-label")).toContain("Gateway Expand");
  });

  it("shows a threshold message when no opener qualifies", () => {
    renderLeagueReport({ ...ROW, openers: [] });
    expect(
      screen.getByText(/no single opener has cleared the reporting threshold/i),
    ).toBeTruthy();
  });

  it("labels the win-rate section and MMR context throughout", () => {
    const mmrRow: MetaRow = {
      ...ROW,
      bandType: "mmr",
      band: 4000,
      bandLabel: "4000–4500",
      leagueBand: undefined,
      league: undefined,
    };
    render(<LadderMetaReport row={mmrRow} axis="mmr" band={4000} />);

    expect(
      screen.getByRole("heading", { name: "Win rate by opener" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Share of decided games vs 4000–4500 opponents in this MMR band.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("img", {
        name: /PvZ vs 4000–4500 opponents/,
      }),
    ).toBeTruthy();
    expect(
      screen.getByText((_, element) => {
        const text = element?.textContent ?? "";
        return (
          element?.tagName === "P" &&
          text.includes("real PvZ ladder games") &&
          text.includes("vs 4000–4500 opponents")
        );
      }),
    ).toBeTruthy();
  });
});
