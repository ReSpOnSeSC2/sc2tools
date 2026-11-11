// @ts-nocheck
"use strict";

// Re-analysis center: strict versions, cohort counts against real Mongo
// indexes, and the paced durable job protocol with a synthetic agent socket.
const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { parseStrictSemver, compareStrictSemver } = require("../src/util/strictSemver");
const { loadMilestoneCatalog, countCohorts, MILESTONE_CATALOG } = require("../src/services/reanalysisCohorts");
const { ReanalysisService, retireReanalysisJobs } = require("../src/services/reanalysis");
const { buildReanalysisRouter } = require("../src/routes/reanalysis");
const { GDPR_CLASSIFICATION, PURGE_ONLY_COLLECTIONS } = require("../src/services/gdpr");
const { attachSocketAuth } = require("../src/socket/auth");

jest.mock("@clerk/backend", () => ({ verifyToken: jest.fn(async () => ({ sub: "web" })) }));

const OWNER = "u_owner";
const OTHER = "u_other";
const DEVICE = "a".repeat(24);
const NEW = "1.6.12";

let mongo;
let db;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  db = await connect({ uri: mongo.getUri(), dbName: "reanalysis" });
});
afterAll(async () => {
  await db?.close();
  await mongo?.stop();
});
beforeEach(async () => {
  await Promise.all([db.games.deleteMany({}), db.reanalysisJobs.deleteMany({})]);
});

/** @param {number} index @param {Record<string, unknown>} [extra] */
function game(index, extra = {}) {
  return {
    userId: OWNER, gameId: `g-${String(index).padStart(4, "0")}`, date: new Date(Date.UTC(2026, 0, 1) + index * 60_000),
    myRace: "Protoss", opponent: { race: "Terran" }, ingestSource: "agent", engineVersion: "1.6.9",
    macroScore: 50, updatedAt: new Date("2026-01-01T00:00:00Z"), ...extra,
  };
}

describe("strict semver", () => {
  test.each([
    ["1.6.9", "1.6.10", -1], ["1.6.10", "1.6.10", 0], ["1.6.11-rc.1", "1.6.11", -1], ["1.6.11+build.7", "1.6.11", 0],
    ["1.0.0-alpha", "1.0.0-alpha.1", -1], ["1.0.0-alpha.1", "1.0.0-alpha.beta", -1], ["1.0.0-beta.2", "1.0.0-beta.11", -1],
    ["1.0.0-rc.1", "1.0.0", -1], ["2.0.0", "10.0.0", -1],
    ["9007199254740993.0.0", "9007199254740992.0.0", 1], ["1.0.0-9223372036854775808", "1.0.0-9223372036854775807", 1],
  ])("%s vs %s", (a, b, order) => {
    expect(compareStrictSemver(a, b)).toBe(order);
    expect(compareStrictSemver(b, a)).toBe(order === 0 ? 0 : -order);
  });
  test.each(["", "1.6", "v1.6.9", "01.6.9", "1.06.9", "1.6.9-01", "1.6.9-", "1.6.9 ", "0.0.0-" + "x".repeat(40), 1, null, {}])("%j is not strict semver", (value) => {
    expect(parseStrictSemver(value)).toBeNull();
    expect(compareStrictSemver(value, "1.0.0")).toBeNull();
  });
  test("exactly 40 characters is accepted", () => {
    expect(parseStrictSemver(`1.0.0-${"a".repeat(34)}`)).not.toBeNull();
  });
});

describe("milestone catalog", () => {
  const row = { engine: "1.6.10", date: "2026-10-10", summary: "Changed.", matchups: ["PvT", "TvP"] };
  test("the shipped catalog keeps release order and the affected matchups", () => {
    expect(MILESTONE_CATALOG.milestones.map(({ engine, matchups }) => [engine, matchups])).toEqual([
      ["1.6.10", ["PvT", "TvP"]],
      ["1.6.11", ["PvT", "TvP"]],
      ["1.6.12", ["PvP", "PvT", "PvZ", "TvP", "TvT", "TvZ", "ZvP", "ZvT", "ZvZ"]],
      ["1.6.13", ["PvP", "PvT", "PvZ", "TvP", "TvT", "TvZ", "ZvP", "ZvT", "ZvZ"]],
    ]);
    expect(MILESTONE_CATALOG.revision).toMatch(/^[0-9a-f]{16}$/);
  });
  test.each([
    [[]], [[row, row]], [[{ ...row, engine: "1.6" }]], [[{ ...row, date: "2026-02-30" }]], [[{ ...row, matchups: ["PvX"] }]],
    [[{ ...row, matchups: [] }]], [[{ ...row, summary: "" }]], [[{ ...row, extra: 1 }]], [{}],
  ])("rejects %j instead of silently loading nothing", (raw) => {
    expect(() => loadMilestoneCatalog(raw)).toThrow(/analysis_milestones_invalid/);
  });
});

describe("cohort counts", () => {
  test("count only the owner's live rows, affected matchups, strict versions and valid macro scores", async () => {
    await db.games.insertMany([
      game(1), game(2, { myRace: "Terran", opponent: { race: "protoss" } }), game(3, { engineVersion: "1.6.10" }),
      game(4, { engineVersion: "1.6.11-rc.1" }), game(5, { engineVersion: NEW }),
      game(6, { myRace: "Zerg", opponent: { race: "Zerg" } }), game(7, { myRace: "Random" }),
      game(8, { engineVersion: undefined }), game(9, { engineVersion: "01.6.9" }), game(10, { engineVersion: "1.6.9", ingestSource: "forged" }),
      game(11, { engineVersion: { value: "1.6.9" } }), game(12, { engineVersion: `1.0.0-${"x".repeat(40)}` }),
      game(13, { macroScore: 0 }), game(14, { macroScore: 100 }), game(15, { macroScore: null }), game(16, { macroScore: "50" }),
      game(17, { macroScore: Number.NaN }), game(18, { macroScore: 101 }), game(19, { macroScore: -1 }), game(20, { macroScore: undefined }),
      game(21, { excluded: true }), game(22, { _deleted: true }), game(23, { _deletionPending: true }), game(24, { isResumedFromReplay: true }),
      { ...game(25), userId: OTHER },
      game(26, { myRace: "Zerg", opponent: { race: "Zerg" }, engineVersion: "1.6.13" }),
    ]);
    const { cohorts, catalogRevision } = await countCohorts(db.games, OWNER);
    expect(catalogRevision).toBe(MILESTONE_CATALOG.revision);
    const byId = Object.fromEntries(cohorts.map((c) => [c.id, c]));
    // PvT/TvP rows below 1.6.10: 1, 2, 13-21 (11 rows); 3 and 4 are below 1.6.11 too.
    expect(byId["engine-before:1.6.10"]).toMatchObject({ count: 11, unknown: 5 });
    expect(byId["engine-before:1.6.11"]).toMatchObject({ count: 13, unknown: 5 });
    expect(byId["engine-before:1.6.11"].versions).toEqual(["1.6.10", "1.6.11-rc.1", "1.6.9"]);
    // 1.6.12 also covers the older ZvZ row. 1.6.13 includes the 1.6.12 PvT row too.
    expect(byId["engine-before:1.6.12"]).toMatchObject({
      count: 14,
      unknown: 5,
      versions: ["1.6.10", "1.6.11-rc.1", "1.6.9"],
    });
    expect(byId["engine-before:1.6.13"]).toMatchObject({
      count: 15,
      unknown: 5,
      versions: ["1.6.10", "1.6.11-rc.1", "1.6.12", "1.6.9"],
    });
    expect(byId["missing-macro"].count).toBe(6);
    expect(byId["no-engine-stamp"].count).toBe(5);
  });
  test("an owner without games sees zero counts, never another owner's rows", async () => {
    await db.games.insertMany([{ ...game(1), userId: OTHER }]);
    const { cohorts } = await countCohorts(db.games, OWNER);
    expect(cohorts.every((c) => c.count === 0)).toBe(true);
  });
});

/** Synthetic owner socket room with one agent device whose acknowledgement the test controls. */
function harness({ capable = true, devices, ack, userId = OWNER } = {}) {
  const emitted = [];
  const deliveries = [];
  const reply = ack || ((payload) => ({ jobId: payload.jobId, seq: payload.seq, generation: payload.generation, code: "accepted" }));
  const device = {
    id: "session-1", handshake: { auth: { deviceToken: "device-token" } },
    data: { kind: "device", userId, deviceId: DEVICE, reanalysisVersion: capable ? 1 : 0 },
    timeout: () => ({ emitWithAck: async (event, payload) => { deliveries.push({ event, payload }); return reply(payload); } }),
  };
  let sockets = devices ?? [device];
  const io = {
    in: () => ({ fetchSockets: async () => sockets }),
    to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }),
  };
  const notifications = { notify: jest.fn(async () => null) };
  const pairings = { findTokenByHash: jest.fn(async () => ({ userId, deviceId: DEVICE })) };
  let clock = Date.parse("2026-11-10T12:00:00Z");
  const service = new ReanalysisService({ db, io, pairings, notifications, now: () => clock, ackTimeoutMs: 50 });
  const idle = async () => { while (service.kicks.size) await Promise.all([...service.kicks.values()].map((entry) => entry.promise)); };
  return {
    service, io, emitted, deliveries, notifications, pairings, device, idle,
    setDevices: (next) => { sockets = next; },
    tick: (ms) => { clock += ms; },
  };
}

/** Simulate the agent's normal-queue upload landing on the stored row. */
async function landUpload(gameId, at = new Date("2026-11-10T12:00:30Z")) {
  await db.games.updateOne({ userId: OWNER, gameId }, { $set: { ingestSource: "agent", engineVersion: NEW, updatedAt: at } });
}

const outcomeEvent = (job, seq, gameId, outcome = "uploaded", extra = {}) => ({
  version: 1, jobId: job, seq, generation: 1, gameId, outcome, engineVersion: NEW, ...extra,
});
const deviceData = { kind: "device", userId: OWNER, deviceId: DEVICE };

// ---------------- paced jobs ----------------

test("without an agent the job waits; an old agent asks for an update; a capable connect resumes it", async () => {
  await db.games.insertMany([game(1)]);
  const offline = harness({ devices: [] });
  const { job } = await offline.service.start(OWNER, { cohortId: "engine-before:1.6.11" });
  expect(job).toMatchObject({ status: "waiting_for_agent", total: 1, processed: 0 });
  expect(offline.deliveries).toHaveLength(0);

  const old = harness({ capable: false });
  expect((await old.service.overview(OWNER)).agent).toBe("update_required");
  await old.idle();
  expect((await db.reanalysisJobs.findOne({ userId: OWNER })).status).toBe("update_required");

  const ready = harness();
  await ready.service.deviceReady(deviceData);
  await ready.idle();
  expect(ready.deliveries).toHaveLength(1);
  expect((await db.reanalysisJobs.findOne({ userId: OWNER })).status).toBe("running");
});

test("camera backfill admits older and unknown engines across matchups and excludes current analysis", async () => {
  await db.games.insertMany([
    game(1, { myRace: "Random" }),
    game(2, { engineVersion: "1.6.13-rc.1" }),
    game(3, { engineVersion: null }),
    game(4, { engineVersion: "1.6.13+build" }),
    game(5, { engineVersion: "1.6.14" }),
    game(6, { userId: OTHER }),
    game(7, { isResumedFromReplay: true }),
  ]);
  const h = harness();
  expect((await h.service.overview(OWNER)).cohorts).toContainEqual({ id: "add-camera-data", kind: "camera", count: 3 });
  const { job } = await h.service.start(OWNER, { cohortId: "add-camera-data" });
  expect(job).toMatchObject({ total: 3, cohortId: "add-camera-data" });
  await h.idle();
  expect(h.deliveries[0].payload.games.map(row => row.gameId)).toEqual(["g-0001", "g-0002", "g-0003"]);
});

test("the next batch waits for the acknowledgement and every outcome of the current one", async () => {
  await db.games.insertMany(Array.from({ length: 101 }, (_, index) => game(index)));
  const h = harness();
  const { job } = await h.service.start(OWNER, { cohortId: "engine-before:1.6.11" });
  await h.idle();
  expect(h.deliveries).toHaveLength(1);
  const first = h.deliveries[0].payload;
  expect(first.games).toHaveLength(100);
  expect(first).toMatchObject({ version: 1, jobId: job.id, seq: 1, generation: 1, deviceId: DEVICE, sessionId: "session-1" });
  for (const { gameId } of first.games.slice(0, 99)) {
    await landUpload(gameId);
    expect(await h.service.recordOutcome(deviceData, outcomeEvent(job.id, 1, gameId))).toBe(true);
  }
  await h.idle();
  expect(h.deliveries).toHaveLength(1);
  // A duplicate never counts twice.
  expect(await h.service.recordOutcome(deviceData, outcomeEvent(job.id, 1, first.games[0].gameId))).toBe(false);
  const last = first.games[99].gameId;
  await h.service.recordOutcome(deviceData, outcomeEvent(job.id, 1, last, "not_found", { engineVersion: null }));
  await h.idle();
  expect(h.deliveries).toHaveLength(2);
  expect(h.deliveries[1].payload).toMatchObject({ seq: 2, games: [{ gameId: "g-0100" }] });
  const stored = await db.reanalysisJobs.findOne({ userId: OWNER });
  expect(stored).toMatchObject({ processed: 100, updated: 99, unavailable: 1, failed: 0, cursor: first.games[99].gameId });
});

test("an unacknowledged batch counts nothing and is redelivered later, not failed", async () => {
  await db.games.insertMany([game(1), game(2)]);
  const h = harness({ ack: () => null });
  const { job } = await h.service.start(OWNER, { cohortId: "engine-before:1.6.11" });
  await h.idle();
  let stored = await db.reanalysisJobs.findOne({ userId: OWNER });
  expect(stored.batch).toMatchObject({ acked: false, stalls: 1 });
  for (let attempt = 0; attempt < 4; attempt += 1) { h.service._schedule(OWNER, "always"); await h.idle(); }
  stored = await db.reanalysisJobs.findOne({ userId: OWNER });
  expect(stored).toMatchObject({ processed: 0, failed: 0, status: "running" });
  expect(stored.batch.items.every((item) => item.outcome === null)).toBe(true);
  expect(job.status).toBe("running");
});

test("an uploaded claim without a matching stored upload counts as failed", async () => {
  await db.games.insertMany([game(1), game(2)]);
  const h = harness();
  const { job } = await h.service.start(OWNER, { cohortId: "engine-before:1.6.11" });
  await h.idle();
  await h.service.recordOutcome(deviceData, outcomeEvent(job.id, 1, "g-0001"));
  await db.games.updateOne({ userId: OWNER, gameId: "g-0002" }, { $set: { engineVersion: NEW, ingestSource: "browser", updatedAt: new Date("2026-11-10T12:00:30Z") } });
  await h.service.recordOutcome(deviceData, outcomeEvent(job.id, 1, "g-0002"));
  await h.idle();
  const stored = await db.reanalysisJobs.findOne({ userId: OWNER });
  expect(stored).toMatchObject({ processed: 2, updated: 0, failed: 2, status: "completed", active: false });
  expect(h.notifications.notify).toHaveBeenCalledTimes(1);
  expect(h.notifications.notify.mock.calls[0][1]).toMatchObject({ kind: "data.reanalysis", eventKey: `reanalysis:${job.id}` });
});

test("pause fences late acknowledgements, resume redelivers only open games, cancel ignores later outcomes", async () => {
  await db.games.insertMany([game(1), game(2), game(3)]);
  let release;
  const late = new Promise((resolve) => { release = resolve; });
  let first = true;
  const h = harness({ ack: async (payload) => {
    if (first) { first = false; await late; }
    return { jobId: payload.jobId, seq: payload.seq, generation: payload.generation, code: "accepted" };
  } });
  h.service.ackTimeoutMs = 2_000;
  const { job } = await h.service.start(OWNER, { cohortId: "engine-before:1.6.11" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const paused = await h.service.control(OWNER, "pause", { jobId: job.id });
  expect(paused.job.status).toBe("paused");
  expect(h.emitted).toContainEqual({ room: `user:${OWNER}`, event: "reanalyze:cancel", payload: { jobId: job.id, generation: 2 } });
  release();
  await h.idle();
  let stored = await db.reanalysisJobs.findOne({ userId: OWNER });
  expect(stored.batch.acked).toBe(false);
  await landUpload("g-0001");
  await h.service.recordOutcome(deviceData, outcomeEvent(job.id, 1, "g-0001"));
  expect((await h.service.control(OWNER, "pause", { jobId: job.id })).job.status).toBe("paused");
  await h.service.control(OWNER, "resume", { jobId: job.id });
  await h.idle();
  const redelivery = h.deliveries.at(-1).payload;
  expect(redelivery).toMatchObject({ seq: 1, generation: 3 });
  expect(redelivery.games.map((g) => g.gameId)).toEqual(["g-0002", "g-0003"]);
  stored = await db.reanalysisJobs.findOne({ userId: OWNER });
  expect(stored.batch).toMatchObject({ acked: true, ackedGeneration: 3 });
  const stale = outcomeEvent(job.id, 1, "g-0002", "parse_failed");
  expect(await h.service.recordOutcome(deviceData, stale)).toBe(false);
  expect(await h.service.recordOutcome({ ...deviceData, deviceId: "b".repeat(24) }, { ...stale, generation: 3 })).toBe(false);
  await h.service.control(OWNER, "cancel", { jobId: job.id });
  expect(await h.service.recordOutcome(deviceData, outcomeEvent(job.id, 1, "g-0002", "parse_failed"))).toBe(false);
  stored = await db.reanalysisJobs.findOne({ userId: OWNER });
  expect(stored).toMatchObject({ status: "cancelled", active: false, processed: 1 });
  expect((await h.service.control(OWNER, "cancel", { jobId: job.id })).job.status).toBe("cancelled");
  await expect(h.service.control(OWNER, "resume", { jobId: job.id })).rejects.toMatchObject({ status: 409 });
});

test("one active job per owner; other owners and their devices cannot touch it", async () => {
  await db.games.insertMany([game(1), { ...game(2), userId: OTHER }]);
  const h = harness();
  const { job } = await h.service.start(OWNER, { cohortId: "engine-before:1.6.11" });
  await expect(h.service.start(OWNER, { cohortId: "missing-macro" })).rejects.toMatchObject({ status: 409 });
  await expect(h.service.control(OTHER, "cancel", { jobId: job.id })).rejects.toMatchObject({ status: 404 });
  await h.idle();
  expect(await h.service.recordOutcome({ ...deviceData, userId: OTHER }, outcomeEvent(job.id, 1, "g-0001", "not_found"))).toBe(false);
  expect(await h.service.recordOutcome({ kind: "web", userId: OWNER }, outcomeEvent(job.id, 1, "g-0001", "not_found"))).toBe(false);
  // Only device sockets report outcomes, even if another socket carried a device-shaped id.
  expect(await h.service.recordOutcome({ kind: "overlay", userId: OWNER, deviceId: DEVICE }, outcomeEvent(job.id, 1, "g-0001", "not_found"))).toBe(false);
  expect((await db.reanalysisJobs.findOne({ userId: OWNER })).processed).toBe(0);
});

test("a running job records an agent that went offline and redelivers when it returns", async () => {
  await db.games.insertMany([game(1)]);
  const h = harness();
  await h.service.start(OWNER, { cohortId: "engine-before:1.6.11" });
  await h.idle();
  h.setDevices([]);
  expect((await h.service.overview(OWNER)).agent).toBe("offline");
  await h.idle();
  expect((await db.reanalysisJobs.findOne({ userId: OWNER })).status).toBe("waiting_for_agent");
  expect(h.deliveries).toHaveLength(1);
  h.setDevices([h.device]);
  await h.service.deviceReady(deviceData);
  await h.idle();
  expect((await db.reanalysisJobs.findOne({ userId: OWNER })).status).toBe("running");
  expect(h.deliveries).toHaveLength(2);
});

test("an API restart resumes the stored batch through a reconnecting agent", async () => {
  await db.games.insertMany([game(1), game(2)]);
  const before = harness();
  const { job } = await before.service.start(OWNER, { cohortId: "engine-before:1.6.11" });
  await before.idle();
  await landUpload("g-0001");
  const after = harness({ ack: (payload) => ({ jobId: payload.jobId, seq: payload.seq, generation: payload.generation, code: "accepted",
    outcomes: [{ gameId: "g-0001", outcome: "uploaded", engineVersion: NEW }, { gameId: "g-0002", outcome: "parse_failed" }] }) });
  await after.service.deviceReady(deviceData);
  await after.idle();
  expect(after.deliveries[0].payload).toMatchObject({ jobId: job.id, seq: 1 });
  const stored = await db.reanalysisJobs.findOne({ _id: (await db.reanalysisJobs.findOne({ userId: OWNER }))._id });
  expect(stored).toMatchObject({ status: "completed", processed: 2, updated: 1, failed: 1 });
});

test("an acknowledgement naming a game outside the delivery is refused", async () => {
  await db.games.insertMany([game(1)]);
  const h = harness({ ack: (payload) => ({ jobId: payload.jobId, seq: payload.seq, generation: payload.generation, code: "accepted",
    outcomes: [{ gameId: "g-9999", outcome: "not_found" }] }) });
  await h.service.start(OWNER, { cohortId: "engine-before:1.6.11" });
  await h.idle();
  expect(await db.reanalysisJobs.findOne({ userId: OWNER })).toMatchObject({ processed: 0, batch: { acked: false } });
});

test("wipes and restores retire the owner's jobs and stop the agent", async () => {
  await db.games.insertMany([game(1)]);
  const h = harness({ devices: [] });
  const { job } = await h.service.start(OWNER, { cohortId: "engine-before:1.6.11" });
  expect(await retireReanalysisJobs(db.reanalysisJobs, h.io, OWNER)).toBe(1);
  expect(await db.reanalysisJobs.countDocuments({ userId: OWNER })).toBe(0);
  expect(h.emitted.at(-1)).toEqual({ room: `user:${OWNER}`, event: "reanalyze:cancel", payload: { jobId: job.id, generation: 2 } });
  expect(GDPR_CLASSIFICATION.REANALYSIS_JOBS).toBe("purge_only");
  expect(PURGE_ONLY_COLLECTIONS).toContainEqual(["reanalysisJobs", "userId"]);
});

describe("routes", () => {
  function app(source = "clerk") {
    const h = harness({ devices: [] });
    const server = express();
    server.use(express.json());
    server.use("/v1/me/reanalysis", buildReanalysisRouter({ reanalysis: h.service, auth: (req, _res, next) => { req.auth = { userId: OWNER, source }; next(); } }));
    server.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: { code: err.code } }));
    return server;
  }
  test("owner sessions read private, uncached counts; devices and query strings are refused", async () => {
    await db.games.insertMany([game(1)]);
    const ok = await request(app()).get("/v1/me/reanalysis");
    expect(ok.status).toBe(200);
    expect(ok.headers["cache-control"]).toBe("private, no-store");
    expect(ok.body).toMatchObject({ agent: "offline", job: null });
    expect(ok.body.cohorts.find((c) => c.id === "engine-before:1.6.10")).toMatchObject({ count: 1, unknown: 0, summary: expect.any(String) });
    expect(ok.body.cohorts.some((c) => "versions" in c)).toBe(false);
    expect((await request(app("device")).get("/v1/me/reanalysis")).status).toBe(403);
    expect((await request(app()).get("/v1/me/reanalysis?userId=u_other")).status).toBe(400);
  });
  test("start validates the cohort before creating anything", async () => {
    await db.games.insertMany([game(1)]);
    for (const body of [{}, { cohortId: "engine-before:9.9.9" }, { cohortId: "missing-macro", userId: OTHER }, { cohortId: { $ne: "" } }]) {
      expect((await request(app()).post("/v1/me/reanalysis").send(body)).status).toBe(400);
    }
    expect((await request(app()).post("/v1/me/reanalysis").send({ cohortId: "missing-macro" })).status).toBe(409);
    expect(await db.reanalysisJobs.countDocuments({})).toBe(0);
    const created = await request(app()).post("/v1/me/reanalysis").send({ cohortId: "engine-before:1.6.10" });
    expect(created.status).toBe(201);
    expect(created.body.job).toMatchObject({ status: "waiting_for_agent", total: 1 });
    expect((await request(app()).post("/v1/me/reanalysis/pause").send({ jobId: "nope" })).status).toBe(400);
  });
});

describe("device socket wiring", () => {
  function socketFixture(auth, identity = { userId: OWNER, deviceId: DEVICE }) {
    let middleware, connection;
    const hooks = { deviceReady: jest.fn(), recordOutcome: jest.fn() };
    const io = { use: (fn) => { middleware = fn; }, on: (_event, fn) => { connection = fn; } };
    attachSocketAuth(io, { secretKey: "synthetic", resolveDeviceToken: async () => identity, reanalysis: hooks });
    const handlers = {};
    const socket = { id: "sid", handshake: { auth }, data: {}, join: jest.fn(), emit: jest.fn(), on: (event, fn) => { handlers[event] = fn; } };
    const connect = async () => { await new Promise((resolve, reject) => middleware(socket, (err) => (err ? reject(err) : resolve()))); connection(socket); await Promise.resolve(); await Promise.resolve(); };
    return { hooks, handlers, socket, connect };
  }
  test.each([[1, 1], [2, 0], [true, 0], [undefined, 0]])("reanalysisVersion %j advertises %j only for a canonical device", async (value, expected) => {
    const f = socketFixture({ deviceToken: "synthetic-device", reanalysisVersion: value });
    await f.connect();
    expect(f.socket.data.reanalysisVersion).toBe(expected);
    expect(f.hooks.deviceReady).toHaveBeenCalledWith(f.socket.data);
    f.handlers["reanalyze:outcome"]({ any: "payload" });
    await Promise.resolve(); await Promise.resolve();
    expect(f.hooks.recordOutcome).toHaveBeenCalledWith(f.socket.data, { any: "payload" });
  });
  test("a legacy device without a stable id cannot advertise re-analysis", async () => {
    const f = socketFixture({ deviceToken: "synthetic-device", reanalysisVersion: 1 }, { userId: OWNER });
    await f.connect();
    expect(f.socket.data.reanalysisVersion).toBe(0);
  });
});
