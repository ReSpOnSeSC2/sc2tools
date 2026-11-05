import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSiteStats, siteStatsUrl } from "../siteStats";

const snapshot = {
  agentDownloads: 42,
  activeAgents: 0,
  activeUsers: null,
  generatedAt: "2026-11-04T12:00:00.000Z",
  activityWindowSeconds: 180,
};

describe("public site statistics transport", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("NEXT_PUBLIC_API_BASE", "https://api.sc2tools.test/");
    fetchMock.mockReset().mockResolvedValue(Response.json(snapshot));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("fetches directly from the configured API without browser credentials or authentication", async () => {
    fetchMock.mockResolvedValue(Response.json({ ...snapshot, internalDetails: "discarded" }));
    expect(await fetchSiteStats()).toEqual(snapshot);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("https://api.sc2tools.test/v1/site/stats", {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: expect.any(AbortSignal),
    });
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty("headers");
  });

  it("retains the same-origin compatibility route when no public API base is configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE", "");
    expect(siteStatsUrl()).toBe("/api/site/stats");
    await fetchSiteStats();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/site/stats");
  });

  it("preserves configured base paths and removes trailing slashes", () => {
    expect(siteStatsUrl("https://api.sc2tools.test/backend///")).toBe("https://api.sc2tools.test/backend/v1/site/stats");
  });

  it.each([-1, 1.5, "7", undefined])("rejects malformed aggregate counts (%s)", async activeUsers => {
    fetchMock.mockResolvedValue(Response.json({ ...snapshot, activeUsers }));
    await expect(fetchSiteStats()).rejects.toThrow("Invalid site statistics");
  });

  it("reports unavailable responses without treating them as zero counts", async () => {
    fetchMock.mockResolvedValue(new Response("unavailable", { status: 503 }));
    await expect(fetchSiteStats()).rejects.toThrow("Site statistics are temporarily unavailable");
  });

  it("rejects invalid JSON", async () => {
    fetchMock.mockResolvedValue(new Response("not JSON", { status: 200 }));
    await expect(fetchSiteStats()).rejects.toThrow();
  });
});
