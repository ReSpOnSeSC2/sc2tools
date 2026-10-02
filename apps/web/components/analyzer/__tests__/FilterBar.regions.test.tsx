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
  filtersToQuery,
  type AnalyzerFilters,
} from "@/lib/filterContext";
import { FilterBar } from "../FilterBar";

afterEach(cleanup);

function Harness({ initial = {} }: { initial?: AnalyzerFilters }) {
  const [filters, setFilters] = useState<AnalyzerFilters>({
    ...DEFAULT_ANALYZER_FILTERS,
    ...initial,
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

function sentRegions(): string | null {
  return new URLSearchParams(filtersToQuery(state()).slice(1)).get("regions");
}

function regionGroup(): HTMLElement {
  return screen.getByRole("group", { name: "Filter by Battle.net region" });
}

function pressed(name: string): string | null {
  return within(regionGroup())
    .getByRole("button", { name })
    .getAttribute("aria-pressed");
}

describe("FilterBar region pills", () => {
  it("offers the five ladder regions plus PTR, all on by default", () => {
    render(<Harness />);
    const pills = within(regionGroup()).getAllByRole("button");
    expect(pills.map((p) => p.textContent)).toEqual([
      "NA",
      "EU",
      "KR",
      "CN",
      "SEA",
      "PTR",
    ]);
    for (const pill of pills) expect(pill.getAttribute("aria-pressed")).toBe("true");
    // PTR is spelled out where the code alone is opaque.
    expect(
      within(regionGroup()).getByRole("button", { name: "PTR" }).getAttribute("title"),
    ).toBe("Hide Public Test Realm (PTR) opponents");
    expect(sentRegions()).toBeNull();
  });

  it("sends the other five regions when PTR is turned off", () => {
    render(<Harness />);
    fireEvent.click(within(regionGroup()).getByRole("button", { name: "PTR" }));
    expect(pressed("PTR")).toBe("false");
    expect(state().regions).toBe("NA,EU,KR,CN,SEA");
    expect(sentRegions()).toBe("NA,EU,KR,CN,SEA");
  });

  it("sends no regions param once all six are on again", () => {
    render(<Harness initial={{ regions: "NA,EU,KR,CN,SEA" }} />);
    expect(pressed("PTR")).toBe("false");
    fireEvent.click(within(regionGroup()).getByRole("button", { name: "PTR" }));
    expect(pressed("PTR")).toBe("true");
    expect(state().regions).toBeUndefined();
    expect(sentRegions()).toBeNull();
  });

  it("can pick PTR games on their own", () => {
    render(<Harness initial={{ regions: "NA,PTR" }} />);
    fireEvent.click(within(regionGroup()).getByRole("button", { name: "NA" }));
    expect(state().regions).toBe("PTR");
    expect(sentRegions()).toBe("PTR");
  });
});

describe("FilterBar patch range text", () => {
  it("reads the dateless 8-worker preset by patch", () => {
    render(<Harness initial={{ preset: "patch_5_0_16" }} />);
    expect(screen.getByText("5.0.16 → 5.0.17")).toBeTruthy();
  });

  it("still shows a dated preset by date", () => {
    const since = new Date("2026-09-30T04:00:00.000Z");
    render(
      <Harness initial={{ preset: "after_5_0_17", since: since.toISOString() }} />,
    );
    expect(screen.getByText(`${since.toLocaleDateString()} → now`)).toBeTruthy();
  });
});
