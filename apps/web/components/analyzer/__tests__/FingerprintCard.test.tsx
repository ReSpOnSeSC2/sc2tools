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
      position: 28,
      value: 3.913,
      category: "grinder",
      categoryLabel: "Consistent Grinder",
      sampleSize: 30,
    },
    {
      key: "pace",
      label: "Game horizon",
      position: 32,
      value: 489.46,
      category: "flexible",
      categoryLabel: "Flexible Pacer",
      sampleSize: 32,
    },
    {
      key: "matchup_balance",
      label: "Matchup shape",
      position: 0,
      value: 20.968,
      category: "specialist",
      categoryLabel: "Matchup Master",
      sampleSize: 91,
    },
  ],
  playstyle: "Apex Disciplined Operator",
  archetype: {
    key: "grinder|flexible|specialist",
    name: "Apex Disciplined Operator",
    description:
      "Your effective build pool rewards practiced variety. Your game-time profile is flexible. One matchup is a ten-point strength.",
    complete: true,
  },
  buildOrders: [
    { name: "PvZ - Stargate into Glaives", games: 11 },
    { name: "PvZ - Gate Expand", games: 8 },
    { name: "PvZ - 2 Stargate Void Ray", games: 5 },
    { name: "PvZ - Immortal Sentry", games: 4 },
    { name: "PvZ - DT Drop", games: 2 },
  ],
  repertoireSummary: {
    distinctBuilds: 5,
    effectiveBuilds: 3.913,
  },
  paceSummary: {
    averageSec: 489.46,
    medianSec: 480,
    belowFive: { games: 4, percent: 12.5 },
    fiveToSeven: { games: 6, percent: 18.75 },
    aboveSeven: { games: 22, percent: 68.75 },
    sevenToFifteen: { games: 18, percent: 56.25 },
    aboveFifteen: { games: 4, percent: 12.5 },
  },
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
    signedEdge: 10.968,
    tierScore: 2,
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
      screen.getByRole("heading", { name: "Apex Disciplined Operator" }),
    ).toBeTruthy();
    expect(screen.getByText("Complete profile")).toBeTruthy();
    expect(
      screen.getByText(/32 recent PvZ 1v1 replays, using up to your latest 50/),
    ).toBeTruthy();
    expect(screen.getByText("3 of 3 tracks ready")).toBeTruthy();
    expect(screen.getAllByTestId(/^fingerprint-axis-/)).toHaveLength(3);
    expect(screen.queryByTestId("fingerprint-axis-blind_spot")).toBeNull();

    const repertoire = screen.getByTestId("fingerprint-axis-repertoire");
    expect(within(repertoire).getAllByText("Consistent Grinder")).toHaveLength(2);
    expect(within(repertoire).getByText("3.91 effective")).toBeTruthy();
    expect(
      within(repertoire).getByText(
        /We detected 5 distinct builds across 30 classified PvZ replays/,
      ),
    ).toBeTruthy();
    expect(screen.getByTestId("fingerprint-marker-repertoire").getAttribute("style"))
      .toContain("left: 28%");

    const pace = screen.getByTestId("fingerprint-axis-pace");
    expect(within(pace).getAllByText("Flexible Pacer")).toHaveLength(2);
    expect(within(pace).getAllByText("8:09.46 avg").length).toBeGreaterThan(0);
    expect(
      within(pace).getByText(/uses the real time-band counts/),
    ).toBeTruthy();

    const matchup = screen.getByTestId("fingerprint-axis-matchup_balance");
    expect(within(matchup).getAllByText("Matchup Master")).toHaveLength(2);
    expect(within(matchup).getByText("All-Matchup Ace")).toBeTruthy();
    expect(within(matchup).getByText("Matchup Hurdle")).toBeTruthy();
    expect(within(matchup).getByText("Matchup Blind Spot")).toBeTruthy();
    expect(
      within(matchup).getByText(
        /PvZ leads your middle matchup by 10.968 percentage points/,
      ),
    ).toBeTruthy();

    expect(screen.getByText("PvZ - Stargate into Glaives")).toBeTruthy();
    expect(screen.getByText("70.968%")).toBeTruthy();
    expect(screen.getByText("20.968 percentage points best-to-worst")).toBeTruthy();
    expect(screen.getByText("+10.968 pts dominant gap")).toBeTruthy();
    expect(screen.getByText("Tier score +2")).toBeTruthy();
    expect(screen.getByText("8:00 median")).toBeTruthy();
    expect(screen.getByText("5 distinct")).toBeTruthy();
    expect(screen.getAllByText("3.91 effective").length).toBeGreaterThan(0);
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

    const buildStat = screen.getByText("Detected builds").closest("div");
    const effectiveStat = screen.getByText("Effective pool").closest("div");
    const paceStat = screen.getByText("Avg game").closest("div");
    expect(buildStat).toBeTruthy();
    expect(effectiveStat).toBeTruthy();
    expect(paceStat).toBeTruthy();
    expect(within(buildStat!).getByText("Still forming")).toBeTruthy();
    expect(within(effectiveStat!).getByText("Still forming")).toBeTruthy();
    expect(within(paceStat!).getByText("Still forming")).toBeTruthy();
  });

  it("shows missing duration shares as unavailable instead of inventing zeroes", () => {
    const zeroTimed = {
      ...FP,
      archetype: { ...FP.archetype, complete: false },
      axes: FP.axes.map((axis) =>
        axis.key === "pace"
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
      paceSummary: {
        averageSec: null,
        medianSec: null,
        belowFive: { games: 0, percent: null },
        fiveToSeven: { games: 0, percent: null },
        aboveSeven: { games: 0, percent: null },
        sevenToFifteen: { games: 0, percent: null },
        aboveFifteen: { games: 0, percent: null },
      },
    };
    useApiMock.mockReturnValue({ data: { fingerprint: zeroTimed }, isLoading: false });
    render(<FingerprintCard />);

    const distribution = screen
      .getByRole("heading", { name: "Game-time distribution" })
      .closest("section");
    expect(distribution).toBeTruthy();
    expect(within(distribution!).getAllByText("—")).toHaveLength(4);
    expect(
      within(distribution!).getByText(/0 valid timed replays are available/),
    ).toBeTruthy();
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
        key: "grinder|flexible|blind_spot",
        name: "Fault-Line Disciplined Operator",
        description:
          "A practiced build pool and flexible pace with one severe matchup weakness.",
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
        signedEdge: -10,
        tierScore: -2,
      },
    };
    useApiMock.mockReturnValue({
      data: { fingerprint: blindSpot },
      isLoading: false,
    });
    render(<FingerprintCard />);

    expect(
      screen.getByRole("heading", { name: "Fault-Line Disciplined Operator" }),
    ).toBeTruthy();
    const matchup = screen.getByTestId("fingerprint-axis-matchup_balance");
    expect(within(matchup).getAllByText("Matchup Blind Spot")).toHaveLength(2);
    expect(
      within(matchup).getByText(
        /PvT trails your middle matchup by 10 percentage points/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByTestId("fingerprint-marker-matchup_balance").getAttribute("style"),
    ).toContain("left: 100%");
  });

  it("renders a Two-Speed profile from the returned time-band counts", () => {
    const twoSpeed = {
      ...FP,
      axes: FP.axes.map((axis) =>
        axis.key === "pace"
          ? {
              ...axis,
              position: 50,
              value: 600,
              category: "two_speed",
              categoryLabel: "Two-Speed Player",
            }
          : axis,
      ),
      paceSummary: {
        averageSec: 600,
        medianSec: 540,
        belowFive: { games: 8, percent: 25 },
        fiveToSeven: { games: 6, percent: 18.75 },
        aboveSeven: { games: 18, percent: 56.25 },
        sevenToFifteen: { games: 10, percent: 31.25 },
        aboveFifteen: { games: 8, percent: 25 },
      },
      archetype: {
        ...FP.archetype,
        key: "grinder|two_speed|specialist",
        name: "Apex Tempo Gearbox",
      },
    };
    useApiMock.mockReturnValue({
      data: { fingerprint: twoSpeed },
      isLoading: false,
    });
    render(<FingerprintCard />);

    const pace = screen.getByTestId("fingerprint-axis-pace");
    expect(within(pace).getAllByText("Two-Speed Player")).toHaveLength(2);
    expect(screen.getByText(/8\/32 \(25%\) ended under 5:00/)).toBeTruthy();
    expect(screen.getByText(/8\/32 \(25%\) ran over 15:00/)).toBeTruthy();
  });

  it("renders the moderate Matchup Hurdle and its signed score", () => {
    const hurdle = {
      ...FP,
      axes: FP.axes.map((axis) =>
        axis.key === "matchup_balance"
          ? {
              ...axis,
              position: 75,
              value: 12.5,
              category: "matchup_hurdle",
              categoryLabel: "Matchup Hurdle",
            }
          : axis,
      ),
      matchupSummary: {
        ...FP.matchupSummary,
        spread: 12.5,
        leaderGap: 5,
        weakGap: 7.5,
        signedEdge: -7.5,
        tierScore: -1,
      },
      archetype: {
        ...FP.archetype,
        key: "grinder|flexible|matchup_hurdle",
        name: "Battle-Tested Disciplined Operator",
      },
    };
    useApiMock.mockReturnValue({ data: { fingerprint: hurdle }, isLoading: false });
    render(<FingerprintCard />);

    const matchup = screen.getByTestId("fingerprint-axis-matchup_balance");
    expect(within(matchup).getAllByText("Matchup Hurdle")).toHaveLength(2);
    expect(within(matchup).getByText(/a clear Matchup Hurdle/)).toBeTruthy();
    expect(screen.getByText("−7.5 pts dominant gap")).toBeTruthy();
    expect(screen.getByText("Tier score -1")).toBeTruthy();
    expect(
      screen.getByTestId("fingerprint-marker-matchup_balance").getAttribute("style"),
    ).toContain("left: 75%");
  });

  it("keeps a universal matchup profile neutral even when an adjacent gap is signed", () => {
    const universalist = {
      ...FP,
      axes: FP.axes.map((axis) =>
        axis.key === "matchup_balance"
          ? {
              ...axis,
              position: 50,
              value: 5,
              category: "universalist",
              categoryLabel: "All-Matchup Ace",
            }
          : axis,
      ),
      matchupWinRates: [
        { ...FP.matchupWinRates[0], winRate: 54 },
        { ...FP.matchupWinRates[1], winRate: 50 },
        { ...FP.matchupWinRates[2], winRate: 49 },
      ],
      matchupSummary: {
        ...FP.matchupSummary,
        spread: 5,
        leaderGap: 4,
        weakGap: 1,
        strongestMatchup: "PvP",
        weakestMatchup: "PvZ",
        signedEdge: 4,
        tierScore: 0,
      },
      archetype: {
        ...FP.archetype,
        key: "grinder|flexible|universalist",
        name: "Universal Disciplined Operator",
      },
    };
    useApiMock.mockReturnValue({
      data: { fingerprint: universalist },
      isLoading: false,
    });
    render(<FingerprintCard />);

    const matchup = screen.getByTestId("fingerprint-axis-matchup_balance");
    expect(within(matchup).getAllByText("All-Matchup Ace")).toHaveLength(2);
    expect(
      screen.getByTestId("fingerprint-marker-matchup_balance").getAttribute("style"),
    ).toContain("left: 50%");

    const performance = screen
      .getByRole("heading", { name: "Matchup performance" })
      .closest("section");
    expect(performance).toBeTruthy();
    expect(within(performance!).queryByText(/dominant gap/i)).toBeNull();
    expect(within(performance!).getByText("Tier score 0")).toBeTruthy();
    expect(
      within(performance!).getByText("5 percentage points best-to-worst"),
    ).toBeTruthy();
  });

  it("shows enough effective-build precision near a tier boundary", () => {
    const boundary = {
      ...FP,
      axes: FP.axes.map((axis) =>
        axis.key === "repertoire"
          ? {
              ...axis,
              position: 1,
              value: 1.503759,
              category: "signature",
              categoryLabel: "Signature Pilot",
            }
          : axis,
      ),
      repertoireSummary: {
        distinctBuilds: 2,
        effectiveBuilds: 1.503759,
      },
    };
    useApiMock.mockReturnValue({ data: { fingerprint: boundary }, isLoading: false });
    render(<FingerprintCard />);

    const repertoire = screen.getByTestId("fingerprint-axis-repertoire");
    expect(within(repertoire).getAllByText("Signature Pilot")).toHaveLength(2);
    expect(within(repertoire).getByText("1.503759 effective")).toBeTruthy();
  });

  it("documents every formula and exposes all 175 named archetypes", () => {
    useApiMock.mockReturnValue({ data: { fingerprint: FP }, isLoading: false });
    render(<FingerprintCard />);

    const summary = screen.getByText("How this fingerprint is calculated");
    const details = summary.closest("details");
    expect(details).toBeTruthy();
    expect(details!.open).toBe(false);
    fireEvent.click(summary);
    expect(details!.open).toBe(true);

    const guideText = details!.textContent ?? "";
    expect(guideText).toContain("1 ÷ Σp²");
    expect(guideText).toContain("5 detected builds and 3.91 effective");
    expect(guideText).toContain("as diverse as 3.91 builds played equally often");
    expect(guideText).toContain("1.50 or less is Build-Order One-Trick");
    expect(guideText).toContain("over 1.50 through 2.50 is Signature Pilot");
    expect(guideText).toContain("10 or more is Creative Genius");
    expect(guideText).toContain("at least 25% of games under 5:00");
    expect(guideText).toContain("Mid/Late-Game Master needs at least 80% over 7:00");
    expect(guideText).toContain("average from 5:00 through 15:00 is Flexible Pacer");
    expect(guideText).toContain("All three within 5 percentage points");
    expect(guideText).toContain("±7.5 marks are scoring anchors");
    expect(guideText).toContain("dominant +10-point gap is Matchup Master");
    expect(guideText).toContain("only wins and losses enter the win rates");
    expect(guideText).toContain("175 deterministic possibilities");

    const catalogSummary = screen.getByText("All 175 archetypes");
    const catalog = catalogSummary.closest("details");
    expect(catalog).toBeTruthy();
    expect(catalog!.open).toBe(false);
    fireEvent.click(catalogSummary);
    expect(catalog!.open).toBe(true);
    expect(within(catalog!).getAllByTestId("archetype-option")).toHaveLength(175);
    expect(within(catalog!).getByText("Apex Disciplined Operator")).toBeTruthy();
    expect(within(catalog!).getByText("Fault-Line Chaos Switchboard")).toBeTruthy();
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
