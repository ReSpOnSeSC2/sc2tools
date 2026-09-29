import { afterEach, describe, expect, test, vi } from "vitest";
import nextConfig from "../../../next.config.mjs";
import { guidesEnabled } from "@/lib/guides/flags";
import { GUIDE_MATCHUPS } from "@/lib/guides/slugs";

afterEach(() => {
  vi.unstubAllEnvs();
});

async function allMetaRedirects() {
  const redirects = nextConfig.redirects;
  if (!redirects) throw new Error("next.config.mjs has no redirects()");
  const all = await redirects();
  return all.filter((rule) => rule.source === "/meta" || rule.source.startsWith("/meta/"));
}

/** The unconditional /meta rules (no `has` query matcher). */
async function metaRedirects() {
  return (await allMetaRedirects()).filter((rule) => !("has" in rule) || !rule.has);
}

/** Next anchors a `has` value regex (`^value$`) — mirror that to test the patterns. */
function matchesQuery(rule: { has?: Array<{ type: string; key?: string; value?: string }> }, key: string, value: string) {
  const item = rule.has?.find((entry) => entry.type === "query" && entry.key === key);
  return item?.value !== undefined && new RegExp(`^${item.value}$`).test(value);
}

describe("/meta redirect (next.config.mjs)", () => {
  test("is a permanent redirect to /guides when guides are on", async () => {
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "on");
    expect(await metaRedirects()).toEqual([
      { source: "/meta", destination: "/guides", permanent: true },
      { source: "/meta/:path*", destination: "/guides", permanent: true },
    ]);
  });

  test("sends old /meta?matchup=XvY links (any case) to the lowercase matchup guide first", async () => {
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "on");
    const all = await allMetaRedirects();
    const byQuery = all.filter((rule) => "has" in rule && rule.has);
    expect(byQuery.map((rule) => rule.destination)).toEqual(GUIDE_MATCHUPS.map((mu) => `/guides/${mu.toLowerCase()}`));
    expect(all.indexOf(byQuery[byQuery.length - 1])).toBeLessThan(
      all.findIndex((rule) => rule.source === "/meta" && !("has" in rule && rule.has)),
    );
    const pvz = byQuery.find((rule) => rule.destination === "/guides/pvz");
    expect(pvz?.permanent).toBe(true);
    for (const value of ["PvZ", "pvz", "PVZ"]) expect(pvz && matchesQuery(pvz, "matchup", value)).toBe(true);
    for (const value of ["PvZx", "PvT", ""]) expect(pvz && matchesQuery(pvz, "matchup", value)).toBe(false);
  });

  test("temporarily points home when guides are off", async () => {
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", undefined);
    expect(await allMetaRedirects()).toEqual([
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

describe("/optimizer redirect (next.config.mjs)", () => {
  async function optimizerRedirects() {
    const redirects = nextConfig.redirects;
    if (!redirects) throw new Error("next.config.mjs has no redirects()");
    return (await redirects()).filter((rule) => rule.source.startsWith("/optimizer"));
  }

  test("passes the retired Build adapter URL to the guides permanently", async () => {
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "on");
    expect(await optimizerRedirects()).toEqual([
      { source: "/optimizer", destination: "/guides", permanent: true },
      { source: "/optimizer/:path*", destination: "/guides", permanent: true },
    ]);
  });

  test("points home temporarily when guides are off", async () => {
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", undefined);
    expect(await optimizerRedirects()).toEqual([
      { source: "/optimizer", destination: "/", permanent: false },
      { source: "/optimizer/:path*", destination: "/", permanent: false },
    ]);
  });
});
