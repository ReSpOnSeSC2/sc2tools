// @ts-nocheck
"use strict";

/**
 * Build check-in writer guards end to end: agent ingest (upsert + custom
 * tagger), the custom-build library routes and the durable reclassify
 * worker never clear or replace a confirmed check-in, and the declared
 * build's stats stay unified across a rename.
 *
 * Check-ins are applied with ``applyOverridePipeline`` (what the
 * build-intent routes run), so this suite only depends on the writers.
 */

const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const pino = require("pino");

const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { PulseMmrService } = require("../src/services/pulseMmr");
const { randomToken, sha256 } = require("../src/util/hash");
const { applyOverridePipeline } = require("../src/services/buildIntentAttribution");

jest.mock("@clerk/backend", () => ({
  verifyToken: jest.fn(async (token) => {
    if (token === "guard-token") return { sub: "clerk_user_guard" };
    if (token === "catalog-token") return { sub: "clerk_user_catalog" };
    throw new Error("invalid");
  }),
}));

const STARGATE_LOG = ["[0:17] Pylon", "[0:49] Gateway", "[1:30] CyberneticsCore", "[3:00] Stargate"];
const GATEWAY_LOG = ["[0:17] Pylon", "[0:49] Gateway", "[1:30] CyberneticsCore"];
const DT_REF = { key: "custom:dt-rush", name: "DT Rush", slug: "dt-rush", source: "custom" };
const CATALOG_REF = { key: "pvz-dt-rush", name: "PvZ - DT Rush", slug: null, source: "catalog" };

let mongo;
let db;
let app;
let services;
const emitted = [];

const io = {
  to: jest.fn((room) => ({
    emit: (event, data) => emitted.push({ room, event, data }),
  })),
  in: jest.fn(() => ({ fetchSockets: async () => [] })),
  on: jest.fn(),
};

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const dbName = "sc2tools_test_build_intent_guards";
  db = await connect({ uri: mongo.getUri(), dbName });
  ({ app, services } = buildApp({
    db,
    io,
    logger: pino({ level: "silent" }),
    config: {
      port: 0,
      nodeEnv: "test",
      logLevel: "silent",
      mongoUri: "",
      mongoDb: dbName,
      clerkSecretKey: "sk_test",
      clerkJwtIssuer: undefined,
      clerkJwtAudience: undefined,
      serverPepper: Buffer.alloc(32, 3),
      corsAllowedOrigins: [],
      rateLimitPerMinute: 5000,
      agentReleaseAdminToken: "admin",
      pythonExe: null,
      pythonAnalyzerDir: "/tmp/__nonexistent__",
      adminUserIds: [],
    },
    pulseMmr: new PulseMmrService({
      fetchImpl: async () => {
        throw new Error("network_disabled_in_tests");
      },
    }),
  }));
});

afterAll(async () => {
  if (services?.customBuilds) await services.customBuilds.stopReclassifications();
  if (db) await db.close();
  if (mongo) await mongo.stop();
});

const asUser = (token, req) => req.set("authorization", `Bearer ${token}`);

async function bootstrap(token) {
  const me = await asUser(token, request(app).get("/v1/me"));
  expect(me.status).toBe(200);
  const raw = randomToken(32);
  const now = new Date();
  await db.deviceTokens.insertOne({
    tokenHash: sha256(raw),
    userId: me.body.userId,
    createdAt: now,
    lastSeenAt: now,
    revokedAt: null,
  });
  return { userId: me.body.userId, device: raw };
}

function agentGame(n, over = {}) {
  return {
    gameId: `2026-10-20T18:0${n}:00|Opp|Site Delta LE|620`,
    date: `2026-10-20T18:0${n}:00.000Z`,
    result: "Victory",
    myRace: "Protoss",
    myBuild: "PvZ - Macro Transition (Unclassified)",
    map: "Site Delta LE",
    durationSec: 620,
    myMmrSource: "unavailable",
    isLadderGame: true,
    buildLog: STARGATE_LOG,
    oppBuildLog: ["[0:50] SpawningPool"],
    opponent: { displayName: "Opp", race: "Zerg" },
    ...over,
  };
}

async function ingest(device, games) {
  const res = await asUser(device, request(app).post("/v1/games")).send({ games });
  expect(res.status).toBe(202);
  expect(res.body.rejected).toEqual([]);
  return res.body;
}

async function saveBuild(token, slug, body) {
  const res = await asUser(token, request(app).put(`/v1/custom-builds/${slug}`)).send({
    slug,
    race: "Protoss",
    vsRace: "Zerg",
    ...body,
  });
  expect(res.status).toBe(200);
  return res.body;
}

async function waitForIdleJob(userId) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const job = await db.customBuildJobs.findOne({ userId });
    if (job && job.status === "complete") return job;
    if (job && job.status === "failed") throw new Error(`reclassification failed: ${job.error}`);
    if (Date.now() >= deadline) throw new Error("timed out waiting for reclassification");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function stats(token) {
  const res = await asUser(token, request(app).get("/v1/custom-builds/stats"));
  expect(res.status).toBe(200);
  return Object.fromEntries(res.body.map((row) => [row.slug, row]));
}

test("a declared custom build survives ingest, Save & Reclassify, rename and delete", async () => {
  const { userId, device } = await bootstrap("guard-token");
  await saveBuild("guard-token", "stargate-opener", {
    name: "Stargate Opener",
    rules: [{ type: "before", name: "BuildStargate", time_lt: 300 }],
    reclassify: false,
  });
  await saveBuild("guard-token", "dt-rush", {
    name: "DT Rush",
    rules: [{ type: "before", name: "BuildDarkShrine", time_lt: 420 }],
    reclassify: false,
  });
  const declared = agentGame(1);
  const plain = agentGame(2, { result: "Defeat" });
  await ingest(device, [declared, plain]);
  expect((await db.games.findOne({ userId, gameId: declared.gameId })).myBuild).toBe("Stargate Opener");

  // The player declares DT Rush; the replay never satisfied its rules.
  await db.games.updateOne(
    { userId, gameId: declared.gameId },
    applyOverridePipeline(DT_REF, { origin: "postgame", via: "agent", notes: "" }),
  );
  let library = await stats("guard-token");
  expect(library["dt-rush"]).toEqual(expect.objectContaining({ total: 1, wins: 1, checkins: 1 }));
  expect(library["stargate-opener"]).toEqual(expect.objectContaining({ total: 1, losses: 1, checkins: 0 }));
  const matches = await asUser("guard-token", request(app).get("/v1/custom-builds/dt-rush/matches"));
  expect(matches.status).toBe(200);
  expect(matches.body.totals).toEqual(expect.objectContaining({ total: 1, checkins: 1 }));
  expect(matches.body.recent).toEqual([expect.objectContaining({
    gameId: declared.gameId,
    planned: { detected: "Stargate Opener", notes: "" },
  })]);

  // Agent re-upload: the classifier refreshes detected, the check-in stays.
  await ingest(device, [{ ...declared, myBuild: "PvZ - Phoenix (agent)", buildLog: GATEWAY_LOG }]);
  let stored = await db.games.findOne({ userId, gameId: declared.gameId });
  expect(stored.myBuild).toBe("DT Rush");
  expect(stored._customBuildSlug).toBe("dt-rush");
  expect(stored.buildIntent.detected).toEqual({ name: "PvZ - Phoenix (agent)", slug: null });
  await ingest(device, [declared]);
  stored = await db.games.findOne({ userId, gameId: declared.gameId });
  expect(stored.myBuild).toBe("DT Rush");
  expect(stored.buildIntent.detected).toEqual({ name: "Stargate Opener", slug: "stargate-opener" });

  // Save & Reclassify of the declared build (clearUnmatched) never clears it.
  const saved = await saveBuild("guard-token", "dt-rush", {
    name: "DT Rush",
    rules: [{ type: "before", name: "BuildDarkShrine", time_lt: 400 }],
    reclassify: true,
  });
  expect(saved.reclassify).toMatchObject({ status: "queued" });
  await waitForIdleJob(userId);
  stored = await db.games.findOne({ userId, gameId: declared.gameId });
  expect(stored.myBuild).toBe("DT Rush");
  expect(stored._customBuildSlug).toBe("dt-rush");
  expect(stored.buildIntent.detected).toEqual({ name: "Stargate Opener", slug: "stargate-opener" });
  // Reclassifying the detector's build routes its verdict to detected.
  await saveBuild("guard-token", "stargate-opener", {
    name: "Stargate Opener",
    rules: [{ type: "before", name: "BuildStargate", time_lt: 120 }],
    reclassify: true,
  });
  await waitForIdleJob(userId);
  stored = await db.games.findOne({ userId, gameId: declared.gameId });
  expect(stored.myBuild).toBe("DT Rush");
  expect(stored.buildIntent.detected).toEqual({ name: null, slug: null });
  library = await stats("guard-token");
  expect(library["dt-rush"]).toEqual(expect.objectContaining({ total: 1, checkins: 1 }));

  // Rename without reclassify: name-keyed stats stay unified and SPA tabs refresh.
  emitted.length = 0;
  await saveBuild("guard-token", "dt-rush", {
    name: "DT Rush v2",
    rules: [{ type: "before", name: "BuildDarkShrine", time_lt: 400 }],
    reclassify: false,
  });
  stored = await db.games.findOne({ userId, gameId: declared.gameId });
  expect(stored.myBuild).toBe("DT Rush v2");
  expect(stored.buildIntent.build).toEqual({ ...DT_REF, name: "DT Rush v2" });
  expect(emitted).toEqual([
    { room: `user:${userId}`, event: "games:changed", data: { count: 1, inserted: 0, bulk: true, reason: "reclassify" } },
  ]);
  const byName = await asUser("guard-token", request(app).get("/v1/builds"));
  expect(byName.status).toBe(200);
  const names = byName.body.map((row) => row.name);
  expect(names).toContain("DT Rush v2");
  expect(names).not.toContain("DT Rush");

  // Delete: the check-in stays frozen (name + slug) for an undelete.
  const deleted = await asUser("guard-token", request(app).delete("/v1/custom-builds/dt-rush"));
  expect(deleted.status).toBe(204);
  await waitForIdleJob(userId);
  stored = await db.games.findOne({ userId, gameId: declared.gameId });
  expect(stored.myBuild).toBe("DT Rush v2");
  expect(stored._customBuildSlug).toBe("dt-rush");
  expect(stored.buildIntent).toEqual(expect.objectContaining({
    status: "confirmed",
    applied: true,
    build: { ...DT_REF, name: "DT Rush v2" },
  }));
  await ingest(device, [declared]);
  stored = await db.games.findOne({ userId, gameId: declared.gameId });
  expect(stored.myBuild).toBe("DT Rush v2");
  expect(stored._customBuildSlug).toBe("dt-rush");

  // The undeleted card shows the frozen check-in again.
  await saveBuild("guard-token", "dt-rush", {
    name: "DT Rush v2",
    rules: [{ type: "before", name: "BuildDarkShrine", time_lt: 400 }],
    reclassify: false,
  });
  library = await stats("guard-token");
  expect(library["dt-rush"]).toEqual(expect.objectContaining({ total: 1, checkins: 1 }));
});

test("a catalog check-in survives a re-upload by a user with no custom builds", async () => {
  const { userId, device } = await bootstrap("catalog-token");
  const game = agentGame(3, { myBuild: "PvZ - Macro" });
  await ingest(device, [game]);
  await db.games.updateOne(
    { userId, gameId: game.gameId },
    applyOverridePipeline(CATALOG_REF, { origin: "web", via: "web", notes: "" }),
  );

  await ingest(device, [{ ...game, myBuild: "PvZ - Macro (agent v2)" }]);

  const stored = await db.games.findOne({ userId, gameId: game.gameId });
  expect(stored.myBuild).toBe("PvZ - DT Rush");
  expect(stored).not.toHaveProperty("_customBuildSlug");
  expect(stored.buildIntent).toEqual(expect.objectContaining({
    status: "confirmed",
    applied: true,
    build: CATALOG_REF,
    detected: { name: "PvZ - Macro (agent v2)", slug: null },
  }));
  const byName = await asUser("catalog-token", request(app).get("/v1/builds"));
  expect(byName.body.map((row) => row.name)).toEqual(["PvZ - DT Rush"]);
});
