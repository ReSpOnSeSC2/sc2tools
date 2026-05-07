"use strict";

/**
 * One-shot migration — v0.4.3 game_details backfill.
 *
 * Copies the heavy per-game fields (``buildLog``, ``oppBuildLog``,
 * ``macroBreakdown``, ``apmCurve``, ``spatial``) from every existing
 * ``games`` document into a parallel row in the new ``game_details``
 * collection introduced in v0.4.3.
 *
 * Why
 * ---
 * The v0.4.3 ingest path dual-writes — heavy fields land in BOTH
 * ``games`` (for back-compat with existing readers) and
 * ``game_details`` (the future home). New games arrive correctly
 * dual-written; this script populates ``game_details`` for the games
 * that were ingested before v0.4.3 deployed.
 *
 * Once the read-side cutover lands (a follow-up PR that flips
 * ``opponents.js``, ``spatial.js``, ``perGameCompute.js`` etc. to
 * read from ``game_details``), a SECOND migration will $unset the
 * duplicate heavy fields from ``games`` to actually reclaim disk.
 * That's intentionally not part of this script — the duplicate
 * storage during the transition is a known cost we accept to avoid a
 * single big-bang cutover.
 *
 * Idempotent: only inserts rows that don't already exist in
 * ``game_details``. Safe to re-run after a partial failure.
 *
 * Run with:
 *   MONGODB_URI=... MONGODB_DB=... \
 *     node src/db/migrations/2026-05-07-backfill-game-details.js
 *
 * Use ``--dry-run`` to print the planned write count without writing.
 * Use ``--batch=1000`` to override the default 500-doc bulk size.
 */

const path = require("path");
const { MongoClient } = require("mongodb");

const { COLLECTIONS } = require(
  path.join(__dirname, "..", "..", "config", "constants"),
);
const { HEAVY_FIELDS } = require(
  path.join(__dirname, "..", "..", "services", "gameDetails"),
);

const DEFAULT_BATCH = 500;

function parseArgs() {
  const out = { dryRun: false, batch: DEFAULT_BATCH };
  for (const arg of process.argv.slice(2)) {
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg.startsWith("--batch=")) {
      const n = Number.parseInt(arg.slice("--batch=".length), 10);
      if (Number.isFinite(n) && n > 0) out.batch = n;
    }
  }
  return out;
}

async function main() {
  const { dryRun, batch } = parseArgs();
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || "sc2tools_saas";
  if (!uri) {
    console.error("MONGODB_URI required");
    process.exit(2);
  }
  const client = new MongoClient(uri, { retryWrites: true });
  await client.connect();
  try {
    const db = client.db(dbName);
    const games = db.collection(COLLECTIONS.GAMES);
    const details = db.collection(COLLECTIONS.GAME_DETAILS);

    // Project: only the keys we need to assemble a detail row.
    /** @type {Record<string, 1>} */
    const projection = { _id: 0, userId: 1, gameId: 1, date: 1 };
    for (const k of HEAVY_FIELDS) projection[k] = 1;

    // Filter: docs that have at least one heavy field. A game with
    // none of them (early-v0.3.x ingest, AI game) would create an
    // empty detail row, so we skip.
    /** @type {Record<string, any>} */
    const filter = {
      $or: HEAVY_FIELDS.map((k) => ({ [k]: { $exists: true } })),
    };

    const candidate = await games.countDocuments(filter);
    console.log(
      `${dryRun ? "[dry-run] " : ""}games with heavy fields: ${candidate}`,
    );
    if (candidate === 0) return;
    if (dryRun) return;

    let scanned = 0;
    let queued = 0;
    let written = 0;
    /** @type {Array<{updateOne: any}>} */
    let ops = [];
    const flush = async () => {
      if (ops.length === 0) return;
      const res = await details.bulkWrite(ops, { ordered: false });
      written += res.upsertedCount || 0;
      ops = [];
    };
    const cursor = games.find(filter, { projection });
    for await (const g of cursor) {
      scanned += 1;
      if (!g.userId || !g.gameId) continue;
      /** @type {Record<string, any>} */
      const setOnInsert = {
        userId: g.userId,
        gameId: g.gameId,
        date: g.date,
        createdAt: new Date(),
        _schemaVersion: 1,
      };
      let any = false;
      for (const k of HEAVY_FIELDS) {
        if (g[k] !== undefined) {
          setOnInsert[k] = g[k];
          any = true;
        }
      }
      if (!any) continue;
      ops.push({
        updateOne: {
          filter: { userId: g.userId, gameId: g.gameId },
          update: { $setOnInsert: setOnInsert },
          upsert: true,
        },
      });
      queued += 1;
      if (ops.length >= batch) await flush();
      if (scanned % 5000 === 0) {
        console.log(
          `progress: scanned=${scanned} queued=${queued} written=${written}`,
        );
      }
    }
    await flush();
    console.log(
      `done: scanned=${scanned} queued=${queued} written=${written}`,
    );
    console.log(
      "note: ``games`` still carries the duplicate heavy fields. The "
        + "read-side cutover (follow-up PR) flips readers to "
        + "``game_details`` and a second migration $unsets the "
        + "originals to reclaim storage.",
    );
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { parseArgs };
