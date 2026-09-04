import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  DEFAULT_ANALYZER_FILTERS,
  FiltersContext,
  type AnalyzerFilters,
} from "@/lib/filterContext";
import { DashboardKpiStrip } from "../DashboardKpiStrip";

const requestedUrls: string[] = [];
let dataForUrl: (url: string) => unknown = () => undefined;

vi.mock("@/lib/clientApi", () => ({
  useApi: (url: string) => {
    requestedUrls.push(url);
    return { data: dataForUrl(url), isLoading: false, error: null };
  },
}));

afterEach(() => {
  cleanup();
  requestedUrls.length = 0;
  dataForUrl = () => undefined;
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
      <DashboardKpiStrip />
    </FiltersContext.Provider>,
  );
}

describe("DashboardKpiStrip game scope", () => {
  it("keeps every game-derived KPI inside the default ladder 1v1 cohort", () => {
    renderStrip({ ...DEFAULT_ANALYZER_FILTERS });

    const gameQueries = requestedUrls.filter((url) =>
      url.startsWith("/v1/timeseries") || url.startsWith("/v1/streak"),
    );
    expect(gameQueries).toHaveLength(4);
    for (const url of gameQueries) {
      const query = queryOf(url);
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
      const query = queryOf(url);
      expect(query.has("map_pool")).toBe(false);
      expect(query.has("game_size")).toBe(false);
    }
  });

  it("renders the count returned for the complete selected filter range", () => {
    dataForUrl = (url) => {
      if (!url.startsWith("/v1/timeseries") || queryOf(url).get("interval") !== "month") {
        return undefined;
      }
      return {
        interval: "month",
        points: [
          {
            bucket: "2026-08-01T00:00:00.000Z",
            wins: 4,
            losses: 2,
            total: 7,
            winRate: 4 / 7,
          },
          {
            bucket: "2026-09-01T00:00:00.000Z",
            wins: 2,
            losses: 1,
            total: 3,
            winRate: 2 / 3,
          },
        ],
      };
    };

    renderStrip({
      ...DEFAULT_ANALYZER_FILTERS,
      preset: "season:68",
      since: "2026-07-19T00:00:00.000Z",
      until: "2026-09-04T23:59:59.999Z",
      regions: "NA,EU",
      min_minutes: 10,
      max_minutes: 20,
    });

    expect(screen.getByText("Games in range")).toBeTruthy();
    expect(screen.getByText("10")).toBeTruthy();
    expect(screen.getByText("Season 68")).toBeTruthy();
    expect(screen.queryByText("Lifetime synced replays")).toBeNull();

    const rangeUrl = requestedUrls.find(
      (url) =>
        url.startsWith("/v1/timeseries") &&
        queryOf(url).get("interval") === "month",
    );
    expect(rangeUrl).toBeTruthy();
    const query = queryOf(rangeUrl || "");
    expect(query.get("since")).toBe("2026-07-19T00:00:00.000Z");
    expect(query.get("until")).toBe("2026-09-04T23:59:59.999Z");
    expect(query.get("regions")).toBe("NA,EU");
    expect(query.get("map_pool")).toBe("ladder");
    expect(query.get("game_size")).toBe("1v1");
    expect(query.get("min_minutes")).toBe("10");
    expect(query.get("max_minutes")).toBe("20");
  });
});

function queryOf(url: string): URLSearchParams {
  const raw = url.split("?")[1]?.split("#")[0] || "";
  return new URLSearchParams(raw);
}
