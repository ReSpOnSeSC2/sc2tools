"use strict";

const { Readable } = require("stream");
const { createHash } = require("crypto");
const express = require("express");
const request = require("supertest");
const { PlaybackArtifactsService } = require("../src/services/playbackArtifacts");
const { buildPlaybackArtifactsRouter } = require("../src/routes/playbackArtifacts");
const { validateManifest, validateSegment } = require("../src/validation/playbackArtifact");

const sha = (/** @type {Buffer} */ body) => createHash("sha256").update(body).digest("hex");
function fixture() {
  const segment = { schema: "sc2tools-playback-segment-v1", replaySha256: "a".repeat(64), index: 0, start: 0, end: 60,
    playback: { v: 7, terminalAttackInclusive: true, replaySha256: "a".repeat(64), mapName: "Map", gameLength: 60,
      fidelity: { positions: "engine", complete: true, positionError: .15 },
      bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      units: [{ id: 1, name: "Marine", owner: "me", born: 0, died: 60, wp: [0, 1, 1, 60, 1, 1], attacks: [60], aim: [60, 2, 2] }],
      buildings: [], casts: [], effects: [], resources: [] } };
  const body = Buffer.from(JSON.stringify(segment));
  const manifest = { schema: "sc2tools-playback-manifest-v1", replaySha256: "a".repeat(64), sourceArtifactSha256: "b".repeat(64),
    mapName: "Map", gameLength: 60, fidelity: { positions: "engine", complete: true, positionError: .15 },
    segments: [{ index: 0, start: 0, end: 60, points: 2, sizeBytes: body.length, sha256: sha(body) }] };
  return { segment, body, manifest };
}

function setup() {
  /** @type {Map<string, {body: Buffer, metadata: Record<string,string>}>} */
  const objects = new Map();
  /** @type {any} */
  const game = { userId: "owner", gameId: "game", replayFile: { sha256: "a".repeat(64) } };
  const games = {
    findOne: jest.fn(async (/** @type {any} */ query) => query.userId === game.userId && query.gameId === game.gameId ? game : null),
    updateOne: jest.fn(async (/** @type {any} */ _query, /** @type {any} */ update) => { Object.assign(game, update.$set); return { matchedCount: 1 }; }),
  };
  const client = { send: jest.fn(async (/** @type {any} */ command) => {
    const input = command.input;
    if (command.constructor.name === "PutObjectCommand") { objects.set(input.Key, { body: Buffer.from(input.Body), metadata: input.Metadata || {} }); return {}; }
    if (command.constructor.name === "ListObjectsV2Command") return { Contents: [...objects.keys()].filter((key) => key.startsWith(input.Prefix)).map((Key) => ({ Key })) };
    if (command.constructor.name === "DeleteObjectsCommand") { input.Delete.Objects.forEach((/** @type {{Key:string}} */ o) => objects.delete(o.Key)); return {}; }
    const item = objects.get(input.Key);
    if (!item) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
    return { Body: Readable.from([item.body]), ContentLength: item.body.length, Metadata: item.metadata };
  }) };
  const service = new PlaybackArtifactsService({ client: /** @type {any} */ (client), bucket: "test", games: /** @type {any} */ (games) });
  return { service, objects, game, games, client };
}

test("complete is the publication point and reads preserve exact bytes", async () => {
  const { service } = setup();
  const { manifest, body } = fixture();
  const { artifactId } = await service.prepare("owner", "game", manifest);
  await expect(service.getManifest("owner", "game")).rejects.toMatchObject({ status: 404 });
  await expect(service.complete("owner", "game", artifactId)).rejects.toMatchObject({ status: 409 });
  await service.upload("owner", "game", artifactId, 0, body);
  await service.upload("owner", "game", artifactId, 0, body);
  await service.complete("owner", "game", artifactId);
  expect((await service.getManifest("owner", "game")).manifest).toEqual(manifest);
  expect(await service.getSegment("owner", "game", artifactId, 0)).toEqual(body);
});

test("ownership, source identity and segment integrity are fail closed", async () => {
  const { service } = setup();
  const { manifest, body } = fixture();
  await expect(service.prepare("other", "game", manifest)).rejects.toMatchObject({ status: 404 });
  await expect(service.prepare("owner", "game", { ...manifest, replaySha256: "c".repeat(64) })).rejects.toMatchObject({ status: 409 });
  const { artifactId } = await service.prepare("owner", "game", manifest);
  await expect(service.upload("owner", "game", artifactId, 0, Buffer.from("{}"))).rejects.toMatchObject({ status: 400 });
  await expect(service.upload("owner", "game", artifactId, -1, body)).rejects.toMatchObject({ status: 400 });
  await expect(service.getSegment("other", "game", artifactId, 0)).rejects.toMatchObject({ status: 404 });
});

test("missing/corrupt R2 data cannot complete or be read as verified", async () => {
  const { service, objects } = setup();
  const { manifest, body } = fixture();
  const { artifactId } = await service.prepare("owner", "game", manifest);
  await service.upload("owner", "game", artifactId, 0, body);
  await service.complete("owner", "game", artifactId);
  const key = service.key("owner", "game", artifactId, "0.json");
  objects.set(key, { body: Buffer.from("corrupt"), metadata: { sha256: manifest.segments[0].sha256 } });
  await expect(service.complete("owner", "game", artifactId)).rejects.toMatchObject({ status: 409 });
  await expect(service.getSegment("owner", "game", artifactId, 0)).rejects.toMatchObject({ status: 502 });
});

test("bounds, complete coverage, point counts and terminal shots are validated", () => {
  const { manifest, segment } = fixture();
  expect(validateSegment(segment, manifest, manifest.segments[0])).toBe(segment);
  expect(() => validateManifest({ ...manifest, segments: [{ ...manifest.segments[0], start: 1 }] })).toThrow();
  expect(() => validateManifest({ ...manifest, segments: [{ ...manifest.segments[0], sizeBytes: 2 * 1024 * 1024 + 1 }] })).toThrow();
  expect(() => validateSegment(segment, manifest, { ...manifest.segments[0], points: 3 })).toThrow();
  segment.playback.units[0].attacks = [61];
  expect(() => validateSegment(segment, manifest, manifest.segments[0])).toThrow();
});

test("GDPR cleanup removes pending and committed generations only for owner", async () => {
  const { service, objects } = setup();
  const { manifest, body } = fixture();
  const { artifactId } = await service.prepare("owner", "game", manifest);
  await service.upload("owner", "game", artifactId, 0, body);
  objects.set(service.key("other", "game", artifactId, "0.json"), { body, metadata: {} });
  await service.deleteMany("owner", ["game"]);
  expect(objects.size).toBe(1);
  expect([...objects.keys()][0]).toContain("/other/");
});

/** @param {import('mongodb').Collection} games */
function versionedStorage(games) {
  const { service: legacy, client, objects } = setup();
  const signer = jest.fn(async (
    /** @type {any} */ _client,
    /** @type {any} */ command,
    /** @type {any} */ options,
  ) => `https://storage.example/${command.input.Key}?ttl=${options.expiresIn}`);
  legacy.games = games;
  const options = { client: /** @type {any} */ (client), bucket: "test", games,
    keySecret: Buffer.alloc(32, 41), signer: /** @type {any} */ (signer) };
  const opaque = new PlaybackArtifactsService(options);
  const replica = new PlaybackArtifactsService(options);
  return { legacy, opaque, replica, signer, objects, client };
}

test("legacy and opaque generations with the same ID remain readable and are deleted by owner", async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { connect } = require("../src/db/connect");
  const mongo = await MongoMemoryServer.create();
  const db = await connect({ uri: mongo.getUri(), dbName: "playback_storage_layout_test" });
  try {
    const { legacy, opaque, replica, signer, objects } = versionedStorage(db.games);
    const owner = "private-owner";
    const gameId = "2026-11-01T20:00:00|PrivateRival#1234|Map|700";
    const { manifest, body } = fixture();
    await db.games.insertOne({ userId: owner, gameId });
    const { artifactId } = await legacy.prepare(owner, gameId, manifest);

    // A retried legacy prepare and the remainder of that upload stay on v1.
    expect(await opaque.prepare(owner, gameId, manifest)).toEqual({ ok: true, artifactId });
    await opaque.upload(owner, gameId, artifactId, 0, body);
    await opaque.complete(owner, gameId, artifactId);
    expect(await opaque.getSegment(owner, gameId, artifactId, 0)).toEqual(body);
    const ownerLink = await opaque.signSegment(owner, gameId, artifactId, 0, 60);
    expect(decodeURIComponent(ownerLink.url)).toContain("PrivateRival#1234");
    signer.mockClear();
    await expect(opaque.signSegment(owner, gameId, artifactId, 0, 60, { requireOpaque: true }))
      .rejects.toMatchObject({ status: 404, code: "playback_direct_unavailable" });
    expect(signer).not.toHaveBeenCalled();

    // A new v2 prepare of identical content leaves the v1 recording usable
    // until the v2 segment arrives and completion publishes its marker.
    expect(await opaque.prepare(owner, gameId, manifest)).toEqual({ ok: true, artifactId });
    expect((await db.games.findOne({ userId: owner, gameId }))?.playbackUpload).toMatchObject({ artifactId, storageVersion: 2 });
    expect((await opaque.getManifest(owner, gameId)).manifest).toEqual(manifest);
    expect(await opaque.getSegment(owner, gameId, artifactId, 0)).toEqual(body);
    await expect(opaque.complete(owner, gameId, artifactId)).rejects.toMatchObject({ status: 409, code: "playback_segments_incomplete" });
    await opaque.upload(owner, gameId, artifactId, 0, body);
    const completion = { ok: true, artifactId, segmentCount: 1 };
    await expect(Promise.all([
      opaque.complete(owner, gameId, artifactId),
      replica.complete(owner, gameId, artifactId),
    ])).resolves.toEqual([completion, completion]);
    await expect(opaque.complete(owner, gameId, artifactId)).resolves.toEqual(completion);
    expect(await opaque.getSegment(owner, gameId, artifactId, 0, { requireOpaque: true })).toEqual(body);
    const link = await opaque.signSegment(owner, gameId, artifactId, 0, 60, { requireOpaque: true });
    expect(link).toEqual({
      url: expect.stringMatching(/^https:\/\/storage\.example\/mapped-playback\/v2\/[a-f0-9]{64}\/[a-f0-9]{64}\/[a-f0-9]{64}\/0\.json\?ttl=60$/), expiresIn: 60,
    });
    for (const identifier of [owner, gameId, "PrivateRival"]) expect(decodeURIComponent(link.url)).not.toContain(identifier);
    await expect(opaque.signSegment("another-owner", gameId, artifactId, 0, 60, { requireOpaque: true }))
      .rejects.toMatchObject({ status: 404 });

    const untouched = [opaque.key("another-owner", gameId, artifactId, "0.json"),
      opaque.key("another-owner", gameId, artifactId, "0.json", 2)];
    const secondGame = [opaque.key(owner, "different-game", artifactId, "0.json"),
      opaque.key(owner, "different-game", artifactId, "0.json", 2)];
    for (const key of [...untouched, ...secondGame]) objects.set(key, { body, metadata: {} });
    await opaque.deleteMany(owner, [gameId]);
    expect([...objects.keys()].sort()).toEqual([...untouched, ...secondGame].sort());
    await opaque.deleteAllForUser(owner);
    expect([...objects.keys()].sort()).toEqual(untouched.sort());
  } finally {
    await db.close();
    await mongo.stop();
  }
});

/** @param {ReturnType<typeof setup>["client"]} client */
function holdNextHead(client) {
  let markStarted = () => {};
  let release = () => {};
  const started = new Promise(resolve => { markStarted = () => resolve(undefined); });
  const wait = new Promise(resolve => { release = () => resolve(undefined); });
  const send = client.send.getMockImplementation();
  if (!send) throw new Error("Missing S3 test transport");
  let held = false;
  client.send.mockImplementation(async command => {
    if (!held && command.constructor.name === "HeadObjectCommand") {
      held = true;
      markStarted();
      await wait;
    }
    return send(command);
  });
  return { started, release };
}

test.each(["pending", "published"])("a stale %s completion leaves a newer same-content generation intact", async state => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { connect } = require("../src/db/connect");
  const { NotificationsService } = require("../src/services/notifications");
  const { startPlaybackJob, updatePlaybackJob } = require("../src/services/replayPlaybackJobs");
  const mongo = await MongoMemoryServer.create();
  const db = await connect({ uri: mongo.getUri(), dbName: "playback_generation_test" });
  try {
    const { opaque, replica, client } = versionedStorage(db.games);
    const notifications = new NotificationsService(db);
    const notify = jest.spyOn(notifications, "notify");
    opaque.notifications = replica.notifications = notifications;
    const userId = `generation-${state}`, gameId = "same-game";
    const query = { userId, gameId };
    await db.users.insertOne({ userId });
    await db.games.insertOne(query);
    const first = startPlaybackJob(userId, gameId).job;
    const { manifest, body } = fixture();
    const { artifactId } = await opaque.prepare(userId, gameId, manifest);
    await opaque.upload(userId, gameId, artifactId, 0, body);
    if (state === "published") await opaque.complete(userId, gameId, artifactId);
    const oldField = state === "published" ? "playbackArtifact" : "playbackUpload";
    await db.games.updateOne(query, { $unset: { [`${oldField}.generationId`]: "" } });
    notify.mockClear();

    const hold = holdNextHead(client);
    const completion = { ok: true, artifactId, segmentCount: 1 };
    const stale = opaque.complete(userId, gameId, artifactId);
    const result = state === "published" ? expect(stale).resolves.toEqual(completion)
      : expect(stale).rejects.toMatchObject({ status: 503, code: "playback_artifact_busy" });
    let next;
    try {
      await hold.started;
      updatePlaybackJob(userId, gameId, first.requestId, { status: "failed" });
      next = startPlaybackJob(userId, gameId).job;
      await replica.prepare(userId, gameId, manifest);
      if (state === "published") await replica.complete(userId, gameId, artifactId);
    } finally { hold.release(); }
    await result;
    if (state === "pending") {
      expect((await db.games.findOne(query))?.playbackUpload).toMatchObject({ artifactId, requestId: next.requestId });
      expect(notify).not.toHaveBeenCalled();
      await expect(opaque.complete(userId, gameId, artifactId)).resolves.toEqual(completion);
    }
    expect((await db.games.findOne(query))?.playbackArtifact).toMatchObject({ artifactId, requestId: next.requestId });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(userId, expect.objectContaining({ eventKey: `playback_ready:${gameId}:${next.requestId}` }));
  } finally { await db.close(); await mongo.stop(); }
});

test("bounded read and write lanes reject excess work immediately", async () => {
  const { service } = setup();
  service.activeWrites = 1;
  await expect(service.prepare("owner", "game", fixture().manifest)).rejects.toMatchObject({ status: 503 });
  service.activeReads = 2;
  await expect(service.getManifest("owner", "game")).rejects.toMatchObject({ status: 503 });
});

test("a PUT finishing after ownership deletion cleans its late object", async () => {
  const { service, objects, games, client } = setup();
  const { manifest, body } = fixture();
  const { artifactId } = await service.prepare("owner", "game", manifest);
  const original = client.send.getMockImplementation();
  if (!original) throw new Error("Missing S3 test transport");
  client.send.mockImplementation(async (command) => {
    const result = await original(command);
    if (command.constructor.name === "PutObjectCommand") games.findOne.mockResolvedValue(null);
    return result;
  });
  await expect(service.upload("owner", "game", artifactId, 0, body)).rejects.toMatchObject({ status: 404 });
  expect(objects.size).toBe(0);
});

test("only exact authenticated segment PUTs enter the existing large-body lane", () => {
  const { _internals } = require("../src/app");
  const path = `/v1/games/game/map-playback/artifacts/${"a".repeat(64)}/segments/0`;
  const matches = (/** @type {string} */ method, /** @type {string} */ originalUrl) => _internals.isLargeAuthenticatedJson(/** @type {any} */ ({ method, originalUrl }));
  expect(matches("PUT", path)).toBe(true);
  expect(matches("POST", path)).toBe(false);
  expect(matches("GET", path)).toBe(false);
  expect(matches("PUT", path + "/extra")).toBe(false);
  expect(matches("PUT", "/v1/games/game/map-playback/artifacts")).toBe(false);
});

test("routes require device writes, allow owner reads and preserve raw bytes", async () => {
  const { service } = setup();
  const app = express();
  app.use((_req, res, next) => { res.vary("Origin"); next(); });
  app.use(express.json({ limit: "5mb", verify: (req, _res, body) => { /** @type {any} */ (req).playbackRawBody = body; } }));
  const auth = (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ _res, /** @type {import('express').NextFunction} */ next) => {
    req.auth = /** @type {any} */ ({ userId: req.headers["x-user"] || "owner", source: req.headers["x-source"] || "clerk" }); next();
  };
  app.use("/v1", buildPlaybackArtifactsRouter({ playbackArtifacts: service, auth }));
  app.use((/** @type {any} */ err, /** @type {any} */ _req, /** @type {any} */ res, /** @type {any} */ _next) => res.status(err.status || 500).json({ error: { code: err.code } }));
  const { manifest, body } = fixture();
  const base = "/v1/games/game/map-playback";
  expect((await request(app).post(`${base}/artifacts`).send({ manifest })).status).toBe(403);
  const prepared = await request(app).post(`${base}/artifacts`).set("x-source", "device").send({ manifest });
  const id = prepared.body.artifactId;
  expect(prepared.status).toBe(200);
  expect((await request(app).put(`${base}/artifacts/${id}/segments/0`).set("x-source", "device").set("content-type", "application/json").send(body.toString())).status).toBe(200);
  expect((await request(app).post(`${base}/artifacts/${id}/complete`).set("x-source", "device").send({})).status).toBe(200);
  const response = await request(app).get(`${base}/artifacts/${id}/segments/0`);
  expect(Buffer.from(response.text)).toEqual(body);
  expect(response.headers["cache-control"]).toBe("private, max-age=604800, immutable");
  expect(response.headers.vary).toContain("Authorization");
  expect(response.headers.vary).toContain("Origin");
  expect((await request(app).get(`${base}/manifest`)).headers["cache-control"]).toBe("private, no-store");
  expect((await request(app).get(`${base}/manifest`).set("x-user", "other")).status).toBe(404);
});

test("requested artifact completion creates one durable private notification; reads and automatic uploads do not", async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const { connect } = require("../src/db/connect");
  const { NotificationsService } = require("../src/services/notifications");
  const { startPlaybackJob } = require("../src/services/replayPlaybackJobs");
  const mongo = await MongoMemoryServer.create();
  const db = await connect({ uri: mongo.getUri(), dbName: "playback_ready_test" });
  try {
    const { service } = setup();
    service.games = db.games;
    service.notifications = new NotificationsService(db);
    await db.users.insertOne({ userId: "owner" });
    await db.games.insertOne({ userId: "owner", gameId: "game", myRace: "Protoss", opponent: { race: "Zerg" }, map: "Alcyone LE" });
    const { manifest, body } = fixture();
    startPlaybackJob("owner", "game");
    const { artifactId } = await service.prepare("owner", "game", manifest);
    await service.upload("owner", "game", artifactId, 0, body);
    expect(await db.notifications.countDocuments({})).toBe(0);
    await service.complete("owner", "game", artifactId);
    await service.complete("owner", "game", artifactId);
    await service.getManifest("owner", "game");
    await service.getSegment("owner", "game", artifactId, 0);
    const rows = await db.notifications.find({ userId: "owner" }).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "playback_ready", count: 1, groupKey: "game",
      title: "Accurate playback ready: PvZ on Alcyone LE", href: "/app/game/game#replay" });
    await db.games.insertOne({ userId: "owner", gameId: "automatic" });
    const automatic = await service.prepare("owner", "automatic", manifest);
    await service.upload("owner", "automatic", automatic.artifactId, 0, body);
    await service.complete("owner", "automatic", automatic.artifactId);
    expect(await db.notifications.countDocuments({})).toBe(1);
  } finally { await db.close(); await mongo.stop(); }
});

test("segment links are presigned only for the current completed artifact's segments", async () => {
  const { service } = setup();
  const signer = jest.fn(async (/** @type {any} */ _client, /** @type {any} */ command, /** @type {any} */ opts) => `https://r2.example/${command.input.Key}?X-Amz-Expires=${opts.expiresIn}`);
  service.signer = /** @type {any} */ (signer);
  const { manifest, body } = fixture();
  const { artifactId } = await service.prepare("owner", "game", manifest);
  await service.upload("owner", "game", artifactId, 0, body);
  await expect(service.signSegment("owner", "game", artifactId, 0, 60)).rejects.toMatchObject({ status: 404 });
  await service.complete("owner", "game", artifactId);
  const link = await service.signSegment("owner", "game", artifactId, 0, 60);
  expect(link).toEqual({ url: `https://r2.example/${service.key("owner", "game", artifactId, "0.json")}?X-Amz-Expires=60`, expiresIn: 60 });
  await expect(service.signSegment("owner", "game", artifactId, 1, 60)).rejects.toMatchObject({ status: 404 });
  await expect(service.signSegment("owner", "game", "d".repeat(64), 0, 60)).rejects.toMatchObject({ status: 404 });
  await expect(service.signSegment("other", "game", artifactId, 0, 60)).rejects.toMatchObject({ status: 404 });
  expect(signer).toHaveBeenCalledTimes(1);
});


test("admits bounded camera tracks and chronological cast indexes", () => {
  const { segment, manifest } = fixture();
  const indexed = { ...manifest, timeline: { casts: [{ t: 10, o: 0, a: "PsiStorm" }, { t: 15, o: 1, a: "EMP" }] } };
  expect(validateManifest(indexed)).toBe(indexed);
  expect(() => validateManifest({ ...indexed, timeline: { casts: [...indexed.timeline.casts].reverse() } })).toThrow();
  const camera = { ...segment, playback: { ...segment.playback, camera: { me: [0, 50, 50, 12, 60, 60] } } };
  expect(() => validateSegment(camera, manifest, manifest.segments[0])).not.toThrow();
  camera.playback.camera.me = [12, 50, 50, 0, 60, 60];
  expect(() => validateSegment(camera, manifest, manifest.segments[0])).toThrow();
});
