// @ts-nocheck
"use strict";
const request = require("supertest");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const pino = require("pino");
const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { JobLedger } = require("../src/util/jobLedger");
const { AdminRolesService } = require("../src/services/adminRoles");
const { buildLeaguePercentilesRecomputeJob } = require("../src/jobs/leaguePercentilesRecomputeJob");
jest.mock("@clerk/backend", () => ({ verifyToken: jest.fn(async (token) => ({ sub: token === "admin-token" ? "admin-clerk" : "normal-clerk" })) }));
let mongo, db, app, services, adminId;
const admin = (call) => call.set("authorization", "Bearer admin-token");
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); db = await connect({ uri: mongo.getUri(), dbName: "ops_console" });
  const built = buildApp({ db, logger: pino({ level: "silent" }), config: { nodeEnv: "test", serverPepper: Buffer.alloc(32, 5), clerkSecretKey: "sk_test", adminUserIds: ["admin-clerk"], rateLimitPerMinute: 5000, corsAllowedOrigins: [], gameDetailsStore: "mongo", r2: null, pythonExe: null, pythonAnalyzerDir: "/none" } });
  app = built.app; services = built.services; adminId = (await admin(request(app).get("/v1/me"))).body.userId;
});
afterAll(async () => { await db?.close(); await mongo?.stop(); });
async function waitAudit(action, target) {
  for (let i = 0; i < 30; i++) { const row = await db.adminAudit.findOne({ action, target }); if (row) return row; await new Promise(r => setTimeout(r, 10)); }
  throw new Error("audit not recorded");
}

test("ledger coalesces manual/scheduled work, bounds summaries, and never throws storage failures into work", async () => {
  let release, calls = 0; const task = new Promise(r => { release = r; });
  const run = services.jobLedger.instrumentJob("coalesced", 60000, async () => { calls++; await task; return { scanned: 4, token: "private", userId: "private" }; });
  const first = run(), second = services.jobLedger.runNow("coalesced"); expect(calls).toBe(1); release(); await Promise.all([first, second]);
  const rows = await db.jobRuns.find({ job: "coalesced" }).toArray(); expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ status: "ok", summary: { scanned: 4 } }); expect(JSON.stringify(rows)).not.toContain("private");
  const broken = new JobLedger({ db: { jobRuns: { insertOne: async () => { throw new Error("offline"); } } } });
  await expect(broken.instrumentJob("work", 10, async () => 42)()).resolves.toBe(42);
  await expect(broken.instrumentJob("throws", 10, async () => { throw Object.assign(new Error("secret-url"), { code: "provider_down" }); })()).rejects.toMatchObject({ code: "provider_down" });
});

test("caught worker failures, disabled runs, leader locks and overdue alerts retain their real meanings", async () => {
  let now = Date.now(); const events = { record: jest.fn(async () => null) }, ledger = new JobLedger({ db, adminEvents: events, now: () => now });
  buildLeaguePercentilesRecomputeJob({ jobLedger: ledger, leaguePercentiles: { recompute: async () => { throw new Error("secret-user-id"); } }, logger: pino({ level: "silent" }), runOnStart: false });
  await ledger.runNow("league-percentiles"); expect(await db.jobRuns.findOne({ job: "league-percentiles" })).toMatchObject({ status: "error", errorCode: "job_failed" });
  await ledger.instrumentJob("disabled", 100, async () => { throw new Error("must not run"); }, { disabled: true })();
  await ledger.instrumentJob("locked", 100, async () => ({ ranAsLeader: false }))(); expect(await db.jobRuns.findOne({ job: "locked" })).toMatchObject({ status: "lock_held" });
  now += 301; await ledger.checkOverdue();
  expect(events.record).toHaveBeenCalledWith("job_overdue", { job: "locked", intervalMs: 100 }, expect.objectContaining({ ingestionKey: expect.stringContaining("job-overdue:locked:") }));
  expect(events.record.mock.calls.some(([, payload]) => payload.job === "disabled")).toBe(false);
});

test("unknown repair IDs return404; a known-user wipe is audited with exact deletion counters", async () => {
  for (const action of ["wipe-games", "rebuild-opponents"]) { const response = await admin(request(app).post(`/v1/admin/users/never-existed/${action}`)); expect(response.status).toBe(404); expect(response.body.error.code).toBe("user_not_found"); }
  await db.users.insertOne({userId:"legacy",createdAt:new Date()});
  await db.games.insertOne({ userId: "legacy", gameId: "old-game", date: new Date(), result: "Victory" }); await db.macroJobs.insertOne({ userId: "legacy", jobId: "old-macro" });
  const wiped = await admin(request(app).post("/v1/admin/users/legacy/wipe-games")); expect(wiped.status).toBe(202); expect(wiped.body).toMatchObject({ games: 1, macroJobs: 1 });
  expect(await waitAudit("user.wipe-games", "legacy")).toMatchObject({ actorUserId: adminId, result: { games: 1, macroJobs: 1, status: 202, ok: true } });
  expect((await admin(request(app).get("/v1/admin/audit?target=legacy"))).body.items).toHaveLength(1);
  expect((await request(app).get("/v1/admin/audit").set("authorization", "Bearer normal-token")).status).toBe(403);
});

test("support snapshot reuses doctor and omits device credentials and import payloads", async () => {
  await db.users.insertOne({ userId: "support", clerkUserId:"support-clerk", createdAt: new Date() });
  await db.deviceTokens.insertOne({ userId: "support", tokenHash: "secret-hash", hostname: "Desk", agentVersion: "0.20.0", agentOs: "windows", lastSeenAt: new Date(), revokedAt: null });
  await db.importJobs.insertOne({ userId: "support", jobId: "job", status: "done", completed: 3, failed: 1, createdAt: new Date(), error: "secret-replay-path" });
  const response = await admin(request(app).get("/v1/admin/users/support/support")); expect(response.status).toBe(200); expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.body.devices[0]).toMatchObject({ hostname: "Desk", version: "0.20.0", os: "windows", online: true }); expect(response.body.imports[0]).toMatchObject({ completed: 3, failed: 1 });
  expect(response.body.doctor.warnings.some(w => w.id === "no_games")).toBe(true); expect(JSON.stringify(response.body)).not.toMatch(/secret-hash|secret-replay-path|tokenHash/);
});

test("revoke blocks self/last/configured admins and serializes concurrent removals", async () => {
  // Use a separate users collection so the HTTP harness's configured admin does not affect this invariant.
  const users = db.db.collection("role_fixtures"), roles = new AdminRolesService({ db: { ...db, users } });
  await users.insertOne({ userId: "only", clerkUserId: "only-clerk", role: "admin" });
  await expect(roles.revoke("only", "only")).rejects.toMatchObject({ code: "cannot_revoke_self" }); await expect(roles.revoke("only", "external")).rejects.toMatchObject({ code: "cannot_revoke_last_admin" });
  await users.insertOne({ userId: "second", clerkUserId: "second-clerk", role: "admin" });
  const results = await Promise.allSettled([roles.revoke("only", "external"), roles.revoke("second", "external")]); expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(await users.countDocuments({ role: "admin" })).toBe(1);
  const live = await users.findOne({ role: "admin" }); await expect(new AdminRolesService({ db: { ...db, users }, protectedIds: [live.clerkUserId] }).revoke(live.userId, "external")).rejects.toMatchObject({ code: "configured_admin_protected" });
});

test("authenticated download and week-two visit are idempotent and preserve future activation fields", async () => {
  const user = (await request(app).get("/v1/me").set("authorization", "Bearer normal-token")).body.userId;
  await db.users.updateOne({ userId: user }, { $set: { createdAt: new Date(Date.now() - 9 * 86400000), activation: { other: "kept" } } });
  expect((await request(app).post("/v1/me/activation/download").set("authorization", "Bearer normal-token")).status).toBe(204); const first = (await db.users.findOne({ userId: user })).activation.downloadedAt;
  await request(app).post("/v1/me/activation/download").set("authorization", "Bearer normal-token"); await services.users.touch(user);
  const row = await db.users.findOne({ userId: user }); expect(row.activation.downloadedAt).toEqual(first); expect(row.activation.week2ReturnAt).toBeInstanceOf(Date); expect(row.activation.other).toBe("kept");
});
