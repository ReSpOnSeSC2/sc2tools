"use strict";

const crypto = require("crypto");
const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");
const { LIVE_GAME_MATCH } = require("../util/gameVisibility");
const {
  BUILD_INTENT_LABEL_PROJECTION,
  OPP_INTENT_LABEL_PROJECTION,
  withDetectorLabels,
} = require("./buildIntentShape");
const {
  buildGameSnapshot,
  reviewMacroBreakdown,
  reviewBuildOrder,
  reviewPlayback,
  reviewPlaybackManifest,
} = require("./reviewRedaction");
const { REVIEW_ID_RE, segmentCarriesIdentity } = require("./reviews");
const { boundedNumber, boundedString } = require("../routes/publicReplays");

/**
 * Revocable single-game share links (``game_shares``).
 *
 * A share is a scoped grant like a review request: an unguessable token
 * (12 random bytes, the 16-character review id format) that lets anyone
 * holding it read ONE of the owner's games, redacted, without an account.
 * Revoking it, deleting the game or deleting the account ends the grant.
 *
 * Privacy (ADR 0075, docs/reviews.md): the opponent is a third party, so
 * nothing that identifies them leaves the server. No name, battle tag,
 * clan, toon handle, pulse id, exact rating, game id or stream link; the
 * game is dated to the day and both ratings are rounded to 100. The owner
 * appears by race only, and only the replay classifier's labels are shown,
 * never a build check-in, a correction, notes or review state. Payloads
 * are rebuilt from the review allow-lists (services/reviewRedaction.js),
 * which are themselves built on the public-replay shapers.
 *
 * Tokens are bearer credentials: they are never logged (the request
 * logger redacts ``/shares/<token>``) and never exported.
 */

const SHARE_TOKEN_RE = REVIEW_ID_RE;
const GAME_SHARES = Object.freeze({
  /** Live links per user. */
  MAX_ACTIVE: 200,
  /** Links listed per game in the owner's manager. */
  MAX_LISTED: 20,
  /** Lifetime of a presigned segment URL, as for replay downloads. */
  SEGMENT_LINK_EXPIRES_SEC: 60,
  /** Segments whose bytes passed the identity scan, remembered per process. */
  CLEAN_SEGMENT_CACHE: 4096,
});

const GAME_PROJECTION = Object.freeze({
  _id: 0, gameId: 1, date: 1, result: 1, map: 1, myRace: 1, myMmr: 1, myBuild: 1,
  customBuildSlug: 1, _customBuildSlug: 1, customOpponentStrategySlug: 1, _customOpponentStrategySlug: 1,
  durationSec: 1, macroScore: 1, apm: 1, spq: 1, matchFormat: 1, playerCount: 1, playbackArtifact: 1,
  "opponent.race": 1, "opponent.mmr": 1, "opponent.strategy": 1, "opponent.leagueId": 1,
  ...BUILD_INTENT_LABEL_PROJECTION,
  ...OPP_INTENT_LABEL_PROJECTION,
});
const OWNER_PROJECTION = Object.freeze({
  _id: 1, gameId: 1, createdAt: 1, revokedAt: 1, viewCount: 1, lastViewedAt: 1,
});
const BENCHMARK_METRICS = Object.freeze(["macroScore", "apm", "spq", "durationSec"]);

class GameSharesService {
  /**
   * @param {import('../db/connect').DbContext} db
   * @param {{
   *   replayLibrary: import('./replayLibrary').ReplayLibraryService,
   *   perGame: import('./types').PerGameComputeService,
   *   playbackArtifacts?: import('./playbackArtifacts').PlaybackArtifactsService | null,
   *   leaguePercentiles?: {lookup(q: {leagueId: unknown, matchup: string}): Promise<any>} | null,
   *   logger?: import('pino').Logger | null,
   *   now?: () => number,
   * }} deps
   */
  constructor(db, deps) {
    if (!db?.gameShares || !db?.games || !deps?.replayLibrary || !deps?.perGame) {
      throw new Error("GameSharesService: db.gameShares, db.games, replayLibrary and perGame required");
    }
    this.db = db;
    this.replayLibrary = deps.replayLibrary;
    this.perGame = deps.perGame;
    this.playbackArtifacts = deps.playbackArtifacts || null;
    this.leaguePercentiles = deps.leaguePercentiles || null;
    this.logger = deps.logger || null;
    this.now = deps.now || Date.now;
    /** @type {Set<string>} */
    this.cleanSegments = new Set();
  }

  // ── Owner ───────────────────────────────────────────────────────

  /**
   * The game's live link, created on first use. One game has at most one
   * live link; asking again returns it rather than minting another.
   *
   * @param {string} userId
   * @param {string} gameId
   * @returns {Promise<{share: ReturnType<typeof ownerView>, created: boolean}>}
   */
  async create(userId, gameId) {
    const id = String(gameId || "");
    // Live, non-resumed games only: the same rule as the replay archive.
    const detail = id && id.length <= 200 ? await this.replayLibrary.getDetail(userId, id) : null;
    if (!detail) throw shareError(404, "game_not_found", "That game isn't in your synced history.");
    const inlinePlayback = await this._hasInlinePlayback(userId, id);
    const key = activeKey(userId, id);
    const existing = await this.db.gameShares.findOneAndUpdate(
      { activeKey: key },
      { $set: { inlinePlayback } },
      { returnDocument: "after", projection: OWNER_PROJECTION },
    );
    if (existing) return { share: ownerView(existing), created: false };
    await this._assertCapacity(userId, 0);
    const doc = {
      _id: newToken(),
      userId,
      gameId: id,
      activeKey: key,
      createdAt: new Date(this.now()),
      revokedAt: null,
      viewCount: 0,
      lastViewedAt: null,
      inlinePlayback,
    };
    try {
      await this.db.gameShares.insertOne(stampVersion(doc, COLLECTIONS.GAME_SHARES));
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      // A parallel request created this game's link first.
      const raced = await this.db.gameShares.findOne({ activeKey: key }, { projection: OWNER_PROJECTION });
      if (raced) return { share: ownerView(raced), created: false };
      // Never rethrow the driver error: its message quotes the duplicate key.
      throw shareError(409, "share_busy", "The share link changed while it was being created. Try again.");
    }
    // The capacity pre-check races with parallel creates; count again with
    // this link included and withdraw it if the cap is now exceeded.
    try {
      await this._assertCapacity(userId, 1);
    } catch (err) {
      await this.db.gameShares.deleteOne({ _id: doc._id });
      throw err;
    }
    return { share: ownerView(doc), created: true };
  }

  /**
   * The owner's links for one game, newest first, live and revoked.
   *
   * @param {string} userId
   * @param {string} gameId
   */
  async listForGame(userId, gameId) {
    const id = String(gameId || "").slice(0, 200);
    const [rows, active] = await Promise.all([
      this.db.gameShares.find({ userId, gameId: id }, { projection: OWNER_PROJECTION })
        .sort({ createdAt: -1 }).limit(GAME_SHARES.MAX_LISTED).toArray(),
      this.db.gameShares.countDocuments({ userId, revokedAt: null }),
    ]);
    return { shares: rows.map(ownerView), activeCount: active, limit: GAME_SHARES.MAX_ACTIVE };
  }

  /**
   * Revoke one of the owner's links. Idempotent; someone else's token is
   * indistinguishable from a missing one.
   *
   * @param {string} userId
   * @param {string} token
   */
  async revoke(userId, token) {
    if (!SHARE_TOKEN_RE.test(String(token || ""))) throw notFound();
    const revoked = await this.db.gameShares.findOneAndUpdate(
      { _id: token, userId, revokedAt: null },
      { $set: { revokedAt: new Date(this.now()), revokedReason: "owner" }, $unset: { activeKey: "" } },
      { returnDocument: "after", projection: OWNER_PROJECTION },
    );
    if (revoked) return { share: ownerView(revoked) };
    const existing = await this.db.gameShares.findOne({ _id: token, userId }, { projection: OWNER_PROJECTION });
    if (!existing) throw notFound();
    return { share: ownerView(existing) };
  }

  /** @param {string} userId @param {0 | 1} justInserted */
  async _assertCapacity(userId, justInserted) {
    const active = await this.db.gameShares.countDocuments({ userId, revokedAt: null });
    if (active - justInserted >= GAME_SHARES.MAX_ACTIVE) {
      throw shareError(409, "share_limit",
        `You can have at most ${GAME_SHARES.MAX_ACTIVE} active share links. Revoke one in Manage links to create another.`);
    }
  }

  /** @param {string} userId @param {string} gameId */
  async _hasInlinePlayback(userId, gameId) {
    const inline = await safeRead(() => this.perGame.mapPlayback(userId, gameId));
    return reviewPlayback(inline) !== null;
  }

  // ── Public grant ────────────────────────────────────────────────

  /**
   * The owner and game behind a live link. A malformed, unknown or revoked
   * token is the same plain 404, so a probe learns nothing. A link whose
   * game was deleted is retired on sight, which also frees its slot.
   *
   * @param {string} token
   * @returns {Promise<{ownerId: string, gameId: string, inlinePlayback: boolean}>}
   */
  async resolve(token) {
    if (!SHARE_TOKEN_RE.test(String(token || ""))) throw notFound();
    const doc = await this.db.gameShares.findOne(
      { _id: token },
      { projection: { userId: 1, gameId: 1, revokedAt: 1, inlinePlayback: 1 } },
    );
    if (!doc || doc.revokedAt) throw notFound();
    const detail = await this.replayLibrary.getDetail(doc.userId, doc.gameId);
    if (!detail) {
      await this.db.gameShares.updateOne(
        { _id: doc._id, revokedAt: null },
        { $set: { revokedAt: new Date(this.now()), revokedReason: "game_unavailable" }, $unset: { activeKey: "" } },
      );
      throw notFound();
    }
    return { ownerId: doc.userId, gameId: doc.gameId, inlinePlayback: doc.inlinePlayback === true };
  }

  /**
   * The shared game's redacted analysis: game facts, macro breakdown,
   * both build orders, which playback the page can load, and the league
   * benchmark table (a k-anonymous aggregate) for its bracket.
   *
   * @param {string} token
   */
  async analysis(token) {
    const { ownerId, gameId, inlinePlayback } = await this.resolve(token);
    const game = await this.db.games.findOne({ userId: ownerId, gameId, ...LIVE_GAME_MATCH }, { projection: GAME_PROJECTION });
    if (!game) throw notFound();
    // Viewers see the replay's classified build and opponent strategy,
    // never the owner's build check-in or opponent correction.
    const snapshot = buildGameSnapshot(withDetectorLabels(game));
    const [macro, build, table] = await Promise.all([
      safeRead(() => this.perGame.macroBreakdown(ownerId, gameId)),
      safeRead(() => this.perGame.buildOrder(ownerId, gameId)),
      snapshot.matchup && this.leaguePercentiles
        ? safeRead(() => /** @type {any} */ (this.leaguePercentiles).lookup({ leagueId: game.opponent?.leagueId, matchup: snapshot.matchup }))
        : Promise.resolve(null),
    ]);
    const segmented = Boolean(this.playbackArtifacts && game.playbackArtifact?.artifactId);
    return {
      game: publicGame(snapshot, game),
      macroBreakdown: reviewMacroBreakdown(macro),
      buildOrder: reviewBuildOrder(build, {
        opponentLabel: snapshot.opponentLabel,
        myBuild: snapshot.myBuild || null,
        oppStrategy: snapshot.oppStrategy || null,
      }),
      playback: { mode: segmented ? "segmented" : inlinePlayback ? "inline" : "none" },
      benchmark: publicBenchmark(table),
    };
  }

  /**
   * Count one view. The page sends this once per load from the browser,
   * so link previews and server renders are not counted.
   *
   * @param {string} token
   */
  async recordView(token) {
    if (!SHARE_TOKEN_RE.test(String(token || ""))) throw notFound();
    const res = await this.db.gameShares.updateOne(
      { _id: token, revokedAt: null },
      { $inc: { viewCount: 1 }, $set: { lastViewedAt: new Date(this.now()) } },
    );
    if (!res.matchedCount) throw notFound();
  }

  /** Legacy inline map playback, identity keys stripped. @param {string} token */
  async playback(token) {
    const { ownerId, gameId } = await this.resolve(token);
    const out = reviewPlayback(await safeRead(() => this.perGame.mapPlayback(ownerId, gameId)));
    if (!out) throw shareError(404, "playback_not_computed", "This replay has no map playback.");
    return out;
  }

  /** Segmented playback manifest, rebuilt from an allow-list. @param {string} token */
  async playbackManifest(token) {
    const { ownerId, gameId } = await this.resolve(token);
    if (!this.playbackArtifacts) throw noPlayback();
    const out = reviewPlaybackManifest(await this.playbackArtifacts.getManifest(ownerId, gameId));
    if (!out) throw noPlayback();
    return out;
  }

  /**
   * Existing segment object keys carry private identifiers. Keep the
   * lookup revocation-aware and let the browser use the verified proxy.
   * @param {string} token
   */
  async segmentLink(token) {
    await this.resolve(token);
    throw shareError(404, "playback_direct_unavailable", "Use the replay playback endpoint.");
  }

  /**
   * Segment bytes through the API: the fallback for browsers that cannot
   * read the storage URL directly.
   *
   * @param {string} token
   * @param {string} artifactId
   * @param {number} index
   * @returns {Promise<Buffer>}
   */
  async playbackSegment(token, artifactId, index) {
    const { ownerId, gameId } = await this.resolve(token);
    if (!this.playbackArtifacts) throw noPlayback();
    const bytes = await this.playbackArtifacts.getSegment(ownerId, gameId, artifactId, index);
    this._assertClean(bytes, artifactId, index);
    return bytes;
  }

  /** @param {Buffer} bytes @param {string} artifactId @param {number} index */
  _assertClean(bytes, artifactId, index) {
    if (segmentCarriesIdentity(bytes)) {
      // Never log the token: it is the page's credential.
      if (this.logger) this.logger.warn({ index }, "game_share_segment_identity_blocked");
      throw noPlayback();
    }
    if (this.cleanSegments.size >= GAME_SHARES.CLEAN_SEGMENT_CACHE) {
      const oldest = this.cleanSegments.values().next().value;
      if (oldest !== undefined) this.cleanSegments.delete(oldest);
    }
    this.cleanSegments.add(`${artifactId}:${index}`);
  }
}

/**
 * The public game facts. ``snapshot`` is the review snapshot of the
 * detector-view row (rounded ratings, league bands, a race-only opponent
 * label, labels from the shared classifier only).
 *
 * @param {ReturnType<typeof buildGameSnapshot>} snapshot
 * @param {Record<string, any>} game
 */
function publicGame(snapshot, game) {
  const format = game.matchFormat;
  return {
    matchup: snapshot.matchup,
    myRace: snapshot.myRace,
    oppRace: snapshot.oppRace,
    map: snapshot.map,
    result: snapshot.result,
    durationSec: snapshot.durationSec,
    // The day, never the time: a time to the second picks one game out of
    // the sharer's public ladder history, and so points at the opponent.
    playedOn: snapshot.playedAt ? snapshot.playedAt.toISOString().slice(0, 10) : null,
    myBuild: snapshot.myBuild,
    oppStrategy: snapshot.oppStrategy,
    macroScore: snapshot.macroScore,
    apm: boundedNumber(game.apm, 0, 2_000, false),
    spq: boundedNumber(game.spq, 0, 1_000, false),
    playerLabel: snapshot.myRace && snapshot.myRace !== "Random" ? `${snapshot.myRace} player` : "Player",
    playerMmr: snapshot.askerMmr,
    playerBand: snapshot.askerBand,
    opponentLabel: snapshot.opponentLabel,
    opponentMmr: snapshot.opponentMmr,
    opponentBand: snapshot.opponentBand,
    matchFormat: format === "1v1" || format === "team" || format === "ffa" || format === "other" ? format : null,
    playerCount: boundedNumber(game.playerCount, 1, 16, true),
  };
}

/**
 * The league table for the game's bracket: an aggregate over at least 50
 * players' games, no user data. Only the benchmarked game metrics.
 *
 * @param {any} table
 */
function publicBenchmark(table) {
  if (!table || typeof table !== "object" || !table.metrics) return null;
  /** @type {Record<string, {n: number, deciles: number[] | null}>} */
  const metrics = {};
  for (const metric of BENCHMARK_METRICS) {
    const row = table.metrics[metric];
    const n = boundedNumber(row?.n, 0, 100_000_000, true);
    if (n === null) continue;
    const deciles = Array.isArray(row.deciles) && row.deciles.length === 9 && row.deciles.every(Number.isFinite)
      ? row.deciles.slice()
      : null;
    metrics[metric] = { n, deciles };
  }
  const updatedAt = new Date(table.updatedAt);
  return {
    league: boundedString(table.league, 40),
    matchup: typeof table.matchup === "string" && /^[PTZ]v[PTZ]$/.test(table.matchup) ? table.matchup : null,
    n: boundedNumber(table.n, 0, 100_000_000, true),
    updatedAt: Number.isNaN(updatedAt.getTime()) ? null : updatedAt.toISOString(),
    metrics,
  };
}

/** @param {{_id: string, gameId: string, createdAt?: Date|null, revokedAt?: Date|null, viewCount?: number, lastViewedAt?: Date|null}} doc */
function ownerView(doc) {
  return {
    token: doc._id,
    gameId: doc.gameId,
    url: `/g/${doc._id}`,
    active: !doc.revokedAt,
    createdAt: doc.createdAt || null,
    revokedAt: doc.revokedAt || null,
    viewCount: Number.isInteger(doc.viewCount) ? doc.viewCount : 0,
    lastViewedAt: doc.lastViewedAt || null,
  };
}

/** 12 random bytes: 96 bits, 16 base64url characters. */
function newToken() {
  return crypto.randomBytes(12).toString("base64url");
}

/** @param {string} userId @param {string} gameId */
function activeKey(userId, gameId) {
  return `${userId}\u0000${gameId}`;
}

/** @template T @param {() => Promise<T>} read @returns {Promise<T | null>} */
async function safeRead(read) {
  try {
    return await read();
  } catch {
    return null;
  }
}

/** @param {unknown} err */
function isDuplicateKey(err) {
  return Boolean(err && typeof err === "object" && /** @type {any} */ (err).code === 11000);
}

/** @param {number} status @param {string} code @param {string} message */
function shareError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function notFound() {
  return shareError(404, "share_not_found", "This share link doesn't exist or was turned off.");
}

function noPlayback() {
  return shareError(404, "playback_artifact_not_found", "No recorded playback.");
}

module.exports = { GameSharesService, GAME_SHARES, SHARE_TOKEN_RE, _internals: { publicGame, publicBenchmark, ownerView } };
