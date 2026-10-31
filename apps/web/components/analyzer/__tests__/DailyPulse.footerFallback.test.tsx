import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DailyPulse } from "../DailyPulse";

let analysisError: { status: number; message: string } | null = null;
const loadAnalysis = vi.fn();
const GAMES = ["2026-07-17T18:00:00Z", "2026-07-17T19:00:00Z", "2026-07-17T20:00:00Z"].map((date, index) => ({
  gameId: `g${index}`,
  date,
  result: "Victory",
}));

// A deploy replaced the footer's chunk, so it cannot load.
vi.mock("../DailyPulseFooter", () => {
  throw new Error("chunk failed to load");
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
    error: analysisError,
    pagesFetched: 1,
    hitCorpusLimit: false,
    onDevice: false,
    syncedAt: null,
    keepFailed: false,
    isActive: true,
    load: loadAnalysis,
    keepOnDevice: vi.fn(),
    release: vi.fn(),
  }),
}));

vi.mock("@/components/analyzer/arcade/hooks/useDailySeed", () => ({
  useDailySeed: () => ({ tz: "UTC", day: "2026-07-18", rng: () => 0.5, userId: "u1" }),
}));

afterEach(cleanup);

describe("DailyPulse without its footer chunk", () => {
  it("still offers Try again after a failed update, and nothing otherwise", async () => {
    analysisError = { status: 503, message: "Busy" };
    const view = render(<DailyPulse />);
    expect(screen.getByText("You banked a winning session")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(loadAnalysis).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Couldn’t update")).toBeTruthy();
    expect(screen.queryByText("Replay insights couldn’t load")).toBeNull();

    analysisError = null;
    view.rerender(<DailyPulse />);
    expect(screen.getByText("You banked a winning session")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByText("Couldn’t update")).toBeNull();
  });
});
