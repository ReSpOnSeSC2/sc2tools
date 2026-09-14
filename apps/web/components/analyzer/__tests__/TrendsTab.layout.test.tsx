import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TrendsTab } from "../TrendsTab";
import { TrendsDataProvider } from "@/lib/trendsDataContext";
import type { ApiTimeseriesResponse } from "@/lib/timeseries";
import type { ClientApiError } from "@/lib/clientApi";

const useApiMock = vi.fn((_path: string): { data?: ApiTimeseriesResponse; isLoading: boolean; error?: ClientApiError; mutate?: () => unknown } => ({
  data: {
    interval: "week",
    points: [
      {
        bucket: "2026-08-24T00:00:00.000Z",
        wins: 2,
        losses: 1,
        total: 3,
        winRate: 2 / 3,
      },
    ],
  },
  isLoading: false,
}));

vi.mock("@/lib/clientApi", () => ({
  useApi: (path: string) => useApiMock(path),
}));

vi.mock("@/lib/filterContext", () => ({
  useFilters: () => ({ filters: {}, dbRev: 3 }),
  filtersToQuery: () => "?scope=test",
}));

vi.mock("recharts", () => {
  const Passthrough = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  const ChartStub = () => <div />;
  return {
    ResponsiveContainer: Passthrough,
    ComposedChart: ChartStub,
    Area: ChartStub,
    Bar: ChartStub,
    Line: ChartStub,
    ReferenceLine: ChartStub,
    XAxis: ChartStub,
    YAxis: ChartStub,
    Tooltip: ChartStub,
    CartesianGrid: ChartStub,
    Legend: ChartStub,
  };
});

vi.mock("../FingerprintCard", () => ({
  FingerprintCard: () => (
    <section data-testid="skill-fingerprint">Skill fingerprint</section>
  ),
}));

vi.mock("../charts/MapTrendChart", () => ({
  MapTrendChart: () => (
    <section data-testid="map-performance">Map performance over time</section>
  ),
}));

vi.mock("../charts/MatchupOverTimeChart", () => ({
  MatchupOverTimeChart: () => <section>Matchup over time</section>,
}));
vi.mock("../charts/MatchupGameLengthCard", () => ({
  MatchupGameLengthCard: () => <section>Matchup game length</section>,
}));
vi.mock("../charts/TimeOfDayHeatmap", () => ({
  TimeOfDayHeatmap: () => <section>Time of day</section>,
}));
vi.mock("../charts/GameLengthWrChart", () => ({
  GameLengthWrChart: () => <section>Game length</section>,
}));
vi.mock("../charts/ActivityCalendarChart", () => ({
  ActivityCalendarChart: () => <section>Activity calendar</section>,
}));
vi.mock("../charts/MmrProgressionChart", () => ({
  MmrProgressionChart: () => <section>MMR progression</section>,
}));
vi.mock("../charts/MomentumChart", () => ({
  MomentumChart: () => <section>Momentum</section>,
}));
vi.mock("../charts/OppMmrBucketsChart", () => ({
  OppMmrBucketsChart: () => <section>Opponent MMR buckets</section>,
}));
vi.mock("../charts/NetMmrByMatchupChart", () => ({
  NetMmrByMatchupChart: () => <section>Net MMR by matchup</section>,
}));

afterEach(() => {
  cleanup();
  useApiMock.mockClear();
  window.localStorage.clear();
});

describe("TrendsTab layout", () => {
  it.each((["personal", "global"] as const).flatMap((mode) =>
    ["loading", "error", "empty"].map((state) => ({ mode, state })),
  ))("keeps every independent $mode trend section mounted when the overview is $state", ({ mode, state }) => {
    const retry = vi.fn();
    useApiMock.mockReturnValueOnce({
      data: state === "empty" ? { interval: "week", points: [] } : undefined,
      isLoading: state === "loading",
      error: state === "error" ? { status: 0, code: "request_timeout", message: "The API took too long to respond." } : undefined,
      mutate: retry,
    });
    render(<TrendsDataProvider mode={mode}><TrendsTab /></TrendsDataProvider>);
    for (const title of ["Games per period (W stacked on L)", "Win rate", "MMR progression", "Net MMR by matchup", "Opponent MMR buckets", "Momentum", "Matchup over time", "Matchup game length", "Time of day", "Game length", "Activity calendar", "Map performance over time"]) {
      expect(screen.getByText(title), title).toBeTruthy();
    }
    expect(Boolean(screen.queryByTestId("skill-fingerprint"))).toBe(mode === "personal");
    expect(screen.getByRole("checkbox", { name: "Rolling WR (4)" })).toBeTruthy();
    expect(screen.getByRole("combobox")).toBeTruthy();
    if (state === "loading") expect(screen.getByRole("status", { name: "Loading Win rate" })).toBeTruthy();
    if (state === "error") {
      expect(screen.getAllByRole("alert")[0].textContent).toContain("The API took too long to respond.");
      fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]);
      expect(retry).toHaveBeenCalledOnce();
    }
    if (state === "empty") {
      const title = mode === "personal" ? "No games match these filters" : "No player game records match these filters";
      expect(screen.getAllByText(title)).toHaveLength(2);
      if (mode === "personal") expect(screen.queryByText(/Adjust the player selection/)).toBeNull();
    }
  });

  it("labels the server's wider interval and explains it for global data", () => {
    useApiMock.mockReturnValueOnce({ data: { interval: "month", points: [{ bucket: "2026-08-01T00:00:00.000Z", wins: 3, losses: 0, total: 3, winRate: 1 }] }, isLoading: false });
    render(<TrendsDataProvider mode="global"><TrendsTab /></TrendsDataProvider>);
    expect(screen.getByText("Best month")).toBeTruthy();
    expect(screen.getByText("Worst month")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Showing monthly periods");
  });

  it("keeps all trend groups but excludes fingerprints in global mode", () => {
    useApiMock.mockReturnValueOnce({ data: { interval: "week", points: [{ bucket: "2026-08-24T00:00:00.000Z", wins: 3, losses: 0, total: 3, winRate: 1 }] }, isLoading: false });
    render(<TrendsDataProvider mode="global" cohort={{ excluded_players: ["one"], excluded_races: ["Z"] }}><TrendsTab /></TrendsDataProvider>);

    expect(screen.queryByTestId("skill-fingerprint")).toBeNull();
    expect(screen.queryByText(/Winning streak/)).toBeNull();
    expect(screen.getByTestId("map-performance")).toBeTruthy();
    expect(screen.getByText("MMR progression")).toBeTruthy();
    expect(screen.getByText("Momentum")).toBeTruthy();
    expect(screen.getByText("Player game records")).toBeTruthy();
    const path = String(useApiMock.mock.calls[0][0]);
    expect(path).toContain("/v1/admin/global-trends/timeseries?");
    expect(path).toContain("excluded_players=one");
    expect(path).toContain("excluded_races=Z");
  });

  it("groups rating and outcome charts ahead of time and calendar analysis", () => {
    render(<TrendsTab />);

    const orderedLabels = [
      "MMR progression",
      "Net MMR by matchup",
      "Opponent MMR buckets",
      "Momentum",
      "Matchup over time",
      "Matchup game length",
      "Time of day",
      "Game length",
      "Activity calendar",
      "Map performance over time",
      "Skill fingerprint",
    ];
    const positions = orderedLabels.map((label) => {
      const element = screen.getByText(label);
      const position = Array.from(document.body.querySelectorAll("section"))
        .indexOf(element);
      expect(position, label).toBeGreaterThanOrEqual(0);
      return position;
    });

    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(screen.getByText("Performance & MMR")).toBeTruthy();
    expect(screen.getByText("Time & activity")).toBeTruthy();
    expect(screen.queryByText("Macro score over time")).toBeNull();
  });

  it("ends with map performance followed directly by skill fingerprint and omits mix cards", () => {
    render(<TrendsTab />);

    const mapPerformance = screen.getByTestId("map-performance");
    const skillFingerprint = screen.getByTestId("skill-fingerprint");
    const mapSlot = mapPerformance.parentElement;
    const chartGrid = mapSlot?.parentElement;
    const trendsRoot = skillFingerprint.parentElement;

    expect(chartGrid?.lastElementChild).toBe(mapSlot);
    expect(skillFingerprint.previousElementSibling).toBe(chartGrid);
    expect(trendsRoot?.lastElementChild).toBe(skillFingerprint);
    expect(screen.queryByText("Your build mix over time")).toBeNull();
    expect(screen.queryByText("Strategies you're facing")).toBeNull();
  });
});
