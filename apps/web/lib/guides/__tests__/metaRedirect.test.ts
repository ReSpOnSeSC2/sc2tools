import { afterEach, describe, expect, test, vi } from "vitest";
import nextConfig from "../../../next.config.mjs";
import { guidesEnabled } from "@/lib/guides/flags";

afterEach(() => {
  vi.unstubAllEnvs();
});

async function metaRedirects() {
  const redirects = nextConfig.redirects;
  if (!redirects) throw new Error("next.config.mjs has no redirects()");
  const all = await redirects();
  return all.filter((rule) => rule.source === "/meta" || rule.source.startsWith("/meta/"));
}

describe("/meta redirect (next.config.mjs)", () => {
  test("is a permanent redirect to /guides when guides are on", async () => {
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "on");
    expect(await metaRedirects()).toEqual([
      { source: "/meta", destination: "/guides", permanent: true },
      { source: "/meta/:path*", destination: "/guides", permanent: true },
    ]);
  });

  test("temporarily points home when guides are off", async () => {
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", undefined);
    expect(await metaRedirects()).toEqual([
      { source: "/meta", destination: "/", permanent: false },
      { source: "/meta/:path*", destination: "/", permanent: false },
    ]);
  });

  test.each(["1", "true", "on", " TRUE ", "On", "", "0", "yes", "off"])(
    "agrees with guidesEnabled() for %j",
    async (value) => {
      vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", value);
      const [rule] = await metaRedirects();
      expect(rule.destination === "/guides").toBe(guidesEnabled());
      expect(rule.permanent).toBe(guidesEnabled());
    },
  );
});
