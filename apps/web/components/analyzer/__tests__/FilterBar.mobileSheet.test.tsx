import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  FiltersContext,
  defaultAnalyzerFilters,
  type AnalyzerFilters,
} from "@/lib/filterContext";
import { FilterBar } from "../FilterBar";
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "owner" }) }));

// The Matchup picker asks which races you have played: "none yet" here.
vi.mock("@/lib/clientApi", () => ({
  useApi: () => ({ data: undefined, isLoading: false, error: null }),
}));

beforeEach(() => { vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const DEFAULTS = defaultAnalyzerFilters();

function Harness({ initial = DEFAULTS }: { initial?: AnalyzerFilters }) {
  const [filters, setFilters] = useState<AnalyzerFilters>(initial);
  return (
    <FiltersContext.Provider
      value={{ filters, setFilters, dbRev: 0, bumpRev: () => undefined, seasons: [] }}
    >
      <FilterBar />
      <output data-testid="filters-state">{JSON.stringify(filters)}</output>
    </FiltersContext.Provider>
  );
}

function state(): AnalyzerFilters {
  return JSON.parse(screen.getByTestId("filters-state").textContent || "{}");
}

function sheetButton(): HTMLElement {
  return screen.getByRole("button", { name: /^Filters/ });
}

/** Modal moves focus on a zero-delay timer once it opens. */
async function openSheet(): Promise<HTMLElement> {
  vi.useFakeTimers();
  try {
    fireEvent.click(sheetButton());
    await act(async () => {
      vi.runAllTimers();
    });
  } finally {
    vi.useRealTimers();
  }
  return screen.getByRole("dialog", { name: "Filters" });
}

describe("FilterBar phone sheet", () => {
  it("counts every non-default facet, including the date now edited inside the sheet", () => {
    render(
      <Harness
        initial={{ ...DEFAULTS, preset: "all", since: undefined, opp_race: "Z", regions: "EU" }}
      />,
    );
    // Accessible name skips the decorative dot: "Filters 2 active".
    expect(sheetButton().textContent).toBe("Filters·3 active");
    expect(sheetButton().getAttribute("aria-haspopup")).toBe("dialog");
    expect(sheetButton().getAttribute("aria-expanded")).toBe("false");
  });

  it("counts a changed date when the other facets are default", () => {
    render(<Harness initial={{ ...DEFAULTS, preset: "last_7d" }} />);
    expect(sheetButton().textContent).toBe("Filters·1 active");
  });

  it("opens a labelled modal dialog holding the filter controls", async () => {
    render(<Harness />);
    const dialog = await openSheet();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(sheetButton().getAttribute("aria-expanded")).toBe("true");
    expect(within(dialog).getByRole("radiogroup", { name: "Matchup" })).toBeTruthy();
    expect(within(dialog).getByRole("group", { name: "Filter by Battle.net region" })).toBeTruthy();
    expect(within(dialog).getByRole("group", { name: "Filter by ladder or custom games" })).toBeTruthy();
    expect(within(dialog).getByRole("group", { name: "Filter by game size" })).toBeTruthy();
    expect(within(dialog).getByRole("group", { name: "Filter by game length" })).toBeTruthy();
    expect(within(dialog).getByRole("checkbox", { name: "Hide games under 45 seconds" })).toBeTruthy();
    // Focus starts inside the sheet.
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("applies changes made in the sheet right away", async () => {
    render(<Harness />);
    const dialog = await openSheet();
    fireEvent.click(within(dialog).getByRole("radio", { name: "vs Terran" }));
    expect(state().opp_race).toBe("T");
    expect(sheetButton().textContent).toBe("Filters·1 active");
  });

  it("closes on Escape and returns focus to the Filters button", async () => {
    render(<Harness />);
    sheetButton().focus();
    await openSheet();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Filters" })).toBeNull();
    expect(document.activeElement).toBe(sheetButton());
  });

  it("keeps Tab inside the sheet", async () => {
    render(<Harness />);
    const dialog = await openSheet();
    const done = within(dialog).getByRole("button", { name: "Done" });
    done.focus();
    fireEvent.keyDown(done, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(done);
  });

  it("Reset to defaults clears everything, and Done closes the sheet", async () => {
    render(
      <Harness
        initial={{ ...DEFAULTS, preset: "all", since: undefined, opp_race: "Z", build: "PvZ - Stargate" }}
      />,
    );
    const dialog = await openSheet();
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset to defaults" }));
    expect(state()).toEqual(DEFAULTS);
    const done = within(dialog).getByRole("button", { name: "Done" });
    expect(document.activeElement).toBe(done);
    expect(
      (within(dialog).getByRole("button", { name: "Reset to defaults" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(done);
    expect(screen.queryByRole("dialog", { name: "Filters" })).toBeNull();
  });

  it("opens the phone date picker from the full editor above the app's tab bar", async () => {
    render(<Harness />);
    await openSheet();
    // The date range button sits right after its "Date range" label.
    const label = screen.getByText("Date range");
    const trigger = within(label.nextElementSibling as HTMLElement).getByRole("button");
    fireEvent.click(trigger);
    const picker = screen.getByRole("dialog", { name: "Pick a date range" });
    expect(picker.className).toContain("bottom-above-chrome");
    expect(picker.className).toContain("z-sheet");
    expect(picker.className).not.toMatch(/(^|\s)bottom-2(\s|$)/);
  });

  it("links the filters help article from the bar", async () => {
    render(<Harness />);
    await openSheet();
    const help = await screen.findByRole("link", { name: "How filters work" });
    expect(help.getAttribute("href")).toBe("/help/analyzer-filters");
  });
});
