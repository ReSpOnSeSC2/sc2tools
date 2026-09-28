// @ts-nocheck
"use strict";

/**
 * guide_samples capture through the real POST /v1/games (full app +
 * mongod): one pseudonymous sample per eligible ladder 1v1 game, idempotent
 * on re-upload, nothing for excluded games, fail-soft on malformed heavy
 * fields, never awaited by the ingest loop, and removed by GDPR delete /
 * history wipe.
 */

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");
const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { PulseMmrService } = require("../src/services/pulseMmr");
const { guideUserHash, guideGameHash } = require("../src/util/guideHash");
const { GdprService } = require("../src/services/gdpr");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "user-a") return { sub: "clerk_user_a" };
    if (token === "user-b") return { sub: "clerk_user_b" };
    throw new Error("invalid");
  }),
}));

const PEPPER = Buffer.alloc(32, 7);
const config = {
  port: 0, nodeEnv: "test", logLevel: "silent", mongoUri: "", mongoDb: "sc2tools_test_guide_samples_ingest",
  clerkSecretKey: "sk_test", clerkJwtIssuer: undefined, clerkJwtAudience: undefined,
  serverPepper: PEPPER, corsAllowedOrigins: [], rateLimitPerMinute: 5000,
  agentReleaseAdminToken: "admin", pythonExe: null, pythonAnalyzerDir: "/tmp/__nonexistent__", adminUserIds: [],
};

const OPPONENT_NAME = "GuideFoeName";
const PULSE_ID = "1-S2-1-777001";

/** An eligible PvZ ladder 1v1 upload. */
function ladderGame(gameId, overrides = {}) {
  return {
    gameId,
    date: "2026-07-01T12:00:00.000Z",
    result: "Victory",
    myRace: "Protoss",
    myBuild: "PvZ - Stargate into Glaives",
    map: "Site Delta LE",
    durationSec: 700,
    playerCount: 2,
    matchFormat: "1v1",
    isLadderGame: true,
    gameVersion: "5.0.16.97425",
    gameBuild: 97425,
    buildLog: ["[0:00] Nexus", "[0:18] Pylon", "[0:40] Gateway", "[1:30] Nexus", "[3:05] Stargate", "[4:31] TwilightCouncil"],
    oppBuildLog: ["[0:00] Hatchery"],
    macroBreakdown: {
      unit_timeline: [
        { time: 362, my: { Adept: 4, Oracle: 1, Probe: 40 }, opp: { Zergling: 10 } },
        { time: 600, my: { Adept: 8, Stalker: 2 }, opp: { Roach: 6 } },
      ],
    },
    opponent: {
      displayName: OPPONENT_NAME, race: "Zerg", leagueId: 4, mmr: 4120, pulseId: PULSE_ID, pulseLookupAttempted: true,
    },
    ...overrides,
  };
}

describe("POST /v1/games captures guide_samples", () => {
  let mongo; let db; let app; let services; let userId;

  const post = (body, token = "user-a") => request(app).post("/v1/games").set("authorization", `Bearer ${token}`).send(body);
  const samples = () => db.guideSamples.find({}).toArray();

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: config.mongoDb });
    const built = buildApp({
      db, logger: pino({ level: "silent" }), config,
      pulseMmr: new PulseMmrService({ fetchImpl: async () => { throw new Error("network_disabled_in_tests"); } }),
    });
    app = built.app;
    services = built.services;
    // Never fetch Liquipedia (it would rewrite data/ladder-map-pool.json).
    jest.spyOn(services.seasons.ladderMapPool, "get").mockResolvedValue({ maps: ["Site Delta"], teamMaps: [] });
    const me = await request(app).get("/v1/me").set("authorization", "Bearer user-a");
    expect(me.status).toBe(200);
    userId = me.body.userId;
  });

  afterEach(async () => {
    await services.guideSamples.drain();
    services.guideSamples.disabled = false;
    jest.restoreAllMocks();
    jest.spyOn(services.seasons.ladderMapPool, "get").mockResolvedValue({ maps: ["Site Delta"], teamMaps: [] });
    await Promise.all([
      db.games.deleteMany({}), db.gameDetails.deleteMany({}), db.opponents.deleteMany({}), db.guideSamples.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    if (services) await services.customBuilds.stopReclassifications();
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  test("an accepted ladder 1v1 game writes one pseudonymous sample", async () => {
    const res = await post(ladderGame("g-guide-1"));
    expect(res.status).toBe(202);
    expect(res.body.accepted).toEqual([expect.objectContaining({ gameId: "g-guide-1", created: true })]);
    await services.guideSamples.drain();
    const docs = await samples();
    expect(docs).toHaveLength(1);
    const [doc] = docs;
    expect(doc).toMatchObject({
      userHash: guideUserHash(PEPPER, userId),
      gameHash: guideGameHash(PEPPER, userId, "g-guide-1"),
      buildKey: "PvZ - Stargate into Glaives", matchup: "PvZ", era: "after", leagueBand: 4, mmrBand: 4000,
      result: "Victory", map: "Site Delta LE", durationSec: 700, _schemaVersion: 1,
      milestones: { Pylon: 18, Gateway: 40, "Nexus#2": 90, Stargate: 185, TwilightCouncil: 271 },
      army: { 360: { Adept: 4, Oracle: 1 }, 600: { Adept: 8, Stalker: 2 } },
    });
    expect(doc.createdAt).toBeInstanceOf(Date);
    expect(Object.keys(doc.army)).toEqual(["360", "600"]); // 8:00 had no sample within 15 s → omitted
    const text = JSON.stringify(doc);
    for (const needle of [userId, "g-guide-1", OPPONENT_NAME, PULSE_ID, "userId", "gameId", "displayName"]) {
      expect(text).not.toContain(needle);
    }
    expect(services.guideSamples.counters.captured).toBeGreaterThanOrEqual(1);
  });

  test("re-upload is idempotent: still one doc, updated in place", async () => {
    await post(ladderGame("g-guide-2"));
    await services.guideSamples.drain();
    const [first] = await samples();
    const res = await post(ladderGame("g-guide-2", { result: "Defeat" }));
    expect(res.body.accepted).toEqual([expect.objectContaining({ gameId: "g-guide-2", created: false })]);
    await services.guideSamples.drain();
    const docs = await samples();
    expect(docs).toHaveLength(1);
    expect(docs[0].result).toBe("Defeat");
    expect(docs[0].createdAt).toEqual(first.createdAt);
    expect(docs[0].updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
  });

  test("a re-upload relabelled to a non-guide build removes the stale sample", async () => {
    await post(ladderGame("g-relabel"));
    await services.guideSamples.drain();
    expect(await samples()).toHaveLength(1);
    const res = await post(ladderGame("g-relabel", { myBuild: "PvZ - Macro Transition (Unclassified)" }));
    expect(res.body.accepted).toEqual([expect.objectContaining({ gameId: "g-relabel", created: false })]);
    await services.guideSamples.drain();
    expect(await samples()).toHaveLength(0);
    expect((await db.games.findOne({ gameId: "g-relabel" })).myBuild).toBe("PvZ - Macro Transition (Unclassified)");
  });

  test("a game a saved 'you' custom build relabels feeds no sample; its re-upload drops the stale one", async () => {
    await post(ladderGame("g-custom-old"));
    await services.guideSamples.drain();
    expect(await samples()).toHaveLength(1);
    const saved = await request(app).put("/v1/custom-builds/my-glaives").set("authorization", "Bearer user-a").send({
      slug: "my-glaives", name: "My Glaives", race: "Protoss", vsRace: "Zerg", perspective: "you",
      rules: [{ type: "before", name: "BuildStargate", time_lt: 240 }], reclassify: false,
    });
    expect(saved.status).toBe(200);
    try {
      await post(ladderGame("g-custom-new"));
      const reupload = await post(ladderGame("g-custom-old"));
      expect(reupload.body.accepted).toEqual([expect.objectContaining({ gameId: "g-custom-old", created: false })]);
      await services.guideSamples.drain();
      const projection = { _id: 0, myBuild: 1, _customBuildSlug: 1 };
      const rows = await db.games.find({ userId }, { projection }).toArray();
      expect(rows).toEqual([
        { myBuild: "My Glaives", _customBuildSlug: "my-glaives" },
        { myBuild: "My Glaives", _customBuildSlug: "my-glaives" },
      ]);
      expect(await samples()).toHaveLength(0);
    } finally {
      await db.customBuilds.deleteMany({ userId });
    }
  });

  test.each([
    ["team game", { playerCount: 4, matchFormat: "team" }],
    ["non-ladder", { isLadderGame: false }],
    ["custom build name", { myBuild: "My Private Build" }],
    ["game too short", { myBuild: "PvZ - Game Too Short" }],
    ["random race", { myRace: "Random" }],
  ])("excluded: %s writes nothing", async (_label, overrides) => {
    const res = await post(ladderGame("g-excluded", overrides));
    expect(res.status).toBe(202);
    expect(res.body.accepted).toHaveLength(1);
    await services.guideSamples.drain();
    expect(await samples()).toHaveLength(0);
  });

  test("excluded: a resumed replay writes nothing", async () => {
    const res = await post(ladderGame("g-resumed", { isResumedFromReplay: true }));
    expect(res.status).toBe(202);
    await services.guideSamples.drain();
    expect(await samples()).toHaveLength(0);
  });

  test("malformed heavy fields: 202, no crash, counted as skipped", async () => {
    const before = { ...services.guideSamples.counters };
    const res = await post({
      games: [
        ladderGame("g-bad-log", { buildLog: ["garbage", "[99:9] nope"] }),
        ladderGame("g-bad-timeline", { macroBreakdown: { unit_timeline: [{ time: "six", my: { Adept: 3 } }, {}] } }),
      ],
    });
    expect(res.status).toBe(202);
    expect(res.body.accepted.map((a) => a.gameId).sort()).toEqual(["g-bad-log", "g-bad-timeline"]);
    await services.guideSamples.drain();
    expect(services.guideSamples.counters.skipped).toBe(before.skipped + 1);
    const docs = await samples();
    expect(docs).toHaveLength(1);
    expect(docs[0].army).toEqual({});
  });

  test("a failing sample write never fails the upload", async () => {
    const before = services.guideSamples.counters.failed;
    jest.spyOn(services.guideSamples.coll, "updateOne").mockRejectedValue(Object.assign(new Error("down"), { code: 91 }));
    const res = await post(ladderGame("g-write-fails"));
    expect(res.status).toBe(202);
    expect(res.body.rejected).toEqual([]);
    await services.guideSamples.drain();
    expect(services.guideSamples.counters.failed).toBe(before + 1);
    expect(await db.games.countDocuments({ gameId: "g-write-fails" })).toBe(1);
  });

  test("the ingest response never waits for the sample write", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const real = services.guideSamples.coll.updateOne.bind(services.guideSamples.coll);
    jest.spyOn(services.guideSamples.coll, "updateOne").mockImplementation(async (...args) => {
      await gate;
      return real(...args);
    });
    const res = await post(ladderGame("g-slow-write"));
    expect(res.status).toBe(202);
    expect(services.guideSamples.pending.size).toBe(1); // still in flight after the 202
    expect(await samples()).toHaveLength(0);
    release();
    await services.guideSamples.drain();
    expect(await samples()).toHaveLength(1);
  });

  test("kill switch: a disabled service writes nothing", async () => {
    services.guideSamples.disabled = true;
    const res = await post(ladderGame("g-killed"));
    expect(res.status).toBe(202);
    await services.guideSamples.drain();
    expect(await samples()).toHaveLength(0);
  });

  test("GDPR wipeGames: a ranged wipe removes only the wiped games' samples, a full wipe the rest", async () => {
    await post({
      games: [
        ladderGame("g-old", { date: "2026-06-01T12:00:00.000Z", gameBuild: 97000, gameVersion: "5.0.15.97000" }),
        ladderGame("g-new", { date: "2026-07-05T12:00:00.000Z" }),
      ],
    });
    await services.guideSamples.drain();
    expect(await samples()).toHaveLength(2);
    const partial = await services.gdpr.wipeGames(userId, { until: new Date("2026-06-15T00:00:00Z") });
    expect(partial.games).toBe(1);
    expect(partial.guideSamples).toBe(1);
    const left = await samples();
    expect(left.map((d) => d.gameHash)).toEqual([guideGameHash(PEPPER, userId, "g-new")]);
    const full = await services.gdpr.wipeGames(userId);
    expect(full.guideSamples).toBe(1);
    expect(await samples()).toHaveLength(0);
  });

  test("GDPR ranged wipe with replay storage deletes samples by the replay id snapshot", async () => {
    await post({
      games: [
        ladderGame("g-r-old", { date: "2026-06-01T12:00:00.000Z" }),
        ladderGame("g-r-new", { date: "2026-07-05T12:00:00.000Z" }),
      ],
    });
    await services.guideSamples.drain();
    const replayFiles = { deleteMany: jest.fn(async () => {}), deleteAllForUser: jest.fn(async () => {}) };
    const gdpr = new GdprService(db, { gameDetails: services.gameDetails, replayFiles, guideSamples: services.guideSamples });
    const res = await gdpr.wipeGames(userId, { until: new Date("2026-06-15T00:00:00Z") });
    expect(res).toMatchObject({ games: 1, guideSamples: 1 });
    expect(replayFiles.deleteMany).toHaveBeenCalledWith(userId, ["g-r-old"]);
    expect((await samples()).map((d) => d.gameHash)).toEqual([guideGameHash(PEPPER, userId, "g-r-new")]);
  });

  test("GDPR snapshot restore purges the user's samples with the detail blobs", async () => {
    await post(ladderGame("g-restore"));
    await services.guideSamples.drain();
    const { id } = await services.gdpr.snapshot(userId);
    await post(ladderGame("g-after-snapshot"));
    await services.guideSamples.drain();
    expect(await samples()).toHaveLength(2);
    await services.gdpr.restoreSnapshot(userId, id);
    expect(await samples()).toHaveLength(0);
    expect(await db.games.countDocuments({ userId })).toBe(1);
    await db.db.collection("user_backups").deleteMany({});
  });

  test("GDPR deleteAll removes every sample of the user and only theirs", async () => {
    const meB = await request(app).get("/v1/me").set("authorization", "Bearer user-b");
    const userB = meB.body.userId;
    await post(ladderGame("g-a-keep"));
    await post(ladderGame("g-b-1"), "user-b");
    await post(ladderGame("g-b-2", { result: "Defeat" }), "user-b");
    await services.guideSamples.drain();
    expect(await samples()).toHaveLength(3);
    const counts = await services.gdpr.deleteAll(userB);
    expect(counts.guideSamples).toBe(2);
    expect(await db.guideSamples.countDocuments({ userHash: guideUserHash(PEPPER, userB) })).toBe(0);
    expect(await db.guideSamples.countDocuments({ userHash: guideUserHash(PEPPER, userId) })).toBe(1);
  });
});
