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
  labelPayload,
  labelError,
}: {
  customBuildsList?: Array<{ slug: string; name: string }>;
  yourPayload?: unknown;
  oppPayload?: unknown;
  // Fallback payload served by /v1/builds/:name/phases — used by the
  // left column when no saved custom build matches the agent label.
  labelPayload?: unknown;
  labelError?: { status: number } | null;
}) {
  useApiMock.mockImplementation((path: string | null) => {
    if (path === "/v1/custom-builds") {
      return { data: { items: customBuildsList }, isLoading: false, error: null };
    }
    if (path && path.includes("/compositions")) {
      return { data: yourPayload, isLoading: false, error: null };
    }
    if (path && path.startsWith("/v1/builds/") && path.includes("/phases")) {
      return {
        data: labelPayload,
        isLoading: false,
        error: labelError ?? null,
      };
    }
    if (path && path.includes("/phases")) {
      return { data: oppPayload, isLoading: false, error: null };
    }
    return { data: undefined, isLoading: false, error: null };
  });
}

describe("BuildVsStrategyComparison", () => {
  it("requests the left column with perspective=you and right column with perspective=opponent, both scoped to the matrix cell", () => {
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
    // Left column: perspective=you AND strategy filter — describes
    // the SAME cell as the right column.
    expect(callPaths).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "/v1/custom-builds/stargate-phoenix/compositions?perspective=you&strategy=Terran%20-%20Mech",
        ),
      ]),
    );
    // Right column: perspective=opponent AND build filter — same cell.
    expect(callPaths).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "/v1/strategies/Terran%20-%20Mech/phases?perspective=opponent&build=Stargate%20Phoenix",
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

    // The flex / grid wrapper carries xl:grid-cols-2 so each column
    // gets half-width on a wide layout — same visual budget for left
    // and right. Stacked below xl so common 1024-1279px desktops give
    // each column the full content width instead of cramming both into
    // ~600px halves. Asserting the class is the cheapest way to guard
    // the "comparable visual width" claim without a JSDOM layout
    // engine.
    const wrapper = container.querySelector(
      "[data-testid='build-vs-strategy-comparison']",
    );
    expect(wrapper).toBeTruthy();
    expect(wrapper?.className).toMatch(/grid-cols-1/);
    expect(wrapper?.className).toMatch(/xl:grid-cols-2/);

    // Each column hosts its own trajectory strip — that's the
    // primary visual element. Two strips means the comparison is
    // really side-by-side.
    const strips = container.querySelectorAll(
      "[data-testid='phase-trajectory-strip']",
    );
    expect(strips.length).toBe(2);
  });

  it("falls back to the build-label phases endpoint when no saved build matches", () => {
    // User has 8 games tagged with the agent's auto-classified label
    // but no saved custom build by that name. The left column should
    // fire ``/v1/builds/:name/phases`` and render the resulting
    // trajectory rather than spinning forever or showing the legacy
    // "No saved build" empty state.
    wireMocks({
      customBuildsList: [],
      labelPayload: {
        ...buildPhasesPayload(8, "you"),
        name: "Some Agent Auto-Label",
      },
      oppPayload: { ...buildPhasesPayload(8, "opponent"), name: "Terran - Mech" },
    });

    const { container } = render(
      <BuildVsStrategyComparison
        build="Some Agent Auto-Label"
        strategy="Terran - Mech"
      />,
    );

    const callPaths = useApiMock.mock.calls.map((c) => c[0]);
    expect(callPaths).toEqual(
      expect.arrayContaining([
        // The fallback also carries the strategy filter so the cell-
        // scoped intersection holds in the auto-classified-label path.
        expect.stringContaining(
          "/v1/builds/Some%20Agent%20Auto-Label/phases?perspective=you&strategy=Terran%20-%20Mech",
        ),
      ]),
    );
    // Both columns render a trajectory strip — the fallback wired the
    // left column off the auto-classified label set.
    expect(
      container.querySelectorAll('[data-testid="phase-trajectory-strip"]').length,
    ).toBe(2);
    // Empty-state copy must NOT appear when the fallback has data.
    expect(screen.queryByText(/No saved build for this label/i)).toBeNull();
    expect(screen.queryByText(/Not enough samples/i)).toBeNull();
  });

  it("renders an empty-state on the left when the agent label has too few games", () => {
    // Fewer than COMPARISON_MIN_GAMES (3) games carry the label — the
    // left column shouldn't try to draw a trajectory off a 1-sample
    // bucket. Surfaces a friendlier message than the legacy "No saved
    // build" empty state.
    wireMocks({
      customBuildsList: [],
      labelPayload: {
        ...buildPhasesPayload(1, "you"),
        name: "Some Agent Auto-Label",
        total: 1,
      },
      oppPayload: { ...buildPhasesPayload(8, "opponent"), name: "Terran - Mech" },
    });

    render(
      <BuildVsStrategyComparison
        build="Some Agent Auto-Label"
        strategy="Terran - Mech"
      />,
    );

    expect(screen.getByText(/Not enough samples/i)).toBeTruthy();
    // Right column still renders — the comparison doesn't gate one
    // column on the other.
    expect(screen.getByTestId("bvs-column-opponent")).toBeTruthy();
  });

  it("handles a 404 from the build-label endpoint with the empty-state copy", () => {
    // No games at all for the agent label — API returns 404, which
    // the column treats the same as "no data" (NOT a load failure).
    wireMocks({
      customBuildsList: [],
      labelPayload: undefined,
      labelError: { status: 404 },
      oppPayload: { ...buildPhasesPayload(8, "opponent"), name: "Terran - Mech" },
    });

    render(
      <BuildVsStrategyComparison
        build="Some Agent Auto-Label"
        strategy="Terran - Mech"
      />,
    );

    expect(screen.getByText(/Not enough samples/i)).toBeTruthy();
    // Generic "Couldn't load this build" must not appear on 404.
    expect(screen.queryByText(/Couldn't load this build/i)).toBeNull();
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
          "/v1/custom-builds/stargate-phoenix/compositions?perspective=you&strategy=Zerg%20-%203%20Base%20Macro",
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
          "/v1/custom-builds/stargate-phoenix/compositions?perspective=you&strategy=Zerg%20-%203%20Base%20Macro",
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
