"use strict";

/**
 * One-shot migration — v0.4.4 cutover cleanup.
 *
 * Drops the four heavy fields (``buildLog``, ``oppBuildLog``,
 * ``macroBreakdown``, ``apmCurve``) from the ``games`` collection.
 * After v0.4.3's reader cutover, every service that needs those
 * fields fetches them from ``game_details`` (or whatever backend
 * GameDetailsService is configured to use). The inline copies on
 * ``games`` became dead weight the moment the readers flipped.
 *
 * Safety
 * ------
 * Run AFTER ``2026-05-07-backfill-game-details.js`` has populated
 * ``game_details`` for every game that previously had heavy fields
 * inline. This script only $unsets — it does not $set anything new
 * — so a game whose detail row didn't get backfilled will lose its
 * heavy data permanently. The dry-run check below counts how many
 * rows are at risk before proceeding.
 *
 * Idempotent: re-running on docs already missing the fields is a
 * no-op. Stamps ``_schemaVersion: 4`` so we can tell at a glance
 * which generation a doc is on.
 *
 * Run with:
 *   MONGODB_URI=... MONGODB_DB=... \
 *     node src/db/migrations/2026-05-08-unset-heavy-from-games.js
 *
 * ``--dry-run`` prints the at-risk count + the planned write count.
 * ``--force`` proceeds even when at-risk games exist (DANGEROUS;
 * lose data).
 */

const path = require("path");
const { MongoClient } = require("mongodb");

const { COLLECTIONS } = require(
  path.join(__dirname, "..", "..", "config", "constants"),
);
const { HEAVY_FIELDS } = require(
  path.join(__dirname, "..", "..", "services", "gameDetails"),
);

const TARGET_VERSION = 4;

function parseArgs() {
  return {
    dryRun: process.argv.includes("--dry-run"),
    force: process.argv.includes("--force"),
  };
}

async function main() {
  const { dryRun, force } = parseArgs();
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

    // Risk audit: any game that has heavy fields inline AND no
    // matching gameDetails row is one we're about to lose data for.
    const filter = {
      $or: HEAVY_FIELDS.map((k) => ({ [k]: { $exists: true } })),
    };
    const candidate = await games.countDocuments(filter);
    console.log(
      `${dryRun ? "[dry-run] " : ""}games carrying inline heavy fields: ${candidate}`,
    );
    if (candidate === 0) return;

    // Walk a sample of candidates and check whether each has a
    // matching detail row. Full scan would be O(N) round-trips; a
    // 1000-doc sample is enough to flag a botched backfill.
    const sampleSize = Math.min(1000, candidate);
    const sample = await games
      .find(filter, { projection: { _id: 0, userId: 1, gameId: 1 } })
      .limit(sampleSize)
      .toArray();
    const sampleIds = sample.map((g) => ({ userId: g.userId, gameId: g.gameId }));
    /** @type {Array<{userId: string, gameId: string}>} */
    const missing = [];
    for (const id of sampleIds) {
      // eslint-disable-next-line no-await-in-loop
      const has = await details.countDocuments(
        { userId: id.userId, gameId: id.gameId },
        { limit: 1 },
      );
      if (has === 0) missing.push(id);
    }
    console.log(
      `sample of ${sampleSize} candidates: ${missing.length} missing a `
        + `gameDetails row (those would lose heavy data on $unset).`,
    );
    if (missing.length > 0 && !force) {
      console.error(
        "Refusing to proceed: backfill is incomplete. Re-run "
          + "``2026-05-07-backfill-game-details.js`` first, or pass "
          + "--force to ignore the risk.",
      );
      process.exit(3);
    }
    if (dryRun) {
      console.log("[dry-run] would $unset heavy fields on candidate docs.");
      return;
    }
    /** @type {Record<string, string>} */
    const unset = {};
    for (const k of HEAVY_FIELDS) unset[k] = "";
    const res = await games.updateMany(filter, {
      $unset: unset,
      $set: { _schemaVersion: TARGET_VERSION },
    });
    console.log(
      `done: matched=${res.matchedCount} modified=${res.modifiedCount}`,
    );
    console.log(
      "note: storage reclaim is gradual — WiredTiger compacts in "
        + "the background. Force immediate reclaim with "
        + "``db.runCommand({compact: 'games'})`` on the primary.",
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

module.exports = { TARGET_VERSION };
