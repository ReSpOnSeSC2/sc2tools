"use strict";

const crypto = require("crypto");
const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");
const {
  cleanText,
  cleanDisplayName,
  containsBlockedTerm,
} = require("../util/contentFilter");
const {
  publicBuildSnapshot,
  publicBuildMongoExpression,
  boundedPublicString,
  matchupFromRaces,
} = require("./communityBuildSnapshot");

const K_ANONYMITY_THRESHOLD = 5;

// Public opponent aggregates load at most this many game rows. The
// endpoint is unauthenticated; without a cap, a celebrity opponent
// faced by thousands of users becomes an anonymous memory-exhaustion
// lever.
const AGGREGATE_OPPONENT_MAX_GAMES = 20000;
const PUBLIC_AUTHOR_BUILD_LIMIT = 100;

/**
 * Match current rows plus legacy publications that stored the private slug
 * only inside build.
 * @param {string} userId
 * @param {string} sourceSlug
 */
function privateSourceFilter(userId, sourceSlug) {
  return {
    ownerUserId: userId,
    $or: [
      { sourceSlug },
      { sourceSlug: { $exists: false }, "build.slug": sourceSlug },
    ],
  };
}

/**
 * Compare-and-set filter for one authoritative publication revision.
 * `removed` historically defaulted to absent/false, so live rows use `$ne`.
 *
 * @param {string} userId
 * @param {string} sourceSlug
 * @param {Record<string, any>} row
 */
function publicationStateFilter(userId, sourceSlug, row) {
  /** @type {Record<string, any>} */
  const filter = row._id
    ? { _id: row._id }
    : privateSourceFilter(userId, sourceSlug);
  filter.removed = row.removed === true ? true : { $ne: true };
  filter.publicationRevision =
    typeof row.publicationRevision === "string"
      ? row.publicationRevision
      : { $exists: false };
  filter.publicationSequence = Number.isFinite(row.publicationSequence)
    ? Number(row.publicationSequence)
    : { $exists: false };
  return filter;
}

/**
 * @param {Record<string, any>} publicRow
 * @param {Record<string, any>|null} privateBuild
 */
function privateBuildMirrors(publicRow, privateBuild) {
  if (!privateBuild) return true;
  const expectedPublic = publicRow.removed !== true;
  if (!!privateBuild.isPublic !== expectedPublic) return false;
  if (Number.isFinite(publicRow.publicationSequence)) {
    return (
      privateBuild._communityPublicationSequence ===
      Number(publicRow.publicationSequence)
    );
  }
  if (typeof publicRow.publicationRevision === "string") {
    return (
      privateBuild._communityPublicationRevision ===
      publicRow.publicationRevision
    );
  }
  return !Number.isFinite(privateBuild._communityPublicationSequence);
}

/**
 * Outer projection used for every public listing/detail of a community
 * build. Centralised so list/detail/author-aggregate stay in sync —
 * anything new added to a build doc is automatically excluded from
 * public responses unless explicitly opted in here.
 */
const PUBLIC_OUTER_PROJECTION = Object.freeze({
  _id: 0,
  slug: 1,
  ownerUserId: 1,
  title: 1,
  description: 1,
  matchup: 1,
  authorName: 1,
  votes: 1,
  publishedAt: 1,
  updatedAt: 1,
});

// Aggregations cannot rely on a later dotted projection when an earlier
// `$group` would already push the complete legacy build into an in-process
// result. Construct and slice the safe nested object at that boundary.
const PUBLIC_AGGREGATE_PROJECTION = Object.freeze({
  ...PUBLIC_OUTER_PROJECTION,
  build: publicBuildMongoExpression("$build"),
});

// Publish reads only fields that can enter the public snapshot. A historical
// private doc may contain a multi-megabyte unknown child; never fetch that
// object wholesale merely to publish a handful of known leaves.
const PRIVATE_BUILD_PUBLICATION_PROJECTION = Object.freeze({
  _id: 0,
  ...publicBuildMongoExpression("$$ROOT"),
  isPublic: 1,
});

/**
 * Read-time public serializer for a community-build document.
 *
 * Community rows created by older releases may contain a full private build
 * under `build`. Mongo constructs only bounded safe leaves, then this final
 * serializer applies the same allowlist used at publish time. Returning a raw
 * row would preserve legacy `notes`, `sourceGameId`, `userId`, and the private
 * source `build.slug`.
 *
 * Keep the outer allowlist explicit as well. That makes the serializer the
 * final public boundary even if a future query accidentally fetches more
 * fields than PUBLIC_AGGREGATE_PROJECTION.
 *
 * @param {Record<string, any>} row
 * @returns {Record<string, any>}
 */
function publicCommunityBuildSnapshot(row) {
  /** @type {Record<string, any>} */
  const out = {};
  copyOuterString(out, "slug", row.slug, 80);
  copyOuterString(out, "title", row.title, 200);
  copyOuterString(out, "description", row.description, 4000);
  copyOuterString(out, "matchup", row.matchup, 16);
  copyOuterString(out, "authorName", row.authorName, 80);
  // Anonymous must mean unlinkable through this public API. The stable owner
  // id is needed only for a named author's profile link; exposing it on an
  // anonymous row lets viewers join that row to any later named publication.
  if (typeof out.authorName === "string" && out.authorName.trim()) {
    copyOuterString(out, "ownerUserId", row.ownerUserId, 200);
  }
  if (typeof row.votes === "number" && Number.isFinite(row.votes)) {
    out.votes = row.votes;
  }
  copyPublicDate(out, "publishedAt", row.publishedAt);
  copyPublicDate(out, "updatedAt", row.updatedAt);
  if (row.build !== undefined) {
    out.build = publicBuildSnapshot(row.build);
  }
  return out;
}

/** @param {Record<string, any>} out @param {string} key @param {unknown} value @param {number} max */
function copyOuterString(out, key, value, max) {
  const safe = boundedPublicString(value, max);
  if (safe !== undefined) out[key] = safe;
}

/** @param {Record<string, any>} out @param {string} key @param {unknown} value */
function copyPublicDate(out, key, value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    out[key] = new Date(value.getTime());
  } else {
    const safe = boundedPublicString(value, 40);
    if (safe !== undefined) out[key] = safe;
  }
}

/**
 * @param {Record<string, number>} counts
 * @param {number} total
 * @param {number} threshold — minimum share to qualify as dominant
 * @returns {string | null}
 */
function pickDominant(counts, total, threshold) {
  let best = "";
  let bestN = 0;
  for (const [k, n] of Object.entries(counts)) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  if (!best || total === 0) return null;
  return bestN / total >= threshold ? best : null;
}

/**
 * @param {Record<string, number>} counts
 * @returns {string | null}
 */
function pickTop(counts) {
  let best = "";
  let bestN = 0;
  for (const [k, n] of Object.entries(counts)) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best || null;
}

/**
 * Community service.
 *
 * Two public-read entities:
 *   1. communityBuilds — user-published custom builds, slug-addressed,
 *      voted on, reportable.
 *   2. aggregated opponent profiles — derived from `games` across all
 *      users. K-anonymity gated: we only surface a row if at least
 *      K_ANONYMITY_THRESHOLD distinct users have faced that pulseId.
 *
 * Plus a moderation queue: communityReports holds user-flag records
 * resolved by an admin via the Clerk role check.
 */
class CommunityService {
  /**
   * @param {import('../db/connect').DbContext} db
   * @param {{slugSecret?: Buffer|string}} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.slugSecret = opts.slugSecret || null;
  }

  // ── Builds ──────────────────────────────────────────────────────

  /**
   * Publish (or re-publish) a custom build to the community. Keyed on
   * (ownerUserId, sourceSlug) so it's idempotent per private build —
   * re-publishing updates the public copy in place.
   *
   * Re-publish preserves everything the public has already interacted
   * with: the public ``slug`` (stable shareable URL), the ``votes``
   * tally, and the original ``publishedAt`` date. Only the snapshot and
   * any author-supplied metadata change. (The previous implementation
   * regenerated the slug and reset votes to 0 on every save, which broke
   * shared links and wiped vote counts whenever an author edited a
   * build they'd already published.)
   *
   * The published ``build`` is a sanitised snapshot: private fields
   * (personal notes, source-replay id, internal ids, the owner's
   * userId) are stripped via {@link publicBuildSnapshot} so the public
   * copy honours the "personal notes / source replays stay private"
   * promise shown at publish time.
   *
   * @param {string} userId
   * @param {string} userSlug — the private build's slug
   * @param {{
   *   title?: string,
   *   description?: string,
   *   authorName?: string,
   *   publishAnonymously?: boolean,
   * }} meta
   * @returns {Promise<{slug: string, created: boolean, mirrorPending?: boolean}>}
   */
  async publish(userId, userSlug, meta) {
    // Content hygiene on everything that renders publicly. Blocked
    // terms reject outright; names/links are silently cleaned.
    const hasAuthorName = Object.prototype.hasOwnProperty.call(
      meta || {},
      "authorName",
    );
    const hasDescription = Object.prototype.hasOwnProperty.call(
      meta || {},
      "description",
    );
    const hasAnonymousChoice =
      typeof (meta && meta.publishAnonymously) === "boolean";
    meta = {
      title: cleanText(meta.title || ""),
      description: hasDescription
        ? cleanText(meta.description || "", { multiline: true })
        : undefined,
      authorName: hasAuthorName
        ? cleanDisplayName(meta.authorName || "")
        : undefined,
      publishAnonymously: hasAnonymousChoice
        ? !!meta.publishAnonymously
        : undefined,
    };
    for (const [field, value] of Object.entries(meta)) {
      if (typeof value !== "string") continue;
      if (containsBlockedTerm(value)) {
        const err = new Error(`content_rejected: ${field}`);
        /** @type {any} */ (err).status = 400;
        throw err;
      }
    }
    const priv = await this.db.customBuilds.aggregate([
      {
        $match: {
          userId,
          slug: userSlug,
          deletedAt: { $exists: false },
        },
      },
      { $limit: 1 },
      { $project: PRIVATE_BUILD_PUBLICATION_PROJECTION },
    ]).next();
    if (!priv) {
      const err = new Error("build_not_found");
      /** @type {any} */ (err).status = 404;
      throw err;
    }
    const sourceFilter = privateSourceFilter(userId, userSlug);
    let existing = await this.db.communityBuilds.findOne(sourceFilter, {
      sort: { removed: 1, votes: -1, publishedAt: 1, updatedAt: -1 },
    });
    const now = new Date();
    // Preserve the public slug across re-publishes so shared links keep
    // working; only mint a new one for a first-time publish.
    let slug = existing
      ? existing.slug
      : await this._uniqueSlug(userId, userSlug);
    const title =
      meta.title || (existing && existing.title) || priv.name || userSlug;
    // Only overwrite description / authorName when the caller actually
    // supplied a value, so the lightweight "Share with community" toggle
    // (which sends neither) never wipes metadata the author entered
    // through the richer publish dialog.
    const description = hasDescription
      ? meta.description || ""
      : (existing && existing.description) || "";
    // Identity is tri-state rather than truthy/falsy:
    //   * a new publication defaults to the owner's profile name;
    //   * explicit publishAnonymously=true is the only way a new row is
    //     anonymous;
    //   * an update that omits identity preserves the existing choice,
    //     including legacy anonymous rows. This avoids silently outing an
    //     author merely because they edited their build.
    const existingAuthorName = cleanDisplayName(
      (existing && existing.authorName) || "",
    );
    const existingAnonymous = existing
      ? typeof existing.publishAnonymously === "boolean"
        ? existing.publishAnonymously
        : !existingAuthorName
      : false;
    const publishAnonymously = hasAnonymousChoice
      ? !!meta.publishAnonymously
      : meta.authorName
        ? false
        : existing
          ? existingAnonymous
          : false;
    let authorName = "";
    if (!publishAnonymously) {
      authorName =
        meta.authorName ||
        (existing && !existingAnonymous ? existingAuthorName : "") ||
        (await this._defaultAuthorName(userId));
      if (!authorName) {
        const err = new Error("public_author_name_required");
        /** @type {any} */ (err).status = 400;
        /** @type {any} */ (err).code = "public_author_name_required";
        throw err;
      }
      if (containsBlockedTerm(authorName)) {
        const err = new Error("content_rejected: authorName");
        /** @type {any} */ (err).status = 400;
        throw err;
      }
    }
    /** @type {Record<string, any>} */
    const doc = {
      slug,
      ownerUserId: userId,
      sourceSlug: userSlug,
      title,
      description,
      authorName,
      publishAnonymously,
      matchup: priv.matchup || matchupFromRaces(priv.race, priv.vsRace),
      build: publicBuildSnapshot(priv),
      updatedAt: now,
      removed: false,
      publicationRevision: crypto.randomUUID(),
      privateMirrorPending: true,
    };
    stampVersion(doc, COLLECTIONS.COMMUNITY_BUILDS);
    const mutation = {
      $set: doc,
      $setOnInsert: { createdAt: now, publishedAt: now, votes: 0 },
      $inc: { publicationSequence: 1 },
    };
    const updatingExisting = !!existing;
    let created = false;
    try {
      const result = await this.db.communityBuilds.updateOne(
        existing ? { _id: existing._id } : { ownerUserId: userId, sourceSlug: userSlug },
        mutation,
        { upsert: true },
      );
      created = result.upsertedCount > 0;
    } catch (error) {
      // Retryable/network errors can be reported after Mongo has committed.
      // Verify this request's opaque revision before telling the client that
      // publishing failed or attempting any compensation.
      const committed = await this.db.communityBuilds.findOne({
        ...sourceFilter,
        publicationRevision: doc.publicationRevision,
      });
      if (committed && typeof committed.slug === "string") {
        existing = committed;
        slug = committed.slug;
        created = !updatingExisting;
      } else {
      // Two first publishes reserve the same deterministic public slug. The
      // existing unique slug index serializes them: refetch the winner and
      // apply this request as an update instead of creating a second source row.
      if (
        !error ||
        typeof error !== "object" ||
        /** @type {any} */ (error).code !== 11000 ||
        existing
      ) {
        throw error;
      }
      const winner = await this.db.communityBuilds.findOne(sourceFilter, {
        sort: { removed: 1, votes: -1, publishedAt: 1, updatedAt: -1 },
      });
      if (!winner || typeof winner.slug !== "string") throw error;
      existing = winner;
      slug = winner.slug;
      doc.slug = winner.slug;
      try {
        await this.db.communityBuilds.updateOne(
          { _id: winner._id },
          { $set: doc, $inc: { publicationSequence: 1 } },
        );
      } catch (retryError) {
        const retryCommitted = await this.db.communityBuilds.findOne({
          _id: winner._id,
          publicationRevision: doc.publicationRevision,
        });
        if (!retryCommitted) throw retryError;
      }
      }
    }
    // Mirror published state onto the private doc so the "Published"
    // badge + the editor's share toggle reflect reality across every
    // publish entry point (this dialog, the save-time toggle, forks).
    const mirrored = await this._mirrorPrivatePublicationState(
      userId,
      userSlug,
      true,
      { authorName, publishAnonymously },
    );
    // Once the public write is acknowledged, Community is the source of truth.
    // Never report "publish failed/private" merely because its private badge
    // mirror needs repair; that would be a dangerous visibility lie.
    return {
      slug,
      created,
      ...(mirrored ? {} : { mirrorPending: true }),
    };
  }

  /**
   * Owner-only publication settings for a private source build. Public
   * serializers deliberately omit this state; the editor needs it to render
   * the current choice accurately without exposing or changing a legacy
   * anonymous publication.
   *
   * @param {string} userId
   * @param {string} sourceSlug
   * @returns {Promise<{
   *   published: boolean,
   *   publicSlug: string|null,
   *   authorName: string,
   *   publishAnonymously: boolean,
   *   mirrorPending: boolean,
   * }>}
   */
  async getOwnerPublicationSettings(userId, sourceSlug) {
    const [row, defaultAuthorName] = await Promise.all([
      this.db.communityBuilds.findOne(
        privateSourceFilter(userId, sourceSlug),
        {
          sort: { removed: 1, votes: -1, publishedAt: 1, updatedAt: -1 },
          projection: {
            _id: 0,
            slug: 1,
            authorName: 1,
            publishAnonymously: 1,
            removed: 1,
            privateMirrorPending: 1,
            publicationRevision: 1,
            publicationSequence: 1,
          },
        },
      ),
      this._defaultAuthorName(userId),
    ]);
    const savedAuthorName = cleanDisplayName((row && row.authorName) || "");
    // Missing mode on an old row is inferred conservatively: blank meant
    // anonymous under the historical contract, so never deanonymise it.
    const publishAnonymously = row
      ? typeof row.publishAnonymously === "boolean"
        ? row.publishAnonymously
        : !savedAuthorName
      : false;
    let mirrorPending = !!(row && row.privateMirrorPending);
    if (row && mirrorPending) {
      mirrorPending = !(await this._mirrorPrivatePublicationState(
        userId,
        sourceSlug,
        row.removed !== true,
        {
          authorName: savedAuthorName,
          publishAnonymously,
        },
      ));
    }
    return {
      published: !!row && row.removed !== true,
      publicSlug: row && typeof row.slug === "string" ? row.slug : null,
      // Return the safe account fallback even for an anonymous row so the
      // owner can uncheck the opt-in and immediately see who will be shown.
      authorName: savedAuthorName || defaultAuthorName,
      publishAnonymously,
      mirrorPending,
    };
  }

  /**
   * Resolve the account identity used for named-by-default publishing.
   * Profile display name wins; BattleTag (without its discriminator) is the
   * fallback. No internal user id or Clerk id is ever turned into a public
   * name.
   *
   * @private
   * @param {string} userId
   * @returns {Promise<string>}
   */
  async _defaultAuthorName(userId) {
    const profile = await this.db.users.findOne(
      { userId },
      { projection: { _id: 0, displayName: 1, battleTag: 1 } },
    );
    const displayName = cleanDisplayName(
      profile && typeof profile.displayName === "string"
        ? profile.displayName
        : "",
    );
    if (displayName) return displayName;
    const battleTag =
      profile && typeof profile.battleTag === "string"
        ? profile.battleTag.split("#")[0]
        : "";
    return cleanDisplayName(battleTag);
  }

  /**
   * Unpublish by the PRIVATE build slug (sourceSlug). Used by the
   * save-time "Share with community" toggle when an author flips
   * sharing back off — the editor knows only the private slug, not the
   * public one. Soft-removes the public copy; the doc (with its slug +
   * votes) is retained so re-publishing later restores the same
   * listing. No-op when the build was never published.
   *
   * @param {string} userId
   * @param {string} sourceSlug
   * @returns {Promise<{removed: boolean, mirrorPending: boolean}>}
   */
  async unpublishBySource(userId, sourceSlug) {
    const sourceFilter = privateSourceFilter(userId, sourceSlug);
    const publicationRevision = crypto.randomUUID();
    const mutation = {
        $set: {
          removed: true,
          removedAt: new Date(),
          removedBy: userId,
          removalReason: "owner_unpublish",
          publicationRevision,
          privateMirrorPending: true,
        },
        $inc: { publicationSequence: 1 },
      };
    let removed = false;
    try {
      const res = await this.db.communityBuilds.updateMany(
        { ...sourceFilter, removed: { $ne: true } },
        mutation,
      );
      removed = res.matchedCount > 0;
    } catch (error) {
      const active = await this.db.communityBuilds.findOne({
        ...sourceFilter,
        removed: { $ne: true },
      });
      if (active) throw error;
      removed = !!(await this.db.communityBuilds.findOne({
        ...sourceFilter,
        publicationRevision,
      }));
    }
    // Keep the private doc's badge in sync even when nothing was live to
    // remove — the author's intent is "not shared".
    const mirrored = await this._mirrorPrivatePublicationState(
      userId,
      sourceSlug,
      false,
    );
    return {
      removed,
      mirrorPending: !mirrored,
    };
  }

  /**
   * Set `isPublic` on the owner's private custom-build doc. Best-effort
   * mirror of community state; skips soft-deleted docs and never throws
   * on a missing build (the community write is the source of truth).
   *
   * @private
   * @param {string} userId
   * @param {string} sourceSlug
   * @param {boolean} isPublic
   * @param {{authorName: string, publishAnonymously: boolean}} [identity]
   * @param {string} [publicationRevision]
   * @param {number} [publicationSequence]
   */
  async _setPrivateIsPublic(
    userId,
    sourceSlug,
    isPublic,
    identity,
    publicationRevision,
    publicationSequence,
  ) {
    /** @type {Record<string, any>} */
    const set = { isPublic: !!isPublic, updatedAt: new Date() };
    if (identity) {
      set.communityAuthorName = identity.authorName;
      set.publishAnonymously = identity.publishAnonymously;
    }
    if (publicationRevision) {
      set._communityPublicationRevision = publicationRevision;
    }
    if (Number.isFinite(publicationSequence)) {
      set._communityPublicationSequence = publicationSequence;
    }
    /** @type {Record<string, any>} */
    const filter = { userId, slug: sourceSlug, deletedAt: { $exists: false } };
    // Never let a slow mirror from an older public mutation overwrite the
    // private badge written by a newer publish/unpublish request.
    if (Number.isFinite(publicationSequence)) {
      filter.$or = [
        { _communityPublicationSequence: { $exists: false } },
        { _communityPublicationSequence: { $lte: publicationSequence } },
      ];
    } else {
      filter._communityPublicationSequence = { $exists: false };
    }
    return this.db.customBuilds.updateOne(
      filter,
      { $set: set },
    );
  }

  /**
   * Best-effort, retrying mirror of authoritative Community visibility.
   * Failure is recorded internally for read repair and never changes the
   * already-committed public result returned to the client.
   *
   * @private
   * @param {string} userId
   * @param {string} sourceSlug
   * @param {boolean} isPublic
   * @param {{authorName: string, publishAnonymously: boolean}} [identity]
   */
  async _mirrorPrivatePublicationState(userId, sourceSlug, isPublic, identity) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const current = await this.db.communityBuilds.findOne(
          privateSourceFilter(userId, sourceSlug),
          {
            sort: { removed: 1, votes: -1, publishedAt: 1, updatedAt: -1 },
            projection: {
              _id: 1,
              removed: 1,
              authorName: 1,
              publishAnonymously: 1,
              publicationRevision: 1,
              publicationSequence: 1,
            },
          },
        );
        const currentPublic = current ? current.removed !== true : isPublic;
        const currentIdentity = current
          ? {
              authorName: cleanDisplayName(current.authorName || ""),
              publishAnonymously:
                typeof current.publishAnonymously === "boolean"
                  ? current.publishAnonymously
                  : !current.authorName,
            }
          : identity;
        const revision =
          current && typeof current.publicationRevision === "string"
            ? current.publicationRevision
            : undefined;
        const sequence =
          current && Number.isFinite(current.publicationSequence)
            ? Number(current.publicationSequence)
            : undefined;
        await this._setPrivateIsPublic(
          userId,
          sourceSlug,
          currentPublic,
          currentIdentity,
          revision,
          sequence,
        );
        const after = await this.db.communityBuilds.findOne(
          current
            ? { _id: current._id }
            : privateSourceFilter(userId, sourceSlug),
          {
            projection: {
              _id: 1,
              publicationRevision: 1,
              publicationSequence: 1,
              removed: 1,
            },
          },
        );
        const sameAuthoritativeState = current
          ? !!after &&
            after.publicationRevision === current.publicationRevision &&
            after.publicationSequence === current.publicationSequence &&
            after.removed === current.removed
          : !after;
        if (!sameAuthoritativeState) continue;
        if (!current) return true;
        const cleared = await this.db.communityBuilds.updateOne(
          publicationStateFilter(userId, sourceSlug, current),
          { $unset: { privateMirrorPending: "" } },
        );
        if (cleared.matchedCount > 0) return true;
      } catch {
        // One immediate retry handles a transient primary/network handoff.
      }
    }
    try {
      const current = await this.db.communityBuilds.findOne(
        privateSourceFilter(userId, sourceSlug),
        {
          sort: { removed: 1, votes: -1, publishedAt: 1, updatedAt: -1 },
          projection: {
            _id: 1,
            removed: 1,
            publicationRevision: 1,
            publicationSequence: 1,
          },
        },
      );
      if (!current) return false;
      const privateBuild = await this.db.customBuilds.findOne(
        { userId, slug: sourceSlug, deletedAt: { $exists: false } },
        {
          projection: {
            _id: 0,
            isPublic: 1,
            _communityPublicationRevision: 1,
            _communityPublicationSequence: 1,
          },
        },
      );
      if (privateBuildMirrors(current, privateBuild)) {
        const cleared = await this.db.communityBuilds.updateOne(
          publicationStateFilter(userId, sourceSlug, current),
          { $unset: { privateMirrorPending: "" } },
        );
        return cleared.matchedCount > 0;
      }
      const marked = await this.db.communityBuilds.updateOne(
        publicationStateFilter(userId, sourceSlug, current),
        { $set: { privateMirrorPending: true } },
      );
      if (marked.matchedCount === 0) return false;
      // A same-revision mirror may have completed between the private read
      // and marker write. Avoid leaving a false repair marker in that race.
      const afterPrivate = await this.db.customBuilds.findOne(
        { userId, slug: sourceSlug, deletedAt: { $exists: false } },
        {
          projection: {
            _id: 0,
            isPublic: 1,
            _communityPublicationRevision: 1,
            _communityPublicationSequence: 1,
          },
        },
      );
      if (privateBuildMirrors(current, afterPrivate)) {
        await this.db.communityBuilds.updateOne(
          publicationStateFilter(userId, sourceSlug, current),
          { $unset: { privateMirrorPending: "" } },
        );
        return true;
      }
    } catch {
      // Public state is still authoritative even if the repair marker fails.
    }
    return false;
  }

  /**
   * Reconcile the private badge from the authoritative Community row.
   * @param {string} userId
   * @param {string} sourceSlug
   */
  async reconcilePrivatePublicationState(userId, sourceSlug) {
    return this._mirrorPrivatePublicationState(userId, sourceSlug, false);
  }

  /**
   * Unpublish (soft) by setting removed=true. The owner OR an admin
   * can call this; admin path adds a moderation note in the report.
   *
   * Owner removals are deliberately idempotent: a second DELETE succeeds
   * without rewriting the original removal audit fields. Missing builds and
   * builds owned by somebody else both return the same 404 so this write
   * endpoint cannot be used to probe ownership. The private source build is
   * retained and only has its `isPublic` mirror switched off.
   *
   * @param {string} userId
   * @param {string} slug
   * @param {{adminUserId?: string, reason?: string}} [opts]
   * @returns {Promise<boolean>} true only when this call removed a live copy
   */
  async unpublish(userId, slug, opts = {}) {
    const lookupFilter = opts.adminUserId
      ? { slug }
      : { slug, ownerUserId: userId };
    const existing = await this.db.communityBuilds.findOne(lookupFilter, {
      projection: {
        _id: 1,
        ownerUserId: 1,
        sourceSlug: 1,
        "build.slug": 1,
        removed: 1,
      },
    });
    if (!existing) {
      const err = new Error("not_found");
      /** @type {any} */ (err).status = 404;
      throw err;
    }

    const sourceSlug = typeof existing.sourceSlug === "string"
      ? existing.sourceSlug
      : typeof existing.build?.slug === "string"
        ? existing.build.slug
        : "";

    let removed = false;
    if (existing.removed !== true) {
      const filter = !opts.adminUserId && sourceSlug
        ? {
            ownerUserId: existing.ownerUserId,
            removed: { $ne: true },
            $or: [
              { sourceSlug },
              { sourceSlug: { $exists: false }, "build.slug": sourceSlug },
            ],
          }
        : { _id: existing._id, removed: { $ne: true } };
      const publicationRevision = crypto.randomUUID();
      const mutation = {
        $set: {
          removed: true,
          removedAt: new Date(),
          removedBy: opts.adminUserId || userId,
          removalReason: opts.reason || "owner_unpublish",
          publicationRevision,
          privateMirrorPending: true,
        },
        $inc: { publicationSequence: 1 },
      };
      try {
        const res = opts.adminUserId
          ? await this.db.communityBuilds.updateOne(filter, mutation)
          : await this.db.communityBuilds.updateMany(filter, mutation);
        removed = res.modifiedCount > 0;
      } catch (error) {
        const verificationFilter = !opts.adminUserId && sourceSlug
          ? privateSourceFilter(existing.ownerUserId, sourceSlug)
          : { _id: existing._id };
        const active = await this.db.communityBuilds.findOne({
          ...verificationFilter,
          removed: { $ne: true },
        });
        if (active) throw error;
        removed = true;
      }
    }

    if (sourceSlug) {
      await this._mirrorPrivatePublicationState(
        existing.ownerUserId,
        sourceSlug,
        false,
      );
    }
    return removed;
  }

  /**
   * Public list — only non-removed builds, optionally filtered by
   * matchup or a free-text query. Sortable by top votes, newest, or
   * "controversial" (high engagement, near-50/50 vote split).
   *
   * `ownerUserId` is serialized only for rows carrying a public author name,
   * where it powers `/community/authors/:userId`. Anonymous rows omit it so
   * they cannot be joined to a later named publication by stable owner id.
   *
   * @param {{
   *   matchup?: string,
   *   limit?: number,
   *   offset?: number,
   *   sort?: 'top' | 'new' | 'controversial',
   *   search?: string,
   * }} opts
   */
  async listPublic(opts = {}) {
    const filter = /** @type {Record<string, any>} */ ({ removed: false });
    if (opts.matchup) filter.matchup = opts.matchup;
    if (opts.search) {
      const escaped = String(opts.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(escaped, "i");
      filter.$or = [
        { title: re },
        { description: re },
        { authorName: re },
      ];
    }
    const limit = Math.min(opts.limit || 30, 100);
    const offset = Math.max(0, Number(opts.offset) || 0);
    const sortKey = opts.sort || "top";
    /** @type {Record<string, 1 | -1>} */
    let sort;
    switch (sortKey) {
      case "new":
        sort = { publishedAt: -1, votes: -1 };
        break;
      case "controversial":
        // Controversial: lots of votes either way. We approximate by
        // ordering on the sum of upvotes + downvotes desc. The
        // pipeline path computes the sum field on the fly.
        return this._listControversial(filter, { limit, offset });
      case "top":
      default:
        sort = { votes: -1, publishedAt: -1 };
        break;
    }
    const rows = await this.db.communityBuilds.aggregate([
      { $match: filter },
      { $sort: sort },
      { $skip: offset },
      { $limit: limit + 1 }, // Fetch one extra to know whether more exist.
      { $project: PUBLIC_AGGREGATE_PROJECTION },
    ]).toArray();
    const hasMore = rows.length > limit;
    const items = rows
      .slice(0, limit)
      .map((row) => publicCommunityBuildSnapshot(row));
    const total = await this.db.communityBuilds.countDocuments(filter);
    return { items, hasMore, total, offset, limit };
  }

  /**
   * Authenticated owner-only replay totals for the creator's published cards.
   * The response is keyed by PUBLIC slug and never exposes the private source
   * slug or any replay identity. Other viewers receive only their own rows.
   *
   * @param {string} userId
   * @returns {Promise<Array<{publicSlug: string, total: number, wins: number, losses: number}>>}
   */
  async listOwnerReplayStats(userId) {
    const published = await this.db.communityBuilds
      .find(
        { ownerUserId: userId, removed: false },
        {
          projection: {
            _id: 0,
            slug: 1,
            sourceSlug: 1,
            "build.slug": 1,
          },
        },
      )
      .toArray();
    /** @param {Record<string, any>} row */
    const sourceFor = (row) => String(row.sourceSlug || row.build?.slug || "");
    const sourceSlugs = published
      .map(sourceFor)
      .filter(Boolean);
    const counts = sourceSlugs.length > 0
      ? await this.db.games
      .aggregate([
        {
          $match: {
            userId,
            $or: [
              { _customBuildSlug: { $in: sourceSlugs } },
              { _customOpponentStrategySlug: { $in: sourceSlugs } },
            ],
            isResumedFromReplay: { $ne: true },
          },
        },
        {
          // A replay can match one authored build on each perspective. Unwind
          // both provenance slots so published cards get the correct owner
          // totals without making the two builds compete for one count.
          $project: {
            result: 1,
            _customReplaySlugs: {
              $setUnion: [
                {
                  $filter: {
                    input: ["$_customBuildSlug", "$_customOpponentStrategySlug"],
                    as: "slug",
                    cond: { $in: ["$$slug", sourceSlugs] },
                  },
                },
                [],
              ],
            },
          },
        },
        { $unwind: "$_customReplaySlugs" },
        {
          $group: {
            _id: "$_customReplaySlugs",
            total: { $sum: 1 },
            wins: {
              $sum: {
                $cond: [
                  { $in: [
                    { $toLower: { $ifNull: ["$result", ""] } },
                    ["win", "victory"],
                  ] },
                  1,
                  0,
                ],
              },
            },
            losses: {
              $sum: {
                $cond: [
                  { $in: [
                    { $toLower: { $ifNull: ["$result", ""] } },
                    ["loss", "defeat"],
                  ] },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ])
      .toArray()
      : [];
    const bySource = new Map(
      counts.map((row) => [String(row._id || ""), row]),
    );
    return published.map((row) => {
      const count = bySource.get(sourceFor(row));
      return {
        publicSlug: String(row.slug || ""),
        total: Math.max(0, Number(count?.total) || 0),
        wins: Math.max(0, Number(count?.wins) || 0),
        losses: Math.max(0, Number(count?.losses) || 0),
      };
    });
  }

  /**
   * Balanced "top-N per matchup" listing used by the Arcade Stock
   * Market to build a universe of builds that spans every matchup.
   * The default `listPublic` (sort=top, global) skews to whichever
   * race dominates vote counts — for a Protoss-heavy community that
   * collapses the universe to PvX, hiding ZvX/TvX entirely. This
   * method groups by matchup and keeps the top `perMatchup` builds in
   * each bucket so every matchup gets representation.
   *
   * One Mongo aggregation, served by the
   * `{matchup, removed, votes: -1}` index. The empty-string matchup
   * (legacy unclassified rows) gets its own bucket so those builds
   * still surface.
   *
   * @param {{ perMatchup?: number, totalCap?: number }} [opts]
   * @returns {Promise<{ items: object[] }>}
   */
  async listArcadeUniverse(opts = {}) {
    const perMatchup = Math.min(Math.max(1, Number(opts.perMatchup) || 12), 50);
    const totalCap = Math.min(Math.max(1, Number(opts.totalCap) || 200), 500);
    const items = await this.db.communityBuilds
      .aggregate([
        { $match: { removed: false } },
        { $sort: { votes: -1, publishedAt: -1 } },
        {
          $group: {
            _id: { $ifNull: ["$matchup", ""] },
            items: {
              $push: {
                slug: "$slug",
                ownerUserId: "$ownerUserId",
                title: "$title",
                description: "$description",
                matchup: "$matchup",
                authorName: "$authorName",
                votes: "$votes",
                publishedAt: "$publishedAt",
                updatedAt: "$updatedAt",
                build: publicBuildMongoExpression("$build"),
              },
            },
          },
        },
        {
          $project: {
            _id: 0,
            matchup: "$_id",
            items: { $slice: ["$items", perMatchup] },
          },
        },
        { $unwind: "$items" },
        { $replaceRoot: { newRoot: "$items" } },
        { $sort: { matchup: 1, votes: -1, publishedAt: -1 } },
        { $limit: totalCap },
      ])
      .toArray();
    return {
      items: items.map((row) => publicCommunityBuildSnapshot(row)),
    };
  }

  /**
   * @param {Record<string, any>} filter
   * @param {{limit: number, offset: number}} page
   */
  async _listControversial(filter, page) {
    const items = await this.db.communityBuilds
      .aggregate([
        { $match: filter },
        {
          $addFields: {
            engagement: {
              $add: [
                { $size: { $ifNull: ["$upvotes", []] } },
                { $size: { $ifNull: ["$downvotes", []] } },
              ],
            },
          },
        },
        { $sort: { engagement: -1, publishedAt: -1 } },
        { $skip: page.offset },
        { $limit: page.limit + 1 },
        // This is an inclusion projection. Mongo permits `_id: 0` alongside
        // inclusions, but excluding the computed `engagement` field here as
        // well makes the projection illegally mixed. Because engagement is
        // not included by PUBLIC_AGGREGATE_PROJECTION, it is already omitted.
        { $project: PUBLIC_AGGREGATE_PROJECTION },
      ])
      .toArray();
    const hasMore = items.length > page.limit;
    const total = await this.db.communityBuilds.countDocuments(filter);
    return {
      items: items
        .slice(0, page.limit)
        .map((row) => publicCommunityBuildSnapshot(row)),
      hasMore,
      total,
      offset: page.offset,
      limit: page.limit,
    };
  }

  /**
   * Public detail — full build content. 404s when removed.
   * Exposes `ownerUserId` only for named authors so the frontend can link
   * to the author profile page without making anonymous rows linkable.
   *
   * @param {string} slug
   */
  async getPublic(slug) {
    const row = await this.db.communityBuilds.aggregate([
      { $match: { slug, removed: false } },
      { $limit: 1 },
      // Keep detail responses on the same explicit public allowlist as the
      // collection view. In particular, sourceSlug links the publication to
      // a user's private library and must never cross this boundary.
      { $project: PUBLIC_AGGREGATE_PROJECTION },
    ]).next();
    return row ? publicCommunityBuildSnapshot(row) : null;
  }

  /**
   * Public author profile aggregate. Returns null when the author has
   * no published builds OR when none of their builds carry a public
   * `authorName` — that's the implicit "no public profile" opt-out.
   * Users who never declare a display name on a publish stay private.
   *
   * @param {string} userId — internal UUID (not Clerk id)
   * @returns {Promise<{
   *   userId: string,
   *   displayName: string,
   *   joinedAt: Date | null,
   *   builds: object[],
   *   totalBuilds: number,
   *   totalVotes: number,
   *   primaryRace: string | null,
   *   topMatchup: string | null,
   *   topBuild: object | null,
   *   recent: object[],
   * } | null>}
   */
  async getAuthor(userId) {
    if (!userId) return null;
    const rawBuilds = await this.db.communityBuilds.aggregate([
      { $match: { ownerUserId: userId, removed: false } },
      { $sort: { publishedAt: -1 } },
      { $limit: PUBLIC_AUTHOR_BUILD_LIMIT },
      { $project: PUBLIC_AGGREGATE_PROJECTION },
    ]).toArray();
    const allBuilds = rawBuilds.map((row) => publicCommunityBuildSnapshot(row));
    if (allBuilds.length === 0) return null;
    // Anonymous publications are excluded from the profile entirely, not
    // merely used as a gate. Otherwise publishing one named build later would
    // retroactively attach every anonymous build (and its votes/stats) to the
    // public author profile.
    const builds = allBuilds.filter(
      (b) => typeof b.authorName === "string" && b.authorName.trim().length > 0,
    );
    if (builds.length === 0) return null;
    // Most-recent declared authorName wins as the canonical display.
    const displayName = builds[0].authorName.trim();
    const totalVotes = builds.reduce(
      (acc, b) => acc + (Number.isFinite(b.votes) ? b.votes : 0),
      0,
    );
    /** @type {Record<string, number>} */
    const raceCounts = {};
    /** @type {Record<string, number>} */
    const matchupCounts = {};
    for (const b of builds) {
      const r = b.build?.race;
      if (r) raceCounts[r] = (raceCounts[r] || 0) + 1;
      if (b.matchup) matchupCounts[b.matchup] = (matchupCounts[b.matchup] || 0) + 1;
    }
    const primaryRace = pickDominant(raceCounts, builds.length, 0.6);
    const topMatchup = pickTop(matchupCounts);
    const topBuild = builds.reduce((best, cur) => {
      if (!best) return cur;
      return (cur.votes ?? 0) > (best.votes ?? 0) ? cur : best;
    }, /** @type {any} */ (null));
    const joinedAt = builds.length
      ? builds.reduce((earliest, b) => {
          const t = b.publishedAt ? new Date(b.publishedAt).getTime() : NaN;
          if (!Number.isFinite(t)) return earliest;
          if (earliest == null || t < earliest) return t;
          return earliest;
        }, /** @type {number | null} */ (null))
      : null;
    return {
      userId,
      displayName,
      joinedAt: joinedAt != null ? new Date(joinedAt) : null,
      builds,
      totalBuilds: builds.length,
      totalVotes,
      primaryRace,
      topMatchup,
      topBuild,
      recent: builds.slice(0, 5),
    };
  }

  /**
   * @param {string} userId
   * @param {string} slug
   * @param {1 | -1} delta
   */
  async vote(userId, slug, delta) {
    if (delta !== 1 && delta !== -1) {
      const err = new Error("delta must be ±1");
      /** @type {any} */ (err).status = 400;
      throw err;
    }
    // We store one vote per (userId, slug) by stashing the vote inside
    // the build doc via $addToSet; rolling our own vote table is overkill
    // for the volumes we expect.
    const arr = delta === 1 ? "upvotes" : "downvotes";
    const opposite = delta === 1 ? "downvotes" : "upvotes";
    await this.db.communityBuilds.updateOne(
      { slug, removed: false },
      {
        $addToSet: { [arr]: userId },
        // Computed-key $pull fights the driver's PullOperator mapped
        // type — the key is one of two literal array fields at runtime.
        $pull: /** @type {any} */ ({ [opposite]: userId }),
      },
    );
    // Refresh the cached `votes` count.
    const row = await this.db.communityBuilds.findOne(
      { slug },
      { projection: { upvotes: 1, downvotes: 1 } },
    );
    if (row) {
      const u = Array.isArray(row.upvotes) ? row.upvotes.length : 0;
      const d = Array.isArray(row.downvotes) ? row.downvotes.length : 0;
      await this.db.communityBuilds.updateOne(
        { slug },
        { $set: { votes: u - d } },
      );
    }
  }

  // ── K-anonymous opponent profiles ────────────────────────────────

  /**
   * Compute aggregate stats for one pulseId across ALL users. Returns
   * null if fewer than K_ANONYMITY_THRESHOLD distinct users have faced
   * this opponent — public exposure of single-user data is a privacy
   * leak (you'd be able to recover individual battle tags by cross-
   * referencing).
   *
   * @param {string} pulseId
   */
  async aggregateOpponent(pulseId) {
    // Discover the canonical SC2Pulse character id for this toon
    // handle from any opponents row that's seen it. If a player
    // ever rebound their Battle.net account, two distinct toon
    // handles may both map to the same pulseCharacterId; we want
    // the cross-toon games to appear in the public aggregate so
    // the k-anonymous profile reflects the same player's full
    // public footprint. ``distinct`` returns at most one id per
    // input toon — opponents.pulseId is unique-per-user, so we
    // grab any user's row and read its character id off.
    const charIdRow = await this.db.opponents.findOne(
      {
        pulseId,
        pulseCharacterId: { $type: "string", $ne: "" },
      },
      { projection: { pulseCharacterId: 1 } },
    );
    const pulseCharacterId = charIdRow && typeof charIdRow.pulseCharacterId === "string"
      ? charIdRow.pulseCharacterId
      : null;
    /** @type {Record<string, any>} */
    const filter = pulseCharacterId
      ? {
          isResumedFromReplay: { $ne: true },
          $or: [
            { "opponent.pulseId": pulseId },
            { "opponent.pulseCharacterId": pulseCharacterId },
          ],
        }
      : {
          isResumedFromReplay: { $ne: true },
          "opponent.pulseId": pulseId,
        };
    // Check the k-anonymity floor BEFORE materializing rows. This is a
    // public, unauthenticated endpoint: for a heavily-faced opponent
    // (a pro / streamer) the old load-then-count shape let any
    // anonymous caller trigger an unbounded scan+load of every user's
    // games. ``distinct`` resolves from the index without shipping
    // documents.
    const distinctUserIds = (await this.db.games.distinct("userId", filter))
      .filter((userId) => typeof userId === "string" && userId.length > 0);
    if (distinctUserIds.length < K_ANONYMITY_THRESHOLD) {
      return null;
    }
    const games = await this.db.games
      .find(filter, {
        projection: {
          userId: 1,
          result: 1,
          map: 1,
          "opponent.race": 1,
          "opponent.strategy": 1,
          "opponent.opening": 1,
          _id: 0,
        },
      })
      // Hard cap: aggregate quality saturates long before this, and it
      // bounds memory for celebrity opponents. Most recent-inserted
      // rows win (natural order); counts below reflect the capped set.
      .limit(AGGREGATE_OPPONENT_MAX_GAMES)
      .toArray();
    const distinctUsers = new Set(
      games
        .map((g) => g.userId)
        .filter((userId) => typeof userId === "string" && userId.length > 0),
    );
    // The indexed pre-check above applies to the complete match set. A single
    // prolific contributor can still occupy the entire bounded sample while
    // four sparse contributors sit beyond the 20k cap. Never publish that
    // sample: the aggregate itself must independently satisfy k-anonymity.
    if (distinctUsers.size < K_ANONYMITY_THRESHOLD) {
      return null;
    }
    let wins = 0;
    let losses = 0;
    /** @type {Record<string, number>} */
    const openings = {};
    /** @type {Record<string, number>} */
    const strategies = {};
    /** @type {Record<string, {wins: number, losses: number}>} */
    const byMap = {};
    /** @type {string|undefined} */
    let race = undefined;
    for (const g of games) {
      // From the opponent's perspective: their wins are our losses.
      if (g.result === "Defeat") wins += 1;
      if (g.result === "Victory") losses += 1;
      if (!race && g.opponent?.race) race = g.opponent.race;
      const op = g.opponent?.opening;
      if (op) openings[op] = (openings[op] || 0) + 1;
      const st = g.opponent?.strategy;
      if (st) strategies[st] = (strategies[st] || 0) + 1;
      if (g.map) {
        if (!byMap[g.map]) byMap[g.map] = { wins: 0, losses: 0 };
        if (g.result === "Defeat") byMap[g.map].wins += 1;
        if (g.result === "Victory") byMap[g.map].losses += 1;
      }
    }
    const total = wins + losses;
    return {
      pulseId,
      race,
      contributors: distinctUsers.size,
      games: games.length,
      wins,
      losses,
      winRate: total > 0 ? wins / total : 0,
      openings,
      strategies,
      byMap,
    };
  }

  // ── Moderation queue ─────────────────────────────────────────────

  /**
   * @param {string} userId — reporter
   * @param {{targetType: string, targetId: string, reason: string, note?: string}} input
   *   ``targetType`` must be 'build'|'opponent'; anything else is
   *   rejected with a 400 below. Typed wide because the route passes
   *   the raw request-body string through for exactly that check.
   */
  async report(userId, input) {
    if (!["build", "opponent"].includes(input.targetType)) {
      const err = new Error("targetType must be build|opponent");
      /** @type {any} */ (err).status = 400;
      throw err;
    }
    const reason = String(input.reason || "").slice(0, 80);
    if (!reason) {
      const err = new Error("reason required");
      /** @type {any} */ (err).status = 400;
      throw err;
    }
    const targetId = String(input.targetId);
    // Per-(reporter, target) dedup: one open report per user per
    // target. Without it a single user could flood the moderation
    // queue with duplicate rows; the caller can also tell the user
    // "already reported" instead of silently stacking.
    const existing = await this.db.communityReports.findOne(
      {
        reporterUserId: userId,
        targetType: input.targetType,
        targetId,
        resolvedAt: null,
      },
      { projection: { _id: 1 } },
    );
    if (existing) {
      return { alreadyReported: true };
    }
    await this.db.communityReports.insertOne(
      stampVersion(
        {
          id: crypto.randomUUID(),
          reporterUserId: userId,
          targetType: input.targetType,
          targetId,
          reason,
          note: String(input.note || "").slice(0, 1000),
          createdAt: new Date(),
          resolvedAt: null,
          resolution: null,
        },
        COLLECTIONS.COMMUNITY_REPORTS,
      ),
    );
    return { alreadyReported: false };
  }

  /** @returns {Promise<{items: object[]}>} */
  async listReports() {
    const items = await this.db.communityReports
      .find({ resolvedAt: null }, { projection: { _id: 0 } })
      .sort({ createdAt: 1 })
      .limit(100)
      .toArray();
    return { items };
  }

  /**
   * @param {string} adminUserId
   * @param {string} reportId
   * @param {{action: 'dismiss'|'remove', note?: string}} input
   */
  async resolveReport(adminUserId, reportId, input) {
    const report = await this.db.communityReports.findOne({ id: reportId });
    if (!report) {
      const err = new Error("report_not_found");
      /** @type {any} */ (err).status = 404;
      throw err;
    }
    if (input.action === "remove" && report.targetType === "build") {
      await this.unpublish("admin", report.targetId, {
        adminUserId,
        reason: input.note || "moderator_action",
      });
    }
    await this.db.communityReports.updateOne(
      { id: reportId },
      {
        $set: {
          resolvedAt: new Date(),
          resolvedBy: adminUserId,
          resolution: input.action,
          note: input.note || null,
        },
      },
    );
  }

  // ── Internals ────────────────────────────────────────────────────

  /**
   * Reserve a deterministic slug for one private source. Concurrent first
   * publishes therefore contend on the existing unique slug index instead of
   * inserting two public rows with different random slugs.
   *
   * @param {string} ownerUserId
   * @param {string} sourceSlug
   * @returns {Promise<string>}
   */
  async _uniqueSlug(ownerUserId, sourceSlug) {
    if (!this.slugSecret) throw new Error("community_slug_secret_required");
    const reservation = crypto
      .createHmac("sha256", this.slugSecret)
      .update("community-build-source-v1\0")
      .update(ownerUserId)
      .update("\0")
      .update(sourceSlug)
      .digest("hex")
      .slice(0, 32);
    for (let i = 0; i < 5; i++) {
      const candidate =
        i === 0 ? `build-${reservation}` : `build-${reservation}-${i + 1}`;
      const exists = await this.db.communityBuilds.findOne(
        { slug: candidate },
        { projection: { _id: 1, ownerUserId: 1, sourceSlug: 1 } },
      );
      if (
        !exists ||
        (exists.ownerUserId === ownerUserId && exists.sourceSlug === sourceSlug)
      ) {
        return candidate;
      }
    }
    // Fallback — astronomically unlikely.
    return `build-${crypto.randomBytes(8).toString("hex")}`;
  }
}

module.exports = { CommunityService, K_ANONYMITY_THRESHOLD };
