/**
 * sitemap — /try is listed only when Instant Analysis is rolled out to
 * everyone (NEXT_PUBLIC_INSTANT_IMPORT=all); "admins" and "off" keep it out.
 * Reviews are forced off so no API call is made.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/reviews", () => ({ reviewsRollout: () => "off" }));
vi.mock("@/lib/serverApi", () => ({ getJson: vi.fn(async () => null) }));

import sitemap from "../sitemap";

async function paths(): Promise<string[]> {
  return (await sitemap()).map((entry) => new URL(entry.url).pathname);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sitemap", () => {
  it("lists /try when Instant Analysis is on for everyone", async () => {
    vi.stubEnv("NEXT_PUBLIC_INSTANT_IMPORT", "all");
    expect(await paths()).toContain("/try");
  });

  it.each(["admins", "off", ""])("leaves /try out when the flag is %j", async (value) => {
    vi.stubEnv("NEXT_PUBLIC_INSTANT_IMPORT", value);
    const listed = await paths();
    expect(listed).not.toContain("/try");
    expect(listed).toContain("/");
  });
});
