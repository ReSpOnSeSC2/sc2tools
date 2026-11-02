"use strict";
const { sanitizeGameMomentAlerts } = require("./multichatAppearance");
const { sanitizeChatCommands } = require("./chatCommands");

const crypto = require("crypto");
const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");
const { ladderRegionFromToonHandle } = require("../util/regionFromToonHandle");
const { claimUserDataLease } = require("../middleware/userDataWriteFence");
const { sanitizeAnalyzerViews } = require("../util/analyzerViews");
const { PREF_TYPE: TWITCH_PREF_TYPE, sanitizeTwitchAutomation } = require("./twitchAutomationPolicy");
const { PLAYER_SLUG_RE, PLAYER_UUID_RE, createPlayerSlug } = require("../util/publicPlayerConfig");
const { ACTIVATION_QUERY_MAX_TIME_MS, activationTimestamp, activationUnavailable } = require("./activation");
const { readyStatsFromOwnerRow, OWNER_STATS_PROJECTION } = require("./maintainedGameStatsRead");
const { ingestRejectionUpdate, ingestStatsDto } = require("./ingestRejections");
const { appendPulseId } = require("./appendPulseId");

const REPLAY_SHARE_ID_RE = /^[A-Za-z0-9_-]{32}$/;
const REPLAY_SHARE_SLUG_MAX_LENGTH = 64;
const REPLAY_SHARE_SLUG_RE = PLAYER_SLUG_RE;
const ONBOARDING_TOUR_IDS = new Set(["today", "game", "overlay"]);
const ONBOARDING_TOUR_VERSION_MAX = 1000;
const SUMMARY_PROJECTION = Object.freeze({ _id: 0, userId: 1, clerkUserId: 1, email: 1 });
const PROFILE_PROJECTION = Object.freeze({ _id: 0, battleTag: 1, battleTags: 1, pulseId: 1, pulseIds: 1,
  region: 1, preferredRace: 1, displayName: 1, lastKnownMmr: 1, lastKnownMmrAt: 1,
  lastKnownMmrRegion: 1, sessionAnchorAt: 1, sessionGapMinutes: 1, _gdprMutation: 1 });

/**
 * User service. The `users` collection maps Clerk user ids → our
 * internal user ids (stable UUIDs). Internal ids decouple our DB from
 * the auth provider, so swapping Clerk later is a one-table migration.
 */
class UsersService {
  /**
   * @param {{
   *   users: import('mongodb').Collection,
   *   games: import('mongodb').Collection,
   *   gameStatsTransactions?: boolean,
   * }} db
   * @param {{
   *   adminEvents?: {
   *     record: (type: string, payload: Record<string, unknown>) => Promise<unknown>,
   *     enrichSignupEmail?: (
   *       identity: {userId?: string, clerkUserId?: string},
   *       email: string,
   *     ) => Promise<unknown>,
   *   } | null,
   *   identityDeletions?: import('./identityDeletions').IdentityDeletionsService|null,
   * }} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.adminEvents = opts.adminEvents || null;
    this.identityDeletions = opts.identityDeletions || null;
    /** @type {import('../util/userRevision').UserRevision|null} */ this.userRevision = null;
    /** @type {((userId:string)=>void)|null} */ this.onSessionPolicyChanged = null;
    /** @type {((userId:string)=>Promise<{displayName:string,profileHandle?:string}|null>)|null} */
    this.publicPlayerIdentity = null;
  }

  /**
   * Idempotent: create the user record on first sight, return existing
   * record on subsequent calls.
   *
   * @param {string} clerkUserId
   * @returns {Promise<{userId: string, clerkUserId: string}>}
   */
  async ensureFromClerk(clerkUserId) {
    if (!clerkUserId) throw new Error("clerkUserId required");
    await this._assertIdentityActive(clerkUserId);
    const existing = await this.db.users.findOne({ clerkUserId });
    await this._assertIdentityActive(clerkUserId);
    if (existing) {
      return { userId: existing.userId, clerkUserId };
    }
    const userId = crypto.randomUUID();
    const now = new Date();
    const doc = stampVersion(
      {
        userId,
        clerkUserId,
        createdAt: now,
        lastSeenAt: now,
      },
      COLLECTIONS.USERS,
    );
    try {
      await this.db.users.insertOne(doc);
    } catch (err) {
      // Race: a concurrent request inserted first. Re-read.
      const code = /** @type {any} */ (err)?.code;
      if (code === 11000) {
        const again = await this.db.users.findOne({ clerkUserId });
        if (again) { await this._assertIdentityActive(clerkUserId); return { userId: again.userId, clerkUserId }; }
      }
      throw err;
    }
    // Await the one-time write so any email discovered later in this same
    // request can deterministically enrich the event instead of racing an
    // unobserved fire-and-forget insert.
    try { await this._assertIdentityActive(clerkUserId); }
    catch (error) { await this.db.users.deleteOne({ userId, clerkUserId }); throw error; }
    const lease = this.identityDeletions ? await claimUserDataLease(this.db.users, userId) : null;
    try { await this._recordSignup({ clerkUserId, userId, source: "first_touch" }); }
    finally { if (lease) await lease.release(); }
    return { userId, clerkUserId };
  }
  /** @param {string} clerkUserId */
  async _assertIdentityActive(clerkUserId) {
    if (this.identityDeletions && await this.identityDeletions.isDeleted(clerkUserId)) throw Object.assign(new Error("account_deleted"), { status: 401, code: "account_deleted" });
  }

  /**
   * Read the Clerk user IDs of every user carrying the DB ``admin``
   * role. The boot sequence merges these into the in-memory allowlist
   * the REST and socket gates check, so admins minted by the email
   * allowlist or an explicit grant survive restarts (their role is
   * persisted; this re-seeds the live set on the next boot).
   *
   * Read-only — admins are only ever created explicitly, via the
   * ``SC2TOOLS_ADMIN_EMAILS`` / ``SC2TOOLS_ADMIN_USER_IDS`` allowlists
   * or the admin-gated grant endpoint. There is no "first signup
   * becomes admin" heuristic.
   *
   * @returns {Promise<string[]>}
   */
  async listDbAdminClerkIds() {
    const admins = await this.db.users
      .find(
        { role: "admin" },
        { projection: { _id: 0, clerkUserId: 1 } },
      )
      .toArray();
    return admins
      .map((a) => a.clerkUserId)
      .filter((c) => typeof c === "string" && c.length > 0);
  }

  /**
   * Whether this *internal* user id carries the DB ``admin`` role.
   *
   * The REST and socket gates compare ``req.auth.clerkUserId`` against the
   * in-memory allowlist, which works because a Clerk-authenticated request
   * carries that id. Overlay tokens do not: they are created with the
   * internal UUID (``auth.userId``) and never see a Clerk session, so a
   * token-authenticated surface has no Clerk id to compare. This is the
   * lookup for that case.
   *
   * Reads the persisted role rather than the live allowlist, so it also
   * covers admins minted by the email allowlist or an explicit grant. An
   * unknown or role-less user is simply not an admin.
   *
   * @param {string} userId internal user UUID
   * @returns {Promise<boolean>}
   */
  async isAdminUserId(userId) {
    if (typeof userId !== "string" || !userId) return false;
    const hit = await this.db.users.findOne(
      { userId, role: "admin" },
      { projection: { _id: 0, userId: 1 } },
    );
    return Boolean(hit);
  }

  /**
   * Grant the ``admin`` role to another user. Combined with the email
   * allowlist, this is how admins come to exist — the endpoint that
   * calls it is itself gated on ``isAdmin``, so "only an admin can add
   * other admins" holds end to end.
   *
   * Idempotent: re-granting an existing admin is a no-op that still
   * returns their Clerk id (so the live allowlist can be re-seeded).
   * Refuses targets without a Clerk identity — an admin who can't log
   * in via Clerk would be useless — and unknown user ids.
   *
   * @param {string} targetUserId internal UUID of the user to promote
   * @param {string} grantedByClerkId Clerk id of the granting admin (audit)
   * @returns {Promise<{userId: string, clerkUserId: string}|null>}
   *   the promoted user's identity for live-allowlist propagation, or
   *   null when the target is missing / has no Clerk identity.
   */
  async grantAdmin(targetUserId, grantedByClerkId) {
    if (typeof targetUserId !== "string" || targetUserId.length === 0) {
      return null;
    }
    const target = await this.db.users.findOne(
      { userId: targetUserId },
      { projection: { _id: 0, userId: 1, clerkUserId: 1, role: 1 } },
    );
    if (!target) return null;
    if (typeof target.clerkUserId !== "string" || target.clerkUserId.length === 0) {
      return null;
    }
    if (target.role !== "admin") {
      await this.db.users.updateOne(
        { userId: targetUserId },
        {
          $set: {
            role: "admin",
            roleGrantedAt: new Date(),
            roleGrantedBy:
              typeof grantedByClerkId === "string" && grantedByClerkId
                ? grantedByClerkId
                : "admin_grant",
          },
        },
      );
      if (this.adminEvents) {
        Promise.resolve(
          this.adminEvents.record("admin_granted", {
            userId: target.userId,
            clerkUserId: target.clerkUserId,
            grantedBy: grantedByClerkId || null,
          }),
        ).catch(() => {});
      }
    }
    return { userId: target.userId, clerkUserId: target.clerkUserId };
  }

  /**
   * Bump `lastSeenAt`. Cheap, fire-and-forget; failures are non-fatal.
   *
   * @param {string} userId
   */
  async recordDownload(userId) {
    await this.db.users.updateOne({ userId }, { $min: { "activation.downloadedAt": new Date() } });
  }

  /** @param {string} userId */
  async touch(userId) {
    const now = new Date(Date.now());
    const weekAgo = new Date(now.getTime() - 7 * 86400000);
    const twoWeeksAgo = new Date(now.getTime() - 14 * 86400000);
    await this.db.users.updateOne(
      { userId, $or: [
        { $expr: { $ne: [{ $type: "$lastSeenAt" }, "date"] } },
        { lastSeenAt: { $lte: new Date(now.getTime() - 5 * 60000) } },
        // A first week-two visit must still count when lastSeenAt is recent.
        { createdAt: { $lte: weekAgo, $gt: twoWeeksAgo }, "activation.week2ReturnAt": null },
      ] },
      [{ $set: { lastSeenAt: now, "activation.week2ReturnAt": { $cond: [
        { $and: [{ $lte: ["$createdAt", weekAgo] }, { $gt: ["$createdAt", twoWeeksAgo] }] },
        { $ifNull: ["$activation.week2ReturnAt", now] }, { $ifNull: ["$activation.week2ReturnAt", "$$REMOVE"] },
      ] } } }],
    );
  }

  /**
   * Read the lightweight account summary used by /v1/me — userId,
   * clerkUserId (when known), and the cached email. We project narrowly
   * so the row doesn't drag the entire profile into memory on every page
   * load.
   *
   * @param {string} userId
   * @returns {Promise<{userId: string, clerkUserId: string|null, email: string|null}>}
   */
  async getSummary(userId) {
    const doc = await this.db.users.findOne(
      { userId },
      { projection: SUMMARY_PROJECTION },
    );
    return summaryDto(doc, userId);
  }

  /** Internal /me envelope after the qualified writer cutover.
   * One existing-owner read can replace summary+onboarding reads, never auth.
   * @param {string} userId */
  async getMeSnapshot(userId) {
    const doc = await this.db.users.findOne({ userId }, { readPreference: "primary",
      projection: { ...SUMMARY_PROJECTION, ...OWNER_STATS_PROJECTION, "preferences.onboarding": 1 } });
    return { summary: summaryDto(doc, userId),
      statsCandidate: readyStatsFromOwnerRow(doc, userId, this.db.gameStatsTransactions),
      onboarding: (doc && doc.preferences && doc.preferences.onboarding) || {} };
  }

  /** Internal Doctor envelope; the public profile getter retains its DTO.
   * Keep the original profile errors before attempting candidate validation.
   * The same read carries the ingest rejection window for Sync health.
   * @param {string} userId */
  async getDoctorSnapshot(userId) {
    const doc = await this.db.users.findOne({ userId }, { readPreference: "primary",
      projection: { ...PROFILE_PROJECTION, ...OWNER_STATS_PROJECTION, "preferences.replayArchive": 1, ingestStats: 1 } });
    return { profile: profileDto(doc),
      statsCandidate: readyStatsFromOwnerRow(doc, userId, this.db.gameStatsTransactions),
      replayArchivePrefs: (doc && doc.preferences && doc.preferences.replayArchive) || {},
      ingestStats: ingestStatsDto(doc) };
  }

  /** Best-effort ingest rejection counters (services/ingestRejections.js): one
   * pipeline update per batch, never an upsert, so a missing owner is a no-op.
   * @param {string} userId @param {Record<string, number>} counts */
  async recordIngestRejections(userId, counts) {
    const update = ingestRejectionUpdate(counts, new Date());
    if (update) await this.db.users.updateOne({ userId }, update, { upsert: false });
  }

  /**
   * Read the replay-library sharing switch without involving (or exposing)
   * the user's broader profile document. Active links use a stable player slug
   * instead of an account id. A legacy enabled row without a slug is repaired
   * on read before a link is returned.
   *
   * @param {string} userId
   * @returns {Promise<{enabled: boolean, handle: string|null}>}
   */
  async getReplaySharing(userId) {
    const doc = await this.db.users.findOne(
      { userId },
      {
        projection: {
          _id: 0,
          userId: 1,
          displayName: 1,
          "replaySharing.enabled": 1,
          "replaySharing.slug": 1,
          "replaySharing.shareId": 1,
        },
      },
    );
    if (doc?.replaySharing?.enabled !== true) {
      return { enabled: false, handle: null };
    }
    const slug = validReplayShareSlug(doc.replaySharing?.slug)
      || await this._ensureActiveReplaySharingSlug(userId);
    return { enabled: Boolean(slug), handle: slug };
  }

  /**
   * Atomically update only the replay-library sharing switch. In particular,
   * this must not call updateProfile(): that method intentionally replaces
   * profile fields and would make a privacy toggle capable of clearing them.
   *
   * @param {string} userId
   * @param {boolean} enabled
   * Enabling an already-active link is idempotent. The canonical player slug
   * is retained while disabled and across profile-name changes, so every
   * player has one stable, human-facing replay URL. A legacy opaque share id
   * is removed on disable; it remains an alias only until its owner revokes
   * the old link.
   *
   * @returns {Promise<{enabled: boolean, handle: string|null}>}
   */
  async setReplaySharing(userId, enabled) {
    if (typeof enabled !== "boolean") {
      const err = /** @type {Error & {status: number, code: string}} */ (
        new Error("enabled_must_be_boolean")
      );
      err.status = 400;
      err.code = "invalid_replay_sharing";
      throw err;
    }
    if (!enabled) {
      const result = await this.db.users.updateOne(
        { userId },
        {
          $set: {
            "replaySharing.enabled": false,
            "replaySharing.updatedAt": new Date(),
          },
          $unset: { "replaySharing.shareId": "" },
        },
      );
      if (result.matchedCount === 0) throw replaySharingUserNotFound();
      return { enabled: false, handle: null };
    }

    // A duplicate suffix is cryptographically improbable, but the unique
    // index is authoritative. Retry both that case and a concurrent first
    // enable; the winner's canonical slug is returned on the next read.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await this.db.users.findOne(
        { userId },
        {
          projection: {
            _id: 0,
            userId: 1,
            displayName: 1,
            "replaySharing.enabled": 1,
            "replaySharing.slug": 1,
            "replaySharing.shareId": 1,
          },
        },
      );
      if (!current) throw replaySharingUserNotFound();
      const currentSlug = validReplayShareSlug(current.replaySharing?.slug);
      if (currentSlug) {
        if (current.replaySharing?.enabled !== true) {
          const result = await this.db.users.updateOne(
            { userId, "replaySharing.slug": currentSlug },
            {
              $set: {
                "replaySharing.enabled": true,
                "replaySharing.updatedAt": new Date(),
              },
            },
          );
          if (result.matchedCount === 0) continue;
        }
        return { enabled: true, handle: currentSlug };
      }

      const slug = createReplayShareSlug(current.displayName);
      try {
        const result = await this.db.users.updateOne(
          {
            userId,
            $or: [
              { "replaySharing.slug": { $exists: false } },
              { "replaySharing.slug": { $not: REPLAY_SHARE_SLUG_RE } },
            ],
          },
          {
            $set: {
              "replaySharing.enabled": true,
              "replaySharing.slug": slug,
              "replaySharing.updatedAt": new Date(),
            },
          },
        );
        if (result.matchedCount > 0) return { enabled: true, handle: slug };
      } catch (err) {
        if (/** @type {any} */ (err)?.code !== 11000) throw err;
      }
    }
    const err = /** @type {Error & {status: number, code: string}} */ (
      new Error("replay_sharing_conflict")
    );
    err.status = 503;
    err.code = "replay_sharing_conflict";
    throw err;
  }

  /**
   * Resolve an explicitly shared replay library. Malformed, unknown, and
   * private handles all return null so the public route can answer with the
   * same neutral 404 and never disclose whether a private account exists.
   *
   * @param {string} handle
   * @returns {Promise<{userId: string, profile: {handle: string, displayName: string}} | null>}
   */
  async resolveReplaySharing(handle) {
    const slug = validReplayShareSlug(handle);
    const legacyShareId = validReplayShareId(handle);
    const legacyPlayerId = typeof handle === "string" && PLAYER_UUID_RE.test(handle) ? handle : null;
    if (!slug && !legacyShareId && !legacyPlayerId) return null;
    const projection = {
      _id: 0,
      userId: 1,
      displayName: 1,
      "replaySharing.slug": 1,
    };
    // A 32-character legacy id can theoretically also satisfy the slug
    // grammar. Canonical slugs take precedence, then the legacy alias is
    // attempted only on a miss so one string cannot resolve ambiguously.
    let doc = slug
      ? await this.db.users.findOne(
        { "replaySharing.slug": slug, "replaySharing.enabled": true },
        { projection },
      )
      : null;
    if (!doc && legacyShareId) {
      doc = await this.db.users.findOne(
        {
          "replaySharing.shareId": legacyShareId,
          "replaySharing.enabled": true,
        },
        { projection },
      );
    }
    // Compatibility for already-shared /p/<uuid>/replays links. A UUID is
    // never publication consent: this exact lookup still requires an active
    // archive and returns its canonical slug, without an owner-id payload.
    if (!doc && legacyPlayerId) {
      doc = await this.db.users.findOne({ userId: legacyPlayerId, "replaySharing.enabled": true }, { projection });
    }
    if (!doc || typeof doc.userId !== "string") return null;
    const canonicalSlug = validReplayShareSlug(doc.replaySharing?.slug)
      || await this._ensureActiveReplaySharingSlug(doc.userId);
    if (!canonicalSlug) return null;
    const publicName = typeof doc.displayName === "string"
      ? doc.displayName
        .normalize("NFKC")
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .trim()
        .slice(0, 80)
      : "";
    const displayName = publicName || "SC2 Player";
    const publicIdentity = this.publicPlayerIdentity ? await this.publicPlayerIdentity(doc.userId) : null;
    return {
      userId: doc.userId,
      profile: { handle: canonicalSlug, displayName: publicIdentity?.displayName || displayName,
        ...(publicIdentity?.profileHandle ? { profileHandle: publicIdentity.profileHandle } : {}) },
    };
  }

  /**
   * Lazily migrate an enabled legacy share to a canonical player slug. The
   * update predicate includes ``enabled: true`` so a concurrent disable wins
   * and this read path can never resurrect a revoked library.
   *
   * @param {string} userId
   * @returns {Promise<string|null>}
   */
  async _ensureActiveReplaySharingSlug(userId) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await this.db.users.findOne(
        { userId, "replaySharing.enabled": true },
        {
          projection: {
            _id: 0,
            userId: 1,
            displayName: 1,
            "replaySharing.slug": 1,
          },
        },
      );
      if (!current) return null;
      const currentSlug = validReplayShareSlug(current.replaySharing?.slug);
      if (currentSlug) return currentSlug;

      const nextSlug = createReplayShareSlug(current.displayName);
      try {
        const result = await this.db.users.updateOne(
          {
            userId,
            "replaySharing.enabled": true,
            $or: [
              { "replaySharing.slug": { $exists: false } },
              { "replaySharing.slug": { $not: REPLAY_SHARE_SLUG_RE } },
            ],
          },
          {
            $set: {
              "replaySharing.slug": nextSlug,
              "replaySharing.updatedAt": new Date(),
            },
          },
        );
        if (result.matchedCount > 0) return nextSlug;
      } catch (err) {
        if (/** @type {any} */ (err)?.code !== 11000) throw err;
      }
    }
    return null;
  }

  /**
   * Cache an email on the user record. Idempotent — only writes when the
   * value actually changes, so we don't churn `_schemaVersion` or
   * `lastSeenAt` on no-op refreshes.
   *
   * @param {string} userId
   * @param {string} email
   */
  async setEmail(userId, email) {
    if (typeof email !== "string" || email.length === 0) return;
    await this.db.users.updateOne(
      { userId, email: { $ne: email } },
      { $set: { email, emailUpdatedAt: new Date() } },
    );
    // The first authenticated request creates its signup event before /me
    // performs the best-effort Clerk lookup. Converge that existing event
    // now; this helper is update-only and cannot turn an old user into a
    // fresh signup notification.
    await this._enrichSignupEmail({ userId }, email);
  }

  /**
   * Webhook entrypoint: upsert email by Clerk user id. The user row may
   * not exist yet if the webhook lands before the user's first API call,
   * so we insert a stub on miss using the same shape `ensureFromClerk`
   * produces. Returns true when an email was written or a stub created.
   *
   * @param {string} clerkUserId
   * @param {string|null} email
   * @param {{ eventType?: "user.created"|"user.updated" }} [opts]
   * @returns {Promise<boolean>}
   */
  async upsertFromWebhook(clerkUserId, email, opts = {}) {
    if (!clerkUserId) return false;
    await this._assertIdentityActive(clerkUserId);
    const now = new Date();
    /** @type {Record<string, unknown>} */
    const set = { lastSeenAt: now };
    if (typeof email === "string" && email.length > 0) {
      set.email = email;
      set.emailUpdatedAt = now;
    }
    /** @type {Record<string, unknown>} */
    const setOnInsert = {
      userId: crypto.randomUUID(),
      clerkUserId,
      createdAt: now,
    };
    stampVersion(setOnInsert, COLLECTIONS.USERS);
    const res = await this.db.users.updateOne(
      { clerkUserId },
      { $set: set, $setOnInsert: setOnInsert },
      { upsert: true },
    );
    try { await this._assertIdentityActive(clerkUserId); }
    catch (error) {
      if (res.upsertedCount) await this.db.users.deleteOne({ userId: setOnInsert.userId, clerkUserId });
      throw error;
    }
    const current = await this.db.users.findOne({ clerkUserId }, { projection: { userId: 1 } });
    const lease = this.identityDeletions && current ? await claimUserDataLease(this.db.users, current.userId) : null;
    try {
    if (opts.eventType !== "user.updated") {
      // user.created is authoritative signup input even if first-touch won
      // the users-row race. record() dedupes by Clerk id and fill-only
      // enriches the existing event with this email.
      const persisted = res.upsertedCount > 0
        ? setOnInsert
        : await this.db.users.findOne(
            { clerkUserId },
            { projection: { _id: 0, userId: 1 } },
          );
      await this._recordSignup({
        clerkUserId,
        userId: persisted && persisted.userId
          ? String(persisted.userId)
          : null,
        email: typeof set.email === "string" ? set.email : null,
        source: "clerk_webhook",
      });
    } else if (typeof set.email === "string") {
      // A user.updated delivery may supply the email that an earlier
      // first-touch event lacked, but must never create a new signup event
      // for a pre-existing account.
      await this._enrichSignupEmail({ clerkUserId }, set.email);
    }
    return res.modifiedCount > 0 || res.upsertedCount > 0;
    } finally { if (lease) await lease.release(); }
  }

  /**
   * Best-effort signup event. Callers await the attempt so later email
   * enrichment cannot overtake the initial insert. It remains idempotent at
   * the storage layer (unique partial index on ``payload.clerkUserId``), so
   * the webhook → first-touch race naturally collapses to a single row.
   *
   * @param {{
   *   clerkUserId: string,
   *   userId?: string | null,
   *   email?: string | null,
   *   source?: string,
   * }} payload
   */
  async _recordSignup(payload) {
    if (!this.adminEvents || !payload || !payload.clerkUserId) return null;
    try {
      return await this.adminEvents.record("user_signup", payload);
    } catch {
      // Notification storage must never block account creation/auth. The
      // concrete service logs its own Mongo failures; the catch also keeps
      // narrow test doubles and future implementations best-effort.
      return null;
    }
  }

  /**
   * Update-only email convergence for an already-recorded signup.
   *
   * @param {{ userId?: string, clerkUserId?: string }} identity
   * @param {string} email
   */
  async _enrichSignupEmail(identity, email) {
    if (
      !this.adminEvents ||
      typeof this.adminEvents.enrichSignupEmail !== "function"
    ) {
      return null;
    }
    try {
      return await this.adminEvents.enrichSignupEmail(identity, email);
    } catch {
      return null;
    }
  }

  /**
   * Read the public-facing profile fields. Returns an empty object
   * when no fields have been set, never null, so callers can spread
   * the result without a null check.
   *
   * ``pulseIds`` is the canonical list. ``pulseId`` is mirrored from
   * ``pulseIds[0]`` (or the legacy single-string field on docs that
   * pre-date the migration) so existing read-paths — the session
   * widget's MMR fallback, the agent's player-handle resolver — keep
   * working without a separate backfill.
   *
   * @param {string} userId
   * @returns {Promise<{
   *   battleTag?: string,
   *   battleTags?: string[],
   *   pulseId?: string,
   *   pulseIds?: string[],
   *   region?: string,
   *   preferredRace?: string,
   *   displayName?: string,
   *   lastKnownMmr?: number,
   *   lastKnownMmrAt?: string,
   *   lastKnownMmrRegion?: string,
   *   sessionAnchorAt?: string,
   *   sessionGapMinutes?: number|null,
   * }>}
   */
  async getProfile(userId) {
    const doc = await this.db.users.findOne(
      { userId },
      { projection: PROFILE_PROJECTION },
    );
    return profileDto(doc);
  }

  /**
   * Persist SC2Pulse-detected BattleTags onto the user record.
   *
   * Semantics:
   *   - ``battleTags`` (array) is replaced with the merged, deduped
   *     list — a manually-typed ``battleTag`` (if any) is preserved as
   *     the first entry so it's never lost to a detection pass.
   *   - ``battleTag`` (singular) is only WRITTEN when currently unset:
   *     detection must never clobber what the user typed into Settings.
   *     When unset, it becomes the first detected tag — that's the
   *     auto-fill the Settings UI and the agent's handle resolver see.
   *
   * Idempotent: skips the Mongo write when nothing would change, so
   * the detect endpoint can be called liberally.
   *
   * @param {string} userId
   * @param {string[]} tags detected BattleTags, e.g. ["ReSpOnSe#1872"]
   * @returns {Promise<ReturnType<UsersService['getProfile']> extends Promise<infer T> ? T : never>}
   */
  async setBattleTags(userId, tags) {
    const detected = normaliseBattleTagList(tags);
    if (detected.length === 0) return this.getProfile(userId);
    const doc = await this.db.users.findOne(
      { userId },
      { projection: { _id: 0, battleTag: 1, battleTags: 1 } },
    );
    if (!doc) return this.getProfile(userId);
    const manual =
      typeof doc.battleTag === "string" && doc.battleTag.trim().length > 0
        ? doc.battleTag.trim()
        : null;
    const merged = normaliseBattleTagList(
      manual ? [manual, ...detected] : detected,
    );
    const current = normaliseBattleTagList(doc.battleTags);
    const sameList =
      current.length === merged.length &&
      current.every((v, i) => v === merged[i]);
    if (sameList && manual) return this.getProfile(userId);
    /** @type {Record<string, any>} */
    const set = { battleTags: merged };
    if (!manual) set.battleTag = merged[0];
    stampVersion(set, COLLECTIONS.USERS);
    await this.db.users.updateOne({ userId }, { $set: set });
    return this.getProfile(userId);
  }

  /**
   * Append a single pulse identifier (toon handle or numeric SC2Pulse
   * character id) to the user's ``pulseIds`` array, dedup-aware. Used
   * by the games ingest path to auto-populate the array as the agent
   * forwards each replay's ``myToonHandle`` — streamers shouldn't have
   * to paste their own toon handle into Settings for the session
   * widget's SC2Pulse fallback to resolve their MMR.
   *
   * Idempotent: a no-op when the id is already present.
   * Skips clobbering the user's typed-in single-string ``pulseId`` —
   * if the array doesn't exist yet but the legacy field does, the
   * legacy value is preserved as the first entry of the new array.
   *
   * @param {string} userId
   * @param {string} pulseId
   * @returns {Promise<boolean>} true when the array changed.
   */
  async addPulseId(userId, pulseId) {
    return (await appendPulseId(this.db.users, userId, pulseId)).code === "added";
  }

  /**
   * Read per-user preferences for a given type key (e.g. "misc", "voice").
   * Returns {} when not yet set.
   *
   * @param {string} userId
   * @param {string} type
   * @returns {Promise<Record<string, unknown>>}
   */
  async getPreferences(userId, type) {
    const doc = await this.db.users.findOne(
      { userId },
      { projection: { _id: 0, [`preferences.${type}`]: 1 } },
    );
    const prefs = (doc && doc.preferences && doc.preferences[type]) || {};
    return type === "analyzerViews" ? sanitizeAnalyzerViews(prefs) : type === TWITCH_PREF_TYPE ? sanitizeTwitchAutomation(prefs)
      : type === "chatCommands" ? sanitizeChatCommands(prefs) : prefs;
  }

  /** One indexed preferences read replaces AppHome's existing misc lookup.
   * Only the selected safe view and the legacy scalar leave the service.
   * @param {string} userId */
  async getAnalyzerDefaultView(userId) {
    const doc = await this.db.users.findOne({ userId }, {
      projection: { _id: 0, "preferences.misc": 1, "preferences.analyzerViews": 1 },
    });
    const prefs = sanitizeAnalyzerViews(doc?.preferences?.analyzerViews);
    const legacy = doc?.preferences?.misc?.defaultTab;
    const defaultTab = typeof legacy === "string" && legacy.length <= 64 && !/[\u0000-\u001f\u007f]/.test(legacy) ? legacy : null;
    return { defaultView: prefs.views.find((view) => view.id === prefs.defaultViewId) || null, defaultTab };
  }

  /** Record a successfully opened owned replay without replacing onboarding.
   * The route's ordinary erasure lease covers both commands. The conditional
   * pipeline also protects direct callers and concurrent browser attempts.
   * @param {string} userId @param {string} gameId */
  async markFirstGameViewed(userId, gameId) {
    const game = await this.db.games.findOne({ userId, gameId, _deleted: { $ne: true },
      _deletionPending: { $ne: true }, isResumedFromReplay: { $ne: true } }, {
      projection: { _id: 1 }, maxTimeMS: ACTIVATION_QUERY_MAX_TIME_MS,
    });
    if (!game) throw Object.assign(new Error("game_not_found"), { status: 404, code: "game_not_found" });
    const firstGameViewedAt = "preferences.onboarding.firstGameViewedAt";
    const updated = await this.db.users.findOneAndUpdate({ userId, _gdprMutation: { $exists: false } }, [{ $set: {
      [firstGameViewedAt]: { $cond: [
        { $eq: [{ $ifNull: [`$${firstGameViewedAt}`, null] }, null] },
        { $literal: new Date().toISOString() }, `$${firstGameViewedAt}`,
      ] },
    } }], { upsert: false, returnDocument: "after", projection: { _id: 0, [firstGameViewedAt]: 1 },
      maxTimeMS: ACTIVATION_QUERY_MAX_TIME_MS });
    if (!updated || !activationTimestamp(updated.preferences?.onboarding?.firstGameViewedAt)) throw activationUnavailable();
    return { firstGameViewed: true };
  }

  /**
   * Merge-replace the preferences sub-document for a given type key.
   * The sub-object is replaced atomically, except onboarding: independent
   * checklist and goals updates merge fields so callers can send a patch.
   *
   * @param {string} userId
   * @param {string} type
   * @param {Record<string, unknown>} prefs
   * @returns {Promise<Record<string, unknown>>}
   */
  async updatePreferences(userId, type, prefs) {
    if (type === "analyzerViews") prefs = sanitizeAnalyzerViews(prefs, true);
    if (type === TWITCH_PREF_TYPE) prefs = sanitizeTwitchAutomation(prefs, true);
    if (type === "multichat" && prefs.alerts && typeof prefs.alerts === "object") {
      const alerts = /** @type {Record<string,unknown>} */ (prefs.alerts);
      if (alerts.gameMoments !== undefined) prefs = { ...prefs, alerts: { ...alerts, gameMoments: sanitizeGameMomentAlerts(alerts.gameMoments, true) } };
    }
    if (type === "chatCommands") prefs = sanitizeChatCommands(prefs, true);
    if (type === "onboarding") {
      const ordinary = { ...prefs };
      const versions = Object.hasOwn(prefs, "toursDone") ? validateOnboardingToursDone(prefs.toursDone) : {};
      delete ordinary.toursDone;
      // Literal ordinary patches and nested versions share one atomic write.
      // An empty tour patch preserves the stored map, including absence.
      /** @type {import('mongodb').Document[]} */
      const fragments = [{ $cond: [{ $eq: [{ $type: "$preferences.onboarding" }, "object"] },
        "$preferences.onboarding", {}] }, { $literal: ordinary }];
      if (Object.keys(versions).length) fragments.push({ toursDone: mergeOnboardingTourVersions(versions) });
      const updated = await this.db.users.findOneAndUpdate({ userId, _gdprMutation: { $exists: false } }, [{ $set: {
        "preferences.onboarding": { $mergeObjects: fragments },
      } }], { upsert: false, returnDocument: "after", projection: { _id: 0, "preferences.onboarding": 1 },
        maxTimeMS: ACTIVATION_QUERY_MAX_TIME_MS });
      if (!updated) throw Object.assign(new Error("gdpr_operation_busy"), { status: 409, code: "gdpr_operation_busy" });
      return updated.preferences.onboarding;
    }
    await this.db.users.updateOne(
      { userId },
      { $set: { [`preferences.${type}`]: prefs } },
    );
    return prefs;
  }

  /**
   * Replace the profile block on the user record. Empty/missing
   * fields are unset on disk so the document doesn't accumulate
   * stale entries. The profile is the only writable surface — we
   * never let the client touch userId/clerkUserId/createdAt.
   *
   * The agent has its own narrower entry point for sticky-MMR pings
   * (``patchLastKnownMmr``) — it never sends the user-editable fields
   * (battleTag/pulseId/region/preferredRace/displayName), so the agent
   * can't accidentally clear what the streamer typed into Settings.
   *
   * @param {string} userId
   * @param {{
   *   battleTag?: string|null,
   *   pulseId?: string|null,
   *   region?: string|null,
   *   preferredRace?: string|null,
   *   displayName?: string|null,
   *   lastKnownMmr?: number|null,
   *   lastKnownMmrAt?: string|null,
   *   lastKnownMmrRegion?: string|null,
   *   sessionGapMinutes?: number|null,
   * }} profile
   */
  async updateProfile(userId, profile) {
    const policyWrite = !!profile && Object.prototype.hasOwnProperty.call(profile, "sessionGapMinutes");
    if (policyWrite && profile.sessionGapMinutes !== null && !(typeof profile.sessionGapMinutes === "number" && Number.isInteger(profile.sessionGapMinutes) && profile.sessionGapMinutes >= 15 && profile.sessionGapMinutes <= 480)) {
      throw Object.assign(new Error("session_gap_invalid"), { status: 400, code: "session_gap_invalid" });
    }
    const STRING_FIELDS = [
      "battleTag",
      "region",
      "preferredRace",
      "displayName",
      "lastKnownMmrAt",
      "lastKnownMmrRegion",
    ];
    /** @type {Record<string, any>} */
    const set = {};
    /** @type {Record<string, "">} */
    const unset = {};
    // This new preference alone has patch semantics: an omitted legacy PUT
    // preserves it; null persists Auto. Other Profile fields retain their rules.
    if (policyWrite) set.sessionGapMinutes = profile.sessionGapMinutes;
    for (const k of STRING_FIELDS) {
      const raw = profile ? profile[/** @type {keyof typeof profile} */ (k)] : undefined;
      if (typeof raw === "string" && raw.trim().length > 0) {
        set[k] = raw.trim();
      } else {
        unset[k] = "";
      }
    }
    applyPulseIdsUpdate(profile, set, unset);
    // ``lastKnownMmr`` is numeric. Treat null/missing as "clear", a
    // valid integer in the [500, 9999] band as "set". Out-of-band
    // values are dropped on the floor (never set, never unset) so a
    // malformed agent ping can't clear a previously-good value.
    if (profile && Object.prototype.hasOwnProperty.call(profile, "lastKnownMmr")) {
      const raw = profile.lastKnownMmr;
      if (raw === null) {
        unset.lastKnownMmr = "";
      } else if (
        typeof raw === "number" &&
        Number.isInteger(raw) &&
        raw >= 500 &&
        raw <= 9999
      ) {
        set.lastKnownMmr = raw;
      }
    } else {
      unset.lastKnownMmr = "";
    }
    set.profileUpdatedAt = /** @type {any} */ (new Date());
    // Re-stamp the schema version on every write so a future bump of
    // USERS' currentVersion rolls existing docs forward as they're
    // touched, without a separate backfill.
    stampVersion(set, COLLECTIONS.USERS);
    /** @type {Record<string, any>} */
    const update = { $set: set };
    if (Object.keys(unset).length > 0) update.$unset = unset;
    if (policyWrite) this.onSessionPolicyChanged?.(userId);
    try {
      const write = async () => {
        const result = await this.db.users.updateOne(
          policyWrite ? { userId, _gdprMutation: { $exists: false } } : { userId }, update, { upsert: false },
        );
        if (policyWrite && result.matchedCount !== 1) throw Object.assign(new Error("session_policy_owner_unavailable"), { status: 409, code: "session_policy_owner_unavailable" });
      };
      if (policyWrite && this.userRevision) await this.userRevision.run(userId, write);
      else await write();
      return await this.getProfile(userId);
    } finally { if (policyWrite) this.onSessionPolicyChanged?.(userId); }
  }

  /**
   * Narrow agent-only entry for the sticky-MMR ping. Patches just the
   * three ``lastKnownMmr*`` fields without touching the user-editable
   * profile (battleTag/pulseId/region/...) — the agent must never be
   * able to clobber what the streamer typed into Settings.
   *
   * Idempotent on a no-op: if ``mmr`` matches the stored value we
   * skip the write entirely (saves a Mongo round-trip per replay
   * during a 13k-replay backfill).
   *
   * @param {string} userId
   * @param {{
   *   mmr: number,
   *   capturedAt?: string,
   *   region?: string,
   *   gameId?: string,
   * }} update
   * @returns {Promise<boolean>} true when the document was actually written.
   */
  async patchLastKnownMmr(userId, update) {
    if (!update || typeof update !== "object") return false;
    const mmr = Number(update.mmr);
    if (!Number.isInteger(mmr) || mmr < 500 || mmr > 9999) return false;
    /** @type {Record<string, any>} */
    const set = { lastKnownMmr: mmr };
    const captured =
      typeof update.capturedAt === "string"
        ? new Date(update.capturedAt)
        : null;
    const hasExplicitCapturedAt =
      captured !== null && !Number.isNaN(captured.getTime());
    if (typeof update.capturedAt === "string" && !hasExplicitCapturedAt) {
      return false;
    }
    const gameId = typeof update.gameId === "string"
      ? update.gameId.trim().slice(0, 200)
      : "";
    let sourceDate = hasExplicitCapturedAt ? captured : null;
    if (gameId) {
      const source = await this.db.games.findOne(
        { userId, gameId },
        {
          projection: {
            _id: 0,
            date: 1,
            isResumedFromReplay: 1,
          },
        },
      );
      if (!source || source.isResumedFromReplay === true) return false;
      const storedGameDate = source.date instanceof Date
        ? source.date
        : new Date(source.date);
      if (Number.isNaN(storedGameDate.getTime())) return false;
      if (
        sourceDate
        && sourceDate.toISOString() !== storedGameDate.toISOString()
      ) {
        return false;
      }
      sourceDate = storedGameDate;
    }
    set.lastKnownMmrAt = sourceDate
      ? sourceDate.toISOString()
      : new Date().toISOString();
    if (typeof update.region === "string" && update.region) {
      set.lastKnownMmrRegion = update.region.slice(0, 8);
    }
    // Backwards-compatible protection for agents that do not yet send a
    // gameId. Their replay timestamp is still enough to reject a sticky-MMR
    // ping sourced from a quarantined Resume-from-Replay row.
    const sourceInstant = new Date(set.lastKnownMmrAt);
    // New agents identify the exact replay that supplied the rating. Keep
    // that check game-id scoped: two games can legitimately share a replay
    // timestamp. Date matching is only the conservative compatibility path
    // for old agents that have not learned to send gameId yet.
    const resumedSourceFilter = gameId
      ? { userId, gameId, isResumedFromReplay: true }
      : {
          userId,
          isResumedFromReplay: true,
          $or: [
            { date: sourceInstant },
            { date: set.lastKnownMmrAt },
          ],
        };
    if (
      (sourceDate || gameId)
      && await this.db.games.findOne(
        resumedSourceFilter,
        { projection: { _id: 1 } },
      )
    ) {
      return false;
    }
    // Skip the write if nothing changed — most replays in a backfill
    // produce the same MMR as the prior one, so the unconditional
    // updateOne would generate ~13k pointless writes during a
    // re-sync.
    const existing = await this.db.users.findOne(
      { userId },
      {
        projection: {
          _id: 0,
          lastKnownMmr: 1,
          lastKnownMmrAt: 1,
          lastKnownMmrRegion: 1,
        },
      },
    );
    const existingCapturedAt =
      existing && typeof existing.lastKnownMmrAt === "string"
        ? existing.lastKnownMmrAt
        : null;
    // A backfill must never overwrite a rating captured by a newer
    // replay. This pre-check saves the write in the common sequential
    // case; the update filter below enforces the same ordering atomically
    // when two agent upload workers race.
    if (
      existingCapturedAt &&
      existingCapturedAt > set.lastKnownMmrAt
    ) {
      return false;
    }
    if (
      existing &&
      existing.lastKnownMmr === mmr &&
      existing.lastKnownMmrRegion === set.lastKnownMmrRegion &&
      (
        !hasExplicitCapturedAt ||
        existingCapturedAt === set.lastKnownMmrAt
      )
    ) {
      return false;
    }
    stampVersion(set, COLLECTIONS.USERS);
    const wrote = await this.db.users.updateOne(
      {
        userId,
        $or: [
          { lastKnownMmrAt: { $exists: false } },
          { lastKnownMmrAt: { $lt: set.lastKnownMmrAt } },
        ],
      },
      { $set: set },
    );
    const changed = wrote.modifiedCount > 0;
    // Close the cross-collection race where quarantine lands after the
    // source-game check but before the profile CAS. If that happened, make
    // the cleanup durable again and run the same idempotent repair now. A
    // failure propagates, leaving the pending bit for the agent's retry.
    if (sourceDate || gameId) {
      const becameResumed = await this.db.games.find(
        resumedSourceFilter,
        { projection: { _id: 1 } },
      ).toArray();
      if (becameResumed.length > 0) {
        await this.db.games.updateMany(
          { _id: { $in: becameResumed.map((row) => row._id) }, userId },
          {
            $set: {
              resumedReplayMmrRepairPending: true,
              resumedReplayMmrRepairToken: crypto.randomUUID(),
            },
            $unset: { resumedReplayMmrRepairedAt: "" },
          },
        );
        await this.repairLastKnownMmrAfterResumedReplay(userId);
        return false;
      }
    }
    return changed;
  }

  /**
   * Consume durable sticky-MMR repair work left by replay quarantine.
   *
   * The game rows, not the request, are the repair journal. The profile CAS
   * prevents cleanup from rolling back a concurrently uploaded real game;
   * pending rows are cleared only after that CAS (or after proving no profile
   * change is needed). A failure at any earlier point leaves them retryable.
   *
   * @param {string} userId
   * @returns {Promise<boolean>} true when the sticky fields changed
   */
  async repairLastKnownMmrAfterResumedReplay(userId) {
    const pending = await this.db.games
      .find(
        {
          userId,
          isResumedFromReplay: true,
          resumedReplayMmrRepairPending: true,
        },
        {
          projection: {
            _id: 1,
            date: 1,
            resumedReplayMmrRepairToken: 1,
          },
        },
      )
      .toArray();
    if (pending.length === 0) return false;

    const badDates = new Set(
      pending
        .map((row) => row && row.date)
        .map((value) => {
          const parsed = new Date(value);
          return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
        })
        .filter((value) => typeof value === "string"),
    );
    const profile = await this.db.users.findOne(
      { userId },
      {
        projection: {
          _id: 0,
          lastKnownMmrAt: 1,
        },
      },
    );
    const storedRaw = profile && profile.lastKnownMmrAt;
    const storedDate = typeof storedRaw === "string"
      ? new Date(storedRaw)
      : null;
    const stickyNeedsRepair = Boolean(
      storedDate
      && !Number.isNaN(storedDate.getTime())
      && badDates.has(storedDate.toISOString()),
    );
    let changed = false;
    if (stickyNeedsRepair) {
      const latest = await this.db.games.findOne(
        {
          userId,
          isResumedFromReplay: { $ne: true },
          date: { $type: "date" },
          myMmr: { $type: "number", $gte: 500, $lte: 9999 },
        },
        {
          projection: {
            _id: 0,
            date: 1,
            myMmr: 1,
            myToonHandle: 1,
          },
          sort: { date: -1 },
        },
      );
      const guard = { userId, lastKnownMmrAt: storedRaw };
      if (!latest) {
        const cleared = await this.db.users.updateOne(guard, {
          $unset: {
            lastKnownMmr: "",
            lastKnownMmrAt: "",
            lastKnownMmrRegion: "",
          },
        });
        changed = cleared.modifiedCount > 0;
      } else {
        const latestAt = latest.date instanceof Date
          ? latest.date
          : new Date(latest.date);
        const mmr = Math.round(Number(latest.myMmr));
        if (
          Number.isNaN(latestAt.getTime())
          || !Number.isInteger(mmr)
          || mmr < 500
          || mmr > 9999
        ) {
          throw new Error("invalid competitive MMR replacement");
        }
        /** @type {Record<string, any>} */
        const replacement = {
          lastKnownMmr: mmr,
          lastKnownMmrAt: latestAt.toISOString(),
        };
        // Ladder regions only, like the agent's own sticky-MMR ping: the
        // session widget reads this as the ladder of the sticky MMR, and
        // PTR (``98-``) has none.
        const region = ladderRegionFromToonHandle(latest.myToonHandle);
        if (region) replacement.lastKnownMmrRegion = region;
        stampVersion(replacement, COLLECTIONS.USERS);
        /** @type {Record<string, any>} */
        const update = { $set: replacement };
        if (!region) update.$unset = { lastKnownMmrRegion: "" };
        const repaired = await this.db.users.updateOne(guard, update);
        changed = repaired.modifiedCount > 0;
      }
    }

    // No profile, malformed/nonmatching sticky timestamp, and a lost CAS all
    // mean no further repair is necessary. They are successful no-ops, so
    // consume exactly the rows captured at the start; newer work stays pending.
    const repairedAt = new Date();
    await this.db.games.bulkWrite(
      pending.map((row) => ({
        updateOne: {
          filter: {
            _id: row._id,
            userId,
            resumedReplayMmrRepairPending: true,
            resumedReplayMmrRepairToken:
              typeof row.resumedReplayMmrRepairToken === "string"
                ? row.resumedReplayMmrRepairToken
                : { $exists: false },
          },
          update: {
            $set: {
              resumedReplayMmrRepairPending: false,
              resumedReplayMmrRepairedAt: repairedAt,
            },
            $unset: { resumedReplayMmrRepairToken: "" },
          },
        },
      })),
    );
    return changed;
  }
}

/**
 * Resolve the next ``pulseIds`` array from a partial profile update,
 * folding the legacy single-string ``pulseId`` field in when ``pulseIds``
 * was not supplied. Mutates the caller's ``set``/``unset`` accumulators
 * in place; mirrors the first id into the legacy ``pulseId`` field so
 * unmigrated read-paths keep resolving.
 *
 * @param {Record<string, unknown> | null | undefined} profile
 * @param {Record<string, any>} set
 * @param {Record<string, "">} unset
 */
function applyPulseIdsUpdate(profile, set, unset) {
  /** @type {string[]|null} */
  let nextPulseIds = null;
  if (profile && Object.prototype.hasOwnProperty.call(profile, "pulseIds")) {
    const raw = profile.pulseIds;
    if (Array.isArray(raw)) nextPulseIds = normalisePulseIdList(raw);
    else if (raw === null) nextPulseIds = [];
  } else if (profile && Object.prototype.hasOwnProperty.call(profile, "pulseId")) {
    const raw = profile.pulseId;
    nextPulseIds =
      typeof raw === "string" && raw.trim() ? [raw.trim()] : [];
  }
  if (nextPulseIds === null) return;
  if (nextPulseIds.length === 0) {
    unset.pulseIds = "";
    unset.pulseId = "";
  } else {
    set.pulseIds = nextPulseIds;
    set.pulseId = nextPulseIds[0];
  }
}

/** Existing public summary mapping, also used by the unwired envelope.
 * @param {any} doc @param {string} userId */
function summaryDto(doc, userId) {
  if (!doc) return { userId, clerkUserId: null, email: null };
  return { userId: doc.userId,
    clerkUserId: typeof doc.clerkUserId === "string" ? doc.clerkUserId : null,
    email: typeof doc.email === "string" && doc.email.length > 0 ? doc.email : null };
}

/** Presence distinguishes known-owner Auto from a missing profile.
 * @param {any} gap @returns {number|null} */
function profileGap(gap) {
  if (gap !== null && gap !== undefined && !(typeof gap === "number" && Number.isInteger(gap) && gap >= 15 && gap <= 480)) {
    throw Object.assign(new Error("session_policy_invalid"), { status: 503, code: "session_policy_invalid" });
  }
  return gap ?? null;
}
/** @param {any} doc @param {Record<string,string|number|string[]|null>} out */
function copyProfileText(doc, out) {
  for (const key of ["battleTag", "region", "preferredRace", "displayName", "lastKnownMmrAt", "lastKnownMmrRegion", "sessionAnchorAt"]) {
    const value = doc[key];
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
}
/** Prefer the array, including an explicitly empty array, to legacy pulseId.
 * @param {any} doc */
function profilePulseIds(doc) {
  return normalisePulseIdList(Array.isArray(doc.pulseIds) ? doc.pulseIds
    : typeof doc.pulseId === "string" ? [doc.pulseId] : []);
}
/** The original profile DTO/errors; proof fields never enter the result.
 * @param {any} doc @returns {Record<string,string|number|string[]|null>} */
function profileDto(doc) {
  if (!doc) return {};
  if (doc._gdprMutation) throw Object.assign(new Error("gdpr_operation_busy"), { status: 503, code: "gdpr_operation_busy" });
  /** @type {Record<string,string|number|string[]|null>} */
  const out = { sessionGapMinutes: profileGap(doc.sessionGapMinutes) };
  copyProfileText(doc, out);
  const ids = profilePulseIds(doc);
  if (ids.length > 0) { out.pulseIds = ids; out.pulseId = ids[0]; }
  const tags = normaliseBattleTagList(doc.battleTags);
  if (tags.length > 0) out.battleTags = tags;
  if (typeof doc.lastKnownMmr === "number" && Number.isFinite(doc.lastKnownMmr)) out.lastKnownMmr = doc.lastKnownMmr;
  return out;
}

/**
 * Trim, dedupe, and bound-check an array of BattleTags. Loose shape
 * check (must contain a ``#`` after at least one name char, ≤ 80 chars
 * to match the profile schema's ``battleTag`` cap) — Blizzard allows
 * unicode names, so anything stricter would reject real tags.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
function normaliseBattleTagList(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {string[]} */
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const tag = entry.trim();
    if (!tag || tag.length > 80) continue;
    const hash = tag.indexOf("#");
    if (hash < 1) continue;
    if (out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * Trim, dedupe, and bound-check an array of pulse identifiers. Strings
 * only; entries that survived after trimming and aren't already in the
 * accumulator are kept in input order. Capped at 20 to match the
 * profile schema's ``maxItems``.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalisePulseIdList(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {string[]} */
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || trimmed.length > 64) continue;
    if (out.includes(trimmed)) continue;
    out.push(trimmed);
    if (out.length >= 20) break;
  }
  return out;
}

/** @param {unknown} value @returns {string|null} */
function validReplayShareId(value) {
  return typeof value === "string" && REPLAY_SHARE_ID_RE.test(value)
    ? value
    : null;
}

/** @param {unknown} value @returns {string|null} */
function validReplayShareSlug(value) {
  return typeof value === "string"
    && value.length <= REPLAY_SHARE_SLUG_MAX_LENGTH
    && REPLAY_SHARE_SLUG_RE.test(value)
    ? value
    : null;
}

/**
 * Build a readable but collision-resistant player URL segment. The random
 * suffix is deliberately lowercase hexadecimal so links are unambiguous when
 * copied between case-sensitive and case-insensitive clients.
 *
 * @param {unknown} displayName
 * @returns {string}
 */
function createReplayShareSlug(displayName) {
  return createPlayerSlug(displayName);
}

/** @returns {Error & {status:number,code:string}} */
function replaySharingUserNotFound() {
  const err = /** @type {Error & {status:number,code:string}} */ (
    new Error("user_not_found")
  );
  err.status = 404;
  err.code = "user_not_found";
  return err;
}

/** Only known tours and bounded integer versions are client-writable.
 * Completing and skipping a tour record the same terminal version.
 * @param {unknown} value @returns {Record<string, number>} */
function validateOnboardingToursDone(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw Object.assign(new Error("invalid_onboarding_tours_done"), { status: 400, code: "invalid_onboarding_tours_done" });
  }
  const entries = Object.entries(value);
  if (entries.length > ONBOARDING_TOUR_IDS.size || entries.some(([id, version]) => !ONBOARDING_TOUR_IDS.has(id)
      || typeof version !== "number" || !Number.isSafeInteger(version) || version < 1 || version > ONBOARDING_TOUR_VERSION_MAX)) {
    throw Object.assign(new Error("invalid_onboarding_tours_done"), { status: 400, code: "invalid_onboarding_tours_done" });
  }
  return Object.fromEntries(entries);
}

/** Mongo's condition guards numeric operators from malformed legacy values.
 * @param {string} value @returns {import('mongodb').Document} */
function validStoredTourVersion(value) {
  return { $cond: [{ $isNumber: value }, { $and: [
    { $gte: [value, 1] }, { $lte: [value, ONBOARDING_TOUR_VERSION_MAX] }, { $eq: [value, { $trunc: value }] },
  ] }, false] };
}

/** Preserve independent tours and never roll back a newer saved version.
 * @param {Record<string, number>} versions @returns {import('mongodb').Document} */
function mergeOnboardingTourVersions(versions) {
  const path = "$preferences.onboarding.toursDone";
  const existing = { $arrayToObject: { $filter: {
    input: { $objectToArray: { $cond: [{ $eq: [{ $type: path }, "object"] }, path, {}] } },
    as: "entry", cond: { $and: [
      { $in: ["$$entry.k", { $literal: [...ONBOARDING_TOUR_IDS] }] }, validStoredTourVersion("$$entry.v"),
    ] },
  } } };
  const updates = Object.fromEntries(Object.entries(versions).map(([id, version]) => [id, { $max: [
    { $cond: [validStoredTourVersion(`${path}.${id}`), `${path}.${id}`, 0] }, { $literal: version },
  ] }]));
  return { $mergeObjects: [existing, updates] };
}
module.exports = { UsersService, validateOnboardingToursDone };
