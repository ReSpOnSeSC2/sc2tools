import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  DEFAULT_ANALYZER_FILTERS,
  FiltersContext,
  type AnalyzerFilters,
} from "@/lib/filterContext";
import { FilterBar } from "../FilterBar";

afterEach(cleanup);

function Harness() {
  const [filters, setFilters] = useState<AnalyzerFilters>({
    ...DEFAULT_ANALYZER_FILTERS,
  });
  return (
    <FiltersContext.Provider
      value={{
        filters,
        setFilters,
        dbRev: 0,
        bumpRev: () => undefined,
        seasons: [],
      }}
    >
      <FilterBar />
      <output data-testid="filters-state">{JSON.stringify(filters)}</output>
    </FiltersContext.Provider>
  );
}

function state(): AnalyzerFilters {
  return JSON.parse(screen.getByTestId("filters-state").textContent || "{}");
}

describe("FilterBar game-scope controls", () => {
  it("starts on ranked ladder and 1v1", () => {
    render(<Harness />);
    const maps = screen.getByRole("group", {
      name: "Filter by ladder or custom games",
    });
    const players = screen.getByRole("group", {
      name: "Filter by game size",
    });

    expect(
      within(maps)
        .getByRole("button", { name: "Ladder" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      within(players)
        .getByRole("button", { name: "1v1" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(state()).toMatchObject({ map_pool: "ladder", game_size: "1v1" });
  });

  it("keeps active choices selected and uses explicit All to clear", () => {
    render(<Harness />);
    const maps = screen.getByRole("group", {
      name: "Filter by ladder or custom games",
    });
    const players = screen.getByRole("group", {
      name: "Filter by game size",
    });

    fireEvent.click(within(maps).getByRole("button", { name: "Ladder" }));
    fireEvent.click(within(players).getByRole("button", { name: "1v1" }));
    expect(state()).toMatchObject({ map_pool: "ladder", game_size: "1v1" });

    fireEvent.click(within(maps).getByRole("button", { name: "All" }));
    expect(state()).toMatchObject({ map_pool: "all", game_size: "1v1" });

    fireEvent.click(within(players).getByRole("button", { name: "All" }));
    expect(state()).toMatchObject({ map_pool: "all", game_size: "all" });

    fireEvent.click(within(maps).getByRole("button", { name: "Custom" }));
    fireEvent.click(within(players).getByRole("button", { name: "Team" }));
    expect(state()).toMatchObject({
      map_pool: "nonladder",
      game_size: "team",
    });
  });
});
