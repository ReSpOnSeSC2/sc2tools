import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ArcadeGame } from "@/components/analyzer/arcade/types";
import { DailyPulse } from "../DailyPulse";

/** The fixed "today" every fixture anchors on. */
const DAY = "2026-07-18";

const apiData = new Map<string, unknown>();
let analysisGames: ArcadeGame[] = [];
let analysisLoading = true;
let analysisActive = true;
let analysisError: { status: number; message: string } | null = null;
const loadAnalysis = vi.fn();
const releaseAnalysis = vi.fn();

vi.mock("@/lib/clientApi", () => ({
  useApi: (path: string | null) => {
    if (path && apiData.has(path)) {
      return { data: apiData.get(path), isLoading: false, error: null };
    }
    return { data: undefined, isLoading: !apiData.size, error: null };
  },
}));

vi.mock("@/components/analyzer/arcade/hooks/useAnalysisGames", () => ({
  useAnalysisGames: () => ({
    items: analysisGames,
    isLoading: analysisLoading,
    error: analysisError,
    pagesFetched: analysisLoading ? 0 : 1,
    hitCorpusLimit: false,
    isActive: analysisActive,
    load: loadAnalysis,
    release: releaseAnalysis,
  }),
}));

vi.mock("@/components/analyzer/arcade/hooks/useDailySeed", () => ({
  useDailySeed: () => ({
    tz: "UTC",
    day: DAY,
    rng: () => 0.5,
    userId: "u1",
  }),
}));

afterEach(cleanup);
beforeEach(() => {
  apiData.clear();
  analysisGames = [];
  analysisLoading = true;
  analysisActive = true;
  analysisError = null;
  loadAnalysis.mockReset();
  releaseAnalysis.mockReset();
  window.localStorage.clear();
});

let seq = 0;
function game(overrides: Partial<ArcadeGame> = {}): ArcadeGame {
  seq += 1;
  return {
    gameId: `g${seq}`,
    date: "2026-07-17T18:00:00Z",
    result: "Victory",
    ...overrides,
  };
}

function primeGames(
  items: ArcadeGame[],
  seasons: {
    mapPool?: string[];
    mapPoolSource?: "liquipedia" | "persisted" | "fallback";
    mapPoolFetchedAt?: number | null;
  } = { mapPool: [], mapPoolSource: "fallback" },
) {
  analysisGames = items;
  analysisLoading = false;
  apiData.set("/v1/seasons", seasons);
}

/** Yesterday session (3 games) + a 3-win streak → ≥1 timely card. */
function corpusWithSession(): ArcadeGame[] {
  return [
    game({ date: "2026-07-17T18:00:00Z" }),
    game({ date: "2026-07-17T19:00:00Z" }),
    game({ date: "2026-07-17T20:00:00Z" }),
  ];
}

describe("DailyPulse", () => {
  it("shows compact loading feedback", () => {
    render(<DailyPulse />);
    expect(screen.getByText("Loading replay insights…")).toBeTruthy();
  });

  it("keeps a release control when a loaded corpus has no eligible cards", () => {
    primeGames([]);
    render(<DailyPulse />);

    expect(
      screen.getByText(
        "No replay insights yet. More games will unlock your daily pulse.",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /daily pulse/i }));
    expect(releaseAnalysis).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByText(
        "No replay insights yet. More games will unlock your daily pulse.",
      ),
    ).toBeNull();
  });

  it("keeps full replay history dormant until Daily Pulse is requested", () => {
    analysisActive = false;
    analysisLoading = false;
    render(<DailyPulse />);

    expect(
      screen.getByText("Replay insights, loaded when you open them"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /daily pulse/i }));
    expect(loadAnalysis).toHaveBeenCalledTimes(1);
  });

  it("offers an in-place retry when corpus loading fails", () => {
    analysisLoading = false;
    analysisError = { status: 503, message: "Busy" };
    render(<DailyPulse />);

    expect(screen.getByText("Replay insights couldn’t load")).toBeTruthy();
    fireEvent.click(screen.getByText("Try again"));
    expect(loadAnalysis).toHaveBeenCalledTimes(1);
  });

  it("renders the day's cards from real games", () => {
    primeGames(corpusWithSession());
    render(<DailyPulse />);
    expect(screen.getByText("Daily Pulse")).toBeTruthy();
    // Yesterday's 3-0 session is the top-weight timely card.
    expect(screen.getByText("You banked a winning session")).toBeTruthy();
    expect(
      screen.getByText(/You played 3 games yesterday, went 3–0/),
    ).toBeTruthy();
  });

  it("deep-links a card into its analyzer tab", () => {
    primeGames(corpusWithSession());
    const onNavigate = vi.fn();
    render(<DailyPulse onNavigate={onNavigate} />);
    fireEvent.click(screen.getByText("You banked a winning session"));
    expect(onNavigate).toHaveBeenCalledWith("trends");
  });

  it("collapses and persists the choice", () => {
    primeGames(corpusWithSession());
    render(<DailyPulse />);
    fireEvent.click(screen.getByText("Daily Pulse"));
    expect(screen.queryByText("You banked a winning session")).toBeNull();
    expect(window.localStorage.getItem("analyzer.pulse.collapsed")).toBe("1");
    expect(releaseAnalysis).toHaveBeenCalledTimes(1);
  });

  it("uses the verified current pool only for Queue Thought map advice", () => {
    const currentMapGames = Array.from({ length: 6 }, (_, index) =>
      game({
        date: `2026-07-${String(8 + index).padStart(2, "0")}T12:00:00Z`,
        map: "Sanctuary III LE",
      }),
    );
    primeGames(currentMapGames, {
      mapPool: ["Sanctuary III"],
      mapPoolSource: "persisted",
      mapPoolFetchedAt: Date.now(),
    });
    render(<DailyPulse />);

    expect(screen.getByText("Sanctuary III LE is your happy place")).toBeTruthy();
    expect(screen.getByText(/100% over 6 recent games/)).toBeTruthy();

    cleanup();
    primeGames(currentMapGames, {
      mapPool: ["Sanctuary III"],
      mapPoolSource: "fallback",
    });
    render(<DailyPulse />);

    expect(
      screen.queryByText("Sanctuary III LE is your happy place"),
    ).toBeNull();

    cleanup();
    primeGames(currentMapGames, {
      mapPool: ["Sanctuary III"],
      mapPoolSource: "persisted",
      mapPoolFetchedAt: Date.now() - 9 * 24 * 60 * 60 * 1000,
    });
    render(<DailyPulse />);

    expect(
      screen.queryByText("Sanctuary III LE is your happy place"),
    ).toBeNull();
  });
});
