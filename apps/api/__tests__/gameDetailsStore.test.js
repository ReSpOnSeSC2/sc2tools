// @ts-nocheck
"use strict";

/**
 * Storage-backend integration tests for GameDetailsStore.
 *
 * Covers both backends in one suite:
 *
 *   - ``MongoDetailsStore`` is exercised against an in-process
 *     ``mongodb-memory-server`` so the contract is verified without
 *     mocks or network.
 *   - ``R2DetailsStore`` is exercised against a hand-rolled S3-API
 *     fake that responds to the exact subset of the SDK's commands
 *     the store calls. The fake stores blobs in memory keyed on the
 *     same ``${prefix}/${userId}/${gameId}.json.gz`` scheme so the
 *     production key derivation gets coverage too. Real
 *     ``@aws-sdk/client-s3`` Command objects round-trip through the
 *     fake — there's no monkey-patching of the SDK internals.
 */

const zlib = require("zlib");
const { promisify } = require("util");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");

const {
  STORE_KINDS,
  MongoDetailsStore,
  R2DetailsStore,
  buildStoreFromConfig,
} = require("../src/services/gameDetailsStore");
const { COLLECTIONS } = require("../src/config/constants");

const gunzip = promisify(zlib.gunzip);

const SAMPLE_BLOB = {
  buildLog: ["[0:00] Nexus", "[0:17] Pylon"],
  oppBuildLog: ["[0:00] Hatchery", "[0:30] Drone"],
  macroBreakdown: { raw: { sq: 80 }, top_3_leaks: [], stats_events: [] },
  apmCurve: { window_sec: 30, has_data: true, players: [] },
};

describe("MongoDetailsStore", () => {
  /** @type {MongoMemoryServer} */
  let mongo;
  /** @type {MongoClient} */
  let client;
  /** @type {MongoDetailsStore} */
  let store;
  /** @type {import('mongodb').Collection} */
  let collection;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    const db = client.db("test_gd_store");
    collection = db.collection(COLLECTIONS.GAME_DETAILS);
    store = new MongoDetailsStore({ gameDetails: collection });
  });

  afterAll(async () => {
    await client.close();
    await mongo.stop();
  });

  beforeEach(async () => {
    await collection.deleteMany({});
  });

  test("write + read round-trips the blob", async () => {
    const date = new Date("2026-05-04T12:00:00Z");
    await store.write("u1", "g1", date, SAMPLE_BLOB);
    const got = await store.read("u1", "g1");
    expect(got).toMatchObject(SAMPLE_BLOB);
    // Bookkeeping fields are trimmed off the read response so callers
    // never have to filter them out themselves.
    expect(got).not.toHaveProperty("userId");
    expect(got).not.toHaveProperty("createdAt");
    expect(got).not.toHaveProperty("_id");
  });

  test("read returns null for missing gameId", async () => {
    expect(await store.read("u1", "missing")).toBeNull();
  });

  test("readMany returns a Map keyed by gameId, only populated entries", async () => {
    const date = new Date("2026-05-04T12:00:00Z");
    await store.write("u1", "g1", date, { buildLog: ["a"] });
    await store.write("u1", "g2", date, { buildLog: ["b"] });
    const out = await store.readMany("u1", ["g1", "g2", "missing"]);
    expect(out.size).toBe(2);
    expect(out.get("g1").buildLog).toEqual(["a"]);
    expect(out.get("g2").buildLog).toEqual(["b"]);
    expect(out.has("missing")).toBe(false);
  });

  test("readMany short-circuits empty input without a query", async () => {
    const out = await store.readMany("u1", []);
    expect(out.size).toBe(0);
  });

  test("delete removes one row, leaves siblings intact", async () => {
    const date = new Date("2026-05-04T12:00:00Z");
    await store.write("u1", "g1", date, { buildLog: ["a"] });
    await store.write("u1", "g2", date, { buildLog: ["b"] });
    await store.delete("u1", "g1");
    expect(await store.read("u1", "g1")).toBeNull();
    expect(await store.read("u1", "g2")).not.toBeNull();
  });

  test("deleteAllForUser clears every row for that user only", async () => {
    const date = new Date("2026-05-04T12:00:00Z");
    await store.write("u1", "g1", date, { buildLog: ["a"] });
    await store.write("u1", "g2", date, { buildLog: ["b"] });
    await store.write("u2", "g3", date, { buildLog: ["c"] });
    await store.deleteAllForUser("u1");
    expect(await store.read("u1", "g1")).toBeNull();
    expect(await store.read("u1", "g2")).toBeNull();
    expect(await store.read("u2", "g3")).not.toBeNull();
  });
});

/**
 * In-memory S3 client compatible with the subset of @aws-sdk/client-s3
 * the R2DetailsStore uses. Distinct objects per key; supports list +
 * batch delete by prefix; throws an SDK-shaped NoSuchKey on misses.
 */
class FakeS3Client {
  constructor() {
    /** @type {Map<string, { body: Buffer, ContentType?: string, ContentEncoding?: string, CacheControl?: string }>} */
    this.objects = new Map();
    this.deleteObjectsCalls = 0;
  }

  async send(command) {
    const name = command.constructor.name;
    const input = command.input;
    if (name === "PutObjectCommand") {
      const body = await toBuffer(input.Body);
      this.objects.set(input.Key, {
        body,
        ContentType: input.ContentType,
        ContentEncoding: input.ContentEncoding,
        CacheControl: input.CacheControl,
      });
      return {};
    }
    if (name === "GetObjectCommand") {
      const stored = this.objects.get(input.Key);
      if (!stored) {
        const err = new Error("NoSuchKey");
        err.name = "NoSuchKey";
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      return {
        Body: bufferToStream(stored.body),
        ContentType: stored.ContentType,
        ContentEncoding: stored.ContentEncoding,
        $metadata: { httpStatusCode: 200 },
      };
    }
    if (name === "DeleteObjectCommand") {
      this.objects.delete(input.Key);
      return {};
    }
    if (name === "ListObjectsV2Command") {
      const matching = [];
      for (const key of this.objects.keys()) {
        if (key.startsWith(input.Prefix)) matching.push({ Key: key });
      }
      return {
        Contents: matching,
        IsTruncated: false,
        KeyCount: matching.length,
      };
    }
    if (name === "DeleteObjectsCommand") {
      this.deleteObjectsCalls += 1;
      for (const obj of input.Delete.Objects) {
        this.objects.delete(obj.Key);
      }
      return {};
    }
    throw new Error(`FakeS3Client: unsupported command ${name}`);
  }
}

async function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (typeof input === "string") return Buffer.from(input);
  if (input && typeof input.pipe === "function") {
    return new Promise((resolve, reject) => {
      const chunks = [];
      input.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      input.on("end", () => resolve(Buffer.concat(chunks)));
      input.on("error", reject);
    });
  }
  if (input instanceof Uint8Array) return Buffer.from(input);
  throw new Error("FakeS3Client.toBuffer: unsupported body");
}

function bufferToStream(buf) {
  const { Readable } = require("stream");
  return Readable.from([buf]);
}

describe("R2DetailsStore", () => {
  /** @type {MongoMemoryServer} */
  let mongo;
  /** @type {MongoClient} */
  let mongoClient;
  /** @type {import('mongodb').Collection} */
  let collection;
  /** @type {FakeS3Client} */
  let s3;
  /** @type {R2DetailsStore} */
  let store;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    mongoClient = new MongoClient(mongo.getUri());
    await mongoClient.connect();
    collection = mongoClient.db("test_gd_r2").collection(COLLECTIONS.GAME_DETAILS);
  });

  afterAll(async () => {
    await mongoClient.close();
    await mongo.stop();
  });

  beforeEach(async () => {
    await collection.deleteMany({});
    s3 = new FakeS3Client();
    store = new R2DetailsStore({
      client: s3,
      bucket: "test-bucket",
      prefix: "details",
      gameDetailsCollection: collection,
    });
  });

  test("keyFor encodes special characters in gameId", () => {
    // gameId contains the agent's literal ``date|opp|map|len`` — the
    // store must URL-encode it so ``|`` doesn't trip up tooling.
    const k = store.keyFor("u1", "2026-05-04T12:00:00|Opp|Goldenaura|600");
    expect(k).toBe(
      "details/u1/2026-05-04T12%3A00%3A00%7COpp%7CGoldenaura%7C600.json.gz",
    );
  });

  test("write uploads gzipped JSON + writes a slim Mongo metadata row", async () => {
    const date = new Date("2026-05-04T12:00:00Z");
    await store.write("u1", "g1", date, SAMPLE_BLOB);
    // Object lives at the deterministic key.
    expect(s3.objects.size).toBe(1);
    const [, stored] = [...s3.objects.entries()][0];
    expect(stored.ContentEncoding).toBe("gzip");
    // Verify the body is real gzip + the JSON we wrote.
    const json = (await gunzip(stored.body)).toString("utf8");
    expect(JSON.parse(json)).toEqual(SAMPLE_BLOB);
    // Mongo metadata row mirrors the (userId, gameId, date, storedIn) tuple.
    const meta = await collection.findOne({ userId: "u1", gameId: "g1" });
    expect(meta).not.toBeNull();
    expect(meta.storedIn).toBe(STORE_KINDS.R2);
    // Heavy fields are NOT echoed onto the slim metadata row — that's
    // the whole point of the offload.
    expect(meta).not.toHaveProperty("buildLog");
    expect(meta).not.toHaveProperty("macroBreakdown");
  });

  test("read pulls the blob back through the gzip path", async () => {
    const date = new Date("2026-05-04T12:00:00Z");
    await store.write("u1", "g1", date, SAMPLE_BLOB);
    const got = await store.read("u1", "g1");
    expect(got).toEqual(SAMPLE_BLOB);
  });

  test("read returns null on NoSuchKey instead of throwing", async () => {
    expect(await store.read("u1", "missing")).toBeNull();
  });

  test("readMany fans out parallel GETs and skips missing keys", async () => {
    const date = new Date("2026-05-04T12:00:00Z");
    await store.write("u1", "g1", date, { buildLog: ["a"] });
    await store.write("u1", "g3", date, { buildLog: ["c"] });
    const out = await store.readMany("u1", ["g1", "g2", "g3"]);
    expect(out.size).toBe(2);
    expect(out.get("g1").buildLog).toEqual(["a"]);
    expect(out.get("g3").buildLog).toEqual(["c"]);
  });

  test("delete removes the object + its Mongo metadata row", async () => {
    const date = new Date("2026-05-04T12:00:00Z");
    await store.write("u1", "g1", date, SAMPLE_BLOB);
    await store.delete("u1", "g1");
    expect(s3.objects.size).toBe(0);
    expect(await collection.findOne({ userId: "u1", gameId: "g1" })).toBeNull();
  });

  test("deleteAllForUser deletes only that user's prefix", async () => {
    const date = new Date("2026-05-04T12:00:00Z");
    await store.write("u1", "g1", date, SAMPLE_BLOB);
    await store.write("u1", "g2", date, SAMPLE_BLOB);
    await store.write("u2", "g3", date, SAMPLE_BLOB);
    await store.deleteAllForUser("u1");
    expect(s3.objects.size).toBe(1);
    expect([...s3.objects.keys()][0]).toMatch(/^details\/u2\//);
    expect(await collection.countDocuments({ userId: "u1" })).toBe(0);
    expect(await collection.countDocuments({ userId: "u2" })).toBe(1);
  });
});

describe("buildStoreFromConfig", () => {
  test("defaults to MongoDetailsStore when gameDetailsStore is unset", () => {
    const fakeDb = { gameDetails: {} };
    const store = buildStoreFromConfig({ db: fakeDb, config: {} });
    expect(store.kind).toBe(STORE_KINDS.MONGO);
  });

  test("rejects gameDetailsStore=r2 without R2 credentials", () => {
    const fakeDb = { gameDetails: {} };
    expect(() =>
      buildStoreFromConfig({
        db: fakeDb,
        config: { gameDetailsStore: STORE_KINDS.R2, r2: null },
      }),
    ).toThrow(/R2_/);
  });
});
