import { describe, expect, it } from "vitest";
import {
  availableMapImages,
  canonicalMapImageKey,
  getMapImageUrl,
  getMapLayoutUrl,
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

  it("builds layout URLs from the raw name without manifest gating", () => {
    // The layout render set is resolved server-side and differs from
    // the thumbnail manifest — a name the manifest doesn't know must
    // still produce a URL (the API 404s and the replayer falls back).
    expect(getMapLayoutUrl("Alcyone LE")).toContain(
      "/v1/map-image?map=Alcyone%20LE&variant=layout",
    );
    expect(getMapLayoutUrl("A Map That Does Not Exist")).toContain(
      "variant=layout",
    );
    expect(getMapLayoutUrl("")).toBeNull();
    expect(getMapLayoutUrl(null)).toBeNull();
  });
});
