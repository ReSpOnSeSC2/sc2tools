// @ts-nocheck
"use strict";

/**
 * Map Intel heatmap bounds: the 300-game cap, the opponent filter, the
 * sample semantics, the bounded projections and the per-owner cache.
 */
const { MongoClient } = require("mongodb");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { SpatialService, MapIntelCache } = require("../src/services/spatial");

const BOUNDS = { minX: 0, minY: 0, maxX: 200, maxY: 200 };
const ALIASES = { mapExact: ["Goldenaura", "Goldenaura LE"] };
const RIVAL = { "opponent.pulseId": { $in: ["rival"] } };
let mongo;
let client;
let games;

/** 305 owned games with map data on two editions; only the four oldest, against "rival", had a fight. */
function intelRows() {
  const start = Date.parse("2026-01-01T00:00:00Z");
  const rows = Array.from({ length: 305 }, (_, i) => ({
    userId: "u1",
    gameId: `g${i}`,
    map: i % 2 ? "Goldenaura LE" : "Goldenaura",
    date: new Date(start + i * 60_000),
    opponent: { pulseId: i < 4 ? "rival" : `other-${i}`, race: "Z" },
    spatial: {
      map_bounds: BOUNDS,
      buildings: [{ name: "Nexus", time: 0, x: 30, y: 30 }, { name: "Nexus", time: 60, x: 60, y: 30 }],
      ...(i < 4 ? { battles: [{ x: 61, y: 33, weight: 500 }] } : {}),
    },
  }));
  rows.push(
    { userId: "u1", gameId: "no-spatial", map: "Goldenaura", date: new Date(start + 10_000_000) },
    { userId: "u2", gameId: "foreign", map: "Goldenaura", date: new Date(start), spatial: { map_bounds: BOUNDS, battles: [{ x: 1, y: 1 }] } },
    { userId: "u1", gameId: "hidden", map: "Goldenaura", excluded: true, date: new Date(start + 20_000_000), spatial: { map_bounds: BOUNDS, battles: [{ x: 5, y: 5 }] } },
  );
  return rows;
}

/** A service over the real collection that counts its reads. */
function service() {
  let reads = 0;
  const counting = { aggregate(pipeline) { reads += 1; return games.aggregate(pipeline); } };
  return { svc: new SpatialService({ games: counting }), reads: () => reads };
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongo.getUri());
  games = client.db("map_intel_test").collection("games");
  await games.insertMany(intelRows());
});

afterAll(async () => {
  if (client) await client.close();
  if (mongo) await mongo.stop();
});

describe("Map Intel sample bounds", () => {
  test("reads only the 300 most recent owned games with map data and says it was capped", async () => {
    const out = await service().svc.battle("u1", "Goldenaura", ALIASES, { grid: 20 });
    expect(out).toMatchObject({ scanned: 300, capped: true, maxGames: 300, minGames: 3 });
    // The four fights are the oldest games, beyond the newest 300 of 305.
    expect(out).toMatchObject({ games: 0, belowMinimum: true });
  });

  test("an opponent filter keeps only that opponent's games and shows every observed game", async () => {
    const out = await service().svc.battle("u1", "Goldenaura", ALIASES, { grid: 20, opponent: RIVAL });
    expect(out).toMatchObject({ scanned: 4, capped: false, games: 4, minGames: 1, belowMinimum: false, points: 4 });
    expect(out.cells).toEqual([{ x: 6, y: 3, value: 2000, intensity: 1, games: 4 }]);
    expect(out.zones).toEqual([expect.objectContaining({ games: 4, share: 1, base: "natural", area: "bottom left" })]);
  });

  test("without an alias list only the exact map name is read", async () => {
    const out = await service().svc.battle("u1", "Goldenaura LE", {}, { grid: 20, opponent: RIVAL });
    // g1 and g3 are the rival's "Goldenaura LE" games.
    expect(out).toMatchObject({ scanned: 2, games: 2 });
  });

  test("a map with no spatial extract answers an empty sample", async () => {
    const out = await service().svc.battle("u1", "Unplayed", {}, {});
    expect(out).toMatchObject({ scanned: 0, games: 0, bounds: null, cells: [], zones: [], belowMinimum: true });
  });
});

describe("Map Intel bounded projections", () => {
  test("a layer reads positions and weights only, at most 400 building rows a game", async () => {
    let captured;
    const fake = { aggregate(pipeline) { captured = pipeline; return { toArray: async () => [] }; } };
    await new SpatialService({ games: fake }).buildings("u1", "Goldenaura", {});
    expect(captured.find((stage) => stage.$limit).$limit).toBe(301);
    const { $project } = captured.find((stage) => stage.$project);
    expect($project.points.$map.input.$slice[1]).toBe(400);
    expect($project.points.$map.in).toEqual({ x: "$$row.x", y: "$$row.y", weight: "$$row.weight" });
    expect($project.anchors.$map.input.$slice[1]).toBe(12);
  });
});

describe("Map Intel cache", () => {
  test("answers are cached per owner revision and retired by invalidateForUser", async () => {
    const { svc, reads } = service();
    const first = await svc.battle("u1", "Goldenaura", {}, { grid: 20, opponent: RIVAL });
    first.cells.length = 0;
    const second = await svc.battle("u1", "Goldenaura", {}, { grid: 20, opponent: RIVAL });
    expect(reads()).toBe(1);
    // A caller mutating its copy never changes the cached answer.
    expect(second.cells).toHaveLength(1);
    // Layer, filters and opponent are all part of the key.
    await svc.deathZone("u1", "Goldenaura", {}, { grid: 20, opponent: RIVAL });
    await svc.battle("u1", "Goldenaura", { oppRace: "Z" }, { grid: 20, opponent: RIVAL });
    await svc.battle("u1", "Goldenaura", {}, { grid: 20 });
    expect(reads()).toBe(4);
    svc.invalidateForUser("u1");
    await svc.battle("u1", "Goldenaura", {}, { grid: 20, opponent: RIVAL });
    expect(reads()).toBe(5);
  });

  test("entries expire after ten minutes and the least recently used is evicted at capacity", () => {
    let now = 0;
    const cache = new MapIntelCache({ max: 2, now: () => now });
    cache.set("u1", "a", cache.token("u1"), { n: 1 });
    cache.set("u1", "b", cache.token("u1"), { n: 2 });
    expect(cache.get("u1", "a")).toEqual({ n: 1 });
    cache.set("u1", "c", cache.token("u1"), { n: 3 });
    expect(cache.get("u1", "b")).toBeNull();
    now = 10 * 60 * 1000;
    expect(cache.get("u1", "a")).toBeNull();
  });

  test("an answer computed across an invalidation is never stored, and owners are separate", () => {
    const cache = new MapIntelCache({ max: 1 });
    const stale = cache.token("u1");
    cache.set("u2", "k2", cache.token("u2"), { owner: "u2" });
    cache.invalidate("u1");
    cache.set("u1", "k1", stale, { owner: "u1" });
    expect(cache.get("u1", "k1")).toBeNull();
    // The stale answer took no slot, so it evicted nobody's live answer.
    expect(cache.get("u2", "k2")).toEqual({ owner: "u2" });
  });
});
