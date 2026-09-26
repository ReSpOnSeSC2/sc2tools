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
  expect((await request(app).get(`${base}/manifest`).set("x-user", "other")).status).toBe(404);
});
