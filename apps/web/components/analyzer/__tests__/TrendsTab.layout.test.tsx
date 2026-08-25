import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TrendsTab } from "../TrendsTab";

const useApiMock = vi.fn((_path: string) => ({
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
