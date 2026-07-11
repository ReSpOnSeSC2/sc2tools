import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DailyQuests } from "../DailyQuests";
import type { ArcadeGame } from "../types";

/**
 * DailyQuests card — mocked dataset + fixed daily seed.
 *
 * The fixture corpus is crafted so EXACTLY three quests are eligible
 * (play-3, win-2, bounce-back: 6 games total, no macro_score / MMR /
 * map / build history, <8 games so the streak quest stays out), which
 * pins the selection regardless of the seeded shuffle order — the
 * assertions below are therefore deterministic without replicating the
 * RNG here.
 */

const DAY = "2026-07-11";

const useArcadeDataMock = vi.fn();
vi.mock("../hooks/useArcadeData", () => ({
  useArcadeData: () => useArcadeDataMock(),
}));

vi.mock("../hooks/useDailySeed", () => ({
  useDailySeed: () => ({
    tz: "UTC",
    day: "2026-07-11",
    userId: "quest-tester",
    rng: () => 0.5,
  }),
}));

// Signed-out auth → useArcadeState hydrates immediately and stays
// purely local (no network flush) — same setup recordsTracking uses.
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({
    isLoaded: true,
    isSignedIn: false,
    getToken: async () => null,
  }),
}));

afterEach(() => {
  cleanup();
  useArcadeDataMock.mockReset();
});

function fixtureGames(): ArcadeGame[] {
  return [
    // Four decided games yesterday — corpus padding (must NOT count today).
    { gameId: "y1", date: "2026-07-10T10:00:00Z", result: "Win" },
    { gameId: "y2", date: "2026-07-10T11:00:00Z", result: "Loss" },
    { gameId: "y3", date: "2026-07-10T12:00:00Z", result: "Win" },
    { gameId: "y4", date: "2026-07-10T13:00:00Z", result: "Loss" },
    // Today: a loss then a win → bounce-back completes.
    { gameId: "t1", date: `${DAY}T10:00:00Z`, result: "Loss" },
    { gameId: "t2", date: `${DAY}T11:00:00Z`, result: "Win" },
  ];
}

describe("DailyQuests", () => {
  it("renders three quests with progress reflecting today's games", () => {
    useArcadeDataMock.mockReturnValue({ data: { games: fixtureGames() }, loading: false });
    render(<DailyQuests />);

    expect(screen.getAllByRole("progressbar")).toHaveLength(3);
    // play-3: 2 of today's games played.
    expect(
      screen.getByRole("progressbar", { name: "Warm up the ladder: 2 of 3" }),
    ).toBeTruthy();
    // win-2: 1 win today.
    expect(screen.getByRole("progressbar", { name: "Double up: 1 of 2" })).toBeTruthy();
    // bounce-back: the loss→win sequence completed it.
    expect(screen.getByRole("progressbar", { name: "Bounce back: 1 of 1" })).toBeTruthy();
  });

  it("auto-claims a completed quest and shows the claimed state", async () => {
    useArcadeDataMock.mockReturnValue({ data: { games: fixtureGames() }, loading: false });
    render(<DailyQuests />);

    // bounce-back (30 XP) is done → claimed exactly once.
    expect(await screen.findByText(/claimed \+30 xp/i)).toBeTruthy();
    // Header tally reflects one of three quests done.
    expect(screen.getByText("1/3 done")).toBeTruthy();
    // The two unfinished quests still show their unclaimed XP badges.
    expect(screen.getByText("+20 XP")).toBeTruthy();
    expect(screen.getByText("+30 XP")).toBeTruthy();
  });

  it("shows the empty state for a fresh account (<1 game ever)", () => {
    useArcadeDataMock.mockReturnValue({ data: { games: [] }, loading: false });
    render(<DailyQuests />);
    expect(screen.getByText(/quests unlock with your first game/i)).toBeTruthy();
    expect(screen.queryAllByRole("progressbar")).toHaveLength(0);
  });

  it("shows a skeleton while the dataset is still loading", () => {
    useArcadeDataMock.mockReturnValue({ data: null, loading: true });
    render(<DailyQuests />);
    expect(screen.getByText("Daily Quests")).toBeTruthy();
    expect(screen.queryAllByRole("progressbar")).toHaveLength(0);
  });
});
