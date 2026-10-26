import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  FiltersContext,
  defaultAnalyzerFilters,
  type AnalyzerFilters,
} from "@/lib/filterContext";
import { ActiveFilterChips } from "../ActiveFilterChips";

afterEach(cleanup);

const DEFAULTS = defaultAnalyzerFilters();

function Harness({ initial }: { initial: AnalyzerFilters }) {
  const [filters, setFilters] = useState<AnalyzerFilters>(initial);
  return (
    <FiltersContext.Provider
      value={{ filters, setFilters, dbRev: 0, bumpRev: () => undefined, seasons: [] }}
    >
      <ActiveFilterChips className="with-border" />
      <output data-testid="filters-state">{JSON.stringify(filters)}</output>
    </FiltersContext.Provider>
  );
}

function state(): AnalyzerFilters {
  return JSON.parse(screen.getByTestId("filters-state").textContent || "{}");
}

/** The row's own live region (the harness output element is a status too). */
function announcement(): string | null {
  return within(screen.getByTestId("active-filter-chips")).getByRole("status").textContent;
}

function chipList(): HTMLElement {
  return screen.getByRole("list", { name: "Active filters" });
}

function chipNames(): string[] {
  return within(chipList())
    .getAllByRole("button")
    .map((b) => b.getAttribute("aria-label") || "");
}

describe("ActiveFilterChips", () => {
  it("shows nothing visible while the defaults apply", () => {
    render(<Harness initial={DEFAULTS} />);
    expect(screen.queryByRole("list", { name: "Active filters" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset to defaults" })).toBeNull();
    // No divider or spacing either: the row's classes only apply with chips.
    expect(screen.getByTestId("active-filter-chips").className).not.toMatch(/with-border/);
  });

  it("renders one removable chip per non-default filter", () => {
    render(
      <Harness
        initial={{
          ...DEFAULTS,
          preset: "all",
          since: undefined,
          regions: "EU",
          map_pool: "nonladder",
          game_size: "all",
          min_minutes: 20,
          exclude_too_short: false,
          race: "T",
          opp_race: "Z",
          build: "TvZ - Hellbat Drop",
          opp_strategy: "ZvT - Ling Bane",
          map: "Ghost River",
          mmr_min: 4000,
          mmr_max: 4600,
        }}
      />,
    );
    expect(chipNames()).toEqual([
      "Remove filter Date range: All time",
      "Remove filter Regions: EU",
      "Remove filter Game type: Custom games",
      "Remove filter Game size: All",
      "Remove filter Length: 20+ min",
      "Remove filter Too-short games: Shown",
      "Remove filter Your race: Terran",
      "Remove filter Opponent race: Zerg",
      "Remove filter Your build: TvZ - Hellbat Drop, set in Strategies",
      "Remove filter Opponent strategy: ZvT - Ling Bane, set in Strategies",
      "Remove filter Map: Ghost River",
      "Remove filter MMR: 4000–4600",
    ]);
    expect(screen.getByTestId("active-filter-chips").className).toMatch(/with-border/);
  });

  it("shows the 'set in Strategies' hint on drill-down chips", () => {
    render(<Harness initial={{ ...DEFAULTS, opp_strategy: "PvP - DT Rush" }} />);
    const chip = within(chipList()).getByRole("button");
    expect(chip.textContent).toContain("Opponent strategy:");
    expect(chip.textContent).toContain("PvP - DT Rush");
    expect(chip.textContent).toContain("set in Strategies");
  });

  it("removes just that filter, focuses the next chip and announces it", () => {
    render(<Harness initial={{ ...DEFAULTS, regions: "NA", opp_race: "P", map: "Ghost River" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove filter Opponent race: Protoss" }));

    expect(state()).not.toHaveProperty("opp_race");
    expect(state()).toMatchObject({ regions: "NA", map: "Ghost River" });
    expect(chipNames()).toEqual(["Remove filter Regions: NA", "Remove filter Map: Ghost River"]);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Remove filter Map: Ghost River" }),
    );
    expect(announcement()).toBe(
      "Removed Opponent race: Protoss. 2 filters active.",
    );
  });

  it("moves focus to the previous chip when the last one goes", () => {
    render(<Harness initial={{ ...DEFAULTS, regions: "NA", map: "Ghost River" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove filter Map: Ghost River" }));
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Remove filter Regions: NA" }),
    );
  });

  it("keeps focus in the row when the only chip is removed", () => {
    render(<Harness initial={{ ...DEFAULTS, map: "Ghost River" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove filter Map: Ghost River" }));
    expect(document.activeElement).toBe(screen.getByTestId("active-filter-chips"));
    expect(announcement()).toBe(
      "Removed Map: Ghost River. No filters active.",
    );
  });

  it("Reset to defaults restores every default and clears the session drill-downs", () => {
    render(
      <Harness
        initial={{
          ...DEFAULTS,
          preset: "last_7d",
          since: "2026-10-01T00:00:00.000Z",
          until: "2026-10-07T23:59:59.999Z",
          map_pool: "all",
          opp_race: "T",
          build: "PvT - Robo",
          opp_strategy: "TvP - Cyclone",
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    expect(state()).toEqual({ ...DEFAULTS, preset: "current_season", until: expect.any(String) });
    expect(screen.queryByRole("list", { name: "Active filters" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("active-filter-chips"));
    expect(announcement()).toBe("Filters reset to defaults.");
  });
});
