import { describe, expect, it } from "vitest";
import {
  availableMapImages,
  canonicalMapImageKey,
  getMapImageUrl,
  resolveMapImage,
} from "../map-images";

describe("map image registry", () => {
  it("ships real imported entries", () => {
    expect(availableMapImages().length).toBeGreaterThan(100);
  });

  it("normalizes ladder suffixes, punctuation, and curly apostrophes", () => {
    expect(canonicalMapImageKey("16-Bit LE")).toBe("16bit");
    expect(canonicalMapImageKey("10,000 Feet LE")).toBe("10000feet");
    expect(canonicalMapImageKey("At Eternity’s Edge LE")).toBe(
      "ateternitysedge",
    );
  });

  it("resolves a raw replay name without its LE suffix", () => {
    expect(resolveMapImage("Ruby Rock")?.displayName).toBe("Ruby Rock LE");
    expect(getMapImageUrl("Ruby Rock")).toContain(
      "/v1/map-image?map=Ruby%20Rock%20LE",
    );
  });

  it("does not request unknown artwork", () => {
    expect(resolveMapImage("A Map That Does Not Exist")).toBeNull();
    expect(getMapImageUrl("A Map That Does Not Exist")).toBeNull();
  });
});
