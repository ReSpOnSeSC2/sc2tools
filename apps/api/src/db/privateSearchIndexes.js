"use strict";

// Stable name/key measured by the isolated owner/_id experiments. Only the
// opponent index ships: map quick search is deferred and needs no game index.
const PRIVATE_SEARCH_OPPONENT_INDEX = "b2_probe_owner_id_v1";

/** Optional index work never holds boot or falls back to an unbounded scan.
 * Example: startPrivateSearchIndex(ctx, logger).status(indexName).
 * @param {Pick<import('./connect').DbContext,'opponents'>} ctx
 * @param {import('pino').Logger|null} logger
 * @returns {import('./guideIndexes').BackgroundIndexBuilds}
 */
function startPrivateSearchIndex(ctx, logger) {
  /** @type {import('./guideIndexes').BackgroundIndexStatus} */ let state = "building";
  const started = Date.now();
  const settled = Promise.resolve().then(() => ctx.opponents.createIndex(
    { userId: 1, _id: 1 },
    { name: PRIVATE_SEARCH_OPPONENT_INDEX, unique: false, collation: { locale: "simple" }, timeoutMS: 0 },
  )).then(() => {
    state = "ready";
    logger?.info({ index: PRIVATE_SEARCH_OPPONENT_INDEX, durationMs: Date.now() - started }, "background_index_ready");
  }, () => {
    state = "failed";
    logger?.warn({ index: PRIVATE_SEARCH_OPPONENT_INDEX, code: "private_search_index_failed",
      durationMs: Date.now() - started }, "background_index_failed");
  });
  return { settled, status: name => name === PRIVATE_SEARCH_OPPONENT_INDEX ? state : null };
}

module.exports = { PRIVATE_SEARCH_OPPONENT_INDEX, startPrivateSearchIndex };
