import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  DEFAULT_ANALYZER_FILTERS,
  FiltersContext,
  type AnalyzerFilters,
} from "@/lib/filterContext";
import { DashboardKpiStrip } from "../DashboardKpiStrip";

const requestedUrls: string[] = [];

vi.mock("@/lib/clientApi", () => ({
  useApi: (url: string) => {
    requestedUrls.push(url);
    return { data: undefined, isLoading: false };
  },
}));

afterEach(() => {
  cleanup();
  requestedUrls.length = 0;
  window.localStorage.clear();
});

function renderStrip(filters: AnalyzerFilters) {
  render(
    <FiltersContext.Provider
      value={{
        filters,
        setFilters: () => undefined,
        dbRev: 0,
        bumpRev: () => undefined,
        seasons: [],
      }}
    >
      <DashboardKpiStrip totalGames={99} />
    </FiltersContext.Provider>,
  );
}

describe("DashboardKpiStrip game scope", () => {
  it("keeps every game-derived KPI inside the default ladder 1v1 cohort", () => {
    renderStrip({ ...DEFAULT_ANALYZER_FILTERS });

    const gameQueries = requestedUrls.filter((url) =>
      url.startsWith("/v1/timeseries") || url.startsWith("/v1/streak"),
    );
    expect(gameQueries).toHaveLength(3);
    for (const url of gameQueries) {
      const query = new URLSearchParams(url.split("?")[1] || "");
      expect(query.get("map_pool")).toBe("ladder");
      expect(query.get("game_size")).toBe("1v1");
    }
  });

  it("omits both constraints when the user explicitly selects All", () => {
    renderStrip({
      ...DEFAULT_ANALYZER_FILTERS,
      map_pool: "all",
      game_size: "all",
    });

    for (const url of requestedUrls) {
      const query = new URLSearchParams(url.split("?")[1] || "");
      expect(query.has("map_pool")).toBe(false);
      expect(query.has("game_size")).toBe(false);
    }
  });
});
