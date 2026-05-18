import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/**
 * Tests for the 2-column build × strategy comparison renderer in
 * ``StrategiesTabBuildVs``. The component runs three useApi hooks
 * (custom-builds list for the slug bridge, plus left + right phase
 * payloads); we mock useApi to drive each call's state directly.
 */

const useApiMock = vi.fn();

vi.mock("@/lib/clientApi", () => ({
  useApi: (path: string | null) => useApiMock(path),
}));

import { BuildVsStrategyComparison } from "../analyzer/StrategiesTabBuildVs";

afterEach(() => {
  cleanup();
  useApiMock.mockReset();
});

function buildPhasesPayload(total: number, perspective: "you" | "opponent") {
  return {
    slug: "stargate-phoenix",
    name: "Stargate Phoenix",
    perspective,
    total,
    sampleSize: {
      early: total, earlyMid: total, mid: total, midLate: 0, late: 0,
    },
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
        tech: [], upgrades: [],
      },
      midLate: { signatures: [], tech: [], upgrades: [] },
      late: { signatures: [], tech: [], upgrades: [] },
    },
    finalPhaseDistribution: {
      early: 0, earlyMid: 0, mid: total, midLate: 0, late: 0,
    },
    medianCrossings: {
      earlyMidAt: 120, midAt: 240, midLateAt: null, lateAt: null,
    },
    durationP95Sec: 600,
    flags: [],
  };
}

function wireMocks({
  customBuildsList = [{ slug: "stargate-phoenix", name: "Stargate Phoenix" }],
  yourPayload,
  oppPayload,
}: {
  customBuildsList?: Array<{ slug: string; name: string }>;
  yourPayload?: unknown;
  oppPayload?: unknown;
}) {
  useApiMock.mockImplementation((path: string | null) => {
    if (path === "/v1/custom-builds") {
      return { data: { items: customBuildsList }, isLoading: false, error: null };
    }
    if (path && path.includes("/compositions")) {
      return { data: yourPayload, isLoading: false, error: null };
    }
    if (path && path.includes("/phases")) {
      return { data: oppPayload, isLoading: false, error: null };
    }
    return { data: undefined, isLoading: false, error: null };
  });
}

describe("BuildVsStrategyComparison", () => {
  it("requests the left column with perspective=you and right column with perspective=opponent", () => {
    wireMocks({
      yourPayload: buildPhasesPayload(7, "you"),
      oppPayload: { ...buildPhasesPayload(7, "opponent"), name: "Terran - Mech" },
    });

    render(
      <BuildVsStrategyComparison
        build="Stargate Phoenix"
        strategy="Terran - Mech"
      />,
    );

    const callPaths = useApiMock.mock.calls.map((c) => c[0]);
    // Slug bridge call:
    expect(callPaths).toContain("/v1/custom-builds");
    // Left column: perspective=you.
    expect(callPaths).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "/v1/custom-builds/stargate-phoenix/compositions?perspective=you",
        ),
      ]),
    );
    // Right column: perspective=opponent.
    expect(callPaths).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "/v1/strategies/Terran%20-%20Mech/phases?perspective=opponent",
        ),
      ]),
    );
  });

  it("renders two columns of comparable visual width when both have data", () => {
    wireMocks({
      yourPayload: buildPhasesPayload(8, "you"),
      oppPayload: { ...buildPhasesPayload(8, "opponent"), name: "Terran - Mech" },
    });

    const { container } = render(
      <BuildVsStrategyComparison
        build="Stargate Phoenix"
        strategy="Terran - Mech"
      />,
    );

    // Both columns rendered.
    expect(screen.getByTestId("bvs-column-you")).toBeTruthy();
    expect(screen.getByTestId("bvs-column-opponent")).toBeTruthy();

    // The flex / grid wrapper carries lg:grid-cols-2 so each column
    // gets half-width on a wide layout — same visual budget for left
    // and right. Asserting the class is the cheapest way to guard the
    // "comparable visual width" claim without a JSDOM layout engine.
    const wrapper = container.querySelector(
      "[data-testid='build-vs-strategy-comparison']",
    );
    expect(wrapper).toBeTruthy();
    expect(wrapper?.className).toMatch(/grid-cols-1/);
    expect(wrapper?.className).toMatch(/lg:grid-cols-2/);

    // Each column hosts its own trajectory strip — that's the
    // primary visual element. Two strips means the comparison is
    // really side-by-side.
    const strips = container.querySelectorAll(
      "[data-testid='phase-trajectory-strip']",
    );
    expect(strips.length).toBe(2);
  });

  it("falls back to an EmptyState in the left column when no saved build matches the name", () => {
    wireMocks({
      customBuildsList: [], // user hasn't saved this build yet
      oppPayload: { ...buildPhasesPayload(8, "opponent"), name: "Terran - Mech" },
    });

    render(
      <BuildVsStrategyComparison
        build="Some Agent Auto-Label"
        strategy="Terran - Mech"
      />,
    );

    expect(
      screen.getByText(/No saved build for this label/i),
    ).toBeTruthy();
    // Right column still renders its trajectory — the comparison
    // doesn't gate one column on the other.
    expect(screen.getByTestId("bvs-column-opponent")).toBeTruthy();
  });

  it("resolves the saved-build slug even when the drill carries the agent's race-matchup prefix", () => {
    // The agent's auto-classifier emits names like "PvZ - 3 Stargate
    // Phoenix" while users typically save the build without the
    // "PvZ - " prefix. The comparison should still bridge to the
    // saved slug rather than falling into the "no saved build" state.
    wireMocks({
      customBuildsList: [
        { slug: "stargate-phoenix", name: "3 Stargate Phoenix" },
      ],
      yourPayload: buildPhasesPayload(8, "you"),
      oppPayload: { ...buildPhasesPayload(8, "opponent"), name: "Zerg - 3 Base Macro" },
    });

    render(
      <BuildVsStrategyComparison
        build="PvZ - 3 Stargate Phoenix"
        strategy="Zerg - 3 Base Macro"
      />,
    );

    const callPaths = useApiMock.mock.calls.map((c) => c[0]);
    expect(callPaths).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "/v1/custom-builds/stargate-phoenix/compositions?perspective=you",
        ),
      ]),
    );
  });

  it("matches saved builds when case, whitespace, or dash style differ from the agent label", () => {
    // Real-world reports: user has a build saved as "3 stargate
    // phoenix" (lowercase, stray trailing space) and the agent label
    // is "PvZ - 3 Stargate Phoenix". Strict equality misses; the
    // bridge should normalize case + whitespace so they line up.
    wireMocks({
      customBuildsList: [
        { slug: "stargate-phoenix", name: "  3 stargate  Phoenix " },
      ],
      yourPayload: buildPhasesPayload(8, "you"),
      oppPayload: { ...buildPhasesPayload(8, "opponent"), name: "Zerg - 3 Base Macro" },
    });

    render(
      <BuildVsStrategyComparison
        build="PvZ - 3 Stargate Phoenix"
        strategy="Zerg - 3 Base Macro"
      />,
    );

    const callPaths = useApiMock.mock.calls.map((c) => c[0]);
    expect(callPaths).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "/v1/custom-builds/stargate-phoenix/compositions?perspective=you",
        ),
      ]),
    );
    expect(screen.queryByText(/No saved build for this label/i)).toBeNull();
  });

  it("does not flash the empty state while the custom-builds list is still loading", () => {
    // Initial render before the slug-bridge fetch settles: data is
    // undefined, isLoading is true. The left column should show a
    // skeleton rather than the "No saved build for this label" empty
    // state — otherwise users with a matching build see the wrong
    // message until SWR resolves.
    useApiMock.mockImplementation((path: string | null) => {
      if (path === "/v1/custom-builds") {
        return { data: undefined, isLoading: true, error: null };
      }
      if (path && path.includes("/phases")) {
        return {
          data: { ...buildPhasesPayload(8, "opponent"), name: "Zerg - 3 Base Macro" },
          isLoading: false,
          error: null,
        };
      }
      return { data: undefined, isLoading: false, error: null };
    });

    render(
      <BuildVsStrategyComparison
        build="PvZ - 3 Stargate Phoenix"
        strategy="Zerg - 3 Base Macro"
      />,
    );

    expect(screen.queryByText(/No saved build for this label/i)).toBeNull();
  });

  it("renders the 'where games end' stacked bar (not the median-timing bands) in both columns", () => {
    // Comparison columns swap the full PhaseTrajectoryStrip for the
    // outcomeOnly variant — that means `phase-histogram` (the stacked
    // bar) renders, while `phase-bands` (the median-timing strip) and
    // `phase-crossing` markers do not.
    wireMocks({
      yourPayload: buildPhasesPayload(8, "you"),
      oppPayload: { ...buildPhasesPayload(8, "opponent"), name: "Terran - Mech" },
    });
    const { container } = render(
      <BuildVsStrategyComparison
        build="Stargate Phoenix"
        strategy="Terran - Mech"
      />,
    );
    expect(
      container.querySelectorAll('[data-testid="phase-histogram"]').length,
    ).toBe(2);
    expect(
      container.querySelector('[data-testid="phase-bands"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="phase-crossing"]'),
    ).toBeNull();
  });

  it("renders the opp-signal sparse EmptyState when the right payload sets that flag", () => {
    wireMocks({
      yourPayload: buildPhasesPayload(8, "you"),
      oppPayload: {
        ...buildPhasesPayload(0, "opponent"),
        name: "Terran - Mech",
        total: 8,
        flags: ["opp_signals_sparse"],
      },
    });

    render(
      <BuildVsStrategyComparison
        build="Stargate Phoenix"
        strategy="Terran - Mech"
      />,
    );

    expect(
      screen.getByText(/Opponent signal too sparse/i),
    ).toBeTruthy();
  });
});
