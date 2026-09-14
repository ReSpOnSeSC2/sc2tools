import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NetMmrByMatchupChart } from "../NetMmrByMatchupChart";

const useApiMock = vi.fn();

vi.mock("@/lib/clientApi", () => ({
  useApi: (...args: unknown[]) => useApiMock(...args),
}));

vi.mock("@/lib/filterContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/filterContext")>();
  return {
    ...actual,
    useFilters: () => ({ filters: {}, dbRev: 3 }),
  };
});

vi.mock("../NetMmrRaceOpponentsModal", () => ({
  NetMmrRaceOpponentsModal: ({ race, myRace }: { race: string | null; myRace: string | null }) =>
    race ? <div data-testid="race-drilldown">Drill-down {myRace}v{race}</div> : null,
}));

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  BarChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Bar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  ReferenceLine: () => null,
  Cell: () => null,
}));

afterEach(() => {
  cleanup();
  useApiMock.mockReset();
});

describe("NetMmrByMatchupChart opponent drill-down", () => {
  it("makes each matchup summary an accessible dialog launcher", () => {
    useApiMock.mockReturnValue({
      data: {
        matchups: [
          { matchup: "PvP", myRace: "P", opponentRace: "P", netMmr: 120, avgDelta: 4, pairs: 30, games: 30, wins: 18, losses: 12, winRate: 0.6 },
          { matchup: "PvT", myRace: "P", opponentRace: "T", netMmr: -75, avgDelta: -3, pairs: 25, games: 25, wins: 11, losses: 14, winRate: 0.44 },
        ],
        totalGames: 56,
        eligibleGames: 56,
        dropped: { terminalGame: 1 },
      },
      isLoading: false,
    });

    render(<NetMmrByMatchupChart />);

    const protoss = screen.getByRole("button", {
      name: "View PvP MMR impact by opponent",
    });
    expect(protoss.getAttribute("aria-haspopup")).toBe("dialog");
    expect(screen.queryByTestId("race-drilldown")).toBeNull();

    fireEvent.click(protoss);
    expect(screen.getByTestId("race-drilldown").textContent).toBe("Drill-down PvP");
    expect(
      screen.getByText(/30 measured games.*60.0% WR.*avg \+4\/game/),
    ).toBeTruthy();
    expect(
      screen.getByText(/55 measured games from 56 eligible ranked 1v1 games/),
    ).toBeTruthy();
    expect(
      screen.getByText(/1 sequence-ending game has no later MMR reading/),
    ).toBeTruthy();
  });

  it("explains a 75-game race cohort with 66 measurable MMR results", () => {
    useApiMock.mockReturnValue({
      data: {
        matchups: [
          {
            matchup: "TvZ", myRace: "T", opponentRace: "Z",
            netMmr: -185,
            avgDelta: -2.8,
            pairs: 66,
            games: 66,
            wins: 38,
            losses: 28,
            winRate: 38 / 66,
          },
        ],
        coverage: [
          {
            matchup: "TvZ",
            totalGames: 75,
            eligibleGames: 75,
            measuredGames: 66,
            dropped: { terminalGame: 9 },
          },
        ],
        totalGames: 75,
        eligibleGames: 75,
        dropped: { terminalGame: 9 },
      },
      isLoading: false,
    });

    render(<NetMmrByMatchupChart />);

    expect(
      screen.getByText(/66 of 75 games measured.*57.6% WR.*avg -2.8\/game/),
    ).toBeTruthy();
    expect(
      screen.getByText(/Not measured: 9 sequence-ending \(no later reading\)/),
    ).toBeTruthy();
    expect(
      screen.getByText(/9 sequence-ending games have no later MMR reading/),
    ).toBeTruthy();
  });

  it("lists all played matchups in the requested order and does not invent MMR for unmeasured games", () => {
    const order = ["PvP", "PvZ", "PvT", "TvT", "TvZ", "TvP", "ZvZ", "ZvT", "ZvP"];
    useApiMock.mockReturnValue({ data: {
      matchups: order.slice(0, 8).reverse().map((matchup) => ({
        matchup, myRace: matchup[0], opponentRace: matchup[2],
        netMmr: 25, avgDelta: 25, pairs: 1, games: 1, wins: 1, losses: 0, winRate: 1,
      })),
      coverage: order.map((matchup, index) => ({
        matchup, totalGames: 1, eligibleGames: 1, measuredGames: index === 8 ? 0 : 1,
        dropped: index === 8 ? { terminalGame: 1 } : {},
      })), totalGames: 9, eligibleGames: 9,
    }, isLoading: false });
    render(<NetMmrByMatchupChart />);
    const tiles = screen.getAllByRole("button").filter((button) => button.getAttribute("aria-haspopup") === "dialog");
    expect(tiles.map((button) => button.textContent?.slice(0, 3))).toEqual(order);
    const unmeasured = screen.getByRole("button", { name: "ZvP: no measured MMR changes" });
    expect(unmeasured.hasAttribute("disabled")).toBe(true);
    expect(unmeasured.textContent).toContain("—");
    expect(unmeasured.textContent).toContain("0 of 1 games measured");
    expect(unmeasured.textContent).not.toContain("0.0% WR");
    fireEvent.click(screen.getByRole("button", { name: "View TvZ MMR impact by opponent" }));
    expect(screen.getByTestId("race-drilldown").textContent).toBe("Drill-down TvZ");
  });
});
