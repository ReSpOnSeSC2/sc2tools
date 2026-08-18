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

/**
 * The global "Game length" control.
 *
 * Bounds are whole minutes, inclusive lower / exclusive upper, and they
 * live in the same shared filter context every other FilterBar control
 * writes to — so one click re-scopes every analyzer tab at once. The
 * default is no constraint at all, which is what keeps existing
 * bookmarks and cache keys unchanged for anyone who never touches it.
 */

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

function lengthGroup(): HTMLElement {
  return screen.getByRole("group", { name: "Filter by game length" });
}

describe("FilterBar game-length control", () => {
  it("starts unconstrained, with All selected", () => {
    render(<Harness />);
    expect(
      within(lengthGroup())
        .getByRole("button", { name: "All" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(state().min_minutes).toBeUndefined();
    expect(state().max_minutes).toBeUndefined();
  });

  it("applies a quick band and reflects it back as the active pill", () => {
    render(<Harness />);
    fireEvent.click(within(lengthGroup()).getByRole("button", { name: "10–20" }));
    expect(state()).toMatchObject({ min_minutes: 10, max_minutes: 20 });
    expect(
      within(lengthGroup())
        .getByRole("button", { name: "10–20" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("leaves the far side open on the outer bands", () => {
    render(<Harness />);
    fireEvent.click(within(lengthGroup()).getByRole("button", { name: "20+" }));
    expect(state().min_minutes).toBe(20);
    expect(state().max_minutes).toBeUndefined();

    fireEvent.click(within(lengthGroup()).getByRole("button", { name: "< 10" }));
    expect(state().min_minutes).toBeUndefined();
    expect(state().max_minutes).toBe(10);
  });

  it("clears back to no constraint via All", () => {
    render(<Harness />);
    fireEvent.click(within(lengthGroup()).getByRole("button", { name: "20+" }));
    fireEvent.click(within(lengthGroup()).getByRole("button", { name: "All" }));
    expect(state().min_minutes).toBeUndefined();
    expect(state().max_minutes).toBeUndefined();
  });

  it("applies a custom range and labels the pill with it", () => {
    render(<Harness />);
    fireEvent.click(within(lengthGroup()).getByRole("button", { name: /Custom/ }));

    const dialog = screen.getByRole("dialog", { name: "Custom game length" });
    fireEvent.change(within(dialog).getByLabelText("Min (min)"), {
      target: { value: "7" },
    });
    fireEvent.change(within(dialog).getByLabelText("Max (min)"), {
      target: { value: "13" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));

    expect(state()).toMatchObject({ min_minutes: 7, max_minutes: 13 });
    // The pill stops saying "Custom" and starts saying what is applied,
    // so the active range is legible without reopening the popover.
    expect(
      within(lengthGroup())
        .getByRole("button", { name: /7–13 min/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("swaps a transposed custom range rather than selecting nothing", () => {
    render(<Harness />);
    fireEvent.click(within(lengthGroup()).getByRole("button", { name: /Custom/ }));

    const dialog = screen.getByRole("dialog", { name: "Custom game length" });
    fireEvent.change(within(dialog).getByLabelText("Min (min)"), {
      target: { value: "30" },
    });
    fireEvent.change(within(dialog).getByLabelText("Max (min)"), {
      target: { value: "5" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));

    expect(state()).toMatchObject({ min_minutes: 5, max_minutes: 30 });
  });

  it("treats an empty box as no bound on that side", () => {
    render(<Harness />);
    fireEvent.click(within(lengthGroup()).getByRole("button", { name: /Custom/ }));

    const dialog = screen.getByRole("dialog", { name: "Custom game length" });
    fireEvent.change(within(dialog).getByLabelText("Min (min)"), {
      target: { value: "25" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));

    expect(state().min_minutes).toBe(25);
    expect(state().max_minutes).toBeUndefined();
  });

  it("clears from inside the custom popover", () => {
    render(<Harness />);
    fireEvent.click(within(lengthGroup()).getByRole("button", { name: "10–20" }));
    fireEvent.click(within(lengthGroup()).getByRole("button", { name: /Custom/ }));

    const dialog = screen.getByRole("dialog", { name: "Custom game length" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear" }));

    expect(state().min_minutes).toBeUndefined();
    expect(state().max_minutes).toBeUndefined();
    expect(
      within(lengthGroup())
        .getByRole("button", { name: "All" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("does not disturb the other global filters", () => {
    // Regression guard for the whole point of the shared context: a
    // length pick must re-scope the tabs without quietly resetting the
    // ranked-ladder 1v1 cohort or the "Hide too-short" toggle.
    render(<Harness />);
    fireEvent.click(within(lengthGroup()).getByRole("button", { name: "20+" }));
    expect(state()).toMatchObject({
      map_pool: "ladder",
      game_size: "1v1",
      exclude_too_short: true,
      min_minutes: 20,
    });
  });
});
