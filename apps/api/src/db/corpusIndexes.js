"use strict";

// The analysis-corpus change stamp (util/corpusUpdatedAt.js) that a delta reader pages by: owner, stamp, then _id, so
// rows stamped by one bulk write still page in a stable order. Partial on rows that carry the stamp, so the first build
// scans games without holding boot and indexes nothing until rows are stamped. It has its own producer so the guide
// readiness wait (ctx.backgroundIndexes) never includes this full-collection build.
const CORPUS_UPDATED_AT_INDEX = "games_user_updated_at";

/** Optional index work never holds boot. Example: startCorpusStampIndex(ctx, logger).status(CORPUS_UPDATED_AT_INDEX).
 * @param {Pick<import('./connect').DbContext,'games'>} ctx
 * @param {import('pino').Logger|null} logger
 * @returns {import('./guideIndexes').BackgroundIndexBuilds}
 */
function startCorpusStampIndex(ctx, logger) {
  /** @type {import('./guideIndexes').BackgroundIndexStatus} */ let state = "building";
  const started = Date.now();
  const settled = Promise.resolve().then(() => ctx.games.createIndex(
    { userId: 1, updatedAt: 1, _id: 1 },
    { name: CORPUS_UPDATED_AT_INDEX, partialFilterExpression: { updatedAt: { $exists: true } }, timeoutMS: 0 },
  )).then(() => {
    state = "ready";
    logger?.info({ index: CORPUS_UPDATED_AT_INDEX, durationMs: Date.now() - started }, "background_index_ready");
  }, () => {
    state = "failed";
    logger?.warn({ index: CORPUS_UPDATED_AT_INDEX, code: "corpus_stamp_index_failed",
      durationMs: Date.now() - started }, "background_index_failed");
  });
  return { settled, status: name => name === CORPUS_UPDATED_AT_INDEX ? state : null };
}

module.exports = { CORPUS_UPDATED_AT_INDEX, startCorpusStampIndex };
