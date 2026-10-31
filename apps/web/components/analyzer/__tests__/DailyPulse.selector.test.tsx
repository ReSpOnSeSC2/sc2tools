import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DailyPulse } from "../DailyPulse";

const selectorLoads = vi.hoisted(() => ({ attempts: 0 }));
let analysisActive = false;
const loadAnalysis = vi.fn();
const GAMES = ["2026-07-17T18:00:00Z", "2026-07-17T19:00:00Z", "2026-07-17T20:00:00Z"].map((date, index) => ({
  gameId: `g${index}`,
  date,
  result: "Victory",
}));

// The card selection's chunk fails to load once (a deploy replaced it mid-visit), then loads.
vi.mock("@/lib/dailyPulse", async (importOriginal) => {
  selectorLoads.attempts += 1;
  if (selectorLoads.attempts === 1) throw new Error("chunk failed to load");
  return importOriginal();
});

vi.mock("@/lib/clientApi", () => ({
  useApi: (path: string | null) =>
    path === "/v1/seasons"
      ? { data: { mapPool: [], mapPoolSource: "fallback" }, isLoading: false, error: null }
      : { data: undefined, isLoading: false, error: null },
}));

vi.mock("@/components/analyzer/arcade/hooks/useAnalysisGames", () => ({
  useAnalysisGames: () => ({
    items: GAMES,
    isLoading: false,
    error: null,
    pagesFetched: 1,
    hitCorpusLimit: false,
    isActive: analysisActive,
    load: loadAnalysis,
    release: vi.fn(),
  }),
}));

vi.mock("@/components/analyzer/arcade/hooks/useDailySeed", () => ({
  useDailySeed: () => ({ tz: "UTC", day: "2026-07-18", rng: () => 0.5, userId: "u1" }),
}));

afterEach(cleanup);

describe("DailyPulse's card selection, loaded on demand", () => {
  it("loads only once the history is asked for, and offers Try again when it cannot load", async () => {
    const view = render(<DailyPulse />);
    expect(screen.getByRole("button", { name: "Show insights" })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(selectorLoads.attempts).toBe(0);

    analysisActive = true;
    view.rerender(<DailyPulse />);
    expect(screen.getByText("Loading replay insights…")).toBeTruthy();
    fireEvent.click(await screen.findByText("Try again"));
    expect(await screen.findByText("You banked a winning session")).toBeTruthy();
    expect(selectorLoads.attempts).toBe(2);
    // Try again loads the selection again, not the history.
    expect(loadAnalysis).not.toHaveBeenCalled();
  });
});
