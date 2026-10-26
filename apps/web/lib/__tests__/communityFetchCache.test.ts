import { afterEach, expect, it, vi } from "vitest";
import { getJsonWithStatus } from "../serverApi";
import { communityCacheOptions } from "../communityCache";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthorChip } from "@/components/community/AuthorChip";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("fetches decorated Community data freshly without auth or secret transport", async () => {
  vi.stubEnv("COMMUNITY_REVALIDATE_SECRET", "local-private-purge-secret");
  const fetcher = vi.fn().mockResolvedValue(Response.json({ title: "Public fixture" })); vi.stubGlobal("fetch", fetcher);
  expect(await getJsonWithStatus("/v1/community/builds/macro", communityCacheOptions("macro"))).toMatchObject({ status: 200 });
  expect(fetcher.mock.calls[0][1]).toEqual({ headers: { accept: "application/json" }, next: { revalidate: 0 } });
  expect(JSON.stringify(fetcher.mock.calls)).not.toContain("local-private-purge-secret");
});
it("removes a public profile link after Off despite a warm data cache and failed optional purge", async () => {
  vi.stubEnv("COMMUNITY_REVALIDATE_SECRET", "configured-but-unavailable");
  const author = { authorName: "Synthetic public author", authorProfileHandle: "frontier-0123456789" };
  let profileEnabled = true, freshReads = 0;
  // Emulate Next's data cache: a positive revalidate would reuse this warm
  // capability body. The configured purge fails and never clears it.
  const warmBody = { ...author };
  vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
    if (options.next.revalidate > 0) return Response.json(warmBody);
    freshReads += 1;
    return Response.json(profileEnabled ? author : { authorName: author.authorName });
  }));
  const read = async () => (await getJsonWithStatus<typeof author>("/v1/community/builds/macro", communityCacheOptions("macro"))).data!;
  expect(renderToStaticMarkup(createElement(AuthorChip, { build: await read() }))).toContain("/players/frontier-0123456789");
  profileEnabled = false;
  const purge = vi.fn().mockRejectedValue(new Error("Synthetic optional purge unavailable"));
  await purge().catch(() => undefined);
  const hidden = renderToStaticMarkup(createElement(AuthorChip, { build: await read() }));
  expect(hidden).toContain(author.authorName); expect(hidden).not.toContain("/players/");
  expect(freshReads).toBe(2); expect(purge).toHaveBeenCalledOnce();
});
it("does not turn an upstream failure into a cached successful payload", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("upstream private detail", { status: 503 })));
  expect(await getJsonWithStatus("/v1/community/builds/macro", communityCacheOptions("macro"))).toEqual({ data: null, status: 503 });
});
