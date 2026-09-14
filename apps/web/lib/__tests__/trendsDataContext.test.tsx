import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { TrendsDataProvider, trendsDataPath, useTrendsApi } from "../trendsDataContext";

const useApiMock = vi.fn((..._args: unknown[]) => ({ request: vi.fn() }));
vi.mock("@/lib/clientApi", () => ({ useApi: (...args: unknown[]) => useApiMock(...args) }));

afterEach(() => { cleanup(); useApiMock.mockClear(); });

const cohort = {
  excluded_races: ["Z", "R"],
  excluded_players: ["1-S2-1-123", "2-S2-1-456"],
  included_players: [],
  player_selection: "include",
  player_mmr_min: 3500,
  player_mmr_max: 5500,
  include_unrated: false,
};

describe("trends data boundary", () => {
  it("preserves personal paths verbatim and keeps disabled requests disabled", () => {
    const path = "/v1/timeseries?race=P&map=Gold+Base#42";
    expect(trendsDataPath(path, { mode: "personal", cohort })).toBe(path);
    expect(trendsDataPath(null, { mode: "global", cohort })).toBeNull();
    renderHook(() => useTrendsApi(path));
    expect(useApiMock).toHaveBeenCalledWith(path, undefined, undefined);
  });

  it("scopes every endpoint including drilldowns and preserves game filters, timezone, and revision", () => {
    const endpoints = ["timeseries", "timeseries/mmr", "mmr-by-matchup", "mmr-by-matchup/opponents", "momentum", "opp-mmr-buckets", "opp-mmr-buckets/games", "timeseries/matchups", "length-buckets", "timeseries/day-hour", "activity-calendar", "timeseries/maps"];
    for (const endpoint of endpoints) {
      const path = trendsDataPath(`/v1/${endpoint}?race=P&opp_race=T&map=Gold+Base&min_minutes=6&mmr_min=3000&interval=week&tz=America%2FNew_York&lo=4000&hi=4500&offset=25#42`, { mode: "global", cohort });
      const url = new URL(path!, "https://example.test");
      expect(url.pathname).toBe(`/v1/admin/global-trends/${endpoint}`);
      expect(url.searchParams.get("excluded_races")).toBe("Z,R");
      expect(url.searchParams.get("excluded_players")).toBe("1-S2-1-123,2-S2-1-456");
      expect(url.searchParams.get("included_players")).toBe("");
      expect(url.searchParams.get("player_selection")).toBe("include");
      expect(url.searchParams.get("player_mmr_min")).toBe("3500");
      expect(url.searchParams.get("player_mmr_max")).toBe("5500");
      expect(url.searchParams.get("include_unrated")).toBe("false");
      expect(url.searchParams.get("race")).toBe("P");
      expect(url.searchParams.get("opp_race")).toBe("T");
      expect(url.searchParams.get("map")).toBe("Gold Base");
      expect(url.searchParams.get("min_minutes")).toBe("6");
      expect(url.searchParams.get("mmr_min")).toBe("3000");
      expect(url.searchParams.get("tz")).toBe("America/New_York");
      expect(url.searchParams.get("lo")).toBe("4000");
      expect(url.searchParams.get("hi")).toBe("4500");
      expect(url.searchParams.get("offset")).toBe("25");
      expect(url.hash).toBe("#42");
    }
  });

  it("changes request identity when the cohort changes and forwards scoped request helpers", () => {
    function Wrapper({ children }: { children: ReactNode }) {
      return <TrendsDataProvider mode="global" cohort={cohort}>{children}</TrendsDataProvider>;
    }
    const { result } = renderHook(() => useTrendsApi("/v1/timeseries#2"), { wrapper: Wrapper });
    expect(useApiMock.mock.calls[0][0]).toContain("/v1/admin/global-trends/timeseries?");
    expect(useApiMock.mock.calls[0][1]).toMatchObject({ revalidateOnFocus: false, shouldRetryOnError: false });
    expect(useApiMock.mock.calls[0][2]).toEqual({ timeoutMs: 60_000 });
    expect(result.current.request).toBe(useApiMock.mock.results[0].value.request);
    const a = trendsDataPath("/v1/timeseries", { mode: "global", cohort });
    const b = trendsDataPath("/v1/timeseries", { mode: "global", cohort: { ...cohort, excluded_players: ["another"] } });
    expect(a).not.toBe(b);
  });
});
