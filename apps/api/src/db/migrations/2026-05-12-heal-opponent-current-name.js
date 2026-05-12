"use strict";

/**
 * One-shot migration — heal Opponents tab "current name" staleness.
 *
 * Before the May-2026 write guard landed, every ``recordGame`` /
 * ``refreshMetadata`` call wrote ``displayNameSample`` and
 * ``lastSeen`` unconditionally — i.e. the row reflected the most
 * recent UPLOAD, not the most recent GAME by date. Users who
 * re-uploaded old replays (manual drag-drop, agent backfill) ended
 * up with the Opponents tab heading rendering a stale historical
 * name for any opponent who had since renamed in-game.
 *
 * Going forward, the write guard prevents the staleness from
 * recurring. This migration heals existing rows by recomputing
 * the canonical "latest by date" name and timestamp from the
 * games collection.
 *
 * Algorithm:
 *   1. ``games`` aggregation grouped by ``(userId, opponent.pulseId)``
 *      sorted by ``date`` desc — yields one row per opponent with the
 *      displayName + date of their most-recent game on record.
 *   2. For each result, compare against the opponents row. If the
 *      stored values match, skip. Otherwise queue a bulk update.
 *   3. Flush bulk ops in batches.
 *
 * Idempotent: re-running after a partial failure (or on a clean
 * dataset) is safe — rows whose values already match are skipped.
 *
 * Run with:
 *   MONGODB_URI=... MONGODB_DB=... \
 *     node src/db/migrations/2026-05-12-heal-opponent-current-name.js
 *
 * Flags:
 *   --dry-run        Print planned change count without writing.
 *   --batch=N        Override default 500-doc bulk size.
 *   --user=USER_ID   Limit to a single user (useful for support
 *                    triage / debugging a specific report).
 */

const path = require("path");
const { MongoClient } = require("mongodb");

const { COLLECTIONS } = require(
  path.join(__dirname, "..", "..", "config", "constants"),
);

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
 * Heal one user's opponents rows. Returns counts for the caller's
 * summary line.
 *
 * @param {import('mongodb').Db} db
 * @param {string} userId
 * @param {{ dryRun: boolean, batch: number }} opts
 */
async function healUser(db, userId, opts) {
  const games = db.collection(COLLECTIONS.GAMES);
  const opponents = db.collection(COLLECTIONS.OPPONENTS);
  // One aggregation, one pass. Sorted DESC so $first = latest.
  const cursor = games.aggregate([
    {
      $match: {
        userId,
        "opponent.pulseId": { $type: "string", $ne: "" },
      },
    },
    { $sort: { date: -1 } },
    {
      $group: {
        _id: "$opponent.pulseId",
        latestName: { $first: { $ifNull: ["$opponent.displayName", ""] } },
        latestDate: { $first: "$date" },
      },
    },
  ]);

  /** @type {Array<{filter: object, update: object}>} */
  const ops = [];
  let scanned = 0;
  let planned = 0;
  let written = 0;

  for await (const row of cursor) {
    scanned += 1;
    const pulseId = row._id;
    if (typeof pulseId !== "string" || pulseId.length === 0) continue;
    const latestName = typeof row.latestName === "string" ? row.latestName : "";
    const latestDate = row.latestDate instanceof Date ? row.latestDate : null;
    if (!latestDate) continue;

    const existing = await opponents.findOne(
      { userId, pulseId },
      { projection: { _id: 0, displayNameSample: 1, lastSeen: 1 } },
    );
    if (!existing) continue;

    const nameChanged = existing.displayNameSample !== latestName;
    const seenChanged = !(existing.lastSeen instanceof Date)
      || existing.lastSeen.getTime() !== latestDate.getTime();
    if (!nameChanged && !seenChanged) continue;

    planned += 1;
    /** @type {Record<string, any>} */
    const set = {};
    if (nameChanged) set.displayNameSample = latestName;
    if (seenChanged) set.lastSeen = latestDate;
    ops.push({
      filter: { userId, pulseId },
      update: { $set: set },
    });

    if (ops.length >= opts.batch) {
      if (!opts.dryRun) {
        const res = await opponents.bulkWrite(
          ops.map((o) => ({ updateOne: { filter: o.filter, update: o.update } })),
          { ordered: false },
        );
        written += res.modifiedCount || 0;
      }
      ops.length = 0;
    }
  }

  if (ops.length > 0) {
    if (!opts.dryRun) {
      const res = await opponents.bulkWrite(
        ops.map((o) => ({ updateOne: { filter: o.filter, update: o.update } })),
        { ordered: false },
      );
      written += res.modifiedCount || 0;
    }
    ops.length = 0;
  }

  return { scanned, planned, written };
}

async function main() {
  const args = parseArgs();
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB;
  if (!uri || !dbName) {
    console.error(
      "MONGODB_URI and MONGODB_DB must be set in the environment.",
    );
    process.exit(2);
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
      userIds = await db
        .collection(COLLECTIONS.OPPONENTS)
        .distinct("userId");
    }

    let totalScanned = 0;
    let totalPlanned = 0;
    let totalWritten = 0;
    for (const userId of userIds) {
      const r = await healUser(db, userId, args);
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

module.exports = { healUser };
