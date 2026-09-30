"use strict";

/**
 * One-shot migration — name the pool-first openers for their patch.
 *
 * The openers are "8 Pool" on the 8-worker patch 5.0.16 and "12 Pool"
 * before it and again from 5.0.17, which restored 12 starting workers
 * (util/poolBuildNames.js). Agents 0.14.3 to 0.17.3 sent "8 Pool" for every
 * patch (a re-sync also relabelled older games), and earlier agents sent
 * "12 Pool" for 5.0.16 games. Ingest corrects new uploads. This corrects
 * what is already stored, by each row's era (util/patchEra.js):
 *
 *   - ``games``: ``myBuild``, ``opponent.strategy`` and the legacy
 *     ``opp_strategy``;
 *   - ``guide_samples``: ``buildKey``. Rule-1 rows are relabelled to the
 *     current era rule first (relabelEraRule), so their era can be trusted;
 *   - ``guide_notes``: ``buildKey``. The guide pages describe the 12-worker
 *     game, so an 8 Pool guide's admin notes and video pins move to the
 *     12 Pool guide, unless that guide already has a note (the pair is
 *     unique). A conflict is reported and left for the admin.
 *
 * Afterwards press **Recompute now** on /admin/guides. Ladder Meta rebuilds
 * nightly and at boot.
 *
 * Idempotent: re-running is a no-op once every label matches its patch.
 *
 * Run with:
 *   MONGODB_URI=... MONGODB_DB=... \
 *     node src/db/migrations/2026-09-30-rename-8-pool-builds.js
 *
 * Flags:
 *   --dry-run   Print the planned counts without writing (guide samples
 *               still under era rule 1 are not counted).
 */

const path = require("path");
const { MongoClient } = require("mongodb");

const { COLLECTIONS } = require(path.join(__dirname, "..", "..", "config", "constants"));
const { TWELVE_POOL_NAMES } = require(path.join(__dirname, "..", "..", "util", "poolBuildNames"));
const {
  PATCH_ERA_AFTER,
  PATCH_ERA_BEFORE,
  PATCH_ERA_RULE,
  buildEraMatch,
} = require(path.join(__dirname, "..", "..", "util", "patchEra"));
const { relabelEraRule } = require(path.join(__dirname, "..", "..", "services", "guideSamples"));

/** Label fields named on ``games`` rows. */
const GAME_FIELDS = Object.freeze(["myBuild", "opponent.strategy", "opp_strategy"]);

/**
 * @typedef {object} RenameCounts
 * @property {number} games       label fields renamed on games rows
 * @property {number} samples     guide_samples rows renamed
 * @property {number} notes       guide_notes rows moved to the 12 Pool guide
 * @property {Array<{ matchup: string, buildKey: string }>} noteConflicts
 *   8 Pool notes left in place because the 12 Pool guide already has one
 */

/**
 * @param {import('mongodb').Collection} coll
 * @param {Record<string, unknown>} filter
 * @param {Record<string, unknown>} set
 * @param {boolean} dryRun
 * @returns {Promise<number>} rows matched (dry run) or modified
 */
async function renameMany(coll, filter, set, dryRun) {
  if (dryRun) return coll.countDocuments(filter);
  const res = await coll.updateMany(filter, { $set: set });
  return res.modifiedCount;
}

/**
 * Move the 8 Pool guides' admin notes to the 12 Pool guides.
 *
 * @param {import('mongodb').Collection} notes guide_notes
 * @param {string} from 8 Pool name
 * @param {string} to 12 Pool name
 * @param {boolean} dryRun
 * @param {RenameCounts} counts
 */
async function moveNotes(notes, from, to, dryRun, counts) {
  const rows = await notes.find({ buildKey: from }, { projection: { _id: 1, matchup: 1 } }).toArray();
  for (const row of rows) {
    if (await notes.findOne({ matchup: row.matchup, buildKey: to }, { projection: { _id: 1 } })) {
      counts.noteConflicts.push({ matchup: row.matchup, buildKey: from });
      continue;
    }
    if (!dryRun) await notes.updateOne({ _id: row._id }, { $set: { buildKey: to } });
    counts.notes += 1;
  }
}

/**
 * Name every stored pool-opener label for its patch.
 *
 * Example: `await renamePoolBuilds(db, { dryRun: true })` →
 * `{ games: 42, samples: 3, notes: 0, noteConflicts: [] }`.
 *
 * @param {import('mongodb').Db} db
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {Promise<RenameCounts>}
 */
async function renamePoolBuilds(db, opts = {}) {
  const dryRun = opts.dryRun === true;
  const games = db.collection(COLLECTIONS.GAMES);
  const samples = db.collection(COLLECTIONS.GUIDE_SAMPLES);
  const notes = db.collection(COLLECTIONS.GUIDE_NOTES);
  if (!dryRun) await relabelEraRule(samples);
  const twelveWorker = buildEraMatch(PATCH_ERA_AFTER);
  const eightWorker = buildEraMatch(PATCH_ERA_BEFORE);
  /** @type {RenameCounts} */
  const counts = { games: 0, samples: 0, notes: 0, noteConflicts: [] };
  for (const [eight, twelve] of Object.entries(TWELVE_POOL_NAMES)) {
    for (const field of GAME_FIELDS) {
      counts.games += await renameMany(games, { $and: [twelveWorker, { [field]: eight }] }, { [field]: twelve }, dryRun);
      counts.games += await renameMany(games, { $and: [eightWorker, { [field]: twelve }] }, { [field]: eight }, dryRun);
    }
    const stamped = { eraRule: PATCH_ERA_RULE };
    counts.samples += await renameMany(
      samples, { ...stamped, era: PATCH_ERA_AFTER, buildKey: eight }, { buildKey: twelve }, dryRun,
    );
    counts.samples += await renameMany(
      samples, { ...stamped, era: PATCH_ERA_BEFORE, buildKey: twelve }, { buildKey: eight }, dryRun,
    );
    await moveNotes(notes, eight, twelve, dryRun, counts);
  }
  return counts;
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
    const counts = await renamePoolBuilds(client.db(dbName), { dryRun });
    console.log(
      `${dryRun ? "[DRY RUN] " : ""}Done. game labels=${counts.games} ` +
        `guide samples=${counts.samples} guide notes=${counts.notes}`,
    );
    for (const conflict of counts.noteConflicts) {
      console.warn(
        `  guide note left in place: ${conflict.matchup} "${conflict.buildKey}" ` +
          "(the 12 Pool guide already has a note)",
      );
    }
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

module.exports = { renamePoolBuilds };
