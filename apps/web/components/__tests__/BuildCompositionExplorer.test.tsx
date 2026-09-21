import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { BuildCompositionExplorer, compositionComparisonPath } from "@/components/builds/BuildCompositionExplorer";
import type { BuildPhasePayload } from "@/lib/serverApi";
import type { UnitComparison, UnitSummary } from "@/components/analyzer/UnitCompositionTable";

const api = vi.hoisted(() => ({ useApi: vi.fn() }));
vi.mock("@/lib/clientApi", () => ({ useApi: api.useApi }));

const mutate = vi.fn();
const path = "/v1/custom-builds/stargate/compositions?since=2026-09-01&opp_race=Z&map=Map+One&regions=EU&perspective=you&revision=4#units";

function summary(token = "Stalker", overrides: Partial<UnitSummary> = {}): UnitSummary {
  return {
    metric: "snapshot_alive", source: "unit_timeline", observedGames: 2, missingGames: 1, emptyArmyGames: 0,
    units: [{ token, mean: 4, median: 4, p25: 3, p75: 5, min: 2, max: 6, gamesPresent: 2,
      sampleGameIds: ["game-a", "game-b"], whenPresent: { median: 4, p25: 3, p75: 5 }, examples: {} }],
    ...overrides,
  };
}

function payload(overrides: Partial<BuildPhasePayload> = {}): BuildPhasePayload {
  const empty = () => ({ signatures: [], tech: [], upgrades: [] });
  return {
    slug: "stargate", name: "Stargate", perspective: "you",
    sampleSize: { early: 4, earlyMid: 3, mid: 3, midLate: 0, late: 0 },
    perPhase: {
      early: { ...empty(), unitSummary: summary("Adept", { metric: "peak_alive" }) },
      earlyMid: empty(), mid: { ...empty(), unitSummary: summary("Immortal", { metric: "peak_alive" }) },
      midLate: empty(), late: empty(),
    },
    finalPhaseDistribution: { early: 1, earlyMid: 0, mid: 3, midLate: 0, late: 0 },
    medianCrossings: { earlyMidAt: 200, midAt: 300, midLateAt: null, lateAt: null },
    durationP95Sec: 800, flags: [], sampleLimit: 100, sampleTruncated: false,
    checkpoints: [
      { timeSec: 240, reachedGames: 4, endedGames: 0, unitSummary: summary("Zealot", { observedGames: 4, missingGames: 0 }) },
      { timeSec: 360, reachedGames: 3, endedGames: 1, unitSummary: summary() },
      { timeSec: 480, reachedGames: 2, endedGames: 2, unitSummary: summary("", { observedGames: 0, missingGames: 2, units: [] }) },
    ],
    comparisonGames: [
      { gameId: "game-a", date: "2026-09-21T12:00:00Z", map: "Map One", result: "Victory", myRace: "Protoss", oppRace: "Zerg", opponentName: "Rival One", durationSec: 800 },
      { gameId: "game-b", date: "2026-09-18T12:00:00Z", map: "Map Two", result: "Defeat", myRace: "Protoss", oppRace: "Terran", opponentName: "Rival Two", durationSec: 700 },
      { gameId: "game-c", date: null, map: null, result: "Victory", myRace: "Protoss", oppRace: "Zerg", opponentName: null, durationSec: 460 },
      { gameId: "game-d", date: "invalid-date", map: null, result: null, myRace: null, oppRace: null, opponentName: null, durationSec: 300 },
    ],
    ...overrides,
  };
}

function compared(gameId: string, status: UnitComparison["status"] = "observed") {
  const base = payload();
  const comparison: UnitComparison = {
    gameId, status, baselineGames: 1, sampleTimeSec: 355,
    units: status === "observed" ? [{ token: "Carrier", count: 5, median: 2, p25: 2, p75: 2, delta: 3 }] : [],
  };
  return { ...base, checkpoints: base.checkpoints!.map((point) => ({
    ...point, unitSummary: { ...point.unitSummary, comparison },
  })) };
}

function setApi(data?: BuildPhasePayload, options: { error?: Error; isLoading?: boolean; isValidating?: boolean } = {}) {
  api.useApi.mockReturnValue({ data, error: options.error, isLoading: options.isLoading ?? false, isValidating: options.isValidating ?? false, mutate });
}

function select(gameId: string) {
  fireEvent.change(screen.getByRole("combobox", { name: /Compare a game/ }), { target: { value: gameId } });
}

beforeEach(() => { vi.clearAllMocks(); setApi(); });
afterEach(cleanup);

describe("BuildCompositionExplorer", () => {
  it("preserves every scope parameter and the hash when adding or replacing a comparison ID", () => {
    const result = new URL(compositionComparisonPath(`${path.replace("#units", "")}&compareGameId=previous#units`, "id/with + symbols"), "https://test.invalid");
    expect(result.pathname).toBe("/v1/custom-builds/stargate/compositions");
    expect(result.hash).toBe("#units");
    expect([...result.searchParams.entries()]).toEqual([
      ["since", "2026-09-01"], ["opp_race", "Z"], ["map", "Map One"], ["regions", "EU"],
      ["perspective", "you"], ["revision", "4"], ["compareGameId", "id/with + symbols"],
    ]);
    expect(compositionComparisonPath("/v1/builds/Bio/phases", "game-a")).toBe("/v1/builds/Bio/phases?compareGameId=game-a");
  });

  it("starts at a measured six-minute checkpoint, switches clocks and phases, and opens scoped samples", () => {
    const onOpenGames = vi.fn();
    render(<BuildCompositionExplorer payload={payload()} apiPath={path} onOpenGames={onOpenGames} />);
    expect(api.useApi).toHaveBeenLastCalledWith(null, expect.objectContaining({ keepPreviousData: false }), { timeoutMs: 45000 });
    expect(screen.getByRole("button", { name: "6:00" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("unit-summary-row").getAttribute("data-token")).toBe("Stalker");
    fireEvent.click(screen.getByRole("button", { name: "4:00" }));
    expect(screen.getByTestId("unit-summary-row").getAttribute("data-token")).toBe("Zealot");
    fireEvent.click(within(screen.getByTestId("unit-summary-row")).getByRole("button"));
    fireEvent.click(screen.getByRole("button", { name: "View 2 games with Zealot" }));
    expect(onOpenGames).toHaveBeenCalledWith(["game-a", "game-b"], "4:00 · Games with Zealot");
    fireEvent.click(screen.getByRole("button", { name: "By phase" }));
    expect(screen.getByTestId("phase-tab-panel").getAttribute("data-active-phase")).toBe("mid");
    expect(screen.getByTestId("unit-summary-row").getAttribute("data-token")).toBe("Immortal");
    expect(screen.getByText(/Unit peaks can occur at different moments/)).toBeTruthy();
    fireEvent.click(screen.getAllByTestId("phase-tab")[0]);
    expect(screen.getByTestId("unit-summary-row").getAttribute("data-token")).toBe("Adept");
    fireEvent.click(screen.getByRole("button", { name: "At game time" }));
    expect(screen.getByRole("button", { name: "4:00" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("shows real cohort context, bounded sampling, matchup counts and checkpoint coverage", () => {
    render(<BuildCompositionExplorer payload={payload({ sampleTruncated: true, perspective: "opponent" })} apiPath={path} onOpenGames={vi.fn()} />);
    expect(screen.getByText("4 sampled games")).toBeTruthy();
    expect(screen.getByText("Opponent units")).toBeTruthy();
    expect(screen.getByText(/latest 100 matching games/)).toBeTruthy();
    expect(screen.getByText(/Selection & matchups · 4 active filters/)).toBeTruthy();
    expect(screen.getByText(/2 games have no recorded date/)).toBeTruthy();
    expect(screen.getByText("Protoss vs Zerg: 2 · Protoss vs Terran: 1 · Race unavailable: 1")).toBeTruthy();
    expect(screen.getByText(/From: 2026-09-01 · Opponent race: Z · Map: Map One · Regions: EU/)).toBeTruthy();
    expect(screen.getByText("3 reached 6:00").parentElement?.textContent).toContain("1 ended earlier");
    expect(screen.getByText("1 game has no usable samples at this checkpoint and is excluded from the averages.")).toBeTruthy();
    expect(screen.getByRole("option", { name: /vs Rival Two · Map Two · Defeat · 11:40/ })).toBeTruthy();
    expect(screen.queryByText(/needs reprocessing/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "8:00" }));
    expect(screen.getByText("No unit samples at this checkpoint")).toBeTruthy();
    expect(screen.getByText("2 reached 8:00").parentElement?.textContent).toContain("2 ended earlier");
  });

  it("requests the selected replay in the current scope and keeps the overview usable while loading", () => {
    setApi(undefined, { isLoading: true });
    render(<BuildCompositionExplorer payload={payload()} apiPath={path} onOpenGames={vi.fn()} />);
    select("game-b");
    const [requestedPath] = api.useApi.mock.calls.at(-1)!;
    const query = new URL(requestedPath, "https://test.invalid");
    expect(query.searchParams.get("compareGameId")).toBe("game-b");
    expect(query.searchParams.get("map")).toBe("Map One");
    expect(query.searchParams.get("perspective")).toBe("you");
    expect(query.hash).toBe("#units");
    expect(screen.getByRole("status").textContent).toBe("Calculating this game’s comparison…");
    expect(screen.queryByRole("region", { name: "Selected game comparison" })).toBeNull();
    expect(screen.getByTestId("unit-summary-row").getAttribute("data-token")).toBe("Stalker");
  });

  it("hides stale comparisons when another game is selected or the selection leaves the cohort", () => {
    setApi(compared("game-a"));
    const initial = payload();
    const { rerender } = render(<BuildCompositionExplorer payload={initial} apiPath={path} onOpenGames={vi.fn()} />);
    select("game-a");
    expect(screen.getByRole("region", { name: "Selected game comparison" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open at 5:55" }).getAttribute("href")).toBe("/app/game/game-a?t=355");
    setApi(compared("game-a"), { isLoading: true });
    select("game-b");
    expect(screen.queryByRole("region", { name: "Selected game comparison" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Open at 5:55" })).toBeNull();
    expect(screen.queryByText("Comparison unavailable. The build overview remains available.")).toBeNull();
    setApi(compared("game-b"));
    rerender(<BuildCompositionExplorer payload={{ ...initial, comparisonGames: [initial.comparisonGames![0]] }} apiPath={path} onOpenGames={vi.fn()} />);
    expect((screen.getByRole("combobox", { name: /Compare a game/ }) as HTMLSelectElement).value).toBe("");
    expect(api.useApi.mock.calls.at(-1)![0]).toBeNull();
    expect(screen.queryByRole("region", { name: "Selected game comparison" })).toBeNull();
  });

  it("keeps the base overview on errors and offers an explicit retry", () => {
    setApi(compared("game-a"), { error: new Error("network unavailable") });
    render(<BuildCompositionExplorer payload={payload()} apiPath={path} onOpenGames={vi.fn()} />);
    select("game-a");
    expect(screen.getByText("Comparison unavailable. The build overview remains available.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Selected game comparison" })).toBeNull();
    expect(screen.getByTestId("unit-summary-row").getAttribute("data-token")).toBe("Stalker");
    fireEvent.click(screen.getByRole("button", { name: "Retry comparison" }));
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("identifies refreshing data while retaining the matching replay comparison", () => {
    setApi(compared("game-a"), { isValidating: true });
    render(<BuildCompositionExplorer payload={payload()} apiPath={path} onOpenGames={vi.fn()} />);
    select("game-a");
    expect(screen.getByRole("region", { name: "Selected game comparison" })).toBeTruthy();
    expect(screen.getByText("Refreshing comparison. Showing its previous sample until the updated analysis arrives.")).toBeTruthy();
    expect(screen.queryByText("Comparison unavailable. The build overview remains available.")).toBeNull();
  });

  it("refreshes the selected comparison when the base payload changes and uses its returned cohort context", () => {
    const initial = payload();
    const previousComparison = compared("game-a");
    setApi(previousComparison);
    const { rerender } = render(<BuildCompositionExplorer payload={initial} apiPath={path} onOpenGames={vi.fn()} />);
    select("game-a");
    expect(mutate).not.toHaveBeenCalled();

    const freshBase = payload({ comparisonGames: initial.comparisonGames!.slice(0, 3).map((game) => ({
      ...game, date: "2026-10-01T12:00:00Z",
    })), sampleTruncated: false });
    setApi(previousComparison, { isValidating: true });
    rerender(<BuildCompositionExplorer payload={freshBase} apiPath={path} onOpenGames={vi.fn()} />);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Refreshing comparison. Showing its previous sample until the updated analysis arrives.")).toBeTruthy();

    const refreshedComparison: BuildPhasePayload = {
      ...compared("game-a"), sampleTruncated: true, sampleLimit: 100,
      comparisonGames: initial.comparisonGames!.slice(0, 2).map((game, index) => ({
        ...game, date: `2026-09-0${index + 5}T12:00:00Z`, myRace: "Terran", oppRace: "Protoss",
      })),
    };
    setApi(refreshedComparison);
    rerender(<BuildCompositionExplorer payload={freshBase} apiPath={path} onOpenGames={vi.fn()} />);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(screen.getByText("2 sampled games")).toBeTruthy();
    expect(screen.queryByText("3 sampled games")).toBeNull();
    const format = (date: string) => new Date(date).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    expect(screen.getByText(`${format("2026-09-05T12:00:00Z")} – ${format("2026-09-06T12:00:00Z")}`)).toBeTruthy();
    expect(screen.queryByText(format("2026-10-01T12:00:00Z"))).toBeNull();
    expect(screen.getByText("Terran vs Protoss: 2")).toBeTruthy();
    expect(screen.getByText("Analysis is limited to the latest 100 matching games. Older matches are not included.")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Selected game comparison" })).toBeTruthy();
    expect(screen.queryByText(/Refreshing comparison/)).toBeNull();
  });

  it("offers recovery when an older API response does not include the requested comparison", () => {
    setApi(payload());
    render(<BuildCompositionExplorer payload={payload()} apiPath={path} onOpenGames={vi.fn()} />);
    select("game-a");
    expect(screen.queryByRole("region", { name: "Selected game comparison" })).toBeNull();
    expect(screen.getByRole("button", { name: "Retry comparison" })).toBeTruthy();
    expect(screen.getByTestId("unit-summary-row")).toBeTruthy();
  });

  it("allows clock samples even when opponent phase classification is unavailable", () => {
    render(<BuildCompositionExplorer payload={payload({ flags: ["opp_signals_sparse"], perspective: "opponent" })} apiPath={path} onOpenGames={vi.fn()} />);
    expect(screen.getByTestId("unit-summary-row")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "By phase" }));
    expect(screen.getByText("Opponent phases unavailable")).toBeTruthy();
    expect(screen.queryByTestId("unit-summary-row")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "At game time" }));
    expect(screen.getByTestId("unit-summary-row")).toBeTruthy();
  });

  it("handles an empty cohort without selecting fabricated games or checkpoints", () => {
    render(<BuildCompositionExplorer payload={payload({ comparisonGames: [], checkpoints: [] })} apiPath={path} onOpenGames={vi.fn()} />);
    expect((screen.getByRole("combobox", { name: /Compare a game/ }) as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByText("0 sampled games")).toBeTruthy();
    expect(screen.getByText("No time checkpoints available")).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });
});
