import { afterEach, expect, it, vi } from "vitest";
import { getJsonWithStatus } from "../serverApi";
import { communityCacheOptions } from "../communityCache";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("tags only the configured public fetch without auth or secret transport", async () => {
  vi.stubEnv("COMMUNITY_REVALIDATE_SECRET", "local-private-purge-secret");
  const fetcher = vi.fn().mockResolvedValue(Response.json({ title: "Public fixture" })); vi.stubGlobal("fetch", fetcher);
  expect(await getJsonWithStatus("/v1/community/builds/macro", communityCacheOptions("macro"))).toMatchObject({ status: 200 });
  expect(fetcher.mock.calls[0][1]).toEqual({ headers: { accept: "application/json" }, next: { revalidate: 300, tags: ["community", "community-build:macro"] } });
  expect(JSON.stringify(fetcher.mock.calls)).not.toContain("local-private-purge-secret");
});
it("does not turn an upstream failure into a cached successful payload", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("upstream private detail", { status: 503 })));
  expect(await getJsonWithStatus("/v1/community/builds/macro", communityCacheOptions("macro"))).toEqual({ data: null, status: 503 });
});
