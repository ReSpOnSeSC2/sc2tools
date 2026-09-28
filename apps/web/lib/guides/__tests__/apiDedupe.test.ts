import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * React's `cache` is request-scoped on the server and a pass-through in
 * the client build vitest loads, so the per-request memo is stood in by a
 * plain Map-backed `cache` here. What this pins is the wiring: every
 * fetcher goes through one memoised function keyed by the API path, so a
 * page's generateMetadata and body share a single API call even though
 * the timeout signal opts each fetch out of Next's own dedupe.
 */
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  function memo<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R {
    const results = new Map<string, R>();
    return (...args: Args) => {
      const key = JSON.stringify(args);
      if (!results.has(key)) results.set(key, fn(...args));
      return results.get(key) as R;
    };
  }
  return { ...actual, cache: memo };
});

import { fetchGuideBuild, fetchGuideMatchup, GUIDE_FETCH_TIMEOUT_MS } from "@/lib/guides/api";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify({ published: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("guide fetch memo", () => {
  test("generateMetadata + page share one API call per path", async () => {
    const [metadata, page] = await Promise.all([
      fetchGuideBuild("pvz", "stargate-into-glaives"),
      fetchGuideBuild("pvz", "stargate-into-glaives"),
    ]);
    expect(metadata).toEqual(page);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The timeout signal is still sent (a hung API can't stall a render).
    expect(fetchMock.mock.calls[0][1].signal).toBeDefined();
    expect(GUIDE_FETCH_TIMEOUT_MS).toBeGreaterThan(0);
  });

  test("equal band queries built as separate objects still share the call", async () => {
    await fetchGuideMatchup("tvz", { band: { type: "league", value: 4 } });
    await fetchGuideMatchup("tvz", { band: { type: "league", value: 4 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/v1\/guides\/tvz\?band=league:4$/);
  });

  test("different paths are fetched separately", async () => {
    await fetchGuideBuild("pvt", "dt-drop");
    await fetchGuideBuild("pvt", "stargate-into-charge");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
