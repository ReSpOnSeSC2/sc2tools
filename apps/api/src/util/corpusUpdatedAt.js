"use strict";

// A games write that changes what GET /v1/games/analysis-corpus returns (a projected field, or the row's membership)
// stamps top-level `updatedAt`, so a delta reader can ask for rows changed since a watermark. The value is this
// process's clock when the write is issued, not when it commits, so a reader keeps an overlap window. Hard deletes
// leave no row to stamp. apps/api/__tests__/gamesUpdatedAtInventory.test.js keeps every games writer classified.

// Every field ANALYSIS_GAME_PROJECTION serves (services/games.js) plus the corpus membership flags.
const CORPUS_FIELDS = Object.freeze(["gameId", "date", "result", "myToonHandle", "myRace", "myMmr", "durationSec", "map",
  "myBuild", "macroScore", "opponent.displayName", "opponent.toonHandle", "opponent.mmr", "opponent.race",
  "opponent.pulseCharacterId", "opponent.pulseId", "opponent.strategy", "_deleted", "_deletionPending", "excluded",
  "isResumedFromReplay"]);
const CORPUS = Object.freeze(Object.fromEntries(CORPUS_FIELDS.map((field, index) => [`f${index}`, `$${field}`])));

/** Wraps update stages so `updatedAt` moves only when a corpus field changes. An unchanged row stays byte-identical,
 * so an idempotent write still reports no modification. @param {Array<Record<string, any>>} stages */
function stampWhenChanged(stages) {
  return [{ $set: { _corpusBefore: CORPUS } }, ...stages,
    { $set: { updatedAt: { $cond: [{ $eq: ["$_corpusBefore", CORPUS] }, "$updatedAt", new Date()] } } },
    { $unset: "_corpusBefore" }];
}

/** Adds the stamp to an aggregation-pipeline update, or to an operator update. A `$set`/`$unset` update becomes the
 * equivalent pipeline with literal values, so it stamps only on change; any other operator (an upsert's
 * `$setOnInsert`) stamps on every write. A pipeline would apply a numeric path segment to every array element and let
 * a `$set` and an `$unset` of one path both run, where the operator form addresses one element or fails, so those
 * shapes are refused. Converted paths must also have an object or missing parent, as every caller's do.
 * @param {Record<string, any>|Array<Record<string, any>>} update @returns {any} */
function withUpdatedAt(update) {
  if (Array.isArray(update)) return stampWhenChanged(update);
  if (!Object.keys(update).every(key => key === "$set" || key === "$unset")) {
    return { ...update, $set: { ...update.$set, updatedAt: new Date() } };
  }
  const set = Object.entries(update.$set || {}), unset = Object.keys(update.$unset || {});
  if (!set.length && !unset.length) throw new Error("corpus_stamp_empty_update");
  const paths = [...set.map(([field]) => field), ...unset];
  if (paths.some((path, index) => /(^|\.)\d+(\.|$)/.test(path) || paths.some((other, at) => at !== index
    && (other === path || other.startsWith(`${path}.`))))) throw new Error("corpus_stamp_unsupported_update");
  return stampWhenChanged([...(set.length ? [{ $set: Object.fromEntries(set.map(([field, value]) => [field, { $literal: value }])) }] : []),
    ...(unset.length ? [{ $unset: unset }] : [])]);
}

/** Adds the stamp to an inserted or replacement document. @param {Record<string, any>} row @returns {any} */
function rowWithUpdatedAt(row) { return { ...row, updatedAt: new Date() }; }

module.exports = { withUpdatedAt, rowWithUpdatedAt, CORPUS_FIELDS };
