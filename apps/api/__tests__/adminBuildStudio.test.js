"use strict";
const request = require("supertest");
const { MongoMemoryReplSet, MongoMemoryServer } = require("mongodb-memory-server");
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
  const saved = await admin(request(app).put(`${root}/community/${publicId}`).send({ expectedRevision: 1, build, title: "Corrected listing", description: "Corrected listing description" }));
  expect(saved.status).toBe(200); expect(saved.body.revision).toBe(2); expect(saved.body.removed).toBe(true);
  const row = await db.communityBuilds.findOne({ slug: "public-opening" });
  expect(row.votes).toBe(8); expect(row.upvotes).toEqual(["voter"]); expect(row.ownerUserId).toBe(owner); expect(row.sourceSlug).toBe("private-opening");
  expect(await db.customBuilds.findOne({ userId: owner, slug: "private-opening" })).toEqual(beforePrivate);
  expect((await admin(request(app).put(`${root}/community/${publicId}`).send({ expectedRevision: 1, build }))).status).toBe(409);
  const restored = await admin(request(app).post(`${root}/community/${publicId}/revert`).send({ expectedRevision: 2, revision: 1 }));
  expect(restored.status).toBe(200); expect(restored.body.revision).toBe(3);
  expect(restored.body).toMatchObject({ title: "Public opening", description: "Public listing", removed: true, build: original });
  expect(restored.body.history[1]).toMatchObject({ title: "Corrected listing", description: "Corrected listing description", build });
  expect((await db.communityBuilds.findOne({ slug: "public-opening" })).votes).toBe(8);
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
  // A fresh owner isolates this held-save lease from asynchronous audit
  // leases belonging to earlier real HTTP saves. No production fence is
  // removed or weakened to make the assertion pass.
  const isolatedOwner = "studio-held-save-owner";
  await db.users.insertOne({ userId: isolatedOwner, clerkUserId: "studio-held-save-clerk" });
  const isolatedId = String((await db.customBuilds.insertOne({ ...original, userId: isolatedOwner, slug: "held-save", definitionRevision: 0 })).insertedId);
  const saving = services.buildStudio.save("custom", isolatedId, { expectedRevision: 0, build: original });
  await started;
  expect((await db.users.findOne({ userId: isolatedOwner }))._dataMutations).toHaveLength(1);
  let acquired = false;
  const exclusive = services.gdpr._acquireMutationFence(isolatedOwner, "test-only").then((/** @type {any} */ fence) => { acquired = true; return fence; });
  await new Promise((resolve) => setTimeout(resolve, 30)); expect(acquired).toBe(false);
  release(); expect((await saving).revision).toBe(1); spy.mockRestore();
  const fence = await exclusive; expect(acquired).toBe(true); await services.gdpr._releaseMutationFence(isolatedOwner, fence);
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

test("real ingest re-evaluates complete stale policy evidence, preserves custom names, and never stores raw evidence on slim rows", async () => {
  const current = await services.presetPolicies.current(true);
  const name = replacement.name;
  const disabled = { name, enabled: false, priority: 0, anyOf: [] };
  const active = await services.presetPolicies.save(current.hash, [disabled]);
  const account = await db.users.findOne({ clerkUserId: "admin-clerk" });
  const axis = { custom: false, baseline: name, complete: true, events: shared.cases[0].events };
  const evidence = { schemaVersion: 1, evaluatorVersion: 1, policyHash: current.hash, you: axis, opponent: { custom: false, baseline: "Zerg - 12 Pool", complete: true, events: [] } };
  const base = { date: "2026-10-23T12:00:00.000Z", result: "Victory", myRace: "Protoss", map: "SyntheticStudioMap", durationSec: 600, myBuild: name, opponent: { race: "Zerg", strategy: "Zerg - 12 Pool" }, buildLog: [], oppBuildLog: [], presetEvidence: evidence };
  /** @param {string} id @param {any} [overrides] */
  const put = async (id, overrides = {}) => {
    const response = await admin(request(app).post("/v1/games").send({ ...base, ...overrides, gameId: id }));
    expect(response.status).toBe(202); expect(response.body.rejected).toEqual([]);
    return db.games.findOne({ userId: account.userId, gameId: id });
  };
  const classified = await put("studio-policy-stale");
  expect(classified.myBuild).toBe("Unclassified - Protoss"); expect(classified.presetEvidence).toBeUndefined();
  const custom = await put("studio-policy-native-custom", { presetEvidence: { ...evidence, you: { ...axis, custom: true, baseline: null } } });
  expect(custom.myBuild).toBe(name);
  const incomplete = await put("studio-policy-incomplete", { presetEvidence: { ...evidence, you: { ...axis, complete: false } } });
  expect(incomplete.myBuild).toBe(name);
  const legacy = await put("studio-policy-legacy", { presetEvidence: undefined }); expect(legacy.myBuild).toBe(name);
  const incompatible = await put("studio-policy-future", { presetEvidence: { ...evidence, evaluatorVersion: 2 } }); expect(incompatible.myBuild).toBe(name);
  // The same write boundary keeps declared check-ins and stores the active
  // policy's detector label separately; an upload can never overwrite intent.
  await db.games.updateOne({ userId: account.userId, gameId: "studio-policy-stale" }, { $set: { myBuild: "Declared opener", buildIntent: { status: "confirmed", applied: true, build: { name: "Declared opener", source: "preset" }, detected: { name, slug: null } } } });
  const checked = await put("studio-policy-stale");
  expect(checked.myBuild).toBe("Declared opener"); expect(checked.buildIntent.detected).toEqual({ name: "Unclassified - Protoss", slug: null });
  const invalid = await admin(request(app).post("/v1/games").send({ ...base, gameId: "studio-policy-bad", presetEvidence: { ...evidence, you: { ...axis, events: [{ name: "WarpPrism", type: "unit", time: 360, token: "forbidden" }] } } }));
  expect(invalid.status).toBe(202); expect(invalid.body.rejected).toHaveLength(1);
  expect(JSON.stringify(invalid.body.rejected)).toContain("additional properties");
  expect(await db.games.findOne({ userId: account.userId, gameId: "studio-policy-bad" })).toBeNull();
  expect((await services.presetPolicies.current()).hash).toBe(active.hash);
  await services.customBuilds.upsert(account.userId, { ...original, slug: "cloud-winner", name: "Cloud private winner" });
  const privateWinner = await put("studio-policy-cloud-custom", { buildLog: ["[1:40] Gateway"] });
  expect(privateWinner.myBuild).toBe("Cloud private winner"); expect(privateWinner._customBuildSlug).toBe("cloud-winner");
  const observed = [{ type: "building", name: "Gateway", time: 100 }];
  const matching = { priority: 0, enabled: true, anyOf: [[{ kind: "exists", name: "Gateway", category: "building", clock: "recorded", beforeSeconds: 200 }]] };
  await services.presetPolicies.save(active.hash, [{ ...matching, name }, { ...matching, name: "Protoss - DT Rush" }]);
  const personal = await put("studio-policy-personal-surface", { presetEvidence: { ...evidence, you: { ...axis, events: observed } } });
  expect(personal.myBuild).toBe(name);
  const opposing = await put("studio-policy-opponent-surface", { myRace: "Zerg", myBuild: "Zerg - 12 Pool", opponent: { race: "Protoss", strategy: "Protoss - DT Rush" }, presetEvidence: { ...evidence, you: { ...axis, baseline: "Zerg - 12 Pool", events: [] }, opponent: { ...axis, baseline: "Unclassified - Protoss", events: observed } } });
  expect(opposing.opponent.strategy).toBe("Protoss - DT Rush");
  expect(opposing.opponent.strategy).not.toBe(name);
});

test("legacy definitions exceeding valid array bounds cannot be silently truncated by an admin save", async () => {
  const tooMany = { ...original, userId: owner, slug: "legacy-oversized", steps: Array.from({ length: 201 }, (_, i) => ({ time: `0:${String(i % 60).padStart(2, "0")}`, supply: 10, action: "Gateway" })) };
  const id = String((await db.customBuilds.insertOne(tooMany)).insertedId);
  const detail = await admin(request(app).get(`${root}/custom/${id}`));
  expect(detail.status).toBe(200); expect(detail.body.truncated).toBe(true); expect(detail.body.definitionCounts.steps).toBe(201); expect(detail.body.build.steps).toHaveLength(200);
  const blocked = await admin(request(app).put(`${root}/custom/${id}`).send({ expectedRevision: 0, build: detail.body.build }));
  expect(blocked.status).toBe(409); expect(blocked.body.error.code).toBe("legacy_definition_requires_repair");
  expect((await db.customBuilds.findOne({ slug: "legacy-oversized" })).steps).toHaveLength(201);
});

test("owner-filtered catalog pages use bounded compound keyset indexes instead of scanning other owners", async () => {
  await db.customBuilds.insertMany(Array.from({ length: 2000 }, (_, i) => ({ userId: `unrelated-${i}`, slug: `unrelated-${i}`, name: "Unrelated" })));
  await db.customBuilds.insertMany(Array.from({ length: 120 }, (_, i) => ({ userId: "catalog-index-owner", slug: `indexed-${i}`, name: `Indexed ${i}` })));
  const first = await admin(request(app).get(`${root}?scope=custom&owner=catalog-index-owner`));
  const second = await admin(request(app).get(`${root}?scope=custom&owner=catalog-index-owner&after=${first.body.nextAfter}`));
  const third = await admin(request(app).get(`${root}?scope=custom&owner=catalog-index-owner&after=${second.body.nextAfter}`));
  expect([first.body.items.length, second.body.items.length, third.body.items.length]).toEqual([50, 50, 20]);
  expect(third.body.nextAfter).toBeNull();
  const explained = await db.customBuilds.find({ userId: "catalog-index-owner", deletedAt: { $exists: false } }).sort({ _id: 1 }).limit(51).explain("executionStats");
  expect(JSON.stringify(explained.queryPlanner.winningPlan)).toContain("admin_custom_build_catalog");
  expect(explained.executionStats.totalKeysExamined).toBeLessThanOrEqual(51);
  expect(explained.executionStats.totalDocsExamined).toBeLessThanOrEqual(51);
  expect((await db.communityBuilds.indexes()).some((/** @type {any} */ index) => index.name === "admin_community_build_catalog")).toBe(true);
});


test("a losing cross-process admin rename cannot partially change confirmed game labels", async () => {
  const { CustomBuildsService } = require("../src/services/customBuilds");
  const raceOwner = "studio-rename-race-owner", slug = "rename-race";
  await db.users.insertOne({ userId: raceOwner, clerkUserId: "rename-race-clerk" });
  const id = String((await db.customBuilds.insertOne({ ...original, name: "Initial name", userId: raceOwner, slug, definitionRevision: 0 })).insertedId);
  await db.games.insertOne({ userId: raceOwner, gameId: "rename-race-game", myBuild: "Initial name", _customBuildSlug: slug,
    buildIntent: { status: "confirmed", applied: true, build: { source: "custom", slug, name: "Initial name", key: slug }, detected: { slug, name: "Initial name" } } });
  /** @type {()=>void} */ let entered = () => {}; /** @type {()=>void} */ let release = () => {};
  const started = new Promise(resolve => { entered = () => resolve(undefined); });
  const hold = new Promise(resolve => { release = () => resolve(undefined); });
  const actualUpdate = db.games.updateMany.bind(db.games);
  let held = false;
  const spy = jest.spyOn(db.games, "updateMany").mockImplementation(async (...args) => {
    if (!held && /** @type {any} */ (args[1])?.[0]?.$set?.myBuild?.$literal === "Admin stale rename") {
      held = true; entered(); await hold;
    }
    return actualUpdate(...args);
  });
  const ownerGamesChanged = jest.fn(), ownerDefinitionsChanged = jest.fn();
  const otherProcess = new CustomBuildsService(db, { onGamesChanged: ownerGamesChanged, onDefinitionsChanged: ownerDefinitionsChanged });
  const losing = services.buildStudio.save("custom", id, { expectedRevision: 0, build: { ...original, name: "Admin stale rename" } });
  // Observe rejection immediately, even if a later assertion fails.
  const result = losing.then((/** @type {any} */ value) => ({ value }), (/** @type {any} */ error) => ({ error }));
  try {
    await started;
    await otherProcess.upsert(raceOwner, { ...original, slug, name: "Owner winner" });
    release();
    expect(await result).toMatchObject({ error: { status: 409, code: "build_definition_changed" } });
    const definition = await db.customBuilds.findOne({ userId: raceOwner, slug });
    expect(definition.name).toBe("Owner winner"); expect(definition.definitionRevision).toBe(1);
    expect(definition._definitionHistory).toBeUndefined();
    const game = await db.games.findOne({ userId: raceOwner, gameId: "rename-race-game" });
    expect(game.myBuild).toBe("Owner winner");
    expect(game.buildIntent.build.name).toBe("Owner winner");
    expect(game.buildIntent.detected).toEqual({ slug, name: "Owner winner" });
    expect(ownerGamesChanged).toHaveBeenCalledTimes(1); expect(ownerGamesChanged).toHaveBeenCalledWith(raceOwner, 1);
    expect(ownerDefinitionsChanged).toHaveBeenCalledTimes(1);
  } finally { release(); await result; spy.mockRestore(); }
});


test("standalone development owner saves work but versioned admin saves fail before any partial write", async () => {
  const { CustomBuildsService } = require("../src/services/customBuilds");
  const standalone = await MongoMemoryServer.create();
  const local = await connect({ uri: standalone.getUri(), dbName: "studio_standalone_only" });
  try {
    const onDefinitionsChanged = jest.fn();
    const service = new CustomBuildsService(local, { onDefinitionsChanged });
    await service.upsert("local-owner", { ...original, slug: "local-build", name: "Local initial" });
    expect(onDefinitionsChanged).toHaveBeenCalledTimes(1);
    await expect(service.upsert("local-owner", { ...original, slug: "local-build", name: "Rejected admin rename" }, { expectedRevision: 1, recordHistory: true })).rejects.toMatchObject({ status: 503, code: "build_definition_transactions_required" });
    const saved = await local.customBuilds.findOne({ userId: "local-owner", slug: "local-build" });
    expect(saved?.name).toBe("Local initial"); expect(saved?.definitionRevision).toBe(1); expect(saved?._definitionHistory).toBeUndefined();
    expect(onDefinitionsChanged).toHaveBeenCalledTimes(1);
    const { PresetPoliciesService } = require("../src/services/presetPolicies");
    const policies = new PresetPoliciesService(local), baseline = await policies.current();
    await expect(policies.save(baseline.hash, [replacement])).rejects.toMatchObject({ status: 503, code: "preset_policy_transactions_required" });
    await expect(policies.revert(baseline.hash, 0)).rejects.toMatchObject({ status: 503, code: "preset_policy_transactions_required" });
    expect(await local.siteConfig.countDocuments({})).toBe(0);
    expect(await policies.current()).toEqual(baseline);
  } finally { await local.close(); await standalone.stop(); }
});

test("an unsupported-transaction error after the initial read never retries without a transaction", async () => {
  const { CustomBuildsService } = require("../src/services/customBuilds");
  const userId = "late-transaction-error-owner", slug = "late-transaction-error";
  await db.customBuilds.insertOne({ ...original, userId, slug, name: "Original name", definitionRevision: 1 });
  await db.games.insertOne({ userId, gameId: slug, myBuild: "Original name", _customBuildSlug: slug });
  const onGamesChanged = jest.fn(), onDefinitionsChanged = jest.fn();
  const service = new CustomBuildsService(db, { onGamesChanged, onDefinitionsChanged });
  const failure = Object.assign(new Error("Transaction numbers are only allowed on a replica set member or mongos"), { code: 20 });
  const write = jest.spyOn(db.customBuilds, "updateOne").mockRejectedValueOnce(failure);
  try {
    await expect(service.upsert(userId, { ...original, slug, name: "Rejected name" })).rejects.toBe(failure);
    expect(write).toHaveBeenCalledTimes(1);
    expect((await db.customBuilds.findOne({ userId, slug })).name).toBe("Original name");
    expect((await db.games.findOne({ userId, gameId: slug })).myBuild).toBe("Original name");
    expect(onGamesChanged).not.toHaveBeenCalled(); expect(onDefinitionsChanged).not.toHaveBeenCalled();
  } finally { write.mockRestore(); }
});
