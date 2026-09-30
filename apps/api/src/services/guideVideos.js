"use strict";

/**
 * Guide videos — the site owner's build-order videos from their YouTube
 * channel, surfaced on the SC2 Tools Guides pages in the author's own
 * words (title, first paragraph and build checklist, verbatim).
 *
 * Storage: `guide_videos`, one row per video
 *   `{ youtubeId, title, description, publishedAt, channelId,
 *      source: "rss"|"snapshot"|"admin", isShort, hidden, updatedAt,
 *      _schemaVersion }`.
 *   - ensureSnapshot() seeds the committed channel snapshot
 *     (config/guideVideosSnapshot.json) with $setOnInsert only, so a row
 *     the RSS sync already refreshed is never overwritten.
 *   - syncFromChannel() reads the channel's public Atom feed (the newest
 *     15 videos) and upserts; it never deletes, so older videos stay.
 *   - addVideo() lets an admin add an older video by id (oEmbed lookup;
 *     only videos of the configured channel, since every guide credits
 *     the channel's author).
 *
 * Reads: matching is recomputed at read time from the live catalog
 * (services/guideVideoMatch.js) plus the snapshot's hand-curated links,
 * over an in-memory copy of the (small) collection refreshed every
 * CACHE_TTL_MS. Videos published during the 8-worker patch 5.0.16
 * (``eightWorkerPatch``) teach a build order the 12-worker guides no
 * longer cover: guides and matchup pages show them only where an admin
 * pins them. Guide reads are fail-soft: a Mongo error yields [] so a
 * guide page never fails because its video block could not load.
 *
 * Helpers: guideVideoFeed.js (Atom parser), guideVideoMatch.js (catalog
 * matching), guideVideoText.js (excerpt, checklist, public shape),
 * guideVideoSelect.js (ordering and caps), guideVideoHttp.js (bounded
 * YouTube requests). Logs carry reason codes and counts only.
 */

const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");
const {
  MATCHUPS,
  isGuideBuildName,
  isGuideStrategyName,
} = require("../config/guideSlugs");
const { parseChannelFeed } = require("./guideVideoFeed");
const {
  matchVideo,
  applyCuratedLinks,
  isValidCuratedLink,
} = require("./guideVideoMatch");
const {
  toPublicVideo,
  extractChecklist,
  extractExcerpt,
} = require("./guideVideoText");
const {
  VIDEO_LIST_DEFAULT,
  isVideoId,
  compareRows,
  adminItem,
  selectForGuide,
  selectLatest,
} = require("./guideVideoSelect");
const {
  HTTP_BAD_REQUEST,
  HTTP_UNPROCESSABLE,
  HTTP_BAD_GATEWAY,
  HTTP_UNAVAILABLE,
  videoError,
  validChannelId,
  validChannelUrl,
  fetchChannelFeed,
  lookupOembed,
} = require("./guideVideoHttp");
const SNAPSHOT = require("../config/guideVideosSnapshot.json");
const {
  PATCH_ERA_AFTER,
  PATCH_ERA_BEFORE,
  PATCH_5_0_16_RELEASE,
  PATCH_5_0_17_RELEASE,
} = require("../util/patchEra");

/** Publish dates of videos recorded on the 8-worker patch 5.0.16. */
const EIGHT_WORKER_VIDEO_WINDOW = Object.freeze({ from: PATCH_5_0_16_RELEASE, until: PATCH_5_0_17_RELEASE });
/** How long guide reads reuse the in-memory copy of guide_videos. */
const CACHE_TTL_MS = 5 * 60 * 1000;
/** Most rows read into memory (the channel has a few dozen videos). */
const MAX_VIDEOS_LOADED = 500;
/** Mongo duplicate-key error code (tolerated when two boots seed at once). */
const DUPLICATE_KEY = 11000;
/** Projection for every read: storage bookkeeping stays in Mongo. */
const READ_PROJECTION = Object.freeze({ _id: 0, _schemaVersion: 0 });
/** The "@handle" path segment of a canonical YouTube channel URL. */
const CHANNEL_HANDLE_RE = /^https:\/\/www\.youtube\.com\/@([^/]+)(?:\/|$)/;

/**
 * @typedef {import('./guideVideoMatch').CuratedLink} CuratedLink
 * @typedef {import('./guideVideoText').PublicVideo} PublicVideo
 * @typedef {import('./guideVideoFeed').FeedVideo} FeedVideo
 * @typedef {import('./guideVideoSelect').GuideVideoDoc} GuideVideoDoc
 * @typedef {import('./guideVideoSelect').VideoRow} VideoRow
 * @typedef {import('./guideVideoSelect').VideoOverrides} VideoOverrides
 * @typedef {import('./guideVideoSelect').AdminVideo} AdminVideo
 */

/**
 * @typedef {object} VideoSnapshot
 * @property {string} channelId
 * @property {string} channelName
 * @property {CuratedLink[]} curatedLinks
 * @property {{ youtubeId: string, title: string, publishedAt: string,
 *   isShort: boolean, description: string }[]} videos
 */

/**
 * RSS row upsert: refresh the feed's fields, never touch `hidden`.
 *
 * @param {FeedVideo} video
 * @param {Date} now
 * @returns {import('mongodb').AnyBulkWriteOperation}
 */
function rssUpsert(video, now) {
  return {
    updateOne: {
      filter: { youtubeId: video.youtubeId },
      update: {
        $set: {
          title: video.title,
          description: video.description,
          publishedAt: new Date(video.publishedAt),
          channelId: video.channelId,
          isShort: video.isShort,
          source: "rss",
          updatedAt: now,
        },
        $setOnInsert: stampVersion({ youtubeId: video.youtubeId, hidden: false }, COLLECTIONS.GUIDE_VIDEOS),
      },
      upsert: true,
    },
  };
}

/**
 * Snapshot row insert ($setOnInsert only).
 *
 * @param {VideoSnapshot["videos"][number]} video
 * @param {string} channelId
 * @param {Date} now
 * @returns {import('mongodb').AnyBulkWriteOperation}
 */
function snapshotInsert(video, channelId, now) {
  return {
    updateOne: {
      filter: { youtubeId: video.youtubeId },
      update: {
        $setOnInsert: stampVersion({
          youtubeId: video.youtubeId,
          title: video.title,
          description: video.description || "",
          publishedAt: new Date(video.publishedAt),
          channelId,
          source: "snapshot",
          isShort: video.isShort === true,
          hidden: false,
          updatedAt: now,
        }, COLLECTIONS.GUIDE_VIDEOS),
      },
      upsert: true,
    },
  };
}

/**
 * @param {VideoSnapshot["videos"][number]} video
 * @returns {boolean}
 */
function isValidSnapshotVideo(video) {
  return isVideoId(video.youtubeId)
    && typeof video.title === "string"
    && !Number.isNaN(Date.parse(video.publishedAt));
}

/**
 * The "@handle" of a canonical channel URL ("https://www.youtube.com/@X"
 * or ".../@X/videos"), percent-decoded when well formed; null otherwise.
 *
 * @param {string} url
 * @returns {string|null}
 */
function handleFromUrl(url) {
  const hit = CHANNEL_HANDLE_RE.exec(url);
  if (!hit) return null;
  try {
    return decodeURIComponent(hit[1]);
  } catch {
    return hit[1];
  }
}

/**
 * @param {unknown} err
 * @returns {boolean} true for a bulk write whose only failures are duplicate keys
 */
function isDuplicateOnly(err) {
  const e = /** @type {any} */ (err);
  if (!e) return false;
  if (e.code === DUPLICATE_KEY) return true;
  const writeErrors = Array.isArray(e.writeErrors) ? e.writeErrors : [];
  return writeErrors.length > 0
    && writeErrors.every((/** @type {{ code?: number }} */ w) => w.code === DUPLICATE_KEY);
}

class GuideVideosService {
  /**
   * @param {{ guideVideos?: import('mongodb').Collection<any> }} db
   * @param {{
   *   channelId?: string|null,
   *   channelUrl?: string|null,
   *   logger?: import('pino').Logger,
   *   fetchImpl?: typeof fetch,
   *   now?: () => number,
   *   snapshot?: VideoSnapshot,
   *   eightWorkerWindow?: { from: Date, until: Date } | null,
   * }} [opts] ``eightWorkerWindow``: publish dates of 8-worker patch videos
   *   (default: the 5.0.16 release until the 5.0.17 revert; null: none)
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.channelId = validChannelId(opts.channelId);
    this.channelUrl = validChannelUrl(opts.channelUrl);
    this.logger = opts.logger ? opts.logger.child({ component: "guideVideos" }) : null;
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.now = opts.now || Date.now;
    /** @type {VideoSnapshot} */
    this.snapshot = opts.snapshot || /** @type {VideoSnapshot} */ (SNAPSHOT);
    /** @type {CuratedLink[]} */
    this.curatedLinks = (this.snapshot.curatedLinks || []).filter(isValidCuratedLink);
    /** @type {{ from: Date, until: Date } | null} */
    this.eightWorkerWindow = opts.eightWorkerWindow === undefined
      ? EIGHT_WORKER_VIDEO_WINDOW
      : opts.eightWorkerWindow;
    /** @type {{ at: number, rows: VideoRow[] } | null} */
    this.cache = null;
    /** @type {Promise<VideoRow[]> | null} */
    this.loading = null;
    /** Bumped by invalidate() so a read that started earlier is not cached. */
    this.generation = 0;
  }

  /** @returns {boolean} true when a valid channel id is configured */
  isConfigured() {
    return this.channelId !== null;
  }

  /**
   * The channel link for the guides hub, or null when no URL is set or
   * the channel cannot be named from real data.
   *
   * @returns {{ url: string, name: string } | null}
   */
  channel() {
    if (!this.channelUrl) return null;
    const name = handleFromUrl(this.channelUrl)
      || (this.channelId === this.snapshot.channelId ? this.snapshot.channelName : null);
    return name ? { url: this.channelUrl, name } : null;
  }

  /** Drop the in-memory copy (after writes). */
  invalidate() {
    this.cache = null;
    this.generation += 1;
  }

  /** @returns {import('mongodb').Collection<any>|null} */
  collection() {
    return (this.db && this.db.guideVideos) || null;
  }

  /**
   * @param {GuideVideoDoc} doc
   * @returns {VideoRow}
   */
  decorate(doc) {
    const match = applyCuratedLinks(doc.youtubeId, matchVideo(doc), this.curatedLinks);
    return {
      doc,
      match,
      buildOrder: match.matchup !== null,
      eightWorkerPatch: this.isEightWorkerVideo(doc),
      video: toPublicVideo(doc),
    };
  }

  /**
   * True for a video published during the 8-worker patch. An undated
   * (admin-added, not yet in the feed) video is not, so it shows at once.
   *
   * @param {GuideVideoDoc} doc
   * @returns {boolean}
   */
  isEightWorkerVideo(doc) {
    const window = this.eightWorkerWindow;
    if (!window || !(doc.publishedAt instanceof Date)) return false;
    const at = doc.publishedAt.getTime();
    return at >= window.from.getTime() && at < window.until.getTime();
  }

  /**
   * Every row, decorated and sorted newest first.
   *
   * @returns {Promise<VideoRow[]>}
   */
  async readRows() {
    const coll = this.collection();
    if (!coll) return [];
    const docs = /** @type {GuideVideoDoc[]} */ (await coll
      .find({}, { projection: READ_PROJECTION })
      .sort({ publishedAt: -1, youtubeId: 1 })
      .limit(MAX_VIDEOS_LOADED)
      .toArray());
    return docs
      .filter((doc) => isVideoId(doc.youtubeId) && typeof doc.title === "string")
      .map((doc) => this.decorate(doc))
      .sort(compareRows);
  }

  /**
   * Cached rows for guide reads (single flight); [] when Mongo fails.
   *
   * @returns {Promise<VideoRow[]>}
   */
  async cachedRows() {
    const now = this.now();
    if (this.cache && now - this.cache.at < CACHE_TTL_MS) return this.cache.rows;
    if (!this.loading) {
      this.loading = this.loadCache(now).finally(() => {
        this.loading = null;
      });
    }
    return this.loading;
  }

  /**
   * @param {number} now
   * @returns {Promise<VideoRow[]>}
   */
  async loadCache(now) {
    const generation = this.generation;
    try {
      const rows = await this.readRows();
      if (generation === this.generation) this.cache = { at: now, rows };
      return rows;
    } catch (err) {
      const e = /** @type {any} */ (err);
      const code = e && typeof e.codeName === "string" ? e.codeName : "read_failed";
      this.logger?.warn({ code }, "guide_videos_read_failed");
      return [];
    }
  }

  /**
   * Videos for a build guide: pinned, then videos whose title names the
   * build (or curated to it), newest first; ≤ 3.
   *
   * @param {string} matchup "PvZ" form
   * @param {string} buildKey exact catalog name
   * @param {VideoOverrides|null} [overrides]
   * @returns {Promise<PublicVideo[]>}
   */
  async videosForBuild(matchup, buildKey, overrides = null) {
    if (!isGuideBuildName(matchup, buildKey)) return [];
    const rows = await this.cachedRows();
    return selectForGuide(rows, (m) => m.matchup === matchup && m.builds.includes(buildKey), overrides);
  }

  /**
   * Videos for a counter guide (opponent strategy); same rules as
   * videosForBuild.
   *
   * @param {string} matchup "PvZ" form (the viewer's matchup)
   * @param {string} strategyKey exact catalog name
   * @param {VideoOverrides|null} [overrides]
   * @returns {Promise<PublicVideo[]>}
   */
  async videosForCounter(matchup, strategyKey, overrides = null) {
    if (!isGuideStrategyName(matchup, strategyKey)) return [];
    const rows = await this.cachedRows();
    return selectForGuide(rows, (m) => m.matchup === matchup && m.counters.includes(strategyKey), overrides);
  }

  /**
   * Latest build-order videos of one matchup, newest first. The current
   * (12-worker) view leaves out 8-worker patch videos; the 8-worker view
   * (era "before") keeps them.
   *
   * @param {string} matchup "PvZ" form
   * @param {number} [n] 1..12, default 4
   * @param {string} [era] util/patchEra.js era id, default the current one
   * @returns {Promise<PublicVideo[]>}
   */
  async videosForMatchup(matchup, n = VIDEO_LIST_DEFAULT, era = PATCH_ERA_AFTER) {
    if (!MATCHUPS.includes(matchup)) return [];
    return selectLatest(await this.cachedRows(), n, matchup, era !== PATCH_ERA_BEFORE);
  }

  /**
   * Latest build-order videos across matchups (no Shorts, no stream VODs,
   * matchup detected), newest first.
   *
   * @param {number} [n] 1..12, default 4
   * @returns {Promise<PublicVideo[]>}
   */
  async latest(n = VIDEO_LIST_DEFAULT) {
    return selectLatest(await this.cachedRows(), n, null);
  }

  /**
   * Every stored video with its detected match, for the admin panel
   * (hidden videos and Shorts included; reads Mongo directly).
   *
   * @returns {Promise<AdminVideo[]>}
   */
  async listForAdmin() {
    return (await this.readRows()).map(adminItem);
  }

  /**
   * One stored video in admin shape, or null.
   *
   * @param {unknown} youtubeId
   * @returns {Promise<AdminVideo|null>}
   */
  async adminVideo(youtubeId) {
    const coll = this.collection();
    if (!coll || !isVideoId(youtubeId)) return null;
    const doc = /** @type {GuideVideoDoc|null} */ (
      await coll.findOne({ youtubeId }, { projection: READ_PROJECTION }));
    return doc ? adminItem(this.decorate(doc)) : null;
  }

  /**
   * Seed the committed channel snapshot. Only for the snapshot's own
   * channel; `$setOnInsert` only, so newer RSS/admin rows are untouched.
   *
   * @returns {Promise<{ inserted: number }>}
   */
  async ensureSnapshot() {
    const coll = this.collection();
    if (!coll || !this.channelId || this.channelId !== this.snapshot.channelId) return { inserted: 0 };
    const now = new Date(this.now());
    const ops = this.snapshot.videos
      .filter(isValidSnapshotVideo)
      .map((video) => snapshotInsert(video, /** @type {string} */ (this.channelId), now));
    if (ops.length === 0) return { inserted: 0 };
    try {
      const res = await coll.bulkWrite(ops, { ordered: false });
      return { inserted: res.upsertedCount };
    } catch (err) {
      if (!isDuplicateOnly(err)) throw err;
      return { inserted: 0 };
    } finally {
      this.invalidate();
    }
  }

  /**
   * Pull the channel's Atom feed and upsert every entry of the configured
   * channel. Never deletes. Throws a coded error (channel_not_configured,
   * feed_timeout, feed_http_<status>, feed_too_large, feed_empty, …).
   *
   * @returns {Promise<{ fetched: number, inserted: number, updated: number }>}
   */
  async syncFromChannel() {
    const coll = this.collection();
    const channelId = this.channelId;
    if (!coll || !channelId) throw videoError("channel_not_configured", HTTP_UNAVAILABLE);
    const xml = await fetchChannelFeed(this.fetchImpl, channelId);
    const videos = parseChannelFeed(xml).filter((video) => video.channelId === channelId);
    if (videos.length === 0) throw videoError("feed_empty", HTTP_BAD_GATEWAY);
    const now = new Date(this.now());
    try {
      const res = await coll.bulkWrite(videos.map((video) => rssUpsert(video, now)), { ordered: false });
      return { fetched: videos.length, inserted: res.upsertedCount, updated: res.modifiedCount };
    } finally {
      this.invalidate();
    }
  }

  /**
   * True when an oEmbed author URL is the configured channel.
   *
   * @param {unknown} authorUrl
   * @returns {boolean}
   */
  isChannelAuthor(authorUrl) {
    const url = validChannelUrl(authorUrl);
    if (!url) return false;
    if (this.channelUrl && url.toLowerCase() === this.channelUrl.toLowerCase()) return true;
    return this.channelId !== null && url === `https://www.youtube.com/channel/${this.channelId}`;
  }

  /**
   * Admin: add (or un-hide) a video of the configured channel by id. The
   * RSS sync fills in its description and publish time once the video is
   * among the feed's newest; until then publishedAt is null (never
   * invented).
   *
   * @param {unknown} youtubeId
   * @returns {Promise<AdminVideo>}
   */
  async addVideo(youtubeId) {
    const coll = this.collection();
    if (!isVideoId(youtubeId)) throw videoError("invalid_video_id", HTTP_BAD_REQUEST);
    if (!coll || !this.channelId) throw videoError("channel_not_configured", HTTP_UNAVAILABLE);
    const meta = await lookupOembed(this.fetchImpl, youtubeId);
    if (!this.isChannelAuthor(meta.authorUrl)) throw videoError("video_not_on_channel", HTTP_UNPROCESSABLE);
    const now = new Date(this.now());
    await coll.updateOne({ youtubeId }, {
      $set: { hidden: false, updatedAt: now },
      $setOnInsert: stampVersion({
        youtubeId, title: meta.title, description: "", publishedAt: null,
        channelId: this.channelId, source: "admin", isShort: false,
      }, COLLECTIONS.GUIDE_VIDEOS),
    }, { upsert: true });
    this.invalidate();
    return /** @type {AdminVideo} */ (await this.adminVideo(youtubeId));
  }

  /**
   * Admin: hide or show a video on every guide.
   *
   * @param {unknown} youtubeId
   * @param {boolean} hidden
   * @returns {Promise<AdminVideo|null>} null when the video is unknown
   */
  async setHidden(youtubeId, hidden) {
    const coll = this.collection();
    if (!isVideoId(youtubeId)) throw videoError("invalid_video_id", HTTP_BAD_REQUEST);
    if (!coll) return null;
    const res = await coll.updateOne(
      { youtubeId },
      { $set: { hidden: hidden === true, updatedAt: new Date(this.now()) } },
    );
    this.invalidate();
    return res.matchedCount > 0 ? this.adminVideo(youtubeId) : null;
  }
}

module.exports = {
  GuideVideosService,
  parseChannelFeed,
  matchVideo,
  extractChecklist,
  extractExcerpt,
  toPublicVideo,
};
