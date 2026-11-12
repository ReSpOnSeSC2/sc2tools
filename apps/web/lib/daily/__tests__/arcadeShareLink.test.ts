import { afterEach, describe, expect, test, vi } from "vitest";
import nextConfig from "../../../next.config.mjs";
import { SHARE_LINK_LABEL, SHARE_LINK_URL } from "@/components/analyzer/arcade/ShareCard";
import { DAILY_ROOT } from "../clip";

afterEach(() => vi.unstubAllEnvs());

describe("Arcade share destination", () => {
  test.each(["all", "off", "admins", undefined])("keeps /arcade on the static Daily page (%j)", async value => {
    vi.stubEnv("NEXT_PUBLIC_INSTANT_IMPORT", value);
    const share = new URL(SHARE_LINK_URL);
    expect(share.pathname).toBe("/arcade");
    expect(share.host + share.pathname).toBe(SHARE_LINK_LABEL);
    expect((await nextConfig.redirects!()).some(rule => rule.source === share.pathname)).toBe(false);
  });

  test("revalidates the schedule but lets versioned pack files be cached", async () => {
    expect(await nextConfig.headers!()).toEqual(expect.arrayContaining([
      { source: DAILY_ROOT + "/index.json", headers: [{ key: "Cache-Control", value: "no-cache" }] },
      { source: DAILY_ROOT + "/packs/:digest/:file*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
    ]));
  });
});
