import { describe, expect, it } from "vitest";
import { getIconPath, resolveStrategyIcons } from "@/lib/sc2-icons";

describe("sc2-icons - crawler building icons", () => {
  it("resolves Spine Crawler names used by the macro roster", () => {
    const expected = "/icons/sc2/buildings/spinecrawler.png";
    expect(getIconPath("SpineCrawler", "building")).toBe(expected);
    expect(getIconPath("Spine Crawler", "building")).toBe(expected);
    expect(getIconPath("SpineCrawlerUprooted", "building")).toBe(expected);
    expect(getIconPath("spine", "building")).toBe(expected);
  });

  it("resolves Spore Crawler names used by the macro roster", () => {
    const expected = "/icons/sc2/buildings/sporecrawler.png";
    expect(getIconPath("SporeCrawler", "building")).toBe(expected);
    expect(getIconPath("Spore Crawler", "building")).toBe(expected);
    expect(getIconPath("SporeCrawlerUprooted", "building")).toBe(expected);
    expect(getIconPath("spore", "building")).toBe(expected);
  });

  it("includes crawler buildings in strategy keyword resolution", () => {
    expect(resolveStrategyIcons("Spine Crawler rush", 1)).toEqual([
      "/icons/sc2/buildings/spinecrawler.png",
    ]);
    expect(resolveStrategyIcons("Spore Crawler safety", 1)).toEqual([
      "/icons/sc2/buildings/sporecrawler.png",
    ]);
  });
});
