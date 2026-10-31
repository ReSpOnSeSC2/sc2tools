import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DailyPulse } from "../DailyPulse";

let analysisError: { status: number; message: string } | null = null;
let analysisSyncedAt: number | null = null;
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
    syncedAt: analysisSyncedAt,
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
  it("still offers Try again after a failed update, keeping focus on it through the retry", async () => {
    analysisError = { status: 503, message: "Busy" };
    const view = render(<DailyPulse />);
    expect(await screen.findByText("You banked a winning session")).toBeTruthy();
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(screen.getByRole("status").textContent).toBe("Couldn’t update");
    expect(screen.queryByText("Replay insights couldn’t load")).toBeNull();
    retry.focus();
    fireEvent.click(retry);
    expect(loadAnalysis).toHaveBeenCalledTimes(1);

    // The retry runs: the same button stays, held, with focus.
    analysisError = null;
    view.rerender(<DailyPulse />);
    expect(screen.getByRole("status").textContent).toBe("Updating…");
    const refresh = screen.getByRole("button", { name: "Refresh" });
    expect(refresh).toBe(retry);
    expect(refresh.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(refresh);
    fireEvent.click(refresh);
    expect(loadAnalysis).toHaveBeenCalledTimes(1);

    analysisSyncedAt = Date.now();
    view.rerender(<DailyPulse />);
    expect(screen.getByRole("status").textContent).toBe("Updated");
    expect(screen.getByText("You banked a winning session")).toBeTruthy();
  });
});
