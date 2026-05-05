// @ts-nocheck
"use strict";

const { SpatialService } = require("../src/services/spatial");

function buildGames(rows) {
  return {
    aggregate() {
      return {
        toArray: () => Promise.resolve(rows.slice()),
      };
    },
  };
}

describe("services/spatial", () => {
  test("maps returns the user's available maps with W/L/winRate", async () => {
    const games = buildGames([
      {
        name: "Goldenaura",
        total: 4,
        wins: 3,
        losses: 1,
        winRate: 0.75,
        lastPlayed: new Date(),
        hasSpatial: true,
        bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      },
      {
        name: "Acropolis",
        total: 1,
        wins: 0,
        losses: 1,
        winRate: 0,
        lastPlayed: new Date(),
        hasSpatial: false,
        bounds: null,
      },
    ]);
    const svc = new SpatialService({ games });
    const out = await svc.maps("u1", {});
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      name: "Goldenaura",
      total: 4,
      wins: 3,
      losses: 1,
      hasSpatial: true,
    });
    expect(out[0].winRate).toBeCloseTo(0.75);
  });

  test("buildings returns an empty payload when no games match", async () => {
    const games = buildGames([]);
    const svc = new SpatialService({ games });
    const out = await svc.buildings("u1", "Goldenaura", {});
    expect(out.points).toBe(0);
    expect(out.cells).toEqual([]);
  });

  test("buildings rejects an empty map", async () => {
    const games = buildGames([]);
    const svc = new SpatialService({ games });
    await expect(svc.buildings("u1", "", {})).rejects.toThrow(/map_required/);
  });

  test("falls back to JS heatmap when python is unavailable", async () => {
    const games = buildGames([
      {
        gameId: "g1",
        mapBounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
        points: [
          { x: 10, y: 10 },
          { x: 11, y: 9 },
          { x: 90, y: 80 },
        ],
      },
    ]);
    const svc = new SpatialService({ games });
    const original = process.env.SC2_PY_ANALYZER_DIR;
    process.env.SC2_PY_ANALYZER_DIR = "/tmp/__nonexistent__";
    try {
      const out = await svc.buildings("u1", "Goldenaura", {}, { grid: 16 });
      expect(out.cells.length).toBeGreaterThan(0);
      expect(out.cells.every((c) => c.intensity >= 0 && c.intensity <= 1)).toBe(true);
    } finally {
      if (original === undefined) delete process.env.SC2_PY_ANALYZER_DIR;
      else process.env.SC2_PY_ANALYZER_DIR = original;
    }
  });
});
