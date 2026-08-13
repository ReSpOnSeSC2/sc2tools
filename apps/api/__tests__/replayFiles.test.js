// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { Readable } = require("stream");

const {
  ReplayFilesService,
  buildReplayFilesFromConfig,
} = require("../src/services/replayFiles");
const { buildReplayFilesRouter } = require("../src/routes/replayFiles");
const { GdprService, USER_SCOPED_COLLECTIONS } = require("../src/services/gdpr");

const SHA = "a".repeat(64);
const MD5 = "AAAAAAAAAAAAAAAAAAAAAA==";
const OTHER_MD5 = "AQEBAQEBAQEBAQEBAQEBAQ==";
const MPQ = Buffer.from([0x4d, 0x50, 0x51, 0x1b, 1, 2, 3, 4]);

class FakeGames {
  constructor(rows = []) {
    this.rows = rows.map((row) => ({ ...row }));
  }

  async findOne(filter) {
    return this.rows.find(
      (row) => row.userId === filter.userId && row.gameId === filter.gameId,
    ) || null;
  }

  async updateOne(filter, update) {
    const row = this.rows.find((candidate) => matches(candidate, filter));
    if (!row) return { matchedCount: 0, modifiedCount: 0 };
    for (const [path, value] of Object.entries(update.$set || {})) {
      setPath(row, path, value);
    }
    for (const path of Object.keys(update.$unset || {})) deletePath(row, path);
    return { matchedCount: 1, modifiedCount: 1 };
  }
}

function matches(row, filter) {
  return Object.entries(filter).every(([path, expected]) => {
    const actual = getPath(row, path);
    if (expected && typeof expected === "object" && "$exists" in expected) {
      return expected.$exists ? actual !== undefined : actual === undefined;
    }
    return actual === expected;
  });
}

function getPath(object, path) {
  return path.split(".").reduce((value, key) => value?.[key], object);
}

function setPath(object, path, value) {
  const parts = path.split(".");
  const leaf = parts.pop();
  let target = object;
  for (const part of parts) target = target[part] ||= {};
  target[leaf] = value;
}

function deletePath(object, path) {
  const parts = path.split(".");
  const leaf = parts.pop();
  const target = parts.reduce((value, key) => value?.[key], object);
  if (target) delete target[leaf];
}

class FakeS3 {
  constructor() {
    this.objects = new Map();
    this.commands = [];
    this.deleteErrors = [];
  }

  put(key, body = MPQ, metadata = { sha256: SHA }) {
    this.objects.set(key, { body: Buffer.from(body), metadata });
  }

  async send(command) {
    this.commands.push(command);
    const { input } = command;
    switch (command.constructor.name) {
      case "HeadObjectCommand": {
        const object = this.objects.get(input.Key);
        if (!object) throw notFound();
        return { ContentLength: object.body.length, Metadata: object.metadata };
      }
      case "GetObjectCommand": {
        const object = this.objects.get(input.Key);
        if (!object) throw notFound();
        const body = input.Range === "bytes=0-3"
          ? object.body.subarray(0, 4)
          : object.body;
        return { Body: Readable.from([body]) };
      }
      case "CopyObjectCommand": {
        const encodedSource = input.CopySource.split("/").slice(1);
        const sourceKey = encodedSource.map(decodeURIComponent).join("/");
        const object = this.objects.get(sourceKey);
        if (!object) throw notFound();
        this.objects.set(input.Key, {
          body: Buffer.from(object.body),
          metadata: { ...object.metadata },
        });
        return { CopyObjectResult: { ETag: "fake" } };
      }
      case "DeleteObjectCommand":
        this.objects.delete(input.Key);
        return {};
      case "DeleteObjectsCommand":
        for (const item of input.Delete.Objects) this.objects.delete(item.Key);
        return { Errors: this.deleteErrors };
      case "ListObjectsV2Command":
        return {
          Contents: [...this.objects.keys()]
            .filter((key) => key.startsWith(input.Prefix))
            .map((Key) => ({ Key })),
          IsTruncated: false,
        };
      default:
        throw new Error(`unsupported ${command.constructor.name}`);
    }
  }
}

function notFound() {
  const err = new Error("NoSuchKey");
  err.name = "NoSuchKey";
  err.$metadata = { httpStatusCode: 404 };
  return err;
}

function makeStore(gameRows) {
  const games = new FakeGames(gameRows);
  const client = new FakeS3();
  const signed = [];
  const signer = jest.fn(async (_client, command, options) => {
    signed.push({ command, options });
    return `https://r2.invalid/${signed.length}`;
  });
  const store = new ReplayFilesService({
    client,
    bucket: "private-replays",
    prefix: "raw/v1",
    games,
    signer,
  });
  return { store, games, client, signed, signer };
}

describe("ReplayFilesService", () => {
  test("builds from the shared R2 config and stays disabled without R2", () => {
    const db = { games: new FakeGames() };
    expect(buildReplayFilesFromConfig(db, {
      replayFilesStore: "disabled",
      r2: null,
    })).toBeNull();
    expect(() => buildReplayFilesFromConfig(db, {
      replayFilesStore: "r2",
      r2: { endpoint: "https://account.r2.invalid" },
    })).toThrow(/REPLAY_FILES_STORE=r2/);
    const configured = buildReplayFilesFromConfig(db, {
      replayFilesStore: "r2",
      r2: {
        endpoint: "https://account.r2.invalid",
        bucket: "private",
        accessKeyId: "key",
        secretAccessKey: "secret",
        replayPrefix: "originals/v2",
      },
    });
    expect(configured).toBeInstanceOf(ReplayFilesService);
    expect(configured.prefix).toBe("originals/v2");
  });

  test("short-circuits a Full Resync when the same verified object exists", async () => {
    const storedAt = new Date("2026-08-01T10:00:00Z");
    const marker = { storedAt, sizeBytes: 8, sha256: SHA, md5: MD5 };
    const { store, games, client, signer } = makeStore([
      { userId: "u1", gameId: "g1", replayFile: marker },
    ]);
    client.put(store.keyFor("u1", "g1"));

    await expect(store.prepareUpload("u1", "g1", {
      filename: "g1.SC2Replay",
      sizeBytes: 8,
      sha256: SHA,
      md5: MD5,
    })).resolves.toEqual({ alreadyStored: true, replayAvailable: true });
    expect(signer).not.toHaveBeenCalled();
    expect(games.rows[0].replayFile).toEqual(marker);
    expect(client.commands.map((command) => command.constructor.name))
      .toEqual(["HeadObjectCommand"]);
  });

  test("verifies ingest fast-path markers against R2 and clears stale metadata", async () => {
    const storedAt = new Date("2026-08-01T10:00:00Z");
    const marker = {
      available: true,
      storedAt,
      sizeBytes: 8,
      sha256: SHA,
    };
    const { store, games, client } = makeStore([
      { userId: "u1", gameId: "present", replayFile: { ...marker } },
      { userId: "u1", gameId: "missing", replayFile: { ...marker } },
    ]);
    client.put(store.keyFor("u1", "present"));

    await expect(
      store.verifyAvailableMarker("u1", "present", marker),
    ).resolves.toBe(true);
    await expect(
      store.verifyAvailableMarker("u1", "missing", marker),
    ).resolves.toBe(false);

    expect(games.rows[0].replayFile).toBeDefined();
    expect(games.rows[1].replayFile).toBeUndefined();
    expect(client.commands.map((command) => command.constructor.name))
      .toEqual(["HeadObjectCommand", "HeadObjectCommand"]);
  });

  test("rejects malformed ingest fast-path markers without touching R2", async () => {
    const { store, client } = makeStore([]);
    await expect(store.verifyAvailableMarker("u1", "g1", {
      available: true,
      storedAt: new Date(),
      sizeBytes: 8,
      sha256: "not-a-hash",
    })).resolves.toBe(false);
    expect(client.commands).toEqual([]);
  });

  test("prepares an owner-scoped pending PUT without replacing the old marker", async () => {
    const old = { storedAt: new Date(), sizeBytes: 8, sha256: SHA, md5: MD5 };
    const { store, games, signed } = makeStore([
      { userId: "user/a", gameId: "date|opp|map", replayFile: old },
    ]);

    const prepared = await store.prepareUpload("user/a", "date|opp|map", {
      filename: "match.SC2Replay",
      sizeBytes: 8,
      sha256: SHA,
      md5: MD5,
    });

    expect(prepared).toEqual(expect.objectContaining({
      url: "https://r2.invalid/1",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": "8",
        "cache-control": "private, no-store",
        "content-md5": MD5,
        "x-amz-meta-sha256": SHA,
      },
      expiresIn: 300,
    }));
    expect(prepared.uploadId).toMatch(/^[A-Za-z0-9_-]{20,64}$/);
    expect(games.rows[0].replayFile).toEqual(old);
    expect(games.rows[0].replayUpload).toMatchObject({
      uploadId: prepared.uploadId,
      sizeBytes: 8,
      sha256: SHA,
      md5: MD5,
      state: "pending",
    });
    expect(signed[0].command.constructor.name).toBe("PutObjectCommand");
    expect(signed[0].options.unhoistableHeaders)
      .toEqual(new Set(["x-amz-meta-sha256"]));
    expect(signed[0].options.signableHeaders)
      .toEqual(new Set(["content-type", "cache-control", "content-md5"]));
    expect(signed[0].command.input).toMatchObject({
      Bucket: "private-replays",
      Key: `raw/v1-pending/user%2Fa/date%7Copp%7Cmap/${prepared.uploadId}.SC2Replay`,
      ContentLength: 8,
      ContentMD5: MD5,
      Metadata: { sha256: SHA },
    });
    await expect(
      store.prepareUpload("someone-else", "date|opp|map", {
        filename: "match.SC2Replay",
        sizeBytes: 8,
        sha256: SHA,
        md5: MD5,
      }),
    ).rejects.toMatchObject({ status: 404, code: "game_not_found" });
  });

  test("two clients reuse one live intent instead of replacing each other", async () => {
    const { store, games } = makeStore([{ userId: "u1", gameId: "g1" }]);
    const file = {
      filename: "g1.SC2Replay",
      sizeBytes: 8,
      sha256: SHA,
      md5: MD5,
    };
    const first = await store.prepareUpload("u1", "g1", file);
    const second = await store.prepareUpload("u1", "g1", file);
    expect(second.uploadId).toBe(first.uploadId);
    expect(games.rows[0].replayUpload.uploadId).toBe(first.uploadId);

    await expect(store.prepareUpload("u1", "g1", {
      ...file,
      md5: OTHER_MD5,
    })).rejects.toMatchObject({ status: 409, code: "replay_upload_busy" });
    expect(games.rows[0].replayUpload.uploadId).toBe(first.uploadId);
  });

  test("completes only a HEAD + Range validated MPQ and stamps metadata", async () => {
    const { store, games, client } = makeStore([
      {
        userId: "u1",
        gameId: "g1",
        date: new Date("2026-08-01T10:00:00Z"),
      },
    ]);
    const prepared = await store.prepareUpload("u1", "g1", {
      filename: "g1.SC2Replay",
      sizeBytes: 8,
      sha256: SHA,
      md5: MD5,
    });
    const pendingKey = store.pendingKeyFor("u1", "g1", prepared.uploadId);
    client.put(pendingKey);

    const marker = await store.completeUpload("u1", "g1", prepared.uploadId);

    expect(marker).toMatchObject({
      version: 1,
      uploadId: prepared.uploadId,
      sizeBytes: 8,
      sha256: SHA,
      md5: MD5,
    });
    expect(marker.storedAt).toBeInstanceOf(Date);
    expect(games.rows[0].replayFile).toEqual(marker);
    expect(client.commands.map((command) => command.constructor.name)).toEqual([
      "HeadObjectCommand",
      "GetObjectCommand",
      "CopyObjectCommand",
      "DeleteObjectCommand",
    ]);
    expect(client.commands[1].input.Range).toBe("bytes=0-3");
    expect(client.objects.has(store.keyFor("u1", "g1"))).toBe(true);
    expect(client.objects.has(pendingKey)).toBe(false);
  });

  test("deletes invalid uploads and reports missing uploads as retryable conflict", async () => {
    const { store, client } = makeStore([{ userId: "u1", gameId: "bad" }]);
    const first = await store.prepareUpload("u1", "bad", {
      filename: "bad.SC2Replay",
      sizeBytes: 8,
      sha256: SHA,
      md5: MD5,
    });
    const firstKey = store.pendingKeyFor("u1", "bad", first.uploadId);
    client.put(firstKey, Buffer.from("nope!!!!"));
    await expect(store.completeUpload("u1", "bad", first.uploadId))
      .rejects.toMatchObject({ status: 400, code: "not_a_replay" });
    expect(client.objects.has(firstKey)).toBe(false);

    const second = await store.prepareUpload("u1", "bad", {
      filename: "bad.SC2Replay",
      sizeBytes: 8,
      sha256: SHA,
      md5: MD5,
    });
    await expect(store.completeUpload("u1", "bad", second.uploadId))
      .rejects.toMatchObject({ status: 409, code: "replay_upload_missing" });
  });

  test("clears expired intents and lets prepare replace a stale completion lease", async () => {
    const expiredId = "E".repeat(24);
    const { store, games, client } = makeStore([
      {
        userId: "u1",
        gameId: "expired",
        replayUpload: {
          uploadId: expiredId,
          sizeBytes: 8,
          sha256: SHA,
          md5: MD5,
          state: "pending",
          expiresAt: new Date(Date.now() - 60_000),
        },
      },
      {
        userId: "u1",
        gameId: "stale",
        replayUpload: {
          uploadId: "S".repeat(24),
          state: "completing",
          expiresAt: new Date(Date.now() - 60_000),
        },
      },
    ]);
    const expiredKey = store.pendingKeyFor("u1", "expired", expiredId);
    client.put(expiredKey);

    await expect(store.completeUpload("u1", "expired", expiredId))
      .rejects.toMatchObject({ status: 409, code: "replay_upload_expired" });
    expect(client.objects.has(expiredKey)).toBe(false);
    expect(games.rows[0].replayUpload).toBeUndefined();

    const replacement = await store.prepareUpload("u1", "stale", {
      filename: "stale.SC2Replay",
      sizeBytes: 8,
      sha256: SHA,
      md5: MD5,
    });
    expect(replacement.uploadId).not.toBe("S".repeat(24));
    expect(games.rows[1].replayUpload.state).toBe("pending");
  });

  test("downloads through a short GET URL and clears a marker for missing R2 data", async () => {
    const storedAt = new Date("2026-08-01T10:00:00Z");
    const { store, games, client, signed } = makeStore([
      {
        userId: "u1",
        gameId: "g1",
        date: storedAt,
        map: "Ocean \/ \\ Drive",
        opponent: { displayName: "A:\"Player\"" },
        replayFile: { storedAt, sizeBytes: 8, sha256: SHA },
      },
      {
        userId: "u1",
        gameId: "missing",
        replayFile: { storedAt, sizeBytes: 8, sha256: SHA },
      },
    ]);
    client.put(store.keyFor("u1", "g1"));

    const download = await store.prepareDownload("u1", "g1");
    expect(download.url).toBe("https://r2.invalid/1");
    expect(download.expiresIn).toBe(60);
    expect(download.filename).toMatch(/\.SC2Replay$/);
    expect(download.filename).not.toMatch(/[\\/:*?"<>|]/);
    expect(signed[0].command.constructor.name).toBe("GetObjectCommand");
    expect(signed[0].command.input.ResponseContentDisposition)
      .toContain("attachment;");

    await expect(store.prepareDownload("u1", "missing"))
      .rejects.toMatchObject({ status: 404, code: "replay_unavailable" });
    expect(games.rows[1].replayFile).toBeUndefined();
  });

  test("deletes only the user's prefix and surfaces S3 batch failures", async () => {
    const { store, client } = makeStore([]);
    client.put(store.keyFor("u1", "g1"));
    client.put(store.pendingKeyFor("u1", "g1", "A".repeat(24)));
    client.put(store.keyFor("u2", "g2"));
    client.put(store.pendingKeyFor("u2", "g2", "B".repeat(24)));
    await store.deleteAllForUser("u1");
    expect(client.objects.has(store.keyFor("u1", "g1"))).toBe(false);
    expect(client.objects.has(
      store.pendingKeyFor("u1", "g1", "A".repeat(24)),
    )).toBe(false);
    expect(client.objects.has(store.keyFor("u2", "g2"))).toBe(true);
    expect(client.objects.has(
      store.pendingKeyFor("u2", "g2", "B".repeat(24)),
    )).toBe(true);

    client.put(store.keyFor("u1", "g3"));
    client.deleteErrors = [{ Key: store.keyFor("u1", "g3"), Code: "AccessDenied" }];
    await expect(store.deleteMany("u1", ["g3"]))
      .rejects.toMatchObject({ code: "replay_object_delete_failed" });
  });
});

function routeApp(replayFiles, source = "device") {
  const app = express();
  app.use(express.json());
  app.use("/v1", buildReplayFilesRouter({
    replayFiles,
    auth(req, _res, next) {
      req.auth = { userId: "u1", source };
      next();
    },
  }));
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ code: err.code || err.message });
  });
  return app;
}

describe("replay file routes", () => {
  test("reports unavailable storage instead of accepting an upload", async () => {
    const response = await request(routeApp(null))
      .post("/v1/games/g1/replay-upload")
      .send({ filename: "g.SC2Replay", sizeBytes: 8, sha256: SHA });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("replay_storage_unavailable");
  });

  test("validates upload input and requires device auth for writes", async () => {
    const replayFiles = { prepareUpload: jest.fn(async () => ({ url: "put" })) };
    const good = await request(routeApp(replayFiles))
      .post("/v1/games/g1/replay-upload")
      .send({ filename: "g.SC2Replay", sizeBytes: 8, sha256: SHA, md5: MD5 });
    expect(good.status).toBe(200);
    expect(replayFiles.prepareUpload).toHaveBeenCalledWith("u1", "g1", {
      filename: "g.SC2Replay",
      sizeBytes: 8,
      sha256: SHA,
      md5: MD5,
    });

    const invalid = await request(routeApp(replayFiles))
      .post("/v1/games/g1/replay-upload")
      .send({
        filename: "../g.SC2Replay",
        sizeBytes: 8,
        sha256: SHA,
        md5: MD5,
      });
    expect(invalid.status).toBe(400);

    const invalidMd5 = await request(routeApp(replayFiles))
      .post("/v1/games/g1/replay-upload")
      .send({ filename: "g.SC2Replay", sizeBytes: 8, sha256: SHA, md5: "bad" });
    expect(invalidMd5.status).toBe(400);

    const browser = await request(routeApp(replayFiles, "clerk"))
      .post("/v1/games/g1/replay-upload")
      .send({ filename: "g.SC2Replay", sizeBytes: 8, sha256: SHA });
    expect(browser.status).toBe(403);
    expect(browser.body.code).toBe("device_auth_required");
  });

  test("complete advertises availability and browser auth may request download", async () => {
    const replayFiles = {
      completeUpload: jest.fn(async () => ({
        sizeBytes: 8,
        sha256: SHA,
        storedAt: new Date("2026-08-01T00:00:00Z"),
      })),
      prepareDownload: jest.fn(async () => ({
        url: "get",
        filename: "game.SC2Replay",
        expiresIn: 60,
      })),
    };
    const complete = await request(routeApp(replayFiles))
      .post("/v1/games/g1/replay-upload/complete")
      .send({ uploadId: "A".repeat(24) });
    expect(complete.status).toBe(200);
    expect(complete.body).toMatchObject({ ok: true, replayAvailable: true });
    expect(replayFiles.completeUpload)
      .toHaveBeenCalledWith("u1", "g1", "A".repeat(24));
    expect(complete.body.replay.storedAt).toBe("2026-08-01T00:00:00.000Z");

    const download = await request(routeApp(replayFiles, "clerk"))
      .get("/v1/games/g1/replay-download");
    expect(download.status).toBe(200);
    expect(download.headers["cache-control"]).toBe("private, no-store");
    expect(download.body.url).toBe("get");
    expect(replayFiles.prepareDownload).toHaveBeenCalledWith("u1", "g1");
  });
});

function fakeCollection(overrides = {}) {
  return {
    findOne: jest.fn(async () => null),
    find: jest.fn(() => ({ toArray: jest.fn(async () => []) })),
    deleteMany: jest.fn(async () => ({ deletedCount: 0 })),
    deleteOne: jest.fn(async () => ({ deletedCount: 0 })),
    updateOne: jest.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    updateMany: jest.fn(async () => ({ modifiedCount: 0 })),
    insertMany: jest.fn(async () => ({})),
    ...overrides,
  };
}

function fakeGdprDb() {
  const db = {};
  for (const [key] of USER_SCOPED_COLLECTIONS) db[key] = fakeCollection();
  db.users = fakeCollection();
  db.gameDetails = fakeCollection();
  db.devicePairings = fakeCollection();
  db.arcadeLeaderboard = fakeCollection();
  db.communityBuilds = fakeCollection();
  db.communityReports = fakeCollection();
  db.adminEvents = fakeCollection();
  db.backups = fakeCollection();
  db.db = { collection: jest.fn(() => db.backups) };
  return db;
}

describe("GDPR replay object integration", () => {
  test("fails closed when archived games exist but R2 is disabled", async () => {
    const db = fakeGdprDb();
    db.games.findOne.mockImplementation(async (filter) => (
      filter["_opponentBuildOrderWriteLease.leaseUntil"]
        ? null
        : { _id: "archived-game" }
    ));
    const gdpr = new GdprService(db);
    await expect(gdpr.deleteAll("u1")).rejects.toMatchObject({
      status: 503,
      code: "replay_storage_unavailable",
    });
    expect(db.games.deleteMany).not.toHaveBeenCalled();
  });

  test("account deletion purges the user's private R2 prefix", async () => {
    const db = fakeGdprDb();
    let objectPresent = true;
    const replayFiles = {
      deleteAllForUser: jest.fn(async () => {
        objectPresent = false;
      }),
    };
    db.games.deleteMany.mockImplementation(async () => {
      // Simulate a completion that promoted its object after the first R2
      // purge but immediately before the game ownership row was removed.
      objectPresent = true;
      return { deletedCount: 1 };
    });
    const gdpr = new GdprService(db, { replayFiles });
    const counts = await gdpr.deleteAll("u1");
    expect(replayFiles.deleteAllForUser).toHaveBeenCalledTimes(2);
    expect(replayFiles.deleteAllForUser).toHaveBeenNthCalledWith(1, "u1");
    expect(replayFiles.deleteAllForUser).toHaveBeenNthCalledWith(2, "u1");
    expect(objectPresent).toBe(false);
    expect(counts.replayFiles).toBe(-1);
  });

  test("ranged history wipe resolves game ids before deletion", async () => {
    const db = fakeGdprDb();
    db.games.find = jest.fn(() => ({
      toArray: jest.fn(async () => [{ gameId: "g1" }, { gameId: "g2" }]),
    }));
    const replayFiles = {
      deleteMany: jest.fn(async () => {}),
      deleteAllForUser: jest.fn(async () => {}),
    };
    db.gameDetails.find = jest.fn(() => ({
      toArray: jest.fn(async () => [{ gameId: "g1" }, { gameId: "g2" }]),
    }));
    const gameDetails = {
      delete: jest.fn(async () => {}),
      deleteAllForUser: jest.fn(async () => {}),
    };
    const gdpr = new GdprService(db, { replayFiles, gameDetails });
    gdpr.rebuildOpponentsForUser = jest.fn(async () => 0);
    const since = new Date("2026-08-01T00:00:00Z");
    await gdpr.wipeGames("u1", { since });
    expect(replayFiles.deleteMany).toHaveBeenCalledTimes(2);
    expect(replayFiles.deleteMany).toHaveBeenNthCalledWith(
      1,
      "u1",
      ["g1", "g2"],
    );
    expect(replayFiles.deleteMany).toHaveBeenNthCalledWith(
      2,
      "u1",
      ["g1", "g2"],
    );
    // The Mongo delete is constrained to the exact ID snapshot that received
    // both R2 cleanup passes. A concurrently inserted in-range game therefore
    // survives instead of losing its ownership row while leaving an orphan.
    expect(db.games.deleteMany).toHaveBeenCalledWith({
      userId: "u1",
      gameId: { $in: ["g1", "g2"] },
    });
    expect(db.gameDetails.find).toHaveBeenCalledWith(
      { userId: "u1", gameId: { $in: ["g1", "g2"] } },
      { projection: { _id: 0, gameId: 1 } },
    );
    expect(gameDetails.delete).toHaveBeenCalledTimes(2);
    expect(replayFiles.deleteAllForUser).not.toHaveBeenCalled();
  });

  test("snapshot restore purges objects and strips stale replay markers", async () => {
    const db = fakeGdprDb();
    db.backups.findOne.mockResolvedValue({
      payload: {
        data: {
          games: [{ gameId: "g1", replayFile: { storedAt: new Date() } }],
        },
      },
    });
    const replayFiles = { deleteAllForUser: jest.fn(async () => {}) };
    const gameDetails = { deleteAllForUser: jest.fn(async () => {}) };
    const gdpr = new GdprService(db, { replayFiles, gameDetails });
    await gdpr.restoreSnapshot("u1", "snapshot-1");
    expect(replayFiles.deleteAllForUser).toHaveBeenCalledTimes(2);
    expect(replayFiles.deleteAllForUser).toHaveBeenCalledWith("u1");
    expect(gameDetails.deleteAllForUser).toHaveBeenCalledTimes(1);
    expect(gameDetails.deleteAllForUser).toHaveBeenCalledWith("u1");
    expect(gameDetails.deleteAllForUser.mock.invocationCallOrder[0])
      .toBeLessThan(db.games.insertMany.mock.invocationCallOrder[0]);
    const inserted = db.games.insertMany.mock.calls[0][0][0];
    expect(inserted).toMatchObject({ userId: "u1", gameId: "g1" });
    expect(inserted.replayFile).toBeUndefined();
  });
});
