import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { FiltersContext, type AnalyzerFilters } from "@/lib/filterContext";
import { NoFilterMatches, NoOpponentsMatch } from "../EmptyStates";

afterEach(cleanup);

function renderWith(filters: AnalyzerFilters, ui = <NoFilterMatches />) {
  const setFilters = vi.fn();
  render(
    <FiltersContext.Provider value={{ filters, setFilters, dbRev: 0, bumpRev: () => {}, seasons: [] }}>
      {ui}
    </FiltersContext.Provider>,
  );
  return setFilters;
}

const DEFAULTS: AnalyzerFilters = {
  preset: "after_5_0_17",
  exclude_too_short: true,
  map_pool: "ladder",
  game_size: "1v1",
};

describe("NoFilterMatches", () => {
  it("lists what is applied: the date range and every narrowing filter", () => {
    renderWith({ ...DEFAULTS, race: "Z", map: "Alcyone LE" });
    const applied = screen.getByTestId("no-filter-matches-applied");
    expect(within(applied).getByText("Dates:")).toBeTruthy();
    expect(applied.textContent).toContain("Your race:Zerg");
    expect(applied.textContent).toContain("Map:Alcyone LE");
  });

  it("uses the chip row's list, listing the date range once", () => {
    renderWith({ ...DEFAULTS, preset: "all", exclude_too_short: false });
    const applied = screen.getByTestId("no-filter-matches-applied");
    expect(within(applied).getAllByText(/Dates:|Date range:/)).toHaveLength(1);
    expect(applied.textContent).toContain("Too-short games:Shown");
  });

  it("offers Reset filters only when a filter beyond the defaults is on, and keeps the dates", () => {
    renderWith({ ...DEFAULTS, preset: "all" });
    expect(screen.queryByRole("button", { name: "Reset filters" })).toBeNull();
    cleanup();

    const setFilters = renderWith({ ...DEFAULTS, preset: "all", race: "P", regions: "EU", map_pool: "all" });
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    // Every facet is back on its default; the date range is untouched.
    expect(setFilters).toHaveBeenCalledWith({ ...DEFAULTS, preset: "all" });
  });

  it("offers Widen to All time only when the date range is narrower", () => {
    renderWith({ ...DEFAULTS, preset: "all" });
    expect(screen.queryByRole("button", { name: "Widen to All time" })).toBeNull();
    cleanup();

    const setFilters = renderWith({ ...DEFAULTS, since: "2026-09-30T04:00:00.000Z" });
    fireEvent.click(screen.getByRole("button", { name: "Widen to All time" }));
    expect(setFilters).toHaveBeenCalledWith(expect.objectContaining({ preset: "all", since: undefined, until: undefined }));
  });

  it("offers Lower Min games to 1 only when Min games hid rows", () => {
    const lower = vi.fn();
    renderWith(DEFAULTS, <NoFilterMatches minGames={3} hiddenByMinGames={0} onLowerMinGames={lower} />);
    expect(screen.queryByRole("button", { name: /Lower Min games/ })).toBeNull();
    cleanup();

    renderWith(DEFAULTS, <NoFilterMatches minGames={3} hiddenByMinGames={12} onLowerMinGames={lower} />);
    const button = screen.getByRole("button", { name: "Lower Min games to 1 (12 hidden by Min games)" });
    fireEvent.click(button);
    expect(lower).toHaveBeenCalledTimes(1);
    cleanup();

    renderWith(DEFAULTS, <NoFilterMatches minGames={1} hiddenByMinGames={12} onLowerMinGames={lower} />);
    expect(screen.queryByRole("button", { name: /Lower Min games/ })).toBeNull();
  });

  it("keeps NoOpponentsMatch as the opponents' wrapper", () => {
    renderWith({ ...DEFAULTS, preset: "all" }, <NoOpponentsMatch />);
    expect(screen.getByText("No opponents match these filters")).toBeTruthy();
  });
});
