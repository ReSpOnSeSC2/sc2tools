import { afterEach, describe, expect, it, vi } from "vitest";
import { absoluteUrl, siteOrigin } from "../absoluteUrl";
import { trimDescription } from "../trimDescription";
import { pageMetadata } from "../pageMetadata";
import { publicDate } from "../publicDate";

afterEach(() => vi.unstubAllEnvs());
describe("public URL origin", () => {
  it.each(["not a URL", "javascript:alert(1)", "https://user:password@outside.invalid"])('uses the public fallback for %s', value => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", value); expect(siteOrigin()).toBe("https://sc2tools.com");
  });
  it("uses only the configured origin and builds absolute structured-data URLs", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://preview.example/base/");
    expect(absoluteUrl("/community/builds/blink?q=1")).toBe("https://preview.example/community/builds/blink?q=1");
  });
  it.each(["https://outside.invalid", "//outside.invalid", "/\\outside.invalid", "/bad\npath"])('rejects non-site path %s', value => expect(() => absoluteUrl(value)).toThrow());
});
describe("word-boundary descriptions", () => {
  it("preserves short normalized text", () => expect(trimDescription(" A   public\n build ")).toBe("A public build"));
  it("adds a real ellipsis within the maximum, at a complete word", () => expect(trimDescription("A practical build order for ladder play", 20)).toBe("A practical build…"));
  it("never splits a surrogate pair when a word exceeds the maximum", () => expect(trimDescription("😀😀😀😀😀", 4)).toBe("😀😀😀…"));
  it("supports a one-character bound", () => expect(trimDescription("Long", 1)).toBe("…"));
});
describe("complete page metadata", () => {
  it("shares one canonical and meaningful social titles without tracking parameters", () => {
    const data = pageMetadata({ title: "Community builds", description: "Public strategies", canonical: "/community?sort=new#cards" });
    expect(data.alternates?.canonical).toBe("/community"); expect(data.openGraph).toMatchObject({ url: "https://sc2tools.com/community", title: "Community builds · SC2 Tools" });
    expect(data.twitter).toMatchObject({ card: "summary_large_image", title: "Community builds · SC2 Tools" });
  });
  it("allows file-based social cards to take precedence", () => {
    const data = pageMetadata({ title: "Replay analyzer", description: "Local replay analysis", canonical: "/try", routeOgImage: true });
    expect(data.openGraph).not.toHaveProperty("images"); expect(data.twitter).not.toHaveProperty("images");
  });
});
describe("public dates", () => {
  it("fixes locale/timezone for hydration regardless of user preference", () => {
    expect(publicDate("2026-10-01T00:00:00.000Z")).toBe("Oct 2026");
    expect(publicDate("2026-10-01T00:00:00.000Z", true)).toBe("October 1, 2026");
  });
  it.each([null, undefined, "not-a-date"])('renders a neutral missing date for %s', value => expect(publicDate(value)).toBe("—"));
});
