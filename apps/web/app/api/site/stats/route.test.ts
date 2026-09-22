import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const snapshot = {
  agentDownloads: 42,
  activeAgents: 7,
  activeUsers: 3,
  generatedAt: "2026-09-21T12:00:00.000Z",
  activityWindowSeconds: 180,
};

describe("GET /api/site/stats", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("SC2TOOLS_API_BASE", "https://api.sc2tools.test/");
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("returns only validated aggregate data without a cache or identity", async () => {
    fetchMock.mockResolvedValue(Response.json({ ...snapshot, internalDetails: "private" }));
    const response = await GET();
    expect(await response.json()).toEqual(snapshot);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("https://api.sc2tools.test/v1/site/stats", {
      cache: "no-store", signal: expect.any(AbortSignal),
    });
  });

  it("preserves unavailable metrics and real zero values", async () => {
    const partial = { ...snapshot, agentDownloads: null, activeAgents: 0 };
    fetchMock.mockResolvedValue(Response.json(partial));
    expect(await (await GET()).json()).toEqual(partial);
  });

  it.each([-1, 2.5, "123", undefined])("rejects invalid counts (%s) instead of inventing data", async (activeUsers) => {
    fetchMock.mockResolvedValue(Response.json({ ...snapshot, activeUsers }));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "site_stats_unavailable" });
  });

  it("does not expose upstream failure details", async () => {
    fetchMock.mockRejectedValue(new Error("private upstream failure"));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private upstream");
  });
});
