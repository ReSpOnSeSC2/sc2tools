// @ts-nocheck
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { CatalogService } = require("../src/services/catalog");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sc2tools-cat-"));
}

function buildFakeAnalyzerDir() {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "data", "sc2_catalog.json"),
    JSON.stringify({
      units: [
        { name: "Stalker", display: "Stalker", race: "Protoss", category: "unit", tier: 2, isBuilding: false },
      ],
      buildings: [
        { name: "Pylon", display: "Pylon", race: "Protoss", category: "supply", tier: 1, isBuilding: true },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(dir, "data", "definitions.json"),
    JSON.stringify({
      version: 1,
      generatedAt: "2026-04-01T00:00:00Z",
      timings: { Pylon: { earliest: 12 } },
      buildCategories: ["supply"],
    }),
  );
  fs.mkdirSync(path.join(dir, "data", "map_assets"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "data", "map_assets", "Goldenaura.jpg"),
    Buffer.from("FAKEJPG"),
  );
  return dir;
}

function buildGames(rows) {
  let i = 0;
  return {
    find() {
      return {
        sort: () => ({
          limit: () => ({
            [Symbol.asyncIterator]: async function* () {
              for (const row of rows) yield row;
            },
          }),
        }),
      };
    },
  };
}

describe("services/catalog", () => {
  test("loads catalog json + definitions and provides lookup", async () => {
    const dir = buildFakeAnalyzerDir();
    try {
      const svc = new CatalogService({}, { projectDir: dir });
      const catalog = await svc.catalog();
      expect(catalog.units).toHaveLength(1);
      expect(catalog.buildings).toHaveLength(1);
      const lookup = svc.catalogLookup();
      expect(lookup.lookup("Pylon")?.race).toBe("Protoss");
      expect(lookup.lookup("Stalker")?.tier).toBe(2);
      expect(lookup.lookup("Nonexistent")).toBeNull();
      const defs = await svc.definitions();
      expect(defs.version).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns minimal definitions fallback when file is missing", async () => {
    const dir = tempDir();
    try {
      const svc = new CatalogService({}, { projectDir: dir });
      const defs = await svc.definitions();
      expect(defs.version).toBe(0);
      expect(defs.timings).toEqual({});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("mapImagePath finds .jpg variant", () => {
    const dir = buildFakeAnalyzerDir();
    try {
      const svc = new CatalogService({}, { projectDir: dir });
      const found = svc.mapImagePath("Goldenaura");
      expect(found?.contentType).toBe("image/jpeg");
      expect(found?.path).toContain("Goldenaura.jpg");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("mapImagePath returns null for unknown maps", () => {
    const dir = buildFakeAnalyzerDir();
    try {
      const svc = new CatalogService({}, { projectDir: dir });
      expect(svc.mapImagePath("Nonexistent")).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("playbackInfo returns the stub error envelope", () => {
    const svc = new CatalogService({}, { projectDir: null });
    const info = /** @type {any} */ (svc.playbackInfo());
    expect(info.code).toBe("playback_local_only");
  });

  test("exportCsv yields a header followed by escaped rows", async () => {
    const games = buildGames([
      {
        gameId: "g1",
        date: new Date("2026-04-01"),
        result: "Victory",
        myRace: "Protoss",
        myBuild: "P - Stargate",
        map: "Goldenaura",
        durationSec: 600,
        macroScore: 85,
        apm: 165,
        spq: 12,
        opponent: { displayName: "Foo,Bar", race: "Z", mmr: 4000 },
      },
    ]);
    const svc = new CatalogService({ games }, { projectDir: null });
    const chunks = [];
    for await (const chunk of svc.exportCsv("u1", {})) chunks.push(chunk);
    const csv = chunks.join("");
    expect(csv).toMatch(/^gameId,date,result/);
    expect(csv).toContain('"Foo,Bar"');
    expect(csv).toContain("g1");
  });
});
