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

describe("sc2-icons - Terran add-ons", () => {
  it("resolves every *Reactor name onto the shared reactor PNG", () => {
    const expected = "/icons/sc2/buildings/reactor.png";
    expect(getIconPath("Reactor", "building")).toBe(expected);
    expect(getIconPath("BarracksReactor", "building")).toBe(expected);
    expect(getIconPath("FactoryReactor", "building")).toBe(expected);
    expect(getIconPath("StarportReactor", "building")).toBe(expected);
  });

  it("resolves every *TechLab name onto the shared tech-lab PNG", () => {
    const expected = "/icons/sc2/buildings/techlab.png";
    expect(getIconPath("TechLab", "building")).toBe(expected);
    expect(getIconPath("BarracksTechLab", "building")).toBe(expected);
    expect(getIconPath("FactoryTechLab", "building")).toBe(expected);
    expect(getIconPath("StarportTechLab", "building")).toBe(expected);
  });

  it("resolves add-on names without a kind hint (roster passes 'building')", () => {
    // The macro roster always passes kind="building", but the resolver
    // should also work bare so future callers don't regress.
    expect(getIconPath("BarracksReactor")).toBe(
      "/icons/sc2/buildings/reactor.png",
    );
    expect(getIconPath("FactoryTechLab")).toBe(
      "/icons/sc2/buildings/techlab.png",
    );
  });
});

describe("sc2-icons - lift-off and state-morph names", () => {
  it("resolves flying Terran structures onto their grounded icon", () => {
    expect(getIconPath("BarracksFlying", "building")).toBe(
      "/icons/sc2/buildings/barracks.png",
    );
    expect(getIconPath("CommandCenterFlying", "building")).toBe(
      "/icons/sc2/buildings/commandcenter.png",
    );
    expect(getIconPath("FactoryFlying", "building")).toBe(
      "/icons/sc2/buildings/factory.png",
    );
    expect(getIconPath("OrbitalCommandFlying", "building")).toBe(
      "/icons/sc2/buildings/orbitalcommand.png",
    );
    expect(getIconPath("StarportFlying", "building")).toBe(
      "/icons/sc2/buildings/starport.png",
    );
  });

  it("resolves lowered depots and Nydus exits", () => {
    expect(getIconPath("SupplyDepotLowered", "building")).toBe(
      "/icons/sc2/buildings/supplydepot.png",
    );
    expect(getIconPath("NydusCanal", "building")).toBe(
      "/icons/sc2/buildings/nydusnetwork.png",
    );
    expect(getIconPath("NydusWorm", "building")).toBe(
      "/icons/sc2/buildings/nydusnetwork.png",
    );
  });
});
