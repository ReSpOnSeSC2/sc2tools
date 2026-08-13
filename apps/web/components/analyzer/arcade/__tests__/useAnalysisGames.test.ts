import { createElement, type ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  dbRev: 0,
  generation: 0,
  getToken: vi.fn(async () => null),
  apiCall: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({
    getToken: harness.getToken,
    isLoaded: true,
    isSignedIn: true,
  }),
}));

vi.mock("@/lib/filterContext", () => ({
  useFilters: () => ({ dbRev: harness.dbRev }),
}));

vi.mock("@/lib/clientApi", () => ({
  apiCall: harness.apiCall,
}));

import {
  ANALYSIS_GAMES_CORPUS_MAX,
  ANALYSIS_GAMES_MAX_PAGES,
  ANALYSIS_GAMES_PAGE_SIZE,
  ANALYSIS_GAMES_REFRESH_QUIET_MS,
  AnalysisGamesProvider,
  analysisGamesPageKey,
  useAnalysisGames,
  useSettledAnalysisRevision,
} from "../hooks/useAnalysisGames";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  harness.dbRev = 0;
  harness.generation = 0;
  harness.apiCall.mockReset();
  harness.apiCall.mockImplementation(async (_getToken, path: string) => {
    const cursor = new URL(path, "https://example.test").searchParams.get(
      "cursor",
    );
    const prefix = `r${harness.generation}`;
    return cursor
      ? {
          items: [game(`${prefix}-c`)],
          nextCursor: null,
        }
      : {
          items: [game(`${prefix}-a`), game(`${prefix}-b`)],
          nextCursor: `${prefix}-next`,
        };
  });
});

function game(gameId: string) {
  return {
    gameId,
    date: "2026-08-13T12:00:00.000Z",
    result: "Victory",
  };
}

describe("analysisGamesPageKey", () => {
  it("starts at the bounded analysis projection endpoint", () => {
    expect(analysisGamesPageKey(0, null)).toBe(
      `/v1/games/analysis-corpus?limit=${ANALYSIS_GAMES_PAGE_SIZE}`,
    );
  });

  it("carries the opaque cursor without interpreting it in the browser", () => {
    const path = analysisGamesPageKey(1, {
      items: [],
      nextCursor: "date/id + opaque",
    });
    expect(path).toBe(
      `/v1/games/analysis-corpus?limit=${ANALYSIS_GAMES_PAGE_SIZE}`
        + "&cursor=date%2Fid+%2B+opaque",
    );
  });

  it("stops at exhaustion, signed-out state, or the 20k corpus ceiling", () => {
    expect(
      analysisGamesPageKey(1, { items: [], nextCursor: null }),
    ).toBeNull();
    expect(analysisGamesPageKey(0, null, false)).toBeNull();
    expect(
      analysisGamesPageKey(ANALYSIS_GAMES_MAX_PAGES, {
        items: [],
        nextCursor: "more",
      }),
    ).toBeNull();
    expect(ANALYSIS_GAMES_PAGE_SIZE * ANALYSIS_GAMES_MAX_PAGES).toBe(20_000);
    expect(ANALYSIS_GAMES_CORPUS_MAX).toBe(20_000);
  });
});

describe("useSettledAnalysisRevision", () => {
  it("coalesces a resync burst and publishes only after the quiet period", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ revision }) => useSettledAnalysisRevision(revision),
      { initialProps: { revision: 0 } },
    );

    rerender({ revision: 1 });
    act(() => {
      vi.advanceTimersByTime(ANALYSIS_GAMES_REFRESH_QUIET_MS - 1);
    });
    expect(result.current).toBe(0);

    // A newer ingest event resets the timer instead of starting another load.
    rerender({ revision: 2 });
    act(() => {
      vi.advanceTimersByTime(ANALYSIS_GAMES_REFRESH_QUIET_MS);
    });
    expect(result.current).toBe(2);
  });
});

describe("AnalysisGamesProvider retention", () => {
  const wrapper = ({ children }: { children: ReactNode }) => {
    const providerProps = { refreshQuietMs: 0, children };
    return createElement(AnalysisGamesProvider, providerProps);
  };

  it("replaces one flat corpus across revisions without retaining old pages", async () => {
    const { result, rerender } = renderHook(() => useAnalysisGames(), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.items.map((row) => row.gameId)).toEqual([
        "r0-a",
        "r0-b",
        "r0-c",
      ]);
    });
    const firstSnapshot = result.current.items;
    expect(result.current.pagesFetched).toBe(2);

    harness.generation = 1;
    harness.dbRev = 1;
    rerender();
    await waitFor(() => {
      expect(result.current.items.map((row) => row.gameId)).toEqual([
        "r1-a",
        "r1-b",
        "r1-c",
      ]);
    });
    expect(result.current.items).not.toBe(firstSnapshot);
    expect(result.current.items).toHaveLength(3);
    expect(result.current.pagesFetched).toBe(2);

    harness.generation = 2;
    harness.dbRev = 2;
    rerender();
    await waitFor(() => {
      expect(result.current.items.map((row) => row.gameId)).toEqual([
        "r2-a",
        "r2-b",
        "r2-c",
      ]);
    });
    // Two page requests per revision; neither page count nor retained item
    // count grows with old cursor generations.
    expect(harness.apiCall).toHaveBeenCalledTimes(6);
    expect(result.current.pagesFetched).toBe(2);
    expect(result.current.items).toHaveLength(3);
  });
});
