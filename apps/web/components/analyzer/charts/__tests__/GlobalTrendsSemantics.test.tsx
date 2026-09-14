import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TrendsDataProvider } from "@/lib/trendsDataContext";
import { MmrProgressionChart } from "../MmrProgressionChart";
import { MomentumChart } from "../MomentumChart";

const useApiMock = vi.fn();
vi.mock("@/lib/clientApi", () => ({ useApi: (...args: unknown[]) => useApiMock(...args) }));
vi.mock("recharts", () => {
  const Empty = () => null;
  return {
    ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    ComposedChart: ({ data, children }: { data: unknown; children?: ReactNode }) => <div><output data-testid="chart-values">{JSON.stringify(data)}</output><svg>{children}</svg></div>,
    Area: Empty, Line: Empty, Bar: Empty, Cell: Empty, Legend: Empty,
    XAxis: Empty, YAxis: Empty, Tooltip: Empty, CartesianGrid: Empty,
    ReferenceDot: Empty, ReferenceLine: Empty,
  };
});

afterEach(() => { cleanup(); useApiMock.mockReset(); });

describe("global trend semantics", () => {
  it("renders the population MMR average even if an account series is present", () => {
    const bucket = "2026-08-24T00:00:00Z";
    const point = { bucket, openMmr: 4400, closeMmr: 4400, avgMmr: 4500, minMmr: 3500, maxMmr: 5500, wins: 6, losses: 4, total: 10 };
    useApiMock.mockImplementation((path: string) => ({ isLoading: false, data: path.includes("/timeseries/mmr") ? {
      interval: "week", points: [point], peak: { bucket, mmr: 4500 }, trough: { bucket, mmr: 4500 }, latest: { bucket, mmr: 4500 },
      series: [{ seriesKey: "one", toonHandle: "1-S2-1-123", region: "NA", ladderRace: "P", label: "Private account", points: [{ ...point, closeMmr: 6000 }] }],
    } : undefined }));
    render(<TrendsDataProvider mode="global"><MmrProgressionChart bucket="week" /></TrendsDataProvider>);
    expect(screen.getByText("Average MMR over time")).toBeTruthy();
    expect(screen.getByText("Latest average")).toBeTruthy();
    expect(screen.getByText("Highest average")).toBeTruthy();
    expect(screen.getByText("Lowest average")).toBeTruthy();
    expect(screen.getByText(/Each account\/race has equal weight/)).toBeTruthy();
    expect(screen.getByTestId("chart-values").textContent).toContain('"close":4500');
    expect(screen.queryByText("Private account")).toBeNull();
    expect(screen.queryByText("Last recorded")).toBeNull();
    expect(screen.getByText(/Combined net MMR change across the selected players/)).toBeTruthy();
  });

  it("describes combined player sessions without assigning one player's tilt verdict", () => {
    useApiMock.mockReturnValue({ isLoading: false, data: {
      sessionGapMinutes: 60,
      baseline: { total: 100, wins: 60, losses: 40, winRate: 0.6 },
      postWin: { total: 50, wins: 40, losses: 10, winRate: 0.8 },
      postLoss: { total: 50, wins: 20, losses: 30, winRate: 0.4 },
      sessionPositions: [],
    } });
    render(<TrendsDataProvider mode="global"><MomentumChart /></TrendsDataProvider>);
    expect(screen.getByText(/Sessions are measured separately for each player account/)).toBeTruthy();
    expect(screen.getByText(/the cohort's overall win rate is 60%/)).toBeTruthy();
    expect(screen.queryByText("Tilt signal:")).toBeNull();
    expect(screen.queryByText(/you win/)).toBeNull();
  });
});
