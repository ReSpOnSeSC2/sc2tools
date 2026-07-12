// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const {
  BAND_INDEX_KEY,
  COLLECTION_NAME,
  LadderMetaService,
  MIN_SAMPLE,
  migrateBandIndex,
} = require("../src/services/ladderMeta");
const {
  ladderMetaBracketLabel,
  ladderMetaBucketFor,
} = require("../src/util/mmrBracketing");

const BUILD = "PvZ - Gateway Expand";
const START = Date.UTC(2026, 6, 12, 12);

  let mongo;
  let db;
  let meta;
  let out;
  let now;
  let sequence;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "sc2tools_test_ladder_meta_dual_axis",
    });
    out = db.db.collection(COLLECTION_NAME);
  });

  beforeEach(() => {
    now = START;
    sequence = 0;
    meta = new LadderMetaService(db, { logger: null, now: () => now });
  });

  afterEach(async () => {
    await db.games.deleteMany({});
    await dropIfPresent(out);
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  function games(count, options = {}) {
    return Array.from({ length: count }, (_, index) => {
      sequence += 1;
      const opponent = { race: "Zerg" };
      if (options.leagueId !== null) opponent.leagueId = options.leagueId ?? 4;
      if (options.mmr !== null) opponent.mmr = options.mmr ?? 4100;
      return {
        userId: `dual-user-${sequence % 12}`,
        gameId: `dual-game-${sequence}`,
        date: new Date(START + sequence * 1000),
        result: index < (options.wins ?? Math.ceil(count / 2))
          ? "Victory"
          : "Defeat",
        myRace: "Protoss",
        myBuild: options.build ?? BUILD,
        map: "Dual Axis Test Map",
        playerCount: 2,
        opponent,
      };
    });
  }

  test("uses the exact half-open bucket edges and open caps", () => {
    const cases = [
      [999, null, null],
      [1000, 1000, "<2000"],
      [1999, 1000, "<2000"],
      [2000, 2000, "2000–2500"],
      [2499, 2000, "2000–2500"],
      [2500, 2500, "2500–3000"],
      [6499, 6000, "6000–6500"],
      [6500, 6500, "6500+"],
      [7999, 6500, "6500+"],
      [8000, null, null],
    ];
    for (const [mmr, band, label] of cases) {
      expect(ladderMetaBucketFor(mmr)).toBe(band);
      expect(band === null ? null : ladderMetaBracketLabel(band)).toBe(label);
    }
  });

  test("recompute stores and serves both axes with isolated WoW snapshots", async () => {
    await db.games.insertMany(games(60));
    const first = await meta.recompute();
    expect(first).toMatchObject({ bands: 2, leagueBands: 1, mmrBands: 1 });

    const league = await meta.lookup({ bandType: "league", band: 4, matchup: "pvz" });
    const legacy = await meta.lookup({ leagueId: 4, matchup: "PvZ" });
    const mmr = await meta.lookup({ bandType: "mmr", band: 4000, matchup: "PvZ" });
    expect(league).toMatchObject({ bandType: "league", band: 4, league: "Diamond" });
    expect(legacy).toMatchObject({ bandType: "league", band: 4, leagueBand: 4 });
    expect(mmr).toMatchObject({ bandType: "mmr", band: 4000, bandLabel: "4000–4500" });

    now += 24 * 60 * 60 * 1000;
    await meta.recompute();
    const unchangedLeague = await meta.lookup({ bandType: "league", band: 4, matchup: "PvZ" });
    const unchangedMmr = await meta.lookup({ bandType: "mmr", band: 4000, matchup: "PvZ" });
    expect(unchangedLeague.openers[0].winRateDelta).toBe(0);
    expect(unchangedMmr.openers[0].winRateDelta).toBe(0);
  });

  test("enforces the publication floor independently in each MMR bucket", async () => {
    await db.games.insertMany([
      ...games(30, { mmr: 4100 }),
      ...games(30, { mmr: 4600 }),
    ]);
    await meta.recompute();

    const league = await meta.lookup({ bandType: "league", band: 4, matchup: "PvZ" });
    expect(league.n).toBe(60);
    expect(league.n).toBeGreaterThanOrEqual(MIN_SAMPLE);
    await expect(meta.lookup({ bandType: "mmr", band: 4000, matchup: "PvZ" }))
      .resolves.toBeNull();
    await expect(meta.lookup({ bandType: "mmr", band: 4500, matchup: "PvZ" }))
      .resolves.toBeNull();
  });

  test("aggregation excludes the global floor and ceiling without double counts", async () => {
    const mmrs = [999, 1000, 1999, 2000, 2499, 2500, 6499, 6500, 7999, 8000];
    const docs = mmrs.flatMap((mmr) => games(1, { leagueId: null, mmr }));
    await db.games.insertMany(docs);
    await meta.recompute();

    const rows = await out.find({ bandType: "mmr" }).sort({ band: 1 }).toArray();
    expect(rows.map((row) => [row.band, row.n])).toEqual([
      [1000, 2],
      [2000, 2],
      [2500, 1],
      [6000, 1],
      [6500, 2],
    ]);
    expect(rows.reduce((sum, row) => sum + row.n, 0)).toBe(8);
  });

  test("one stale cleanup keeps fresh league rows and removes a vanished MMR axis", async () => {
    await db.games.insertMany(games(60));
    await meta.recompute();
    expect(await out.countDocuments({})).toBe(2);

    await db.games.updateMany({}, { $unset: { "opponent.mmr": "" } });
    now += 24 * 60 * 60 * 1000;
    const result = await meta.recompute();
    expect(result).toMatchObject({ leagueBands: 1, mmrBands: 0 });
    expect(await out.countDocuments({ bandType: "league" })).toBe(1);
    expect(await out.countDocuments({ bandType: "mmr" })).toBe(0);
  });

  test("legacy index migration promotes rows and is safe to repeat", async () => {
    await out.insertMany([
      legacyRow(4, "PvZ"),
      legacyRow(5, "PvZ"),
    ]);
    await out.createIndex({ leagueBand: 1, matchup: 1 }, { unique: true });

    await migrateBandIndex(out);
    await migrateBandIndex(out);

    const rows = await out.find({}).sort({ band: 1 }).toArray();
    expect(rows.map((row) => [row.bandType, row.band])).toEqual([
      ["league", 4],
      ["league", 5],
    ]);
    const indexes = await out.listIndexes().toArray();
    expect(indexes.some((index) => sameKey(index.key, BAND_INDEX_KEY))).toBe(true);
    expect(indexes.some((index) => sameKey(index.key, { leagueBand: 1, matchup: 1 })))
      .toBe(false);
  });
function legacyRow(leagueBand, matchup) {
  return {
    leagueBand,
    league: leagueBand === 4 ? "Diamond" : "Master",
    matchup,
    n: 60,
    openers: [],
    prevOpeners: null,
    prevUpdatedAt: null,
    updatedAt: new Date(START),
  };
}

function sameKey(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

async function dropIfPresent(collection) {
  try {
    await collection.drop();
  } catch (err) {
    if (err && (err.code === 26 || err.codeName === "NamespaceNotFound")) return;
    throw err;
  }
}
