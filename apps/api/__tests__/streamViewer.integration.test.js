// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { ObjectId } = require("mongodb");
const { connect } = require("../src/db/connect");
const { buildStreamViewerRouter } = require("../src/routes/streamViewer");
const { StreamViewerService } = require("../src/services/streamViewer");
const { PublicPlayerPreferencesService } = require("../src/services/publicPlayerPreferences");
const { SECTION_KEYS, playerError } = require("../src/util/publicPlayerConfig");
const { sha256 } = require("../src/util/hash");
const { buildErrorHandler } = require("../src/middleware/errorHandler");

const OWNER = "viewer-owner-private", OTHER = "other-owner-private";
const SLUG = "streamer-0123456789", PUBLIC = `/v1/public/players/${SLUG}/live`, SETTINGS = "/v1/me/stream-viewer";
const RAW = "private-browser-source-credential", ALT = "private-secondary-credential";
const SOURCE = new ObjectId(), SECOND = new ObjectId(), FOREIGN = new ObjectId();
const NOW = Date.parse("2026-11-11T12:00:00Z"), CUTOFF = NOW - 300_000, START = NOW - 900_000;
const input = (tokenId = SOURCE.toHexString(), revision = 0, delayMinutes = 5) => ({ tokenId, revision, delayMinutes });

let mongo, db, viewer, app, log, now;

function makeApp(limit) {
  const server = express();
  server.use(express.json());
  server.use("/v1", buildStreamViewerRouter({ viewer, limit, auth(req, _res, next) {
    const [source, userId] = (req.get("authorization") ?? "").split(" ");
    if (!userId) { next(playerError(401, "missing_token", "Sign in first.")); return; }
    req.auth = { source, userId }; next();
  } }));
  server.use(buildErrorHandler(log));
  return server;
}

function ownerRequest(method, data) {
  const call = request(app)[method](SETTINGS).set("authorization", `clerk ${OWNER}`);
  return data ? call.send(data) : call;
}

function game(end, overrides = {}) {
  return { userId: OWNER, date: new Date(end), durationSec: 90, matchFormat: "1v1",
    gameId: `private-game-${new ObjectId()}`, result: "Victory", myToonHandle: "private-toon",
    map: "deathaura le", opponent: { race: "P", name: "private-opponent", mmr: 4217 },
    ...overrides };
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  db = await connect({ uri: mongo.getUri(), dbName: "sc2tools_test_stream_viewer" });
});

afterAll(async () => { if (db) await db.close(); if (mongo) await mongo.stop(); });

beforeEach(async () => {
  now = NOW;
  viewer = new StreamViewerService(db, () => now);
  log = { error: jest.fn() };
  app = makeApp();
  await Promise.all([db.users.deleteMany({}), db.games.deleteMany({}), db.overlayTokens.deleteMany({})]);
  await db.users.insertOne({ userId: OWNER, displayName: "private-owner-name", publicProfile: { enabled: true },
    replaySharing: { enabled: false, slug: SLUG }, streamSession: { startAt: new Date(START), viewerSource: sha256(RAW) } });
  await db.overlayTokens.insertMany([
    { _id: SOURCE, userId: OWNER, label: "Main Dock", token: RAW },
    { _id: SECOND, userId: OWNER, label: "Other Dock", token: ALT },
    { _id: FOREIGN, userId: OTHER, label: "Foreign Dock", token: "foreign-private" },
  ]);
});

test("publication defaults off and owner admission, source lists and writes are isolated", async () => {
  await request(app).get(PUBLIC).expect(404).expect("Cache-Control", /no-store/).expect("X-Robots-Tag", /noindex/);
  await request(app).put(SETTINGS).send(input()).expect(401);
  await request(app).put(SETTINGS).set("authorization", `device ${OWNER}`).send(input()).expect(403);
  const settings = await ownerRequest("get").expect(200).expect("Cache-Control", /no-store/);
  expect(settings.body).toEqual({ eligible: true, tokenId: null, delayMinutes: 5, revision: 0, href: null,
    sources: [{ id: SECOND.toHexString(), label: "Other Dock" }, { id: SOURCE.toHexString(), label: "Main Dock" }] });
  expect(settings.text).not.toMatch(/private|Foreign/);
  await ownerRequest("put", input(FOREIGN.toHexString())).expect(404);
  await ownerRequest("put", { ...input(), userId: OTHER }).expect(400);
  await ownerRequest("put", input(SOURCE.toHexString(), 0, 4)).expect(400);
  await ownerRequest("put", input(SOURCE.toHexString(), 0, 61)).expect(400);
  await db.users.updateOne({ userId: OWNER }, { $unset: { "publicProfile.enabled": "" } });
  await ownerRequest("put", input()).expect(409);
  await db.users.updateOne({ userId: OWNER }, { $set: { "publicProfile.enabled": true } });
  const saved = await ownerRequest("put", input()).expect(200);
  expect(saved.body.href).toBe(`/p/${SLUG}/live`);
  await ownerRequest("put", input()).expect(409);
});

test("selects only complete games fully within the bound session and past the exact delay", async () => {
  await ownerRequest("put", input()).expect(200);
  await db.games.insertMany([
    game(CUTOFF), game(CUTOFF - 1, { result: "Defeat", map: "private-map-name", opponent: { race: "private-value" } }),
    game(CUTOFF + 1), game(NOW), game(NOW + 1), game(CUTOFF, { result: "Playing" }),
    game(START + 89_999), game(CUTOFF, { durationSec: 0 }), game(CUTOFF, { durationSec: null }),
    game(CUTOFF, { excluded: true }), game(CUTOFF, { isResumedFromReplay: true }),
    game(CUTOFF, { _deletionPending: true }), game(CUTOFF, { _deleted: true }),
    game(CUTOFF, { matchFormat: "team" }), game(CUTOFF, { userId: OTHER }),
  ]);
  const response = await request(app).get(PUBLIC).expect(200).expect("Cache-Control", /no-store/);
  expect(response.body).toEqual({ games: [{ result: "win", opponentRace: "Protoss", map: "Deathaura LE" },
    { result: "loss", opponentRace: null, map: null }], wins: 1, losses: 1, delayMinutes: 5 });
  expect(response.text).not.toMatch(/private|4217|2026|streamer/);
  await ownerRequest("put", input(SOURCE.toHexString(), 1, 10)).expect(200);
  expect((await request(app).get(PUBLIC).expect(200)).body).toEqual({ games: [], wins: 0, losses: 0, delayMinutes: 10 });
  now += 300_001;
  expect((await request(app).get(PUBLIC).expect(200)).body.games).toHaveLength(3);
});

test("legacy, ended and other-source sessions cannot supply rows", async () => {
  await ownerRequest("put", input()).expect(200);
  await db.games.insertOne(game(CUTOFF));
  expect((await viewer.read(SLUG)).wins).toBe(1);
  for (const update of [{ $unset: { "streamSession.viewerSource": "" } },
    { $set: { "streamSession.viewerSource": sha256(ALT) } }, { $unset: { streamSession: "" } }]) {
    await db.users.updateOne({ userId: OWNER }, update);
    expect((await viewer.read(SLUG)).games).toEqual([]);
  }
});

test("profile opt-out, source rotation and revocation bypass a warm result cache", async () => {
  await ownerRequest("put", input()).expect(200);
  await db.games.insertOne(game(CUTOFF));
  await request(app).get(PUBLIC).expect(200);
  await db.overlayTokens.updateOne({ _id: SOURCE }, { $set: { _rotationPending: true } });
  await request(app).get(PUBLIC).expect(404);
  await ownerRequest("put", input(SOURCE.toHexString(), 1)).expect(404);
  await db.overlayTokens.updateOne({ _id: SOURCE }, { $unset: { _rotationPending: "" }, $set: { revokedAt: new Date(NOW) } });
  await request(app).get(PUBLIC).expect(404);
  await ownerRequest("put", input(SECOND.toHexString(), 1)).expect(200);
  const profile = new PublicPlayerPreferencesService(db, { community: { getAuthor: async () => null } });
  const sections = Object.fromEntries(SECTION_KEYS.map(key => [key, false]));
  await profile.set(OWNER, { enabled: false, revision: 0, slug: SLUG, ...sections });
  await request(app).get(PUBLIC).expect(404);
  await profile.set(OWNER, { enabled: true, revision: 1, slug: SLUG, ...sections });
  await request(app).get(PUBLIC).expect(404);
  expect((await ownerRequest("get").expect(200)).body.tokenId).toBeNull();
});

test("revocation during a data read discards results before the response", async () => {
  await ownerRequest("put", input()).expect(200);
  await db.games.insertOne(game(CUTOFF));
  const load = viewer.load.bind(viewer);
  jest.spyOn(viewer, "load").mockImplementation(async (...args) => {
    const result = await load(...args);
    await viewer.setSettings(OWNER, input(null, 1));
    return result;
  });
  await request(app).get(PUBLIC).expect(404);
  expect(viewer.cache.size).toBe(0);
});

test("public failures are redacted and limited independently of authenticated settings", async () => {
  app = makeApp(2);
  jest.spyOn(viewer, "read").mockRejectedValue(new Error(`unsafe ${SLUG} ${RAW}`));
  const response = await request(app).get(PUBLIC).expect(503).expect("Cache-Control", /no-store/);
  expect(response.text).not.toContain(SLUG);
  expect(JSON.stringify(log.error.mock.calls)).not.toMatch(/unsafe|streamer|private-browser/);
  await request(app).get(PUBLIC).expect(503);
  await request(app).get(PUBLIC).expect(429).expect("Cache-Control", /no-store/);
  await ownerRequest("get").expect(200);
});
