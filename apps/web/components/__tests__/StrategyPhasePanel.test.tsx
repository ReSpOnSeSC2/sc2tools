import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// ---------------------------------------------------------------------
// Test seam: ``useApi`` (data) + ``useFilters`` (dbRev for cache key).
// Both are global hooks the panel reaches for; mocks let each test
// drive the fetch state directly without spinning up SWR.
// ---------------------------------------------------------------------

const useApiMock = vi.fn();

vi.mock("@/lib/clientApi", () => ({
  useApi: (path: string | null) => useApiMock(path),
}));

vi.mock("@/lib/filterContext", () => ({
  useFilters: () => ({ filters: {}, dbRev: "rev1" }),
}));

import { StrategyPhasePanel } from "../analyzer/StrategyPhasePanel";

afterEach(() => {
  cleanup();
  useApiMock.mockReset();
});

function payload(total: number) {
  return {
    name: "Zerg - Mass Ling",
    total,
    sampleSize: { early: total, earlyMid: total, mid: total, midLate: 0, late: 0 },
    perPhase: {
      early: { signatures: [], tech: [], upgrades: [] },
      earlyMid: { signatures: [], tech: [], upgrades: [] },
      mid: {
        signatures: [
          {
            key: "Stalker|Phoenix|Immortal",
            units: [
              { token: "Stalker", count: 5 },
              { token: "Phoenix", count: 3 },
              { token: "Immortal", count: 2 },
            ],
            sampleCount: total,
            wins: total,
            losses: 0,
            winRate: 1,
            sampleGameIds: ["g1", "g2"],
          },
        ],
        tech: [],
        upgrades: [],
      },
      midLate: { signatures: [], tech: [], upgrades: [] },
      late: { signatures: [], tech: [], upgrades: [] },
    },
    finalPhaseDistribution: {
      early: 0,
      earlyMid: 0,
      mid: total,
      midLate: 0,
      late: 0,
    },
    medianCrossings: {
      earlyMidAt: 120,
      midAt: 240,
      midLateAt: null,
      lateAt: null,
    },
    durationP95Sec: 600,
    flags: [],
  };
}

describe("StrategyPhasePanel", () => {
  it("hits the /v1/strategies/:name/phases endpoint with the strategy name encoded", () => {
    useApiMock.mockReturnValue({ data: undefined, isLoading: true, error: null });
    render(<StrategyPhasePanel strategy="Zerg - Mass Ling" />);
    // useApi receives the URL with the strategy name percent-encoded
    // (space → %20) and dbRev appended as a cache-bust fragment.
    expect(useApiMock).toHaveBeenCalledWith(
      "/v1/strategies/Zerg%20-%20Mass%20Ling/phases#rev1",
    );
  });

  it("shows EmptyState when sample size is under the 5-game threshold", () => {
    useApiMock.mockReturnValue({
      data: payload(3),
      isLoading: false,
      error: null,
    });
    render(<StrategyPhasePanel strategy="Zerg - Mass Ling" />);
    expect(
      screen.getByText(/Not enough games on this strategy yet/i),
    ).toBeTruthy();
    // Trajectory strip must NOT render — it would imply we have data
    // that we don't.
    expect(screen.queryByTestId("phase-composition-tabs")).toBeNull();
  });

  it("renders the trajectory strip + composition tabs when ≥ 5 games", () => {
    useApiMock.mockReturnValue({
      data: payload(7),
      isLoading: false,
      error: null,
    });
    render(<StrategyPhasePanel strategy="Zerg - Mass Ling" />);
    expect(screen.getByTestId("phase-composition-tabs")).toBeTruthy();
    // Five bands on the trajectory strip — same as the BuildDossier
    // surface uses, no special-casing for the strategies tab.
    const bands = document.querySelectorAll('[data-testid="phase-band"]');
    expect(bands.length).toBe(5);
  });

  it("shows EmptyState on 404 (server returns strategy_not_found)", () => {
    useApiMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: { status: 404, message: "not found" },
    });
    render(<StrategyPhasePanel strategy="Zerg - Mass Ling" />);
    expect(
      screen.getByText(/Not enough games on this strategy yet/i),
    ).toBeTruthy();
  });

  it("hides the card entirely on a non-404 server error", () => {
    useApiMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: { status: 500, message: "server fire" },
    });
    const { container } = render(
      <StrategyPhasePanel strategy="Zerg - Mass Ling" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders a skeleton while loading and no data is cached yet", () => {
    useApiMock.mockReturnValue({ data: undefined, isLoading: true, error: null });
    const { container } = render(
      <StrategyPhasePanel strategy="Zerg - Mass Ling" />,
    );
    // Card title is always there; skeleton lives inside the card body.
    expect(
      screen.getByText(/What this matchup looks like phase-by-phase/i),
    ).toBeTruthy();
    // The skeleton renderer uses bg-bg-elevated stripes; the panel
    // header should render even before data arrives.
    expect(container.querySelectorAll("section").length).toBeGreaterThan(0);
  });

  it("renders nothing when no strategy is provided (empty drill state)", () => {
    useApiMock.mockReturnValue({ data: undefined, isLoading: false, error: null });
    render(<StrategyPhasePanel strategy="" />);
    // Should still call useApi(null) so SWR stays idle; an empty
    // strategy renders the EmptyState fallback shape.
    expect(useApiMock).toHaveBeenCalledWith(null);
  });
});
