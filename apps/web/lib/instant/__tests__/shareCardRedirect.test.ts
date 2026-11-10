import { afterEach, describe, expect, test, vi } from "vitest";
import nextConfig from "../../../next.config.mjs";
import { SHARE_LINK_LABEL, SHARE_LINK_URL } from "@/components/analyzer/arcade/ShareCard";
import { getInstantImportMode } from "@/lib/instant/flag";

afterEach(() => {
  vi.unstubAllEnvs();
});

const ATTRIBUTION = "utm_source=card&utm_medium=share&utm_campaign=arcade";

/** The rules that match the address printed on every share card. */
async function shareLinkRedirects() {
  const redirects = nextConfig.redirects;
  if (!redirects) throw new Error("next.config.mjs has no redirects()");
  const sharePath = new URL(SHARE_LINK_URL).pathname;
  return (await redirects()).filter((rule) => rule.source === sharePath);
}

describe("share-card link redirect (next.config.mjs)", () => {
  test("the link in the share text and the watermark on the image are the same address", () => {
    const url = new URL(SHARE_LINK_URL);
    expect(`${url.host}${url.pathname}`).toBe(SHARE_LINK_LABEL);
  });

  test.each(["all", " ALL ", "All"])(
    "lands on the no-install analyzer when it is open to everyone (%j)",
    async (value) => {
      vi.stubEnv("NEXT_PUBLIC_INSTANT_IMPORT", value);
      // The page itself must be open under the same value, or the card
      // link would land on a hidden page.
      expect(getInstantImportMode()).toBe("all");
      expect(await shareLinkRedirects()).toEqual([
        { source: "/arcade", destination: `/try?${ATTRIBUTION}`, permanent: false },
      ]);
    },
  );

  test.each(["off", "admins", " Admins ", "", "yes", "1", "true", undefined])(
    "points home while the analyzer is hidden (%j)",
    async (value) => {
      vi.stubEnv("NEXT_PUBLIC_INSTANT_IMPORT", value);
      expect(getInstantImportMode()).not.toBe("all");
      expect(await shareLinkRedirects()).toEqual([
        { source: "/arcade", destination: `/?${ATTRIBUTION}`, permanent: false },
      ]);
    },
  );

  test("stays temporary so a real /arcade page can replace it", async () => {
    for (const value of ["all", "off"]) {
      vi.stubEnv("NEXT_PUBLIC_INSTANT_IMPORT", value);
      const rules = await shareLinkRedirects();
      expect(rules).toHaveLength(1);
      expect(rules[0].permanent).toBe(false);
    }
  });
});
