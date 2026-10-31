import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DailyPulse } from "../DailyPulse";

// The card selection's chunk fails twice (a flaky connection, then a retry that fails too), then loads.
const selectorLoads = vi.hoisted(() => ({ attempts: 0, outcomes: ["fail", "fail"] as string[] }));
let analysisActive = false;
let analysisLoading = false;
const loadAnalysis = vi.fn();
const GAMES = ["2026-07-17T18:00:00Z", "2026-07-17T19:00:00Z", "2026-07-17T20:00:00Z"].map((date, index) => ({
  gameId: `g${index}`,
  date,
  result: "Victory",
}));

vi.mock("@/lib/dailyPulse", async (importOriginal) => {
  selectorLoads.attempts += 1;
  if (selectorLoads.outcomes.shift() === "fail") throw new Error("chunk failed to load");
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
    isLoading: analysisLoading,
    error: null,
    pagesFetched: analysisLoading ? 0 : 1,
    hitCorpusLimit: false,
    onDevice: false,
    syncedAt: analysisLoading ? null : 1_793_000_000_000,
    keepFailed: false,
    isActive: analysisActive,
    load: loadAnalysis,
    keepOnDevice: vi.fn(),
    release: vi.fn(),
  }),
}));

vi.mock("@/components/analyzer/arcade/hooks/useDailySeed", () => ({
  useDailySeed: () => ({ tz: "UTC", day: "2026-07-18", rng: () => 0.5, userId: "u1" }),
}));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const idle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("DailyPulse's card selection, loaded on demand", () => {
  it("is never loaded behind the gate or while Daily Pulse is closed", async () => {
    render(<DailyPulse />);
    expect(screen.getByRole("button", { name: "Load my history" })).toBeTruthy();
    await idle();
    cleanup();

    window.localStorage.setItem("analyzer.pulse.collapsed", "1");
    render(<DailyPulse />);
    expect(screen.getByRole("button", { name: /daily pulse/i }).getAttribute("aria-expanded")).toBe("false");
    await idle();
    expect(selectorLoads.attempts).toBe(0);
  });

  it("loads with the history, offers Try again then a reload, and recovers on a later attempt", async () => {
    analysisActive = true;
    analysisLoading = true;
    const view = render(<DailyPulse />);
    expect(screen.getByText("Loading replay insights…")).toBeTruthy();
    // Requested while the history is still loading.
    await waitFor(() => expect(selectorLoads.attempts).toBe(1));

    analysisLoading = false;
    view.rerender(<DailyPulse />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    // Try again fails too: the chunk is likely gone, so it asks for a reload.
    expect(await screen.findByRole("button", { name: "Reload page" })).toBeTruthy();
    expect(screen.getByText("Replay insights couldn’t load. Reload the page to try again.")).toBeTruthy();
    expect(selectorLoads.attempts).toBe(2);
    // Try again loads the selection again, not the history.
    expect(loadAnalysis).not.toHaveBeenCalled();

    // Closing and reopening tries once more by itself; this time it loads, and the failure goes.
    fireEvent.click(screen.getByText("Daily Pulse"));
    analysisActive = false;
    view.rerender(<DailyPulse />);
    fireEvent.click(screen.getByRole("button", { name: /daily pulse/i }));
    analysisActive = true;
    view.rerender(<DailyPulse />);
    expect(await screen.findByText("You banked a winning session")).toBeTruthy();
    expect(screen.queryByText(/couldn’t load/)).toBeNull();
    expect(selectorLoads.attempts).toBe(3);
  });

  it("shows the cards at once on a later Daily Pulse once the selection has loaded", () => {
    analysisActive = true;
    analysisLoading = false;
    render(<DailyPulse />);
    expect(screen.getByText("You banked a winning session")).toBeTruthy();
    expect(selectorLoads.attempts).toBe(3);
  });
});
