"use strict";

/**
 * SC2 Tools Guides indexes (docs/guides.md), called from
 * ``ensureIndexes`` in db/connect.js:
 *
 *   - ``ensureGuideIndexes``: the guide_* collections' own indexes,
 *     awaited at boot like every other index (small collections, and a
 *     no-op once they exist);
 *   - ``startBackgroundIndexBuilds``: the cross-user ``games`` index the
 *     nightly guide_stats aggregate starts on, built WITHOUT blocking boot
 *     (see BACKGROUND_GAMES_INDEXES for why).
 */

const { GUIDE_SAMPLE_TTL_SEC } = require("../config/guides");

/** @typedef {import('./connect').DbContext} DbContext */

/** @typedef {"building"|"ready"|"failed"} BackgroundIndexStatus */

/**
 * Progress of the index builds ``ensureIndexes`` starts without awaiting.
 *
 * @typedef {object} BackgroundIndexBuilds
 * @property {Promise<void>} settled resolves once every background build
 *   has finished, whether it succeeded or failed (never rejects)
 * @property {(name: string) => BackgroundIndexStatus|null} status one
 *   build's state by index name; null for an index that is not built in
 *   the background
 */

/**
 * Indexes over the whole multi-user ``games`` collection that are built in
 * the BACKGROUND: ``ensureIndexes`` starts them and returns without
 * waiting.
 *
 * Why: ``connect`` runs before ``httpServer.listen`` (server.js), and the
 * first deploy of a new cross-user index scans every games row — minutes
 * on production. Awaiting it would keep the port closed past Render's
 * health-check window and fail the deploy; it would also trip the
 * client's 30 s socket timeout (TIMEOUTS.MONGO_SOCKET_MS) and crash boot.
 * Nothing on the request path needs these indexes, so the build runs
 * with ``timeoutMS: 0`` (CSOT: no client-side deadline and no server
 * ``maxTimeMS``) and reports its outcome in the logs (info
 * ``background_index_ready`` / warn ``background_index_failed``). Once the
 * index exists, the boot-time call is a no-op that settles at once.
 *
 *   - ``guide_stats_build_opp_race`` {myBuild, opponent.race}: the guides
 *     nightly aggregate (services/guideStatsPipelines.js) — the only
 *     cross-user index a guide pipeline can use (every other games index
 *     is userId-prefixed). guideGamesMatch pins myBuild to exact catalog
 *     names and opponent.race to case-prefix regexes → tight bounds on
 *     both keys. Partial, so rows without a string myBuild cost nothing.
 *     Its only reader, GuideStatsService.recompute, waits briefly for a
 *     build still in progress and otherwise fails fast; the job's next
 *     hourly check retries.
 */
const BACKGROUND_GAMES_INDEXES = Object.freeze([
  Object.freeze({
    key: { myBuild: 1, "opponent.race": 1 },
    options: {
      name: "guide_stats_build_opp_race",
      partialFilterExpression: { myBuild: { $type: "string" } },
    },
  }),
]);

/** CSOT ``timeoutMS: 0`` = no client deadline (see BACKGROUND_GAMES_INDEXES). */
const BACKGROUND_INDEX_TIMEOUT_MS = 0;

/**
 * Start every BACKGROUND_GAMES_INDEXES build without awaiting it. Each
 * outcome is logged (index name, duration and error message only) and
 * recorded for ``status``; ``settled`` never rejects, so an unobserved
 * build can never surface as an unhandled rejection.
 *
 * Example:
 *   const builds = startBackgroundIndexBuilds(ctx, logger);
 *   builds.status("guide_stats_build_opp_race"); // "building"
 *   await builds.settled;
 *
 * @param {Pick<DbContext, "games">} ctx
 * @param {import('pino').Logger|null} logger
 * @returns {BackgroundIndexBuilds}
 */
function startBackgroundIndexBuilds(ctx, logger) {
  /** @type {Map<string, BackgroundIndexStatus>} */
  const statuses = new Map();
  const builds = BACKGROUND_GAMES_INDEXES.map(({ key, options }) => {
    const index = options.name;
    const startedMs = Date.now();
    statuses.set(index, "building");
    return ctx.games
      .createIndex(key, { ...options, timeoutMS: BACKGROUND_INDEX_TIMEOUT_MS })
      .then(
        () => {
          statuses.set(index, "ready");
          if (logger) logger.info({ index, durationMs: Date.now() - startedMs }, "background_index_ready");
        },
        (/** @type {unknown} */ err) => {
          statuses.set(index, "failed");
          if (!logger) return;
          const message = err instanceof Error ? err.message : String(err);
          logger.warn({ index, durationMs: Date.now() - startedMs, err: message }, "background_index_failed");
        },
      );
  });
  return {
    settled: Promise.all(builds).then(() => undefined),
    status: (name) => statuses.get(name) || null,
  };
}

/**
 * Every guide_* collection index, in boot order.
 *
 * @param {DbContext} ctx
 */
async function ensureGuideIndexes(ctx) {
  await ensureGuideSampleIndexes(ctx);
  await ensureGuideStatsIndexes(ctx);
  await ensureGuideVideoIndexes(ctx);
  // Coach's notes (services/guideNotes.js): one note per guide build.
  await ctx.guideNotes.createIndex(
    { matchup: 1, buildKey: 1 },
    { unique: true, name: "guide_notes_matchup_build" },
  );
}

/**
 * ``guide_samples`` (services/guideSamples.js): pseudonymous per-game
 * guide inputs.
 *   - unique {userHash, gameHash}: the idempotent ingest/backfill upsert
 *     key; its ``userHash`` prefix also serves GDPR deletes and the /me
 *     comparison, so no separate {userHash:1} index;
 *   - {matchup, buildKey, era}: the nightly per-matchup aggregation;
 *   - TTL on createdAt: rows age out GUIDE_SAMPLE_TTL_SEC after capture.
 *
 * @param {DbContext} ctx
 */
async function ensureGuideSampleIndexes(ctx) {
  await ctx.guideSamples.createIndex(
    { userHash: 1, gameHash: 1 },
    { unique: true, name: "guide_samples_user_game" },
  );
  await ctx.guideSamples.createIndex(
    { matchup: 1, buildKey: 1, era: 1 },
    { name: "guide_samples_matchup_build_era" },
  );
  await ctx.guideSamples.createIndex(
    { createdAt: 1 },
    { expireAfterSeconds: GUIDE_SAMPLE_TTL_SEC, name: "guide_samples_ttl" },
  );
}

/**
 * ``guide_stats`` (services/guideStats.js). Built here, not lazily in the
 * service (the ladder_meta way): the public read layer queries it from
 * boot, and the recompute's replace-by-key upserts need the unique key.
 *
 * @param {DbContext} ctx
 */
async function ensureGuideStatsIndexes(ctx) {
  await ctx.guideStats.createIndex({ key: 1 }, { unique: true, name: "guide_stats_key" });
  await ctx.guideStats.createIndex({ kind: 1, era: 1, matchup: 1 }, { name: "guide_stats_kind_era_matchup" });
}

/**
 * ``guide_videos`` (services/guideVideos.js): the site owner's YouTube
 * build-order videos.
 *   - unique {youtubeId}: the RSS/snapshot/admin upsert key;
 *   - {publishedAt: -1}: the newest-first read behind every guide page.
 *
 * @param {DbContext} ctx
 */
async function ensureGuideVideoIndexes(ctx) {
  await ctx.guideVideos.createIndex(
    { youtubeId: 1 },
    { unique: true, name: "guide_videos_youtube_id" },
  );
  await ctx.guideVideos.createIndex(
    { publishedAt: -1 },
    { name: "guide_videos_published_at" },
  );
}

module.exports = {
  BACKGROUND_GAMES_INDEXES,
  ensureGuideIndexes,
  startBackgroundIndexBuilds,
};
