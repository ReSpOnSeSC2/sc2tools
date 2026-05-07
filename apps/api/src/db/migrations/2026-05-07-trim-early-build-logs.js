"use strict";

/**
 * One-shot migration — v0.4.3 storage trim.
 *
 * Removes the redundant ``earlyBuildLog`` and ``oppEarlyBuildLog``
 * fields from every document in the ``games`` collection. Both arrays
 * are exactly ``buildLog`` / ``oppBuildLog`` filtered to ``time < 5:00``;
 * the API now derives them on read (see ``readEarlyBuildLog`` in
 * ``services/perGameCompute.js``) so the stored copies are pure waste —
 * roughly 6 kB per document for a typical replay.
 *
 * The schema-versioning registry was bumped to ``games.currentVersion = 2``
 * in the same release. Documents that still have the early arrays are
 * stamped at ``v1``; this script $unsets the fields and stamps ``v2``
 * in one ``updateMany`` so the migration is atomic per-batch.
 *
 * Idempotent: safe to re-run. Documents already at v2 are skipped by
 * the filter; running twice on a fresh database is a no-op.
 *
 * Run with:
 *   MONGODB_URI=... MONGODB_DB=... \
 *     node src/db/migrations/2026-05-07-trim-early-build-logs.js
 *
 * Use ``--dry-run`` to print the affected count without writing.
 */

const path = require("path");
const { MongoClient } = require("mongodb");

const { COLLECTIONS } = require(path.join(__dirname, "..", "..", "config", "constants"));

const FILTER = {
  $or: [
    { earlyBuildLog: { $exists: true } },
    { oppEarlyBuildLog: { $exists: true } },
  ],
};

const UPDATE = {
  $unset: { earlyBuildLog: "", oppEarlyBuildLog: "" },
  $set: { _schemaVersion: 2 },
};

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || "sc2tools_saas";
  if (!uri) {
    console.error("MONGODB_URI required");
    process.exit(2);
  }
  const client = new MongoClient(uri, { retryWrites: true });
  await client.connect();
  try {
    const games = client.db(dbName).collection(COLLECTIONS.GAMES);
    const total = await games.countDocuments(FILTER);
    console.log(
      `${dryRun ? "[dry-run] " : ""}docs with early log fields: ${total}`,
    );
    if (dryRun || total === 0) return;
    const res = await games.updateMany(FILTER, UPDATE);
    console.log(
      `updated ${res.modifiedCount} of ${res.matchedCount} matched docs`,
    );
    // Storage doesn't reclaim until WiredTiger compacts. The user can
    // run ``db.runCommand({compact: 'games'})`` against a primary to
    // reclaim immediately, or just wait — autocompact runs in the
    // background.
    console.log(
      "note: on-disk size reclaims gradually as WiredTiger compacts; "
        + "run db.runCommand({compact: 'games'}) on the primary to force.",
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

module.exports = { FILTER, UPDATE };
