// @ts-nocheck
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const imagesDir = path.resolve(
  __dirname,
  "..",
  "..",
  "replay-engine",
  "data",
  "map-images",
);

describe("generated map artwork manifest", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(imagesDir, "manifest.json"), "utf8"),
  );

  test("covers the published season archive with unique canonical IDs", () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.maps.length).toBeGreaterThan(100);
    expect(manifest.seasonRange.min).toBe(36);
    expect(manifest.seasonRange.max).toBe(67);
    expect(manifest.seasonRange.emptySeasonIds).toEqual([61]);
    expect(new Set(manifest.maps.map((entry) => entry.id)).size).toBe(
      manifest.maps.length,
    );
    expect(manifest.skippedArtwork.map((entry) => entry.displayName)).toEqual([
      "Blueshift LE (Test)",
      "Fracture LE (Test)",
      "Para Site LE (Test)",
    ]);
  });

  test("every entry points to a verified optimized WebP rendition", () => {
    for (const entry of manifest.maps) {
      expect(entry.displayName).toBeTruthy();
      expect(entry.seasons.length).toBeGreaterThan(0);
      expect(entry.source.provider).toBe("Sc2ReplayStats");
      expect(entry.source.copyrightOwner).toBe("Blizzard Entertainment");
      expect(entry.source.url).not.toMatch(/\/missing_image\.jpg$/i);
      expect(entry.image.filename).toMatch(/^[a-z0-9_]+\.webp$/);
      expect(entry.image.width).toBe(640);
      expect(entry.image.height).toBe(360);

      const bytes = fs.readFileSync(path.join(imagesDir, entry.image.filename));
      expect(bytes.byteLength).toBe(entry.image.bytes);
      expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(bytes.subarray(8, 12).toString("ascii")).toBe("WEBP");
      expect(crypto.createHash("sha256").update(bytes).digest("hex")).toBe(
        entry.image.sha256,
      );
    }
    const generatedFiles = fs
      .readdirSync(imagesDir)
      .filter((name) => name.endsWith(".webp"));
    expect(generatedFiles).toHaveLength(manifest.maps.length);
  });

  test("every entry carries a verified full-layout rendition for the replayer", () => {
    for (const entry of manifest.maps) {
      expect(entry.layout).toBeTruthy();
      expect(entry.layout.filename).toMatch(/^[a-z0-9_]+\.jpg$/);
      // Layout stems mirror the webp stems so the /v1/map-image
      // variant=layout filename scan resolves them without aliases.
      expect(entry.layout.filename.replace(/\.jpg$/, "")).toBe(
        entry.image.filename.replace(/\.webp$/, ""),
      );
      expect(["curated", "source-original"]).toContain(entry.layout.provenance);
      const bytes = fs.readFileSync(path.join(imagesDir, entry.layout.filename));
      expect(bytes.byteLength).toBe(entry.layout.bytes);
      // JPEG SOI magic — a cached soft-404 HTML page must never ship.
      expect(bytes[0]).toBe(0xff);
      expect(bytes[1]).toBe(0xd8);
      expect(crypto.createHash("sha256").update(bytes).digest("hex")).toBe(
        entry.layout.sha256,
      );
    }
  });
});
