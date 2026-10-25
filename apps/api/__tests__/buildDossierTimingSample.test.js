"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { GameDetailsService } = require("../src/services/gameDetails");
const { MongoDetailsStore } = require("../src/services/gameDetailsStore");
const { BuildsService } = require("../src/services/builds");
const { CustomBuildsService } = require("../src/services/customBuilds");
const { hydrateDossierTimings } = require("../src/services/buildDossierTimingSample");

/** @type {import('mongodb-memory-server').MongoMemoryServer} */ let mongo;
/** @type {import('mongodb').MongoClient} */ let client;
/** @type {import('mongodb').Db} */ let database;
const owner = "synthetic-timing-owner";
const ref = { source: "custom", key: "custom:dt", slug: "dt", name: "DT Rush" };

beforeAll(async () => {
  mongo = await MongoMemoryServer.create(); client = new MongoClient(mongo.getUri()); await client.connect();
  database = client.db("synthetic_dossier_split_store");
});
afterEach(async () => {
  for (const name of ["games", "game_details", "custom_builds", "custom_build_jobs"]) await database.collection(name).deleteMany({});
  jest.restoreAllMocks();
});
afterAll(async () => { await client?.close(); await mongo?.stop(); });

async function fixture(buildName = ref.name) {
  const games = database.collection("games"), customBuilds = database.collection("custom_builds");
  const details = new GameDetailsService(new MongoDetailsStore({ gameDetails: database.collection("game_details") }));
  const base = { userId: owner, myBuild: buildName, _customBuildSlug: "dt", myRace: "Protoss",
    opponent: { race: "Zerg", strategy: "Zerg - Rush", displayName: "Synthetic opponent" },
    result: "Victory", map: "Synthetic map", durationSec: 900, gameVersion: "5.0.16.97425" };
  const rows = Array.from({ length: 30 }, (_, index) => ({ ...base, gameId: `game-${index}`,
    date: new Date(Date.UTC(2026, 0, index + 1)), result: index % 2 ? "Defeat" : "Victory", macroScore: index,
    ...(index < 2 ? { buildIntent: { status: "confirmed", applied: true, build: ref,
      detected: { name: index ? ref.name : "Other opening", slug: index ? ref.slug : "other" } } } : {}),
  }));
  const hidden = [{ excluded: true }, { _deleted: true }, { _deletionPending: true },
    { isResumedFromReplay: true }, { userId: "another-owner" }];
  for (const [index, marker] of hidden.entries()) rows.push({ ...base, gameId: `ineligible-${index}`,
    date: new Date(Date.UTC(2026, 5, index + 1)), macroScore: 100, ...marker });
  await games.insertMany(rows);
  for (const row of rows) await details.upsert(row.userId, row.gameId, row.date, {
    buildLog: ["[3:30] Gateway", "[4:00] Gateway"], oppBuildLog: ["[1:20] SpawningPool"],
    macroBreakdown: { stats_events: [{ privateHeavy: "not requested" }] },
  });
  await customBuilds.insertOne({ userId: owner, slug: ref.slug, name: buildName, race: "Protoss", vsRace: "Zerg", rules: [] });
  return { games, customBuilds, customBuildJobs: database.collection("custom_build_jobs"), details };
}

test.each(["catalog", "custom"])("%s timings use at most25 split-store logs while all performance facets stay complete", async source => {
  const deps = await fixture(), read = jest.spyOn(deps.details, "findMany");
  const result = source === "catalog"
    ? await new BuildsService(deps, { gameDetails: deps.details }).detail(owner, ref.name, {})
    : await new CustomBuildsService(deps, { perGame: /** @type {any} */ ({ gameDetails: deps.details }) }).evaluateBuild(owner, ref.slug);
  expect(result).toMatchObject({ totals: { total: 30, wins: 15, losses: 15 },
    macro: { gamesWithScore: 30, avgMacroScore: 14.5 }, timingSampleGames: 25, timingSampleSelected: 25, timingSampleLimit: 25, timingsTruncated: true,
    plan: { declared: 2, held: 1, knockedOff: 1 } });
  expect(/** @type {any} */ (result).medianTimingsLegacy.Gateway).toMatchObject({ sampleCount: 25, medianSeconds: 210 });
  expect(read).toHaveBeenCalledTimes(25);
  for (const [userId, ids, opts] of read.mock.calls) {
    expect(userId).toBe(owner); expect(ids).toHaveLength(1); expect(ids[0]).toMatch(/^game-/);
    expect(opts).toMatchObject({ fields: ["buildLog", "oppBuildLog"], concurrency: 1 });
  }
  const stored = await deps.games.findOne({ gameId: "game-29" });
  expect(stored).not.toHaveProperty("buildLog");
});

test.each(["catalog", "custom"])("%s detail cannot map a same-name private classifier to a public guide", async source => {
  const buildName = "PvZ - 2 Stargate Phoenix", deps = await fixture(buildName);
  await deps.games.updateMany({}, { $set: { gameVersion: "5.0.17.98000" } });
  const find = jest.fn(), db = { ...deps, guideStats: /** @type {any} */ ({ find }) };
  const result = source === "catalog"
    ? await new BuildsService(db, { gameDetails: deps.details }).detail(owner, buildName, {})
    : await new CustomBuildsService(db, { perGame: /** @type {any} */ ({ gameDetails: deps.details }) }).evaluateBuild(owner, ref.slug);
  expect(result).toMatchObject({ communityTimings: {} }); expect(find).not.toHaveBeenCalled();
});

test.each(["catalog", "custom"])("%s exposes actual selected timing coverage when most performance games are check-ins", async source => {
  const deps = await fixture(), read = jest.spyOn(deps.details, "findMany");
  await deps.games.updateMany({ userId: owner, gameId: { $in: Array.from({ length: 25 }, (_, index) => `game-${index}`) } }, { $set: { buildIntent: {
    status: "confirmed", applied: true, build: ref, detected: { name: "Another opening", slug: "another" },
  } } });
  const result = source === "catalog"
    ? await new BuildsService(deps, { gameDetails: deps.details }).detail(owner, ref.name, {})
    : await new CustomBuildsService(deps, { perGame: /** @type {any} */ ({ gameDetails: deps.details }) }).evaluateBuild(owner, ref.slug);
  expect(result).toMatchObject({ totals: { total: 30 }, timingSampleSelected: 5, timingSampleGames: 5, timingSampleLimit: 25 });
  expect(read).toHaveBeenCalledTimes(5);
});

test("catalog and library summaries share the live declared denominator without hydration or list fanout", async () => {
  const deps = await fixture(), details = jest.spyOn(deps.details, "findMany");
  await deps.games.updateMany({ userId: owner, gameId: { $in: ["game-2", "game-3", "game-4"] } }, { $set: { buildIntent: {
    status: "confirmed", applied: true, build: ref, detected: { name: ref.name, slug: ref.slug },
  } } });
  await deps.games.updateMany({ gameId: /^ineligible-/ }, { $set: { buildIntent: { status: "confirmed", applied: true, build: ref, detected: null } } });
  const service = new CustomBuildsService(deps, { perGame: /** @type {any} */ ({ gameDetails: deps.details }) });
  const [stats] = await service.evaluateAllStats(owner, { slugs: [ref.slug] });
  expect(stats).toMatchObject({ total: 30, wins: 15, losses: 15, planHeldRate: 4 / 5 });
  const catalog = new BuildsService(deps, { gameDetails: deps.details });
  expect((await catalog.list(owner, {})).find(row => row.name === ref.name)).toMatchObject({ total: 30, planHeldRate: 4 / 5 });
  expect(details).not.toHaveBeenCalled();
  await deps.games.updateOne({ userId: owner, gameId: "game-4" }, { $unset: { buildIntent: "" } });
  expect((await service.evaluateAllStats(owner, { slugs: [ref.slug] }))[0].planHeldRate).toBeNull();
  expect((await catalog.list(owner, {})).find(row => row.name === ref.name)?.planHeldRate).toBeNull();
});

test("an aborted held detail read cannot hydrate a second game or return a partial summary", async () => {
  /** @type {(value:unknown)=>void} */ let release = () => {};
  const held = new Promise(resolve => { release = resolve; });
  const findMany = jest.fn(async () => held), controller = new AbortController();
  const result = hydrateDossierTimings({ games: /** @type {any} */ ({}), details: /** @type {any} */ ({ findMany }) },
    owner, [{ gameId: "first" }, { gameId: "second" }], controller.signal);
  controller.abort(); release(new Map([["first", { buildLog: [], oppBuildLog: [] }]]));
  await expect(result).rejects.toMatchObject({ name: "AbortError" }); expect(findMany).toHaveBeenCalledTimes(1);
});

test("the bounded compactor preserves earliest-start DNA parity for unordered logs", () => {
  const { compactDossierTimingLog } = require("../src/services/buildDossierTimingSample");
  const { firstOccurrenceSeconds } = require("../src/services/dnaTimings");
  const raw = ["[9:00] Gateway", "[4:00] Gateway", "[8:00] GreaterSpire", "[7:45] Spire", "[3:30] Gateway"];
  const game = { gameVersion: "5.0.17.98000" };
  const compact = compactDossierTimingLog(raw, game);
  for (const token of ["Gateway", "Spire"]) expect(firstOccurrenceSeconds(compact, token, game)).toBe(firstOccurrenceSeconds(raw, token, game));
  expect(compact).toContain("[3:30] Gateway"); expect(compact).not.toContain("[9:00] Gateway");
  expect(compact.length).toBeLessThan(raw.length);
});
