// @ts-nocheck
"use strict";

/**
 * Build check-in writers (services/buildIntentAttribution.js) against a
 * real Mongo: each is a single-document pipeline, so the declared label,
 * the captured detector label and the patch must land atomically and
 * literally (a "$"-prefixed build name is data, never a field path).
 */

const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");

const { COLLECTIONS } = require("../src/config/constants");
const { expectedVersion } = require("../src/db/schemaVersioning");
const {
  applyOverridePipeline,
  clearOverridePipeline,
  mergeIntentPipeline,
  renameCustomOverrides,
} = require("../src/services/buildIntentAttribution");
const { overrideActive, detectorView } = require("../src/services/buildIntentShape");

const USER = "u-attr";
const CUSTOM_A = { key: "custom:dt-rush", name: "DT Rush", slug: "dt-rush", source: "custom" };
const CATALOG_B = {
  key: "pvz-2-stargate-phoenix",
  name: "PvZ - 2 Stargate Phoenix",
  slug: null,
  source: "catalog",
};

let mongo;
let client;
let games;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongo.getUri());
  games = client.db("build_intent_attribution").collection("games");
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
    ...fields,
  });
}

describe("applyOverridePipeline", () => {
  test("writes the declared custom build and captures the detector label once", async () => {
    await seed("g1", {
      myBuild: "PvZ - Macro Transition (Unclassified)",
      _customBuildReclassify: [{ runId: "r1", action: "set" }],
      buildIntent: { status: "pending", notes: "kept", gameKey: "k|1", randomizer: CATALOG_B },
    });
    const confirmedAt = new Date("2026-10-21T10:00:00Z");
    await games.updateOne(
      { userId: USER, gameId: "g1" },
      applyOverridePipeline(CUSTOM_A, { origin: "web", via: "web", confirmedAt, updatedAt: confirmedAt }),
    );

    const stored = await row("g1");
    expect(stored.myBuild).toBe("DT Rush");
    expect(stored._customBuildSlug).toBe("dt-rush");
    expect(stored.buildIntent).toEqual({
      status: "confirmed",
      applied: true,
      build: CUSTOM_A,
      detected: { name: "PvZ - Macro Transition (Unclassified)", slug: null },
      notes: "kept",
      gameKey: "k|1",
      randomizer: CATALOG_B,
      origin: "web",
      via: "web",
      confirmedAt,
      updatedAt: confirmedAt,
    });
    expect(stored.buildIntent.confirmedAt).toBeInstanceOf(Date);
    expect(stored._schemaVersion).toBe(expectedVersion(COLLECTIONS.GAMES));
    // Never supersedes an in-flight tagger or drops reclassify staging.
    expect(stored._customBuildRevision).toBe("rev-g1");
    expect(stored._customBuildReclassify).toEqual([{ runId: "r1", action: "set" }]);
    expect(overrideActive(stored)).toBe(true);
  });

  test("a catalog build removes the custom slug and keeps it as the detector's", async () => {
    await seed("g2", { myBuild: "Old Custom", _customBuildSlug: "old" });
    await games.updateOne({ userId: USER, gameId: "g2" }, applyOverridePipeline(CATALOG_B, {}));

    const stored = await row("g2");
    expect(stored.myBuild).toBe("PvZ - 2 Stargate Phoenix");
    expect(stored).not.toHaveProperty("_customBuildSlug");
    expect(stored.buildIntent.detected).toEqual({ name: "Old Custom", slug: "old" });
    expect(detectorView(stored)).toEqual({ myBuild: "Old Custom", customBuildSlug: "old" });
  });

  test("a row with no label captures null detector fields", async () => {
    await seed("g3");
    await games.updateOne({ userId: USER, gameId: "g3" }, applyOverridePipeline(CATALOG_B, {}));
    expect((await row("g3")).buildIntent.detected).toEqual({ name: null, slug: null });
  });

  test("changing A to B keeps the original detector label", async () => {
    await seed("g4", { myBuild: "PvZ - Macro", _customBuildSlug: "macro-custom" });
    await games.updateOne({ userId: USER, gameId: "g4" }, applyOverridePipeline(CUSTOM_A, {}));
    await games.updateOne(
      { userId: USER, gameId: "g4" },
      applyOverridePipeline(CATALOG_B, { origin: "postgame" }),
    );

    const stored = await row("g4");
    expect(stored.myBuild).toBe("PvZ - 2 Stargate Phoenix");
    expect(stored).not.toHaveProperty("_customBuildSlug");
    expect(stored.buildIntent.build).toEqual(CATALOG_B);
    expect(stored.buildIntent.origin).toBe("postgame");
    expect(stored.buildIntent.detected).toEqual({ name: "PvZ - Macro", slug: "macro-custom" });
  });

  test("$-prefixed names, slugs and patch strings are stored literally", async () => {
    await seed("g5", { myBuild: "PvZ - Macro" });
    const weird = { key: "custom:$weird", name: "$myBuild", slug: "$weird", source: "custom" };
    await games.updateOne(
      { userId: USER, gameId: "g5" },
      applyOverridePipeline(weird, { notes: "$notes", gameKey: "$$ROOT" }),
    );

    const stored = await row("g5");
    expect(stored.myBuild).toBe("$myBuild");
    expect(stored._customBuildSlug).toBe("$weird");
    expect(stored.buildIntent.build).toEqual(weird);
    expect(stored.buildIntent.notes).toBe("$notes");
    expect(stored.buildIntent.gameKey).toBe("$$ROOT");
    expect(stored.buildIntent.detected).toEqual({ name: "PvZ - Macro", slug: null });
  });

  test("the patch can never override the status/applied/build invariants", async () => {
    await seed("g6", { myBuild: "PvZ - Macro" });
    await games.updateOne(
      { userId: USER, gameId: "g6" },
      applyOverridePipeline(CUSTOM_A, { status: "pending", applied: false, build: null }),
    );
    const stored = await row("g6");
    expect(stored.buildIntent).toEqual(expect.objectContaining({
      status: "confirmed",
      applied: true,
      build: CUSTOM_A,
    }));
  });
});

describe("clearOverridePipeline", () => {
  test("restores the detector label exactly", async () => {
    await seed("c1", { myBuild: "Other Custom", _customBuildSlug: "other" });
    await games.updateOne({ userId: USER, gameId: "c1" }, applyOverridePipeline(CUSTOM_A, {}));
    await games.updateOne(
      { userId: USER, gameId: "c1" },
      clearOverridePipeline({ status: "skipped", build: null, updatedAt: new Date(0) }),
    );

    const stored = await row("c1");
    expect(stored.myBuild).toBe("Other Custom");
    expect(stored._customBuildSlug).toBe("other");
    expect(stored.buildIntent).toEqual({
      status: "skipped",
      applied: false,
      build: null,
      detected: null,
      updatedAt: new Date(0),
    });
  });

  test("unsets labels the detector never had instead of keeping the declared ones", async () => {
    await seed("c2");
    await games.updateOne({ userId: USER, gameId: "c2" }, applyOverridePipeline(CUSTOM_A, {}));
    expect((await row("c2")).myBuild).toBe("DT Rush");
    await games.updateOne({ userId: USER, gameId: "c2" }, clearOverridePipeline({ status: "pending" }));

    const stored = await row("c2");
    expect(stored).not.toHaveProperty("myBuild");
    expect(stored).not.toHaveProperty("_customBuildSlug");
    expect(stored.buildIntent.status).toBe("pending");
  });

  test("leaves the labels of rows without an active override alone", async () => {
    await seed("c3", { myBuild: "Plain", _customBuildSlug: "plain" });
    await seed("c4", {
      myBuild: "Plain 2",
      buildIntent: { status: "confirmed", applied: false, build: CATALOG_B, detected: null },
    });
    await games.updateMany(
      { userId: USER, gameId: { $in: ["c3", "c4"] } },
      clearOverridePipeline({ status: "skipped", build: null }),
    );

    const plain = await row("c3");
    expect(plain.myBuild).toBe("Plain");
    expect(plain._customBuildSlug).toBe("plain");
    expect(plain.buildIntent).toEqual({ status: "skipped", build: null, applied: false, detected: null });
    const notApplied = await row("c4");
    expect(notApplied.myBuild).toBe("Plain 2");
    expect(notApplied).not.toHaveProperty("_customBuildSlug");
  });
});

describe("mergeIntentPipeline", () => {
  test("merges into the subdocument without touching labels", async () => {
    await seed("m1", { myBuild: "PvZ - Macro" });
    await games.updateOne({ userId: USER, gameId: "m1" }, applyOverridePipeline(CUSTOM_A, {}));
    await games.updateOne(
      { userId: USER, gameId: "m1" },
      mergeIntentPipeline({ notes: "$cond went wrong", updatedAt: new Date(1) }),
    );

    const stored = await row("m1");
    expect(stored.myBuild).toBe("DT Rush");
    expect(stored._customBuildSlug).toBe("dt-rush");
    expect(stored.buildIntent).toEqual(expect.objectContaining({
      status: "confirmed",
      applied: true,
      build: CUSTOM_A,
      detected: { name: "PvZ - Macro", slug: null },
      notes: "$cond went wrong",
      updatedAt: new Date(1),
    }));
  });

  test("creates the subdocument when absent", async () => {
    await seed("m2", { myBuild: "PvZ - Macro" });
    await games.updateOne({ userId: USER, gameId: "m2" }, mergeIntentPipeline({ status: "none", notes: "" }));
    const stored = await row("m2");
    expect(stored.buildIntent).toEqual({ status: "none", notes: "" });
    expect(stored.myBuild).toBe("PvZ - Macro");
    expect(stored._schemaVersion).toBe(expectedVersion(COLLECTIONS.GAMES));
  });
});

describe("renameCustomOverrides", () => {
  test("renames only this user's applied custom overrides of that slug", async () => {
    await seed("r-override", { myBuild: "PvZ - Macro" });
    await seed("r-override-2", { myBuild: "PvZ - Macro" });
    await games.updateMany(
      { userId: USER, gameId: { $in: ["r-override", "r-override-2"] } },
      applyOverridePipeline(CUSTOM_A, {}),
    );
    // The classifier's own claim of the same slug is renamed by reclassify.
    await seed("r-plain", { myBuild: "DT Rush", _customBuildSlug: "dt-rush" });
    await seed("r-other-slug", { myBuild: "PvZ - Macro" });
    await games.updateOne(
      { userId: USER, gameId: "r-other-slug" },
      applyOverridePipeline({ ...CUSTOM_A, key: "custom:other", slug: "other" }, {}),
    );
    await games.insertOne({
      userId: "someone-else",
      gameId: "r-foreign",
      myBuild: "DT Rush",
      _customBuildSlug: "dt-rush",
      buildIntent: { status: "confirmed", applied: true, build: CUSTOM_A, detected: null },
    });

    expect(await renameCustomOverrides(games, USER, "dt-rush", "$DT Rush v2")).toBe(2);
    for (const gameId of ["r-override", "r-override-2"]) {
      const stored = await row(gameId);
      expect(stored.myBuild).toBe("$DT Rush v2");
      expect(stored.buildIntent.build).toEqual({ ...CUSTOM_A, name: "$DT Rush v2" });
      expect(stored.buildIntent.detected).toEqual({ name: "PvZ - Macro", slug: null });
    }
    expect((await row("r-plain")).myBuild).toBe("DT Rush");
    expect((await row("r-other-slug")).myBuild).toBe("DT Rush");
    expect((await games.findOne({ gameId: "r-foreign" })).myBuild).toBe("DT Rush");
    // Idempotent: nothing left to rename.
    expect(await renameCustomOverrides(games, USER, "dt-rush", "$DT Rush v2")).toBe(0);
  });
});
