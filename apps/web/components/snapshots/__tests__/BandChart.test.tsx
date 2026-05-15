import { describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import { BandChart } from "../BandChart";
import type { CohortTick } from "../shared/snapshotTypes";

afterEach(() => cleanup());

vi.mock("recharts", () => {
  return {
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="responsive">{children}</div>
    ),
    ComposedChart: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="chart">{children}</div>
    ),
    Area: () => <div data-testid="area" />,
    Line: () => <div data-testid="line" />,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    CartesianGrid: () => null,
    ReferenceLine: () => null,
  };
});

function band(loserMed: number, winnerMed: number) {
  return {
    p25l: loserMed * 0.7,
    p50l: loserMed,
    p75l: loserMed * 1.3,
    p90l: loserMed * 1.6,
    p25w: winnerMed * 0.7,
    p50w: winnerMed,
    p75w: winnerMed * 1.3,
    p90w: winnerMed * 1.6,
    sampleWinners: 6,
    sampleLosers: 6,
  };
}

describe("BandChart", () => {
  it("renders the chart with multiple series when cohort has data", () => {
    const cohort: CohortTick[] = [
      { t: 0, my: { army_value: band(0, 50) }, opp: {} },
      { t: 30, my: { army_value: band(50, 200) }, opp: {} },
    ];
    render(<BandChart title="Army value" metric="army_value" cohort={cohort} hideOpp />);
    expect(screen.getByTestId("chart")).toBeTruthy();
    expect(screen.getAllByTestId("area").length).toBeGreaterThan(0);
  });

  it("falls back to an empty-state message when cohort has nothing for the metric", () => {
    const cohort: CohortTick[] = [{ t: 0, my: {}, opp: {} }];
    render(<BandChart title="Bases" metric="bases" cohort={cohort} />);
    expect(screen.getByText(/Not enough cohort data/i)).toBeTruthy();
  });
});
