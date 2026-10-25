// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { OverlayTokensService } = require("../src/services/overlayTokens");
const { MultichatStudioService } = require("../src/services/multichatStudio");
const { MultichatEngagementService } = require("../src/services/multichatEngagement");
const { ENGAGEMENT, ROW_BATCH, REQUEST_BATCHES } = require("../src/services/overlayTokenRotation");

let mongo, db, tokens, original;
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  db = await connect({ uri: mongo.getUri(), dbName: "token_rotation" });
  await db.overlayTokens.createIndex({ token: 1 }, { unique: true });
  await db.multichatStudio.createIndex({ studioKey: 1 }, { unique: true, sparse: true });
  await db.multichatViewers.createIndex({ token: 1, userKey: 1 }, { unique: true });
  await db.multichatPredictions.createIndex({ token: 1, gameKey: 1 }, { unique: true });
  await db.multichatEngagementEvents.createIndex({ token: 1, platform: 1, msgId: 1 }, { unique: true });
});
afterAll(async () => { await db?.close(); await mongo?.stop(); });
beforeEach(async () => {
  jest.restoreAllMocks();
  for (const key of ["overlayTokens", "multichatStudio", ...ENGAGEMENT]) await db[key].deleteMany({});
  tokens = new OverlayTokensService(db);
  original = await tokens.create("owner", "Live");
  await db.overlayTokens.updateOne({ token: original.token }, { $set: { enabledWidgets: ["stream-goals", "chat-oracle"], profile: { v: 1, theme: { accent: "#abcdef" }, widgetOptions: {} } } });
  await db.multichatStudio.insertOne({ token: original.token, studioKey: original.token, goals: [{ label: "Ladder" }], broll: { clips: [{ id: "video" }], playback: { epochMs: 12345 } }, poll: { question: "Play?" }, brollWriteRevision: 7 });
  await db.multichatViewers.insertOne({ token: original.token, userKey: "twitch:viewer", xp: 234, oracle: { score: 80 } });
  await db.multichatPredictions.insertOne({ token: original.token, gameKey: "game", settled: false, picks: { viewer: { pick: "win" } } });
  await db.multichatEngagementEvents.insertOne({ token: original.token, platform: "twitch", msgId: "msg" });
  await db.multichatClipMoments.insertOne({ token: original.token, reason: "Great game" });
});

async function assertPreserved(replacement) {
  expect(await tokens.resolve(original.token)).toBeNull();
  expect(await tokens.isReplaced(original.token)).toBe(true);
  expect(await tokens.resolve(replacement)).toMatchObject({ userId: "owner", label: "Live", enabledWidgets: ["stream-goals", "chat-oracle"], profile: { theme: { accent: "#abcdef" } } });
  const studio = await db.multichatStudio.findOne({ studioKey: replacement });
  expect(studio).toMatchObject({ token: replacement, goals: [{ label: "Ladder" }], broll: { playback: { epochMs: 12345 } }, brollWriteRevision: 7 });
  for (const key of ENGAGEMENT) {
    expect(await db[key].countDocuments({ token: original.token })).toBe(0);
    expect(await db[key].countDocuments({ token: replacement })).toBe(1);
  }
  expect(await db.multichatViewers.findOne({ token: replacement })).toMatchObject({ xp: 234, oracle: { score: 80 } });
  const items = await tokens.list("owner");
  expect(items).toHaveLength(2);
  expect(items.find(row => row.token === original.token)).toMatchObject({ replacedBy: replacement, revokedAt: expect.any(Date) });
  expect(JSON.stringify(items)).not.toMatch(/_rotation|studioKey|writeRevision/);
}

test("preserves profile, authoritative studio and all token-owned data; repeat returns the same credential", async () => {
  await db.multichatStudio.insertOne({ token: original.token, goals: [{ label: "Ignored legacy duplicate" }] });
  const result = await tokens.rotate("owner", original.token);
  expect(result.pending).toBe(false);
  await assertPreserved(result.token);
  expect(await tokens.rotate("owner", original.token)).toEqual(result);
  expect(await db.overlayTokens.countDocuments({ userId: "owner" })).toBe(2);
});

test.each(["reserve", "destination", "studio", ...ENGAGEMENT, "revoke", "activate"])("recovers after an ambiguous %s write without losing or duplicating data", async stage => {
  const collection = stage === "studio" ? db.multichatStudio : ENGAGEMENT.includes(stage) ? db[stage] : db.overlayTokens;
  const method = ENGAGEMENT.includes(stage) ? "updateMany" : "updateOne";
  const write = collection[method].bind(collection);
  let failed = false;
  jest.spyOn(collection, method).mockImplementation(async (match, update, ...rest) => {
    const applies = stage === "reserve" ? update.$set?._rotation
      : stage === "destination" ? update.$setOnInsert?._rotationPending
      : stage === "revoke" ? update.$set?.["_rotation.state"]
      : stage === "activate" ? update.$set?._rotationPending === false : true;
    const result = await write(match, update, ...rest);
    if (applies && !failed) { failed = true; throw new Error("synthetic lost response"); }
    return result;
  });
  await expect(tokens.rotate("owner", original.token)).rejects.toThrow("synthetic lost response");
  expect(failed).toBe(true);
  const reserved = (await db.overlayTokens.findOne({ token: original.token }))._rotation.to;
  // A process restart discards admitted writers, but the durable marker still
  // rejects stale credentials and resumes this exact destination.
  tokens = new OverlayTokensService(db);
  const result = await tokens.rotate("owner", original.token);
  expect(result).toEqual({ pending: false, token: reserved });
  await assertPreserved(reserved);
});

test("hides the reserved destination and drains a previously admitted Studio writer before copying", async () => {
  const retired = jest.fn(); tokens.rotation.onRotationStarted = retired;
  const studio = new MultichatStudioService(db, { overlayTokens: tokens });
  const entered = defer(), release = defer();
  const update = studio._updateUnlocked.bind(studio);
  jest.spyOn(studio, "_updateUnlocked").mockImplementation(async (...args) => { entered.resolve(); await release.promise; return update(...args); });
  const writing = studio.update(original.token, { goals: [{ label: "Admitted", current: 1, target: 2 }] });
  await entered.promise;
  expect(await tokens.rotate("owner", original.token)).toEqual({ pending: true });
  expect(retired).toHaveBeenCalledWith(original.token);
  expect(await tokens.isReplaced(original.token)).toBe(true);
  expect(await tokens.resolve(original.token)).toBeNull();
  const express = require("express"), request = require("supertest");
  const { buildMultichatRouter } = require("../src/routes/multichat");
  const app = express(); app.use("/v1", buildMultichatRouter({ overlayTokens: tokens, studio, users: { getPreferences: jest.fn() }, tiktokRelay: {} }));
  expect((await request(app).get(`/v1/multichat/${original.token}/config`).expect(401)).body.error.code).toBe("overlay_token_replaced");
  expect(await tokens.list("owner")).toEqual([expect.objectContaining({ token: original.token, rotationPending: true })]);
  await expect(studio.update(original.token, { recap: true })).rejects.toMatchObject({ code: "invalid_overlay_token" });
  await expect(tokens.setProfile("owner", original.token, { v: 1, theme: {}, widgetOptions: {} }, 0)).rejects.toMatchObject({ status: 404 });
  await expect(tokens.rename("owner", original.token, "Changed")).rejects.toMatchObject({ status: 409 });
  release.resolve(); await writing;
  const result = await tokens.rotate("owner", original.token);
  expect(await studio.get(result.token)).toMatchObject({ goals: [expect.objectContaining({ label: "Admitted" })] });
});

test("engagement ingest and internal prediction writers participate in the same drain", async () => {
  const engagement = new MultichatEngagementService(db, { overlayTokens: tokens });
  const entered = defer(), release = defer();
  const credit = engagement._creditXp.bind(engagement);
  jest.spyOn(engagement, "_creditXp").mockImplementation(async (...args) => { entered.resolve(); await release.promise; return credit(...args); });
  const writing = engagement.ingest(original.token, [{ platform: "twitch", id: "new", user: "Viewer", text: "hi" }]);
  await entered.promise;
  expect(await tokens.rotate("owner", original.token)).toEqual({ pending: true });
  const healthy = await tokens.create("owner", "Healthy");
  await engagement.openPrediction([original.token, healthy.token], { gameKey: "later" });
  expect(await db.multichatPredictions.findOne({ token: healthy.token, gameKey: "later" })).not.toBeNull();
  await engagement.settlePrediction([original.token, healthy.token], { gameKey: "later", result: "win" });
  expect(await db.multichatPredictions.findOne({ token: healthy.token, gameKey: "later" })).toMatchObject({ settled: true, result: "win" });
  release.resolve(); await writing;
  const result = await tokens.rotate("owner", original.token);
  expect(await db.multichatViewers.findOne({ token: result.token, userKey: "twitch:viewer" })).toMatchObject({ xp: 236 });
  expect(await db.multichatEngagementEvents.countDocuments({ token: original.token })).toBe(0);
});

test("each request has a fixed row budget and restart resumes remaining batches", async () => {
  await db.multichatClipMoments.insertMany(Array.from({ length: ROW_BATCH * REQUEST_BATCHES + 1 }, (_, i) => ({ token: original.token, reason: String(i) })));
  expect(await tokens.rotate("owner", original.token)).toEqual({ pending: true });
  const reserved = (await db.overlayTokens.findOne({ token: original.token }))._rotation.to;
  expect(await tokens.resolve(reserved)).toBeNull();
  expect((await tokens.list("owner"))).toHaveLength(1);
  tokens = new OverlayTokensService(db);
  expect(await tokens.rotate("owner", original.token)).toEqual({ pending: false, token: reserved });
  expect(await db.multichatClipMoments.countDocuments({ token: reserved })).toBe(ROW_BATCH * REQUEST_BATCHES + 2);
});

test("wrong owners, revoked tokens and hidden destinations cannot start rotations", async () => {
  await expect(tokens.rotate("stranger", original.token)).rejects.toMatchObject({ status: 404 });
  expect(await db.overlayTokens.countDocuments({})).toBe(1);
  await tokens.revoke("owner", original.token);
  await expect(tokens.rotate("owner", original.token)).rejects.toMatchObject({ status: 404 });
});

test("rename is owner-scoped and preserves every setting", async () => {
  await expect(tokens.rename("stranger", original.token, "Other")).rejects.toMatchObject({ status: 409 });
  expect(await tokens.rename("owner", original.token, "  Tournament  ")).toEqual({ label: "Tournament" });
  expect(await tokens.resolve(original.token)).toMatchObject({ label: "Tournament", enabledWidgets: ["stream-goals", "chat-oracle"] });
});


test("owned heartbeat receipts include only ready direct replacements", async () => {
  const result = await tokens.rotate("owner", original.token);
  expect(await tokens.replacementReceipts("stranger")).toEqual([]);
  expect(await tokens.replacementReceipts("owner")).toEqual([{ from: original.token, to: result.token }]);
  await tokens.revoke("owner", result.token);
  expect(await tokens.replacementReceipts("owner")).toEqual([]);
});


test("a held pre-claim resolver cannot stop the next healthy token's internal prediction", async () => {
  const healthy = await tokens.create("owner", "Healthy");
  const entered = defer(), release = defer();
  const find = db.overlayTokens.findOne.bind(db.overlayTokens);
  let held = false;
  jest.spyOn(db.overlayTokens, "findOne").mockImplementation(async (match, ...rest) => {
    const row = await find(match, ...rest);
    if (!held && match.token === original.token && !match.userId && match.revokedAt === null) {
      held = true; entered.resolve(); await release.promise;
    }
    return row;
  });
  const engagement = new MultichatEngagementService(db, { overlayTokens: tokens });
  const pending = engagement.openPrediction([original.token, healthy.token], { gameKey: "raced" });
  await entered.promise;
  expect(await tokens.rotate("owner", original.token)).toEqual({ pending: true });
  release.resolve(); await pending;
  expect(await db.multichatPredictions.findOne({ token: original.token, gameKey: "raced" })).toBeNull();
  expect(await db.multichatPredictions.findOne({ token: healthy.token, gameKey: "raced" })).not.toBeNull();
});


test("uploaded sound IDs and alert catalog object keys work through the replacement without embedded old credentials", async () => {
  const express = require("express"), request = require("supertest");
  const { buildMultichatRouter } = require("../src/routes/multichat");
  const { MultichatSoundsService } = require("../src/services/multichatSounds");
  const { AlertMediaStore } = require("../src/services/alertMediaStore");
  const sounds = new MultichatSoundsService(db);
  const bytes = Buffer.from("ID3synthetic-audio");
  const sound = await sounds.create("owner", "Victory", bytes);
  const prefs = { sound: { customSounds: [{ id: "c-victory", label: "Victory", kind: "upload", uploadId: sound.soundId }, { id: "c-legacy", label: "Legacy", kind: "upload", url: `/v1/multichat/${original.token}/sound/${sound.soundId}` }], messageSound: "c-victory" } };
  const key = "alerts/sc2-3d/zealot-dance-3d.webm";
  const client = { send: jest.fn(async () => ({ Contents: [{ Key: key }] })) };
  const signer = jest.fn(async (_client, command) => `https://media.invalid/${command.input.Key}?synthetic-grant=1`);
  const media = new AlertMediaStore({ client, bucket: "synthetic-local-only", signer });
  const app = express();
  app.use("/v1", buildMultichatRouter({ overlayTokens: tokens, users: { getPreferences: async () => prefs, isAdminUserId: async userId => userId === "owner" }, sounds, alertMedia: media, studio: new MultichatStudioService(db, { overlayTokens: tokens }), tiktokRelay: {} }));
  const before = await request(app).get(`/v1/multichat/${original.token}/config`).expect(200);
  expect(before.body.config.sound.customSounds[0].url).toContain(original.token);
  const { token: replacement } = await tokens.rotate("owner", original.token);
  const after = await request(app).get(`/v1/multichat/${replacement}/config`).expect(200);
  const source = after.body.config.sound.customSounds[0];
  expect(source).toEqual({ id: "c-victory", label: "Victory", kind: "upload", url: `/v1/multichat/${replacement}/sound/${sound.soundId}` });
  expect(after.body.config.sound.customSounds[1].url).toBe(source.url);
  const served = await request(app).get(source.url).expect(200);
  expect(served.body).toEqual(bytes);
  await request(app).get(`/v1/multichat/${original.token}/sound/${sound.soundId}`).expect(401);
  const grant = await request(app).get(`/v1/multichat/${replacement}/alert-media`).expect(200);
  expect(JSON.stringify(grant.body)).toContain(key);
  expect(JSON.stringify({ config: after.body, grant: grant.body, studio: await new MultichatStudioService(db).get(replacement) })).not.toContain(original.token);
  expect(signer.mock.calls[0][1].input.Key).toBe(key);
  expect((await db.multichatSounds.findOne({ soundId: sound.soundId })).userId).toBe("owner");
});


test("terminal A→B→C receipts repair non-default sources and old retries never resurrect revoked targets", async () => {
  const other = await tokens.create("owner", "Unrelated default");
  const b = await tokens.rotate("owner", original.token);
  const c = await tokens.rotate("owner", b.token);
  expect(await tokens.replacementReceipts("owner")).toEqual(expect.arrayContaining([{ from: original.token, to: c.token }, { from: b.token, to: c.token }]));
  expect(await tokens.rotate("owner", original.token)).toEqual({ pending: false, token: c.token });
  expect(await tokens.resolve(other.token)).toMatchObject({ label: "Unrelated default" });
  await tokens.revoke("owner", c.token);
  expect(await tokens.rotate("owner", original.token)).toEqual({ pending: false, unavailable: true, revoked: true });
  expect(await tokens.resolve(b.token)).toBeNull(); expect(await tokens.resolve(c.token)).toBeNull();
  expect(await tokens.replacementReceipts("owner")).toEqual([]);
  expect(await db.overlayTokens.countDocuments({ userId: "owner" })).toBe(4);
});

test("cyclic or overlong replacement chains stop at a fixed hop bound", async () => {
  const { replacementTargets } = require("../src/services/overlayTokenRotation");
  const collection = { find: jest.fn(() => { throw new Error("all nodes already seeded"); }) };
  const rows = Array.from({ length: 17 }, (_, i) => ({ token: String(i), revokedAt: new Date(), _rotation: { state: "complete", to: String((i + 1) % 17) } }));
  const result = await replacementTargets(collection, "owner", new Map([["source", "0"]]), rows);
  expect(result.get("source")).toEqual({}); expect(collection.find).not.toHaveBeenCalled();
});


test("recent rotation of an old-created token enters bounded offline receipts", async () => {
  await db.overlayTokens.updateOne({ token: original.token }, { $set: { createdAt: new Date("1990-01-01") } });
  const result = await tokens.rotate("owner", original.token);
  await db.overlayTokens.insertMany(Array.from({ length: 33 }, (_, i) => ({ userId: "owner", token: `old-receipt-${i}`, createdAt: new Date("2100-01-01"), revokedAt: new Date("2000-01-01"), _rotation: { state: "complete", startedAt: new Date("2000-01-01"), to: result.token } })));
  const receipts = await tokens.replacementReceipts("owner");
  expect(receipts).toHaveLength(32);
  expect(receipts).toContainEqual({ from: original.token, to: result.token });
});
