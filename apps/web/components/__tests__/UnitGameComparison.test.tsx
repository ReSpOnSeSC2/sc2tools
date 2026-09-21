import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { UnitGameComparison } from "@/components/analyzer/UnitGameComparison";
import { UnitCompositionTable, type UnitComparison, type UnitSummary } from "@/components/analyzer/UnitCompositionTable";

afterEach(cleanup);

function comparison(overrides: Partial<UnitComparison> = {}): UnitComparison {
  return {
    gameId: "selected/replay", status: "observed", baselineGames: 3, sampleTimeSec: 355.5,
    units: [
      { token: "Medivac", count: 1, median: 3, p25: 2, p75: 4, delta: -2 },
      { token: "Marine", count: 20, median: 8, p25: 5, p75: 10, delta: 12 },
      { token: "SiegeTank", count: 2, median: 2, p25: 1, p75: 3, delta: 0 },
    ],
    ...overrides,
  };
}

describe("UnitGameComparison", () => {
  it("shows honest leave-one-out ranges, neutral differences and the actual snapshot timestamp", () => {
    const data = comparison();
    render(<UnitGameComparison comparison={data} snapshot />);
    expect(screen.getByText(/Compared with 3 other games with data. The selected game is excluded/)).toBeTruthy();
    expect(screen.getByText(/Differences describe army choices, not execution quality. Small comparison sample/)).toBeTruthy();
    const rows = screen.getAllByTestId("unit-comparison-row");
    expect(within(rows[0]).getByText("Marine")).toBeTruthy();
    expect(within(rows[0]).getByText("Above range")).toBeTruthy();
    expect(within(rows[0]).getByText("5–10")).toBeTruthy();
    expect(within(rows[0]).getByText("+12")).toBeTruthy();
    expect(within(rows[1]).getByText("Below range")).toBeTruthy();
    expect(within(rows[1]).getByText("-2")).toBeTruthy();
    expect(within(rows[2]).getByText("Within range")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open at 5:55" }).getAttribute("href")).toBe("/app/game/selected%2Freplay?t=355.5");
    expect(data.units.map((row) => row.token)).toEqual(["Medivac", "Marine", "SiegeTank"]);
  });

  it("opens phase comparisons without implying one simultaneous army timestamp", () => {
    render(<UnitGameComparison comparison={comparison()} snapshot={false} />);
    expect(screen.getByRole("link", { name: "Open game" }).getAttribute("href")).toBe("/app/game/selected%2Freplay");
    expect(screen.queryByRole("link", { name: /Open at/ })).toBeNull();
  });

  it("shows a selected game's counts without invented ranges when no other baseline exists", () => {
    render(<UnitGameComparison comparison={comparison({ baselineGames: 0,
      units: [{ token: "Marine", count: 7, median: null, p25: null, p75: null, delta: null }],
    })} snapshot />);
    expect(screen.getByText("There are no other measured games in this selection. Counts are shown without a baseline.")).toBeTruthy();
    const row = screen.getByTestId("unit-comparison-row");
    expect(within(row).getByText("7")).toBeTruthy();
    expect(within(row).getAllByText("—")).toHaveLength(2);
    expect(screen.queryByText(/Within range|Above range|Below range/)).toBeNull();
    expect(screen.queryByText(/Typical range =/)).toBeNull();
  });

  it.each([
    ["missing", "This game has no usable unit samples for this view. A missing sample is not a zero army."],
    ["not_reached", "This game ended before this checkpoint or did not reach this phase."],
    ["not_in_cohort", "This game is no longer in the current selection. Choose another game."],
  ] as const)("distinguishes %s from an observed empty army", (status, text) => {
    render(<UnitGameComparison comparison={comparison({ status, units: [] })} snapshot />);
    expect(screen.getByRole("status").textContent).toBe(text);
    expect(screen.queryAllByTestId("unit-comparison-row")).toHaveLength(0);
    expect(screen.queryByText("No eligible army or support units observed in this comparison.")).toBeNull();
    expect(screen.queryByText(/Compared with/)).toBeNull();
  });

  it("identifies a measured empty army separately from absent data", () => {
    render(<UnitGameComparison comparison={comparison({ units: [] })} snapshot />);
    expect(screen.getByText("No eligible army or support units observed in this comparison.")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText(/Compared with 3 other games/)).toBeTruthy();
  });

  it("keeps six largest differences readable and allows every measured unit to be inspected", () => {
    const tokens = ["Marine", "Marauder", "Medivac", "SiegeTank", "Viking", "Raven", "Ghost", "Battlecruiser"];
    render(<UnitGameComparison comparison={comparison({ units: tokens.map((token, index) => ({
      token, count: index + 1, median: 1, p25: 1, p75: 1, delta: index,
    })) })} snapshot />);
    expect(screen.getAllByTestId("unit-comparison-row")).toHaveLength(6);
    expect(screen.queryByText("Marine")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Compare all 8 unit types" }));
    expect(screen.getAllByTestId("unit-comparison-row")).toHaveLength(8);
    expect(screen.getByText("Marine")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show 6 largest differences" }));
    expect(screen.getAllByTestId("unit-comparison-row")).toHaveLength(6);
  });
});

describe("measured unit replay examples", () => {
  it("uses supplied example counts and their exact replay moments for all three categories", () => {
    const summary: UnitSummary = {
      metric: "peak_alive", source: "unit_timeline", observedGames: 4, missingGames: 1, emptyArmyGames: 1,
      units: [{ token: "SiegeTank", mean: 2, median: 2, p25: 0.75, p75: 3.25, min: 0, max: 4,
        gamesPresent: 3, sampleGameIds: ["typical", "high", "other"], whenPresent: { median: 3, p25: 2, p75: 3.5 },
        examples: {
          typical: { gameId: "typical/replay", count: 3, timeSec: 325.25 },
          high: { gameId: "highest/replay", count: 4, timeSec: 418 },
          absent: { gameId: "absent/replay", count: 0, timeSec: 302 },
        },
      }],
    };
    render(<UnitCompositionTable summary={summary} />);
    expect(screen.queryByRole("link", { name: /Open typical/ })).toBeNull();
    fireEvent.click(within(screen.getByTestId("unit-summary-row")).getByRole("button"));
    expect(screen.getByRole("link", { name: "Open typical Siege Tank example: 3 at 5:25" }).getAttribute("href")).toBe("/app/game/typical%2Freplay?t=325.25");
    expect(screen.getByRole("link", { name: "Open high Siege Tank example: 4 at 6:58" }).getAttribute("href")).toBe("/app/game/highest%2Freplay?t=418");
    expect(screen.getByRole("link", { name: "Open absent Siege Tank example: 0 at 5:02" }).getAttribute("href")).toBe("/app/game/absent%2Freplay?t=302");
    expect(screen.getByText("Typical when present")).toBeTruthy();
    expect(screen.getByText(/median 3, middle 50% 2–3.5 across 3 games/)).toBeTruthy();
    expect(screen.getByText(/including 1 where this unit was absent/)).toBeTruthy();
  });
});
