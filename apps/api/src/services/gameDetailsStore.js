"use strict";

/**
 * Pluggable storage backends for the per-game heavy-field blob
 * (``buildLog`` / ``oppBuildLog`` / ``macroBreakdown`` / ``apmCurve``).
 *
 * The ``GameDetailsService`` (services/gameDetails.js) is the public
 * API every reader / writer talks to. Internally it delegates blob I/O
 * to one of the backends defined here:
 *
 *   - ``MongoDetailsStore``  — stores the blob inline on the
 *                              ``game_details`` Mongo collection.
 *                              Default; queryable; counts against the
 *                              Atlas storage cap.
 *   - ``R2DetailsStore``     — stores the blob as a single
 *                              gzip-compressed JSON object in
 *                              S3-compatible object storage
 *                              (Cloudflare R2 / AWS S3 /
 *                              Backblaze B2). ~50× cheaper per GB
 *                              than Atlas dedicated tiers; right
 *                              choice past ~1M games.
 *
 * Backend choice is a runtime config decision, not a code change.
 * See ``config/loader.js`` for ``GAME_DETAILS_STORE`` env var.
 *
 * Public contract every store implements:
 *
 *   async write(userId, gameId, date, blob)   // upsert
 *   async read(userId, gameId)                // returns blob | null
 *   async readMany(userId, gameIds)           // returns Map<gameId, blob>
 *   async delete(userId, gameId)
 *   async deleteAllForUser(userId)
 *
 * ``blob`` is always the JSON-serialisable subset of the four heavy
 * fields. Stores are responsible for any compression / serialisation;
 * callers never touch raw bytes.
 */

const zlib = require("zlib");
const { promisify } = require("util");

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");

/**
 * Backend identifier strings. Public for tests and the config
 * loader so the env var is validated against the same set.
 */
const STORE_KINDS = Object.freeze({
  MONGO: "mongo",
  R2: "r2",
});

/**
 * Mongo-backed implementation. Persists the blob inline on the
 * ``game_details`` collection alongside the (userId, gameId, date)
 * key columns. Same schema the v0.4.3 dual-write already uses, just
 * formalised through the store interface so we can swap to R2.
 */
class MongoDetailsStore {
  /**
   * @param {{ gameDetails: import('mongodb').Collection }} db
   */
  constructor(db) {
    if (!db || !db.gameDetails) {
      throw new Error("MongoDetailsStore: db.gameDetails required");
    }
    this.db = db;
    this.kind = STORE_KINDS.MONGO;
  }

  /**
   * Upsert the blob for one game. Caller has already validated the
   * shape; we trust the inputs.
   *
   * @param {string} userId
   * @param {string} gameId
   * @param {Date} date
   * @param {Record<string, any>} blob
   */
  async write(userId, gameId, date, blob) {
    /** @type {Record<string, any>} */
    const set = { userId, gameId, date, ...blob };
    stampVersion(set, COLLECTIONS.GAME_DETAILS);
    await this.db.gameDetails.updateOne(
      { userId, gameId },
      { $setOnInsert: { createdAt: new Date() }, $set: set },
      { upsert: true },
    );
  }

  /**
   * Fetch one game's blob. Returns ``null`` when no detail row
   * exists (legacy v0.3.x ingest, or write failed earlier).
   *
   * @param {string} userId
   * @param {string} gameId
   * @returns {Promise<Record<string, any> | null>}
   */
  async read(userId, gameId) {
    const doc = await this.db.gameDetails.findOne(
      { userId, gameId },
      // Trim the bookkeeping fields — callers want only the heavy
      // payload, not _id/userId/gameId/date/createdAt/_schemaVersion.
      {
        projection: {
          _id: 0,
          userId: 0,
          gameId: 0,
          date: 0,
          createdAt: 0,
          _schemaVersion: 0,
        },
      },
    );
    if (!doc) return null;
    return doc;
  }

  /**
   * Fetch blobs for many gameIds in a single round-trip. Returns a
   * Map keyed by gameId so callers can zip with their slim games
   * array in one pass.
   *
   * @param {string} userId
   * @param {string[]} gameIds
   * @returns {Promise<Map<string, Record<string, any>>>}
   */
  async readMany(userId, gameIds) {
    if (!Array.isArray(gameIds) || gameIds.length === 0) return new Map();
    const cursor = this.db.gameDetails.find(
      { userId, gameId: { $in: gameIds } },
      { projection: { _id: 0, userId: 0, date: 0, createdAt: 0, _schemaVersion: 0 } },
    );
    const out = new Map();
    for await (const doc of cursor) {
      if (!doc || !doc.gameId) continue;
      const { gameId, ...rest } = doc;
      out.set(gameId, rest);
    }
    return out;
  }

  /**
   * @param {string} userId
   * @param {string} gameId
   */
  async delete(userId, gameId) {
    await this.db.gameDetails.deleteOne({ userId, gameId });
  }

  /**
   * @param {string} userId
   */
  async deleteAllForUser(userId) {
    await this.db.gameDetails.deleteMany({ userId });
  }
}

/**
 * R2 / S3-backed implementation. Persists the blob as a single
 * gzip-compressed JSON object at ``${prefix}/${userId}/${gameId}.json.gz``.
 *
 * Why one object per game (and not per-field) — the four heavy
 * fields are always read together (per-game inspector pulls all of
 * them), so atomic write + atomic read is the natural unit. Per-field
 * objects would 4× the request count without changing what's
 * transferred.
 *
 * Why gzip — build logs are extremely repetitive ("[m:ss] Zergling"
 * 500× per game compresses to a couple of references). Measured ~6×
 * compression on real payloads, dropping per-game R2 footprint from
 * ~30 kB to ~5 kB.
 *
 * The MongoDB ``game_details`` collection is still kept in sync with
 * (userId, gameId, date) tuples even when R2 is the blob store —
 * the slim row is what GDPR delete and the spatial filter pipelines
 * reach for. Only the four heavy fields are externalised.
 */
class R2DetailsStore {
  /**
   * @param {{
   *   client: import('@aws-sdk/client-s3').S3Client,
   *   bucket: string,
   *   prefix?: string,
   *   gameDetailsCollection: import('mongodb').Collection,
   * }} opts
   */
  constructor(opts) {
    if (!opts || !opts.client || !opts.bucket) {
      throw new Error("R2DetailsStore: client + bucket required");
    }
    if (!opts.gameDetailsCollection) {
      throw new Error(
        "R2DetailsStore: gameDetailsCollection required for slim metadata",
      );
    }
    // Lazy require so installs that don't use R2 don't pay the
    // @aws-sdk/client-s3 import cost at boot.
    const sdk = require("@aws-sdk/client-s3");
    this._sdk = sdk;
    this.client = opts.client;
    this.bucket = opts.bucket;
    this.prefix = (opts.prefix || "game-details").replace(/^\/+|\/+$/g, "");
    this.gameDetailsCollection = opts.gameDetailsCollection;
    this.kind = STORE_KINDS.R2;
  }

  /**
   * Build the canonical object key for one game. Public so the
   * migration script can compute keys without instantiating the
   * store with a client.
   *
   * @param {string} userId
   * @param {string} gameId
   * @returns {string}
   */
  keyFor(userId, gameId) {
    // Encode the gameId — it can contain ``|`` and ``:`` because the
    // agent builds it as ``date|opp|map|len``. S3 accepts those, but
    // any URL-bearing tooling (signed URLs, browser preview) breaks
    // on them. encodeURIComponent is overkill for the common case
    // but cheap and never wrong.
    const encGameId = encodeURIComponent(gameId);
    return `${this.prefix}/${userId}/${encGameId}.json.gz`;
  }

  /**
   * @param {string} userId
   * @param {string} gameId
   * @param {Date} date
   * @param {Record<string, any>} blob
   */
  async write(userId, gameId, date, blob) {
    const body = await gzip(Buffer.from(JSON.stringify(blob), "utf8"));
    await this.client.send(
      new this._sdk.PutObjectCommand({
        Bucket: this.bucket,
        Key: this.keyFor(userId, gameId),
        Body: body,
        ContentType: "application/json",
        ContentEncoding: "gzip",
        // Cache hint for any future signed-URL / CDN flow. Detail
        // blobs are write-once-per-recompute, so a long max-age is
        // safe — the agent re-uploads under the same key on
        // recompute, which invalidates the CDN entry naturally.
        CacheControl: "private, max-age=86400",
      }),
    );
    // Maintain the slim metadata row in Mongo so GDPR delete and
    // any future $lookup-style queries still have an authoritative
    // (userId, gameId, date) tuple per game.
    /** @type {Record<string, any>} */
    const meta = { userId, gameId, date, storedIn: STORE_KINDS.R2 };
    stampVersion(meta, COLLECTIONS.GAME_DETAILS);
    await this.gameDetailsCollection.updateOne(
      { userId, gameId },
      { $setOnInsert: { createdAt: new Date() }, $set: meta },
      { upsert: true },
    );
  }

  /**
   * @param {string} userId
   * @param {string} gameId
   * @returns {Promise<Record<string, any> | null>}
   */
  async read(userId, gameId) {
    let resp;
    try {
      resp = await this.client.send(
        new this._sdk.GetObjectCommand({
          Bucket: this.bucket,
          Key: this.keyFor(userId, gameId),
        }),
      );
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
    const buf = await streamToBuffer(/** @type {any} */ (resp.Body));
    const json = (await gunzip(buf)).toString("utf8");
    return JSON.parse(json);
  }

  /**
   * Fetch many in parallel. R2 doesn't support a batch-get RPC, so
   * we fan out N GETs with a hard concurrency cap to avoid blowing
   * the per-region request budget. 16 is a comfortable middle ground
   * — high enough to amortise round-trip latency on a list of 1000+
   * games (typical ML training scan), low enough to leave headroom
   * for foreground request handlers running concurrently.
   *
   * @param {string} userId
   * @param {string[]} gameIds
   * @param {{ concurrency?: number }} [opts]
   * @returns {Promise<Map<string, Record<string, any>>>}
   */
  async readMany(userId, gameIds, opts = {}) {
    if (!Array.isArray(gameIds) || gameIds.length === 0) return new Map();
    const concurrency = Math.max(1, Math.min(64, opts.concurrency || 16));
    const out = new Map();
    let i = 0;
    const worker = async () => {
      for (;;) {
        const idx = i;
        i += 1;
        if (idx >= gameIds.length) return;
        const gid = gameIds[idx];
        try {
          const blob = await this.read(userId, gid);
          if (blob !== null) out.set(gid, blob);
        } catch (err) {
          // One failed object shouldn't fail the whole batch — the
          // caller's per-game logic empty-states for missing details.
          // Surface enough context that a real failure is debuggable.
          // eslint-disable-next-line no-console
          console.warn(
            `R2DetailsStore.readMany: ${this.keyFor(userId, gid)} failed`,
            err && err.message,
          );
        }
      }
    };
    const workers = [];
    for (let w = 0; w < concurrency; w += 1) workers.push(worker());
    await Promise.all(workers);
    return out;
  }

  /**
   * @param {string} userId
   * @param {string} gameId
   */
  async delete(userId, gameId) {
    try {
      await this.client.send(
        new this._sdk.DeleteObjectCommand({
          Bucket: this.bucket,
          Key: this.keyFor(userId, gameId),
        }),
      );
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
    await this.gameDetailsCollection.deleteOne({ userId, gameId });
  }

  /**
   * Bulk delete every blob for a user. R2 has no "delete by prefix"
   * RPC; we list-then-delete in chunks of 1000 (the S3
   * DeleteObjects per-call max).
   *
   * @param {string} userId
   */
  async deleteAllForUser(userId) {
    const prefix = `${this.prefix}/${userId}/`;
    let continuationToken;
    do {
      /** @type {any} */
      const listResp = await this.client.send(
        new this._sdk.ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      const contents = listResp.Contents || [];
      if (contents.length > 0) {
        await this.client.send(
          new this._sdk.DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: {
              Objects: contents.map(/** @param {any} c */ (c) => ({ Key: c.Key })),
              Quiet: true,
            },
          }),
        );
      }
      continuationToken = listResp.IsTruncated
        ? listResp.NextContinuationToken
        : undefined;
    } while (continuationToken);
    await this.gameDetailsCollection.deleteMany({ userId });
  }
}

/**
 * Read a Node.js Readable stream (or an SDK Body) to a single
 * Buffer. The SDK returns a stream subclass that doesn't expose
 * .toArray on Node 18; concatenating chunks ourselves keeps us
 * portable across SDK versions.
 *
 * @param {NodeJS.ReadableStream} stream
 */
async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    stream.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/**
 * Identify a 404-equivalent S3 error. Both R2 and AWS S3 surface
 * "object missing" via different mechanisms depending on whether
 * the error came from the SDK's HEAD path (status code on the
 * underlying response) or the GET path (NoSuchKey error name).
 * Normalise both so callers don't care which.
 *
 * @param {any} err
 */
function isNotFoundError(err) {
  if (!err) return false;
  if (err.name === "NoSuchKey") return true;
  if (err.Code === "NoSuchKey") return true;
  if (err.$metadata && err.$metadata.httpStatusCode === 404) return true;
  return false;
}

/**
 * Build the configured store from a runtime config block. Falls
 * back to the Mongo backend when no R2 endpoint is configured —
 * the safe default during development and the trivially-cheapest
 * setup at low scale.
 *
 * @param {{
 *   db: { gameDetails: import('mongodb').Collection },
 *   config: {
 *     gameDetailsStore: 'mongo' | 'r2',
 *     r2: {
 *       endpoint?: string,
 *       region?: string,
 *       bucket?: string,
 *       accessKeyId?: string,
 *       secretAccessKey?: string,
 *       prefix?: string,
 *     } | null,
 *   },
 * }} ctx
 * @returns {MongoDetailsStore | R2DetailsStore}
 */
function buildStoreFromConfig(ctx) {
  const kind = (ctx && ctx.config && ctx.config.gameDetailsStore) || STORE_KINDS.MONGO;
  if (kind === STORE_KINDS.R2) {
    const r2 = ctx.config.r2;
    if (!r2 || !r2.endpoint || !r2.bucket || !r2.accessKeyId || !r2.secretAccessKey) {
      throw new Error(
        "GAME_DETAILS_STORE=r2 requires R2_ENDPOINT, R2_BUCKET, "
          + "R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY",
      );
    }
    const sdk = require("@aws-sdk/client-s3");
    const client = new sdk.S3Client({
      // R2 mandates ``auto`` for region; AWS S3 wants the real
      // region; B2 accepts either. Pass through whatever the user
      // configured.
      region: r2.region || "auto",
      endpoint: r2.endpoint,
      // Forces path-style addressing — required by R2/B2 and
      // safe for AWS S3 in all current API regions.
      forcePathStyle: true,
      credentials: {
        accessKeyId: r2.accessKeyId,
        secretAccessKey: r2.secretAccessKey,
      },
    });
    return new R2DetailsStore({
      client,
      bucket: r2.bucket,
      prefix: r2.prefix,
      gameDetailsCollection: ctx.db.gameDetails,
    });
  }
  return new MongoDetailsStore(ctx.db);
}

module.exports = {
  STORE_KINDS,
  MongoDetailsStore,
  R2DetailsStore,
  buildStoreFromConfig,
  // Internal helpers exported for tests:
  _internals: { streamToBuffer, isNotFoundError },
};
