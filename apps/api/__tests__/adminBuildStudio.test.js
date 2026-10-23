"use strict";
const request = require("supertest");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { pino } = require("pino");
const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { createBackupStore } = require("./helpers/userBackupsStore");
const { catalog, applyPolicy } = require("../src/services/presetPolicy");
const shared = require("../../replay-engine/tests/fixtures/preset_policy.json");
jest.mock("@clerk/backend", () => ({ verifyToken: jest.fn(async (token) => ({ sub: token === "admin-token" ? "admin-clerk" : "normal-clerk" })) }));
/** @type {any} */ let mongo;
/** @type {any} */ let db;
/** @type {any} */ let app;
/** @type {any} */ let services;
/** @param {any} call */ const admin = (call) => call.set("authorization", "Bearer admin-token");
const root = "/v1/admin/build-studio";
const owner = "studio-owner";
const original = { name: "Private rule-only opening", race: "Protoss", vsRace: "Zerg", schemaVersion: 3, perspective: "you", rules: [{ type: "count_min", name: "BuildGateway", time_lt: 200, count: 1 }], steps: [] };
const replacement = shared.cases[0].policy.entries[0];
/** @type {string} */ let privateId;
/** @type {string} */ let publicId;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  db = await connect({ uri: mongo.getUri(), dbName: "admin_build_studio" });
  const built = buildApp({ db, userBackupsStore: createBackupStore(), clerkClient: { getEmail: async () => null, deleteUser: async () => {} }, logger: pino({ level: "silent" }), config: /** @type {any} */ ({ nodeEnv: "test", serverPepper: Buffer.alloc(32, 5), clerkSecretKey: "sk_test", agentReleaseAdminToken: "release-admin", adminUserIds: ["admin-clerk"], rateLimitPerMinute: 5000, corsAllowedOrigins: [], gameDetailsStore: "mongo", r2: null, pythonExe: null, pythonAnalyzerDir: "/none" }) });
  app = built.app; services = built.services;
  await admin(request(app).get("/v1/me"));
  await db.users.insertOne({ userId: owner, clerkUserId: "studio-owner-clerk", createdAt: new Date() });
  privateId = String((await db.customBuilds.insertOne({ userId: owner, slug: "private-opening", ...original, notes: "NEVER-PUBLISH-PRIVATE-NOTES", sourceGameId: "PRIVATE-REPLAY", unknown: "x".repeat(250000) })).insertedId);
  publicId = String((await db.communityBuilds.insertOne({ ownerUserId: owner, sourceSlug: "private-opening", slug: "public-opening", title: "Public opening", description: "Public listing", build: original, publicationSequence: 1, publicationRevision: "initial-publication", votes: 7, upvotes: ["voter"], downvotes: [], removed: false })).insertedId);
});
afterAll(async () => { await db?.close(); await mongo?.stop(); });

test("admin gate protects all catalog/edit routes; anonymous policy read is global/compatible/conditional", async () => {
  expect((await request(app).get(root)).status).toBe(401);
  expect((await request(app).get(root).set("authorization", "Bearer normal-token")).status).toBe(403);
  expect((await request(app).put(`${root}/custom/${privateId}`).set("authorization", "Bearer normal-token").send({ expectedRevision: 0, build: original })).status).toBe(403);
  expect((await request(app).get("/v1/build-policy")).status).toBe(426);
  const policy = await request(app).get("/v1/build-policy?evaluator=1");
  expect(policy.status).toBe(200); expect(policy.body.entries).toEqual([]);
  expect(policy.headers["cache-control"]).toContain("public");
  expect((await request(app).get("/v1/build-policy?evaluator=1").set("if-none-match", policy.headers.etag)).status).toBe(304);
  expect(JSON.stringify(policy.body)).not.toMatch(/userId|ownerUserId|PRIVATE|clerk/);
});

test("keyset catalog reaches every released preset and every private definition across owners", async () => {
  const names = []; let after = "";
  do {
    const page = await admin(request(app).get(`${root}?scope=preset${after ? `&after=${encodeURIComponent(after)}` : ""}`));
    expect(page.status).toBe(200); expect(page.headers["cache-control"]).toBe("private, no-store");
    names.push(...page.body.items.map((/** @type {any} */ item) => item.name)); after = page.body.nextAfter;
  } while (after);
  expect(names).toEqual(catalog.definitions.map((entry) => entry.name));
  await db.customBuilds.insertMany(Array.from({ length: 62 }, (_, index) => ({ ...original, slug: `page-${index}`, userId: index % 2 ? "other-owner" : owner })));
  const first = await admin(request(app).get(`${root}?scope=custom`));
  const second = await admin(request(app).get(`${root}?scope=custom&after=${first.body.nextAfter}`));
  expect(first.body.items).toHaveLength(50); expect(second.body.items).toHaveLength(13); expect(second.body.nextAfter).toBeNull();
  const rows = [...first.body.items, ...second.body.items];
  expect(new Set(rows.map((item) => item.id)).size).toBe(63);
  expect(rows.some((item) => item.owner === "other-owner")).toBe(true);
  expect(rows.every((item) => item.mode === "rule-only")).toBe(true);
  expect(JSON.stringify(rows)).not.toMatch(/NEVER-PUBLISH|PRIVATE-REPLAY|unknown/);
  const detail = await admin(request(app).get(`${root}/custom/${privateId}`));
  expect(detail.body.build).toMatchObject(original); expect(detail.body.owner).toBe(owner);
  expect(JSON.stringify(detail.body).length).toBeLessThan(5000);
});

test("private edits CAS against ordinary owner saves, retain bounded safe history, and never change private/source fields", async () => {
  await services.customBuilds.upsert(owner, { slug: "private-opening", ...original, description: "Owner saved this first" });
  const stale = await admin(request(app).put(`${root}/custom/${privateId}`).send({ expectedRevision: 0, build: original }));
  expect(stale.status).toBe(409); expect(stale.body.error.code).toBe("build_definition_changed");
  const edit = { ...original, description: "Admin correction", steps: [{ time: "1:30", supply: 20, action: "Gateway" }] };
  const saved = await admin(request(app).put(`${root}/custom/${privateId}`).send({ expectedRevision: 1, build: edit }));
  expect(saved.status).toBe(200); expect(saved.body.revision).toBe(2); expect(saved.body.mode).toBe("steps");
  expect(saved.body.history).toEqual([expect.objectContaining({ revision: 1, build: expect.objectContaining({ description: "Owner saved this first" }) })]);
  const row = await db.customBuilds.findOne({ userId: owner, slug: "private-opening" });
  expect(row.notes).toBe("NEVER-PUBLISH-PRIVATE-NOTES"); expect(row.sourceGameId).toBe("PRIVATE-REPLAY");
  expect(JSON.stringify(row._definitionHistory)).not.toMatch(/NEVER-PUBLISH|PRIVATE-REPLAY|unknown|actor|clerk/);
  expect((await admin(request(app).put(`${root}/custom/${privateId}`).send({ expectedRevision: 2, build: { ...edit, userId: "someone-else" } }))).status).toBe(400);
  const reverted = await admin(request(app).post(`${root}/custom/${privateId}/revert`).send({ expectedRevision: 2, revision: 1 }));
  expect(reverted.status).toBe(200); expect(reverted.body.revision).toBe(3); expect(reverted.body.build.description).toBe("Owner saved this first");
  expect(reverted.body.history).toHaveLength(2);
});

test("community snapshot editing preserves private source, removal state and concurrent votes; stale publications fail", async () => {
  const beforePrivate = await db.customBuilds.findOne({ userId: owner, slug: "private-opening" });
  await db.communityBuilds.updateOne({ slug: "public-opening" }, { $set: { removed: true }, $inc: { votes: 1 } });
  const build = { ...original, description: "Corrected public rules", rules: [{ type: "count_min", name: "BuildGateway", time_lt: 180, count: 2 }] };
  const saved = await admin(request(app).put(`${root}/community/${publicId}`).send({ expectedRevision: 1, build }));
  expect(saved.status).toBe(200); expect(saved.body.revision).toBe(2); expect(saved.body.removed).toBe(true);
  const row = await db.communityBuilds.findOne({ slug: "public-opening" });
  expect(row.votes).toBe(8); expect(row.upvotes).toEqual(["voter"]); expect(row.ownerUserId).toBe(owner); expect(row.sourceSlug).toBe("private-opening");
  expect(await db.customBuilds.findOne({ userId: owner, slug: "private-opening" })).toEqual(beforePrivate);
  expect((await admin(request(app).put(`${root}/community/${publicId}`).send({ expectedRevision: 1, build }))).status).toBe(409);
});

test("expired erasure locks remain authoritative; held owner edit excludes exclusive erasure until completion", async () => {
  const lock = { id: "interrupted-erasure", leaseUntil: new Date(0) };
  await db.users.updateOne({ userId: owner }, { $set: { _gdprMutation: lock } });
  const blocked = await admin(request(app).put(`${root}/custom/${privateId}`).send({ expectedRevision: 3, build: original }));
  expect(blocked.status).toBe(409); expect(blocked.body.error.code).toBe("gdpr_operation_busy");
  expect((await db.users.findOne({ userId: owner }))._gdprMutation).toEqual(lock);
  // Test fixture cleanup only; never done by the Studio implementation.
  await db.users.updateOne({ userId: owner }, { $unset: { _gdprMutation: "" } });
  /** @type {()=>void} */ let entered = () => {}; /** @type {()=>void} */ let release = () => {};
  const started = new Promise((resolve) => { entered = () => resolve(undefined); });
  const hold = new Promise((resolve) => { release = () => resolve(undefined); });
  const realSave = services.customBuilds.upsert.bind(services.customBuilds);
  const spy = jest.spyOn(services.customBuilds, "upsert").mockImplementation(async (...args) => { entered(); await hold; return realSave(...args); });
  // Exercise the real owner-fenced service directly here. Audit middleware
  // has its own separately tested leases; it can conservatively defer a
  // simultaneous erasure after this operation's HTTP response has finished.
  const saving = services.buildStudio.save("custom", privateId, { expectedRevision: 3, build: original });
  await started;
  expect((await db.users.findOne({ userId: owner }))._dataMutations).toHaveLength(1);
  let acquired = false;
  const exclusive = services.gdpr._acquireMutationFence(owner, "test-only").then((/** @type {any} */ fence) => { acquired = true; return fence; });
  await new Promise((resolve) => setTimeout(resolve, 30)); expect(acquired).toBe(false);
  release(); expect((await saving).revision).toBe(4); spy.mockRestore();
  const fence = await exclusive; expect(acquired).toBe(true); await services.gdpr._releaseMutationFence(owner, fence);
});

test("active preset changes are transactional/versioned, visible through the public policy, and immutable-revertable", async () => {
  const name = replacement.name;
  const before = await services.presetPolicies.current(true);
  const competing = await Promise.all([
    admin(request(app).put(`${root}/preset/${encodeURIComponent(name)}`).send({ expectedHash: before.hash, replacement })),
    admin(request(app).put(`${root}/preset/${encodeURIComponent(name)}`).send({ expectedHash: before.hash, replacement: { ...replacement, priority: 1 } })),
  ]);
  expect(competing.map((row) => row.status).sort()).toEqual([200, 409]);
  const current = await request(app).get("/v1/build-policy?evaluator=1");
  expect(current.body.revision).toBe(1); expect(current.body.entries).toHaveLength(1);
  expect(applyPolicy(current.body, "PvZ - Macro Transition (Unclassified)", "Protoss", "Zerg", shared.cases[0].events)).toBe(name);
  const immutable = await db.siteConfig.findOne({ kind: "preset_policy_revision", revision: 1 });
  expect(immutable.policy.hash).toBe(current.body.hash);
  const reverted = await admin(request(app).post(`${root}/policy/revert`).send({ expectedHash: current.body.hash, revision: 0 }));
  expect(reverted.status).toBe(200); expect(reverted.body.revision).toBe(2); expect(reverted.body.entries).toEqual([]);
  expect(await db.siteConfig.findOne({ kind: "preset_policy_revision", revision: 1 })).toEqual(immutable);
  const history = await admin(request(app).get(`${root}/policy/history`)); expect(history.body.items.map((/** @type {any} */ row) => row.revision)).toEqual([2, 1]);
  const review = await admin(request(app).get(`${root}/policy/history/1`)); expect(review.status).toBe(200); expect(review.body).toEqual(immutable.policy);
  expect(JSON.stringify(await db.siteConfig.find({ kind: /^preset_policy/ }).toArray())).not.toMatch(/userId|ownerUserId|PRIVATE|clerk/);
});

test("unsaved shared-runtime preview makes no policy change and rejects executable/oversized definitions", async () => {
  const before = await services.presetPolicies.current(true);
  const preview = await admin(request(app).post(`${root}/preset/${encodeURIComponent(replacement.name)}/preview`).send({ replacement, events: shared.cases[0].events, baseline: replacement.name }));
  expect(preview.status).toBe(200); expect(preview.body.label).toBe(replacement.name); expect(preview.body.evaluatorVersion).toBe(1);
  expect((await services.presetPolicies.current(true)).hash).toBe(before.hash);
  const invalid = { ...replacement, anyOf: [[{ ...replacement.anyOf[0][0], execute: "process.exit()" }]] };
  expect((await admin(request(app).put(`${root}/preset/${encodeURIComponent(replacement.name)}`).send({ expectedHash: before.hash, replacement: invalid }))).status).toBe(400);
});
