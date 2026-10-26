"use strict";

const { PLAYER_SLUG_RE, validPlayerSlug, allowedPlayerSlug, createPlayerSlug, publicPlayerSettings, SECTION_KEYS, playerError } = require("../util/publicPlayerConfig");
const { validatePublicPlayer } = require("../validation/publicPlayer");
const { cleanDisplayName } = require("../util/contentFilter");

const OPTIONS = { maxTimeMS: 3000 };
const PROJECTION = { _id: 0, userId: 1, displayName: 1, publicProfile: 1, "replaySharing.slug": 1, "replaySharing.enabled": 1 };

/** Owner controls never enable replay sharing, publish builds, or change names. */
class PublicPlayerPreferencesService {
  /** @param {import('../db/connect').DbContext} db @param {{community:any,onPublicChanged?:()=>unknown,resolveLegacy?:(userId:string)=>Promise<unknown>}} opts */
  constructor(db, opts) { this.db = db; this.community = opts.community; this.onPublicChanged = opts.onPublicChanged || (() => {}); this.resolveLegacy = opts.resolveLegacy || null; }

  /** @param {string} userId */
  async get(userId) {
    let [user, author] = await Promise.all([this.db.users.findOne({ userId }, { ...OPTIONS, projection: PROJECTION }), this.community.getAuthor(userId, { ...OPTIONS, slimProfile: true })]);
    if (!user) throw playerError(404, "user_not_found", "Account not found.");
    const current = publicPlayerSettings(user, Boolean(author));
    if (current.legacyPublic && !current.slug) {
      if (!this.resolveLegacy) throw playerError(503, "player_address_unavailable", "Your public player address is temporarily unavailable. Try again.");
      await this.resolveLegacy(userId);
      [user, author] = await Promise.all([this.db.users.findOne({ userId }, { ...OPTIONS, projection: PROJECTION }), this.community.getAuthor(userId, { ...OPTIONS, slimProfile: true })]);
      if (!user) throw playerError(404, "user_not_found", "Account not found.");
    }
    const final = publicPlayerSettings(user, Boolean(author));
    if (final.legacyPublic && !final.slug) throw playerError(503, "player_address_unavailable", "Your public player address is temporarily unavailable. Try again.");
    return { ...final, publicDisplayName: cleanDisplayName(author?.displayName || user.displayName).slice(0, 80) || "SC2 Player" };
  }

  /** Availability is advisory; the existing unique index decides the write.
   * @param {string} userId @param {unknown} raw */
  async availability(userId, raw) {
    const slug = typeof raw === "string" ? raw.slice(0, 65) : "";
    if (!validPlayerSlug(slug)) return { slug, available: false, reason: "invalid_or_reserved" };
    const found = await this.db.users.findOne({ "replaySharing.slug": slug }, { ...OPTIONS, projection: { _id: 0, userId: 1 } });
    if (found?.userId === userId) return { slug, available: true, reason: null };
    if (!allowedPlayerSlug(slug)) return { slug, available: false, reason: "invalid_or_reserved" };
    return { slug, available: !found || found.userId === userId, reason: found && found.userId !== userId ? "unavailable" : null };
  }

  /** Full, versioned replacement of this small privacy object only.
   * @param {string} userId @param {unknown} raw */
  async set(userId, raw) {
    const input = validatePublicPlayer(raw);
    if (!input.valid) throw playerError(400, "invalid_public_profile", "Check the profile settings and try again.");
    const value = input.value;
    const [user, author] = await Promise.all([
      this.db.users.findOne({ userId }, { ...OPTIONS, projection: PROJECTION }),
      this.community.getAuthor(userId, { ...OPTIONS, slimProfile: true }),
    ]);
    if (!user) throw playerError(404, "user_not_found", "Account not found.");
    const current = publicPlayerSettings(user);
    if (value.revision !== current.revision) throw playerError(409, "public_profile_conflict", "Profile settings changed elsewhere. Refresh before saving.");
    if (!current.slug && value.slug !== null) throw playerError(400, "create_player_link_first", "Create your player link before editing its prefix.");
    const slug = value.slug || current.slug || createPlayerSlug(user.displayName);
    if (!validPlayerSlug(slug) || (slug !== current.slug && !allowedPlayerSlug(slug))) throw playerError(400, "invalid_player_slug", "Choose a valid, non-reserved player link.");
    if (current.slug && slug.slice(-11) !== current.slug.slice(-11)) throw playerError(400, "player_slug_suffix", "Only the readable prefix of a player link can change.");
    const renamed = Boolean(current.slug && current.slug !== slug);
    this._validateRename(current, renamed);
    const now = new Date();
    // Canonical slug has one authority: replaySharing.slug. This object stores
    // privacy only; old replay-sharing writers cannot leave a stale mirror.
    /** @type {Record<string,any>} */
    const next = { enabled: value.enabled, revision: current.revision + 1, updatedAt: now,
      slugChangedAt: renamed ? now : user.publicProfile?.slugChangedAt || null };
    for (const key of SECTION_KEYS) next[key] = value[key];
    const filter = { userId, _gdprMutation: { $exists: false }, $and: [
      current.revision ? { "publicProfile.revision": current.revision } : { $or: [{ "publicProfile.revision": 0 }, { "publicProfile.revision": { $exists: false } }] },
      current.slug ? { "replaySharing.slug": current.slug } : { $or: [{ "replaySharing.slug": { $exists: false } }, { "replaySharing.slug": { $not: PLAYER_SLUG_RE } }] },
      ...(renamed ? [{ "replaySharing.enabled": { $ne: true } }] : []),
    ] };
    let result;
    try { result = await this.db.users.updateOne(filter, { $set: { publicProfile: next, "replaySharing.slug": slug } }, OPTIONS); }
    catch (error) { if (/** @type {any} */ (error)?.code === 11000) throw playerError(409, "player_slug_unavailable", "That player link is unavailable."); throw error; }
    if (!result.matchedCount) throw playerError(409, "public_profile_conflict", "Profile settings changed elsewhere. Refresh before saving.");
    // The optional existing signed cache purge is best effort. API admission
    // always rereads current privacy state before serving cached aggregates.
    try { await this.onPublicChanged(); } catch { /* A failed optional purge cannot undo a committed privacy choice. */ }
    // Nothing fallible may turn a committed privacy save into a false failure.
    // Independent replay-sharing changes are rechecked by their own control.
    const saved = { ...user, publicProfile: next, replaySharing: { ...user.replaySharing, slug } };
    return { ...publicPlayerSettings(saved, false), publicDisplayName: cleanDisplayName(author?.displayName || user.displayName).slice(0, 80) || "SC2 Player" };
  }

  /** @param {any} current @param {boolean} renamed */
  _validateRename(current, renamed) {
    if (!renamed) return;
    if (current.replaySharingEnabled) throw playerError(409, "replay_link_active", "Turn off replay sharing before changing its player link.");
    if (current.renameAvailableAt && Date.parse(current.renameAvailableAt) > Date.now()) {
      throw playerError(409, "player_slug_cooldown", "The player link can be changed once every 30 days.");
    }
  }
}
module.exports = { PublicPlayerPreferencesService, PROJECTION };
