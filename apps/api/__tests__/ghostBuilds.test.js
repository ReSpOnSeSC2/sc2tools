// @ts-nocheck
"use strict";

const request = require("supertest");
const pino = require("pino");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { buildApp } = require("../src/app");
const { sha256 } = require("../src/util/hash");
const { MAX_REFERENCES, normalizeTarget } = require("../src/services/ghostTargets");
const { COLLECTIONS } = require("../src/config/constants");
const { GDPR_CLASSIFICATION, PURGE_ONLY_COLLECTIONS } = require("../src/services/gdpr");

jest.mock("@clerk/backend", () => ({ verifyToken: jest.fn(async (token) => {
  if (["owner", "other", "admin2"].includes(token)) return { sub: "clerk_" + token };
  throw new Error("invalid");
}) }));

describe("curated Ghost examples and private reference builds", () => {
  let mongo, db, app, services;
  const device = "ghost-device-".padEnd(43, "a");

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "ghost_builds" });
    ({ app, services } = buildApp({ db, logger: pino({ level: "silent" }), config: {
      nodeEnv: "test", clerkSecretKey: "sk_test", serverPepper: Buffer.alloc(32, 8),
      corsAllowedOrigins: [], rateLimitPerMinute: 10000, agentReleaseAdminToken: "test-admin",
      pythonExe: null, pythonAnalyzerDir: "C:/__missing__", adminUserIds: ["clerk_owner", "clerk_admin2"],
    } }));
  });
  afterAll(async () => { await db?.close(); await mongo?.stop(); });
  beforeEach(async () => {
    await Promise.all([db.users.deleteMany({}), db.games.deleteMany({}), db.gameDetails.deleteMany({}), db.ghostExamples.deleteMany({}), db.deviceTokens.deleteMany({})]);
    await db.users.insertMany(["owner", "other", "admin2"].map((userId) => ({ userId, clerkUserId: "clerk_" + userId, createdAt: new Date(), lastSeenAt: new Date() })));
    await db.deviceTokens.insertOne({ userId: "owner", tokenHash: sha256(device), revokedAt: null });
    await seedGame("owner", "replay-1");
    await seedGame("other", "other-private-replay");
  });

  function as(user, method, path, body) {
    const pending = request(app)[method](path).set("authorization", "Bearer " + user);
    return body === undefined ? pending : pending.send(body);
  }

  async function seedGame(userId, gameId, extra = {}) {
    await db.games.insertOne({
      userId, gameId, myRace: "Protoss", myBuild: "Blink expand", playerCount: 2, result: "Victory",
      opponent: { displayName: "Private opponent", toonHandle: "1-S2-1-999", race: "Terran", strategy: "Bio timing" },
      map: "Alcyone LE", durationSec: 600,
      filePath: "C:/private/replay.SC2Replay", chat: ["Private replay chat"],
      buildLog: ["[0:00] Nexus", "[0:12] Probe", "[0:18] Pylon", "[0:40] Gateway", "[2:10] Stalker", "[4:00] BlinkTech"],
      oppBuildLog: ["[0:00] CommandCenter", "[0:12] SCV", "[0:45] Barracks", "[2:20] Factory", "[5:00] Stimpack"],
      ...extra,
    });
  }

  function target(id = "local-replay", steps = 3) {
    return { v: 1, name: "Practice opening", sourceGameId: id, steps: Array.from({ length: steps }, (_, index) => ({ name: "Gateway", t: index * 10, supply: null, kind: "building", timing: "started" })) };
  }

  test("only explicitly previewed and published examples enter the authenticated catalog", async () => {
    expect((await as("other", "get", "/v1/ghost-examples")).body.items).toEqual([]);
    const input = { gameId: "replay-1", side: "you", name: "Coach's Blink opening", description: "A timed opening to practice." };
    const preview = await as("owner", "post", "/v1/admin/ghost-examples/preview", input);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ matchup: "PvT", myRace: "P", opponentRace: "T", stepCount: 5, previewToken: expect.any(String) });
    expect((await as("other", "get", "/v1/ghost-examples")).body.items).toEqual([]);
    expect((await as("owner", "post", "/v1/admin/ghost-examples", input)).status).toBe(409);
    const published = await as("owner", "post", "/v1/admin/ghost-examples", { ...input, previewToken: preview.body.previewToken });
    expect(published.status).toBe(201);
    const id = published.body.id;
    expect(published.body.target.sourceGameId).toBe("example:" + id);
    const listed = await as("other", "get", "/v1/ghost-examples?matchup=PvT");
    expect(listed.body.items).toHaveLength(1);
    expect(listed.headers["cache-control"]).toBe("private, no-store");
    expect(listed.body.items[0]).not.toHaveProperty("target");
    const selected = await as(device, "get", "/v1/ghost-examples/" + id);
    expect(selected.body.target.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Gateway", t: 40, timing: "started" }),
      expect.objectContaining({ name: "Stalker", t: 130, timing: "completed" }),
      expect.objectContaining({ name: "BlinkTech", t: 240, kind: "upgrade", timing: "completed" }),
    ]));
    const serialized = JSON.stringify([published.body, listed.body, selected.body]);
    for (const privateValue of ["ownerUserId", "replay-1", "Private opponent", "Private replay chat", "C:/private", "1-S2-1-999"]) expect(serialized).not.toContain(privateValue);
  });

  test("curation is Clerk-admin and source-owner scoped, with stale-preview fencing", async () => {
    const input = { gameId: "replay-1", side: "opponent" };
    expect((await request(app).get("/v1/ghost-examples")).status).toBe(401);
    expect((await as("other", "post", "/v1/admin/ghost-examples/preview", input)).status).toBe(403);
    expect((await as(device, "post", "/v1/admin/ghost-examples/preview", input)).status).toBe(403);
    expect((await as("owner", "post", "/v1/admin/ghost-examples/preview", { ...input, gameId: "other-private-replay" })).status).toBe(404);
    const preview = await as("owner", "post", "/v1/admin/ghost-examples/preview", input);
    expect(preview.body.matchup).toBe("TvP");
    await db.games.updateOne({ userId: "owner", gameId: "replay-1" }, { $push: { oppBuildLog: "[5:20] Starport" } });
    const stale = await as("owner", "post", "/v1/admin/ghost-examples", { ...input, previewToken: preview.body.previewToken });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("ghost_preview_changed");
    expect(await db.ghostExamples.countDocuments({})).toBe(0);
  });

  test("published entries can only be unpublished by their curator and are classified for erasure", async () => {
    const input = { gameId: "replay-1", side: "you" };
    const preview = await as("owner", "post", "/v1/admin/ghost-examples/preview", input);
    const result = await as("owner", "post", "/v1/admin/ghost-examples", { ...input, previewToken: preview.body.previewToken });
    expect((await as("admin2", "delete", "/v1/admin/ghost-examples/" + result.body.id)).status).toBe(404);
    expect((await as("owner", "delete", "/v1/admin/ghost-examples/" + result.body.id)).status).toBe(204);
    expect((await as("other", "get", "/v1/ghost-examples/" + result.body.id)).status).toBe(404);
    expect(GDPR_CLASSIFICATION.GHOST_EXAMPLES).toBe("purge_only");
    expect(PURGE_ONLY_COLLECTIONS).toContainEqual(["ghostExamples", "ownerUserId"]);
    expect(COLLECTIONS.GHOST_EXAMPLES).toBe("ghost_examples");
  });

  test("replay stars derive both player build orders from owner-scoped stored detail", async () => {
    await seedGame("owner", "detail-game", { buildLog: undefined, oppBuildLog: undefined });
    await services.gameDetails.upsert("owner", "detail-game", new Date(), {
      buildLog: ["[0:20] Pylon", "[0:45] Gateway", "[2:30] TwilightCouncil"],
      oppBuildLog: ["[0:45] Barracks", "[2:20] Factory", "[5:00] Stimpack"],
    });
    const mine = await as(device, "put", "/v1/me/ghost-builds/reference", { gameId: "detail-game", side: "you" });
    expect(mine.status).toBe(200);
    expect(mine.body.slots.PvT.sourceGameId).toBe("detail-game");
    expect(mine.body.references["you:PvT:Blink expand"].gameId).toBe("detail-game");
    const opponent = await as("owner", "put", "/v1/me/ghost-builds/reference", { gameId: "detail-game", side: "opponent" });
    expect(opponent.body.slots.TvP).toMatchObject({ perspective: "opponent", sourceGameId: "detail-game" });
    expect(opponent.body.slots.TvP.steps.map((step) => step.name)).toEqual(["Barracks", "Factory", "Stimpack"]);
    expect((await as("other", "get", "/v1/me/ghost-builds")).body).toEqual({ v: 1, slots: {}, references: {}, history: {} });
    expect((await as("owner", "put", "/v1/me/ghost-builds/reference", { gameId: "other-private-replay", side: "you" })).status).toBe(404);
  });

  test("simultaneous exact-matchup assignments merge and clearing one slot preserves the others", async () => {
    const responses = await Promise.all(["PvT", "ZvP", "TvZ"].map((matchup) => as("owner", "put", "/v1/me/ghost-builds", { matchup, target: target(matchup) })));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const saved = await as("owner", "get", "/v1/me/ghost-builds");
    expect(Object.keys(saved.body.slots).sort()).toEqual(["PvT", "TvZ", "ZvP"]);
    const cleared = await as("owner", "put", "/v1/me/ghost-builds", { matchup: "PvT", target: null });
    expect(Object.keys(cleared.body.slots).sort()).toEqual(["TvZ", "ZvP"]);
  });

  test("an old row's clear cannot delete a newer per-build reference or unrelated active slot", async () => {
    await seedGame("owner", "newer-replay");
    await as("owner", "put", "/v1/me/ghost-builds/reference", { gameId: "replay-1", side: "you" });
    await as("owner", "put", "/v1/me/ghost-builds/reference", { gameId: "newer-replay", side: "you" });
    const oldClear = await as("owner", "put", "/v1/me/ghost-builds/reference", { gameId: "replay-1", side: "you", clear: true });
    expect(oldClear.body.slots.PvT.sourceGameId).toBe("newer-replay");
    expect(oldClear.body.references["you:PvT:Blink expand"].gameId).toBe("newer-replay");
    await seedGame("owner", "other-build", { myBuild: "Stargate opening" });
    await as("owner", "put", "/v1/me/ghost-builds/reference", { gameId: "other-build", side: "you" });
    const clearReference = await as("owner", "put", "/v1/me/ghost-builds/reference", { gameId: "newer-replay", side: "you", clear: true });
    expect(clearReference.body.references).not.toHaveProperty("you:PvT:Blink expand");
    expect(clearReference.body.slots.PvT.sourceGameId).toBe("other-build");
  });

  test("reference capacity is atomically bounded without clobbering other preference fields", async () => {
    await db.users.updateOne({ userId: "owner" }, { $set: { "preferences.buildCheckin": { enabled: false }, "preferences.otherSetting": "keep" } });
    const assignments = await Promise.all(Array.from({ length: MAX_REFERENCES + 3 }, (_, index) => services.ghostReferences.saveSlot("owner", { matchup: "PvT", buildKey: "Build " + index, target: target() }).then(() => true, (error) => error.code)));
    expect(assignments.filter((value) => value === true)).toHaveLength(MAX_REFERENCES);
    expect(assignments.filter((value) => value === "ghost_reference_limit")).toHaveLength(3);
    const document = await services.ghostReferences.get("owner");
    expect(Object.keys(document.references)).toHaveLength(MAX_REFERENCES);
    expect((await db.users.findOne({ userId: "owner" })).preferences).toMatchObject({ buildCheckin: { enabled: false }, otherSetting: "keep" });
    await expect(services.ghostReferences.saveSlot("owner", { matchup: "PvT", buildKey: "Build 0", target: target("replacement") })).resolves.toBeTruthy();
  });

  test("target and mutation bounds reject malformed requests while accepting full native openings", async () => {
    expect(normalizeTarget(target("full-native", 250)).steps).toHaveLength(250);
    for (const body of [
      { matchup: "PvRandom", target: target() },
      { matchup: "PvT", target: target("too-many", 251) },
      { matchup: "PvT", target: { ...target(), steps: [{ name: "Gateway", t: -1 }] } },
      { matchup: "PvT", target: target(), userId: "other" },
    ]) expect((await as("owner", "put", "/v1/me/ghost-builds", body)).status).toBe(400);
    expect((await as("owner", "put", "/v1/me/ghost-builds/reference", { gameId: "replay-1", clear: "yes" })).status).toBe(400);
    expect((await as("owner", "post", "/v1/admin/ghost-examples/preview", { gameId: "replay-1", sourcePath: "C:/private" })).status).toBe(400);
  });

  test("reference history retains the previous three and fenced Undo never overwrites a newer choice", async () => {
    const key = "you:PvT:Blink expand";
    for (const gameId of ["replay-1", "reference-2", "reference-3", "reference-4", "reference-5"]) {
      if (gameId !== "replay-1") await seedGame("owner", gameId);
      expect((await as("owner", "put", "/v1/me/ghost-builds/reference", { gameId })).status).toBe(200);
    }
    const before = (await as("owner", "get", "/v1/me/ghost-builds")).body;
    expect(before.history[key].map((entry) => entry.gameId)).toEqual(["reference-4", "reference-3", "reference-2"]);
    const restore = { referenceKey: key, revision: before.history[key][0].revision, expectedCurrentRevision: before.references[key].revision };
    expect((await as("other", "put", "/v1/me/ghost-builds/reference/restore", restore)).status).toBe(404);
    const undone = await as("owner", "put", "/v1/me/ghost-builds/reference/restore", restore);
    expect(undone.status).toBe(200);
    expect(undone.body.references[key].gameId).toBe("reference-4");
    expect(undone.body.slots.PvT.sourceGameId).toBe("reference-4");
    expect(undone.body.history[key].map((entry) => entry.gameId)).toEqual(["reference-5", "reference-3", "reference-2"]);
    expect((await as("owner", "put", "/v1/me/ghost-builds/reference/restore", { ...restore, revision: undone.body.history[key][1].revision })).status).toBe(409);
    expect((await as("owner", "put", "/v1/me/ghost-builds/reference/restore", restore)).status).toBe(404);
    expect((await as("owner", "get", "/v1/me/ghost-builds")).body.references[key].gameId).toBe("reference-4");
  });

  test("clear is undoable only while its reference stays absent and history families remain bounded", async () => {
    const key = "you:PvT:Blink expand";
    await as("owner", "put", "/v1/me/ghost-builds/reference", { gameId: "replay-1" });
    const cleared = (await as("owner", "put", "/v1/me/ghost-builds/reference", { gameId: "replay-1", clear: true })).body;
    const restore = { referenceKey: key, revision: cleared.history[key][0].revision, expectedCurrentRevision: null };
    expect((await as("owner", "put", "/v1/me/ghost-builds/reference/restore", restore)).status).toBe(200);
    expect((await as("owner", "put", "/v1/me/ghost-builds/reference/restore", restore)).status).toBe(404);
    for (let index = 0; index < MAX_REFERENCES + 2; index += 1) {
      const buildKey = "Family " + index;
      await services.ghostReferences.reference("owner", { gameId: "replay-1", buildKey });
      await services.ghostReferences.reference("owner", { gameId: "replay-1", buildKey, clear: true });
    }
    const document = await services.ghostReferences.get("owner");
    expect(Object.keys(document.history)).toHaveLength(MAX_REFERENCES);
    expect(document.history["you:PvT:Family 0"]).toBeUndefined();
    expect(document.history["you:PvT:Family 33"][0].gameId).toBe("replay-1");
  });

  test("historical comparison matches repeated occurrences and preserves raw start/completion timings", async () => {
    await seedGame("owner", "played", { buildLog: ["[0:50] Gateway", "[1:50] Gateway", "[2:20] Stalker", "[4:10] BlinkTech"] });
    const custom = { v: 1, name: "Two gate reference", sourceGameId: "reference-source", steps: [
      { name: "Gateway", t: 40, kind: "building", timing: "started" },
      { name: "Gateway", t: 120, kind: "building", timing: "started" },
      { name: "Stalker", t: 130, kind: "unit", timing: "completed" },
      { name: "BlinkTech", t: 240, kind: "upgrade", timing: "completed" },
      { name: "Forge", t: 280, kind: "building", timing: "started" },
    ] };
    await services.ghostReferences.saveSlot("owner", { matchup: "PvT", buildKey: "custom-slug", target: custom });
    const response = await as("owner", "get", "/v1/me/ghost-builds/comparison?gameId=played&buildKey=custom-slug");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "ready", matchup: "PvT", buildKey: "custom-slug" });
    expect(response.body.rows.map(({ name, occurrence, deltaSec, status }) => ({ name, occurrence, deltaSec, status }))).toEqual([
      { name: "Gateway", occurrence: 1, deltaSec: 10, status: "observed" },
      { name: "Gateway", occurrence: 2, deltaSec: -10, status: "observed" },
      { name: "Stalker", occurrence: 1, deltaSec: 10, status: "observed" },
      { name: "BlinkTech", occurrence: 1, deltaSec: 10, status: "observed" },
      { name: "Forge", occurrence: 1, deltaSec: null, status: "missing" },
    ]);
    expect((await as("owner", "get", "/v1/me/ghost-builds/comparison?gameId=played")).body.status).toBe("no_reference");
    expect((await as("owner", "get", "/v1/me/ghost-builds/comparison?gameId=played&side=opponent&buildKey=custom-slug")).body.status).toBe("no_reference");
    expect((await as("other", "get", "/v1/me/ghost-builds/comparison?gameId=played&buildKey=custom-slug")).status).toBe(404);
  });

  test("comparison excludes its source and unfinished games, and never compares unlike event timings", async () => {
    await as("owner", "put", "/v1/me/ghost-builds/reference", { gameId: "replay-1" });
    expect((await as("owner", "get", "/v1/me/ghost-builds/comparison?gameId=replay-1")).body.status).toBe("source_replay");
    await seedGame("owner", "unfinished", { result: null });
    expect((await as("owner", "get", "/v1/me/ghost-builds/comparison?gameId=unfinished")).body.status).toBe("replay_pending");
    await services.ghostReferences.saveSlot("owner", { matchup: "PvT", buildKey: "Blink expand", target: { ...target(), steps: [{ name: "Gateway", t: 60, kind: "building", timing: "completed" }] } });
    const incompatible = await as("owner", "get", "/v1/me/ghost-builds/comparison?gameId=replay-1");
    expect(incompatible.body.rows[0]).toMatchObject({ targetSec: 60, actualSec: 40, deltaSec: null, status: "event_mismatch" });
    const input = { gameId: "replay-1", side: "you" };
    const preview = await services.ghostExamples.preview("owner", input);
    const example = await services.ghostExamples.publish("owner", { ...input, previewToken: preview.previewToken });
    await services.ghostReferences.saveSlot("owner", { matchup: "PvT", buildKey: "Blink expand", target: example.target });
    expect((await as("owner", "get", "/v1/me/ghost-builds/comparison?gameId=replay-1")).body.status).toBe("source_replay");
  });

  test("known team formats cannot become fabricated one-on-one Ghost targets", async () => {
    for (const extra of [{ playerCount: 4 }, { matchFormat: "2v2" }, { isResumedFromReplay: true }]) {
      await db.games.updateOne({ userId: "owner", gameId: "replay-1" }, { $set: { playerCount: 2, matchFormat: "1v1", isResumedFromReplay: false, ...extra } });
      expect((await as("owner", "put", "/v1/me/ghost-builds/reference", { gameId: "replay-1" })).status).toBe(409);
      expect((await as("owner", "post", "/v1/admin/ghost-examples/preview", { gameId: "replay-1" })).status).toBe(409);
    }
  });

  test("account inventory and erasure include curated examples and private reference history", async () => {
    for (const [owner, gameId] of [["owner", "replay-1"], ["other", "other-private-replay"]]) {
      const input = { gameId };
      const preview = await services.ghostExamples.preview(owner, input);
      await services.ghostExamples.publish(owner, { ...input, previewToken: preview.previewToken });
    }
    await services.ghostReferences.reference("owner", { gameId: "replay-1" });
    await services.ghostReferences.reference("owner", { gameId: "replay-1", clear: true });
    expect((await services.gdpr.inventory("owner")).removed.ghostExamples).toBe(1);
    await services.gdpr.deleteAll("owner", { identityAlreadyDeleted: true });
    expect(await db.ghostExamples.countDocuments({ ownerUserId: "owner" })).toBe(0);
    expect(await db.ghostExamples.countDocuments({ ownerUserId: "other" })).toBe(1);
    expect(await db.users.findOne({ userId: "owner" })).toBeNull();
    expect((await as(device, "get", "/v1/me/ghost-builds")).status).toBe(401);
  });
});
