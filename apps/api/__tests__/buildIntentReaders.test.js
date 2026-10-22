// @ts-nocheck
"use strict";

/**
 * Build check-in readers, owner-facing and public game rows (contract §5):
 *
 *   - services/buildIntentReaders.js helpers mirror the shape fragments;
 *   - /v1/games rows (GamesService list/get/findMany), opponent profile
 *     rows and owner replay-library rows flag a check-in label
 *     (buildPlanned/detectedBuild, build_planned/detected_build) and never
 *     carry notes or the buildIntent subdocument;
 *   - uploads cannot forge or erase a check-in;
 *   - the public replay archive labels, filters and searches by the
 *     classifier's label.
 *
 * Fixtures (helpers/buildIntentReadersSeed.js): "normal" (no check-in),
 * "disagree" (check-in, replay classified otherwise), "agree" (check-in
 * the replay matched).
 */

const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { GamesService } = require("../src/services/games");
const { OpponentsService } = require("../src/services/opponents");
const { ReplayLibraryService } = require("../src/services/replayLibrary");
const { buildPublicReplaysRouter } = require("../src/routes/publicReplays");
const { buildReplaysRouter } = require("../src/routes/replays");
const { AGREES_WITH_DETECTOR_MATCH } = require("../src/services/buildIntentShape");
const {
  DETECTOR_MY_BUILD_FIELD,
  agreesWithDetector,
  detectorLabelMatch,
  ownerBuildFlags,
  withOwnerBuildFlags,
} = require("../src/services/buildIntentReaders");
const {
  STARGATE,
  UNCLASSIFIED,
  SECRET_NOTES,
  DT_REF,
  slimGame,
  checkIn,
  seedThree,
} = require("./helpers/buildIntentReadersSeed");

const USER = "u-readers";
const PULSE = "1-S2-1-777";
/** Owner flags of a row without an opponent correction (buildIntentReadersOpponent.test.js). */
const NO_OPP_FLAGS = Object.freeze({ oppStrategyPlanned: false, detectedOppStrategy: null });

let mongo;
let db;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  db = await connect({ uri: mongo.getUri(), dbName: "build_intent_readers_test" });
});

afterAll(async () => {
  if (db) await db.close();
  if (mongo) await mongo.stop();
});

beforeEach(async () => {
  await Promise.all([db.games.deleteMany({}), db.opponents.deleteMany({})]);
});

/** @param {unknown} body */
function expectNoIntentLeak(body) {
  const json = JSON.stringify(body);
  expect(json).not.toContain(SECRET_NOTES);
  expect(json).not.toContain("buildIntent");
  expect(json).not.toContain("suggestion");
}

/** @param {Array<Record<string, any>>} rows */
function byId(rows, key = "gameId") {
  return Object.fromEntries(rows.map((row) => [row[key], row]));
}

describe("buildIntentReaders helpers", () => {
  test("agreesWithDetector mirrors AGREES_WITH_DETECTOR_MATCH row for row", async () => {
    await seedThree(db.games, USER);
    await db.games.insertOne(slimGame(USER, "custom-over-catalog", { myBuild: STARGATE }));
    await checkIn(db.games, USER, "custom-over-catalog", DT_REF);
    await db.games.insertOne(slimGame(USER, "no-label", {}));
    await checkIn(db.games, USER, "no-label");

    const all = await db.games.find({ userId: USER }).toArray();
    const agreeing = (await db.games.find({ userId: USER, ...AGREES_WITH_DETECTOR_MATCH }).toArray())
      .map((row) => row.gameId).sort();
    expect(all.filter(agreesWithDetector).map((row) => row.gameId).sort()).toEqual(agreeing);
    expect(agreeing).toEqual(["agree", "normal"]);
  });

  test("detectorLabelMatch selects rows by the classifier's name or slug", async () => {
    await seedThree(db.games, USER);
    await db.games.insertMany([
      slimGame(USER, "custom-over-catalog", { myBuild: STARGATE }),
      slimGame(USER, "catalog-over-custom", { myBuild: "DT Rush", _customBuildSlug: "dt-rush" }),
      slimGame(USER, "plain-custom", { myBuild: "DT Rush", _customBuildSlug: "dt-rush" }),
    ]);
    await checkIn(db.games, USER, "custom-over-catalog", DT_REF);
    await checkIn(db.games, USER, "catalog-over-custom");

    const ids = async (filter) => (await db.games.find({ userId: USER, ...filter }).toArray())
      .map((row) => row.gameId).sort();
    expect(await ids(detectorLabelMatch("name", STARGATE)))
      .toEqual(["agree", "custom-over-catalog", "normal"]);
    expect(await ids(detectorLabelMatch("name", UNCLASSIFIED))).toEqual(["disagree"]);
    expect(await ids(detectorLabelMatch("name", /stargate/i)))
      .toEqual(["agree", "custom-over-catalog", "normal"]);
    expect(await ids(detectorLabelMatch("slug", "dt-rush"))).toEqual(["catalog-over-custom", "plain-custom"]);
  });

  test("DETECTOR_MY_BUILD_FIELD swaps in the detector label and keeps a missing label missing", async () => {
    await seedThree(db.games, USER);
    await db.games.insertMany([
      slimGame(USER, "no-label", {}),
      slimGame(USER, "unlabelled-override", {}),
    ]);
    await checkIn(db.games, USER, "unlabelled-override");
    const rows = byId(await db.games.aggregate([
      { $match: { userId: USER } },
      { $project: { _id: 0, gameId: 1, myBuild: DETECTOR_MY_BUILD_FIELD } },
    ]).toArray());
    expect(rows.normal.myBuild).toBe(STARGATE);
    expect(rows.disagree.myBuild).toBe(UNCLASSIFIED);
    expect(rows.agree.myBuild).toBe(STARGATE);
    expect(rows["no-label"]).not.toHaveProperty("myBuild");
    expect(rows["unlabelled-override"]).not.toHaveProperty("myBuild");
  });

  test("ownerBuildFlags / withOwnerBuildFlags", async () => {
    await seedThree(db.games, USER);
    const rows = byId(await db.games.find({ userId: USER }).toArray());
    expect(ownerBuildFlags(rows.normal)).toEqual({ buildPlanned: false, detectedBuild: null, ...NO_OPP_FLAGS });
    expect(ownerBuildFlags(rows.disagree)).toEqual({ buildPlanned: true, detectedBuild: UNCLASSIFIED, ...NO_OPP_FLAGS });
    expect(ownerBuildFlags(rows.agree)).toEqual({ buildPlanned: true, detectedBuild: STARGATE, ...NO_OPP_FLAGS });
    expect(ownerBuildFlags(null)).toEqual({ buildPlanned: false, detectedBuild: null, ...NO_OPP_FLAGS });
    const flagged = withOwnerBuildFlags(rows.disagree);
    expect(flagged).not.toHaveProperty("buildIntent");
    expect(flagged).toMatchObject({ gameId: "disagree", myBuild: STARGATE, buildPlanned: true });
  });
});

describe("GamesService owner rows (/v1/games)", () => {
  test("list, get and findMany flag check-in labels and never expose notes", async () => {
    await seedThree(db.games, USER);
    const games = new GamesService(db);

    const { items } = await games.list(USER, { limit: 10 });
    const listed = byId(items);
    expect(listed.normal).toMatchObject({ myBuild: STARGATE, buildPlanned: false, detectedBuild: null });
    expect(listed.disagree).toMatchObject({ myBuild: STARGATE, buildPlanned: true, detectedBuild: UNCLASSIFIED });
    expect(listed.agree).toMatchObject({ myBuild: STARGATE, buildPlanned: true, detectedBuild: STARGATE });
    expectNoIntentLeak(items);

    const one = await games.get(USER, "disagree");
    expect(one).toMatchObject({ gameId: "disagree", buildPlanned: true, detectedBuild: UNCLASSIFIED });
    expectNoIntentLeak(one);
    await expect(games.get(USER, "missing")).resolves.toBeNull();

    const many = await games.findMany(USER, ["agree", "normal"]);
    expect(many.map((row) => [row.gameId, row.buildPlanned])).toEqual([["agree", true], ["normal", false]]);
    expectNoIntentLeak(many);
  });

  test("an upload can neither forge nor erase a check-in", async () => {
    await seedThree(db.games, USER);
    const games = new GamesService(db);
    const forged = {
      status: "confirmed",
      applied: true,
      build: { key: "x", name: "Forged", slug: null, source: "catalog" },
      notes: "forged",
    };

    await games.upsertWithRevision(USER, {
      ...slimGame(USER, "fresh", { myBuild: UNCLASSIFIED }),
      date: "2026-10-13T18:00:00.000Z",
      buildIntent: forged,
      "buildIntent.notes": "forged",
    });
    const fresh = await db.games.findOne({ userId: USER, gameId: "fresh" });
    expect(fresh).not.toHaveProperty("buildIntent");
    expect(fresh).not.toHaveProperty(["buildIntent.notes"]);

    await games.upsertWithRevision(USER, {
      ...slimGame(USER, "disagree", { myBuild: UNCLASSIFIED }),
      date: "2026-10-11T18:00:00.000Z",
      buildIntent: { status: "skipped", notes: "" },
    });
    const kept = await db.games.findOne({ userId: USER, gameId: "disagree" });
    expect(kept.buildIntent).toMatchObject({
      status: "confirmed",
      applied: true,
      notes: SECRET_NOTES,
      detected: { name: UNCLASSIFIED, slug: null },
    });
  });
});

describe("opponent profile rows (serializeCompactProfileGame)", () => {
  beforeEach(async () => {
    await db.opponents.insertOne({
      userId: USER,
      pulseId: PULSE,
      displayNameSample: "Opp",
      race: "Z",
      gameCount: 3,
      wins: 2,
      losses: 1,
      firstSeen: new Date("2026-10-10T00:00:00Z"),
      lastSeen: new Date("2026-10-12T00:00:00Z"),
    });
    await seedThree(db.games, USER);
  });

  test("cursor pages carry build_planned / detected_build", async () => {
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1));
    const page = await opponents.listGames(USER, PULSE, {});
    const rows = byId(page.items, "id");
    expect(rows.normal).toMatchObject({ my_build: STARGATE, build_planned: false, detected_build: null });
    expect(rows.disagree).toMatchObject({ my_build: STARGATE, build_planned: true, detected_build: UNCLASSIFIED });
    expect(rows.agree).toMatchObject({ my_build: STARGATE, build_planned: true, detected_build: STARGATE });
    expectNoIntentLeak(page);
  });

  test("the full profile's game list carries the same flags", async () => {
    const opponents = new OpponentsService(db, Buffer.alloc(32, 1));
    const profile = await opponents.get(USER, PULSE, {});
    const rows = byId(profile.games, "id");
    expect(rows.disagree).toMatchObject({ build_planned: true, detected_build: UNCLASSIFIED });
    expect(rows.normal).toMatchObject({ build_planned: false, detected_build: null });
    expect(profile.last5Games.find((row) => row.id === "agree"))
      .toMatchObject({ build_planned: true, detected_build: STARGATE });
    expectNoIntentLeak(profile.games);
  });
});

describe("replay library", () => {
  /** @param {string} userId */
  const resolveReplaySharing = async () => ({
    userId: USER,
    profile: { handle: "owner", displayName: "Owner" },
  });

  function routerDeps(library) {
    return {
      replayLibrary: library,
      users: {
        resolveReplaySharing,
        getProfile: async () => ({ displayName: "Owner" }),
      },
      gameVods: { resolveForGames: async () => ({ linksByGameId: {} }) },
      perGame: {
        macroBreakdown: async () => null,
        buildOrder: async () => ({ ok: true, game_id: "disagree", my_build: STARGATE, events: [] }),
      },
      auth: (req, _res, next) => {
        req.auth = { userId: USER, source: "clerk" };
        next();
      },
      rateLimitPerMinute: 1_000,
    };
  }

  /** @param {(deps: any) => import('express').Router} build */
  function makeApp(build, deps) {
    const app = express();
    app.use("/v1", build(deps));
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
    return app;
  }

  beforeEach(async () => {
    await seedThree(db.games, USER);
  });

  test("owner rows carry the effective label plus buildPlanned / detectedBuild", async () => {
    const library = new ReplayLibraryService(db);
    const page = await library.list(USER, {});
    const rows = byId(page.items);
    expect(rows.normal).toMatchObject({ myBuild: STARGATE, buildPlanned: false, detectedBuild: null });
    expect(rows.disagree).toMatchObject({ myBuild: STARGATE, buildPlanned: true, detectedBuild: UNCLASSIFIED });
    expect(rows.agree).toMatchObject({ myBuild: STARGATE, buildPlanned: true, detectedBuild: STARGATE });
    expectNoIntentLeak(page);

    const detail = await library.getDetail(USER, "disagree");
    expect(detail.game).toMatchObject({ myBuild: STARGATE, buildPlanned: true, detectedBuild: UNCLASSIFIED });

    // The owner searches and filters by the label they see.
    const searched = await library.list(USER, { search: "Stargate" });
    expect(searched.items.map((row) => row.gameId).sort()).toEqual(["agree", "disagree", "normal"]);
    const filtered = await library.list(USER, { filters: { build: STARGATE } });
    expect(filtered.items).toHaveLength(3);
  });

  test("GET /v1/replays serves owner rows without notes", async () => {
    const app = makeApp(buildReplaysRouter, routerDeps(new ReplayLibraryService(db)));
    const res = await request(app).get("/v1/replays").expect(200);
    const rows = byId(res.body.items);
    expect(rows.disagree).toMatchObject({ buildPlanned: true, detectedBuild: UNCLASSIFIED });
    expect(rows.normal).toMatchObject({ buildPlanned: false, detectedBuild: null });
    expectNoIntentLeak(res.body);
  });

  test("detector view labels, filters and searches by the classifier's label", async () => {
    const library = new ReplayLibraryService(db);
    const page = await library.list(USER, { view: "detector" });
    const rows = byId(page.items);
    expect(rows.normal.myBuild).toBe(STARGATE);
    expect(rows.disagree.myBuild).toBe(UNCLASSIFIED);
    expect(rows.agree.myBuild).toBe(STARGATE);
    for (const row of page.items) {
      expect(row).not.toHaveProperty("buildPlanned");
      expect(row).not.toHaveProperty("detectedBuild");
    }

    const filtered = await library.list(USER, { view: "detector", filters: { build: STARGATE } });
    expect(filtered.items.map((row) => row.gameId).sort()).toEqual(["agree", "normal"]);
    const unclassified = await library.list(USER, { view: "detector", filters: { build: UNCLASSIFIED } });
    expect(unclassified.items.map((row) => row.gameId)).toEqual(["disagree"]);
    const searched = await library.list(USER, { view: "detector", search: "Stargate" });
    expect(searched.items.map((row) => row.gameId).sort()).toEqual(["agree", "normal"]);
    const searchedMacro = await library.list(USER, { view: "detector", search: "Macro Transition" });
    expect(searchedMacro.items.map((row) => row.gameId)).toEqual(["disagree"]);

    const detail = await library.getDetail(USER, "disagree", { view: "detector" });
    expect(detail.game.myBuild).toBe(UNCLASSIFIED);
  });

  test("the public archive shows only the classifier's label", async () => {
    const app = makeApp(buildPublicReplaysRouter, routerDeps(new ReplayLibraryService(db)));

    const list = await request(app).get("/v1/public/replays/owner").expect(200);
    const rows = byId(list.body.items);
    expect(rows.normal.myBuild).toBe(STARGATE);
    expect(rows.disagree.myBuild).toBe(UNCLASSIFIED);
    expect(rows.agree.myBuild).toBe(STARGATE);
    expect(JSON.stringify(list.body)).not.toMatch(/buildPlanned|detectedBuild/);
    expectNoIntentLeak(list.body);

    const filtered = await request(app)
      .get(`/v1/public/replays/owner?build=${encodeURIComponent(STARGATE)}`)
      .expect(200);
    expect(filtered.body.items.map((row) => row.gameId).sort()).toEqual(["agree", "normal"]);

    const detail = await request(app).get("/v1/public/replays/owner/disagree").expect(200);
    expect(detail.body.game.myBuild).toBe(UNCLASSIFIED);
    // perGame.buildOrder reports the owner's effective label; the public
    // payload replaces it with the classifier's.
    expect(detail.body.buildOrder.my_build).toBe(UNCLASSIFIED);
    expectNoIntentLeak(detail.body);
  });

  test("an owner-view row reaching the public serializer still hides the check-in", async () => {
    const library = {
      list: async () => ({
        items: [{ gameId: "x", myBuild: STARGATE, buildPlanned: true, detectedBuild: UNCLASSIFIED }],
        sourceGames: [],
        hasMore: false,
        nextCursor: null,
      }),
      getDetail: async () => null,
    };
    const app = makeApp(buildPublicReplaysRouter, routerDeps(library));
    const res = await request(app).get("/v1/public/replays/owner").expect(200);
    expect(res.body.items[0].myBuild).toBe(UNCLASSIFIED);
    expect(res.body.items[0]).not.toHaveProperty("buildPlanned");
  });
});
