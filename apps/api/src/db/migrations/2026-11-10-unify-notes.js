"use strict";

/**
 * Forward migration — move legacy ``opponent_notes`` rows into ``notes``.
 *
 * The API already does this lazily: the first time a user's notes are read
 * or written, NotesService.ensureMigrated moves that user's rows in bounded
 * batches. This script drains every remaining user ahead of time, using the
 * exact same per-user routine, so dormant accounts converge too.
 *
 * Each legacy row becomes an opponent note on the same account with
 * ``visibility: "stream"`` (notes always appeared on the scouting widget
 * before), ``scope: "account"``, no tags and the stored read-aloud choice.
 * Safety:
 *   - idempotent: upserts use $setOnInsert on the one-note-per-account slot,
 *     so a note already written in the new system is never overwritten;
 *   - no data loss: a legacy row is deleted only after its copy exists;
 *     malformed rows (no string pulseId/notes) are left untouched;
 *   - bounded: 200 rows per round trip, one user at a time.
 *
 * Run with:
 *   MONGODB_URI=... MONGODB_DB=... \
 *     node src/db/migrations/2026-11-10-unify-notes.js
 *
 * Flags:
 *   --dry-run   Count users and notes still to migrate without writing.
 */

const path = require("path");
const { MongoClient } = require("mongodb");

const { COLLECTIONS } = require(path.join(__dirname, "..", "..", "config", "constants"));
const { NotesService, LEGACY_FILTER, ensureNotesIndexes } = require(path.join(__dirname, "..", "..", "services", "notes"));

/**
 * @param {import('mongodb').Db} db
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {Promise<{users: number, notes: number}>}
 */
async function unifyNotes(db, opts = {}) {
  const ctx = {
    notes: db.collection(COLLECTIONS.NOTES),
    opponentNotes: db.collection(COLLECTIONS.OPPONENT_NOTES),
    games: db.collection(COLLECTIONS.GAMES),
  };
  if (opts.dryRun === true) {
    const [users, notes] = await Promise.all([
      ctx.opponentNotes.distinct("userId", LEGACY_FILTER),
      ctx.opponentNotes.countDocuments(LEGACY_FILTER),
    ]);
    return { users: users.length, notes };
  }
  await ensureNotesIndexes(ctx.notes);
  return new NotesService(/** @type {any} */ (ctx)).migrateAll();
}

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB;
  if (!uri || !dbName) {
    console.error("MONGODB_URI and MONGODB_DB must be set in the environment.");
    process.exit(2);
  }
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const counts = await unifyNotes(client.db(dbName), { dryRun });
    process.stdout.write(`${dryRun ? "[DRY RUN] " : ""}Done. users=${counts.users} notes=${counts.notes}\n`);
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

module.exports = { unifyNotes };
