import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { FingerprintCard } from "../FingerprintCard";

const useApiMock = vi.fn();
vi.mock("@/lib/clientApi", () => ({
  useApi: (...args: unknown[]) => useApiMock(...args),
}));

afterEach(() => {
  cleanup();
  useApiMock.mockReset();
  window.localStorage.clear();
});

const FP = {
  matchup: "PvZ",
  race: "P",
  games: 32,
  windowGames: 50,
  axes: [
    {
      key: "repertoire",
      label: "Build repertoire",
      position: 38,
      value: 5,
      category: "adaptive",
      categoryLabel: "Adaptive Strategist",
      sampleSize: 30,
    },
    {
      key: "pace",
      label: "Game horizon",
      position: 32,
      value: 489.46,
      category: "standard",
      categoryLabel: "Flexible Pacer",
      sampleSize: 32,
    },
    {
      key: "matchup_balance",
      label: "Matchup shape",
      position: 0,
      value: 20.968,
      category: "specialist",
      categoryLabel: "Matchup Specialist",
      sampleSize: 91,
    },
  ],
  playstyle: "Strategic Specialist",
  archetype: {
    key: "adaptive|standard|specialist",
    name: "Strategic Specialist",
    description:
      "You use 3-9 build orders in this matchup, giving you options without changing plans every game. Your average game is longer than 5:00 but shorter than 15:00, mixing early pressure, mid-game play, and transitions. One matchup is at least 10% stronger than both of your other matchups.",
    complete: true,
  },
  buildOrders: [
    { name: "PvZ - Stargate into Glaives", games: 11 },
    { name: "PvZ - Gate Expand", games: 8 },
    { name: "PvZ - 2 Stargate Void Ray", games: 5 },
    { name: "PvZ - Immortal Sentry", games: 4 },
    { name: "PvZ - DT Drop", games: 2 },
  ],
  matchupWinRates: [
    {
      matchup: "PvP",
      games: 31,
      decidedGames: 30,
      wins: 18,
      losses: 12,
      ties: 1,
      winRate: 60,
    },
    {
      matchup: "PvT",
      games: 30,
      decidedGames: 30,
      wins: 15,
      losses: 15,
      ties: 0,
      winRate: 50,
    },
    {
      matchup: "PvZ",
      games: 32,
      decidedGames: 31,
      wins: 22,
      losses: 9,
      ties: 1,
      winRate: 70.968,
    },
  ],
  matchupSummary: {
    spread: 20.968,
    leaderGap: 10.968,
    weakGap: 10,
    strongestMatchup: "PvZ",
    weakestMatchup: "PvT",
  },
};

describe("FingerprintCard", () => {
  it("requests the fingerprint endpoint for the default matchup", () => {
    useApiMock.mockReturnValue({ data: undefined, isLoading: true });
    render(<FingerprintCard />);
    expect(useApiMock).toHaveBeenCalledWith(
      "/v1/me/fingerprint?matchup=PvZ",
      { revalidateOnFocus: false },
    );
  });

  it("shows a skeleton while loading", () => {
    useApiMock.mockReturnValue({ data: undefined, isLoading: true });
    render(<FingerprintCard />);
    expect(screen.getByText("Skill fingerprint")).toBeTruthy();
  });

  it("renders the real archetype, three spectra, and their replay evidence", () => {
    useApiMock.mockReturnValue({ data: { fingerprint: FP }, isLoading: false });
    render(<FingerprintCard />);

    expect(
      screen.getByRole("heading", { name: "Strategic Specialist" }),
    ).toBeTruthy();
    expect(screen.getByText("Complete profile")).toBeTruthy();
    expect(
      screen.getByText(/32 recent PvZ 1v1 replays, using up to your latest 50/),
    ).toBeTruthy();
    expect(screen.getByText("3 of 3 tracks ready")).toBeTruthy();
    expect(screen.getAllByTestId(/^fingerprint-axis-/)).toHaveLength(3);
    expect(screen.queryByTestId("fingerprint-axis-blind_spot")).toBeNull();

    const repertoire = screen.getByTestId("fingerprint-axis-repertoire");
    expect(within(repertoire).getAllByText("Adaptive Strategist")).toHaveLength(2);
    expect(within(repertoire).getByText("5 builds")).toBeTruthy();
    expect(
      within(repertoire).getByText(
        /We recognized 5 different builds across 30 recent PvZ replays/,
      ),
    ).toBeTruthy();
    expect(screen.getByTestId("fingerprint-marker-repertoire").getAttribute("style"))
      .toContain("left: 38%");

    const pace = screen.getByTestId("fingerprint-axis-pace");
    expect(within(pace).getAllByText("Flexible Pacer")).toHaveLength(2);
    expect(within(pace).getAllByText("8:09.46 avg").length).toBeGreaterThan(0);

    const matchup = screen.getByTestId("fingerprint-axis-matchup_balance");
    expect(within(matchup).getAllByText("Matchup Specialist")).toHaveLength(2);
    expect(within(matchup).getByText("Completely Balanced")).toBeTruthy();
    expect(within(matchup).getByText("Matchup Blind Spot")).toBeTruthy();
    expect(
      within(matchup).getByText(
        /You win PvZ at least 10.968% more often than either of your other matchups/,
      ),
    ).toBeTruthy();

    expect(screen.getByText("PvZ - Stargate into Glaives")).toBeTruthy();
    expect(screen.getByText("70.968%")).toBeTruthy();
    expect(screen.getByText("20.968% between best and worst")).toBeTruthy();
    expect(screen.queryByText(/\bpp\b/i)).toBeNull();
    expect(screen.queryByText(/MMR percentile/)).toBeNull();
  });

  it("keeps a missing signal visibly unclassified instead of plotting zero", () => {
    const sparse = {
      ...FP,
      archetype: {
        key: "incomplete",
        name: "Profile still forming",
        description: "Two signals are ready; matchup shape still needs games.",
        complete: false,
      },
      axes: FP.axes.map((axis) =>
        axis.key === "matchup_balance"
          ? {
              ...axis,
              position: null,
              value: null,
              category: null,
              categoryLabel: null,
              sampleSize: 0,
            }
          : axis,
      ),
    };
    useApiMock.mockReturnValue({
      data: { fingerprint: sparse },
      isLoading: false,
    });
    render(<FingerprintCard />);

    expect(screen.getAllByText("2 of 3 tracks ready").length).toBeGreaterThan(0);
    const matchup = screen.getByTestId("fingerprint-axis-matchup_balance");
    expect(within(matchup).getByText("Not enough data")).toBeTruthy();
    expect(within(matchup).getByText(/this track stays unranked/)).toBeTruthy();
    expect(screen.queryByTestId("fingerprint-marker-matchup_balance")).toBeNull();
    expect(screen.getByTestId("fingerprint-marker-repertoire")).toBeTruthy();
  });

  it("does not turn failed hero signals into zero-value facts", () => {
    const forming = {
      ...FP,
      archetype: { ...FP.archetype, complete: false },
      axes: FP.axes.map((axis) =>
        axis.key === "repertoire" || axis.key === "pace"
          ? {
              ...axis,
              position: null,
              value: null,
              category: null,
              categoryLabel: null,
              sampleSize: 8,
            }
          : axis,
      ),
    };
    useApiMock.mockReturnValue({ data: { fingerprint: forming }, isLoading: false });
    render(<FingerprintCard />);

    const buildStat = screen.getByText("Build orders").closest("div");
    const paceStat = screen.getByText("Avg game").closest("div");
    expect(buildStat).toBeTruthy();
    expect(paceStat).toBeTruthy();
    expect(within(buildStat!).getByText("Still forming")).toBeTruthy();
    expect(within(paceStat!).getByText("Still forming")).toBeTruthy();
  });

  it("renders a matchup blind spot at the opposite end of the spectrum", () => {
    const blindSpot = {
      ...FP,
      axes: FP.axes.map((axis) =>
        axis.key === "matchup_balance"
          ? {
              ...axis,
              position: 100,
              category: "blind_spot",
              categoryLabel: "Matchup Blind Spot",
            }
          : axis,
      ),
      archetype: {
        key: "adaptive|standard|blind_spot",
        name: "Strategic Soft Spot",
        description:
          "You use 3-9 build orders in this matchup, giving you options without changing plans every game. Your average game is longer than 5:00 but shorter than 15:00, mixing early pressure, mid-game play, and transitions. One matchup is at least 10% weaker than both of your other matchups.",
        complete: true,
      },
      matchupWinRates: FP.matchupWinRates.map((row) =>
        row.matchup === "PvZ"
          ? {
              ...row,
              decidedGames: 30,
              wins: 18,
              losses: 12,
              winRate: 60,
            }
          : row,
      ),
      matchupSummary: {
        ...FP.matchupSummary,
        spread: 10,
        leaderGap: 0,
        weakGap: 10,
      },
    };
    useApiMock.mockReturnValue({
      data: { fingerprint: blindSpot },
      isLoading: false,
    });
    render(<FingerprintCard />);

    expect(
      screen.getByRole("heading", { name: "Strategic Soft Spot" }),
    ).toBeTruthy();
    const matchup = screen.getByTestId("fingerprint-axis-matchup_balance");
    expect(within(matchup).getAllByText("Matchup Blind Spot")).toHaveLength(2);
    expect(
      within(matchup).getByText(
        /You win PvT at least 10% less often than either of your other matchups/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByTestId("fingerprint-marker-matchup_balance").getAttribute("style"),
    ).toContain("left: 100%");
  });

  it("documents every threshold and exposes all 36 named archetypes", () => {
    useApiMock.mockReturnValue({ data: { fingerprint: FP }, isLoading: false });
    render(<FingerprintCard />);

    const summary = screen.getByText("How this fingerprint is calculated");
    const details = summary.closest("details");
    expect(details).toBeTruthy();
    expect(details!.open).toBe(false);
    fireEvent.click(summary);
    expect(details!.open).toBe(true);

    const guide = within(details!);
    expect(guide.getByText(/One or two makes you a Consistent Grinder/)).toBeTruthy();
    expect(
      guide.getByText(/three to nine makes you an Adaptive Strategist/),
    ).toBeTruthy();
    expect(guide.getByText(/10 or more makes you a Creative Genius/)).toBeTruthy();
    expect(guide.getByText(/Five minutes or less makes you a Cheeser/)).toBeTruthy();
    expect(
      guide.getByText(/15 minutes or more makes you a Late-Game Specialist/),
    ).toBeTruthy();
    expect(
      guide.getByText(/within 5% of each other, your marker stays near the middle/),
    ).toBeTruthy();
    expect(
      guide.getByText(/within 1% is Completely Balanced/),
    ).toBeTruthy();
    expect(
      guide.getByText(/at least 10% better than each of the other two/),
    ).toBeTruthy();
    expect(
      guide.getByText(/at least 10% worse than each of the other two/),
    ).toBeTruthy();
    expect(
      guide.getByText(
        /larger gap decides; an exact tie goes to Matchup Specialist/,
      ),
    ).toBeTruthy();
    expect(
      guide.getByText(/only wins and losses count toward win rate/),
    ).toBeTruthy();

    const catalogSummary = screen.getByText("All 36 archetypes");
    const catalog = catalogSummary.closest("details");
    expect(catalog).toBeTruthy();
    expect(catalog!.open).toBe(false);
    fireEvent.click(catalogSummary);
    expect(catalog!.open).toBe(true);
    expect(within(catalog!).getAllByTestId("archetype-option")).toHaveLength(36);
    expect(within(catalog!).getByText("Strategic Specialist")).toBeTruthy();
    expect(within(catalog!).getByText("Endgame Soft Spot")).toBeTruthy();
    expect(within(catalog!).getByText("Your archetype")).toBeTruthy();
  });

  it("shows the friendly empty state below 10 games", () => {
    useApiMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: { status: 404, code: "not_enough_games", message: "Not found." },
    });
    render(<FingerprintCard />);
    expect(screen.getByText(/Not enough PvZ games yet/)).toBeTruthy();
    expect(screen.getByText(/at least 10 PvZ 1v1 games/)).toBeTruthy();
  });

  it("shows a generic failure state on other errors", () => {
    useApiMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: { status: 500, message: "boom" },
    });
    render(<FingerprintCard />);
    expect(screen.getByText(/Couldn't load your fingerprint/)).toBeTruthy();
  });

  it("matchup picker refetches and persists the selection", () => {
    useApiMock.mockReturnValue({ data: { fingerprint: FP }, isLoading: false });
    render(<FingerprintCard />);

    fireEvent.click(screen.getByRole("button", { name: "Versus Terran" }));
    expect(useApiMock).toHaveBeenLastCalledWith(
      "/v1/me/fingerprint?matchup=PvT",
      { revalidateOnFocus: false },
    );

    fireEvent.click(screen.getByRole("button", { name: "I play Zerg" }));
    expect(useApiMock).toHaveBeenLastCalledWith(
      "/v1/me/fingerprint?matchup=ZvT",
      { revalidateOnFocus: false },
    );
    expect(window.localStorage.getItem("analyzer.fingerprint.matchup")).toBe(
      "ZvT",
    );
    expect(
      screen
        .getByRole("button", { name: "I play Zerg" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
