import { afterEach, expect, it, vi } from "vitest";
import { communityCacheOptions } from "../communityCache";
afterEach(() => vi.unstubAllEnvs());
it("stays uncached without configured invalidation, including long-lived opponent pages", () => {
  vi.stubEnv("COMMUNITY_REVALIDATE_SECRET", "");
  expect(communityCacheOptions("macro")).toEqual({ revalidateSec: 0, tags: [] });
  expect(communityCacheOptions(undefined, true)).toEqual({ revalidateSec: 0, tags: [] });
});
it("keeps capability admission fresh even when optional purge is configured", () => {
  vi.stubEnv("COMMUNITY_REVALIDATE_SECRET", "local-only");
  expect(communityCacheOptions("macro")).toEqual({ revalidateSec: 0, tags: [] });
  expect(communityCacheOptions(undefined, true)).toEqual({ revalidateSec: 0, tags: [] });
  expect(communityCacheOptions("../private").tags).toEqual([]);
});
