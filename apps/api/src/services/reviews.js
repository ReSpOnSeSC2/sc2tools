"use strict";

const crypto = require("crypto");
const { COLLECTIONS, REVIEWS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");
const {
  cleanText,
  cleanDisplayName,
  containsBlockedTerm,
} = require("../util/contentFilter");
const { MASTERS_BAND_ID, bandFromId } = require("../util/leagueBands");
const {
  buildGameSnapshot,
  askerLabel,
  reviewMacroBreakdown,
  reviewBuildOrder,
  reviewPlayback,
  reviewPlaybackManifest,
  normalizeRace,
} = require("./reviewRedaction");
const { publicVerification } = require("./reviewerReputation");

const ID_RE = /^[A-Za-z0-9_-]{16}$/;
const ACTIVE_STATUSES = Object.freeze(["open", "answered"]);
const HOT_EPOCH_SEC = Date.UTC(2026, 0, 1) / 1000;
// Reddit-style: every 12.5 h of recency is worth one order of magnitude
// of engagement, so the score never needs a decay sweep.
const HOT_TIME_SCALE_SEC = 45_000;
const PLAYBACK_HOT_BONUS = 0.5;
const PLAYBACK_TOP_BONUS = 2;
const URL_RE = /(?:https?:\/\/|www\.)\S+/gi;
const SNIPPET_MAX = 140;
const DIGEST_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Ledger kinds → materialised reviewer counter. */
const KARMA_COUNTER = Object.freeze({
  helpful: "helpful",
  best: "best",
  upvote: "upvotes",
  removed: "removed",
});

/**
 * @typedef {{userId: string | null, isAdmin?: boolean, source?: string}} Viewer
 * @typedef {Record<string, any>} Doc
 */

/**
 * ReviewsService — the Replay Review Exchange (docs/reviews.md).
 *
 * A review request freezes a redacted snapshot of one of the asker's
 * games (reviewRedaction.buildGameSnapshot) and grants public, read-only
 * access to THAT game's analysis while it is open/answered — the "scoped
 * grant". Nothing else of the owner's is ever reachable through it: every
 * heavy read goes through ``replayLibrary.getDetail(ownerId, gameId)``
 * with the ids stored server-side on the request, and every response is
 * rebuilt from an allow-list.
 */
class ReviewsService {
  /**
   * @param {import('../db/connect').DbContext} db
   * @param {{
   *   replayLibrary: {getDetail(userId: string, gameId: string): Promise<{game: Doc, sourceGame: Doc} | null>},
   *   perGame: {macroBreakdown(userId: string, gameId: string): Promise<any>, buildOrder(userId: string, gameId: string): Promise<any>, mapPlayback(userId: string, gameId: string): Promise<any>},
   *   playbackArtifacts?: {getManifest(userId: string, gameId: string): Promise<any>, getSegment(userId: string, gameId: string, artifactId: string, index: number): Promise<Buffer>} | null,
   *   reputation: import('./reviewerReputation').ReviewerReputationService,
   *   notifications: import('./notifications').NotificationsService,
   *   community?: {report(userId: string, input: {targetType: string, targetId: string, reason: string, note?: string}): Promise<{alreadyReported: boolean}>},
   *   now?: () => number,
   *   logger?: import('pino').Logger,
   * }} deps
   */
  constructor(db, deps) {
    this.db = db;
    this.replayLibrary = deps.replayLibrary;
    this.perGame = deps.perGame;
    this.playbackArtifacts = deps.playbackArtifacts || null;
    this.reputation = deps.reputation;
    this.notifications = deps.notifications;
    this.community = deps.community || null;
    this.now = deps.now || (() => Date.now());
    this.logger = deps.logger || null;
  }

  // ── Requests ────────────────────────────────────────────────────

  /**
   * Post one of the caller's own games for review.
   *
   * @param {string} userId
   * @param {Doc} input validated by validation/review.js ``create``
   */
  async create(userId, input) {
    const question = cleanText(input.question, { multiline: true });
    if (question.length < REVIEWS.QUESTION_MIN || question.length > REVIEWS.QUESTION_MAX) {
      throw reviewError(400, "invalid_question", `Your question must be ${REVIEWS.QUESTION_MIN}–${REVIEWS.QUESTION_MAX} characters.`);
    }
    if (containsBlockedTerm(question)) {
      throw reviewError(400, "content_rejected", "Your question contains language that isn't allowed.");
    }
    const gameId = String(input.gameId);
    const detail = await this.replayLibrary.getDetail(userId, gameId);
    if (!detail) throw reviewError(404, "game_not_found", "That game isn't in your synced history.");
    const game = await this.db.games.findOne(
      { userId, gameId },
      {
        projection: {
          _id: 0, gameId: 1, date: 1, result: 1, map: 1, myRace: 1, myMmr: 1, myBuild: 1,
          durationSec: 1, macroScore: 1, matchFormat: 1, playerCount: 1, playbackArtifact: 1,
          "opponent.race": 1, "opponent.mmr": 1, "opponent.strategy": 1,
        },
      },
    );
    if (!game) throw reviewError(404, "game_not_found", "That game isn't in your synced history.");
    // Canonical 1v1 clause (coaching.oneVsOneGameClause); legacy rows
    // with neither field are accepted and still need a P/T/Z matchup.
    const oneVsOne = game.matchFormat === "1v1"
      || (!game.matchFormat && (Number(game.playerCount) === 2 || game.playerCount === undefined || game.playerCount === null));
    const snapshot = buildGameSnapshot(game);
    if (!oneVsOne || !snapshot.matchup) {
      throw reviewError(400, "review_not_1v1", "Only 1v1 games with a known matchup can be posted for review.");
    }
    const macro = await safeRead(() => this.perGame.macroBreakdown(userId, gameId));
    if (!macro || macro.ok !== true) {
      throw reviewError(400, "review_needs_macro", "This game has no macro breakdown yet. Resync it with the desktop agent, then try again.");
    }
    const playbackMode = await this._detectPlayback(userId, gameId, game);

    const timeRange = normaliseTimeRange(input.timeRange, snapshot.durationSec);
    if (input.timeRange && !timeRange) {
      throw reviewError(400, "invalid_time_range", "The time range must sit inside the game.");
    }
    const askerDisplay = input.askerDisplay === "named" ? "named" : "anonymous";
    let askerName = null;
    if (askerDisplay === "named") {
      askerName = await this._askerDisplayName(userId);
      if (!askerName) {
        throw reviewError(400, "display_name_required", "Set a display name in Settings to post under your name, or post anonymously.");
      }
    }

    const now = new Date(this.now());
    const [openCount, recentCount] = await Promise.all([
      this.db.reviewRequests.countDocuments({ userId, status: { $in: [...ACTIVE_STATUSES] } }),
      this.db.reviewRequests.countDocuments({ userId, createdAt: { $gte: new Date(now.getTime() - DAY_MS) } }),
    ]);
    if (openCount >= REVIEWS.MAX_OPEN_REQUESTS) {
      throw reviewError(429, "review_open_limit", `You can have at most ${REVIEWS.MAX_OPEN_REQUESTS} open review requests. Close one to post another.`);
    }
    if (recentCount >= REVIEWS.MAX_NEW_REQUESTS_PER_DAY) {
      throw reviewError(429, "review_daily_limit", `You can post at most ${REVIEWS.MAX_NEW_REQUESTS_PER_DAY} review requests per day.`);
    }

    const id = newId();
    /** @type {Doc} */
    const doc = {
      _id: id,
      userId,
      gameId,
      activeKey: activeKey(userId, gameId),
      question,
      tags: Array.isArray(input.tags) ? [...new Set(input.tags)] : [],
      timeRange,
      desiredLevel: input.desiredLevel || "anyone",
      visibility: input.visibility === "link" ? "link" : "public",
      askerDisplay,
      askerName,
      ...snapshot,
      hasPlayback: playbackMode !== "none",
      playbackMode,
      status: "open",
      hidden: false,
      reportCount: 0,
      reviewCount: 0,
      commentCount: 0,
      helpfulCount: 0,
      upvoteTotal: 0,
      bestCommentId: null,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    };
    Object.assign(doc, derivedRanking(doc));
    try {
      await this.db.reviewRequests.insertOne(stampVersion(doc, COLLECTIONS.REVIEW_REQUESTS));
    } catch (err) {
      if (isDuplicateKey(err)) {
        const existing = await this.db.reviewRequests.findOne(
          { activeKey: activeKey(userId, gameId) },
          { projection: { _id: 1 } },
        );
        throw reviewError(409, "review_exists", "This game already has an open review request.", {
          id: existing ? existing._id : null,
        });
      }
      throw err;
    }
    return { id, url: `/reviews/${id}` };
  }

  /**
   * Which playback the review page can load: segmented engine recording,
   * the legacy inline payload, or none. A pointer on the slim row is the
   * cheap signal for segments; the inline blob is only probed at posting.
   *
   * @param {string} userId
   * @param {string} gameId
   * @param {Doc} game slim row (with ``playbackArtifact`` when projected)
   * @returns {Promise<"segmented"|"inline"|"none">}
   */
  async _detectPlayback(userId, gameId, game) {
    if (this.playbackArtifacts && game.playbackArtifact && game.playbackArtifact.artifactId) {
      return "segmented";
    }
    const inline = await safeRead(() => this.perGame.mapPlayback(userId, gameId));
    return inline && inline.ok === true ? "inline" : "none";
  }

  /** @param {string} userId */
  async _askerDisplayName(userId) {
    const user = await this.db.users.findOne(
      { userId },
      { projection: { _id: 0, displayName: 1 } },
    );
    // Deliberately NOT the BattleTag fallback other surfaces use: a
    // BattleTag name is the in-game name, which together with the map
    // and result could locate the game (and so the opponent) in public
    // ladder history.
    const name = typeof user?.displayName === "string" ? cleanDisplayName(user.displayName).slice(0, 60) : "";
    if (!name || containsBlockedTerm(name)) return null;
    return name;
  }

  /**
   * @param {string} requestId
   * @returns {Promise<Doc | null>}
   */
  async getDoc(requestId) {
    if (!ID_RE.test(String(requestId || ""))) return null;
    return this.db.reviewRequests.findOne({ _id: requestId });
  }

  /**
   * Requests readable by this viewer: removed requests are gone for
   * everyone but admins; moderation-hidden ones stay visible to the asker
   * (with a banner) and admins while the report is pending.
   *
   * @param {string} requestId
   * @param {Viewer} viewer
   */
  async _readable(requestId, viewer) {
    const doc = await this.getDoc(requestId);
    if (!doc) throw notFound();
    const isAsker = Boolean(viewer.userId && viewer.userId === doc.userId);
    if (doc.status === "removed" && !viewer.isAdmin) throw notFound();
    if (doc.hidden && !isAsker && !viewer.isAdmin) throw notFound();
    return { doc, isAsker };
  }

  /**
   * The whole review page: request, thread and viewer capabilities.
   *
   * @param {string} requestId
   * @param {Viewer} viewer
   */
  async page(requestId, viewer) {
    const { doc, isAsker } = await this._readable(requestId, viewer);
    const [comments, blockedIds, votes] = await Promise.all([
      this.db.reviewComments
        .find({ requestId: doc._id })
        .sort({ createdAt: 1, _id: 1 })
        .limit(REVIEWS.MAX_COMMENTS_PER_REQUEST)
        .toArray(),
      viewer.userId ? this._blockedBy(viewer.userId) : Promise.resolve(new Set()),
      viewer.userId
        ? this.db.reviewKarmaEvents.distinct("commentId", {
          requestId: doc._id,
          kind: "upvote",
          actorId: viewer.userId,
        })
        : Promise.resolve([]),
    ]);
    const authorIds = comments.filter((c) => !c.isAskerComment).map((c) => c.authorId).filter(Boolean);
    const profiles = await this.reputation.publicProfiles(authorIds, { viewerId: viewer.userId });
    const thread = serializeThread(comments, {
      doc,
      viewer,
      blockedIds,
      upvoted: new Set(votes),
      profiles,
      now: this.now(),
    });
    return {
      request: requestView(doc, { viewer, isAsker }),
      comments: thread,
      viewer: await this._viewerCapabilities(doc, viewer, isAsker),
      seo: seoView(doc, comments),
    };
  }

  /**
   * @param {Doc} doc
   * @param {Viewer} viewer
   * @param {boolean} isAsker
   */
  async _viewerCapabilities(doc, viewer, isAsker) {
    if (!viewer.userId) {
      return { signedIn: false, isAsker: false, canComment: false, reason: "sign_in", isAdmin: false };
    }
    const base = { signedIn: true, isAsker, isAdmin: Boolean(viewer.isAdmin) };
    if (!ACTIVE_STATUSES.includes(doc.status)) return { ...base, canComment: false, reason: "closed" };
    if (viewer.source && viewer.source !== "clerk") return { ...base, canComment: false, reason: "browser_session_required" };
    if (isAsker) return { ...base, canComment: true, canReview: false, reason: null };
    const blocked = await this.db.reviewBlocks.findOne(
      { blockerId: doc.userId, blockedId: viewer.userId },
      { projection: { _id: 1 } },
    );
    if (blocked) return { ...base, canComment: false, reason: "blocked" };
    const games = await this.reputation.syncedGameCount(viewer.userId);
    if (games < REVIEWS.MIN_SYNCED_GAMES_TO_COMMENT) {
      return { ...base, canComment: false, reason: "min_games", syncedGames: games, requiredGames: REVIEWS.MIN_SYNCED_GAMES_TO_COMMENT };
    }
    const verification = await this.reputation.verification(viewer.userId);
    const levelOk = meetsDesiredLevel(doc, verification);
    return {
      ...base,
      canComment: true,
      // Replies are open to every eligible reviewer; a top-level review
      // additionally needs the asker's desired level.
      canReview: levelOk,
      reason: levelOk ? null : "level_required",
      verified: publicVerification(verification),
    };
  }

  /**
   * Public board. Deliberately NOT personalised so the response is
   * cacheable (Cache-Control public, s-maxage=60 at the route).
   *
   * @param {{sort?: unknown, matchup?: unknown, band?: unknown, tag?: unknown, unanswered?: unknown, cursor?: unknown, limit?: unknown}} query
   */
  async board(query) {
    const sort = query.sort === "new" || query.sort === "top" ? query.sort : "hot";
    const limit = clampInt(query.limit, 1, REVIEWS.BOARD_PAGE_MAX, REVIEWS.BOARD_PAGE_DEFAULT);
    /** @type {Doc} */
    const filter = { listed: true };
    if (typeof query.matchup === "string" && /^[PTZ]v[PTZ]$/.test(query.matchup)) filter.matchup = query.matchup;
    const band = bandFromId(query.band);
    if (band && query.band !== undefined && query.band !== "") filter["askerBand.id"] = band.id;
    if (typeof query.tag === "string" && /^[a-z_]{2,32}$/.test(query.tag)) filter.tags = query.tag;
    if (query.unanswered === "1" || query.unanswered === "true" || query.unanswered === true) {
      filter.reviewCount = 0;
    }
    const field = sort === "new" ? "createdAt" : sort === "top" ? "topScore" : "hotScore";
    const cursor = decodeCursor(query.cursor);
    if (cursor && cursor.s === sort) {
      const value = sort === "new" ? new Date(cursor.v) : Number(cursor.v);
      filter.$or = [
        { [field]: { $lt: value } },
        { [field]: value, _id: { $lt: String(cursor.id) } },
      ];
    }
    const rows = await this.db.reviewRequests
      .find(filter)
      .sort({ [field]: -1, _id: -1 })
      .limit(limit + 1)
      .toArray();
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((doc) => cardView(doc)),
      nextCursor: rows.length > limit && last
        ? encodeCursor({ s: sort, v: sort === "new" ? new Date(last.createdAt).toISOString() : last[field], id: last._id })
        : null,
    };
  }

  /**
   * "Requests you can help with": the reviewer's verified race's
   * matchups, at or below their verified band, that they are allowed to
   * review. Unanswered first.
   *
   * @param {string} userId
   */
  async forReviewer(userId) {
    const verification = await this.reputation.verification(userId);
    const verified = publicVerification(verification);
    if (!verified || !verified.race || verified.race === "Random") {
      return { verified: null, items: [], reason: "unverified" };
    }
    const letter = verified.race.charAt(0);
    const matchups = ["P", "T", "Z"].map((opp) => `${letter}v${opp}`);
    const rows = await this.db.reviewRequests
      .find({
        listed: true,
        status: "open",
        userId: { $ne: userId },
        matchup: { $in: matchups },
        $or: [{ askerBand: null }, { "askerBand.id": { $lte: verified.band.id } }],
      })
      .sort({ reviewCount: 1, createdAt: -1 })
      .limit(40)
      .toArray();
    const blockedBy = new Set(
      (await this.db.reviewBlocks.find({ blockedId: userId }, { projection: { _id: 0, blockerId: 1 } }).toArray())
        .map((b) => b.blockerId),
    );
    const items = rows
      .filter((doc) => !blockedBy.has(doc.userId) && meetsDesiredLevel(doc, verification))
      .slice(0, 12)
      .map((doc) => cardView(doc));
    return { verified, items, reason: null };
  }

  /**
   * The caller's own requests and the reviews they have written.
   *
   * @param {string} userId
   */
  async mine(userId) {
    const [asked, authored] = await Promise.all([
      this.db.reviewRequests
        .find({ userId, status: { $ne: "removed" } })
        .sort({ createdAt: -1 })
        .limit(50)
        .toArray(),
      this.db.reviewComments
        .find({ authorId: userId, parentId: null, isAskerComment: { $ne: true }, status: { $in: ["visible", "hidden"] } })
        .sort({ createdAt: -1 })
        .limit(50)
        .toArray(),
    ]);
    const requestIds = [...new Set(authored.map((c) => c.requestId))];
    const requests = requestIds.length
      ? await this.db.reviewRequests.find({ _id: { $in: requestIds }, status: { $ne: "removed" } }).toArray()
      : [];
    const byId = new Map(requests.map((r) => [r._id, r]));
    return {
      asked: asked.map((doc) => ({ ...cardView(doc), visibility: doc.visibility, isOwn: true })),
      answered: authored.flatMap((comment) => {
        const doc = byId.get(comment.requestId);
        if (!doc || (doc.hidden && doc.userId !== userId)) return [];
        return [{
          request: cardView(doc),
          commentId: comment._id,
          snippet: snippet(comment.body),
          helpful: comment.helpful === true,
          best: comment.best === true,
          upvotes: Number(comment.upvotes) || 0,
          createdAt: iso(comment.createdAt),
        }];
      }),
    };
  }

  /**
   * Close a request: stops new comments AND revokes the scoped grant
   * (the replay analysis stops being served). The thread text stays.
   *
   * @param {string} requestId
   * @param {Viewer} viewer
   * @param {{reason?: string}} [opts]
   */
  async close(requestId, viewer, opts = {}) {
    const doc = await this.getDoc(requestId);
    if (!doc || doc.status === "removed") throw notFound();
    if (doc.userId !== viewer.userId && !viewer.isAdmin) {
      throw reviewError(403, "forbidden", "Only the asker can close this request.");
    }
    if (doc.status === "closed") return { status: "closed" };
    await this._setClosed(doc._id, opts.reason || (doc.userId === viewer.userId ? "asker" : "moderator"));
    return { status: "closed" };
  }

  /**
   * @param {string} requestId
   * @param {string} reason
   */
  async _setClosed(requestId, reason) {
    const now = new Date(this.now());
    await this.db.reviewRequests.updateOne(
      { _id: requestId, status: { $in: [...ACTIVE_STATUSES] } },
      {
        $set: { status: "closed", closedReason: reason, closedAt: now, updatedAt: now, listed: false, indexable: false },
        $unset: { activeKey: "" },
      },
    );
  }

  /**
   * Close every active request whose game no longer exists (single-game
   * delete, history wipe). Called by GDPR wipe and lazily by the grant.
   *
   * @param {string} userId
   */
  async closeForMissingGames(userId) {
    const active = await this.db.reviewRequests
      .find({ userId, status: { $in: [...ACTIVE_STATUSES] } }, { projection: { _id: 1, gameId: 1 } })
      .toArray();
    let closed = 0;
    for (const row of active) {
      const exists = await this.db.games.findOne({ userId, gameId: row.gameId }, { projection: { _id: 1 } });
      if (!exists) {
        await this._setClosed(row._id, "game_unavailable");
        closed += 1;
      }
    }
    return closed;
  }

  // ── Scoped grant ────────────────────────────────────────────────

  /**
   * An open or answered request grants read access to THAT game's
   * analysis and nothing else of the owner's. Closed/removed/hidden
   * requests revoke it; a game deleted by its owner closes the request.
   *
   * @param {string} requestId
   * @returns {Promise<{doc: Doc, ownerId: string, gameId: string}>}
   */
  async grant(requestId) {
    const doc = await this.getDoc(requestId);
    if (!doc || doc.status === "removed" || doc.hidden) throw notFound();
    if (!ACTIVE_STATUSES.includes(doc.status)) {
      throw reviewError(410, "review_closed", "This review request is closed, so its replay is no longer shared.");
    }
    const detail = await this.replayLibrary.getDetail(doc.userId, doc.gameId);
    if (!detail) {
      await this._setClosed(doc._id, "game_unavailable");
      throw reviewError(410, "review_game_unavailable", "The asker removed this game, so the review request was closed.");
    }
    return { doc, ownerId: doc.userId, gameId: doc.gameId };
  }

  /** @param {string} requestId */
  async analysis(requestId) {
    const { doc, ownerId, gameId } = await this.grant(requestId);
    const [macro, build, slim] = await Promise.all([
      safeRead(() => this.perGame.macroBreakdown(ownerId, gameId)),
      safeRead(() => this.perGame.buildOrder(ownerId, gameId)),
      this.db.games.findOne({ userId: ownerId, gameId }, { projection: { _id: 0, playbackArtifact: 1 } }),
    ]);
    let playbackMode = doc.playbackMode || "none";
    if (this.playbackArtifacts && slim?.playbackArtifact?.artifactId) playbackMode = "segmented";
    else if (playbackMode === "segmented") playbackMode = "none";
    if (playbackMode !== doc.playbackMode) {
      await this.db.reviewRequests.updateOne(
        { _id: doc._id },
        { $set: { playbackMode, hasPlayback: playbackMode !== "none" } },
      );
    }
    return {
      requestId: doc._id,
      game: {
        matchup: doc.matchup,
        myRace: doc.myRace,
        oppRace: doc.oppRace,
        map: doc.map,
        result: doc.result,
        durationSec: doc.durationSec,
        askerLabel: askerLabel({ mode: doc.askerDisplay, name: doc.askerName, race: doc.myRace }),
        opponentLabel: doc.opponentLabel,
        myBuild: doc.myBuild,
        oppStrategy: doc.oppStrategy,
      },
      macroBreakdown: reviewMacroBreakdown(macro),
      buildOrder: reviewBuildOrder(build, { opponentLabel: doc.opponentLabel }),
      playback: { mode: playbackMode },
    };
  }

  /** @param {string} requestId */
  async playback(requestId) {
    const { ownerId, gameId } = await this.grant(requestId);
    const out = reviewPlayback(await safeRead(() => this.perGame.mapPlayback(ownerId, gameId)));
    if (!out) throw reviewError(404, "playback_not_computed", "This replay has no map playback.");
    return out;
  }

  /** @param {string} requestId */
  async playbackManifest(requestId) {
    const { ownerId, gameId } = await this.grant(requestId);
    if (!this.playbackArtifacts) throw reviewError(404, "playback_artifact_not_found", "No recorded playback.");
    const out = reviewPlaybackManifest(await this.playbackArtifacts.getManifest(ownerId, gameId));
    if (!out) throw reviewError(404, "playback_artifact_not_found", "No recorded playback.");
    return out;
  }

  /**
   * Segment bytes are integrity-hashed by the agent, so they cannot be
   * rewritten. Instead they are parsed and rejected (fail closed) if an
   * identity-shaped key ever appears in one.
   *
   * @param {string} requestId
   * @param {string} artifactId
   * @param {number} index
   * @returns {Promise<Buffer>}
   */
  async playbackSegment(requestId, artifactId, index) {
    const { ownerId, gameId } = await this.grant(requestId);
    if (!this.playbackArtifacts) throw reviewError(404, "playback_artifact_not_found", "No recorded playback.");
    const bytes = await this.playbackArtifacts.getSegment(ownerId, gameId, artifactId, index);
    if (segmentCarriesIdentity(bytes)) {
      if (this.logger) this.logger.warn({ requestId }, "review_segment_identity_blocked");
      throw reviewError(404, "playback_artifact_not_found", "No recorded playback.");
    }
    return bytes;
  }

  // ── Comments ────────────────────────────────────────────────────

  /**
   * @param {string} requestId
   * @param {Viewer & {userId: string}} viewer
   * @param {Doc} input validated by validation/review.js ``comment``
   */
  async addComment(requestId, viewer, input) {
    const { doc, isAsker } = await this._readable(requestId, viewer);
    if (!ACTIVE_STATUSES.includes(doc.status)) {
      throw reviewError(409, "review_closed", "This review request is closed to new comments.");
    }
    if (doc.hidden) throw reviewError(409, "review_hidden", "This request is hidden pending moderator review.");
    const userId = viewer.userId;
    const parentId = input.parentId || null;
    /** @type {Doc | null} */
    let parent = null;
    if (parentId) {
      parent = await this.db.reviewComments.findOne({ _id: parentId, requestId: doc._id });
      if (!parent || parent.parentId) {
        throw reviewError(400, "invalid_parent", "Replies go one level deep — reply to a top-level review.");
      }
      if (parent.status !== "visible") throw reviewError(409, "parent_unavailable", "That review is no longer available.");
    }
    if (!isAsker) {
      const blocked = await this.db.reviewBlocks.findOne(
        { blockerId: doc.userId, blockedId: userId },
        { projection: { _id: 1 } },
      );
      if (blocked) throw reviewError(403, "review_blocked", "The asker has blocked you from commenting on their requests.");
      const games = await this.reputation.syncedGameCount(userId);
      if (games < REVIEWS.MIN_SYNCED_GAMES_TO_COMMENT) {
        throw reviewError(403, "review_min_games", `Sync at least ${REVIEWS.MIN_SYNCED_GAMES_TO_COMMENT} games with the desktop agent to review replays.`, {
          syncedGames: games,
          requiredGames: REVIEWS.MIN_SYNCED_GAMES_TO_COMMENT,
        });
      }
      if (!parent) {
        const verification = await this.reputation.verification(userId);
        if (!meetsDesiredLevel(doc, verification)) {
          throw reviewError(403, "review_level_required", levelMessage(doc));
        }
      }
    }
    await this._enforceCommentRate(userId);
    const total = await this.db.reviewComments.countDocuments({ requestId: doc._id });
    if (total >= REVIEWS.MAX_COMMENTS_PER_REQUEST) {
      throw reviewError(409, "review_thread_full", "This thread has reached its comment limit.");
    }
    const fields = this._commentFields(input, doc);
    const now = new Date(this.now());
    const comment = stampVersion(
      {
        _id: newId(),
        requestId: doc._id,
        authorId: userId,
        parentId,
        isAskerComment: isAsker,
        ...fields,
        upvotes: 0,
        upvoteKarma: 0,
        helpful: false,
        best: false,
        reportCount: 0,
        status: "visible",
        createdAt: now,
        editedAt: null,
      },
      COLLECTIONS.REVIEW_COMMENTS,
    );
    await this.db.reviewComments.insertOne(comment);
    if (!parent && !isAsker) await this.reputation.applyStats(userId, { reviews: 1 });
    await this._refresh(doc._id, { activity: true });
    await this._notifyNewComment(doc, comment, parent, isAsker);
    return { id: comment._id };
  }

  /**
   * @param {Doc} input
   * @param {Doc} doc
   */
  _commentFields(input, doc) {
    const body = cleanText(input.body, { multiline: true });
    if (body.length < REVIEWS.COMMENT_MIN || body.length > REVIEWS.COMMENT_MAX) {
      throw reviewError(400, "invalid_comment", `Comments must be ${REVIEWS.COMMENT_MIN}–${REVIEWS.COMMENT_MAX} characters.`);
    }
    if (containsBlockedTerm(body)) {
      throw reviewError(400, "content_rejected", "Your comment contains language that isn't allowed.");
    }
    if ((body.match(URL_RE) || []).length > REVIEWS.COMMENT_MAX_LINKS) {
      throw reviewError(400, "too_many_links", `Comments may contain at most ${REVIEWS.COMMENT_MAX_LINKS} links.`);
    }
    const duration = typeof doc.durationSec === "number" ? doc.durationSec : 86_400;
    const gameTimeSec = roundTenth(input.gameTimeSec);
    if (!(gameTimeSec >= 0) || gameTimeSec > duration + 1) {
      throw reviewError(400, "invalid_time", "That moment is outside the game.");
    }
    let endTimeSec = null;
    if (input.endTimeSec !== undefined && input.endTimeSec !== null) {
      endTimeSec = roundTenth(input.endTimeSec);
      if (!(endTimeSec > gameTimeSec) || endTimeSec > duration + 1 || endTimeSec - gameTimeSec > REVIEWS.MAX_RANGE_SEC) {
        throw reviewError(400, "invalid_range", `A range must end after it starts and span at most ${Math.round(REVIEWS.MAX_RANGE_SEC / 60)} minutes.`);
      }
    }
    const mapPoint = input.mapPoint && Number.isFinite(input.mapPoint.x) && Number.isFinite(input.mapPoint.y)
      ? { x: roundTenth(input.mapPoint.x), y: roundTenth(input.mapPoint.y) }
      : null;
    return { body, gameTimeSec, endTimeSec, mapPoint };
  }

  /** @param {string} userId */
  async _enforceCommentRate(userId) {
    const now = this.now();
    const [hour, day] = await Promise.all([
      this.db.reviewComments.countDocuments(
        { authorId: userId, createdAt: { $gte: new Date(now - HOUR_MS) } },
        { limit: REVIEWS.COMMENTS_PER_HOUR },
      ),
      this.db.reviewComments.countDocuments(
        { authorId: userId, createdAt: { $gte: new Date(now - DAY_MS) } },
        { limit: REVIEWS.COMMENTS_PER_DAY },
      ),
    ]);
    if (hour >= REVIEWS.COMMENTS_PER_HOUR) {
      throw reviewError(429, "rate_limited", `You can post ${REVIEWS.COMMENTS_PER_HOUR} comments per hour. Try again later.`);
    }
    if (day >= REVIEWS.COMMENTS_PER_DAY) {
      throw reviewError(429, "rate_limited", `You can post ${REVIEWS.COMMENTS_PER_DAY} comments per day. Try again tomorrow.`);
    }
  }

  /**
   * @param {Doc} doc
   * @param {Doc} comment
   * @param {Doc | null} parent
   * @param {boolean} isAsker
   */
  async _notifyNewComment(doc, comment, parent, isAsker) {
    const href = `/reviews/${doc._id}#comment-${comment._id}`;
    const question = snippet(doc.question, 90);
    try {
      if (!parent && !isAsker) {
        await this.notifications.notify(doc.userId, {
          kind: "review.new",
          groupKey: `review-new:${doc._id}`,
          title: "New review on your replay",
          body: question,
          href,
          render: (count) => ({
            title: count === 1 ? "New review on your replay" : `${count} new reviews on your replay`,
            body: question,
          }),
        });
      }
      if (parent && parent.authorId && parent.authorId !== comment.authorId) {
        await this.notifications.notify(parent.authorId, {
          kind: "review.reply",
          groupKey: `review-reply:${parent._id}`,
          title: "New reply to your review",
          body: question,
          href,
          render: (count) => ({
            title: count === 1 ? "New reply to your review" : `${count} new replies to your review`,
            body: question,
          }),
        });
      }
    } catch (err) {
      if (this.logger) this.logger.warn({ err }, "review_notification_failed");
    }
  }

  /**
   * Edit your own comment within the edit window.
   *
   * @param {string} requestId
   * @param {string} commentId
   * @param {Viewer & {userId: string}} viewer
   * @param {Doc} input validated by ``commentEdit``
   */
  async editComment(requestId, commentId, viewer, input) {
    const { doc } = await this._readable(requestId, viewer);
    const comment = await this.db.reviewComments.findOne({ _id: commentId, requestId: doc._id });
    if (!comment || (comment.status !== "visible" && comment.status !== "hidden")) throw notFound();
    if (comment.authorId !== viewer.userId) throw reviewError(403, "forbidden", "You can only edit your own comments.");
    if (this.now() - new Date(comment.createdAt).getTime() > REVIEWS.EDIT_WINDOW_MS) {
      throw reviewError(403, "edit_window_closed", "Comments can only be edited for 15 minutes after posting.");
    }
    const fields = this._commentFields(
      {
        body: input.body,
        gameTimeSec: input.gameTimeSec ?? comment.gameTimeSec,
        endTimeSec: input.endTimeSec !== undefined ? input.endTimeSec : comment.endTimeSec,
        mapPoint: input.mapPoint !== undefined ? input.mapPoint : comment.mapPoint,
      },
      doc,
    );
    await this.db.reviewComments.updateOne(
      { _id: comment._id },
      { $set: { ...fields, editedAt: new Date(this.now()) } },
    );
    return { id: comment._id };
  }

  /**
   * Delete your own comment (admins may delete any). A comment with
   * replies becomes a "[deleted]" placeholder so the thread keeps its
   * shape; otherwise it is removed outright. Either way the karma it
   * earned is revoked.
   *
   * @param {string} requestId
   * @param {string} commentId
   * @param {Viewer & {userId: string}} viewer
   */
  async deleteComment(requestId, commentId, viewer) {
    const doc = await this.getDoc(requestId);
    if (!doc) throw notFound();
    const comment = await this.db.reviewComments.findOne({ _id: commentId, requestId: doc._id });
    if (!comment || comment.status === "deleted") throw notFound();
    if (comment.authorId !== viewer.userId && !viewer.isAdmin) {
      throw reviewError(403, "forbidden", "You can only delete your own comments.");
    }
    await this._revokeCommentKarma(comment, doc);
    const replies = comment.parentId
      ? 0
      : await this.db.reviewComments.countDocuments({ parentId: comment._id }, { limit: 1 });
    if (replies > 0) {
      await this.db.reviewComments.updateOne(
        { _id: comment._id },
        {
          $set: {
            status: "deleted",
            body: "",
            mapPoint: null,
            endTimeSec: null,
            helpful: false,
            best: false,
            deletedAt: new Date(this.now()),
          },
        },
      );
    } else {
      await this.db.reviewComments.deleteOne({ _id: comment._id });
    }
    if (!comment.parentId && !comment.isAskerComment && comment.authorId && comment.status === "visible") {
      await this.reputation.applyStats(comment.authorId, { reviews: -1 });
    }
    await this._refresh(doc._id, {});
    return { deleted: replies > 0 ? "soft" : "hard" };
  }

  // ── Helpful / best / upvote (karma ledger) ──────────────────────

  /**
   * @param {string} requestId
   * @param {string} commentId
   * @param {Viewer & {userId: string}} viewer
   */
  async _actionTarget(requestId, commentId, viewer) {
    const { doc, isAsker } = await this._readable(requestId, viewer);
    const comment = await this.db.reviewComments.findOne({ _id: commentId, requestId: doc._id });
    if (!comment || comment.status !== "visible") throw notFound();
    return { doc, comment, isAsker };
  }

  /**
   * Asker marks a reviewer's comment helpful (+5), or takes it back.
   *
   * @param {string} requestId
   * @param {string} commentId
   * @param {Viewer & {userId: string}} viewer
   * @param {boolean} value
   */
  async setHelpful(requestId, commentId, viewer, value) {
    const { doc, comment, isAsker } = await this._actionTarget(requestId, commentId, viewer);
    if (!isAsker) throw reviewError(403, "forbidden", "Only the asker can mark comments helpful.");
    if (comment.isAskerComment || comment.authorId === doc.userId) {
      throw reviewError(400, "own_comment", "You can't mark your own comment helpful.");
    }
    if (value) {
      const awarded = await this._award(comment, doc, "helpful", viewer.userId, REVIEWS.KARMA_HELPFUL);
      if (awarded) {
        await this.db.reviewComments.updateOne({ _id: comment._id }, { $set: { helpful: true } });
        await this._notifyReviewer(comment, doc, "review.helpful", "Your review was marked helpful", `+${REVIEWS.KARMA_HELPFUL} karma`);
      }
    } else if (await this._revoke(comment, "helpful", viewer.userId)) {
      await this.db.reviewComments.updateOne({ _id: comment._id }, { $set: { helpful: false } });
    }
    await this._refresh(doc._id, { activity: value });
    return { helpful: value };
  }

  /**
   * Asker picks the one best review (+15). Choosing another moves it.
   *
   * @param {string} requestId
   * @param {string} commentId
   * @param {Viewer & {userId: string}} viewer
   * @param {boolean} value
   */
  async setBest(requestId, commentId, viewer, value) {
    const { doc, comment, isAsker } = await this._actionTarget(requestId, commentId, viewer);
    if (!isAsker) throw reviewError(403, "forbidden", "Only the asker can choose the best review.");
    if (comment.parentId || comment.isAskerComment || comment.authorId === doc.userId) {
      throw reviewError(400, "invalid_best", "Choose a top-level review written by someone else.");
    }
    if (!ACTIVE_STATUSES.includes(doc.status)) {
      throw reviewError(409, "review_closed", "This review request is closed.");
    }
    const previous = doc.bestCommentId || null;
    if (value) {
      if (previous === comment._id) return { best: true };
      const moved = await this.db.reviewRequests.updateOne(
        { _id: doc._id, bestCommentId: previous },
        { $set: { bestCommentId: comment._id, status: "answered", updatedAt: new Date(this.now()) } },
      );
      if (moved.matchedCount !== 1) throw reviewError(409, "conflict", "The best review changed in another tab. Reload and try again.");
      if (previous) {
        const old = await this.db.reviewComments.findOne({ _id: previous });
        if (old) {
          await this._revoke(old, "best", viewer.userId);
          await this.db.reviewComments.updateOne({ _id: old._id }, { $set: { best: false } });
        }
      }
      if (await this._award(comment, doc, "best", viewer.userId, REVIEWS.KARMA_BEST)) {
        await this._notifyReviewer(comment, doc, "review.best", "Your review was chosen as the best answer", `+${REVIEWS.KARMA_BEST} karma`);
      }
      await this.db.reviewComments.updateOne({ _id: comment._id }, { $set: { best: true } });
    } else {
      if (previous !== comment._id) return { best: false };
      const cleared = await this.db.reviewRequests.updateOne(
        { _id: doc._id, bestCommentId: comment._id },
        { $set: { bestCommentId: null, status: "open", updatedAt: new Date(this.now()) } },
      );
      if (cleared.matchedCount === 1) {
        await this._revoke(comment, "best", viewer.userId);
        await this.db.reviewComments.updateOne({ _id: comment._id }, { $set: { best: false } });
      }
    }
    await this._refresh(doc._id, { activity: value });
    return { best: value };
  }

  /**
   * Any signed-in user except the author upvotes (+1, at most +10 karma
   * per comment). No downvotes — use Report.
   *
   * @param {string} requestId
   * @param {string} commentId
   * @param {Viewer & {userId: string}} viewer
   * @param {boolean} value
   */
  async setUpvote(requestId, commentId, viewer, value) {
    const { doc, comment } = await this._actionTarget(requestId, commentId, viewer);
    if (comment.authorId === viewer.userId) throw reviewError(400, "own_comment", "You can't upvote your own comment.");
    if (value) {
      // Reserve a karma slot atomically before recording the vote, so two
      // simultaneous upvotes can never push a comment past the cap.
      const slot = await this.db.reviewComments.findOneAndUpdate(
        { _id: comment._id, upvoteKarma: { $lt: REVIEWS.KARMA_UPVOTE_CAP_PER_COMMENT } },
        { $inc: { upvoteKarma: 1 } },
      );
      const points = slot ? REVIEWS.KARMA_UPVOTE : 0;
      const recorded = await this._award(comment, doc, "upvote", viewer.userId, points);
      if (!recorded) {
        if (slot) await this.db.reviewComments.updateOne({ _id: comment._id }, { $inc: { upvoteKarma: -1 } });
      } else {
        await this.db.reviewComments.updateOne({ _id: comment._id }, { $inc: { upvotes: 1 } });
      }
    } else {
      const removed = await this.db.reviewKarmaEvents.findOneAndDelete({
        commentId: comment._id,
        kind: "upvote",
        actorId: viewer.userId,
      });
      if (removed) {
        await this.db.reviewComments.updateOne(
          { _id: comment._id },
          { $inc: { upvotes: -1, upvoteKarma: removed.points > 0 ? -1 : 0 } },
        );
        if (removed.userId) await this.reputation.applyStats(removed.userId, { karma: -removed.points, upvotes: -1 });
      }
    }
    await this._refresh(doc._id, {});
    const fresh = await this.db.reviewComments.findOne({ _id: comment._id }, { projection: { upvotes: 1 } });
    return { upvoted: value, upvotes: Number(fresh?.upvotes) || 0 };
  }

  /**
   * Record one ledger event and fold it into the recipient's totals.
   * Returns false (and changes nothing) when the unique
   * {commentId, kind, actorId} key says it already happened.
   *
   * @param {Doc} comment
   * @param {Doc} doc
   * @param {"helpful"|"best"|"upvote"|"removed"} kind
   * @param {string} actorId
   * @param {number} points
   */
  async _award(comment, doc, kind, actorId, points) {
    const recipient = comment.authorId || null;
    try {
      await this.db.reviewKarmaEvents.insertOne(
        stampVersion(
          {
            commentId: comment._id,
            requestId: doc._id,
            kind,
            actorId,
            userId: recipient,
            points,
            createdAt: new Date(this.now()),
          },
          COLLECTIONS.REVIEW_KARMA_EVENTS,
        ),
      );
    } catch (err) {
      if (isDuplicateKey(err)) return false;
      throw err;
    }
    if (recipient) await this.reputation.applyStats(recipient, { karma: points, [KARMA_COUNTER[kind]]: 1 });
    return true;
  }

  /**
   * @param {Doc} comment
   * @param {"helpful"|"best"|"upvote"|"removed"} kind
   * @param {string} actorId
   */
  async _revoke(comment, kind, actorId) {
    const removed = await this.db.reviewKarmaEvents.findOneAndDelete({ commentId: comment._id, kind, actorId });
    if (!removed) return false;
    if (removed.userId) {
      await this.reputation.applyStats(removed.userId, { karma: -removed.points, [KARMA_COUNTER[kind]]: -1 });
    }
    return true;
  }

  /**
   * Drop every POSITIVE event a comment earned (helpful, best, upvotes)
   * — used when it is deleted or removed by moderation. Clears the
   * request's best answer if it was this one.
   *
   * @param {Doc} comment
   * @param {Doc} doc
   */
  async _revokeCommentKarma(comment, doc) {
    const events = await this.db.reviewKarmaEvents
      .find({ commentId: comment._id, kind: { $in: ["helpful", "best", "upvote"] } })
      .toArray();
    for (const event of events) {
      const removed = await this.db.reviewKarmaEvents.findOneAndDelete({ _id: event._id });
      if (removed && removed.userId) {
        const kind = /** @type {"helpful"|"best"|"upvote"} */ (removed.kind);
        await this.reputation.applyStats(removed.userId, { karma: -removed.points, [KARMA_COUNTER[kind]]: -1 });
      }
    }
    if (doc.bestCommentId === comment._id) {
      await this.db.reviewRequests.updateOne(
        { _id: doc._id, bestCommentId: comment._id },
        { $set: { bestCommentId: null, status: doc.status === "answered" ? "open" : doc.status } },
      );
    }
    await this.db.reviewComments.updateOne(
      { _id: comment._id },
      { $set: { helpful: false, best: false, upvoteKarma: 0 } },
    );
  }

  /**
   * @param {Doc} comment
   * @param {Doc} doc
   * @param {string} kind
   * @param {string} title
   * @param {string} body
   */
  async _notifyReviewer(comment, doc, kind, title, body) {
    if (!comment.authorId) return;
    try {
      await this.notifications.notify(comment.authorId, {
        kind,
        title,
        body: `${body} · ${snippet(doc.question, 80)}`,
        href: `/reviews/${doc._id}#comment-${comment._id}`,
      });
    } catch (err) {
      if (this.logger) this.logger.warn({ err }, "review_notification_failed");
    }
  }

  /**
   * Recount a request's derived counters from its comments and refresh
   * its board ranking / indexability. Bounded by the per-thread cap, so
   * recounting beats maintaining drift-prone $inc counters.
   *
   * @param {string} requestId
   * @param {{activity?: boolean}} opts
   */
  async _refresh(requestId, opts) {
    const [agg] = await this.db.reviewComments
      .aggregate([
        { $match: { requestId } },
        {
          $group: {
            _id: null,
            commentCount: { $sum: { $cond: [{ $eq: ["$status", "visible"] }, 1, 0] } },
            reviewCount: {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ["$status", "visible"] }, { $eq: ["$parentId", null] }, { $ne: ["$isAskerComment", true] }] },
                  1,
                  0,
                ],
              },
            },
            helpfulCount: { $sum: { $cond: [{ $and: [{ $eq: ["$status", "visible"] }, { $eq: ["$helpful", true] }] }, 1, 0] } },
            upvoteTotal: { $sum: { $cond: [{ $eq: ["$status", "visible"] }, "$upvotes", 0] } },
          },
        },
      ])
      .toArray();
    const counts = {
      commentCount: agg?.commentCount || 0,
      reviewCount: agg?.reviewCount || 0,
      helpfulCount: agg?.helpfulCount || 0,
      upvoteTotal: agg?.upvoteTotal || 0,
    };
    const doc = await this.db.reviewRequests.findOne({ _id: requestId });
    if (!doc) return;
    const now = new Date(this.now());
    const merged = { ...doc, ...counts, ...(opts.activity ? { lastActivityAt: now } : {}) };
    await this.db.reviewRequests.updateOne(
      { _id: requestId },
      {
        $set: {
          ...counts,
          ...(opts.activity ? { lastActivityAt: now } : {}),
          updatedAt: now,
          ...derivedRanking(merged),
        },
      },
    );
  }

  // ── Reports, blocks, lessons ────────────────────────────────────

  /**
   * Report a request or a comment into the shared community moderation
   * queue (community_reports). Auto-hide happens there via the target
   * handlers registered by ``moderationTargets``.
   *
   * @param {string} requestId
   * @param {string | null} commentId
   * @param {Viewer & {userId: string}} viewer
   * @param {{reason: string, note?: string}} input
   */
  async report(requestId, commentId, viewer, input) {
    if (!this.community) throw reviewError(503, "moderation_unavailable", "Reporting is temporarily unavailable.");
    const { doc } = await this._readable(requestId, viewer);
    if (commentId) {
      const comment = await this.db.reviewComments.findOne({ _id: commentId, requestId: doc._id });
      if (!comment || comment.status === "deleted" || comment.status === "removed") throw notFound();
      if (comment.authorId === viewer.userId) throw reviewError(400, "own_comment", "You can't report your own comment.");
    } else if (doc.userId === viewer.userId) {
      throw reviewError(400, "own_request", "You can't report your own request.");
    }
    return this.community.report(viewer.userId, {
      targetType: commentId ? "review_comment" : "review_request",
      targetId: commentId || doc._id,
      reason: cleanText(input.reason).slice(0, 80),
      note: cleanText(input.note || "", { multiline: true }).slice(0, 1000),
    });
  }

  /**
   * Block a comment's author: their comments are hidden from you and
   * they can no longer comment on your requests. Internal user ids never
   * reach the client, so blocks are created from a comment.
   *
   * @param {string} requestId
   * @param {string} commentId
   * @param {Viewer & {userId: string}} viewer
   */
  async blockAuthor(requestId, commentId, viewer) {
    const doc = await this.getDoc(requestId);
    if (!doc) throw notFound();
    const comment = await this.db.reviewComments.findOne({ _id: commentId, requestId: doc._id });
    if (!comment || !comment.authorId) throw notFound();
    if (comment.authorId === viewer.userId) throw reviewError(400, "own_comment", "You can't block yourself.");
    const id = newId();
    try {
      await this.db.reviewBlocks.insertOne(
        stampVersion(
          { _id: id, blockerId: viewer.userId, blockedId: comment.authorId, createdAt: new Date(this.now()) },
          COLLECTIONS.REVIEW_BLOCKS,
        ),
      );
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
    }
    return { blocked: true };
  }

  /** @param {string} userId */
  async listBlocks(userId) {
    const rows = await this.db.reviewBlocks.find({ blockerId: userId }).sort({ createdAt: -1 }).limit(500).toArray();
    const profiles = await this.reputation.publicProfiles(rows.map((r) => r.blockedId));
    return {
      items: rows.map((row) => ({
        id: row._id,
        name: profiles.get(row.blockedId)?.name || "[deleted user]",
        createdAt: iso(row.createdAt),
      })),
    };
  }

  /**
   * @param {string} userId
   * @param {string} blockId
   */
  async unblock(userId, blockId) {
    const res = await this.db.reviewBlocks.deleteOne({ _id: String(blockId), blockerId: userId });
    if (res.deletedCount !== 1) throw notFound();
    return { unblocked: true };
  }

  /** @param {string} userId @returns {Promise<Set<string>>} */
  async _blockedBy(userId) {
    const rows = await this.db.reviewBlocks
      .find({ blockerId: userId }, { projection: { _id: 0, blockedId: 1 } })
      .toArray();
    return new Set(rows.map((r) => r.blockedId));
  }

  /**
   * "Book a lesson" for a viewer who is not yet the coach's student:
   * booking itself is attachment-gated in the Coaching Locker, so this
   * sends the coach an in-app lesson request they can act on there.
   *
   * @param {string} coachId
   * @param {Viewer & {userId: string}} viewer
   * @param {{note?: unknown, requestId?: unknown}} input
   */
  async requestLesson(coachId, viewer, input) {
    const coach = await this.reputation.coachById(String(coachId || ""));
    if (!coach || !coach.bookable) throw notFound();
    if (coach.userId === viewer.userId) throw reviewError(400, "own_coach", "That's you.");
    if (coach.studentUserIds.includes(viewer.userId)) {
      return { status: "student", href: "/coaching?view=schedule" };
    }
    const since = new Date(this.now() - DAY_MS);
    const sent = await this.db.notifications.countDocuments({
      kind: "review.lesson_request",
      senderId: viewer.userId,
      createdAt: { $gte: since },
    });
    if (sent >= REVIEWS.LESSON_REQUESTS_PER_DAY) {
      throw reviewError(429, "rate_limited", "You've sent the maximum number of lesson requests for today.");
    }
    const note = cleanText(typeof input.note === "string" ? input.note : "").slice(0, 300);
    if (note && containsBlockedTerm(note)) throw reviewError(400, "content_rejected", "Your note contains language that isn't allowed.");
    const profiles = await this.reputation.publicProfiles([viewer.userId]);
    const name = profiles.get(viewer.userId)?.name || "A player";
    const requestId = typeof input.requestId === "string" && ID_RE.test(input.requestId) ? input.requestId : null;
    const row = await this.notifications.notify(coach.userId, {
      kind: "review.lesson_request",
      title: `${name} would like a lesson`,
      body: note || "Sent from a replay review. Attach them in the Coaching Locker to let them book your published hours.",
      href: requestId ? `/reviews/${requestId}` : "/coaching",
    });
    if (row) await this.db.notifications.updateOne({ _id: row._id }, { $set: { senderId: viewer.userId } });
    return { status: "requested" };
  }

  // ── Moderation hooks (community_reports) ────────────────────────

  /**
   * Target handlers registered with CommunityService so review content
   * flows through the ONE existing moderation queue.
   */
  moderationTargets() {
    return {
      review_request: {
        exists: async (/** @type {string} */ id) => Boolean(await this.getDoc(id)),
        onReported: async (/** @type {string} */ id, /** @type {number} */ distinct) => {
          await this.db.reviewRequests.updateOne({ _id: id }, { $set: { reportCount: distinct } });
          if (distinct >= REVIEWS.AUTO_HIDE_DISTINCT_REPORTS) {
            const res = await this.db.reviewRequests.updateOne(
              { _id: id, hidden: { $ne: true } },
              { $set: { hidden: true, hiddenAt: new Date(this.now()) } },
            );
            if (res.modifiedCount) await this._refresh(id, {});
          }
        },
        remove: async (/** @type {string} */ id) => {
          await this.db.reviewRequests.updateOne(
            { _id: id },
            {
              $set: { status: "removed", removedAt: new Date(this.now()), listed: false, indexable: false },
              $unset: { activeKey: "" },
            },
          );
        },
        restore: async (/** @type {string} */ id) => {
          await this.db.reviewRequests.updateOne({ _id: id }, { $set: { hidden: false, reportCount: 0 }, $unset: { hiddenAt: "" } });
          await this._refresh(id, {});
        },
        describe: async (/** @type {string[]} */ ids) => {
          const rows = await this.db.reviewRequests.find({ _id: { $in: ids } }).toArray();
          return new Map(rows.map((doc) => [doc._id, {
            title: `[${doc.matchup || "?"}] review request`,
            snippet: snippet(doc.question, 200),
            href: `/reviews/${doc._id}`,
            hidden: doc.hidden === true,
            status: doc.status,
          }]));
        },
      },
      review_comment: {
        exists: async (/** @type {string} */ id) => Boolean(await this.db.reviewComments.findOne({ _id: id }, { projection: { _id: 1 } })),
        onReported: async (/** @type {string} */ id, /** @type {number} */ distinct) => {
          await this.db.reviewComments.updateOne({ _id: id }, { $set: { reportCount: distinct } });
          if (distinct >= REVIEWS.AUTO_HIDE_DISTINCT_REPORTS) {
            const res = await this.db.reviewComments.findOneAndUpdate(
              { _id: id, status: "visible" },
              { $set: { status: "hidden", hiddenAt: new Date(this.now()) } },
            );
            if (res) await this._refresh(res.requestId, {});
          }
        },
        remove: async (/** @type {string} */ id, /** @type {string} */ adminUserId) => {
          const comment = await this.db.reviewComments.findOne({ _id: id });
          if (!comment || comment.status === "removed") return;
          const doc = await this.getDoc(comment.requestId);
          if (doc) await this._revokeCommentKarma(comment, doc);
          await this.db.reviewComments.updateOne(
            { _id: id },
            { $set: { status: "removed", removedAt: new Date(this.now()), removedBy: adminUserId } },
          );
          if (doc && comment.authorId) {
            // One penalty per comment however many admins act on it.
            await this._award(comment, doc, "removed", "moderation", REVIEWS.KARMA_REMOVED);
            if (!comment.parentId && !comment.isAskerComment && comment.status === "visible") {
              await this.reputation.applyStats(comment.authorId, { reviews: -1 });
            }
          }
          if (doc) await this._refresh(doc._id, {});
        },
        restore: async (/** @type {string} */ id) => {
          const res = await this.db.reviewComments.findOneAndUpdate(
            { _id: id, status: "hidden" },
            { $set: { status: "visible", reportCount: 0 }, $unset: { hiddenAt: "" } },
          );
          if (res) await this._refresh(res.requestId, {});
        },
        describe: async (/** @type {string[]} */ ids) => {
          const rows = await this.db.reviewComments.find({ _id: { $in: ids } }).toArray();
          return new Map(rows.map((c) => [c._id, {
            title: `Comment at ${clock(c.gameTimeSec)}`,
            snippet: snippet(c.body, 200),
            href: `/reviews/${c.requestId}#comment-${c._id}`,
            hidden: c.status === "hidden",
            status: c.status,
          }]));
        },
      },
    };
  }

  // ── SEO / OG / sitemap ──────────────────────────────────────────

  /**
   * Minimal payload for the dynamic OG image. Same redaction as the page.
   *
   * @param {string} requestId
   */
  async ogSummary(requestId) {
    const doc = await this.getDoc(requestId);
    if (!doc || doc.status === "removed" || doc.hidden) throw notFound();
    return {
      id: doc._id,
      question: snippet(doc.question, SNIPPET_MAX),
      matchup: doc.matchup,
      map: doc.map,
      result: doc.result,
      askerBand: doc.askerBand ? doc.askerBand.label : null,
      reviewCount: doc.reviewCount || 0,
      hasBest: Boolean(doc.bestCommentId),
      status: doc.status,
    };
  }

  /** Indexable reviews for the dynamic sitemap. */
  async sitemap() {
    const rows = await this.db.reviewRequests
      .find({ indexable: true }, { projection: { _id: 1, lastActivityAt: 1 } })
      .sort({ lastActivityAt: -1 })
      .limit(5000)
      .toArray();
    return { items: rows.map((r) => ({ id: r._id, lastModified: iso(r.lastActivityAt) })) };
  }

  // ── Weekly digest ───────────────────────────────────────────────

  /**
   * "N open requests in your matchups at your level" — once per ISO
   * week per verified reviewer. Idempotent via ``reviewer.digestWeek``.
   *
   * @param {{weekKey: string}} opts
   */
  async sendWeeklyDigest(opts) {
    const since = new Date(this.now() - DIGEST_LOOKBACK_MS);
    const open = await this.db.reviewRequests
      .aggregate([
        { $match: { listed: true, status: "open", createdAt: { $gte: since } } },
        { $group: { _id: { matchup: "$matchup", band: "$askerBand.id", asker: "$userId" }, count: { $sum: 1 } } },
      ])
      .toArray();
    if (open.length === 0) return { notified: 0 };
    const reviewers = await this.db.users
      .find(
        {
          "reviewer.verified.band": { $ne: null },
          "reviewer.digestOptOut": { $ne: true },
          "reviewer.digestWeek": { $ne: opts.weekKey },
        },
        { projection: { _id: 0, userId: 1, "reviewer.verified": 1 } },
      )
      .limit(5000)
      .toArray();
    let notified = 0;
    for (const user of reviewers) {
      const verified = publicVerification(user.reviewer?.verified);
      if (!verified || !verified.race || verified.race === "Random") continue;
      const letter = verified.race.charAt(0);
      let count = 0;
      for (const row of open) {
        const matchup = row._id.matchup;
        const band = row._id.band;
        if (typeof matchup !== "string" || matchup.charAt(0) !== letter) continue;
        if (typeof band === "number" && band > verified.band.id) continue;
        if (row._id.asker === user.userId) continue;
        count += row.count;
      }
      if (count <= 0) continue;
      const claimed = await this.db.users.updateOne(
        { userId: user.userId, "reviewer.digestWeek": { $ne: opts.weekKey } },
        { $set: { "reviewer.digestWeek": opts.weekKey } },
      );
      if (claimed.modifiedCount !== 1) continue;
      await this.notifications.notify(user.userId, {
        kind: "review.digest",
        title: `${count} open review request${count === 1 ? "" : "s"} in your matchups`,
        body: `${verified.race} players at ${verified.band.label} and below are waiting for a reviewer.`,
        href: "/reviews?help=1",
      });
      notified += 1;
    }
    return { notified };
  }

  // ── GDPR ────────────────────────────────────────────────────────

  /**
   * Everything the user authored, for the account export. Other people's
   * ids are removed from rows that mention them.
   *
   * @param {string} userId
   */
  async exportForUser(userId) {
    const [requests, comments, karma, blocks, notifications] = await Promise.all([
      this.db.reviewRequests.find({ userId }, { projection: { activeKey: 0 } }).toArray(),
      this.db.reviewComments.find({ authorId: userId }).toArray(),
      this.db.reviewKarmaEvents.find({ userId }, { projection: { _id: 0, actorId: 0 } }).toArray(),
      this.db.reviewBlocks.find({ blockerId: userId }, { projection: { _id: 0, blockedId: 0 } }).toArray(),
      this.db.notifications.find({ userId }, { projection: { senderId: 0 } }).toArray(),
    ]);
    return { reviewRequests: requests, reviewComments: comments, reviewKarmaEvents: karma, reviewBlocks: blocks, notifications };
  }

  /**
   * Account deletion. Requests (and the threads under them — without the
   * replay they have nothing to point at) are deleted; comments the user
   * wrote on OTHER people's requests stay, anonymised to "[deleted
   * user]"; karma they received is deleted, karma they gave is kept for
   * the recipients but loses its actor id.
   *
   * @param {string} userId
   * @returns {Promise<Record<string, number>>}
   */
  async deleteForUser(userId) {
    const own = await this.db.reviewRequests.find({ userId }, { projection: { _id: 1 } }).toArray();
    const ownIds = own.map((r) => r._id);
    const threadComments = ownIds.length
      ? await this.db.reviewComments.deleteMany({ requestId: { $in: ownIds } })
      : { deletedCount: 0 };
    const requests = await this.db.reviewRequests.deleteMany({ userId });
    const anonymised = await this.db.reviewComments.updateMany(
      { authorId: userId },
      { $set: { authorId: null, authorDeleted: true } },
    );
    const received = await this.db.reviewKarmaEvents.deleteMany({ userId });
    const given = await this.db.reviewKarmaEvents.updateMany(
      { actorId: userId },
      { $set: { actorId: null } },
    );
    const blocks = await this.db.reviewBlocks.deleteMany({ $or: [{ blockerId: userId }, { blockedId: userId }] });
    const notifications = await this.db.notifications.deleteMany({ userId });
    await this.db.notifications.updateMany({ senderId: userId }, { $unset: { senderId: "" } });
    return {
      reviewRequests: requests.deletedCount || 0,
      reviewThreadComments: threadComments.deletedCount || 0,
      reviewCommentsAnonymised: anonymised.modifiedCount || 0,
      reviewKarmaEvents: received.deletedCount || 0,
      reviewKarmaActorsScrubbed: given.modifiedCount || 0,
      reviewBlocks: blocks.deletedCount || 0,
      notifications: notifications.deletedCount || 0,
    };
  }
}

// ── Serialisation ───────────────────────────────────────────────────

/**
 * @param {Doc} doc
 * @param {{viewer: Viewer, isAsker: boolean}} ctx
 */
function requestView(doc, ctx) {
  return {
    id: doc._id,
    url: `/reviews/${doc._id}`,
    question: doc.question,
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    timeRange: doc.timeRange || null,
    desiredLevel: doc.desiredLevel,
    visibility: doc.visibility,
    status: doc.status,
    closedReason: doc.status === "closed" ? publicClosedReason(doc.closedReason) : null,
    hidden: doc.hidden === true,
    asker: {
      label: askerLabel({ mode: doc.askerDisplay, name: doc.askerName, race: doc.myRace }),
      anonymous: doc.askerDisplay !== "named",
      band: doc.askerBand || null,
      mmr: doc.askerMmr ?? null,
      isYou: ctx.isAsker,
    },
    game: {
      matchup: doc.matchup,
      myRace: doc.myRace,
      oppRace: doc.oppRace,
      map: doc.map,
      result: doc.result,
      durationSec: doc.durationSec,
      myBuild: doc.myBuild,
      oppStrategy: doc.oppStrategy,
      macroScore: doc.macroScore ?? null,
      hasPlayback: doc.hasPlayback === true,
    },
    opponent: {
      label: doc.opponentLabel,
      race: doc.oppRace,
      band: doc.opponentBand || null,
      mmr: doc.opponentMmr ?? null,
    },
    stats: {
      reviewCount: doc.reviewCount || 0,
      commentCount: doc.commentCount || 0,
      helpfulCount: doc.helpfulCount || 0,
      upvoteTotal: doc.upvoteTotal || 0,
    },
    bestCommentId: doc.bestCommentId || null,
    createdAt: iso(doc.createdAt),
    lastActivityAt: iso(doc.lastActivityAt),
  };
}

/** @param {unknown} reason */
function publicClosedReason(reason) {
  if (reason === "asker" || reason === "game_unavailable" || reason === "moderator") return reason;
  return "closed";
}

/** @param {Doc} doc */
function cardView(doc) {
  return {
    id: doc._id,
    url: `/reviews/${doc._id}`,
    question: doc.question,
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    matchup: doc.matchup,
    map: doc.map,
    result: doc.result,
    durationSec: doc.durationSec,
    askerLabel: askerLabel({ mode: doc.askerDisplay, name: doc.askerName, race: doc.myRace }),
    askerBand: doc.askerBand || null,
    desiredLevel: doc.desiredLevel,
    status: doc.status,
    reviewCount: doc.reviewCount || 0,
    helpfulCount: doc.helpfulCount || 0,
    hasBest: Boolean(doc.bestCommentId),
    hasPlayback: doc.hasPlayback === true,
    createdAt: iso(doc.createdAt),
    lastActivityAt: iso(doc.lastActivityAt),
  };
}

/**
 * JSON-LD / robots inputs. Indexable only once the thread has a helpful
 * or best review (quality gate).
 *
 * @param {Doc} doc
 * @param {Doc[]} comments
 */
function seoView(doc, comments) {
  const visibleReviews = comments.filter((c) => c.status === "visible" && !c.parentId && !c.isAskerComment);
  return {
    indexable: doc.indexable === true,
    answerCount: visibleReviews.length,
    acceptedAnswerId: doc.bestCommentId && visibleReviews.some((c) => c._id === doc.bestCommentId)
      ? doc.bestCommentId
      : null,
    suggestedAnswerIds: visibleReviews
      .filter((c) => c.helpful && c._id !== doc.bestCommentId)
      .map((c) => c._id),
  };
}

/**
 * @param {Doc[]} comments
 * @param {{doc: Doc, viewer: Viewer, blockedIds: Set<string>, upvoted: Set<string>, profiles: Map<string, Record<string, any>>, now: number}} ctx
 */
function serializeThread(comments, ctx) {
  const hasReplies = new Set(comments.filter((c) => c.parentId).map((c) => c.parentId));
  /** @type {Record<string, any>[]} */
  const out = [];
  for (const c of comments) {
    const mine = Boolean(ctx.viewer.userId && c.authorId === ctx.viewer.userId);
    const blocked = Boolean(c.authorId && ctx.blockedIds.has(c.authorId));
    /** @type {"visible"|"hidden"|"removed"|"deleted"|"blocked"} */
    let state = c.status;
    if (c.status === "hidden" && !mine && !ctx.viewer.isAdmin) {
      if (!hasReplies.has(c._id)) continue;
      state = "removed";
    }
    if (c.status === "removed" && !ctx.viewer.isAdmin) {
      if (!hasReplies.has(c._id)) continue;
    }
    if (c.status === "deleted" && !hasReplies.has(c._id)) continue;
    if (blocked && c.status === "visible" && !ctx.viewer.isAdmin) {
      if (!hasReplies.has(c._id)) continue;
      state = "blocked";
    }
    const showBody = state === "visible" || (state === "hidden" && (mine || ctx.viewer.isAdmin))
      || (state === "removed" && ctx.viewer.isAdmin);
    // The asker speaks under the request's own label ("Anonymous
    // Protoss" or their chosen name) — never their profile, which would
    // unmask an anonymous asker.
    const asAsker = c.isAskerComment === true;
    const profile = c.authorId && !asAsker ? ctx.profiles.get(c.authorId) : null;
    const label = c.authorDeleted || !c.authorId
      ? "[deleted user]"
      : asAsker
        ? askerLabel({ mode: ctx.doc.askerDisplay, name: ctx.doc.askerName, race: ctx.doc.myRace })
        : profile?.name || "SC2 Player";
    out.push({
      id: c._id,
      parentId: c.parentId || null,
      state,
      author: showBody
        ? {
          label,
          isAsker: asAsker,
          profileHref: profile?.profileHref || null,
          verified: profile?.verified || null,
          badges: profile?.badges || [],
          flair: profile?.flair || null,
          coach: profile?.coach || null,
        }
        : null,
      body: showBody ? c.body : "",
      gameTimeSec: showBody ? c.gameTimeSec : null,
      endTimeSec: showBody ? c.endTimeSec ?? null : null,
      mapPoint: showBody ? c.mapPoint || null : null,
      upvotes: showBody ? Number(c.upvotes) || 0 : 0,
      upvoted: ctx.upvoted.has(c._id),
      helpful: showBody && c.helpful === true,
      best: showBody && c.best === true,
      mine,
      canEdit: mine && showBody && ctx.now - new Date(c.createdAt).getTime() <= REVIEWS.EDIT_WINDOW_MS,
      createdAt: iso(c.createdAt),
      editedAt: c.editedAt ? iso(c.editedAt) : null,
    });
  }
  return out;
}

// ── Ranking ─────────────────────────────────────────────────────────

/**
 * Board flags and scores, derived from the stored counters.
 *
 * @param {Doc} doc
 */
function derivedRanking(doc) {
  const active = ACTIVE_STATUSES.includes(doc.status) && doc.hidden !== true;
  const listed = active && doc.visibility === "public";
  const answered = (doc.helpfulCount || 0) > 0 || Boolean(doc.bestCommentId);
  const engagement = 1
    + (doc.reviewCount || 0) * 2
    + (doc.helpfulCount || 0) * 3
    + (doc.bestCommentId ? 5 : 0)
    + (doc.upvoteTotal || 0);
  const activitySec = new Date(doc.lastActivityAt || doc.createdAt || Date.now()).getTime() / 1000;
  return {
    listed,
    indexable: listed && answered,
    hotScore: round4(Math.log10(engagement) + (activitySec - HOT_EPOCH_SEC) / HOT_TIME_SCALE_SEC
      + (doc.hasPlayback ? PLAYBACK_HOT_BONUS : 0)),
    topScore: (doc.helpfulCount || 0) * 3
      + (doc.reviewCount || 0) * 2
      + (doc.bestCommentId ? 5 : 0)
      + (doc.upvoteTotal || 0)
      + (doc.hasPlayback ? PLAYBACK_TOP_BONUS : 0),
  };
}

/**
 * @param {Doc} doc
 * @param {import('./reviewerReputation').ReviewerVerification | null} verification
 */
function meetsDesiredLevel(doc, verification) {
  if (doc.desiredLevel === "masters_plus") {
    return Boolean(verification?.band && verification.band.id >= MASTERS_BAND_ID);
  }
  if (doc.desiredLevel === "my_league_or_higher") {
    if (!doc.askerBand) return Boolean(verification?.band);
    return Boolean(verification?.band && verification.band.id >= doc.askerBand.id);
  }
  return true;
}

/** @param {Doc} doc */
function levelMessage(doc) {
  if (doc.desiredLevel === "masters_plus") return "The asker wants reviews from verified Masters+ players.";
  return `The asker wants reviews from verified ${doc.askerBand ? `${doc.askerBand.label}+` : "ranked"} players.`;
}

// ── Helpers ─────────────────────────────────────────────────────────

function newId() {
  return crypto.randomBytes(12).toString("base64url");
}

/** @param {string} userId @param {string} gameId */
function activeKey(userId, gameId) {
  return `${userId}\u0000${gameId}`;
}

/** @param {unknown} raw @param {number | null} duration */
function normaliseTimeRange(raw, duration) {
  if (!raw || typeof raw !== "object") return null;
  const range = /** @type {Doc} */ (raw);
  const start = roundTenth(range.startSec);
  const end = roundTenth(range.endSec);
  const max = typeof duration === "number" ? duration + 1 : 86_400;
  if (!(start >= 0) || !(end > start) || end > max) return null;
  return { startSec: start, endSec: end };
}

/**
 * @param {Buffer} bytes
 * @returns {boolean}
 */
function segmentCarriesIdentity(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return true;
  }
  const keys = ["player", "players", "playerName", "displayName", "battleTag", "clan", "clanTag", "toonHandle", "handle", "pulseId", "pulseCharacterId", "userId", "gameId"];
  /** @param {unknown} value @param {number} depth @returns {boolean} */
  const walk = (value, depth) => {
    if (depth > 8 || value === null || typeof value !== "object") return false;
    if (Array.isArray(value)) {
      // Unit/building arrays are homogeneous; checking a bounded sample of
      // rows keeps a 2 MiB segment scan cheap.
      for (let i = 0; i < Math.min(value.length, 64); i += 1) if (walk(value[i], depth + 1)) return true;
      return false;
    }
    for (const [key, item] of Object.entries(value)) {
      if (keys.includes(key)) return true;
      if (walk(item, depth + 1)) return true;
    }
    return false;
  };
  return walk(parsed, 0);
}

/**
 * @template T
 * @param {() => Promise<T>} read
 * @returns {Promise<T | null>}
 */
async function safeRead(read) {
  try {
    return await read();
  } catch {
    return null;
  }
}

/** @param {unknown} raw */
function roundTenth(raw) {
  const n = typeof raw === "number" ? raw : Number.NaN;
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : Number.NaN;
}

/** @param {number} n */
function round4(n) {
  return Math.round(n * 10_000) / 10_000;
}

/** @param {unknown} raw @param {number} min @param {number} max @param {number} fallback */
function clampInt(raw, min, max, fallback) {
  const n = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** @param {unknown} text @param {number} [max] */
function snippet(text, max = SNIPPET_MAX) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

/** @param {unknown} value */
function iso(value) {
  if (!value) return null;
  const date = new Date(/** @type {any} */ (value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** @param {unknown} seconds */
function clock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** @param {Record<string, unknown>} value */
function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** @param {unknown} raw @returns {{s: string, v: any, id: string} | null} */
function decodeCursor(raw) {
  if (typeof raw !== "string" || raw.length > 300) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || typeof value.id !== "string") return null;
    if (value.s === "new" && Number.isNaN(new Date(value.v).getTime())) return null;
    if (value.s !== "new" && !Number.isFinite(Number(value.v))) return null;
    return value;
  } catch {
    return null;
  }
}

/** @param {unknown} err */
function isDuplicateKey(err) {
  return Boolean(err && typeof err === "object" && /** @type {any} */ (err).code === 11000);
}

/**
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [extra]
 */
function reviewError(status, code, message, extra) {
  const err = /** @type {Error & {status: number, code: string, details?: Record<string, unknown>}} */ (new Error(message));
  err.status = status;
  err.code = code;
  if (extra) err.details = extra;
  return err;
}

function notFound() {
  return reviewError(404, "review_not_found", "This review doesn't exist or was removed.");
}

module.exports = {
  ReviewsService,
  REVIEW_ID_RE: ID_RE,
  derivedRanking,
  meetsDesiredLevel,
  segmentCarriesIdentity,
  normalizeRace,
  _internals: { requestView, cardView, seoView, serializeThread, decodeCursor, encodeCursor },
};
