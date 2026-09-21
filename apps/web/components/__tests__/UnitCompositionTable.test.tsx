import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import {
  UnitCompositionTable,
  type UnitSummary,
  type UnitSummaryRow,
} from "@/components/analyzer/UnitCompositionTable";

afterEach(cleanup);

function unit(overrides: Partial<UnitSummaryRow> = {}): UnitSummaryRow {
  // Peaks [0, 0, 0, 0, 0, 0, 4, 4, 6, 10]: the six zeroes matter.
  return {
    token: "Stalker", mean: 2.4, median: 0, p25: 0, p75: 4,
    min: 0, max: 10, gamesPresent: 4, sampleGameIds: ["g1", "g2"],
    ...overrides,
  };
}

function summary(overrides: Partial<UnitSummary> = {}): UnitSummary {
  return {
    metric: "peak_alive", source: "unit_timeline", observedGames: 10,
    missingGames: 2, emptyArmyGames: 2, units: [unit()], ...overrides,
  };
}

function row(token = "Stalker") {
  return screen.getAllByTestId("unit-summary-row").find((el) => el.getAttribute("data-token") === token)!;
}

function visibleTokens() {
  return screen.getAllByTestId("unit-summary-row").map((el) => el.getAttribute("data-token"));
}

describe("UnitCompositionTable", () => {
  it("displays the server's zero-inclusive mean and uses observed games for frequency", () => {
    render(<UnitCompositionTable summary={summary()} />);

    expect(screen.getByText("10", { selector: "strong" })).toBeTruthy();
    expect(screen.getByText(/of 12 games with data/)).toBeTruthy();
    expect(screen.getByText("2 games have no usable samples in this phase and are excluded from the averages.")).toBeTruthy();
    expect(within(row()).getByText("2.4")).toBeTruthy();
    expect(within(row()).getByText("40%")).toBeTruthy();
    expect(within(row()).getByText("4/10")).toBeTruthy();
    // Reconstructing from only present games would incorrectly show 6.0.
    expect(within(row()).queryByText("6.0")).toBeNull();
    expect(screen.queryByText("Small sample")).toBeNull();
  });

  it("distinguishes missing samples from a valid observed empty army", () => {
    const { rerender } = render(<UnitCompositionTable summary={summary({
      observedGames: 0, missingGames: 3, emptyArmyGames: 0, units: [],
    })} />);
    expect(screen.getByText("No unit samples in this phase")).toBeTruthy();
    expect(screen.queryByText("No army units observed")).toBeNull();
    expect(screen.queryByText("Small sample")).toBeNull();
    expect(screen.queryAllByTestId("unit-summary-row")).toHaveLength(0);

    rerender(<UnitCompositionTable summary={summary({
      observedGames: 3, missingGames: 1, emptyArmyGames: 3, units: [],
    })} />);
    expect(screen.getByText("No army units observed")).toBeTruthy();
    expect(screen.queryByText("No unit samples in this phase")).toBeNull();
    expect(screen.getByText("Small sample")).toBeTruthy();
    expect(screen.getByText("1 game has no usable samples in this phase and is excluded from the averages.")).toBeTruthy();
    expect(screen.getByText(/3 observed games had no eligible units in this phase/)).toBeTruthy();
  });

  it("expands the supplied median, quartiles and full range without opening games", () => {
    const onOpenGames = vi.fn();
    render(<UnitCompositionTable summary={summary()} onOpenGames={onOpenGames} />);
    const toggle = within(row()).getByRole("button");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Median peak")).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const details = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(details).toBeTruthy();
    expect(within(details).getByText("Median peak").nextElementSibling?.textContent).toBe("0");
    expect(within(details).getByText("Middle 50%").nextElementSibling?.textContent).toBe("0–4");
    expect(within(details).getByText("Full range").nextElementSibling?.textContent).toBe("0–10");
    expect(within(details).getByText("All 10 observed games contribute to these counts, including 6 where this unit was absent.")).toBeTruthy();
    expect(onOpenGames).not.toHaveBeenCalled();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Median peak")).toBeNull();
    expect(onOpenGames).not.toHaveBeenCalled();
  });

  it("opens only the explicit sample action and labels a bounded sample honestly", () => {
    const onOpenGames = vi.fn();
    render(<UnitCompositionTable summary={summary()} onOpenGames={onOpenGames} />);
    fireEvent.click(row());
    expect(onOpenGames).not.toHaveBeenCalled();
    fireEvent.click(within(row()).getByRole("button"));
    expect(onOpenGames).not.toHaveBeenCalled();
    const action = screen.getByRole("button", { name: "View 2 sample games with Stalker" });
    expect(screen.queryByRole("button", { name: "View 4 games with Stalker" })).toBeNull();
    fireEvent.click(action);
    expect(onOpenGames).toHaveBeenCalledTimes(1);
    expect(onOpenGames).toHaveBeenCalledWith(["g1", "g2"], "Stalker");
  });

  it("uses singular labels for one sample and distinguishes a complete one-game list", () => {
    const { rerender } = render(<UnitCompositionTable summary={summary({
      units: [unit({ sampleGameIds: ["g1"] })],
    })} onOpenGames={vi.fn()} />);
    fireEvent.click(within(row()).getByRole("button"));
    expect(screen.getByRole("button", { name: "View 1 sample game with Stalker" })).toBeTruthy();

    rerender(<UnitCompositionTable summary={summary({
      units: [unit({ gamesPresent: 1, sampleGameIds: ["g1"] })],
    })} onOpenGames={vi.fn()} />);
    expect(screen.getByRole("button", { name: "View 1 game with Stalker" })).toBeTruthy();
  });

  it("omits game actions when sample IDs or navigation are unavailable", () => {
    const { rerender } = render(<UnitCompositionTable summary={summary({
      units: [unit({ sampleGameIds: [] })],
    })} onOpenGames={vi.fn()} />);
    fireEvent.click(within(row()).getByRole("button"));
    expect(screen.queryByRole("button", { name: /^View / })).toBeNull();

    rerender(<UnitCompositionTable summary={summary()} />);
    expect(screen.queryByRole("button", { name: /^View / })).toBeNull();
    expect(screen.getByText("Median peak")).toBeTruthy();
  });

  it("defaults to frequency and supports average and name without mutating the server rows", () => {
    const units = [
      unit({ token: "Stalker", mean: 2.4, gamesPresent: 8 }),
      unit({ token: "Zealot", mean: 4.8, gamesPresent: 3 }),
      unit({ token: "Adept", mean: 1.2, gamesPresent: 4 }),
    ];
    render(<UnitCompositionTable summary={summary({ units })} />);
    expect(visibleTokens()).toEqual(["Stalker", "Adept", "Zealot"]);
    fireEvent.change(screen.getByRole("combobox", { name: "Sort by" }), { target: { value: "count" } });
    expect(visibleTokens()).toEqual(["Zealot", "Stalker", "Adept"]);
    fireEvent.change(screen.getByRole("combobox", { name: "Sort by" }), { target: { value: "name" } });
    expect(visibleTokens()).toEqual(["Adept", "Stalker", "Zealot"]);
    expect(units.map((entry) => entry.token)).toEqual(["Stalker", "Zealot", "Adept"]);
  });

  it("shows the top eight initially and allows all unit types to be inspected", () => {
    const tokens = ["Adept", "Archon", "Carrier", "Colossus", "Disruptor", "Immortal", "Oracle", "Phoenix", "Sentry", "Stalker"];
    render(<UnitCompositionTable summary={summary({
      units: tokens.map((token, index) => unit({ token, mean: index + 1 })),
    })} />);
    expect(screen.getAllByTestId("unit-summary-row")).toHaveLength(8);
    expect(visibleTokens()).not.toContain("Stalker");
    fireEvent.click(screen.getByRole("button", { name: "Show all 10 unit types" }));
    expect(screen.getAllByTestId("unit-summary-row")).toHaveLength(10);
    expect(visibleTokens()).toContain("Stalker");
    fireEvent.click(screen.getByRole("button", { name: "Show top 8 units" }));
    expect(screen.getAllByTestId("unit-summary-row")).toHaveLength(8);
  });

  it("exposes one unit label with named metrics and unique disclosure targets", () => {
    render(<>
      <UnitCompositionTable summary={summary()} />
      <UnitCompositionTable summary={summary()} />
    </>);
    const regions = screen.getAllByRole("region", { name: "Units fielded" });
    expect(regions).toHaveLength(2);
    const controls = regions.map((region) => {
      // Exact accessible naming prevents decorative icons duplicating the unit.
      const toggle = within(region).getByRole("button", {
        name: "Stalker Details Average peak alive: 2.4 Middle 50%: 0–4 Seen in 40% 4/10 games",
      });
      expect(within(toggle).queryByRole("img")).toBeNull();
      fireEvent.click(toggle);
      return toggle.getAttribute("aria-controls");
    });
    expect(new Set(controls).size).toBe(2);
    expect(controls.every((id) => id && document.getElementById(id))).toBe(true);
  });
});
