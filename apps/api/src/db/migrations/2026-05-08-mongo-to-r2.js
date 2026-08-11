"use strict";

/**
 * One-shot migration — Mongo ``game_details`` → R2 (or any
 * S3-compatible bucket).
 *
 * Reads every detail row from the Mongo ``game_details`` collection,
 * uploads its heavy-field payload as a gzip-compressed JSON object to
 * the configured bucket under the same key scheme R2DetailsStore
 * uses (``${prefix}/${userId}/${gameId}.json.gz``), and rewrites the
 * Mongo row to a slim metadata stub (``storedIn: 'r2'``).
 *
 * Run this AFTER:
 *   1. Provisioning the R2 bucket and credentials.
 *   2. Populating ``R2_*`` env vars on the API service.
 *   3. Deploying the v0.4.4 reader cutover so every consumer reads
 *      through GameDetailsService.
 *
 * Run BEFORE flipping ``GAME_DETAILS_STORE=r2``. After the flip, new
 * writes go straight to R2; this migration moves the back-history.
 *
 * Usage
 * -----
 *   MONGODB_URI=... MONGODB_DB=... \
 *   R2_ENDPOINT=... R2_BUCKET=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \
 *     node src/db/migrations/2026-05-08-mongo-to-r2.js
 *
 * ``--dry-run`` prints the work plan without uploading.
 * ``--concurrency=N`` overrides the default 8 parallel uploads.
 * ``--limit=N`` migrates at most N rows (useful for staged rollouts).
 *
 * Idempotent: rows already marked ``storedIn: 'r2'`` are skipped.
 * Re-runs on a partially-completed migration pick up where the
 * previous run stopped.
 */

const path = require("path");
const zlib = require("zlib");
const { promisify } = require("util");
const { MongoClient } = require("mongodb");

const gzip = promisify(zlib.gzip);

const { COLLECTIONS } = require(
  path.join(__dirname, "..", "..", "config", "constants"),
);
// path.join require keeps the script runnable from any CWD; the cast
// restores the module type TS loses on a dynamic require path.
const { HEAVY_FIELDS } = /** @type {typeof import("../../services/gameDetails")} */ (
  require(path.join(__dirname, "..", "..", "services", "gameDetails"))
);

function parseArgs() {
  const out = { dryRun: false, concurrency: 8, limit: Infinity };
  for (const arg of process.argv.slice(2)) {
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg.startsWith("--concurrency=")) {
      const n = Number.parseInt(arg.slice("--concurrency=".length), 10);
      if (Number.isFinite(n) && n > 0) out.concurrency = Math.min(64, n);
    } else if (arg.startsWith("--limit=")) {
      const n = Number.parseInt(arg.slice("--limit=".length), 10);
      if (Number.isFinite(n) && n > 0) out.limit = n;
    }
  }
  return out;
}

/** @param {string} name @returns {string} */
function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(2);
  }
  return v;
}

/**
 * @param {string} prefix
 * @param {string} userId
 * @param {string} gameId
 */
function keyFor(prefix, userId, gameId) {
  const encGameId = encodeURIComponent(gameId);
  return `${prefix}/${userId}/${encGameId}.json.gz`;
}

async function main() {
  const { dryRun, concurrency, limit } = parseArgs();
  const mongoUri = requireEnv("MONGODB_URI");
  const dbName = process.env.MONGODB_DB || "sc2tools_saas";
  const bucket = requireEnv("R2_BUCKET");
  const endpoint = requireEnv("R2_ENDPOINT");
  const region = process.env.R2_REGION || "auto";
  const accessKeyId = requireEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("R2_SECRET_ACCESS_KEY");
  const prefix = (process.env.R2_PREFIX || "game-details").replace(
    /^\/+|\/+$/g,
    "",
  );

  const sdk = require("@aws-sdk/client-s3");
  const client = new sdk.S3Client({
    region,
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });

  const mongo = new MongoClient(mongoUri, { retryWrites: true });
  await mongo.connect();
  try {
    const collection = mongo.db(dbName).collection(COLLECTIONS.GAME_DETAILS);
    // Filter: heavy fields present AND not yet flagged as moved.
    const filter = {
      storedIn: { $ne: "r2" },
      $or: HEAVY_FIELDS.map((k) => ({ [k]: { $exists: true } })),
    };
    const total = await collection.countDocuments(filter);
    const planned = Math.min(total, limit);
    console.log(
      `${dryRun ? "[dry-run] " : ""}rows to migrate: ${total} `
        + `(processing ${planned} this run, concurrency=${concurrency})`,
    );
    if (planned === 0) return;

    // Stream from Mongo with only a bounded set of uploads in flight.
    // This keeps memory flat even when the collection grows large.
    const cursor = collection
      .find(filter)
      .limit(planned)
      .batchSize(Math.max(16, concurrency * 4));
    let uploaded = 0;
    let failed = 0;
    let skipped = 0;
    /** @type {Record<string, any>} */
    const unsetFields = {};
    for (const k of HEAVY_FIELDS) unsetFields[k] = "";

    /** @param {Record<string, any>} doc */
    const migrateDoc = async (doc) => {
      try {
        if (!doc.userId || !doc.gameId) {
          skipped += 1;
          return;
        }
        /** @type {Record<string, any>} */
        const blob = {};
        let any = false;
        for (const k of HEAVY_FIELDS) {
          if (doc[k] !== undefined) {
            blob[k] = doc[k];
            any = true;
          }
        }
        if (!any) {
          skipped += 1;
          return;
        }
        if (!dryRun) {
          const body = await gzip(Buffer.from(JSON.stringify(blob), "utf8"));
          await client.send(
            new sdk.PutObjectCommand({
              Bucket: bucket,
              Key: keyFor(prefix, doc.userId, doc.gameId),
              Body: body,
              ContentType: "application/json",
              ContentEncoding: "gzip",
              CacheControl: "private, max-age=86400",
            }),
          );
          await collection.updateOne(
            { userId: doc.userId, gameId: doc.gameId },
            {
              $set: { storedIn: "r2" },
              $unset: unsetFields,
            },
          );
        }
        uploaded += 1;
      } catch (err) {
        failed += 1;
        const e = /** @type {{ message?: unknown }} */ (err);
        console.warn(
          `upload failed for ${doc.userId}/${doc.gameId}: `
            + (e && e.message ? e.message : String(e)),
        );
      } finally {
        const completed = uploaded + failed + skipped;
        if (completed > 0 && completed % 100 === 0) {
          console.log(
            `progress: uploaded=${uploaded} failed=${failed} `
              + `skipped=${skipped} pending=${Math.max(0, planned - completed)}`,
          );
        }
      }
    };

    /** @type {Set<Promise<void>>} */
    const inFlight = new Set();
    for await (const doc of cursor) {
      const task = migrateDoc(doc).finally(() => inFlight.delete(task));
      inFlight.add(task);
      if (inFlight.size >= concurrency) await Promise.race(inFlight);
    }
    await Promise.all(inFlight);
    console.log(
      `done: uploaded=${uploaded} failed=${failed} skipped=${skipped} of ${planned}`,
    );
    const remaining = await collection.countDocuments(filter);
    console.log(`remaining Mongo detail rows to migrate: ${remaining}`);
    if (failed > 0) {
      console.warn(
        `${failed} rows failed and remain in Mongo. Re-run after `
          + "investigating; the dry-run filter excludes successfully "
          + "migrated rows so the re-run only retries the failures.",
      );
      process.exitCode = 1;
    }
  } finally {
    await mongo.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { keyFor };
