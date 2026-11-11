"use strict";

/**
 * Cross-user ``games`` indexes for the classifier quality console
 * (services/classifierQuality.js): one per check-in axis, ordered by the
 * confirmation time the nightly window and the drill-down scan by. Partial
 * on confirmed, applied check-ins, so only check-in rows are indexed and
 * every other game costs nothing.
 *
 * Built in the BACKGROUND like guideIndexes' BACKGROUND_GAMES_INDEXES: the
 * first deploy scans the whole multi-user collection and must not hold
 * boot. Its own producer keeps the guide readiness wait unchanged; the
 * service refuses to scan (503) until both builds report ready.
 */

const CLASSIFIER_QUALITY_INDEXES = Object.freeze({
  build: "classifier_quality_build",
  opponent: "classifier_quality_opponent",
});

const SPECS = Object.freeze([
  Object.freeze({
    key: { "buildIntent.confirmedAt": -1 },
    options: {
      name: CLASSIFIER_QUALITY_INDEXES.build,
      partialFilterExpression: { "buildIntent.status": "confirmed", "buildIntent.applied": true },
    },
  }),
  Object.freeze({
    key: { "buildIntent.opponent.confirmedAt": -1 },
    options: {
      name: CLASSIFIER_QUALITY_INDEXES.opponent,
      partialFilterExpression: { "buildIntent.opponent.status": "confirmed", "buildIntent.opponent.applied": true },
    },
  }),
]);

/**
 * Start both builds without awaiting them; ``settled`` never rejects.
 * Example: startClassifierQualityIndexes(ctx, logger).status("classifier_quality_build") → "building".
 *
 * @param {Pick<import('./connect').DbContext, 'games'>} ctx
 * @param {import('pino').Logger|null} logger
 * @returns {import('./guideIndexes').BackgroundIndexBuilds}
 */
function startClassifierQualityIndexes(ctx, logger) {
  /** @type {Map<string, import('./guideIndexes').BackgroundIndexStatus>} */
  const statuses = new Map(SPECS.map(({ options }) => [options.name, "building"]));
  const builds = SPECS.map(({ key, options }) => {
    const started = Date.now();
    return Promise.resolve()
      .then(() => ctx.games.createIndex(key, { ...options, timeoutMS: 0 }))
      .then(() => {
        statuses.set(options.name, "ready");
        logger?.info({ index: options.name, durationMs: Date.now() - started }, "background_index_ready");
      }, () => {
        statuses.set(options.name, "failed");
        logger?.warn({ index: options.name, code: "classifier_quality_index_failed", durationMs: Date.now() - started },
          "background_index_failed");
      });
  });
  return { settled: Promise.all(builds).then(() => undefined), status: (name) => statuses.get(name) || null };
}

module.exports = { CLASSIFIER_QUALITY_INDEXES, CLASSIFIER_QUALITY_INDEX_SPECS: SPECS, startClassifierQualityIndexes };
