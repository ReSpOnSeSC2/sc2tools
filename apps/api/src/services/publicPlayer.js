"use strict";

const { createHash } = require("crypto");
const { PLAYER_SLUG_RE, PLAYER_UUID_RE, createPlayerSlug, validPlayerSlug, publicPlayerSettings, safeIso, playerError } = require("../util/publicPlayerConfig");
const { cleanDisplayName } = require("../util/contentFilter");
const { shapeTotals, shapeMatchups, shapeSignatureBuilds, shapeFeaturedBuild } = require("./publicProfile");
const { recentForm, extraAggregates, publicReviewer } = require("./publicPlayerAggregates");
const { normalizeChannelUrl } = require("./playerChannels");
const { publicPlayerSitemap } = require("./publicPlayerSitemap");
const USER_PROJECTION = { _id: 0, userId: 1, displayName: 1, publicProfile: 1, "replaySharing.slug": 1, "replaySharing.enabled": 1 };
const CACHE_MAX = 256;
const CACHE_MS = 300_000;

/** Gates are read before the bounded aggregate cache. Explicit privacy switches
 * never borrow consent from replay sharing, channel ownership or review data. */
class PublicPlayerService {
  /** @param {import('../db/connect').DbContext} db @param {{community:any,profile:any,aggregations:any,builds:any,replayLibrary:any,seasons?:any}} opts */
  constructor(db, opts) {
    this.db = db; this.community = opts.community; this.profile = opts.profile;
    this.aggregations = opts.aggregations; this.builds = opts.builds; this.replayLibrary = opts.replayLibrary;
    this.seasons = opts.seasons || null;
    this.cache = new Map();
  }

  sitemap() { return publicPlayerSitemap(this.db); }

  /** Resolve only indexed canonical links or the already-public legacy UUID.
   * @param {string} handle */
  async resolve(handle) {
    if (typeof handle !== "string") return null;
    const queries = [];
    if (validPlayerSlug(handle)) queries.push({ "replaySharing.slug": handle });
    if (PLAYER_UUID_RE.test(handle)) queries.push({ userId: handle });
    if (!queries.length) return null;
    let user = await this.db.users.findOne({ $or: queries }, { projection: USER_PROJECTION, maxTimeMS: 3000 });
    if (!user?.userId) return null;
    let author = await this.community.getAuthor(user.userId, { maxTimeMS: 3000, slimProfile: true });
    const initialSettings = publicPlayerSettings(user, Boolean(author));
    // Named legacy publications already opted into a profile. Allocate only
    // their missing address, without enabling an archive or a new section.
    if (initialSettings.legacyPublic && !validPlayerSlug(user.replaySharing?.slug)) {
      const repaired = await this._legacyAddress(user.userId);
      if (!repaired) return null;
      user = repaired.user; author = repaired.author;
    }
    const settings = publicPlayerSettings(user, Boolean(author));
    const profilePublic = settings.enabled || settings.legacyPublic;
    const archivePublic = settings.replaySharingEnabled;
    if (!profilePublic && !archivePublic) return null;
    const slug = settings.slug;
    if (!slug) return null;
    return { user, author, settings, profilePublic, archivePublic, slug,
      displayName: cleanDisplayName(profilePublic ? author?.displayName || user.displayName : user.displayName).slice(0, 80) || "SC2 Player" };
  }

  /** Bounded compatibility repair, never a broad backfill. Check the public
   * legacy gate before every CAS and again before returning its address.
   * @param {string} userId */
  async _legacyAddress(userId) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const user = await this.db.users.findOne({ userId }, { projection: USER_PROJECTION, maxTimeMS: 3000 });
      if (!user) return null;
      const author = await this.community.getAuthor(userId, { maxTimeMS: 3000, slimProfile: true });
      if (!publicPlayerSettings(user, Boolean(author)).legacyPublic) return null;
      if (!validPlayerSlug(user.replaySharing?.slug)) {
        try {
          await this.db.users.updateOne({ userId, _gdprMutation: { $exists: false }, publicProfile: { $exists: false }, $or: [
            { "replaySharing.slug": { $exists: false } }, { "replaySharing.slug": { $not: PLAYER_SLUG_RE } },
          ] }, { $set: { "replaySharing.slug": createPlayerSlug(author.displayName) } }, { maxTimeMS: 3000 });
        } catch (error) { if (/** @type {any} */ (error)?.code === 11000) continue; throw error; }
      }
      const [current, currentAuthor] = await Promise.all([
        this.db.users.findOne({ userId }, { projection: USER_PROJECTION, maxTimeMS: 3000 }), this.community.getAuthor(userId, { maxTimeMS: 3000, slimProfile: true }),
      ]);
      const currentSettings = publicPlayerSettings(current, Boolean(currentAuthor));
      if (!current || (!currentSettings.legacyPublic && !currentSettings.enabled)) return null;
      if (validPlayerSlug(current.replaySharing?.slug)) return { user: current, author: currentAuthor };
    }
    throw playerError(503, "player_address_unavailable", "This public player address is temporarily unavailable. Try again.");
  }

  /** Used by shared archives so every public surface has one reviewed name.
   * The user id remains internal to this service boundary.
   * @param {string} userId */
  async identity(userId) {
    const entry = await this.resolve(userId);
    return entry ? { displayName: entry.displayName, ...(entry.profilePublic ? { profileHandle: entry.slug } : {}) } : null;
  }

  /** Compatibility author endpoint, subject to the same current privacy gate.
   * @param {string} userId */
  async authorProfile(userId) {
    // Preserve the old author API's identifier contract, independently of
    // canonical player URL resolution. This path never allocates an address.
    if (typeof userId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(userId)) return null;
    const user = await this.db.users.findOne({ userId }, { projection: { _id: 0, publicProfile: 1 }, maxTimeMS: 3000 });
    if (!user || (Object.prototype.hasOwnProperty.call(user, "publicProfile") && user.publicProfile?.enabled !== true)) return null;
    return this.community.getAuthor(userId, { maxTimeMS: 3000 });
  }

  /** One batched privacy read decorates already-public named build DTOs. No
   * allocation, aggregate fan-out or identity inference for anonymous posts.
   * @param {any[]} items */
  async withAuthorLinks(items) {
    const ids = [...new Set(items.filter(row => typeof row?.authorName === "string" && row.authorName.trim() && typeof row.ownerUserId === "string").map(row => row.ownerUserId))].slice(0, 200);
    const users = ids.length ? await this.db.users.find({ userId: { $in: ids } },
      { projection: { _id: 0, userId: 1, publicProfile: 1, "replaySharing.slug": 1 }, maxTimeMS: 3000 }).limit(ids.length).toArray() : [];
    /** @type {Map<string,string>} */ const handles = new Map();
    for (const user of users) {
      const state = publicPlayerSettings(user, true);
      if (state.slug && (state.enabled || state.legacyPublic) && typeof user.userId === "string") handles.set(user.userId, state.slug);
    }
    return items.map(row => {
      const publicRow = { ...row };
      delete publicRow.authorProfileHandle;
      const handle = typeof row.authorName === "string" && row.authorName.trim() ? handles.get(row.ownerUserId) : null;
      return { ...publicRow, ...(handle ? { authorProfileHandle: handle } : {}) };
    });
  }

  /** @param {string} handle */
  async get(handle) {
    const entry = await this.resolve(handle);
    if (!entry) return null;
    if (!entry.profilePublic) return { profile: null, archiveOnly: true, handle: entry.slug, displayName: entry.displayName };
    const { user, author, settings, displayName } = entry;
    // New/removed section consent, renamed author and disabled archives all
    // change this key. Admission above is never served from this cache.
    const key = JSON.stringify([user.userId, settings.updatedAt, settings.revision, settings.replaySharingEnabled, displayName, authorRevision(author)]);
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    const value = await this._build(entry);
    if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, { expires: Date.now() + CACHE_MS, value });
    return value;
  }

  /** @param {any} entry */
  async _build(entry) {
    const { user, author, settings, slug, displayName } = entry;
    const [summary, builds, mainRace, reviewer, extras, channels, archive] = await Promise.all([
      this.aggregations.summary(user.userId, {}, { maxTimeMS: 3000 }), this.builds.list(user.userId, {}, { maxTimeMS: 3000, view: "detector" }), this.profile._mainRace(user.userId, { maxTimeMS: 3000 }),
      this.profile.reviewerReputation ? this.profile.reviewerReputation.publicSection(user.userId, { maxTimeMS: 3000 }) : null,
      extraAggregates(this.db, user.userId, settings, new Date(), this.seasons?.cachedWindows?.() || []),
      settings.showChannels ? this._channels(user.userId) : [],
      settings.showReplays && entry.archivePublic ? this.replayLibrary.list(user.userId, { limit: 1, view: "detector", withSummary: true }) : null,
    ]);
    const profile = {
      handle: slug, displayName, mainRace: mainRace || author?.primaryRace || null,
      joinedAt: safeIso(author?.joinedAt), totals: shapeTotals(summary?.totals), matchups: shapeMatchups(summary?.byMatchup),
      signatureBuilds: shapeSignatureBuilds(builds), featuredBuild: shapeFeaturedBuild(author?.topBuild),
      publishedBuildCount: Number.isSafeInteger(author?.totalBuilds) ? author.totalBuilds : 0,
      publishedBuilds: publicBuilds(author?.builds), reviewer: publicReviewer(reviewer),
      sections: Object.fromEntries(["showReplays", "showChannels", "showRecentForm", "showMmrHistory", "showSeasons", "showMaps"].map(key => [key, settings[key] === true])),
      replayArchive: archive ? { handle: slug, total: Number.isSafeInteger(archive.summary?.total) ? archive.summary.total : 0 } : null,
      ...(settings.showRecentForm ? recentForm(summary?.recent) : {}),
      ...(settings.showChannels ? { channels } : {}), ...extras,
    };
    return { profile, archiveOnly: false, handle: slug, displayName };
  }

  /** Exact-owner, reviewed submissions only. No token or provider grant reads.
   * @param {string} userId */
  async _channels(userId) {
    const rows = await this.db.playerChannels.find({ ownerUserId: userId, removed: { $ne: true }, approvedAt: { $type: "date" } },
      { projection: { _id: 0, channels: 1 }, maxTimeMS: 1000 }).limit(5).toArray();
    const result = new Map();
    for (const row of rows) for (const platform of ["twitch", "youtube"]) {
      try { const url = normalizeChannelUrl(platform, row.channels?.[platform]); if (url) result.set(`${platform}:${url}`, { platform, url }); } catch { /* malformed stored links stay private */ }
    }
    return [...result.values()].slice(0, 6);
  }
}

/** Already-public named builds only, reconstructed without owner ids/snapshots.
 * @param {unknown} raw */
function publicBuilds(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(row => typeof row?.slug === "string" && typeof row.authorName === "string" && row.authorName.trim())
    .slice(0, 50).map(row => ({ slug: row.slug.slice(0, 120), title: String(row.title || row.slug).slice(0, 160), matchup: typeof row.matchup === "string" ? row.matchup.slice(0, 8) : null, votes: Number.isFinite(row.votes) ? Math.trunc(row.votes) : 0 }));
}

/** The bounded fresh author projection fences unpublish/anonymous/title changes
 * even when the author's public-build cap stays at 100 rows.
 * @param {any} author */
function authorRevision(author) {
  const rows = Array.isArray(author?.builds) ? author.builds.slice(0, 100) : [];
  return createHash("sha256").update(JSON.stringify(rows.map((/** @type {any} */ row) => [row.slug, row.title, row.matchup, row.votes, row.authorName, safeIso(row.publishedAt), safeIso(row.updatedAt)]))).digest("hex");
}
module.exports = { PublicPlayerService, publicBuilds };
