import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Phase, PhaseSignature } from "@/components/analyzer/PhaseCompositionTabs";
import type { BuildPhasePayload } from "./types";
import type { BuildDossierData } from "./BuildDossier";

const harness = vi.hoisted(() => ({
  paths: [] as Array<string | null>,
  data: null as BuildDossierData | null,
  compositions: undefined as BuildPhasePayload | undefined,
  compositionError: null as unknown,
  transitionError: null as unknown,
  retryCompositions: vi.fn(),
  retryTransitions: vi.fn(),
  sampleIds: ["shared-replay"],
  gameError: null as unknown,
  retryGame: vi.fn(),
}));

vi.mock("@/lib/clientApi", () => ({
  useApi: (path: string | null) => {
    harness.paths.push(path);
    if (path && /\/(compositions|phases)([?#]|$)/.test(path)) {
      return {
        data: harness.compositions,
        error: harness.compositionError,
        isLoading: false,
        mutate: harness.retryCompositions,
      };
    }
    if (path && /\/transitions([?#]|$)/.test(path)) {
      return {
        data: undefined,
        error: harness.transitionError,
        isLoading: false,
        mutate: harness.retryTransitions,
      };
    }
    if (path?.startsWith("/v1/games/")) {
      return {
        data: harness.gameError ? undefined : {
          gameId: decodeURIComponent(path.slice("/v1/games/".length)),
          date: "2026-08-01T18:00:00.000Z",
          map: "Golden Aura LE",
          opponent: { displayName: "Archive opponent" },
          durationSec: 720,
          result: "Victory",
        },
        error: harness.gameError,
        isLoading: false,
        mutate: harness.retryGame,
      };
    }
    return { data: path ? harness.data : undefined, error: null, isLoading: false, mutate: vi.fn() };
  },
}));

vi.mock("@/components/analyzer/Last5GamesTimeline", () => ({ Last5GamesTimeline: () => null }));
vi.mock("@/components/analyzer/PredictedStrategiesList", () => ({ PredictedStrategiesList: () => null }));
vi.mock("@/components/analyzer/StrategyTendencyChart", () => ({ StrategyTendencyChart: () => null }));
vi.mock("@/components/analyzer/PhaseTrajectoryStrip", () => ({ PhaseTrajectoryStrip: () => null }));
vi.mock("@/components/analyzer/BuildTransitionSankey", () => ({ BuildTransitionSankey: () => null }));
vi.mock("./BuildBreakdownCards", () => ({ BreakdownCard: () => null, TopOpponentsCard: () => null }));
vi.mock("./BuildGamesTable", () => ({
  BuildGamesTable: ({ filterLabel, filterGameIds }: { filterLabel?: string; filterGameIds?: string[] }) => (
    <output data-testid="filtered-games">{filterLabel ? `${filterLabel}: ${filterGameIds?.join(",")}` : "All games"}</output>
  ),
}));
vi.mock("@/components/analyzer/PhaseCompositionTabs", () => ({
  PhaseCompositionTabs: ({ perPhase, onSignatureClick, onUnitClick }: {
    perPhase: BuildPhasePayload["perPhase"];
    onSignatureClick: (ids: string[], context: { phase: Phase; signature: PhaseSignature }) => void;
    onUnitClick: (ids: string[], context: { phase: Phase; token: string }) => void;
  }) => (
    <><button onClick={() => {
      const signature = perPhase.mid.signatures[0];
      onSignatureClick(signature.sampleGameIds, { phase: "mid", signature });
    }}>Inspect mid-game composition</button>
      <button onClick={() => onUnitClick(harness.sampleIds, { phase: "mid", token: "SiegeTank" })}>Inspect unit games</button>
    </>
  ),
}));

import { BuildDossier } from "./BuildDossier";

function signature(token: string): PhaseSignature {
  return {
    key: token,
    units: [{ token, count: 5 }],
    sampleCount: 1,
    wins: 1,
    losses: 0,
    winRate: 1,
    // The same replay appears in early and mid. Labels must use the
    // clicked phase, rather than the first phase containing this game.
    sampleGameIds: ["shared-replay"],
  };
}

function compositionPayload(): BuildPhasePayload {
  const empty = () => ({ signatures: [], tech: [], upgrades: [] });
  return {
    slug: "test-build",
    name: "Test build",
    perspective: "you",
    sampleSize: { early: 1, earlyMid: 0, mid: 1, midLate: 0, late: 0 },
    perPhase: {
      early: { ...empty(), signatures: [signature("Marine")] },
      earlyMid: empty(),
      mid: { ...empty(), signatures: [signature("SiegeTank")] },
      midLate: empty(),
      late: empty(),
    },
    finalPhaseDistribution: { early: 0, earlyMid: 0, mid: 1, midLate: 0, late: 0 },
    medianCrossings: { earlyMidAt: null, midAt: 240, midLateAt: null, lateAt: null },
    durationP95Sec: 600,
    flags: [],
  };
}

beforeEach(() => {
  harness.paths = [];
  harness.compositionError = null;
  harness.transitionError = null;
  harness.gameError = null;
  harness.sampleIds = ["shared-replay"];
  harness.compositions = compositionPayload();
  harness.data = {
    name: "Test build",
    totals: { total: 1, wins: 1, losses: 0, winRate: 1 },
    byMatchup: [], byMap: [], byStrategy: [], recent: [], resumedRecent: [], resumedCount: 0,
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("BuildDossier composition integration", () => {
  it("loads classified build phases with every filter and the cache revision preserved", () => {
    const apiPath = "/v1/builds/PvT%20-%202%20Base?since=2026-08-01&regions=EU%2CKR&opp_race=T&map=Golden%20Aura%20LE&mmr_min=4200&opp_strategy=Bio#17";
    render(<BuildDossier apiPath={apiPath} showMacro={false} />);

    expect(harness.paths).toEqual([
      apiPath,
      apiPath.replace("PvT%20-%202%20Base?", "PvT%20-%202%20Base/phases?"),
      null,
    ]);
    expect(screen.getByRole("heading", { name: "Army composition" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Inspect mid-game composition" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Build transitions" })).toBeNull();
  });

  it("keeps the custom build scope and uses an explicit perspective override", () => {
    const apiPath = "/v1/custom-builds/proxy%20gate/matches?since=2026-08-01&strategy=Bio&perspective=you#9";
    render(<BuildDossier apiPath={apiPath} phasePerspective="opponent" showMacro={false} />);

    expect(harness.paths).toEqual([
      apiPath,
      "/v1/custom-builds/proxy%20gate/compositions?since=2026-08-01&strategy=Bio&perspective=opponent#9",
      null,
    ]);
    // Transitions currently ignore cohort filters on the API. Never pair
    // their full-build results with a scoped composition.
    expect(screen.queryByRole("heading", { name: "Build transitions" })).toBeNull();
  });

  it("loads both custom endpoints when unscoped and retains perspective from the URL", () => {
    const apiPath = "/v1/custom-builds/opponent-bio/matches?perspective=opponent#4";
    harness.compositions!.perspective = "opponent";
    render(<BuildDossier apiPath={apiPath} showMacro={false} />);

    expect(harness.paths).toEqual([
      apiPath,
      "/v1/custom-builds/opponent-bio/compositions?perspective=opponent#4",
      "/v1/custom-builds/opponent-bio/transitions?perspective=opponent#4",
    ]);
    expect(screen.getByText("Opponent army")).toBeTruthy();
  });

  it("keeps failed analyses visible and retries each resource independently", () => {
    harness.compositions = undefined;
    harness.compositionError = { message: "Network failed" };
    harness.transitionError = { message: "Network failed" };
    render(<BuildDossier apiPath="/v1/custom-builds/test-build/matches" showMacro={false} />);

    expect(screen.getByText("Army composition unavailable")).toBeTruthy();
    expect(screen.getByText("Transitions unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry army composition" }));
    expect(harness.retryCompositions).toHaveBeenCalledOnce();
    expect(harness.retryTransitions).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry transitions" }));
    expect(harness.retryTransitions).toHaveBeenCalledOnce();
  });

  it("labels stale composition results when a refresh fails", () => {
    harness.compositionError = { message: "Network failed" };
    render(<BuildDossier apiPath="/v1/builds/Bio" showMacro={false} />);

    expect(screen.getByText("Couldn't refresh this analysis. Showing the previous results.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Inspect mid-game composition" })).toBeTruthy();
  });

  it("explains missing opponent signals instead of presenting empty phase counts", () => {
    harness.compositions!.perspective = "opponent";
    harness.compositions!.flags = ["opp_signals_sparse"];
    harness.compositions!.sampleSize = { early: 0, earlyMid: 0, mid: 0, midLate: 0, late: 0 };
    render(<BuildDossier apiPath="/v1/builds/Bio" phasePerspective="opponent" showMacro={false} />);

    expect(screen.getByText("Opponent composition unavailable")).toBeTruthy();
    expect(screen.getByText(/Most games in this selection are missing the opponent tracker data/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Inspect mid-game composition" })).toBeNull();
  });

  it("uses the clicked signature's phase and clears its game filter when the cohort changes", () => {
    const { rerender } = render(<BuildDossier apiPath="/v1/builds/Bio" showMacro={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Inspect mid-game composition" }));
    expect(screen.getByText("Mid · Siege Tank")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Composition sample games" })).toBeTruthy();

    rerender(<BuildDossier apiPath="/v1/builds/Bio?opp_race=P" showMacro={false} />);
    expect(screen.getByTestId("filtered-games").textContent).toBe("All games");
  });

  it("resolves older sample games outside the recent list and bounds metadata requests to one page", () => {
    harness.sampleIds = Array.from({ length: 25 }, (_, index) => `older-game-${index}`);
    render(<BuildDossier apiPath="/v1/builds/Bio" showMacro={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Inspect unit games" }));

    expect(screen.getByText("Mid · Games with Siege Tank")).toBeTruthy();
    expect(screen.getByText(/25 saved samples · up to 25 replay examples/)).toBeTruthy();
    expect(screen.getAllByText("Archive opponent · Golden Aura LE")).toHaveLength(10);
    expect(screen.getAllByRole("link", { name: "Open game" })[0].getAttribute("href")).toBe("/app/game/older-game-0");
    expect(new Set(harness.paths.filter((path) => path?.startsWith("/v1/games/"))).size).toBe(10);

    fireEvent.click(screen.getByRole("button", { name: "Next samples" }));
    expect(screen.getByText("11–20 of 25 samples")).toBeTruthy();
    expect(new Set(harness.paths.filter((path) => path?.startsWith("/v1/games/"))).size).toBe(20);
    expect(screen.getAllByRole("link", { name: "Open game" })[0].getAttribute("href")).toBe("/app/game/older-game-10");

    fireEvent.click(screen.getByRole("button", { name: "Show all recent games" }));
    expect(screen.getByTestId("filtered-games").textContent).toBe("All games");
  });

  it("uses cached recent metadata and keeps unavailable archived samples visible with retry", () => {
    harness.data!.recent = [{ gameId: "shared-replay", date: "2026-09-01", opponent: "Recent opponent", result: "loss" }];
    const { unmount } = render(<BuildDossier apiPath="/v1/builds/Bio" showMacro={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Inspect unit games" }));
    expect(screen.getByText("Recent opponent · Unknown map")).toBeTruthy();
    expect(harness.paths.some((path) => path?.startsWith("/v1/games/"))).toBe(false);
    unmount();

    harness.data!.recent = [];
    harness.gameError = { message: "Game unavailable" };
    render(<BuildDossier apiPath="/v1/builds/Bio" showMacro={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Inspect unit games" }));
    expect(screen.getByText(/Sample details couldn't load/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open game" }).getAttribute("href")).toBe("/app/game/shared-replay");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(harness.retryGame).toHaveBeenCalledOnce();
  });
});
