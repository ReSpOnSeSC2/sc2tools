import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  fetchGuideBuild,
  fetchGuideCounter,
  fetchGuideIndex,
  fetchGuideMap,
  fetchGuideMatchup,
  fetchGuideSitemap,
  GUIDE_CACHE_TAG,
  GUIDE_REVALIDATE_SEC,
  toSiteGuidePath,
} from "@/lib/guides/api";
import {
  FIXTURE_BUILD_PUBLISHED,
  FIXTURE_INDEX,
  FIXTURE_SITEMAP,
} from "@/lib/guides/__fixtures__";

// Global fetch is mocked (labelled): these tests pin the fetcher's
// request options and its status → union mapping, not the network.
const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function lastUrl(): string {
  return String(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][0]);
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("guide fetchers", () => {
  test("ok: returns the payload and sends cache + redirect options", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, FIXTURE_INDEX));
    const result = await fetchGuideIndex();
    expect(result).toEqual({ kind: "ok", data: FIXTURE_INDEX });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/v1\/guides$/);
    expect(init).toMatchObject({
      headers: { accept: "application/json" },
      next: { revalidate: GUIDE_REVALIDATE_SEC, tags: [GUIDE_CACHE_TAG] },
      redirect: "manual",
    });
    expect(init.signal).toBeDefined();
  });

  test("builds each endpoint path", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, { ok: true }));
    await fetchGuideBuild("pvz", "stargate-into-glaives");
    expect(lastUrl()).toMatch(/\/v1\/guides\/pvz\/stargate-into-glaives$/);
    await fetchGuideCounter("pvz", "8-pool");
    expect(lastUrl()).toMatch(/\/v1\/guides\/pvz\/counter\/8-pool$/);
    await fetchGuideMap("old-sun-temple");
    expect(lastUrl()).toMatch(/\/v1\/guides\/maps\/old-sun-temple$/);
    await fetchGuideSitemap();
    expect(lastUrl()).toMatch(/\/v1\/guides\/sitemap$/);
  });

  test("matchup query carries band and a non-default era only", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, { ok: true }));
    await fetchGuideMatchup("pvz");
    expect(lastUrl()).toMatch(/\/v1\/guides\/pvz$/);
    await fetchGuideMatchup("pvz", { band: { type: "league", value: 4 }, era: "after" });
    expect(lastUrl()).toMatch(/\/v1\/guides\/pvz\?band=league:4$/);
    await fetchGuideMatchup("zvt", { band: { type: "mmr", value: 4500 }, era: "before" });
    expect(lastUrl()).toMatch(/\/v1\/guides\/zvt\?band=mmr:4500&era=before$/);
  });

  test("invalid path segments are not_found without a request", async () => {
    const results = await Promise.all([
      fetchGuideMatchup("PvZ"),
      fetchGuideMatchup("pvx"),
      fetchGuideMatchup("maps"),
      fetchGuideBuild("pvz", "../admin"),
      fetchGuideBuild("pvz", "a".repeat(81)),
      fetchGuideBuild("pvz", ""),
      fetchGuideCounter("pvz", "8 pool"),
      fetchGuideMap("Old%20Sun"),
    ]);
    for (const result of results) expect(result).toEqual({ kind: "not_found" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("404 → not_found", async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: { code: "not_found" } }));
    expect(await fetchGuideBuild("pvz", "no-such-build")).toEqual({ kind: "not_found" });
  });

  test.each([429, 500, 502, 503, 400, 401])("%s → unavailable", async (status) => {
    fetchMock.mockResolvedValue(jsonResponse(status, { error: { code: "x" } }));
    expect(await fetchGuideBuild("pvz", "stargate-into-glaives")).toEqual({ kind: "unavailable" });
  });

  test("network error and timeout → unavailable", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await fetchGuideIndex()).toEqual({ kind: "unavailable" });
    fetchMock.mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
    expect(await fetchGuideIndex()).toEqual({ kind: "unavailable" });
  });

  test("malformed or non-object JSON → unavailable", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>oops</html>", { status: 200 }));
    expect(await fetchGuideSitemap()).toEqual({ kind: "unavailable" });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, [FIXTURE_SITEMAP]));
    expect(await fetchGuideSitemap()).toEqual({ kind: "unavailable" });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, null));
    expect(await fetchGuideSitemap()).toEqual({ kind: "unavailable" });
  });

  test("301 alias → moved, preferring the body's movedTo", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(301, { movedTo: "/guides/pvz/stargate-into-glaives" }, {
        location: "/v1/guides/pvz/ignored",
      }),
    );
    expect(await fetchGuideBuild("pvz", "old-slug")).toEqual({
      kind: "moved",
      path: "/guides/pvz/stargate-into-glaives",
    });
  });

  test("301 without a body falls back to the Location header", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 308, headers: { location: "/v1/guides/pvz/counter/8-pool" } }),
    );
    expect(await fetchGuideCounter("pvz", "old-8-pool")).toEqual({
      kind: "moved",
      path: "/guides/pvz/counter/8-pool",
    });
  });

  test("redirect to anything but a guide path → unavailable (no open redirect)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(301, { movedTo: "https://evil.example/x" }, { location: "https://evil.example/" }),
    );
    expect(await fetchGuideBuild("pvz", "old-slug")).toEqual({ kind: "unavailable" });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 301 }));
    expect(await fetchGuideBuild("pvz", "old-slug")).toEqual({ kind: "unavailable" });
  });

  test("a published payload passes through untouched", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, FIXTURE_BUILD_PUBLISHED));
    const result = await fetchGuideBuild("pvz", "stargate-into-glaives");
    expect(result.kind === "ok" && result.data.published && result.data.overall).toEqual(
      FIXTURE_BUILD_PUBLISHED.overall,
    );
  });
});

describe("toSiteGuidePath", () => {
  test("maps API paths (relative or absolute) to site paths", () => {
    expect(toSiteGuidePath("/v1/guides/pvz/new")).toBe("/guides/pvz/new");
    expect(toSiteGuidePath("http://localhost:8080/v1/guides/maps/rainfall")).toBe(
      "/guides/maps/rainfall",
    );
    expect(toSiteGuidePath("/guides/pvz/counter/8-pool")).toBe("/guides/pvz/counter/8-pool");
  });

  test("refuses anything that is not a safe guide path", () => {
    for (const target of [
      "",
      null,
      "/admin",
      "/v1/guides/../admin",
      "/guides",
      "/guides/PvZ",
      "/guides/a/b/c/d",
      "javascript:alert(1)",
      "//evil.example/guides/pvz",
    ]) {
      expect(toSiteGuidePath(target)).toBeNull();
    }
  });
});
