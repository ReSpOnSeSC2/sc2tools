// @ts-nocheck
/* eslint-disable max-lines-per-function */
"use strict";

/**
 * Opponent-axis check-in writers (services/buildIntentAttribution.js)
 * against a real Mongo: each is a single-document pipeline that moves the
 * opponent label between ``opponent.strategy``/``_customOpponentStrategySlug``
 * and ``buildIntent.opponent.detected`` atomically and literally, never
 * touching the "you" axis, and concatenates with the "you" pipelines into
 * one atomic update.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");

const { COLLECTIONS } = require("../src/config/constants");
const { expectedVersion } = require("../src/db/schemaVersioning");
const {
  applyOverridePipeline,
  clearOverridePipeline,
  applyOpponentOverridePipeline,
  clearOpponentOverridePipeline,
  mergeOpponentIntentPipeline,
  renameCustomOpponentOverrides,
} = require("../src/services/buildIntentAttribution");
const {
  opponentOverrideActive,
  opponentDetectorView,
  overrideActive,
} = require("../src/services/buildIntentShape");

const USER = "u-attr-opp";
const CUSTOM_A = { key: "custom:ling-flood", name: "Ling Flood", slug: "ling-flood", source: "custom" };
const CATALOG_B = { key: "zerg-12-pool", name: "Zerg - 12 Pool", slug: null, source: "catalog" };
const DT_REF = { key: "custom:dt-rush", name: "DT Rush", slug: "dt-rush", source: "custom" };

let mongo;
let client;
let games;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongo.getUri());
  games = client.db("build_intent_attribution_opponent").collection("games");
});

afterAll(async () => {
  if (client) await client.close();
  if (mongo) await mongo.stop();
});

beforeEach(async () => {
  await games.deleteMany({});
});

async function row(gameId) {
  return games.findOne({ userId: USER, gameId }, { projection: { _id: 0 } });
}

async function seed(gameId, fields = {}) {
  await games.insertOne({
    userId: USER,
    gameId,
    date: new Date("2026-10-20T18:00:00Z"),
    _customBuildRevision: `rev-${gameId}`,
    _schemaVersion: 1,
    myBuild: "PvZ - Macro",
    opponent: { displayName: "Foo", race: "Zerg", strategy: "Zerg - Standard Play (Unclassified)" },
    ...fields,
  });
}

describe("applyOpponentOverridePipeline", () => {
  test("writes the declared custom build, captures the detector once and keeps the rest", async () => {
    await seed("g1", {
      _customBuildReclassify: [{ runId: "r1", action: "set" }],
      buildIntent: { status: "pending", notes: "kept", gameKey: "k|1" },
    });
    const confirmedAt = new Date("2026-10-21T10:00:00Z");
    await games.updateOne(
      { userId: USER, gameId: "g1" },
      applyOpponentOverridePipeline(CUSTOM_A, { origin: "web", via: "web", confirmedAt, updatedAt: confirmedAt }),
    );

    const stored = await row("g1");
    expect(stored.opponent).toEqual({ displayName: "Foo", race: "Zerg", strategy: "Ling Flood" });
    expect(stored._customOpponentStrategySlug).toBe("ling-flood");
    expect(stored.myBuild).toBe("PvZ - Macro");
    expect(stored.buildIntent).toEqual({
      status: "pending",
      notes: "kept",
      gameKey: "k|1",
      opponent: {
        status: "confirmed",
        applied: true,
        build: CUSTOM_A,
        detected: { name: "Zerg - Standard Play (Unclassified)", slug: null },
        origin: "web",
        via: "web",
        confirmedAt,
        updatedAt: confirmedAt,
      },
    });
    expect(stored._schemaVersion).toBe(expectedVersion(COLLECTIONS.GAMES));
    // Never supersedes an in-flight tagger or drops reclassify staging.
    expect(stored._customBuildRevision).toBe("rev-g1");
    expect(stored._customBuildReclassify).toEqual([{ runId: "r1", action: "set" }]);
    expect(opponentOverrideActive(stored)).toBe(true);
    expect(overrideActive(stored)).toBe(false);
  });

  test("a catalog build removes the custom slug and keeps it as the detector's", async () => {
    await seed("g2", {
      opponent: { race: "Zerg", strategy: "Roach Rush" },
      _customOpponentStrategySlug: "roach-rush",
    });
    await games.updateOne({ userId: USER, gameId: "g2" }, applyOpponentOverridePipeline(CATALOG_B, {}));

    const stored = await row("g2");
    expect(stored.opponent.strategy).toBe("Zerg - 12 Pool");
    expect(stored).not.toHaveProperty("_customOpponentStrategySlug");
    expect(stored.buildIntent.opponent.detected).toEqual({ name: "Roach Rush", slug: "roach-rush" });
    expect(opponentDetectorView(stored)).toEqual({ strategy: "Roach Rush", customStrategySlug: "roach-rush" });
  });

  test("changing A to B keeps the original detector label", async () => {
    await seed("g3", {
      opponent: { race: "Zerg", strategy: "Roach Rush" },
      _customOpponentStrategySlug: "roach-rush",
    });
    await games.updateOne({ userId: USER, gameId: "g3" }, applyOpponentOverridePipeline(CUSTOM_A, {}));
    await games.updateOne(
      { userId: USER, gameId: "g3" },
      applyOpponentOverridePipeline(CATALOG_B, { origin: "postgame" }),
    );

    const stored = await row("g3");
    expect(stored.opponent.strategy).toBe("Zerg - 12 Pool");
    expect(stored).not.toHaveProperty("_customOpponentStrategySlug");
    expect(stored.buildIntent.opponent).toEqual(expect.objectContaining({
      build: CATALOG_B,
      origin: "postgame",
      detected: { name: "Roach Rush", slug: "roach-rush" },
    }));
  });

  test("$-prefixed names, slugs and patch strings are stored literally; invariants win", async () => {
    await seed("g4");
    const weird = { key: "custom:$weird", name: "$opponent.strategy", slug: "$weird", source: "custom" };
    await games.updateOne(
      { userId: USER, gameId: "g4" },
      applyOpponentOverridePipeline(weird, {
        origin: "$$ROOT", status: "none", applied: false, build: null,
      }),
    );

    const stored = await row("g4");
    expect(stored.opponent.strategy).toBe("$opponent.strategy");
    expect(stored._customOpponentStrategySlug).toBe("$weird");
    expect(stored.buildIntent.opponent).toEqual(expect.objectContaining({
      status: "confirmed",
      applied: true,
      build: weird,
      origin: "$$ROOT",
    }));
  });

  test("concatenated with the \"you\" pipeline it is one atomic update capturing both detectors", async () => {
    await seed("g5", {
      myBuild: "Stargate Opener",
      _customBuildSlug: "stargate-opener",
      opponent: { race: "Zerg", strategy: "Roach Rush" },
      _customOpponentStrategySlug: "roach-rush",
    });
    await games.updateOne({ userId: USER, gameId: "g5" }, [
      ...applyOverridePipeline(DT_REF, { notes: "both" }),
      ...applyOpponentOverridePipeline(CUSTOM_A, { origin: "web" }),
    ]);

    const stored = await row("g5");
    expect(stored.myBuild).toBe("DT Rush");
    expect(stored._customBuildSlug).toBe("dt-rush");
    expect(stored.opponent.strategy).toBe("Ling Flood");
    expect(stored._customOpponentStrategySlug).toBe("ling-flood");
    expect(stored.buildIntent.detected).toEqual({ name: "Stargate Opener", slug: "stargate-opener" });
    expect(stored.buildIntent.opponent.detected).toEqual({ name: "Roach Rush", slug: "roach-rush" });
    expect(stored.buildIntent.notes).toBe("both");

    // A later "you" write keeps the opponent subdocument (shallow merge).
    await games.updateOne(
      { userId: USER, gameId: "g5" },
      clearOverridePipeline({ status: "skipped", build: null }),
    );
    const cleared = await row("g5");
    expect(cleared.myBuild).toBe("Stargate Opener");
    expect(cleared.buildIntent.opponent).toEqual(stored.buildIntent.opponent);
    expect(cleared.opponent.strategy).toBe("Ling Flood");
  });
});

describe("clearOpponentOverridePipeline", () => {
  test("restores the detector label exactly and leaves the \"you\" axis alone", async () => {
    await seed("c1", {
      opponent: { race: "Zerg", strategy: "Roach Rush" },
      _customOpponentStrategySlug: "roach-rush",
    });
    await games.updateOne({ userId: USER, gameId: "c1" }, [
      ...applyOverridePipeline(DT_REF, {}),
      ...applyOpponentOverridePipeline(CUSTOM_A, {}),
    ]);
    await games.updateOne(
      { userId: USER, gameId: "c1" },
      clearOpponentOverridePipeline({ status: "none", build: null, updatedAt: new Date(0) }),
    );

    const stored = await row("c1");
    expect(stored.opponent).toEqual({ race: "Zerg", strategy: "Roach Rush" });
    expect(stored._customOpponentStrategySlug).toBe("roach-rush");
    expect(stored.buildIntent.opponent).toEqual({
      status: "none",
      applied: false,
      build: null,
      detected: null,
      updatedAt: new Date(0),
    });
    expect(stored.myBuild).toBe("DT Rush");
    expect(overrideActive(stored)).toBe(true);
  });

  test("unsets labels the detector never had instead of keeping the declared ones", async () => {
    await seed("c2", { opponent: { race: "Zerg" } });
    await games.updateOne({ userId: USER, gameId: "c2" }, applyOpponentOverridePipeline(CUSTOM_A, {}));
    expect((await row("c2")).opponent.strategy).toBe("Ling Flood");
    await games.updateOne({ userId: USER, gameId: "c2" }, clearOpponentOverridePipeline({ status: "none" }));

    const stored = await row("c2");
    expect(stored.opponent).toEqual({ race: "Zerg" });
    expect(stored).not.toHaveProperty("_customOpponentStrategySlug");
  });

  test("leaves the labels of rows without an active correction alone", async () => {
    await seed("c3", {
      opponent: { race: "Zerg", strategy: "Plain" },
      _customOpponentStrategySlug: "plain",
    });
    await games.updateOne({ userId: USER, gameId: "c3" }, clearOpponentOverridePipeline({ status: "none" }));
    const stored = await row("c3");
    expect(stored.opponent.strategy).toBe("Plain");
    expect(stored._customOpponentStrategySlug).toBe("plain");
    expect(stored.buildIntent).toEqual({ opponent: { status: "none", applied: false, detected: null } });
  });
});

describe("mergeOpponentIntentPipeline", () => {
  test("merges into the opponent subdocument without touching labels", async () => {
    await seed("m1");
    await games.updateOne({ userId: USER, gameId: "m1" }, applyOpponentOverridePipeline(CUSTOM_A, {}));
    await games.updateOne(
      { userId: USER, gameId: "m1" },
      mergeOpponentIntentPipeline({ updatedAt: new Date(1), origin: "$cond" }),
    );
    const stored = await row("m1");
    expect(stored.opponent.strategy).toBe("Ling Flood");
    expect(stored.buildIntent.opponent).toEqual(expect.objectContaining({
      status: "confirmed", applied: true, build: CUSTOM_A, origin: "$cond", updatedAt: new Date(1),
    }));
  });

  test("creates both subdocuments when absent", async () => {
    await seed("m2");
    await games.updateOne({ userId: USER, gameId: "m2" }, mergeOpponentIntentPipeline({ status: "none" }));
    const stored = await row("m2");
    expect(stored.buildIntent).toEqual({ opponent: { status: "none" } });
    expect(stored._schemaVersion).toBe(expectedVersion(COLLECTIONS.GAMES));
  });
});

describe("renameCustomOpponentOverrides", () => {
  test("renames only this user's applied custom corrections of that slug", async () => {
    await seed("r-corrected");
    await seed("r-agree", {
      opponent: { race: "Zerg", strategy: "Ling Flood" },
      _customOpponentStrategySlug: "ling-flood",
    });
    await games.updateMany(
      { userId: USER, gameId: { $in: ["r-corrected", "r-agree"] } },
      applyOpponentOverridePipeline(CUSTOM_A, {}),
    );
    // The classifier's own claim of the same slug is renamed by reclassify.
    await seed("r-plain", {
      opponent: { race: "Zerg", strategy: "Ling Flood" },
      _customOpponentStrategySlug: "ling-flood",
    });
    // A "you"-side check-in with the same slug is not an opponent correction.
    await seed("r-you");
    await games.updateOne(
      { userId: USER, gameId: "r-you" },
      applyOverridePipeline({ ...CUSTOM_A, name: "Ling Flood" }, {}),
    );
    await games.insertOne({
      userId: "someone-else",
      gameId: "r-foreign",
      opponent: { strategy: "Ling Flood" },
      _customOpponentStrategySlug: "ling-flood",
      buildIntent: { opponent: { status: "confirmed", applied: true, build: CUSTOM_A, detected: null } },
    });

    expect(await renameCustomOpponentOverrides(games, USER, "ling-flood", "$Ling Flood v2")).toBe(2);
    const corrected = await row("r-corrected");
    expect(corrected.opponent.strategy).toBe("$Ling Flood v2");
    expect(corrected.buildIntent.opponent.build).toEqual({ ...CUSTOM_A, name: "$Ling Flood v2" });
    expect(corrected.buildIntent.opponent.detected)
      .toEqual({ name: "Zerg - Standard Play (Unclassified)", slug: null });
    // The replay matched the build itself: detected follows, so it never
    // starts counting as a check-in.
    const agree = await row("r-agree");
    expect(agree.buildIntent.opponent.detected).toEqual({ name: "$Ling Flood v2", slug: "ling-flood" });
    expect((await row("r-plain")).opponent.strategy).toBe("Ling Flood");
    expect((await row("r-you")).myBuild).toBe("Ling Flood");
    expect((await games.findOne({ gameId: "r-foreign" })).opponent.strategy).toBe("Ling Flood");
    // Idempotent: nothing left to rename.
    expect(await renameCustomOpponentOverrides(games, USER, "ling-flood", "$Ling Flood v2")).toBe(0);
  });
});
