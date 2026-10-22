// @ts-nocheck
/* eslint-disable max-lines-per-function */
"use strict";

/**
 * Games schema v8 rollback (addendum §A.1): dropping ``buildIntent`` restores
 * the classifier's label exactly on BOTH axes, so a v7 reader never sees a
 * declared build or opponent correction as if the replay had produced it.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");

const { COLLECTIONS } = require("../src/config/constants");
const { VERSION_KEY, migrateDoc } = require("../src/db/schemaVersioning");
const { loadAllMigrations } = require("../src/db/migrations");
const {
  applyOverridePipeline,
  applyOpponentOverridePipeline,
  clearOpponentOverridePipeline,
} = require("../src/services/buildIntentAttribution");

const DT_REF = { key: "custom:dt-rush", name: "DT Rush", slug: "dt-rush", source: "custom" };
const PHOENIX_REF = {
  key: "pvz-2-stargate-phoenix", name: "PvZ - 2 Stargate Phoenix", slug: null, source: "catalog",
};
const LING_REF = { key: "custom:ling-flood", name: "Ling Flood", slug: "ling-flood", source: "custom" };
const POOL_REF = { key: "zerg-12-pool", name: "Zerg - 12 Pool", slug: null, source: "catalog" };

function rollback(doc) {
  return migrateDoc(doc, COLLECTIONS.GAMES, { targetVersion: 7 });
}

beforeAll(() => {
  loadAllMigrations();
});

describe("gamesV8toV7 on the opponent axis", () => {
  test("restores the opponent detector label and slug and keeps the rest of opponent", () => {
    const doc = {
      gameId: "a",
      myBuild: "PvZ - Robo Opener",
      opponent: { displayName: "Foo", race: "Zerg", strategy: "Ling Flood" },
      _customOpponentStrategySlug: "ling-flood",
      buildIntent: {
        status: "pending",
        notes: "private",
        opponent: {
          status: "confirmed",
          applied: true,
          build: LING_REF,
          detected: { name: "Zerg - Roach Rush", slug: "roach-custom" },
        },
      },
      [VERSION_KEY]: 8,
    };
    const before = JSON.parse(JSON.stringify(doc));
    expect(rollback(doc)).toEqual({
      gameId: "a",
      myBuild: "PvZ - Robo Opener",
      opponent: { displayName: "Foo", race: "Zerg", strategy: "Zerg - Roach Rush" },
      _customOpponentStrategySlug: "roach-custom",
      [VERSION_KEY]: 7,
    });
    // The input row is never mutated (nested opponent included).
    expect(doc).toEqual(before);
  });

  test("unsets opponent labels the detector never had", () => {
    expect(rollback({
      gameId: "b",
      opponent: { race: "Zerg", strategy: "Zerg - 12 Pool" },
      buildIntent: {
        opponent: {
          status: "confirmed", applied: true, build: POOL_REF, detected: { name: null, slug: "old-opp" },
        },
      },
      [VERSION_KEY]: 8,
    })).toEqual({
      gameId: "b",
      opponent: { race: "Zerg" },
      _customOpponentStrategySlug: "old-opp",
      [VERSION_KEY]: 7,
    });

    expect(rollback({
      gameId: "b2",
      opponent: { race: "Zerg", strategy: "Ling Flood" },
      _customOpponentStrategySlug: "ling-flood",
      buildIntent: {
        opponent: { status: "confirmed", applied: true, build: LING_REF, detected: null },
      },
      [VERSION_KEY]: 8,
    })).toEqual({ gameId: "b2", opponent: { race: "Zerg" }, [VERSION_KEY]: 7 });
  });

  test("restores both axes at once", () => {
    expect(rollback({
      gameId: "c",
      myBuild: "DT Rush",
      _customBuildSlug: "dt-rush",
      opponent: { race: "Zerg", strategy: "Zerg - 12 Pool" },
      buildIntent: {
        status: "confirmed",
        applied: true,
        build: DT_REF,
        detected: { name: "PvZ - Macro", slug: null },
        opponent: {
          status: "confirmed",
          applied: true,
          build: POOL_REF,
          detected: { name: "Ling Flood", slug: "ling-flood" },
        },
      },
      [VERSION_KEY]: 8,
    })).toEqual({
      gameId: "c",
      myBuild: "PvZ - Macro",
      opponent: { race: "Zerg", strategy: "Ling Flood" },
      _customOpponentStrategySlug: "ling-flood",
      [VERSION_KEY]: 7,
    });
  });

  test("leaves the opponent labels of an unapplied correction alone", () => {
    expect(rollback({
      gameId: "d",
      opponent: { race: "Zerg", strategy: "Zerg - Game Too Short" },
      _customOpponentStrategySlug: "keep",
      buildIntent: {
        opponent: { status: "confirmed", applied: false, build: POOL_REF, detected: null },
      },
      [VERSION_KEY]: 8,
    })).toEqual({
      gameId: "d",
      opponent: { race: "Zerg", strategy: "Zerg - Game Too Short" },
      _customOpponentStrategySlug: "keep",
      [VERSION_KEY]: 7,
    });
  });
});

describe("gamesV8toV7 round trip against the attribution pipelines", () => {
  let mongo;
  let client;
  let games;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = await MongoClient.connect(mongo.getUri());
    games = client.db("build_intent_opponent_rollback").collection("games");
  });

  afterAll(async () => {
    if (client) await client.close();
    if (mongo) await mongo.stop();
  });

  const ORIGINALS = [
    {
      gameId: "both-custom",
      myBuild: "Stargate Opener",
      _customBuildSlug: "stargate-opener",
      opponent: { displayName: "Foo", race: "Zerg", strategy: "Roach Rush" },
      _customOpponentStrategySlug: "roach-rush",
    },
    {
      gameId: "both-generic",
      myBuild: "PvZ - Macro Transition (Unclassified)",
      opponent: { displayName: "Foo", race: "Zerg", strategy: "Zerg - Standard Play (Unclassified)" },
    },
    {
      gameId: "no-labels",
      opponent: { displayName: "Foo", race: "Zerg" },
    },
  ];

  test("a rolled-back row equals the row before any check-in, on both axes", async () => {
    await games.insertMany(ORIGINALS.map((doc) => ({ ...doc, [VERSION_KEY]: 7 })));
    await games.updateOne({ gameId: "both-custom" }, [
      ...applyOverridePipeline(DT_REF, { origin: "web" }),
      ...applyOpponentOverridePipeline(POOL_REF, { origin: "web" }),
    ]);
    await games.updateOne({ gameId: "both-generic" }, [
      ...applyOverridePipeline(PHOENIX_REF, {}),
      ...applyOpponentOverridePipeline(LING_REF, {}),
    ]);
    // Changing the correction keeps the original detector label.
    await games.updateOne({ gameId: "both-generic" }, applyOpponentOverridePipeline(POOL_REF, {}));
    await games.updateOne({ gameId: "no-labels" }, [
      ...applyOverridePipeline(DT_REF, {}),
      ...applyOpponentOverridePipeline(LING_REF, {}),
    ]);

    const stored = await games.find({}, { projection: { _id: 0 } }).sort({ gameId: 1 }).toArray();
    expect(stored.every((doc) => doc.buildIntent?.opponent?.applied === true)).toBe(true);
    const rolledBack = stored.map(rollback);
    const expected = [...ORIGINALS]
      .sort((a, b) => a.gameId.localeCompare(b.gameId))
      .map((doc) => ({ ...doc, [VERSION_KEY]: 7 }));
    expect(rolledBack).toEqual(expected);
  });

  test("rollback and clearOpponentOverridePipeline agree on the opponent labels", async () => {
    await games.deleteMany({});
    await games.insertOne({ ...ORIGINALS[0], gameId: "agree", [VERSION_KEY]: 7 });
    await games.updateOne({ gameId: "agree" }, applyOpponentOverridePipeline(LING_REF, {}));
    const applied = await games.findOne({ gameId: "agree" }, { projection: { _id: 0 } });
    await games.updateOne({ gameId: "agree" }, clearOpponentOverridePipeline({ status: "none" }));
    const cleared = await games.findOne({ gameId: "agree" }, { projection: { _id: 0 } });

    const rolledBack = rollback(applied);
    expect(rolledBack.opponent).toEqual(cleared.opponent);
    expect(rolledBack._customOpponentStrategySlug).toBe(cleared._customOpponentStrategySlug);
  });
});
