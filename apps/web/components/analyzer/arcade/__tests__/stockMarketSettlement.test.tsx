import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ARCADE_STATE_DEFAULT, type ArcadeState } from "../types";
import { portfolioPnlPct, pickReturn } from "../stockMarketPnl";

/**
 * Stock Market weeks never settled: the leaderboard only ever received
 * the 0% placeholder posted at lock-in, and nothing recorded a finished
 * week, so the Tycoon badge (5 green weeks) was unreachable.
 */

const settleStockMarket = vi.fn();
const apiCall = vi.fn(async (..._args: unknown[]) => ({}));
let mockState: ArcadeState;

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true, getToken: async () => "t" }),
  useUser: () => ({ isLoaded: true, user: { username: "tester" } }),
}));
vi.mock("@/lib/clientApi", () => ({ apiCall: (...args: unknown[]) => apiCall(...args) }));
vi.mock("../hooks/useArcadeState", () => ({
  useArcadeState: () => ({
    state: mockState,
    hydrated: true,
    update: vi.fn(),
    settleStockMarket,
  }),
}));

const QUOTES = [
  { id: "blink", name: "Blink", price: 50, source: "own" as const, plays: 30 },
  { id: "dts", name: "DTs", price: null, source: "own" as const, plays: 2 },
];

function lastWeekPortfolio(): ArcadeState["stockMarket"] {
  return {
    weekKey: "2026-W38",
    lockedAt: "2026-09-14T10:00:00Z",
    picks: [
      { slug: "blink", alloc: 60, entryPrice: 40, entryPlays: 30 },
      { slug: "dts", alloc: 40, entryPrice: 30, entryPlays: 2 },
    ],
  };
}

async function renderMarket() {
  const { stockMarket } = await import("../modes/games/stockMarket");
  const ctx = {
    question: { weekKey: "2026-W39", quotes: QUOTES, locked: null },
    answer: null,
    onAnswer: vi.fn(),
    score: null,
    revealed: false,
    isDaily: false,
  };
  return render(<>{stockMarket.render(ctx as never)}</>);
}

describe("P&L math", () => {
  test("weights volatility-adjusted returns and carries unpriced picks flat", () => {
    const picks = lastWeekPortfolio()!.picks;
    // Blink: +25% × 1.0 vol × 60% weight = +15%; DTs lost its price → 0.
    expect(portfolioPnlPct(picks, QUOTES)).toBe(15);
    expect(pickReturn(picks[1], null)).toBeNull();
  });

  test("low-play picks amplify returns up to the 2× cap", () => {
    const pick = { slug: "x", alloc: 100, entryPrice: 40, entryPlays: 1 };
    expect(portfolioPnlPct([pick], [{ id: "x", price: 50 }])).toBe(50);
  });
});

describe("weekly settlement", () => {
  beforeEach(() => {
    settleStockMarket.mockClear();
    apiCall.mockClear();
    mockState = {
      ...ARCADE_STATE_DEFAULT,
      stockMarket: lastWeekPortfolio(),
      leaderboardOptIn: true,
      leaderboardDisplayName: "Tester",
    };
  });
  afterEach(cleanup);

  test("settles last week's portfolio and posts its real P&L", async () => {
    await renderMarket();
    await waitFor(() => expect(settleStockMarket).toHaveBeenCalledWith("2026-W38", 15));
    expect(apiCall).toHaveBeenCalledWith(expect.any(Function), "/v1/arcade/leaderboard", {
      method: "POST",
      body: JSON.stringify({ weekKey: "2026-W38", pnlPct: 15, displayName: "Tester" }),
    });
  });

  test("a private lock settles without touching the leaderboard", async () => {
    mockState = { ...mockState, leaderboardOptIn: false };
    await renderMarket();
    await waitFor(() => expect(settleStockMarket).toHaveBeenCalledTimes(1));
    expect(apiCall).not.toHaveBeenCalled();
  });

  test("an already settled week is not settled again, and its result is shown", async () => {
    mockState = {
      ...mockState,
      stockMarketHistory: { "2026-W38": { pnlPct: 15, settledAt: "2026-09-21T00:00:00Z" } },
    };
    await renderMarket();
    expect(await screen.findByText("+15.0%")).toBeTruthy();
    expect(settleStockMarket).not.toHaveBeenCalled();
    expect(apiCall).not.toHaveBeenCalled();
  });

  test("this week's own portfolio is never settled early", async () => {
    mockState = { ...mockState, stockMarket: { ...lastWeekPortfolio()!, weekKey: "2026-W39" } };
    await renderMarket();
    expect(settleStockMarket).not.toHaveBeenCalled();
  });
});
