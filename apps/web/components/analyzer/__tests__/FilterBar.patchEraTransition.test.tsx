import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalyzerProvider } from "@/components/AnalyzerProvider";
import { defaultAnalyzerFilters, filtersToQuery, useFilters, type AnalyzerFilters } from "@/lib/filterContext";
import { ActiveFilterChips } from "../ActiveFilterChips";
import { FilterBar } from "../FilterBar";

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "owner" }) }));
vi.mock("@/lib/useSeasons", async original => ({ ...await original<typeof import("@/lib/useSeasons")>(), useSeasons: () => ({ data: undefined }) }));
vi.mock("@/lib/useUserSocket", () => ({ useUserSocket: () => undefined }));
vi.mock("@/lib/clientApi", () => ({ useApi: () => ({ data: undefined, isLoading: false, error: null }) }));
vi.mock("@/components/analyzer/arcade/hooks/useAnalysisGames", () => ({ AnalysisGamesProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("next/navigation", () => ({ usePathname: () => "/app/sessions", useSearchParams: () => new URLSearchParams() }));

const SINCE = "2026-06-01T00:00:00.000Z";
const UNTIL = "2026-10-01T00:00:00.000Z";

function Readout() {
  const { filters, setFilters } = useFilters();
  const freeze = (era: "before" | "after") => setFilters({
    ...defaultAnalyzerFilters(), preset: "custom", patch_era: era,
    since: SINCE, until: UNTIL, race: "P", map: "Ghost River",
  });
  return <>
    <button onClick={() => freeze("before")}>Open frozen 8-worker view</button>
    <button onClick={() => freeze("after")}>Open frozen 12-worker view</button>
    <output data-testid="filter-state">{JSON.stringify(filters)}</output>
    <output data-testid="filter-query">{filtersToQuery(filters)}</output>
  </>;
}

function renderFilters() {
  render(<AnalyzerProvider><FilterBar /><ActiveFilterChips /><Readout /></AnalyzerProvider>);
}
function state(): AnalyzerFilters {
  return JSON.parse(screen.getByTestId("filter-state").textContent || "{}");
}
function query(): URLSearchParams {
  return new URLSearchParams(screen.getByTestId("filter-query").textContent || "");
}
function openDatePicker() {
  const label = screen.getByText("Date range");
  fireEvent.click(within(label.nextElementSibling as HTMLElement).getByRole("button"));
  return screen.getByRole("dialog", { name: "Pick a date range" });
}

beforeEach(() => {
  localStorage.clear(); window.history.replaceState(null, "", "/app/sessions");
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("frozen version cohort and real date-preset transitions", () => {
  it.each([
    { label: "All time", preset: "all", era: null },
    { label: /^Auto-track current season/, preset: "current_season", era: null },
    { label: "After 5.0.17 · 12 workers", preset: "after_5_0_17", era: "after" },
  ])("retires an explicit custom era when choosing $preset", ({ label, preset, era }) => {
    renderFilters(); fireEvent.click(screen.getByRole("button", { name: "Open frozen 8-worker view" }));
    expect(query().getAll("patch_era")).toEqual(["before"]);
    fireEvent.click(within(openDatePicker()).getByRole("button", { name: label }));
    expect(state()).toMatchObject({ preset, race: "P", map: "Ghost River" });
    expect(state()).not.toHaveProperty("patch_era");
    expect(query().get("patch_era")).toBe(era);
    expect(query().getAll("patch_era")).not.toContain("before");
    expect(screen.queryByRole("button", { name: /^Remove filter Game version:/ })).toBeNull();
    if (preset === "all") { expect(query().has("since")).toBe(false); expect(query().has("until")).toBe(false); }
    else expect(query().get("since")).not.toBe(SINCE);
  });

  it.each([
    { button: "Open frozen 8-worker view", label: "8 workers · 5.0.16", era: "before" },
    { button: "Open frozen 12-worker view", label: "12 workers", era: "after" },
  ])("shows and clears only the explicit $era version cohort", ({ button, label, era }) => {
    renderFilters(); fireEvent.click(screen.getByRole("button", { name: button }));
    expect(screen.getByLabelText("Current filters").textContent).toContain(label);
    const chip = screen.getByRole("button", { name: `Remove filter Game version: ${label}` });
    chip.focus(); fireEvent.click(chip);
    expect(state()).toMatchObject({ preset: "custom", since: SINCE, until: UNTIL, race: "P", map: "Ghost River" });
    expect(state()).not.toHaveProperty("patch_era"); expect(query().has("patch_era")).toBe(false);
    expect(screen.getByLabelText("Current filters").textContent).not.toContain(label);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove filter Your race: Protoss" }));
    expect(within(screen.getByTestId("active-filter-chips")).getByRole("status").textContent)
      .toBe(`Removed Game version: ${label}. 3 filters active.`);
    expect(filtersToQuery({ patch_era: era })).toBe(`?patch_era=${era}`);
  });

  it("retains a frozen version cohort while editing its custom dates", () => {
    renderFilters(); fireEvent.click(screen.getByRole("button", { name: "Open frozen 8-worker view" }));
    openDatePicker();
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-07-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply custom range" }));
    expect(state()).toMatchObject({ preset: "custom", patch_era: "before", race: "P", map: "Ghost River" });
    expect(state().since).not.toBe(SINCE); expect(query().getAll("patch_era")).toEqual(["before"]);
    expect(screen.getByRole("button", { name: "Remove filter Game version: 8 workers · 5.0.16" })).toBeTruthy();
  });
});
