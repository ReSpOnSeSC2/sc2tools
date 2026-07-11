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

describe("LadderMetaReport", () => {
  it("shows the headline sample size and league/matchup", () => {
    render(<LadderMetaReport row={ROW} />);
    expect(screen.getByText("67")).toBeTruthy();
    // "Diamond" and "PvZ" appear in the intro line (and elsewhere).
    expect(screen.getAllByText("Diamond").length).toBeGreaterThan(0);
    expect(screen.getAllByText("PvZ").length).toBeGreaterThan(0);
  });

  it("lists top openers with matchup prefix stripped, ranked", () => {
    render(<LadderMetaReport row={ROW} />);
    // Rendered in both the table and the mobile cards.
    expect(screen.getAllByText("Gateway Expand").length).toBeGreaterThan(0);
    expect(screen.getAllByText("4 Gate").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Cannon Rush").length).toBeGreaterThan(0);
  });

  it("renders win rates as percentages", () => {
    render(<LadderMetaReport row={ROW} />);
    expect(screen.getAllByText("70%").length).toBeGreaterThan(0);
    expect(screen.getAllByText("40%").length).toBeGreaterThan(0);
    expect(screen.getAllByText("50%").length).toBeGreaterThan(0);
  });

  it("shows week-over-week movement: up, down, and new", () => {
    render(<LadderMetaReport row={ROW} />);
    // +0.05 winrate delta -> +5 pts; -0.03 -> -3 pts.
    expect(screen.getAllByText(/\+5 pts/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/-3 pts/).length).toBeGreaterThan(0);
    // The newly-surfaced opener gets a "New" badge instead of an arrow.
    expect(screen.getAllByText("New").length).toBeGreaterThan(0);
  });

  it("exposes an accessible summary on the chart", () => {
    render(<LadderMetaReport row={ROW} />);
    const img = screen.getByRole("img", { name: /Top openers for Diamond PvZ/ });
    expect(img.getAttribute("aria-label")).toContain("Gateway Expand");
  });

  it("shows a threshold message when no opener qualifies", () => {
    render(<LadderMetaReport row={{ ...ROW, openers: [] }} />);
    expect(
      screen.getByText(/no single opener has cleared the reporting threshold/i),
    ).toBeTruthy();
  });
});
