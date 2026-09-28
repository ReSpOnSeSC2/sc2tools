"use strict";

/**
 * SC2 Tools Guides — the public read layer over the nightly guide_stats
 * docs (services/guideStats.js), the build catalog (config/guideSlugs.js),
 * coach's notes (services/guideNotes.js) and the owner's build-order
 * videos (services/guideVideos.js). routes/guides.js serves it.
 *
 * Reads are indexed point/range lookups on guide_stats ({key} unique,
 * {kind, era, matchup}); the heavy lifting happened in the nightly run.
 * Shaping is delegated to the pure modules services/guidesPayloads.js and
 * services/guidesPagePayloads.js (explicit allowlists, identity-only
 * payloads below the page floor). Build pages add serve-time links from
 * services/guidesRelated.js (exact-name community builds, re-verified
 * example replays); `/me` reads only the caller's own rows
 * (services/guidesPersonal.js).
 *
 * Everything around the numbers is fail-soft on a build page: the videos
 * service already returns [] on errors, a notes read failure only drops
 * the note, and a failed community-link or example re-check only drops
 * those links — the numbers still render.
 */

const { GUIDE_CURRENT_ERA } = require("../config/guides");
const { shapeIndexPayload, shapeMatchupPayload } = require("./guidesPayloads");
const {
  shapeBuildPayload,
  shapeCounterPayload,
  shapeMapPayload,
  shapeSitemapPayload,
} = require("./guidesPagePayloads");
const { communityBuildLinks, verifyExamples } = require("./guidesRelated");
const { personalGuideStats } = require("./guidesPersonal");

/** Hub / matchup video rows. */
const GUIDE_VIDEOS_LATEST = 4;
/** Published maps listed on the hub (games desc). */
const INDEX_MAPS_MAX = 200;
/** Bound on the sitemap read (every published page of one era). */
const SITEMAP_DOCS_MAX = 5000;
const RUN_KEY = "run";
/** Storage fields that never leave Mongo (the shapers allowlist anyway). */
const DOC_PROJECTION = Object.freeze({ _id: 0, _schemaVersion: 0, baseline: 0, baselineCandidate: 0 });
const BUILD_BAND_PROJECTION = Object.freeze({
  _id: 0, buildKey: 1, buildSlug: 1, published: 1, isNew: 1, bands: 1,
});
/** Identity plus what the serve-time published re-check reads (overall, games). */
const SITEMAP_PROJECTION = Object.freeze({
  _id: 0, kind: 1, matchup: 1, buildSlug: 1, strategySlug: 1, mapSlug: 1, published: 1, overall: 1, games: 1,
});

/** @typedef {import('./guidesPayloads').Doc} Doc */
/** @typedef {import('./guidesPayloads').GuideBand} GuideBand */

/**
 * @typedef {object} GuidesServiceDeps
 * @property {Pick<import('./guideNotes').GuideNotesService, "find">} [guideNotes]
 * @property {Pick<import('./guideVideos').GuideVideosService,
 *   "latest"|"videosForMatchup"|"videosForBuild"|"videosForCounter"|"channel">} [guideVideos]
 * @property {import('pino').Logger|null} [logger]
 */

class GuidesService {
  /**
   * @param {import('../db/connect').DbContext} db uses guideStats, guideSamples, games, users, communityBuilds
   * @param {GuidesServiceDeps} [deps]
   */
  constructor(db, deps = {}) {
    this.db = db;
    this.coll = db.guideStats;
    this.guideNotes = deps.guideNotes || null;
    this.guideVideos = deps.guideVideos || null;
    this.logger = deps.logger || null;
  }

  /**
   * @param {string} key
   * @returns {Promise<Doc|null>}
   */
  async _doc(key) {
    return this.coll.findOne({ key }, { projection: DOC_PROJECTION });
  }

  /** @returns {Promise<Date|null>} the last completed run */
  async _runComputedAt() {
    const run = await this.coll.findOne({ key: RUN_KEY }, { projection: { _id: 0, computedAt: 1 } });
    return run && run.computedAt instanceof Date ? run.computedAt : null;
  }

  /**
   * Hub payload (`GET /v1/guides`), current era.
   *
   * @returns {Promise<ReturnType<typeof shapeIndexPayload>>}
   */
  async index() {
    const era = GUIDE_CURRENT_ERA;
    const [computedAt, matchupDocs, mapDocs, videos] = await Promise.all([
      this._runComputedAt(),
      this.coll.find({ kind: "matchup", era }, { projection: DOC_PROJECTION }).toArray(),
      this.coll
        .find({ kind: "map", era, published: true }, { projection: { _id: 0, map: 1, mapSlug: 1, games: 1, published: 1 } })
        .sort({ games: -1 })
        .limit(INDEX_MAPS_MAX)
        .toArray(),
      this.guideVideos ? this.guideVideos.latest(GUIDE_VIDEOS_LATEST) : [],
    ]);
    const channel = this.guideVideos ? this.guideVideos.channel() : null;
    return shapeIndexPayload({ era, computedAt, matchupDocs, mapDocs, videos, channel });
  }

  /**
   * Matchup payload, optionally for one opponent band / era.
   *
   * Example: `await guides.matchup("PvZ", { era: "after", band: { type: "league", value: 4, label: "Diamond" } })`.
   *
   * @param {string} matchup "PvZ" form (validated by the route)
   * @param {{ era: string, band: GuideBand|null }} opts
   */
  async matchup(matchup, opts) {
    const { era, band } = opts;
    const [doc, buildDocs, videos] = await Promise.all([
      this._doc(`matchup:${era}:${matchup}`),
      this.coll.find({ kind: "build", era, matchup }, { projection: BUILD_BAND_PROJECTION }).toArray(),
      this.guideVideos ? this.guideVideos.videosForMatchup(matchup, GUIDE_VIDEOS_LATEST) : [],
    ]);
    return shapeMatchupPayload({ matchup, era, band, doc, buildDocs, videos });
  }

  /**
   * Build guide payload (current era). Unpublished → identity + videos.
   *
   * @param {{ matchup: string, name: string, slug: string }} build resolved slug
   */
  async build(build) {
    const era = GUIDE_CURRENT_ERA;
    const { matchup, name: buildKey } = build;
    const [doc, matchupDoc, note] = await Promise.all([
      this._doc(`build:${era}:${matchup}:${build.slug}`),
      this._doc(`matchup:${era}:${matchup}`),
      this._note(matchup, buildKey),
    ]);
    const published = Boolean(doc && doc.published === true);
    const [videos, communityBuilds, examples] = await Promise.all([
      this.guideVideos ? this.guideVideos.videosForBuild(matchup, buildKey, note ? note.videos : null) : [],
      published
        ? this._softList(communityBuildLinks(this.db.communityBuilds, matchup, buildKey), "guide_community_links_failed")
        : [],
      published && doc
        ? this._softList(verifyExamples(this.db.users, doc.examples), "guide_examples_verify_failed")
        : [],
    ]);
    const notes = note && note.body.trim() ? { body: note.body, updatedAt: note.updatedAt } : null;
    return shapeBuildPayload({
      matchup, buildKey, buildSlug: build.slug, era, doc, matchupDoc, videos, communityBuilds, examples, notes,
    });
  }

  /**
   * Counter guide payload (current era).
   *
   * @param {{ matchup: string, name: string, slug: string }} strategy resolved slug
   */
  async counter(strategy) {
    const era = GUIDE_CURRENT_ERA;
    const { matchup, name: strategyKey } = strategy;
    const [doc, matchupDoc, videos] = await Promise.all([
      this._doc(`counter:${era}:${matchup}:${strategy.slug}`),
      this._doc(`matchup:${era}:${matchup}`),
      this.guideVideos ? this.guideVideos.videosForCounter(matchup, strategyKey, null) : [],
    ]);
    return shapeCounterPayload({ matchup, strategyKey, strategySlug: strategy.slug, era, doc, matchupDoc, videos });
  }

  /**
   * Map guide payload (current era), or null for a map without a doc.
   *
   * @param {string} mapSlugValue canonical map slug (validated by the route)
   */
  async map(mapSlugValue) {
    const era = GUIDE_CURRENT_ERA;
    const doc = await this._doc(`map:${era}:${mapSlugValue}`);
    if (!doc || typeof doc.map !== "string" || typeof doc.mapSlug !== "string") return null;
    return shapeMapPayload({ era, doc });
  }

  /**
   * Published current-era guide pages for the web sitemap.
   *
   * @returns {Promise<ReturnType<typeof shapeSitemapPayload>>}
   */
  async sitemap() {
    const era = GUIDE_CURRENT_ERA;
    const [computedAt, docs, videos] = await Promise.all([
      this._runComputedAt(),
      this.coll
        .find(
          { kind: { $in: ["matchup", "build", "counter", "map"] }, era, published: true },
          { projection: SITEMAP_PROJECTION },
        )
        .sort({ key: 1 })
        .limit(SITEMAP_DOCS_MAX)
        .toArray(),
      this.guideVideos ? this.guideVideos.latest(1) : [],
    ]);
    return shapeSitemapPayload({ computedAt, docs, hasVideos: videos.length > 0 });
  }

  /**
   * The caller's own record and timings with one build (`/me`).
   *
   * @param {{ userId: string, userHash: string, matchup: string, buildKey: string }} who
   */
  async me(who) {
    return personalGuideStats(this.db, who);
  }

  /** @returns {Promise<number>} guide_samples rows (estimated; admin status) */
  async sampleCount() {
    return this.db.guideSamples.estimatedDocumentCount();
  }

  /**
   * The build's note, or null (a read failure only drops the note).
   *
   * @param {string} matchup
   * @param {string} buildKey
   */
  async _note(matchup, buildKey) {
    if (!this.guideNotes) return null;
    try {
      return await this.guideNotes.find(matchup, buildKey);
    } catch (err) {
      this.logger?.warn({ code: errorCode(err) }, "guide_notes_read_failed");
      return null;
    }
  }

  /**
   * A serve-time side read of a build page that must never fail the page
   * (community links, re-verified examples): on error it logs a reason
   * code (no ids) and yields [] — for examples that also means "not
   * shown", the privacy-safe side.
   *
   * @template T
   * @param {Promise<T[]>} read
   * @param {string} message log message
   * @returns {Promise<T[]>}
   */
  async _softList(read, message) {
    try {
      return await read;
    } catch (err) {
      this.logger?.warn({ code: errorCode(err) }, message);
      return [];
    }
  }
}

/**
 * A loggable reason code for a failed read (Mongo ``codeName``), never a
 * message that could carry ids.
 *
 * @param {unknown} err
 * @returns {string}
 */
function errorCode(err) {
  const e = /** @type {any} */ (err);
  return e && typeof e.codeName === "string" ? e.codeName : "read_failed";
}

module.exports = { GuidesService, GUIDE_VIDEOS_LATEST };
