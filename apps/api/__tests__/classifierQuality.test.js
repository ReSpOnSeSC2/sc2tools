// @ts-nocheck
"use strict";

/**
 * Classifier quality console (docs/classifier-quality.md): the nightly
 * aggregate of confirmed check-ins, its k-floor and bounded window, the
 * identity-free drill-down, the admin and public routes, and the job.
 */

const express = require("express");
const request = require("supertest");
const pino = require("pino");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { ClassifierQualityService, normalizeCheckIn, K_FLOOR } = require("../src/services/classifierQuality");
const { buildAdminClassifierRouter, buildClassifierTrustRouter } = require("../src/routes/adminClassifier");
const { buildErrorHandler } = require("../src/middleware/errorHandler");
const { ClassifierQualityJob } = require("../src/jobs/classifierQualityJob");

const NOW = Date.UTC(2026, 10, 10, 12);
const DAY = 24 * 60 * 60 * 1000;
const PHOENIX = "PvZ - 2 Stargate Phoenix";
const VOID_RAY = "PvZ - 2 Stargate Void Ray";
const POOL = "Zerg - 12 Pool";
let seq = 0;

/** One confirmed, applied check-in. */
function checkIn(userId, declared, detected, extra = {}) {
  const { daysAgo = 1, axis = "build", origin = "postgame", slug = null, detectedSlug = null, ...game } = extra;
  const intent = {
    status: "confirmed", applied: true, origin, via: "agent",
    build: { key: "k", name: declared, slug, source: slug ? "custom" : "catalog" },
    detected: { name: detected, slug: detectedSlug },
    confirmedAt: new Date(NOW - daysAgo * DAY),
  };
  seq += 1;
  return {
    userId, gameId: `2026-11-0${seq % 9}T10:00:00|SecretOpponent${seq}|Map|600`, date: new Date(NOW - daysAgo * DAY),
    myRace: "Protoss", map: "Alcyone LE", durationSec: 600, opponent: { race: "Zerg", displayName: `SecretOpponent${seq}` },
    ...(axis === "build" ? { buildIntent: intent } : { buildIntent: { status: "none", opponent: intent } }),
    ...game,
  };
}

describe("classifier quality", () => {
  let mongo, db, service, details, app;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "classifier_quality_test" });
    await db.classifierQualityIndexes.settled;
    details = { findMany: jest.fn(async (_userId, ids) => new Map(ids.map((id) => [id, {
      buildLog: ["[0:00] Nexus", "[0:18] Pylon", "[2:05] Stargate", "[5:59] Phoenix", "[6:00] Phoenix", "[6:01] Oracle", "[9:00] Carrier"],
    }]))) };
    service = new ClassifierQualityService({ db, gameDetails: details, now: () => NOW,
      presetPolicies: { current: async () => ({ revision: 4, entries: [] }) } });
    app = express();
    app.use("/v1/admin/classifier", (req, res, next) => (req.get("x-admin") === "1" ? next() : res.status(403).json({ error: { code: "admin_only" } })),
      buildAdminClassifierRouter({ classifierQuality: service }));
    app.use("/v1", buildClassifierTrustRouter(service));
    app.use(buildErrorHandler(pino({ level: "silent" })));
  });
  afterAll(async () => { await db?.close(); await mongo?.stop(); });
  beforeEach(async () => {
    await db.games.deleteMany({});
    await db.classifierQuality.deleteMany({});
    details.findMany.mockClear();
  });

  async function seedFloorFixture() {
    await db.games.insertMany([
      // Three users: Void Ray detected where Phoenix was declared (published).
      checkIn("u1", PHOENIX, VOID_RAY), checkIn("u2", PHOENIX, VOID_RAY, { origin: "pregame" }),
      checkIn("u3", PHOENIX, VOID_RAY, { ingestSource: "browser", engineVersion: "1.6.3" }),
      checkIn("u3", PHOENIX, VOID_RAY, { origin: "web" }),
      // Two users only: below the k-floor.
      checkIn("u4", VOID_RAY, PHOENIX), checkIn("u5", VOID_RAY, PHOENIX),
      // Agreements count toward the trust line.
      checkIn("u4", PHOENIX, PHOENIX), checkIn("u5", PHOENIX, PHOENIX),
      // Custom builds never surface by name.
      checkIn("u1", "My private plan vs Bob", PHOENIX, { slug: "my-plan" }),
      checkIn("u2", "Another private", PHOENIX, { slug: "another" }),
      checkIn("u3", "Third private", PHOENIX, { slug: "third" }),
      // Opponent axis: the label is the opponent's (Zerg) strategy in ZvP.
      ...["u1", "u2", "u3"].map((u) => checkIn(u, POOL, "Zerg - 1 Base Roach Rush", { axis: "opponent" })),
      // Era alias folds into the released label: "Zerg - 8 Pool" is 12 Pool.
      checkIn("u6", "Zerg - 8 Pool", "Zerg - 8 Pool", { axis: "opponent", gameVersion: "5.0.16.1" }),
    ]);
  }

  test("normalizeCheckIn labels custom builds generically and folds era names", () => {
    const custom = normalizeCheckIn(checkIn("u", "Secret", PHOENIX, { slug: "s" }), "build");
    expect(custom).toMatchObject({ declared: "Custom build", detected: PHOENIX, agree: false, matchup: "PvZ", engine: "agent" });
    const opp = normalizeCheckIn(checkIn("u", "Zerg - 8 Pool", "Zerg - 8 Pool", { axis: "opponent" }), "opponent");
    expect(opp).toMatchObject({ declared: POOL, detected: POOL, agree: true, matchup: "ZvP" });
    expect(normalizeCheckIn({ userId: "u", buildIntent: { build: null } }, "build")).toBeNull();
  });

  test("publishes only pairs, labels and trust lines with at least K distinct users", async () => {
    expect(K_FLOOR).toBe(3);
    await seedFloorFixture();
    const summary = await service.recompute();
    expect(summary).toMatchObject({ checkIns: 15, truncated: false });
    const snap = await service.latest();
    const pairKeys = snap.pairs.map((p) => `${p.axis}|${p.matchup}|${p.detected}->${p.declared}`);
    expect(pairKeys).toEqual([
      `build|PvZ|${VOID_RAY}->${PHOENIX}`,
      `build|PvZ|${PHOENIX}->Custom build`,
      `opponent|ZvP|Zerg - 1 Base Roach Rush->${POOL}`,
    ]);
    const top = snap.pairs[0];
    expect(top).toMatchObject({ count: 4, users: 3, origins: { pregame: 1, postgame: 2, web: 1, other: 0 } });
    expect(top.engines).toEqual([{ engine: "agent", count: 3 }, { engine: "browser:1.6.3", count: 1 }]);
    // The two-user Phoenix-detected pair is withheld but still counted.
    expect(snap.totals).toMatchObject({ checkIns: 15, suppressedPairs: 1, suppressedCheckIns: 2, users: 6 });
    // Below-floor engine cohorts are not published.
    expect(snap.engines.map((e) => e.engine)).toEqual(["agent"]);
    expect(snap.trust).toEqual([
      { label: PHOENIX, matches: 2, corrections: 6 },
      { label: POOL, matches: 1, corrections: 4 },
    ]);
    expect(JSON.stringify(snap)).not.toMatch(/private|my-plan|SecretOpponent|u1|u2/);
  });

  test("the window is bounded: old, unapplied and deleted check-ins are ignored", async () => {
    await db.games.insertMany([
      ...["a", "b", "c"].map((u) => checkIn(u, PHOENIX, VOID_RAY, { daysAgo: 89 })),
      ...["d", "e", "f"].map((u) => checkIn(u, PHOENIX, VOID_RAY, { daysAgo: 91 })),
      { ...checkIn("g", PHOENIX, VOID_RAY), buildIntent: { ...checkIn("g", PHOENIX, VOID_RAY).buildIntent, applied: false } },
      checkIn("h", PHOENIX, VOID_RAY, { _deleted: true }),
      checkIn("i", PHOENIX, VOID_RAY, { _deletionPending: true }),
    ]);
    await service.recompute();
    const snap = await service.latest();
    expect(snap.totals.checkIns).toBe(3);
    expect(snap.windowDays).toBe(90);
    expect(snap.windowStart.getTime()).toBe(NOW - 90 * DAY);
    expect(snap.pairs).toHaveLength(1);
  });

  test("a busier window than the row limit is flagged, and only seven snapshots are kept", async () => {
    await db.games.insertMany(["a", "b", "c", "d"].map((u) => checkIn(u, PHOENIX, VOID_RAY)));
    const limited = new ClassifierQualityService({ db, now: () => NOW, rowLimit: 2 });
    expect((await limited.recompute()).truncated).toBe(true);
    for (let i = 0; i < 8; i += 1) await service.recompute();
    expect(await db.classifierQuality.countDocuments({ kind: "snapshot" })).toBe(7);
  });

  test("drill-down returns at most 20 identity-free samples cut at 6:00 next to the declared rule", async () => {
    await db.games.insertMany(Array.from({ length: 23 }, (_, i) => checkIn(`user${i % 4}`, PHOENIX, VOID_RAY, { daysAgo: 1 + i / 100 })));
    await service.recompute();
    const res = await request(app).get("/v1/admin/classifier/samples").set("x-admin", "1")
      .query({ axis: "build", matchup: "PvZ", detected: VOID_RAY, declared: PHOENIX });
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.body.samples).toHaveLength(20);
    expect(res.body.samples[0]).toMatchObject({ sample: 1, map: "Alcyone LE", race: "Protoss", opponentRace: "Zerg",
      buildLog: ["[0:00] Nexus", "[0:18] Pylon", "[2:05] Stargate", "[5:59] Phoenix", "[6:00] Phoenix"], buildLogTruncated: true });
    expect(res.body.rules.declared).toMatchObject({ name: PHOENIX, policy: null });
    expect(typeof res.body.rules.declared.description).toBe("string");
    expect(JSON.stringify(res.body)).not.toMatch(/userId|gameId|SecretOpponent|user\d/);
    expect(details.findMany).toHaveBeenCalledTimes(4);
  });

  test("routes validate cohorts, 404 unpublished pairs, gate admins and serve public trust lines", async () => {
    await seedFloorFixture();
    await service.recompute();
    const admin = (path, query) => request(app).get(path).set("x-admin", "1").query(query || {});
    const view = await admin("/v1/admin/classifier", { axis: "build", engine: "browser:1.6.3" });
    expect(view.status).toBe(200);
    expect(view.body.pairs).toEqual([expect.objectContaining({ declared: PHOENIX, count: 1 })]);
    expect(view.body.snapshot.matchups).toEqual(["PvZ", "ZvP"]);
    for (const query of [{ axis: "both" }, { matchup: "PvX" }, { detected: "x".repeat(201) }]) {
      expect((await admin("/v1/admin/classifier", query)).status).toBe(400);
    }
    expect((await admin("/v1/admin/classifier/samples", { axis: "build", matchup: "PvZ" })).status).toBe(400);
    expect((await admin("/v1/admin/classifier/samples", { axis: "build", matchup: "PvZ", detected: PHOENIX, declared: VOID_RAY })).status).toBe(404);
    expect((await request(app).get("/v1/admin/classifier")).status).toBe(403);
    const trust = await request(app).get("/v1/classifier-quality/labels");
    expect(trust.status).toBe(200);
    expect(trust.headers["cache-control"]).toContain("public");
    expect(trust.body.labels).toEqual([{ label: PHOENIX, matches: 2, corrections: 6 }, { label: POOL, matches: 1, corrections: 4 }]);
  });

  test("scans wait for the partial indexes instead of reading the whole collection", async () => {
    const building = new ClassifierQualityService({ db: { ...db, classifierQualityIndexes: { status: () => "building" } }, now: () => NOW });
    await expect(building.recompute()).rejects.toMatchObject({ status: 503, code: "classifier_quality_index_unavailable" });
    const names = (await db.games.listIndexes().toArray()).filter((i) => i.name.startsWith("classifier_quality_"));
    expect(names.map((i) => [i.name, i.partialFilterExpression])).toEqual(expect.arrayContaining([
      ["classifier_quality_build", { "buildIntent.status": "confirmed", "buildIntent.applied": true }],
      ["classifier_quality_opponent", { "buildIntent.opponent.status": "confirmed", "buildIntent.opponent.applied": true }],
    ]));
  });

  test("the job rebuilds a stale snapshot on schedule and always on Run now", async () => {
    const logger = { info: jest.fn(), warn: jest.fn() };
    const quality = { latest: jest.fn(async () => ({ generatedAt: new Date(NOW - DAY / 2) })), recompute: jest.fn(async () => ({ checkIns: 1 })) };
    const job = new ClassifierQualityJob({ db, logger, classifierQuality: quality, now: () => NOW });
    expect(await job.runOnce()).toEqual({ ran: false, reason: "fresh" });
    expect(quality.recompute).not.toHaveBeenCalled();
    expect(await job.observedRun()).toMatchObject({ ran: true, checkIns: 1 });
    quality.latest.mockResolvedValue({ generatedAt: new Date(NOW - 2 * DAY) });
    expect(await job.runOnce()).toMatchObject({ ran: true });
    quality.recompute.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "classifier_quality_index_unavailable" }));
    expect(await job.runOnce()).toEqual({ ran: false, reason: "index_building" });
  });
});
