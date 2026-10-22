// @ts-nocheck
"use strict";

/**
 * Build check-in readers on the catalog-label build surfaces (contract
 * §1.6 / §5):
 *
 *   - /v1/builds rows and /v1/builds/:name totals count a confirmed
 *     check-in toward the declared build and say how many games count
 *     only because of one (``checkins``);
 *   - /v1/builds/:name recent rows carry ``planned`` (detected + notes);
 *   - build-shape views (dossier median timings, build phases) use only
 *     games whose replay agrees with the label.
 */

const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { BuildsService } = require("../src/services/builds");
const { StrategyPhasesService } = require("../src/services/strategyPhases");
const { PerGameComputeService } = require("../src/services/perGameCompute");
const { computeDossierExtras } = require("../src/services/buildDossier");
const { buildBuildsRouter } = require("../src/routes/builds");
const {
  STARGATE,
  VOID_RAY,
  UNCLASSIFIED,
  SECRET_NOTES,
  slimGame,
  checkIn,
  seedThree,
} = require("./helpers/buildIntentReadersSeed");

const USER = "u-builds";
const VOID_RAY_REF = { key: "pvz-2-stargate-void-ray", name: VOID_RAY, slug: null, source: "catalog" };

/** Each row's Stargate lands at a different second so medians reveal the cohort. */
const STARGATE_AT = { normal: "3:00", disagree: "6:00", agree: "3:20", "void-over-stargate": "4:00" };

/** @param {string} at "m:ss" */
function buildLog(at) {
  return ["[0:00] Nexus", "[0:18] Pylon", "[0:45] Gateway", "[1:30] Nexus", `[${at}] Stargate`];
}

let mongo;
let db;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  db = await connect({ uri: mongo.getUri(), dbName: "build_intent_readers_builds_test" });
});

afterAll(async () => {
  if (db) await db.close();
  if (mongo) await mongo.stop();
});

beforeEach(async () => {
  await db.games.deleteMany({});
  await seedThree(db.games, USER, (row) => ({ ...row, buildLog: buildLog(STARGATE_AT[row.gameId]) }));
  await db.games.insertOne(slimGame(USER, "void-over-stargate", {
    myBuild: STARGATE,
    date: new Date("2026-10-13T18:00:00.000Z"),
    buildLog: buildLog(STARGATE_AT["void-over-stargate"]),
  }));
  await checkIn(db.games, USER, "void-over-stargate", VOID_RAY_REF);
});

describe("BuildsService", () => {
  test("list counts check-ins toward the declared build and reports them", async () => {
    const rows = Object.fromEntries((await new BuildsService(db).list(USER, {})).map((r) => [r.name, r]));
    expect(rows[STARGATE]).toMatchObject({ total: 3, wins: 2, losses: 1, checkins: 1 });
    expect(rows[VOID_RAY]).toMatchObject({ total: 1, wins: 1, losses: 0, checkins: 1 });
    expect(rows[UNCLASSIFIED]).toBeUndefined();
  });

  test("detail totals, planned recent rows and agreeing-only timings", async () => {
    const detail = await new BuildsService(db).detail(USER, STARGATE, {});
    expect(detail.totals).toMatchObject({ total: 3, wins: 2, losses: 1, checkins: 1 });

    const recent = Object.fromEntries(detail.recent.map((r) => [r.gameId, r]));
    expect(recent.normal.planned).toBeNull();
    expect(recent.disagree.planned).toEqual({ detected: UNCLASSIFIED, notes: SECRET_NOTES });
    expect(recent.agree.planned).toEqual({ detected: STARGATE, notes: SECRET_NOTES });
    expect(recent.disagree).not.toHaveProperty("buildIntent");

    // Timings come from "normal" (3:00) and "agree" (3:20) only.
    expect(detail.medianTimings.Stargate).toMatchObject({ median: 190, count: 2 });
    expect(detail.matchupTimings.PvZ.Stargate).toMatchObject({ median: 190, count: 2 });
    // Every other dossier figure still describes all three games.
    expect(detail.matchupCounts).toEqual({ PvZ: 3 });
    expect(detail.last5Games.map((g) => g.id)).toEqual(["agree", "disagree", "normal"]);
    expect(JSON.stringify(detail.last5Games)).not.toContain(SECRET_NOTES);
  });

  test("a build whose only game is a disagreeing check-in has W-L but no timings", async () => {
    const detail = await new BuildsService(db).detail(USER, VOID_RAY, {});
    expect(detail.totals).toMatchObject({ total: 1, wins: 1, checkins: 1 });
    expect(detail.recent[0].planned).toEqual({ detected: STARGATE, notes: SECRET_NOTES });
    expect(detail.medianTimings.Stargate).toMatchObject({ median: null, count: 0 });
  });

  test("routes serve checkins and planned", async () => {
    const app = express();
    app.use("/v1", buildBuildsRouter({
      builds: new BuildsService(db),
      auth: (req, _res, next) => {
        req.auth = { userId: USER, source: "clerk" };
        next();
      },
    }));
    const list = await request(app).get("/v1/builds").expect(200);
    expect(list.body.find((r) => r.name === STARGATE)).toMatchObject({ total: 3, checkins: 1 });
    const detail = await request(app).get(`/v1/builds/${encodeURIComponent(STARGATE)}`).expect(200);
    expect(detail.body.totals.checkins).toBe(1);
    expect(detail.body.recent.find((r) => r.gameId === "disagree").planned)
      .toEqual({ detected: UNCLASSIFIED, notes: SECRET_NOTES });
  });
});

describe("computeDossierExtras timingGames", () => {
  test("narrows only the timing fields", () => {
    const games = ["normal", "disagree", "agree"].map((id, i) => ({
      gameId: id,
      date: new Date(Date.UTC(2026, 9, 12 - i)),
      result: "Victory",
      myRace: "Protoss",
      opponent: { race: "Zerg", strategy: "Zerg - 12 Pool" },
      buildLog: buildLog(STARGATE_AT[id]),
    }));
    const all = computeDossierExtras(games);
    const narrowed = computeDossierExtras(games, { timingGames: [games[0], games[2]] });
    expect(all.medianTimings.Stargate).toMatchObject({ median: 200, count: 3 });
    expect(narrowed.medianTimings.Stargate).toMatchObject({ median: 190, count: 2 });
    expect(narrowed.topStrategies).toEqual(all.topStrategies);
    expect(narrowed.last5Games).toEqual(all.last5Games);
    expect(narrowed.matchupCounts).toEqual(all.matchupCounts);
  });
});

describe("StrategyPhasesService.evaluateByBuildName", () => {
  test("uses only games whose replay agrees with the label", async () => {
    const phases = new StrategyPhasesService(db, { perGame: new PerGameComputeService({ games: db.games }) });
    const stargate = await phases.evaluateByBuildName(USER, STARGATE, {});
    expect(stargate.total).toBe(2);
    // The only Void Ray game is a check-in the replay disagrees with.
    await expect(phases.evaluateByBuildName(USER, VOID_RAY, {})).resolves.toBeNull();
  });

  test("asks the preview iterator for the agreeing view and re-checks agreement", async () => {
    let captured = null;
    const disagreeing = {
      gameId: "d",
      myBuild: STARGATE,
      buildIntent: { status: "confirmed", applied: true, build: { name: STARGATE }, detected: { name: UNCLASSIFIED } },
    };
    const phases = new StrategyPhasesService({}, {
      perGame: {
        async *iterateRulePreviewPages(_userId, opts) {
          captured = opts;
          yield { games: [disagreeing], candidates: 1, hasMore: false };
        },
      },
    });
    await expect(phases.evaluateByBuildName(USER, STARGATE, {})).resolves.toBeNull();
    expect(captured.view).toBe("agreeing");
    expect(captured.metadataFilter(disagreeing)).toBe(false);
  });

  test("strategy evaluation keeps its own (unchanged) cohort", async () => {
    let captured = null;
    const phases = new StrategyPhasesService({}, {
      perGame: {
        async *iterateRulePreviewPages(_userId, opts) {
          captured = opts;
          yield { games: [], candidates: 0, hasMore: false };
        },
      },
    });
    await phases.evaluate(USER, "Zerg - 12 Pool", {});
    expect(captured).not.toHaveProperty("view");
  });
});
