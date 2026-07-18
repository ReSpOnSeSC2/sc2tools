import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ArcadeGame } from "@/components/analyzer/arcade/types";
import { DailyPulse } from "../DailyPulse";

/** The fixed "today" every fixture anchors on. */
const DAY = "2026-07-18";

const apiData = new Map<string, unknown>();

vi.mock("@/lib/clientApi", () => ({
  useApi: (path: string | null) => {
    if (path && apiData.has(path)) {
      return { data: apiData.get(path), isLoading: false, error: null };
    }
    return { data: undefined, isLoading: !apiData.size, error: null };
  },
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

function primeGames(items: ArcadeGame[]) {
  apiData.set("/v1/games?limit=20000", { items });
  apiData.set("/v1/seasons", { mapPool: [] });
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
  it("renders nothing while loading or for an empty corpus", () => {
    const { container } = render(<DailyPulse />);
    expect(container.innerHTML).toBe("");

    primeGames([]);
    const { container: c2 } = render(<DailyPulse />);
    expect(c2.innerHTML).toBe("");
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
  });
});
