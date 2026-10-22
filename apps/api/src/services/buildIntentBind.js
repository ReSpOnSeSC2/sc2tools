"use strict";

/**
 * Bind an ingested replay to its live check-in record (``POST /v1/games``,
 * after custom-build tagging, awaited before the response).
 *
 * Candidates are the user's unbound live records whose key started between
 * 10 min before the replay's start and min(start + 60 s, the replay's end),
 * newest first. A record matches when the replay opponent's normalised name
 * is its opponent name or one of its key's player names; a record with no
 * opponent information is only taken when it is the only candidate. Binding
 * is first-wins on both sides: the record is claimed (``gameId: null`` →
 * gameId), then the game is written only while it has no
 * ``buildIntent.gameKey``; a lost race releases the claim.
 *
 * A user decision made before the bind (web confirm/skip) is never
 * overwritten; nor are non-empty notes or a user's ``confirmedAt``.
 */

const { BUILD_INTENT } = require("../config/constants");
const {
  applyOverridePipeline,
  mergeIntentPipeline,
} = require("./buildIntentAttribution");
const { detectorView } = require("./buildIntentShape");
const { asBuildRef, suggestIntent } = require("./buildIntentSuggest");
const { fitsMatchup } = require("./buildIntentOptions");
const { readBuildIntentPrefs } = require("./buildIntentPrefs");
const { gameMatchup } = require("./buildIntentCommon");
const {
  GAME_PROJECTION,
  defaultIntent,
  eraBuild,
  ineligibleReason,
} = require("./buildIntentGameState");
const { normalizePlayerName } = require("../util/playerName");
const { parseBuildLogWithProxies, eventsToStartTime } = require("./perGameCompute");

const BIND_ATTEMPTS = 2;

/** @typedef {import('./buildIntentAttribution').BuildRef} BuildRef */
/**
 * @typedef {{ kind: "skip", origin: "postgame", via: string, notes: string|null }
 *   | { kind: "build", ref: BuildRef, fits: boolean, origin: "pregame"|"postgame", via: string, notes: string|null }} Answer
 */

/**
 * The replay's start: payload ``startedAt``, else ``date − durationSec``.
 * @param {Record<string, any>} game
 * @param {number} dateMs
 */
function startedAtMsFor(game, dateMs) {
  const started = typeof game.startedAt === "string" ? Date.parse(game.startedAt) : NaN;
  if (Number.isFinite(started)) return started;
  const duration = Number(game.durationSec);
  return dateMs - (Number.isFinite(duration) && duration > 0 ? duration * 1000 : 0);
}

/** @param {Record<string, any>} doc */
function hasNoOpponentInfo(doc) {
  if (normalizePlayerName(doc.oppName)) return false;
  const names = Array.isArray(doc.playerNames) ? doc.playerNames : [];
  return names.filter((name) => name && name !== "unknown").length <= 1;
}

/**
 * Candidates acceptable for this opponent, in claim order.
 * @param {Array<Record<string, any>>} candidates newest key first
 * @param {unknown} opponentName
 */
function acceptableCandidates(candidates, opponentName) {
  const target = normalizePlayerName(opponentName);
  if (target) {
    const matched = candidates.filter((doc) => (
      normalizePlayerName(doc.oppName) === target
      || (Array.isArray(doc.playerNames) && doc.playerNames.includes(target))
    ));
    if (matched.length > 0) return matched;
  }
  return candidates.length === 1 && hasNoOpponentInfo(candidates[0]) ? candidates : [];
}

class BuildIntentBind {
  /**
   * @param {{
   *   db: {
   *     games: import('mongodb').Collection,
   *     users: import('mongodb').Collection,
   *     buildIntentLive: import('mongodb').Collection<any>,
   *   },
   *   options: import('./buildIntentOptions').BuildIntentOptions,
   *   notifier: import('./buildIntentCommon').BuildIntentNotifier,
   *   perGame?: any,
   *   now?: () => number,
   * }} deps
   */
  constructor(deps) {
    this.games = deps.db.games;
    this.users = deps.db.users;
    this.live = deps.db.buildIntentLive;
    this.options = deps.options;
    this.notifier = deps.notifier;
    this.perGame = deps.perGame || null;
    this.now = deps.now || Date.now;
  }

  /**
   * @param {string} userId
   * @param {Record<string, any>} game the validated ingest payload
   * @param {{ created: boolean, spatial?: unknown }} opts ``spatial``: the
   *        stored (bounded) spatial block, as the tagger evaluated it
   * @returns {Promise<{ bound: boolean, status: string } | null>}
   */
  async bindIngestedGame(userId, game, opts) {
    if (!game || typeof game !== "object" || typeof game.gameId !== "string") return null;
    if (game.isResumedFromReplay === true) return null;
    const opponent = game.opponent && typeof game.opponent === "object" ? game.opponent : null;
    const format = game.matchFormat;
    if (!opponent || (format !== undefined && format !== null && format !== "1v1")) return null;
    const dateMs = new Date(game.date).getTime();
    if (!Number.isFinite(dateMs)) return null;
    const created = opts.created === true;
    const fresh = Math.abs(this.now() - dateMs) <= BUILD_INTENT.FRESH_PENDING_MS;
    const startedAtMs = startedAtMsFor(game, dateMs);
    const candidates = await this.live
      .find({
        userId,
        gameId: null,
        keyStartedAtMs: {
          $gte: startedAtMs - BUILD_INTENT.BIND_LOOKBACK_MS,
          $lt: Math.min(startedAtMs + BUILD_INTENT.BIND_LOOKAHEAD_MS, dateMs),
        },
      })
      .sort({ keyStartedAtMs: -1 })
      .limit(BUILD_INTENT.BIND_MAX_CANDIDATES)
      .toArray();
    if (candidates.length === 0 && !(created && fresh)) return null;
    const row = await this.games.findOne({ userId, gameId: game.gameId }, { projection: GAME_PROJECTION });
    if (!row) return null;
    if (row.buildIntent && typeof row.buildIntent === "object"
      && Object.hasOwn(row.buildIntent, "gameKey")) return null;
    const payload = { ...game, spatial: opts.spatial !== undefined ? opts.spatial : game.spatial };
    for (const candidate of acceptableCandidates(candidates, opponent.displayName)) {
      const now = new Date(this.now());
      const claimed = await this.live.findOneAndUpdate(
        { _id: candidate._id, gameId: null },
        { $set: { gameId: game.gameId, boundAt: now, updatedAt: now } },
        { returnDocument: "after" },
      );
      if (!claimed) continue;
      const outcome = await this._bindClaimed(userId, payload, row, claimed);
      if (outcome) {
        this._changed(userId, game.gameId);
        return outcome;
      }
      // The game was bound meanwhile: give the record back.
      await this.live.updateOne(
        { _id: claimed._id, gameId: game.gameId },
        { $set: { gameId: null, boundAt: null, updatedAt: new Date(this.now()) } },
      );
      return null;
    }
    if (!created || !fresh) return null;
    return this._markPending(userId, payload, row);
  }

  /**
   * A fresh, eligible game with no live record joins the queue (when the
   * user has check-ins on).
   * @param {string} userId
   * @param {Record<string, any>} game
   * @param {Record<string, any>} row
   */
  async _markPending(userId, game, row) {
    if (row.buildIntent) return null;
    const matchup = gameMatchup(row);
    if (!matchup || ineligibleReason(row) !== null) return null;
    const prefs = await readBuildIntentPrefs(this.users, userId);
    if (!prefs.checkin.enabled) return null;
    const suggestion = await this._suggest(userId, game, row, matchup, null, null);
    const now = new Date(this.now());
    const res = await this.games.updateOne(
      { userId, gameId: row.gameId, buildIntent: { $exists: false } },
      mergeIntentPipeline({ ...defaultIntent(now), status: "pending", suggestion }),
    );
    if (res.matchedCount === 0) return null;
    this._changed(userId, String(row.gameId));
    return { bound: false, status: "pending" };
  }

  /**
   * Write the claimed record's answer onto the game, guarded so a
   * concurrent user decision or another bind is never overwritten.
   * @param {string} userId
   * @param {Record<string, any>} game
   * @param {Record<string, any>} firstRow
   * @param {Record<string, any>} doc the claimed live record
   * @returns {Promise<{ bound: boolean, status: string } | null>}
   */
  async _bindClaimed(userId, game, firstRow, doc) {
    const prefs = await readBuildIntentPrefs(this.users, userId);
    let row = firstRow;
    for (let attempt = 0; attempt < BIND_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        const fresh = await this.games.findOne({ userId, gameId: game.gameId }, { projection: GAME_PROJECTION });
        if (!fresh) return null;
        row = fresh;
      }
      const intent = row.buildIntent && typeof row.buildIntent === "object" ? row.buildIntent : null;
      if (intent && Object.hasOwn(intent, "gameKey")) return null;
      const plan = await this._plan(userId, game, row, doc, prefs.checkin.enabled);
      const guard = intent
        ? { "buildIntent.updatedAt": intent.updatedAt instanceof Date ? intent.updatedAt : { $exists: false } }
        : { buildIntent: null };
      const res = await this.games.updateOne(
        { userId, gameId: game.gameId, "buildIntent.gameKey": { $exists: false }, ...guard },
        plan.pipeline,
      );
      if (res.matchedCount > 0) return { bound: true, status: plan.status };
    }
    return null;
  }

  /**
   * The game write for a claimed record.
   * @param {string} userId
   * @param {Record<string, any>} game
   * @param {Record<string, any>} row
   * @param {Record<string, any>} doc
   * @param {boolean} enabled the user's check-in master switch
   * @returns {Promise<{ pipeline: Array<Record<string, any>>, status: string }>}
   */
  async _plan(userId, game, row, doc, enabled) {
    const now = new Date(this.now());
    const intent = row.buildIntent && typeof row.buildIntent === "object" ? row.buildIntent : null;
    const status = intent && typeof intent.status === "string" ? intent.status : "none";
    const roll = asBuildRef(doc.randomizer);
    const rollPatch = intent && asBuildRef(intent.randomizer)
      ? {}
      : { randomizer: roll ? eraBuild(roll, row) : null };
    if (status === "confirmed" || status === "skipped") {
      return {
        pipeline: mergeIntentPipeline({ gameKey: String(doc.gameKey), ...rollPatch }),
        status,
      };
    }
    const matchup = gameMatchup(row);
    const reason = ineligibleReason(row);
    const answer = await this._answer(userId, doc, matchup);
    const misfit = answer && answer.kind === "build" && !answer.fits ? answer.ref : null;
    const suggestion = await this._suggest(
      userId, game, row, matchup, misfit || asBuildRef(doc.declared), roll,
    );
    const base = {
      ...(intent ? {} : defaultIntent(now)),
      gameKey: String(doc.gameKey),
      ...rollPatch,
      suggestion,
      updatedAt: now,
      ...(answer && answer.notes && !(intent && intent.notes) ? { notes: answer.notes } : {}),
    };
    const pendingStatus = enabled && reason === null ? "pending" : "none";
    if (!answer || misfit) {
      return { pipeline: mergeIntentPipeline({ ...base, status: pendingStatus }), status: pendingStatus };
    }
    const provenance = { origin: answer.origin, via: answer.via === "agent" ? "agent" : "web" };
    if (answer.kind === "skip") {
      return {
        pipeline: mergeIntentPipeline({ ...base, ...provenance, status: "skipped", build: null, applied: false }),
        status: "skipped",
      };
    }
    const build = eraBuild(answer.ref, row);
    if (reason !== null) {
      // Too short for an override (leaver, loading-screen disconnect).
      return {
        pipeline: mergeIntentPipeline({
          ...base, ...provenance, status: "confirmed", applied: false, build, confirmedAt: now,
        }),
        status: "confirmed",
      };
    }
    return {
      pipeline: applyOverridePipeline(build, { ...base, ...provenance, confirmedAt: now }),
      status: "confirmed",
    };
  }

  /**
   * The record's answer: the post-game answer wins over the declaration.
   * @param {string} userId
   * @param {Record<string, any>} doc
   * @param {string|null} matchup the replay's matchup
   * @returns {Promise<Answer|null>}
   */
  async _answer(userId, doc, matchup) {
    const post = doc.postgame && typeof doc.postgame === "object" ? doc.postgame : null;
    const postNotes = post && typeof post.notes === "string" && post.notes ? post.notes : null;
    if (post && post.skip === true) {
      return { kind: "skip", origin: "postgame", via: String(post.via), notes: postNotes };
    }
    if (post && typeof post.buildKey === "string") {
      const resolved = await this.options.resolveForUser(userId, post.buildKey);
      if (resolved) {
        return {
          kind: "build",
          ref: resolved.ref,
          fits: fitsMatchup(resolved, matchup),
          origin: "postgame",
          via: String(post.via),
          notes: postNotes,
        };
      }
    }
    const declared = asBuildRef(doc.declared);
    if (!declared) return null;
    const resolved = await this.options.resolveForUser(userId, declared.key);
    return {
      kind: "build",
      ref: declared,
      fits: resolved ? fitsMatchup(resolved, matchup) : false,
      origin: "pregame",
      via: String(doc.declared.via),
      notes: postNotes,
    };
  }

  /**
   * @param {string} userId
   * @param {Record<string, any>} game
   * @param {Record<string, any>} row
   * @param {string|null} matchup
   * @param {BuildRef|null} declared
   * @param {BuildRef|null} roll
   */
  async _suggest(userId, game, row, matchup, declared, roll) {
    if (!matchup) {
      return declared
        ? suggestIntent({ game: row, detector: detectorView(row), events: null, declared, builds: [] }).suggestion
        : null;
    }
    const options = await this.options.forMatchup(userId, matchup);
    return suggestIntent({
      game: row,
      detector: detectorView(row),
      events: declared ? null : this._events(game),
      declared,
      randomizer: roll,
      builds: options.builds,
      usualKey: options.usualKey,
      customRules: declared ? new Map() : await this.options.customRules(userId, matchup),
    }).suggestion;
  }

  /**
   * The payload's "you" start-time events (the tagger's evidence).
   * @param {Record<string, any>} game
   */
  _events(game) {
    if (!Array.isArray(game.buildLog) || game.buildLog.length === 0) return null;
    try {
      const catalog = this.perGame ? this.perGame.catalog || null : null;
      return eventsToStartTime(parseBuildLogWithProxies(game.buildLog, catalog, game.spatial, "my"), game);
    } catch {
      return null;
    }
  }

  /** @param {string} userId @param {string} gameId */
  _changed(userId, gameId) {
    this.options.invalidate(userId);
    this.notifier.changed(userId, { gameId });
  }
}

module.exports = { BuildIntentBind, startedAtMsFor, acceptableCandidates };
