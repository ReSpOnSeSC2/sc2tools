import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrendsDataProvider } from "@/lib/trendsDataContext";
import { MatchupOverTimeChart } from "../MatchupOverTimeChart";

const useApiMock = vi.fn();
const useFiltersMock = vi.fn();

vi.mock("@/lib/clientApi", () => ({
  useApi: (...args: unknown[]) => useApiMock(...args),
}));

vi.mock("@/lib/filterContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/filterContext")>();
  return { ...actual, useFilters: () => useFiltersMock() };
});

vi.mock("@/lib/timeseries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/timeseries")>();
  return { ...actual, clientTimezone: () => "UTC" };
});

// Inspect the data delivered to the chart renderer without depending on SVG
// measurements in jsdom. The real chart component still builds every panel.
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ComposedChart: ({ children, data }: { children: ReactNode; data: unknown }) => (
    <div data-testid="matchup-series" data-series={JSON.stringify(data)}>{children}</div>
  ),
  Line: ({ dataKey }: { dataKey: string }) => <span data-testid="matchup-line" data-key={dataKey} />,
  XAxis: ({ domain }: { domain: number[] }) => <span data-testid="date-axis" data-domain={JSON.stringify(domain)} />,
  YAxis: () => null,
  Tooltip: () => null,
  CartesianGrid: () => null,
  ReferenceLine: () => null,
}));

const MATCHUP_ORDER = ["PvP", "PvZ", "PvT", "TvT", "TvZ", "TvP", "ZvZ", "ZvT", "ZvP"];

function point(bucket: string, matchup: string, wins: number, losses: number, total = wins + losses) {
  return {
    bucket,
    matchup,
    myRace: matchup[0],
    race: matchup[2],
    wins,
    losses,
    total,
    winRate: total ? wins / total : 0,
  };
}

beforeEach(() => {
  useFiltersMock.mockReturnValue({ filters: {}, dbRev: 7 });
  useApiMock.mockReturnValue({ data: { interval: "week", points: [] }, isLoading: false });
});

afterEach(() => {
  cleanup();
  useApiMock.mockReset();
  useFiltersMock.mockReset();
});

describe("MatchupOverTimeChart played matchups", () => {
  it.each(["personal", "global"] as const)("requests full matchup grouping and preserves %s filters", (mode) => {
    useFiltersMock.mockReturnValue({
      filters: { race: "P", map: "Gold Base", since: "2026-07-01T00:00:00Z", mmr_min: 3000 },
      dbRev: 7,
    });

    render(
      <TrendsDataProvider mode={mode} cohort={{ excluded_players: ["1-S2-1-123"], excluded_races: ["Z"], player_mmr_min: 4000 }}>
        <MatchupOverTimeChart bucket="week" />
      </TrendsDataProvider>,
    );

    const url = new URL(String(useApiMock.mock.calls[0][0]), "https://example.test");
    expect(url.pathname).toBe(mode === "global" ? "/v1/admin/global-trends/timeseries/matchups" : "/v1/timeseries/matchups");
    expect(url.searchParams.get("group_by")).toBe("matchup");
    expect(url.searchParams.get("interval")).toBe("day");
    expect(url.searchParams.get("tz")).toBe("UTC");
    expect(url.searchParams.get("race")).toBe("P");
    expect(url.searchParams.get("map")).toBe("Gold Base");
    expect(url.searchParams.get("since")).toBe("2026-07-01T00:00:00Z");
    expect(url.searchParams.get("mmr_min")).toBe("3000");
    expect(url.hash).toBe("#7");
    expect(url.searchParams.get("excluded_players")).toBe(mode === "global" ? "1-S2-1-123" : null);
    expect(url.searchParams.get("excluded_races")).toBe(mode === "global" ? "Z" : null);
    expect(url.searchParams.get("player_mmr_min")).toBe(mode === "global" ? "4000" : null);
  });

  it("lists all nine played matchups in the requested order regardless of response order", () => {
    useApiMock.mockReturnValue({
      data: { interval: "week", points: [...MATCHUP_ORDER].reverse().map((matchup) => point("2026-07-05T00:00:00Z", matchup, 1, 0)) },
      isLoading: false,
    });

    render(<MatchupOverTimeChart bucket="week" />);

    expect(screen.getAllByRole("heading", { level: 4 }).map((heading) => heading.textContent)).toEqual(MATCHUP_ORDER);
    expect(screen.getAllByRole("region")).toHaveLength(9);
    expect(within(screen.getByRole("region", { name: "PvT win rate over time" })).getByText("Protoss vs Terran")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "TvP win rate over time" })).getByText("Terran vs Protoss")).toBeTruthy();
  });

  it("shows only played concrete matchups and accounts for unresolved races separately", () => {
    useApiMock.mockReturnValue({
      data: {
        interval: "week",
        points: [
          point("2026-07-05T00:00:00Z", "ZvT", 2, 0),
          point("2026-07-05T00:00:00Z", "PvT", 0, 1),
          point("2026-07-05T00:00:00Z", "TvT", 0, 0),
          point("2026-07-05T00:00:00Z", "RvT", 1, 1),
          point("2026-07-05T00:00:00Z", "PvU", 1, 0),
        ],
      },
      isLoading: false,
    });

    render(<MatchupOverTimeChart bucket="week" />);

    expect(screen.getAllByRole("heading", { level: 4 }).map((heading) => heading.textContent)).toEqual(["PvT", "ZvT"]);
    expect(within(screen.getByRole("region", { name: "PvT win rate over time" })).getByText("1 game")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "ZvT win rate over time" })).getByText("2 games")).toBeTruthy();
    expect(screen.getByText(/3\b.*games.*(?:race|matchup)/i)).toBeTruthy();
  });

  it("keeps played matchups isolated and weights whole-period samples by games with a shared date axis", () => {
    useApiMock.mockReturnValue({
      data: {
        interval: "month",
        points: [
          // The total includes two records without a decided result. Preserve
          // the API's games denominator instead of silently removing them.
          point("2026-01-01T00:00:00Z", "PvT", 9, 1, 12),
          point("2026-01-01T00:00:00Z", "ZvT", 0, 3),
          point("2026-02-01T00:00:00Z", "ZvT", 1, 0),
          point("2026-03-01T00:00:00Z", "PvT", 0, 20),
          point("2026-04-01T00:00:00Z", "PvT", 1, 1),
          point("2026-05-01T00:00:00Z", "ZvT", 15, 15),
        ],
      },
      isLoading: false,
    });

    render(<MatchupOverTimeChart bucket="month" />);

    const protoss = screen.getByRole("region", { name: "PvT win rate over time" });
    const zerg = screen.getByRole("region", { name: "ZvT win rate over time" });
    expect(within(protoss).getByText("34 games")).toBeTruthy();
    expect(within(protoss).getByText("Overall 29.4%")).toBeTruthy();
    expect(within(zerg).getByText("34 games")).toBeTruthy();
    expect(within(zerg).getByText("Overall 47.1%")).toBeTruthy();
    expect(within(protoss).getByText(/2 other/)).toBeTruthy();

    const protossSeries = JSON.parse(within(protoss).getByTestId("matchup-series").getAttribute("data-series")!);
    expect(protossSeries).toHaveLength(2);
    expect(protossSeries[0]).toMatchObject({ date: "2026-03-01", sampleGames: 32, sampleWins: 9, sampleLosses: 21, rate: 9 / 32 * 100 });
    expect(protossSeries[1]).toMatchObject({ date: "2026-04-01", sampleGames: 34, sampleWins: 10, sampleLosses: 22, rate: 10 / 34 * 100 });
    const zergSeries = JSON.parse(within(zerg).getByTestId("matchup-series").getAttribute("data-series")!);
    expect(zergSeries).toHaveLength(1);
    expect(zergSeries[0]).toMatchObject({ date: "2026-05-01", sampleGames: 30, sampleWins: 15, sampleLosses: 15, rate: 50 });
    expect(within(protoss).getAllByTestId("matchup-line").map((line) => line.getAttribute("data-key"))).toEqual(["rate"]);
    expect(within(protoss).getByTestId("date-axis").getAttribute("data-domain")).toBe(within(zerg).getByTestId("date-axis").getAttribute("data-domain"));
  });

  it("shows the raw record but withholds a misleading trend for a one-game matchup", () => {
    useApiMock.mockReturnValue({ data: { interval: "day", points: [point("2026-07-05T00:00:00Z", "PvT", 1, 0)] }, isLoading: false });
    render(<MatchupOverTimeChart bucket="day" />);
    expect(screen.getByText("Building a sample")).toBeTruthy();
    expect(screen.getByText("1 / 30 games")).toBeTruthy();
    expect(screen.getByText(/Recorded so far:.*1W/)).toBeTruthy();
    expect(screen.queryByTestId("matchup-series")).toBeNull();
  });

  it("offers the same 30, 60, 100, and All sample controls as the win-rate card", () => {
    useApiMock.mockReturnValue({
      data: {
        interval: "day",
        points: [
          point("2026-07-01T00:00:00Z", "PvZ", 20, 20),
          point("2026-07-02T00:00:00Z", "PvZ", 15, 5),
          point("2026-07-02T00:00:00Z", "PvT", 1, 0),
        ],
      },
      isLoading: false,
    });
    render(<MatchupOverTimeChart bucket="day" />);
    const controls = screen.getByRole("group", { name: "Recent-form game sample" });
    expect(within(controls).getAllByRole("button").map((button) => button.textContent)).toEqual(["30", "60", "100", "All"]);
    expect(screen.getByRole("button", { name: "Target at least 30 games" }).getAttribute("aria-pressed")).toBe("true");
    const series = (region: string) => {
      const chart = within(screen.getByRole("region", { name: region })).queryByTestId("matchup-series");
      return chart ? JSON.parse(chart.getAttribute("data-series")!) : null;
    };
    expect(series("PvZ win rate over time")).toHaveLength(2);
    expect(series("PvT win rate over time")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Target at least 60 games" }));
    expect(series("PvZ win rate over time")).toEqual([expect.objectContaining({ date: "2026-07-02", sampleGames: 60, rate: 35 / 60 * 100 })]);

    fireEvent.click(screen.getByRole("button", { name: "Target at least 100 games" }));
    expect(series("PvZ win rate over time")).toBeNull();
    expect(screen.getByText("60 / 100 games")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Include all games" }));
    expect(series("PvZ win rate over time")).toEqual([
      expect.objectContaining({ date: "2026-07-01", sampleGames: 40, rate: 50 }),
      expect.objectContaining({ date: "2026-07-02", sampleGames: 60, rate: 35 / 60 * 100 }),
    ]);
    expect(series("PvT win rate over time")).toEqual([expect.objectContaining({ sampleGames: 1, rate: 100 })]);
    expect(screen.queryByText("Building a sample")).toBeNull();
    expect(screen.getByText(/Win rate over all games to date per matchup/)).toBeTruthy();
  });
});
