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
      position: 75,
      value: 5,
      category: "adaptive",
      categoryLabel: "Adaptive Strategist",
      sampleSize: 30,
    },
    {
      key: "pace",
      label: "Game horizon",
      position: 45,
      value: 489.46,
      category: "standard",
      categoryLabel: "Flexible Pacer",
      sampleSize: 32,
    },
    {
      key: "matchup_balance",
      label: "Matchup shape",
      position: 12,
      value: 14,
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
      "A flexible build repertoire with standard pacing and one standout matchup.",
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
      winRate: 0.6,
    },
    {
      matchup: "PvT",
      games: 30,
      decidedGames: 30,
      wins: 15,
      losses: 15,
      ties: 0,
      winRate: 0.5,
    },
    {
      matchup: "PvZ",
      games: 32,
      decidedGames: 31,
      wins: 22,
      losses: 9,
      ties: 1,
      winRate: 0.71024,
    },
  ],
  matchupSummary: {
    spread: 21,
    leaderGap: 11.004,
    weakGap: 9.996,
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
    expect(screen.getByText(/32 recent PvZ 1v1 replays in a 50-game window/)).toBeTruthy();
    expect(screen.getByText("3 of 3 available")).toBeTruthy();
    expect(screen.getAllByTestId(/^fingerprint-axis-/)).toHaveLength(3);
    expect(screen.queryByTestId("fingerprint-axis-blind_spot")).toBeNull();

    const repertoire = screen.getByTestId("fingerprint-axis-repertoire");
    expect(within(repertoire).getAllByText("Adaptive Strategist")).toHaveLength(2);
    expect(within(repertoire).getByText("5 builds")).toBeTruthy();
    expect(within(repertoire).getByText(/5 distinct classified build orders/)).toBeTruthy();
    expect(screen.getByTestId("fingerprint-marker-repertoire").getAttribute("style"))
      .toContain("left: 75%");

    const pace = screen.getByTestId("fingerprint-axis-pace");
    expect(within(pace).getAllByText("Flexible Pacer")).toHaveLength(2);
    expect(within(pace).getAllByText("8:09.46 avg").length).toBeGreaterThan(0);

    const matchup = screen.getByTestId("fingerprint-axis-matchup_balance");
    expect(within(matchup).getAllByText("Matchup Specialist")).toHaveLength(2);
    expect(within(matchup).getByText("Completely Balanced")).toBeTruthy();
    expect(within(matchup).getByText("Matchup Blind Spot")).toBeTruthy();
    expect(
      within(matchup).getByText(
        /PvZ is the standout strength, leading both other matchups by at least 11.004 pp/,
      ),
    ).toBeTruthy();

    expect(screen.getByText("PvZ - Stargate into Glaives")).toBeTruthy();
    expect(screen.getByText("71.024%")).toBeTruthy();
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

    expect(screen.getAllByText("2 of 3 signals").length).toBeGreaterThan(0);
    const matchup = screen.getByTestId("fingerprint-axis-matchup_balance");
    expect(within(matchup).getByText("Not enough data")).toBeTruthy();
    expect(within(matchup).getByText(/Missing data never counts as zero/)).toBeTruthy();
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
        description: "Flexible plans with one matchup that trails the other two.",
        complete: true,
      },
      matchupSummary: {
        ...FP.matchupSummary,
        spread: 11.006,
        leaderGap: 1.002,
        weakGap: 10.004,
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
        /PvT is the standout weakness, trailing both other matchups by at least 10.004 pp/,
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
    expect(guide.getByText(/One or two is a Consistent Grinder/)).toBeTruthy();
    expect(guide.getByText(/Five minutes or less is Cheeser/)).toBeTruthy();
    expect(
      guide.getByText(/5 percentage points or less stays in the 40–60 near-balanced band/),
    ).toBeTruthy();
    expect(
      guide.getByText(/within 1 point is Matchup Universalist at dead center/),
    ).toBeTruthy();
    expect(guide.getByText(/dominant 10\+ point lead over both/)).toBeTruthy();
    expect(guide.getByText(/dominant 10\+ point deficit to both/)).toBeTruthy();
    expect(
      guide.getByText(
        /larger adjacent gap wins; an exact gap tie resolves to the original Matchup Specialist side/,
      ),
    ).toBeTruthy();
    expect(guide.getByText(/only wins and losses form the win-rate denominator/)).toBeTruthy();

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
