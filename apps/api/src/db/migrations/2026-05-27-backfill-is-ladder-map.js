"use strict";

/**
 * One-shot migration — backfill ``isLadderMap`` on existing games.
 *
 * The FilterBar's ladder / non-ladder map filter ($matches on a stored
 * ``isLadderMap`` boolean) only works on games that were stamped at
 * ingest. Games uploaded before the field shipped carry no flag, so
 * picking "Ladder" or "Custom" hides them entirely.
 *
 * Unlike ``playerCount`` (which was never captured and can only be
 * filled by re-uploading replays through the v0.9.0+ agent), the map
 * NAME is already stored on every game — so we CAN classify historical
 * games retroactively by matching that name against the current ladder
 * pool (1v1 + team), sourced from Liquipedia via LadderMapPoolService.
 *
 * Algorithm:
 *   1. Resolve the live ladder pool once (1v1 ``maps`` + ``teamMaps``)
 *      and build a normalized membership Set.
 *   2. Stream every game per user, compute the boolean, and queue a
 *      bulk ``$set`` only when the stored value differs (or is absent).
 *   3. Flush in batches.
 *
 * Idempotent: re-running is a no-op once values match. The classifier
 * reflects the pool at run time — re-running after a Blizzard rotation
 * re-stamps games whose map left/entered the pool, which matches the
 * ingest-time semantics for fresh uploads.
 *
 * Run with:
 *   MONGODB_URI=... MONGODB_DB=... \
 *     node src/db/migrations/2026-05-27-backfill-is-ladder-map.js
 *
 * Flags:
 *   --dry-run        Print planned change count without writing.
 *   --batch=N        Override default 500-doc bulk size.
 *   --user=USER_ID   Limit to a single user.
 */

const path = require("path");
const { MongoClient } = require("mongodb");

const { COLLECTIONS } = require(
  path.join(__dirname, "..", "..", "config", "constants"),
);
const {
  LadderMapPoolService,
} = require(path.join(__dirname, "..", "..", "services", "ladderMapPool"));
const {
  buildLadderMapSet,
  isLadderMap,
} = require(path.join(__dirname, "..", "..", "util", "isLadderMap"));

const DEFAULT_BATCH = 500;

function parseArgs() {
  /** @type {{ dryRun: boolean, batch: number, user: string|null }} */
  const out = { dryRun: false, batch: DEFAULT_BATCH, user: null };
  for (const arg of process.argv.slice(2)) {
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg.startsWith("--batch=")) {
      const n = Number.parseInt(arg.slice("--batch=".length), 10);
      if (Number.isFinite(n) && n > 0) out.batch = n;
    } else if (arg.startsWith("--user=")) {
      const v = arg.slice("--user=".length).trim();
      out.user = v.length > 0 ? v : null;
    }
  }
  return out;
}

/**
 * Backfill one user's games. Returns counts for the summary line.
 *
 * @param {import('mongodb').Db} db
 * @param {string} userId
 * @param {Set<string>} ladderSet
 * @param {{ dryRun: boolean, batch: number }} opts
 */
async function backfillUser(db, userId, ladderSet, opts) {
  const games = db.collection(COLLECTIONS.GAMES);
  const cursor = games.find(
    { userId },
    { projection: { _id: 0, gameId: 1, map: 1, isLadderMap: 1 } },
  );

  /** @type {Array<{filter: object, update: object}>} */
  const ops = [];
  let scanned = 0;
  let planned = 0;
  let written = 0;

  const flush = async () => {
    if (ops.length === 0) return;
    if (!opts.dryRun) {
      const res = await games.bulkWrite(
        ops.map((o) => ({ updateOne: { filter: o.filter, update: o.update } })),
        { ordered: false },
      );
      written += res.modifiedCount || 0;
    }
    ops.length = 0;
  };

  for await (const row of cursor) {
    scanned += 1;
    if (typeof row.gameId !== "string" || row.gameId.length === 0) continue;
    const next = isLadderMap(row.map, ladderSet);
    if (row.isLadderMap === next) continue; // already correct
    planned += 1;
    ops.push({
      filter: { userId, gameId: row.gameId },
      update: { $set: { isLadderMap: next } },
    });
    if (ops.length >= opts.batch) await flush();
  }
  await flush();

  return { scanned, planned, written };
}

async function main() {
  const args = parseArgs();
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB;
  if (!uri || !dbName) {
    console.error("MONGODB_URI and MONGODB_DB must be set in the environment.");
    process.exit(2);
  }

  const pool = await new LadderMapPoolService().get();
  const ladderSet = buildLadderMapSet([
    ...(pool.maps || []),
    ...(pool.teamMaps || []),
  ]);
  console.log(
    `Ladder pool: source=${pool.source} ` +
      `1v1=${(pool.maps || []).length} team=${(pool.teamMaps || []).length} ` +
      `normalizedKeys=${ladderSet.size}`,
  );
  if (ladderSet.size === 0) {
    console.error(
      "Refusing to run: resolved an EMPTY ladder pool. A backfill now " +
        "would mark every game non-ladder. Check network / Liquipedia " +
        "reachability and retry.",
    );
    process.exit(3);
  }

  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db(dbName);
    /** @type {string[]} */
    let userIds;
    if (args.user) {
      userIds = [args.user];
    } else {
      userIds = await db.collection(COLLECTIONS.GAMES).distinct("userId");
    }

    let totalScanned = 0;
    let totalPlanned = 0;
    let totalWritten = 0;
    for (const userId of userIds) {
      const r = await backfillUser(db, userId, ladderSet, args);
      totalScanned += r.scanned;
      totalPlanned += r.planned;
      totalWritten += r.written;
      console.log(
        `  user=${userId}  scanned=${r.scanned}  planned=${r.planned}  written=${r.written}`,
      );
    }

    console.log("");
    console.log(
      `${args.dryRun ? "[DRY RUN] " : ""}` +
        `Done. users=${userIds.length}  scanned=${totalScanned}  ` +
        `planned=${totalPlanned}  written=${totalWritten}`,
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

module.exports = { backfillUser };
