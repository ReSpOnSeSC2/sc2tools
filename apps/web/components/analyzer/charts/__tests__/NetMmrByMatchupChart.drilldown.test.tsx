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
  NetMmrRaceOpponentsModal: ({ race }: { race: string | null }) =>
    race ? <div data-testid="race-drilldown">Drill-down {race}</div> : null,
}));

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  BarChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Bar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
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
          { race: "P", netMmr: 120, avgDelta: 4, pairs: 30, games: 30, wins: 18, losses: 12, winRate: 0.6 },
          { race: "T", netMmr: -75, avgDelta: -3, pairs: 25, games: 25, wins: 11, losses: 14, winRate: 0.44 },
        ],
        totalGames: 56,
        eligibleGames: 56,
        dropped: { terminalGame: 1 },
      },
      isLoading: false,
    });

    render(<NetMmrByMatchupChart />);

    const protoss = screen.getByRole("button", {
      name: "View MMR impact by Protoss opponent",
    });
    expect(protoss.getAttribute("aria-haspopup")).toBe("dialog");
    expect(screen.queryByTestId("race-drilldown")).toBeNull();

    fireEvent.click(protoss);
    expect(screen.getByTestId("race-drilldown").textContent).toBe("Drill-down P");
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
            race: "Z",
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
            race: "Z",
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
});
