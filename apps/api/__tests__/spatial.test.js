// @ts-nocheck
"use strict";

const { SpatialService } = require("../src/services/spatial");

function buildGames(handlers) {
  // Each call to aggregate() consumes the next handler. Cycles when
  // handlers run out so legacy single-handler tests keep working.
  let nthCall = 0;
  return {
    aggregate(pipeline) {
      const handler = handlers[nthCall++ % handlers.length];
      const rows = typeof handler === "function" ? handler(pipeline) : handler;
      return {
        toArray: () => Promise.resolve(Array.isArray(rows) ? rows.slice() : []),
      };
    },
  };
}

describe("services/spatial", () => {
  test("maps returns the user's available maps with W/L/winRate", async () => {
    const games = buildGames([
      // First aggregate() — the maps facet.
      [
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
      ],
      // Second aggregate() — the recent-results attachment.
      [
        { _id: "Goldenaura", results: ["Victory", "Victory", "Defeat"] },
        { _id: "Acropolis", results: ["Defeat"] },
      ],
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
    // Recent sparkline data is now attached for both Battlefield and
    // Map Intel surfaces — fixes the "no recent" placeholder regression.
    expect(out[0].recent).toEqual(["win", "win", "loss"]);
    expect(out[1].recent).toEqual(["loss"]);
  });

  test("maps pipeline sorts bounds-having docs first so $first is reliable", async () => {
    let captured;
    const games = buildGames([
      (pipeline) => {
        captured = pipeline;
        return [];
      },
      // Recent-results call is no-op when rows is empty.
    ]);
    const svc = new SpatialService({ games });
    await svc.maps("u1", {});
    // The $sort right before the $group MUST descend on the
    // bounds-presence flag so $first picks a doc with bounds when
    // any exist on the map.
    const groupIdx = captured.findIndex((s) => s && s.$group);
    expect(groupIdx).toBeGreaterThan(-1);
    const sortBeforeGroup = captured[groupIdx - 1];
    expect(sortBeforeGroup.$sort._hasBounds).toBe(-1);
    // Tie-break on date desc keeps the surfaced bounds biased toward
    // the most recent extracted replay.
    expect(sortBeforeGroup.$sort.date).toBe(-1);
    // The added `_hasBounds` field has to come from the spatial
    // map_bounds path — otherwise the sort would always pick the
    // same arbitrary doc.
    const hasBoundsAdd = captured.find(
      (s) => s && s.$addFields && s.$addFields._hasBounds,
    );
    expect(hasBoundsAdd).toBeDefined();
  });

  test("maps emits empty recent when the user has no games yet", async () => {
    const games = buildGames([
      // Empty maps facet → no second call needed.
      [],
    ]);
    const svc = new SpatialService({ games });
    const out = await svc.maps("u1", {});
    expect(out).toEqual([]);
  });

  test("buildings returns an empty payload when no games match", async () => {
    const games = buildGames([[]]);
    const svc = new SpatialService({ games });
    const out = await svc.buildings("u1", "Goldenaura", {});
    expect(out.points).toBe(0);
    expect(out.cells).toEqual([]);
  });

  test("buildings rejects an empty map", async () => {
    const games = buildGames([[]]);
    const svc = new SpatialService({ games });
    await expect(svc.buildings("u1", "", {})).rejects.toThrow(/map_required/);
  });

  test("falls back to JS heatmap when python is unavailable", async () => {
    const games = buildGames([
      [
        {
          gameId: "g1",
          mapBounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
          points: [
            { x: 10, y: 10 },
            { x: 11, y: 9 },
            { x: 90, y: 80 },
          ],
        },
      ],
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
