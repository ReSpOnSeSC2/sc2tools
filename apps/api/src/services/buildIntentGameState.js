"use strict";

/**
 * Build check-in on a stored game: ``GET/PUT /v1/games/:gameId/build-intent``
 * and the pending queue.
 *
 * Every label change goes through the atomic pipelines of
 * ``buildIntentAttribution``; nothing here reads a row and writes its label
 * back. Rows that never had a check-in first get a complete ``status:
 * "none"`` subdocument (without ``gameKey``, which stays the ingest bind's
 * first-wins marker), so a notes-only write never makes a game pending.
 */

const { BUILD_INTENT, COLLECTIONS } = require("../config/constants");
const { expectedVersion } = require("../db/schemaVersioning");
const {
  applyOverridePipeline,
  clearOverridePipeline,
  mergeIntentPipeline,
} = require("./buildIntentAttribution");
const {
  detectorView,
  isTooShortGame,
  parseBuildKey,
  sanitizeNotes,
} = require("./buildIntentShape");
const {
  asBuildRef,
  detectedOptionKey,
  executedFor,
  suggestIntent,
  twelvePoolName,
} = require("./buildIntentSuggest");
const { readBuildIntentPrefs } = require("./buildIntentPrefs");
const {
  BuildIntentError,
  gameMatchup,
  provenanceFromAuth,
} = require("./buildIntentCommon");
const { poolNameForGame } = require("../util/poolBuildNames");
const { parseBuildLogWithProxies, eventsToStartTime } = require("./perGameCompute");

/** Slim fields a game state needs (never the heavy logs). */
const GAME_PROJECTION = Object.freeze({
  _id: 0,
  gameId: 1,
  date: 1,
  result: 1,
  myRace: 1,
  map: 1,
  durationSec: 1,
  myBuild: 1,
  _customBuildSlug: 1,
  buildIntent: 1,
  "opponent.race": 1,
  "opponent.displayName": 1,
  isResumedFromReplay: 1,
  matchFormat: 1,
  gameVersion: 1,
  gameBuild: 1,
});

/** @typedef {import('./buildIntentAttribution').BuildRef} BuildRef */
/** @typedef {import('./buildIntentSuggest').Suggestion} Suggestion */
/** @typedef {import('./buildIntentOptions').OptionsPayload} OptionsPayload */
/** @typedef {"resumed"|"not_1v1"|"no_matchup"|"too_short"} IneligibleReason */

/**
 * Why a game cannot take a check-in, or null when it can.
 * @param {Record<string, any>} row
 * @returns {IneligibleReason|null}
 */
function ineligibleReason(row) {
  if (row.isResumedFromReplay === true) return "resumed";
  const format = row.matchFormat;
  if (!row.opponent || typeof row.opponent !== "object"
    || (format !== undefined && format !== null && format !== "1v1")) {
    return "not_1v1";
  }
  if (!gameMatchup(row)) return "no_matchup";
  if (isTooShortGame(row)) return "too_short";
  return null;
}

/**
 * The subdocument of a game that never had a check-in. No ``gameKey``: its
 * absence is the ingest bind's first-wins marker.
 * @param {Date} now
 */
function defaultIntent(now) {
  return {
    status: "none",
    build: null,
    applied: false,
    detected: null,
    suggestion: null,
    randomizer: null,
    origin: null,
    via: null,
    notes: "",
    confirmedAt: null,
    updatedAt: now,
  };
}

/**
 * @param {unknown} value
 * @returns {Suggestion|null}
 */
function suggestionOut(value) {
  const ref = asBuildRef(/** @type {any} */ (value));
  if (!ref) return null;
  const raw = /** @type {Record<string, any>} */ (value);
  const reasons = ["declared", "randomizer", "detected", "rules", "usual"];
  return {
    ...ref,
    reason: reasons.includes(raw.reason) ? raw.reason : "detected",
    passedRules: typeof raw.passedRules === "number" ? raw.passedRules : null,
    ruleCount: typeof raw.ruleCount === "number" ? raw.ruleCount : null,
  };
}

/** @param {unknown} value @returns {string|null} */
function isoOrNull(value) {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" && value ? value : null;
}

/**
 * Without a recomputation, a roll counts as deviated when the cached
 * suggestion did not keep it (and no declaration overrode it).
 * @param {Record<string, any>|null} intent
 * @param {Suggestion|null} suggestion
 */
function cachedDeviation(intent, suggestion) {
  if (!intent || !asBuildRef(intent.randomizer)) return false;
  return !(suggestion && (suggestion.reason === "randomizer" || suggestion.reason === "declared"));
}

/**
 * A catalog build's name as that game's patch spells it ("8 Pool" on the
 * 8-worker patch); custom names unchanged.
 * @param {BuildRef} ref
 * @param {Record<string, any>} game
 * @returns {BuildRef}
 */
function eraBuild(ref, game) {
  if (ref.source !== "catalog") return { ...ref };
  return { ...ref, name: String(poolNameForGame(twelvePoolName(ref.name), game)) };
}

class BuildIntentGameState {
  /**
   * @param {{
   *   db: { games: import('mongodb').Collection, users: import('mongodb').Collection },
   *   options: import('./buildIntentOptions').BuildIntentOptions,
   *   notifier: import('./buildIntentCommon').BuildIntentNotifier,
   *   perGame?: any,
   *   now?: () => number,
   * }} deps
   */
  constructor(deps) {
    this.games = deps.db.games;
    this.users = deps.db.users;
    this.options = deps.options;
    this.notifier = deps.notifier;
    this.perGame = deps.perGame || null;
    this.now = deps.now || Date.now;
  }

  /**
   * ``GET /v1/games/:gameId/build-intent``. A missing suggestion is computed
   * for undecided eligible games (never persisted).
   *
   * @param {string} userId
   * @param {string} gameId
   * @param {{ includeOptions?: boolean }} [opts]
   */
  async get(userId, gameId, opts = {}) {
    const row = await this.games.findOne({ userId, gameId }, { projection: GAME_PROJECTION });
    if (!row) throw new BuildIntentError(404, "not_found", "Game not found.");
    const prefs = (await readBuildIntentPrefs(this.users, userId)).checkin;
    const matchup = gameMatchup(row);
    const options = matchup ? await this.options.forMatchup(userId, matchup) : null;
    const intent = row.buildIntent && typeof row.buildIntent === "object" ? row.buildIntent : null;
    let suggestion = suggestionOut(intent && intent.suggestion);
    let randomizerDeviated = cachedDeviation(intent, suggestion);
    const status = intent && typeof intent.status === "string" ? intent.status : "none";
    if (!suggestion && options && matchup && ineligibleReason(row) === null
      && (status === "none" || status === "pending")) {
      const fresh = await this.suggestFor(userId, row, matchup, options, {
        events: await this.readEvents(userId, gameId),
      });
      suggestion = fresh.suggestion;
      randomizerDeviated = fresh.randomizerDeviated;
    }
    return this.serialize(userId, row, {
      prefs,
      options,
      suggestion,
      randomizerDeviated,
      includeOptions: opts.includeOptions === true,
    });
  }

  /**
   * ``PUT /v1/games/:gameId/build-intent``.
   *
   * @param {string} userId
   * @param {string} gameId
   * @param {{ action: string, buildKey?: string, notes?: string }} body
   * @param {{ source?: string }} auth
   */
  async put(userId, gameId, body, auth) {
    const notesPatch = notesPatchFor(body);
    const before = await this.games.findOne({ userId, gameId }, { projection: GAME_PROJECTION });
    if (!before) throw new BuildIntentError(404, "not_found", "Game not found.");
    const matchup = gameMatchup(before);
    const options = matchup ? await this.options.forMatchup(userId, matchup) : null;
    await this._applyAction(userId, gameId, body, { before, options, notesPatch, auth });
    const after = await this.games.findOne({ userId, gameId }, { projection: GAME_PROJECTION });
    if (!after) throw new BuildIntentError(404, "not_found", "Game not found.");
    this.options.invalidate(userId);
    const labelChanged = (before.myBuild ?? null) !== (after.myBuild ?? null)
      || (before._customBuildSlug ?? null) !== (after._customBuildSlug ?? null);
    if (labelChanged) this.notifier.gamesChanged(userId);
    this.notifier.changed(userId, { gameId });
    const intent = after.buildIntent && typeof after.buildIntent === "object" ? after.buildIntent : null;
    const suggestion = suggestionOut(intent && intent.suggestion);
    return this.serialize(userId, after, {
      prefs: (await readBuildIntentPrefs(this.users, userId)).checkin,
      options,
      suggestion,
      randomizerDeviated: cachedDeviation(intent, suggestion),
      includeOptions: false,
    });
  }

  /**
   * The write of one PUT action.
   * @param {string} userId
   * @param {string} gameId
   * @param {{ action: string, buildKey?: string }} body
   * @param {{
   *   before: Record<string, any>,
   *   options: OptionsPayload|null,
   *   notesPatch: { notes?: string },
   *   auth: { source?: string },
   * }} ctx
   */
  async _applyAction(userId, gameId, body, ctx) {
    const { before, options, notesPatch } = ctx;
    const reason = ineligibleReason(before);
    const { via, origin } = provenanceFromAuth(ctx.auth);
    const now = new Date(this.now());
    switch (body.action) {
      case "confirm": {
        if (reason) throw notEligible(reason);
        const ref = this._resolveConfirmKey(before, options, body.buildKey);
        if (!ref) throw new BuildIntentError(400, "unknown_build", "Unknown build for this game.");
        await this.ensureIntent(userId, gameId, now);
        await this.games.updateOne(
          { userId, gameId, isResumedFromReplay: { $ne: true } },
          applyOverridePipeline(eraBuild(ref, before), {
            ...notesPatch, origin, via, confirmedAt: now, updatedAt: now,
          }),
        );
        return;
      }
      case "skip":
        await this.ensureIntent(userId, gameId, now);
        await this.games.updateOne(
          { userId, gameId },
          clearOverridePipeline({
            ...notesPatch, status: "skipped", build: null, origin, via, confirmedAt: null, updatedAt: now,
          }),
        );
        return;
      case "defer": {
        if (reason) throw notEligible(reason);
        await this.ensureIntent(userId, gameId, now);
        // Only an undecided game becomes pending; a decision is never undone.
        const res = await this.games.updateOne(
          { userId, gameId, "buildIntent.status": { $in: ["none", "pending"] } },
          mergeIntentPipeline({ ...notesPatch, status: "pending", updatedAt: now }),
        );
        if (res.matchedCount === 0 && notesPatch.notes !== undefined) {
          await this.games.updateOne({ userId, gameId }, mergeIntentPipeline({ ...notesPatch, updatedAt: now }));
        }
        return;
      }
      case "notes":
        await this.ensureIntent(userId, gameId, now);
        await this.games.updateOne({ userId, gameId }, mergeIntentPipeline({ ...notesPatch, updatedAt: now }));
        return;
      default:
        throw new BuildIntentError(400, "invalid_action", "Unknown action.");
    }
  }

  /**
   * ``GET /v1/build-intents/pending``: pending eligible games of the last
   * 72 h, newest first. Suggestions come from the cache, or from the
   * detector label alone (no replay detail reads).
   *
   * @param {string} userId
   * @param {number} limit already clamped to 1..25
   */
  async listPending(userId, limit) {
    const prefs = (await readBuildIntentPrefs(this.users, userId)).checkin;
    if (!prefs.enabled) return { items: [], total: 0, disabled: true };
    const filter = this._pendingFilter(userId);
    const [rows, total] = await Promise.all([
      this.games.find(filter, { projection: GAME_PROJECTION }).sort({ date: -1 }).limit(limit).toArray(),
      this.games.countDocuments(filter),
    ]);
    /** @type {Map<string, OptionsPayload>} */
    const optionsByMatchup = new Map();
    const items = [];
    for (const row of rows) {
      const matchup = gameMatchup(row);
      let options = null;
      if (matchup) {
        options = optionsByMatchup.get(matchup) || await this.options.forMatchup(userId, matchup);
        optionsByMatchup.set(matchup, options);
      }
      const intent = row.buildIntent && typeof row.buildIntent === "object" ? row.buildIntent : null;
      let suggestion = suggestionOut(intent && intent.suggestion);
      let randomizerDeviated = cachedDeviation(intent, suggestion);
      if (!suggestion && options && matchup && ineligibleReason(row) === null) {
        const fresh = await this.suggestFor(userId, row, matchup, options, { events: null });
        suggestion = fresh.suggestion;
        randomizerDeviated = fresh.randomizerDeviated;
      }
      items.push(await this.serialize(userId, row, {
        prefs, options, suggestion, randomizerDeviated, includeOptions: false,
      }));
    }
    return { items, total, disabled: false };
  }

  /**
   * ``POST /v1/build-intents/pending/dismiss``: "No set build" for every
   * pending game of the queue window.
   *
   * @param {string} userId
   * @param {{ source?: string }} auth
   */
  async dismissPending(userId, auth) {
    const { via, origin } = provenanceFromAuth(auth);
    const ids = (await this.games
      .find(this._pendingFilter(userId), { projection: { _id: 0, gameId: 1 } })
      .sort({ date: -1 })
      .limit(BUILD_INTENT.DISMISS_MAX)
      .toArray())
      .map((row) => String(row.gameId));
    if (ids.length === 0) return { dismissed: 0 };
    const now = new Date(this.now());
    const res = await this.games.updateMany(
      { userId, gameId: { $in: ids }, "buildIntent.status": "pending" },
      clearOverridePipeline({
        status: "skipped", build: null, origin, via, confirmedAt: null, updatedAt: now,
      }),
    );
    this.options.invalidate(userId);
    // The newest games are the ones an agent card or queue may still show.
    for (const gameId of ids.slice(0, BUILD_INTENT.PENDING_LIMIT_MAX)) {
      this.notifier.changed(userId, { gameId });
    }
    return { dismissed: res.modifiedCount || 0 };
  }

  /** @param {string} userId */
  _pendingFilter(userId) {
    return {
      userId,
      "buildIntent.status": "pending",
      date: { $gte: new Date(this.now() - BUILD_INTENT.PENDING_WINDOW_MS) },
      isResumedFromReplay: { $ne: true },
    };
  }

  /**
   * Give a game without a check-in its complete ``status: "none"``
   * subdocument. Idempotent.
   * @param {string} userId
   * @param {string} gameId
   * @param {Date} now
   */
  async ensureIntent(userId, gameId, now) {
    await this.games.updateOne(
      { userId, gameId, buildIntent: null },
      { $set: { buildIntent: defaultIntent(now), _schemaVersion: expectedVersion(COLLECTIONS.GAMES) } },
    );
  }

  /**
   * A confirmable key: an option of the game's matchup (the detector's build
   * when it is one) or the game's randomizer roll.
   * @param {Record<string, any>} row
   * @param {OptionsPayload|null} options
   * @param {unknown} key
   * @returns {BuildRef|null}
   */
  _resolveConfirmKey(row, options, key) {
    if (!options || !parseBuildKey(key)) return null;
    const option = options.builds.find((b) => b.key === key);
    if (option) return { key: option.key, name: option.name, slug: option.slug, source: option.source };
    const roll = asBuildRef(row.buildIntent && row.buildIntent.randomizer);
    return roll && roll.key === key ? roll : null;
  }

  /**
   * @param {string} userId
   * @param {Record<string, any>} row
   * @param {string} matchup
   * @param {OptionsPayload} options
   * @param {{ events: ReadonlyArray<any>|null, declared?: BuildRef|null, randomizer?: BuildRef|null }} input
   */
  async suggestFor(userId, row, matchup, options, input) {
    const intent = row.buildIntent && typeof row.buildIntent === "object" ? row.buildIntent : {};
    return suggestIntent({
      game: row,
      detector: detectorView(row),
      events: input.events,
      declared: input.declared || null,
      randomizer: input.randomizer !== undefined ? input.randomizer : intent.randomizer || null,
      builds: options.builds,
      usualKey: options.usualKey,
      customRules: await this.options.customRules(userId, matchup),
    });
  }

  /**
   * The game's "you" start-time events from the detail store; null when the
   * store is unavailable or the game has no build log.
   * @param {string} userId
   * @param {string} gameId
   * @returns {Promise<ReadonlyArray<any>|null>}
   */
  async readEvents(userId, gameId) {
    if (!this.perGame || typeof this.perGame._readGameWithDetails !== "function") return null;
    try {
      const { slim, blob } = await this.perGame._readGameWithDetails(userId, gameId, {
        fields: ["buildLog"],
      });
      const lines = slim && Array.isArray(blob.buildLog) ? blob.buildLog : [];
      if (lines.length === 0) return null;
      return eventsToStartTime(
        parseBuildLogWithProxies(lines, this.perGame.catalog || null, slim.spatial, "my"),
        slim,
      );
    } catch {
      // 503 game_details_unavailable / aborts: suggest from the label alone.
      return null;
    }
  }

  /**
   * ``GameIntentState``.
   * @param {string} userId
   * @param {Record<string, any>} row
   * @param {{
   *   prefs: import('./buildIntentPrefs').CheckinPrefs,
   *   options: OptionsPayload|null,
   *   suggestion: Suggestion|null,
   *   randomizerDeviated: boolean,
   *   includeOptions: boolean,
   * }} ctx
   */
  async serialize(userId, row, ctx) {
    const intent = row.buildIntent && typeof row.buildIntent === "object" ? row.buildIntent : null;
    const opponent = row.opponent && typeof row.opponent === "object" ? row.opponent : {};
    const reason = ineligibleReason(row);
    const detector = detectorView(row);
    const builds = ctx.options ? ctx.options.builds : [];
    const ref = asBuildRef(intent && intent.build);
    /** @type {(BuildRef & { deleted?: boolean })|null} */
    let build = ref;
    if (ref && ref.source === "custom" && ref.slug
      && !(await this.options.customBuildExists(userId, ref.slug))) {
      build = { ...ref, deleted: true };
    }
    const target = build
      || (ctx.suggestion && ctx.suggestion.reason === "declared" ? ctx.suggestion : null);
    return {
      gameId: String(row.gameId),
      matchup: gameMatchup(row),
      myRace: typeof row.myRace === "string" ? row.myRace : null,
      oppRace: typeof opponent.race === "string" ? opponent.race : null,
      result: typeof row.result === "string" ? row.result : null,
      date: isoOrNull(row.date),
      durationSec: typeof row.durationSec === "number" ? row.durationSec : null,
      map: typeof row.map === "string" ? row.map : null,
      oppName: typeof opponent.displayName === "string" ? opponent.displayName : null,
      eligible: reason === null,
      ineligibleReason: reason,
      status: intent && typeof intent.status === "string" ? intent.status : "none",
      applied: Boolean(intent && intent.applied === true),
      build,
      suggestion: ctx.suggestion,
      randomizer: asBuildRef(intent && intent.randomizer),
      randomizerDeviated: ctx.randomizerDeviated,
      detected: {
        name: detector.myBuild,
        slug: detector.customBuildSlug,
        key: detectedOptionKey(detector, builds),
      },
      executed: executedFor(target, detector),
      notes: intent && typeof intent.notes === "string" ? intent.notes : "",
      origin: intent && typeof intent.origin === "string" ? intent.origin : null,
      via: intent && typeof intent.via === "string" ? intent.via : null,
      confirmedAt: isoOrNull(intent && intent.confirmedAt),
      updatedAt: isoOrNull(intent && intent.updatedAt),
      prefs: ctx.prefs,
      ...(ctx.includeOptions
        ? { options: builds, usualKey: ctx.options ? ctx.options.usualKey : null }
        : {}),
    };
  }
}

/**
 * Sanitised notes of a PUT body (omitted = unchanged); the ``notes`` action
 * requires them.
 * @param {{ action: string, notes?: unknown }} body
 * @returns {{ notes?: string }}
 */
function notesPatchFor(body) {
  if (body.notes === undefined) {
    if (body.action === "notes") throw new BuildIntentError(400, "invalid_notes", "Notes are required.");
    return {};
  }
  const notes = sanitizeNotes(body.notes);
  if (notes === null) throw new BuildIntentError(400, "invalid_notes", "Notes are limited to 1000 characters.");
  return { notes };
}

/** @param {IneligibleReason} reason */
function notEligible(reason) {
  return new BuildIntentError(409, "not_eligible", "This game cannot take a check-in.", { reason });
}

module.exports = {
  BuildIntentGameState,
  GAME_PROJECTION,
  ineligibleReason,
  defaultIntent,
  eraBuild,
  suggestionOut,
};
