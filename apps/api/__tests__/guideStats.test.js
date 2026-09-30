// @ts-nocheck
"use strict";

/**
 * services/guideStats.js against mongod — the games side of the nightly
 * guide aggregate: CELL / PAGE floors, Wilson ranking, era split, the
 * per-user cap, custom-name exclusion, allowlisted leaks, canonical maps,
 * counter/map docs, stale cleanup and single flight.
 * (Samples: guideStatsSamples.test.js; history/examples/PII:
 * guideStatsHistory.test.js; job: guideStatsJob.test.js.)
 */

const { GuideStatsService } = require("../src/services/guideStats");
const { wilsonInterval } = require("../src/util/wilson");
const {
  NOW_MS, DAY_MS, BEFORE_BUILD, GLAIVES, PHOENIX,
  startDb, resetDb, slimGame, cellGames, statsByKey,
} = require("./helpers/guideStatsSeed");

const VOID_RAY = "PvZ - 2 Stargate Void Ray";
const THREE_GATE_PHOENIX = "PvZ - 3 Stargate Phoenix";
const KEY_GLAIVES = "build:after:PvZ:stargate-into-glaives";

describe("GuideStatsService.recompute — games aggregate", () => {
  let mongo; let db;

  beforeAll(async () => {
    ({ mongo, db } = await startDb("sc2tools_test_guide_stats"));
  });
  beforeEach(async () => {
    await resetDb(db);
  });
  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  const service = () => new GuideStatsService(db, { logger: null, now: () => NOW_MS });
  const recompute = async () => {
    await service().recompute();
    return statsByKey(db);
  };

  test("cell and page floors: below either floor nothing numeric is stored", async () => {
    await db.games.insertMany([
      ...cellGames({ users: 4, perUser: 40, winsPerUser: 20, userPrefix: "four", overrides: { myBuild: PHOENIX } }),
      ...cellGames({
        users: 6, perUser: 4, winsPerUser: 2, userPrefix: "few", overrides: { myBuild: THREE_GATE_PHOENIX },
      }),
      ...cellGames({ users: 6, perUser: 10, winsPerUser: 5, userPrefix: "cell", overrides: { myBuild: VOID_RAY } }),
      ...cellGames({ users: 6, perUser: 20, winsPerUser: 11, userPrefix: "page", overrides: { myBuild: GLAIVES } }),
    ]);
    const docs = await recompute();

    for (const slug of ["2-stargate-phoenix", "3-stargate-phoenix"]) {
      const doc = docs.get(`build:after:PvZ:${slug}`);
      expect(doc).toMatchObject({
        published: false, overall: null, prevalence: null, matchupGames: null, headline: null,
      });
      expect(doc.bands).toEqual({ league: [], mmr: [] });
      expect(doc.maps).toEqual([]);
      expect(doc.vsStrategy).toEqual([]);
      expect(doc.lengths).toEqual([]);
    }
    const cellOnly = docs.get("build:after:PvZ:2-stargate-void-ray");
    expect(cellOnly.overall).toMatchObject({ games: 60, users: 6, wins: 30, winRate: 0.5 });
    expect(cellOnly.published).toBe(false);
    expect(cellOnly.firstPublishedAt).toBeNull();

    const page = docs.get(KEY_GLAIVES);
    expect(page.published).toBe(true);
    expect(page.overall).toEqual({ games: 120, users: 6, wins: 66, winRate: 0.55, ci: wilsonInterval(66, 120) });
    expect(page.matchupGames).toBe(364);
    expect(page.prevalence).toBe(Math.round((120 / 364) * 10000) / 10000);
    expect(page.headline).toEqual({ scope: "league", value: 4, label: "Diamond", games: 120, winRate: 0.55 });
    expect(page.bands.mmr).toEqual([expect.objectContaining({ value: 4000, label: "4000–4500", games: 120 })]);

    const matchup = docs.get("matchup:after:PvZ");
    expect(matchup).toMatchObject({ games: 364, users: 22, published: true });
    expect(matchup.builds.map((b) => b.buildKey).sort()).toEqual([VOID_RAY, GLAIVES].sort());
  });

  test("band cells below the floor are omitted; headline = the league band with the most games, else overall", async () => {
    const league = (leagueId) => ({ opponent: { leagueId } });
    await db.games.insertMany([
      ...cellGames({ users: 6, perUser: 10, winsPerUser: 6, userPrefix: "dia", overrides: league(4) }),
      ...cellGames({ users: 6, perUser: 6, winsPerUser: 2, userPrefix: "mas", overrides: league(5) }),
      ...cellGames({ users: 4, perUser: 10, winsPerUser: 5, userPrefix: "plat", overrides: league(3) }),
      ...cellGames({ users: 6, perUser: 4, winsPerUser: 2, userPrefix: "gold", overrides: league(2) }),
      ...[0, 1, 2].flatMap((id) => cellGames({
        users: 6, perUser: 2, winsPerUser: 1, userPrefix: `vr${id}`,
        overrides: { myBuild: VOID_RAY, opponent: { leagueId: id, mmr: 2600 } },
      })),
    ]);
    const docs = await recompute();
    const glaives = docs.get(KEY_GLAIVES);
    expect(glaives.overall).toMatchObject({ games: 160, users: 22 });
    expect(glaives.bands.league).toEqual([
      { games: 60, users: 6, wins: 36, winRate: 0.6, ci: wilsonInterval(36, 60), value: 4, label: "Diamond" },
      { games: 36, users: 6, wins: 12, winRate: 0.3333, ci: wilsonInterval(12, 36), value: 5, label: "Master" },
    ]);
    expect(glaives.headline).toEqual({ scope: "league", value: 4, label: "Diamond", games: 60, winRate: 0.6 });

    const voidRay = docs.get("build:after:PvZ:2-stargate-void-ray");
    expect(voidRay.overall).toMatchObject({ games: 36, users: 18, wins: 18 });
    expect(voidRay.bands.league).toEqual([]);
    expect(voidRay.bands.mmr).toEqual([expect.objectContaining({ value: 2500, games: 36 })]);
    expect(voidRay.headline).toEqual({ scope: "all", value: null, label: null, games: 36, winRate: 0.5 });
  });

  test("counter pages: PAGE floor on games vs the strategy, openers ranked by Wilson lower bound", async () => {
    const twelvePool = { opponent: { strategy: "Zerg - 12 Pool" } };
    await db.games.insertMany([
      ...cellGames({ users: 6, perUser: 10, winsPerUser: 8, userPrefix: "g", overrides: twelvePool }),
      ...cellGames({
        users: 6, perUser: 10, winsPerUser: 5, userPrefix: "v", overrides: { ...twelvePool, myBuild: VOID_RAY },
      }),
      ...cellGames({ users: 6, perUser: 5, winsPerUser: 5, userPrefix: "m", overrides: { map: "Alcyone LE" } }),
    ]);
    const docs = await recompute();
    const counter = docs.get("counter:after:PvZ:12-pool");
    expect(counter).toMatchObject({
      published: true, strategyKey: "Zerg - 12 Pool",
      overall: { games: 120, users: 12, wins: 78, winRate: 0.65, ci: wilsonInterval(78, 120) },
    });
    expect(counter.openers.map((o) => [o.buildKey, o.buildSlug, o.games])).toEqual([
      [GLAIVES, "stargate-into-glaives", 60],
      [VOID_RAY, "2-stargate-void-ray", 60],
    ]);
    const matchup = docs.get("matchup:after:PvZ");
    expect(matchup.counters[0]).toEqual({
      strategyKey: "Zerg - 12 Pool", strategySlug: "12-pool", published: true, games: 120,
    });
    expect(matchup.counters.slice(1).every((c) => c.published === false && c.games === null)).toBe(true);
    // A map with one floor-clearing matchup cell but under 100 games: a doc, not a page.
    expect(docs.get("map:after:alcyone-le")).toMatchObject({ published: false, games: 30 });
  });

  test("rankings use the Wilson lower bound, never the raw win rate", async () => {
    await db.games.insertMany([
      ...cellGames({ users: 6, perUser: 5, winsPerUser: 4, userPrefix: "hot", overrides: { myBuild: VOID_RAY } }),
      ...cellGames({ users: 10, perUser: 30, winsPerUser: 23, userPrefix: "big", overrides: { myBuild: GLAIVES } }),
    ]);
    const docs = await recompute();
    const [first, second] = docs.get("matchup:after:PvZ").builds;
    expect(first.buildKey).toBe(GLAIVES);
    expect(second.buildKey).toBe(VOID_RAY);
    expect(second.winRate).toBeGreaterThan(first.winRate);
    expect(second.ci.low).toBeLessThan(first.ci.low);
    expect(first.ci).toEqual(wilsonInterval(230, 300));
  });

  test("patch eras are aggregated separately (gameBuild, then gameVersion, then date)", async () => {
    await db.games.insertMany([
      ...cellGames({ users: 6, perUser: 20, winsPerUser: 10, userPrefix: "now" }),
      ...cellGames({ users: 6, perUser: 5, winsPerUser: 5, userPrefix: "old", overrides: { gameBuild: BEFORE_BUILD } }),
      ...cellGames({
        users: 6, perUser: 3, winsPerUser: 0, userPrefix: "ver",
        overrides: { gameBuild: undefined, gameVersion: "5.0.15.96883" },
      }),
      ...cellGames({
        users: 6, perUser: 2, winsPerUser: 2, userPrefix: "date",
        overrides: { gameBuild: undefined, date: new Date("2026-05-01T00:00:00.000Z") },
      }),
    ]);
    const docs = await recompute();
    expect(docs.get(KEY_GLAIVES).overall).toMatchObject({ games: 120, wins: 60 });
    const before = docs.get("build:before:PvZ:stargate-into-glaives");
    expect(before.overall).toMatchObject({ games: 60, users: 18, wins: 42 });
    expect(before.published).toBe(false);
    expect(docs.get("matchup:before:PvZ").games).toBe(60);
  });

  test("one user can contribute at most 50 games per build per era", async () => {
    const whale = Array.from({ length: 500 }, (_, i) => slimGame({
      userId: "whale", result: "Victory", date: new Date(NOW_MS - i * 60_000),
    }));
    const whaleBefore = Array.from({ length: 80 }, () => slimGame({ userId: "whale", gameBuild: BEFORE_BUILD }));
    await db.games.insertMany([
      ...whale, ...whaleBefore,
      ...cellGames({ users: 5, perUser: 12, winsPerUser: 0, userPrefix: "honest" }),
    ]);
    const docs = await recompute();
    expect(docs.get(KEY_GLAIVES).overall).toMatchObject({ games: 110, users: 6, wins: 50 });
    expect(docs.get("matchup:after:PvZ").games).toBe(110);
    expect(docs.get("build:before:PvZ:stargate-into-glaives").overall).toBeNull();
  });

  test("custom builds, private names, custom/unknown strategies and ineligible games are excluded", async () => {
    const twelvePool = { opponent: { strategy: "Zerg - 12 Pool" } };
    await db.games.insertMany([
      ...cellGames({ users: 6, perUser: 10, winsPerUser: 5, userPrefix: "ok", overrides: twelvePool }),
      ...cellGames({
        users: 6, perUser: 10, winsPerUser: 5, userPrefix: "ok",
        overrides: { ...twelvePool, _customOpponentStrategySlug: "my-read" },
      }),
      // The 8-worker patch's label for the same opener is not a catalog
      // strategy, so it gets no counter row.
      ...cellGames({
        users: 6, perUser: 10, winsPerUser: 5, userPrefix: "ok",
        overrides: { opponent: { strategy: "Zerg - 8 Pool" } },
      }),
      ...cellGames({
        users: 6, perUser: 10, winsPerUser: 5, userPrefix: "ok",
        overrides: { opponent: { strategy: "Zerg - PII secret read" } },
      }),
      ...cellGames({ users: 6, perUser: 10, userPrefix: "cb", overrides: { _customBuildSlug: "private-build" } }),
      ...cellGames({ users: 6, perUser: 10, userPrefix: "name", overrides: { myBuild: "PvZ - PII private build" } }),
      ...cellGames({ users: 6, perUser: 10, userPrefix: "team", overrides: { playerCount: 4 } }),
      ...cellGames({ users: 6, perUser: 10, userPrefix: "custom", overrides: { isLadderGame: false } }),
      ...cellGames({ users: 6, perUser: 10, userPrefix: "resumed", overrides: { isResumedFromReplay: true } }),
      ...cellGames({ users: 6, perUser: 10, userPrefix: "random", overrides: { myRace: "Random" } }),
    ]);
    const docs = await recompute();
    const doc = docs.get(KEY_GLAIVES);
    expect(doc.overall).toMatchObject({ games: 240, users: 6, wins: 120 });
    expect(doc.vsStrategy).toEqual([
      expect.objectContaining({ strategyKey: "Zerg - 12 Pool", strategySlug: "12-pool", games: 60 }),
    ]);
    expect(docs.has("counter:after:PvZ:8-pool")).toBe(false);
    expect(docs.get("counter:after:PvZ:12-pool")).toMatchObject({
      published: false, overall: expect.objectContaining({ games: 60 }),
    });
    const all = JSON.stringify([...docs.values()]);
    expect(all).not.toContain("PII");
  });

  test("lengths, maps (one canonical spelling per slug), macro and allowlisted leaks", async () => {
    await db.games.insertMany([
      ...cellGames({
        users: 6, perUser: 20, winsPerUser: 12, userPrefix: "a",
        overrides: {
          durationSec: 300, macroScore: 70, top3Leaks: [{ name: "Supply Blocked" }, { name: "PII_LEAK text" }],
        },
      }),
      ...cellGames({
        users: 6, perUser: 6, winsPerUser: 3, userPrefix: "b",
        overrides: { map: "site delta le", durationSec: 1300, macroScore: 40, top3Leaks: [{ name: "Mineral Float" }] },
      }),
      // Scored and clean (no leak entry): part of every leak's denominator.
      ...cellGames({
        users: 6, perUser: 4, winsPerUser: 2, userPrefix: "c",
        overrides: { map: "site delta le", durationSec: 700, macroScore: 90, top3Leaks: [] },
      }),
      // Unscored (no macroScore): neither macro nor leaks — even with a leak entry.
      ...cellGames({
        users: 6, perUser: 1, userPrefix: "d",
        overrides: { map: "site delta le", durationSec: 700, top3Leaks: [{ name: "Supply Blocked" }] },
      }),
    ]);
    const docs = await recompute();
    const doc = docs.get(KEY_GLAIVES);
    expect(doc.lengths).toEqual([
      expect.objectContaining({ bucket: "0-6", minSec: 0, maxSec: 360, games: 120 }),
      expect.objectContaining({ bucket: "10-15", minSec: 600, maxSec: 900, games: 30 }),
      expect.objectContaining({ bucket: "20+", minSec: 1200, maxSec: null, games: 36 }),
    ]);
    expect(doc.maps).toEqual([expect.objectContaining({ map: "Site Delta LE", mapSlug: "site-delta-le", games: 120 })]);
    const scored = 120 + 36 + 24;
    expect(doc.macro).toEqual({
      avgScore: Math.round(((120 * 70 + 36 * 40 + 24 * 90) / scored) * 10) / 10, games: scored, users: 18,
    });
    expect(doc.leaks).toEqual({
      games: scored, users: 18,
      items: [
        { name: "Supply Blocked", games: 120, users: 6, share: Math.round((120 / scored) * 10000) / 10000 },
        { name: "Mineral Float", games: 36, users: 6, share: Math.round((36 / scored) * 10000) / 10000 },
      ],
    });
    const mapDocs = [...docs.values()].filter((d) => d.kind === "map");
    expect(mapDocs).toHaveLength(1);
    expect(mapDocs[0]).toMatchObject({
      key: "map:after:site-delta-le", map: "Site Delta LE", published: true, games: 120,
      matchups: [expect.objectContaining({
        matchup: "PvZ", games: 120, openers: [expect.objectContaining({ buildKey: GLAIVES })],
      })],
    });
    expect(JSON.stringify(doc)).not.toContain("PII_LEAK");
  });

  test("every doc is replaced by key; docs not rewritten this run are deleted; the run doc remains", async () => {
    await db.games.insertMany(cellGames({ users: 6, perUser: 20, winsPerUser: 10, userPrefix: "a" }));
    await db.guideStats.insertOne({
      kind: "map", key: "map:after:retired-map", era: "after", computedAt: new Date(NOW_MS - DAY_MS),
    });
    const svc = service();
    const first = await svc.recompute();
    const second = await svc.recompute();
    expect(second.computedAt.getTime()).toBeGreaterThan(first.computedAt.getTime());
    const docs = await statsByKey(db);
    expect(docs.has("map:after:retired-map")).toBe(false);
    expect(docs.get("run")).toMatchObject({ kind: "run", counts: { builds: 1, published: 1, counters: 0, maps: 1 } });
    expect(await db.guideStats.countDocuments({ key: KEY_GLAIVES })).toBe(1);
    expect(await svc.readRun()).toEqual({ computedAt: second.computedAt, durationMs: 0, counts: second.counts });
    const kinds = new Set([...docs.values()].map((d) => d.kind));
    expect(kinds).toEqual(new Set(["build", "matchup", "counter", "map", "run"]));
    // Every catalog build and strategy of every matchup gets a doc per era.
    expect([...docs.values()].filter((d) => d.kind === "matchup")).toHaveLength(18);
  });

  test("concurrent recomputes share one in-flight run plus one queued rerun", async () => {
    await db.games.insertMany(cellGames({ users: 6, perUser: 5, userPrefix: "a" }));
    const svc = service();
    const spy = jest.spyOn(svc, "_recomputeOnce");
    const [a, b, c] = await Promise.all([svc.recompute(), svc.recompute(), svc.recompute()]);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });
});
