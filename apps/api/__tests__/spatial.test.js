// @ts-nocheck
"use strict";

const { MongoClient } = require("mongodb");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { SpatialService } = require("../src/services/spatial");
const {
  EXPANSION_PROXY_BUILDING_NAMES,
  ownerMain,
} = require("../src/services/proxyClassification");

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

describe("services/spatial proxy heatmaps use the canonical proxy test", () => {
  const BOUNDS = { minX: 0, minY: 0, maxX: 200, maxY: 200 };
  // The user's main, as the $filter on spatial.buildings returns it.
  const MAIN = { name: "Hatchery", time: 0, x: 20, y: 20 };
  let originalPyDir;

  // 200 world units over a 20-cell grid: each cell is 10 units, so the
  // returned cells name the structures that were plotted.
  async function plotted(method, docs) {
    const svc = new SpatialService({ games: buildGames([docs]) });
    const out = await svc[method]("u1", "Goldenaura", {}, { grid: 20 });
    return { out, cells: out.cells.map((c) => `${c.x},${c.y}`).sort() };
  }

  beforeAll(() => {
    originalPyDir = process.env.SC2_PY_ANALYZER_DIR;
    process.env.SC2_PY_ANALYZER_DIR = "/tmp/__nonexistent__";
  });

  afterAll(() => {
    if (originalPyDir === undefined) delete process.env.SC2_PY_ANALYZER_DIR;
    else process.env.SC2_PY_ANALYZER_DIR = originalPyDir;
  });

  test("a version-2 row is plotted as stored", async () => {
    // The agent already applied the per-structure radius; the cloud does
    // not second-guess it, even without a main to test against.
    const { out, cells } = await plotted("proxy", [
      {
        gameId: "g1",
        mapBounds: BOUNDS,
        proxyVersion: 2,
        points: [
          { name: "Hatchery", time: 150, x: 105, y: 20 },
          { name: "Gateway", time: 40, x: 150, y: 150 },
        ],
      },
    ]);
    expect(out.kind).toBe("proxy");
    expect(out.points).toBe(2);
    expect(cells).toEqual(["10,2", "15,15"]);
  });

  test("a version-1 own row drops a 52-unit Hatchery and keeps an 81-unit one", async () => {
    const { out, cells } = await plotted("proxy", [
      {
        gameId: "g1",
        mapBounds: BOUNDS,
        proxyVersion: 1,
        townHalls: [MAIN, { name: "Hatchery", time: 95, x: 72, y: 20 }],
        points: [
          { name: "Hatchery", time: 95, x: 72, y: 20 }, // third base, 52 out
          { name: "Extractor", time: 110, x: 76, y: 24 }, // its gas, 56 out
          { name: "Hatchery", time: 150, x: 101, y: 20 }, // 81 out
          { name: "Gateway", time: 40, x: 72, y: 60 }, // 50-unit radius
        ],
      },
    ]);
    expect(out.points).toBe(2);
    expect(cells).toEqual(["10,2", "7,6"]);
  });

  test("a version-1 own row whose main is not stored drops its wide-radius rows", async () => {
    const { out, cells } = await plotted("proxy", [
      {
        gameId: "g1",
        mapBounds: BOUNDS,
        proxyVersion: 1,
        points: [
          { name: "Hatchery", time: 150, x: 101, y: 20 },
          { name: "Gateway", time: 40, x: 72, y: 60 },
        ],
      },
    ]);
    expect(out.points).toBe(1);
    expect(cells).toEqual(["7,6"]);
  });

  test("a version-1 opponent row drops town halls, gas and crawlers", async () => {
    // No opponent main is stored, so a third base cannot be told from a
    // proxy Hatchery; the heatmap plots neither.
    const { out, cells } = await plotted("opponentProxies", [
      {
        gameId: "g1",
        mapBounds: BOUNDS,
        proxyVersion: 1,
        points: [
          { name: "Hatchery", time: 95, x: 130, y: 180 },
          { name: "Extractor", time: 110, x: 134, y: 184 },
          { name: "SpineCrawler", time: 130, x: 30, y: 30 },
          { name: "Barracks", time: 45, x: 40, y: 40 },
          { name: "Pylon", time: 30, x: 60, y: 30 },
        ],
      },
    ]);
    expect(out.kind).toBe("opp_proxy");
    expect(out.points).toBe(2);
    expect(cells).toEqual(["4,4", "6,3"]);
  });

  test("a version-2 opponent row keeps its Hatchery", async () => {
    const { out } = await plotted("opponentProxies", [
      {
        gameId: "g1",
        mapBounds: BOUNDS,
        proxyVersion: 2,
        points: [{ name: "Hatchery", time: 95, x: 30, y: 30 }],
      },
    ]);
    expect(out.points).toBe(1);
  });

  test("rows with no stamp are plotted as stored", async () => {
    const { out } = await plotted("proxy", [
      {
        gameId: "g1",
        mapBounds: BOUNDS,
        points: [{ name: "Hatchery", time: 95, x: 72, y: 20 }],
      },
    ]);
    expect(out.points).toBe(1);
  });

  test("a map whose stored rows were all third bases returns no cells", async () => {
    const { out } = await plotted("proxy", [
      {
        gameId: "g1",
        mapBounds: BOUNDS,
        proxyVersion: 1,
        townHalls: [MAIN],
        points: [{ name: "Hatchery", time: 95, x: 72, y: 20 }],
      },
    ]);
    expect(out).toMatchObject({ ok: true, points: 0, bounds: BOUNDS, cells: [] });
  });

  test("the own side projects the stamp and only the town halls of version-1 games", async () => {
    let captured;
    const games = buildGames([(pipeline) => { captured = pipeline; return []; }]);
    await new SpatialService({ games }).proxy("u1", "Goldenaura", {});
    const { $project } = captured.find((s) => s && s.$project);
    expect($project.points).toBe("$spatial.my_proxies");
    expect($project.proxyVersion).toBe("$spatial.my_proxy_classification_v");
    // spatial.buildings holds up to 2000 rows a game; it must never be
    // projected whole.
    expect(Object.values($project)).not.toContain("$spatial.buildings");
    const [isVersionOne, filter, otherwise] = $project.townHalls.$cond;
    expect(isVersionOne.$and).toContainEqual({
      $eq: ["$spatial.my_proxy_classification_v", 1],
    });
    expect(filter.$filter.input).toBe("$spatial.buildings");
    expect(otherwise).toBe("$$REMOVE");
    // The projected names must be exactly the rows ownerMain reads, or the
    // derived main could differ from the one the full list gives.
    const [, projectedNames] = filter.$filter.cond.$in;
    const candidates = new Set([
      ...projectedNames, ...EXPANSION_PROXY_BUILDING_NAMES,
    ]);
    for (const name of candidates) {
      const read = ownerMain([{ name, time: 1, x: 5, y: 5 }]) !== null;
      expect([name, projectedNames.includes(name)]).toEqual([name, read]);
    }
  });

  test("the opponent side projects the stamp but no buildings", async () => {
    let captured;
    const games = buildGames([(pipeline) => { captured = pipeline; return []; }]);
    await new SpatialService({ games }).opponentProxies("u1", "Goldenaura", {});
    const { $project } = captured.find((s) => s && s.$project);
    expect($project.points).toBe("$spatial.opp_proxies");
    expect($project.proxyVersion).toBe("$spatial.opp_proxy_classification_v");
    expect($project.townHalls).toBeUndefined();
  });

  test("the other heatmaps project no proxy fields", async () => {
    let captured;
    const games = buildGames([(pipeline) => { captured = pipeline; return []; }]);
    await new SpatialService({ games }).buildings("u1", "Goldenaura", {});
    const { $project } = captured.find((s) => s && s.$project);
    expect(Object.keys($project).sort()).toEqual(
      ["_id", "gameId", "mapBounds", "points"],
    );
  });
});

describe("services/spatial proxy heatmap against Mongo", () => {
  let mongo;
  let client;
  let games;
  let originalPyDir;

  beforeAll(async () => {
    originalPyDir = process.env.SC2_PY_ANALYZER_DIR;
    process.env.SC2_PY_ANALYZER_DIR = "/tmp/__nonexistent__";
    mongo = await MongoMemoryServer.create();
    client = await MongoClient.connect(mongo.getUri());
    games = client.db("spatial_test").collection("games");
    const bounds = { minX: 0, minY: 0, maxX: 200, maxY: 200 };
    // A macro game's own building list: the main, a third base and the
    // rows the heatmap has no use for.
    const buildings = [
      { name: "Hatchery", time: 0, x: 20, y: 20 },
      { name: "Hatchery", time: 95, x: 72, y: 20 },
      ...Array.from({ length: 200 }, (_, i) => (
        { name: "SpineCrawler", time: 200 + i, x: 25, y: 25 }
      )),
    ];
    await games.insertMany([
      {
        userId: "u1",
        gameId: "v1",
        map: "Goldenaura",
        date: new Date("2026-09-02T00:00:00Z"),
        spatial: {
          map_bounds: bounds,
          buildings,
          my_proxy_classification_v: 1,
          my_proxies: [
            { name: "Hatchery", time: 95, x: 72, y: 20 },
            { name: "Hatchery", time: 150, x: 101, y: 20 },
          ],
          opp_proxy_classification_v: 1,
          opp_proxies: [
            { name: "Hatchery", time: 95, x: 130, y: 180 },
            { name: "Barracks", time: 45, x: 40, y: 40 },
          ],
        },
      },
      {
        userId: "u1",
        gameId: "v2",
        map: "Goldenaura",
        date: new Date("2026-09-01T00:00:00Z"),
        spatial: {
          map_bounds: bounds,
          buildings,
          my_proxy_classification_v: 2,
          my_proxies: [{ name: "Gateway", time: 40, x: 150, y: 150 }],
        },
      },
    ]);
  });

  afterAll(async () => {
    if (originalPyDir === undefined) delete process.env.SC2_PY_ANALYZER_DIR;
    else process.env.SC2_PY_ANALYZER_DIR = originalPyDir;
    if (client) await client.close();
    if (mongo) await mongo.stop();
  });

  // The service with the rows Mongo returned to it kept for inspection.
  function serviceRecordingRows() {
    const seen = { rows: [] };
    const recording = {
      aggregate(pipeline) {
        return {
          toArray: async () => {
            seen.rows = await games.aggregate(pipeline).toArray();
            // The service rewrites ``points`` in place; keep Mongo's rows.
            return seen.rows.map((row) => ({ ...row }));
          },
        };
      },
    };
    return { svc: new SpatialService({ games: recording }), seen };
  }

  test("the own side drops the third base and fetches only town halls", async () => {
    const { svc, seen } = serviceRecordingRows();
    const out = await svc.proxy("u1", "Goldenaura", {}, { grid: 20 });
    expect(out.points).toBe(2);
    expect(out.cells.map((c) => `${c.x},${c.y}`).sort()).toEqual(
      ["10,2", "15,15"],
    );
    const byId = Object.fromEntries(seen.rows.map((row) => [row.gameId, row]));
    expect(byId.v1.townHalls).toEqual([
      { name: "Hatchery", time: 0, x: 20, y: 20 },
      { name: "Hatchery", time: 95, x: 72, y: 20 },
    ]);
    // A version-2 game needs no main, so none of its buildings come back.
    expect(byId.v2).not.toHaveProperty("townHalls");
  });

  test("the opponent side drops the version-1 Hatchery", async () => {
    const { svc, seen } = serviceRecordingRows();
    const out = await svc.opponentProxies("u1", "Goldenaura", {}, { grid: 20 });
    expect(out.points).toBe(1);
    expect(out.cells.map((c) => `${c.x},${c.y}`)).toEqual(["4,4"]);
    expect(seen.rows).toHaveLength(1);
    expect(seen.rows[0]).not.toHaveProperty("townHalls");
  });
});
