// @ts-nocheck
"use strict";
const request = require("supertest");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const pino = require("pino");
const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { createBackupStore } = require("./helpers/userBackupsStore");
const { AdminActivationService } = require("../src/services/adminActivation");
const { JobLedger } = require("../src/util/jobLedger");
const { AdminRolesService } = require("../src/services/adminRoles");
const { buildLeaguePercentilesRecomputeJob } = require("../src/jobs/leaguePercentilesRecomputeJob");
jest.mock("@clerk/backend", () => ({ verifyToken: jest.fn(async (token) => ({ sub: token === "admin-token" ? "admin-clerk" : "normal-clerk" })) }));
let mongo, db, app, services, adminId;
const admin = (call) => call.set("authorization", "Bearer admin-token");
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); db = await connect({ uri: mongo.getUri(), dbName: "ops_console" });
  const built = buildApp({ db, userBackupsStore:createBackupStore(), clerkClient:{getEmail:async()=>null,deleteUser:async()=>{}}, logger: pino({ level: "silent" }), config: { nodeEnv: "test", serverPepper: Buffer.alloc(32, 5), clerkSecretKey: "sk_test", agentReleaseAdminToken: "release-admin", adminUserIds: ["admin-clerk"], rateLimitPerMinute: 5000, corsAllowedOrigins: [], gameDetailsStore: "mongo", r2: null, pythonExe: null, pythonAnalyzerDir: "/none" } });
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
  await expect(ledger.runNow("league-percentiles")).rejects.toMatchObject({status:503,code:"job_failed"}); expect(await db.jobRuns.findOne({ job: "league-percentiles" })).toMatchObject({ status: "error", errorCode: "job_failed" });
  await ledger.instrumentJob("disabled", 100, async () => { throw new Error("must not run"); }, { disabled: true })();
  await ledger.instrumentJob("locked", 100, async () => ({ ranAsLeader: false }))(); expect(await db.jobRuns.findOne({ job: "locked" })).toMatchObject({ status: "lock_held" });
  now += 301; await ledger.checkOverdue();
  expect(events.record).toHaveBeenCalledWith("job_overdue", { job: "locked", intervalMs: 100 }, expect.objectContaining({ ingestionKey: expect.stringContaining("job-overdue:locked:") }));
  expect(events.record.mock.calls.some(([, payload]) => payload.job === "disabled")).toBe(false);
});

test("unknown repair IDs return404; a known-user wipe is audited with exact deletion counters", async () => {
  for (const action of ["wipe-games", "rebuild-opponents"]) { const response = await admin(request(app).post(`/v1/admin/users/never-existed/${action}`)); expect(response.status).toBe(404); expect(response.body.error.code).toBe("user_not_found"); }
  await db.users.insertOne({userId:"legacy",clerkUserId:"legacy-clerk",createdAt:new Date()});
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

test("a changed confirmed game count refuses a wipe before touching history", async () => {
  await db.users.insertOne({userId:"changed-count",clerkUserId:"changed-count-clerk",createdAt:new Date()});
  await db.games.insertOne({userId:"changed-count",gameId:"game",date:new Date()});
  const response=await admin(request(app).post("/v1/admin/users/changed-count/wipe-games").send({expectedGames:0}));
  expect(response.status).toBe(409);expect(response.body.error.code).toBe("game_count_changed");
  expect(await db.games.countDocuments({userId:"changed-count"})).toBe(1);
  expect((await db.users.findOne({userId:"changed-count"}))._gdprMutation).toBeUndefined();
});

test("audit leases exclude erasure; erasure anonymizes retained/exported rows and late writes cannot restore identity", async () => {
  const target="audit-erasure";await db.users.insertOne({userId:target,clerkUserId:"audit-erasure-clerk",createdAt:new Date()});
  await services.adminAudit.audit({auth:{userId:adminId}},"user.wipe-games",target,{games:0});
  const exported=await services.gdpr.export(target);expect(exported.data.adminAudit).toEqual([expect.objectContaining({target,actorUserId:null})]);
  expect((await services.gdpr.inventory(target)).anonymized.auditRows).toBe(1);
  let entered,release;const enteredPromise=new Promise(resolve=>{entered=resolve;}),hold=new Promise(resolve=>{release=resolve;});
  const insert=db.adminAudit.insertOne.bind(db.adminAudit);
  const spy=jest.spyOn(db.adminAudit,"insertOne").mockImplementation(async row=>{if(row.target===target){entered();await hold;}return insert(row);});
  const pending=services.adminAudit.audit({auth:{userId:adminId}},"user.wipe-games",target,{games:0});await enteredPromise;
  const deletion=services.gdpr.deleteAll(target);
  try { await new Promise(resolve=>setTimeout(resolve,75));expect(await db.users.countDocuments({userId:target})).toBe(1); }
  finally { release();await pending;spy.mockRestore(); }
  await deletion;expect(await db.adminAudit.countDocuments({target})).toBe(0);
  await services.adminAudit.audit({auth:{userId:target}},"user.wipe-games",target,{games:0});
  expect(await db.adminAudit.countDocuments({$or:[{actorUserId:target},{target}]})).toBe(0);
});

test("activation uses actual ingest dates, UTC cohorts, medians, historical week-two activity and a coalesced1h cache", async () => {
  const users=db.db.collection("cohort_users"),games=db.db.collection("cohort_games"),deviceTokens=db.db.collection("cohort_devices");
  const start=new Date("2026-10-05T00:00:00Z"),hour=3600000;
  await users.insertMany(["a","b"].map(userId=>({userId,createdAt:start,activation:userId==="a"?{downloadedAt:start}:{}})));
  await games.insertMany([{userId:"a",createdAt:new Date(+start+2*hour)},{userId:"a",createdAt:new Date(+start+8*24*hour)},{userId:"a",createdAt:new Date(+start+18*24*hour)},{userId:"b",createdAt:new Date(+start+6*hour)}]);
  await deviceTokens.insertMany([{userId:"a",createdAt:new Date(+start+hour)},{userId:"b",createdAt:new Date(+start+3*hour)}]);
  let now=+new Date("2026-10-26T12:00:00Z");const service=new AdminActivationService({db:{users,games,deviceTokens},now:()=>now});
  const read=jest.spyOn(users,"find");const first=service.snapshot(8),second=service.snapshot(8);expect(first).toBe(second);
  const result=await first,row=result.cohorts.find(c=>c.week==="2026-10-05");
  expect(row).toMatchObject({signups:2,downloaded:1,paired:2,firstGame:2,tenGames:0,week2Return:1,week2Eligible:2,medianHoursToPair:2,medianHoursToFirstGame:4});
  expect(read).toHaveBeenCalledTimes(1);now+=3600001;await service.snapshot(8);expect(read).toHaveBeenCalledTimes(2);read.mockRestore();
});

test("new job history is a capped5000-document collection and audit has400-day TTL", async () => {
  const meta=await db.db.listCollections({name:"job_runs"}).next();expect(meta.options).toMatchObject({capped:true,max:5000});
  expect((await db.adminAudit.listIndexes().toArray()).some(i=>i.expireAfterSeconds===400*86400)).toBe(true);
});

test("audit compound cursors traverse actions sharing one millisecond", async () => {
  const createdAt=new Date("2026-10-01T12:00:00Z");
  await db.adminAudit.insertMany(["a","b","c"].map(auditId=>({auditId:`cursor-${auditId}`,createdAt,action:"cursor-test",result:{}})));
  const ids=[];let before;
  do { const page=await services.adminAudit.list({action:"cursor-test",limit:1,before});ids.push(...page.items.map(row=>row.auditId));before=page.nextBefore; } while(before);
  expect(ids).toEqual(["cursor-c","cursor-b","cursor-a"]);
});

test("activation caps at2000 signups, labels truncation, and never reads beyond its bounded cohort", async () => {
  const users=db.db.collection("cap_users"),games=db.db.collection("cap_games"),deviceTokens=db.db.collection("cap_devices");
  await users.insertMany(Array.from({length:2001},(_,i)=>({userId:`cap-${i}`,createdAt:new Date("2026-10-20T00:00:00Z")})));
  const service=new AdminActivationService({db:{users,games,deviceTokens},now:()=>+new Date("2026-10-23T12:00:00Z")});
  const result=await service.snapshot(8);expect(result.truncated).toBe(true);expect(result.cohortCap).toBe(2000);expect(result.cohorts.reduce((n,row)=>n+row.signups,0)).toBe(2000);expect(result.stalled).toHaveLength(50);
});

test("manual job failure is an HTTP error with history intact; unknown jobs and nonadmins fail closed",async()=>{
  services.jobLedger.instrumentJob("fails",60000,async()=>{throw new Error("private-provider-response");});
  const response=await admin(request(app).post("/v1/admin/jobs/fails/run"));expect(response.status).toBe(503);expect(response.body.error.code).toBe("job_failed");expect(JSON.stringify(response.body)).not.toContain("private-provider-response");
  expect(await db.jobRuns.findOne({job:"fails"})).toMatchObject({status:"error",errorCode:"job_failed"});
  expect((await admin(request(app).post("/v1/admin/jobs/not-a-job/run"))).status).toBe(404);
  expect((await request(app).post("/v1/admin/jobs/fails/run").set("authorization","Bearer normal-token")).status).toBe(403);
});

test("admin rebuild excludes concurrent owner writes until its pre-snapshot and counters finish",async()=>{
  const user=(await request(app).get("/v1/me").set("authorization","Bearer normal-token")).body.userId;
  let entered,release;const began=new Promise(resolve=>{entered=resolve;}),hold=new Promise(resolve=>{release=resolve;});
  const original=services.gdpr.rebuildOpponentsAndHealForUser.bind(services.gdpr);
  const spy=jest.spyOn(services.gdpr,"rebuildOpponentsAndHealForUser").mockImplementationOnce(async(...args)=>{entered();await hold;return original(...args);});
  const rebuilding=admin(request(app).post(`/v1/admin/users/${user}/rebuild-opponents`)).then(response=>response);await began;
  try {
    expect((await db.users.findOne({userId:user}))._gdprMutation.kind).toBe("admin_rebuild_opponents");
    expect((await request(app).put("/v1/me/preferences/misc").set("authorization","Bearer normal-token").send({timezone:"UTC"})).status).toBe(409);
  }finally{release();spy.mockRestore();}
  const result=await rebuilding;expect(result.status).toBe(202);expect(result.body).toMatchObject({userId:user,games:0,opponents:0,macroJobs:0});expect((await db.users.findOne({userId:user}))._gdprMutation).toBeUndefined();
});

test("service-credential release publishing is audited without retaining its token or artifact URL",async()=>{
  const response=await request(app).post("/v1/agent/releases").set("x-admin-token","release-admin").send({channel:"stable",version:"9.9.9",releaseNotes:"fixture",artifacts:[{platform:"windows",downloadUrl:"https://example.test/private-fixture.exe",sha256:"a".repeat(64),sizeBytes:12}]});
  expect(response.status).toBe(201);const row=await db.adminAudit.findOne({action:"agent.release.publish"});expect(row).toMatchObject({actorUserId:null,actorKind:"service",target:"stable:9.9.9",result:{status:201,ok:true}});expect(JSON.stringify(row)).not.toMatch(/release-admin|example.test/);
});

test("unmatched authenticated admin mutations never retain private path fragments",async()=>{
  const secretUser="private-unmatched-user",secretToken="private-unmatched-token";
  const response=await admin(request(app).post(`/v1/admin/users/${secretUser}/unknown/${secretToken}`));
  expect(response.status).toBe(404);
  const row=await waitAudit("POST unmatched-admin-mutation",null);
  expect(row).toMatchObject({actorUserId:adminId,result:{status:404,ok:false}});
  expect(JSON.stringify(await db.adminAudit.find({}).toArray())).not.toMatch(/private-unmatched-user|private-unmatched-token/);
});

test("a completed wipe is audited even if its HTTP client disconnects before receiving success",async()=>{
  const userId="disconnected-wipe";await db.users.insertOne({userId,clerkUserId:"disconnected-clerk",createdAt:new Date()});await db.games.insertOne({userId,gameId:"disconnected-game",date:new Date()});
  let entered,release;const began=new Promise(resolve=>{entered=resolve;}),hold=new Promise(resolve=>{release=resolve;});
  const original=services.gdpr.wipeGames.bind(services.gdpr);
  const spy=jest.spyOn(services.gdpr,"wipeGames").mockImplementationOnce(async(...args)=>{entered();await hold;return original(...args);});
  const server=require("http").createServer(app);await new Promise(resolve=>server.listen(0,resolve));
  const pending=admin(request(server).post(`/v1/admin/users/${userId}/wipe-games`));void pending.then(()=>null,()=>null);await began;pending.abort();release();
  try{expect(await waitAudit("user.wipe-games",userId)).toMatchObject({result:{games:1,status:202,ok:true}});expect(await db.games.countDocuments({userId})).toBe(0);}finally{spy.mockRestore();await new Promise(resolve=>server.close(resolve));}
});


test("pending-only admin detail separates live history from authoritative wipe confirmation", async () => {
  const userId = "pending-only-admin-preview";
  await db.users.insertOne({ userId, clerkUserId: "pending-only-clerk", createdAt: new Date() });
  await db.games.insertMany([{ userId, gameId: "pending-record", _deletionPending: true }, { userId, gameId: "deleted-marker", _deleted: true }]);
  const detail = await admin(request(app).get(`/v1/admin/users/${userId}`));
  expect(detail.status).toBe(200); expect(detail.body.games.total).toBe(0); expect(detail.body.recentGames).toEqual([]); expect(detail.body.wipeGameCount).toBe(1);
  const wiped = await admin(request(app).post(`/v1/admin/users/${userId}/wipe-games`).send({ expectedGames: detail.body.wipeGameCount }));
  expect(wiped.status).toBe(202); expect(await services.gdpr.countGamesForWipe(userId)).toBe(0);
});
