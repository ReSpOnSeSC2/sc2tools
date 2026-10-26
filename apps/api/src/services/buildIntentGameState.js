"use strict";
const { gameWrite } = require("../util/userRevision");
const { LIVE_GAME_MATCH } = require("../util/gameVisibility");

/**
 * Build check-in on a stored game: ``GET/PUT /v1/games/:gameId/build-intent``
 * and the pending queue.
 *
 * Two axes: the user's own build (``myBuild``/``_customBuildSlug``, with a
 * pending queue) and the opponent's build (``opponent.strategy``/
 * ``_customOpponentStrategySlug``, an optional correction with no queue).
 * Every label change goes through the atomic pipelines of
 * ``buildIntentAttribution``; nothing here reads a row and writes its label
 * back. One PUT is one update: the "you" stages and the opponent stages are
 * concatenated into a single pipeline. Rows that never had a check-in first
 * get a complete ``status: "none"`` subdocument (without ``gameKey``, which
 * stays the ingest bind's first-wins marker), so a notes-only or
 * opponent-only write never makes a game pending. Resumed (quarantined) rows
 * refuse every write.
 */

const { BUILD_INTENT, COLLECTIONS } = require("../config/constants");
const { expectedVersion } = require("../db/schemaVersioning");
const {
  applyOverridePipeline,
  clearOverridePipeline,
  mergeIntentPipeline,
  applyOpponentOverridePipeline,
  clearOpponentOverridePipeline,
} = require("./buildIntentAttribution");
const {
  detectorView,
  isTooShortGame,
  opponentDetectorView,
  opponentOverrideActive,
  parseBuildKey,
  sanitizeNotes,
} = require("./buildIntentShape");
const {
  asBuildRef,
  detectedOpponentOption,
  detectedOptionKey,
  executedFor,
  opponentDetectorLabel,
  suggestIntent,
  suggestOpponent,
  twelvePoolName,
} = require("./buildIntentSuggest");
const { fitsMatchup } = require("./buildIntentOptions");
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
  _customOpponentStrategySlug: 1,
  buildIntent: 1,
  "opponent.race": 1,
  "opponent.displayName": 1,
  "opponent.strategy": 1,
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
 * @typedef {{
 *   action: string, buildKey?: string, notes?: string, opponentBuildKey?: string|null,
 * }} GameIntentBody
 * @typedef {{ you: ReadonlyArray<any>|null, opponent: ReadonlyArray<any>|null }} GameEvents
 */

/** Label fields a PUT compares to decide whether ``games:changed`` fires. */
const LABEL_FIELDS = Object.freeze([
  (/** @type {Record<string, any>} */ row) => row.myBuild,
  (/** @type {Record<string, any>} */ row) => row._customBuildSlug,
  (/** @type {Record<string, any>} */ row) => row.opponent && row.opponent.strategy,
  (/** @type {Record<string, any>} */ row) => row._customOpponentStrategySlug,
]);

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

/**
 * Pipeline stage giving a row without a check-in its complete ``status:
 * "none"`` subdocument; rows that have one keep it.
 * @param {Date} now
 */
function ensureIntentStage(now) {
  return { $set: { buildIntent: { $ifNull: ["$buildIntent", { $literal: defaultIntent(now) }] } } };
}

/**
 * "Later": an undecided game (none / pending) becomes pending; a decision
 * is never undone. Notes merge either way.
 * @param {{ notes?: string }} notesPatch
 * @param {Date} now
 * @returns {Array<Record<string, any>>}
 */
function deferPipeline(notesPatch, now) {
  const touched = notesPatch.notes !== undefined ? { ...notesPatch, updatedAt: now } : {};
  return [{
    $set: {
      _schemaVersion: expectedVersion(COLLECTIONS.GAMES),
      buildIntent: {
        $mergeObjects: [
          { $ifNull: ["$buildIntent", {}] },
          {
            $cond: [
              { $in: [{ $ifNull: ["$buildIntent.status", "none"] }, ["none", "pending"]] },
              { $literal: { ...notesPatch, status: "pending", updatedAt: now } },
              { $literal: touched },
            ],
          },
        ],
      },
    },
  }];
}

/**
 * ``buildIntent.opponent`` after a correction is withdrawn.
 * @param {Date} now
 */
function opponentClearPatch(now) {
  return { status: "none", build: null, origin: null, via: null, confirmedAt: null, updatedAt: now };
}

class BuildIntentGameState {
  /**
   * @param {{
   *   db: { games: import('mongodb').Collection, users: import('mongodb').Collection },
   *   options: import('./buildIntentOptions').BuildIntentOptions,
   *   notifier: import('./buildIntentCommon').BuildIntentNotifier,
   *   perGame?: any,
   *   userRevision?: import("../util/userRevision").UserRevision,
   *   now?: () => number,
   * }} deps
   */
  constructor(deps) {
    this.userRevision = deps.userRevision || null;
    this.games = deps.db.games;
    this.users = deps.db.users;
    this.options = deps.options;
    this.notifier = deps.notifier;
    this.perGame = deps.perGame || null;
    this.now = deps.now || Date.now;
  }

  /**
   * ``GET /v1/games/:gameId/build-intent``. A missing suggestion is computed
   * for undecided eligible games, and the opponent's suggestion for eligible
   * ones (never persisted). One detail read serves both when needed.
   *
   * @param {string} userId
   * @param {string} gameId
   * @param {{ includeOptions?: boolean }} [opts]
   */
  async get(userId, gameId, opts = {}) {
    const row = await this.games.findOne({ userId, gameId, ...LIVE_GAME_MATCH }, { projection: GAME_PROJECTION });
    if (!row) throw new BuildIntentError(404, "not_found", "Game not found.");
    const prefs = (await readBuildIntentPrefs(this.users, userId)).checkin;
    const matchup = gameMatchup(row);
    const { options, oppOptions } = await this._optionsFor(userId, matchup);
    const eligible = ineligibleReason(row) === null;
    const intent = row.buildIntent && typeof row.buildIntent === "object" ? row.buildIntent : null;
    let suggestion = suggestionOut(intent && intent.suggestion);
    let randomizerDeviated = cachedDeviation(intent, suggestion);
    const status = intent && typeof intent.status === "string" ? intent.status : "none";
    const wantYou = Boolean(!suggestion && options && matchup && eligible
      && (status === "none" || status === "pending"));
    const opp = eligible && oppOptions && matchup
      ? await this._opponentSuggestionInput(userId, row, matchup, oppOptions)
      : null;
    const events = wantYou || (opp && opp.wantEvents)
      ? await this.readEvents(userId, gameId, { you: wantYou, opponent: Boolean(opp && opp.wantEvents) })
      : { you: null, opponent: null };
    if (wantYou && options && matchup) {
      const fresh = await this.suggestFor(userId, row, matchup, options, { events: events.you });
      suggestion = fresh.suggestion;
      randomizerDeviated = fresh.randomizerDeviated;
    }
    const oppSuggestion = opp && oppOptions
      ? suggestOpponent({
        game: row,
        detector: opponentDetectorView(row),
        events: events.opponent,
        builds: oppOptions.builds,
        customRules: opp.customRules,
      })
      : null;
    return this.serialize(userId, row, {
      prefs,
      options,
      oppOptions,
      suggestion,
      oppSuggestion,
      randomizerDeviated,
      includeOptions: opts.includeOptions === true,
    });
  }

  /**
   * ``PUT /v1/games/:gameId/build-intent``.
   *
   * @param {string} userId
   * @param {string} gameId
   * @param {GameIntentBody} body
   * @param {{ source?: string }} auth
   */
  async put(userId, gameId, body, auth) {
    const notesPatch = notesPatchFor(body);
    const before = await this.games.findOne({ userId, gameId, ...LIVE_GAME_MATCH }, { projection: GAME_PROJECTION });
    if (!before) throw new BuildIntentError(404, "not_found", "Game not found.");
    const matchup = gameMatchup(before);
    const { options, oppOptions } = await this._optionsFor(userId, matchup);
    await this._applyAction(userId, gameId, body, { before, matchup, options, oppOptions, notesPatch, auth });
    const after = await this.games.findOne({ userId, gameId, ...LIVE_GAME_MATCH }, { projection: GAME_PROJECTION });
    if (!after) throw new BuildIntentError(404, "not_found", "Game not found.");
    this.options.invalidate(userId);
    const labelChanged = LABEL_FIELDS.some((field) => (field(before) ?? null) !== (field(after) ?? null));
    if (labelChanged) this.notifier.gamesChanged(userId);
    this.notifier.changed(userId, { gameId });
    const intent = after.buildIntent && typeof after.buildIntent === "object" ? after.buildIntent : null;
    const suggestion = suggestionOut(intent && intent.suggestion);
    return this.serialize(userId, after, {
      prefs: (await readBuildIntentPrefs(this.users, userId)).checkin,
      options,
      oppOptions,
      suggestion,
      oppSuggestion: this._labelOnlyOpponentSuggestion(after, oppOptions),
      randomizerDeviated: cachedDeviation(intent, suggestion),
      includeOptions: false,
    });
  }

  /**
   * The single write of one PUT: the action's "you" stages followed by the
   * opponent stages of ``opponentBuildKey``. Everything is validated before
   * anything is written.
   * @param {string} userId
   * @param {string} gameId
   * @param {GameIntentBody} body
   * @param {{
   *   before: Record<string, any>,
   *   matchup: string|null,
   *   options: OptionsPayload|null,
   *   oppOptions: OptionsPayload|null,
   *   notesPatch: { notes?: string },
   *   auth: { source?: string },
   * }} ctx
   */
  async _applyAction(userId, gameId, body, ctx) {
    const { before, notesPatch } = ctx;
    const reason = ineligibleReason(before);
    // Quarantined rows are out of every stat; nothing may write their label.
    if (reason === "resumed") throw notEligible(reason);
    const { via, origin } = provenanceFromAuth(ctx.auth);
    const now = new Date(this.now());
    /** @type {Array<Record<string, any>>} */
    let you;
    switch (body.action) {
      case "confirm": {
        if (reason) throw notEligible(reason);
        const ref = await this._resolveConfirmKey(userId, before, ctx.matchup, ctx.options, body.buildKey);
        if (!ref) throw new BuildIntentError(400, "unknown_build", "Unknown build for this game.");
        you = applyOverridePipeline(eraBuild(ref, before), {
          ...notesPatch, origin, via, confirmedAt: now, updatedAt: now,
        });
        break;
      }
      case "skip":
        you = clearOverridePipeline({
          ...notesPatch, status: "skipped", build: null, origin, via, confirmedAt: null, updatedAt: now,
        });
        break;
      case "defer":
        if (reason) throw notEligible(reason);
        you = deferPipeline(notesPatch, now);
        break;
      case "notes":
        you = mergeIntentPipeline({ ...notesPatch, updatedAt: now });
        break;
      case "opponent":
        if (body.opponentBuildKey === undefined) {
          throw new BuildIntentError(400, "invalid_request", "opponentBuildKey is required.");
        }
        you = notesPatch.notes !== undefined ? mergeIntentPipeline({ ...notesPatch, updatedAt: now }) : [];
        break;
      default:
        throw new BuildIntentError(400, "invalid_action", "Unknown action.");
    }
    const opponent = await this._opponentStages(userId, before, body.opponentBuildKey, {
      reason, matchup: ctx.matchup, oppOptions: ctx.oppOptions, via, origin, now,
    });
    if (you.length === 0 && opponent.length === 0) return;
    const res = await gameWrite(this.userRevision, userId, () => this.games.updateOne(
      { userId, gameId,
          ...LIVE_GAME_MATCH, isResumedFromReplay: { $ne: true } },
      [ensureIntentStage(now), ...you, ...opponent],
    ));
    if (res.matchedCount === 0) {
      // Quarantined (or deleted) between the read and the write.
      const gone = !(await this.games.findOne({ userId, gameId, ...LIVE_GAME_MATCH }, { projection: { _id: 1 } }));
      if (gone) throw new BuildIntentError(404, "not_found", "Game not found.");
      throw notEligible("resumed");
    }
  }

  /**
   * Pipeline stages for ``opponentBuildKey``: omitted → none; null → clear
   * the correction; the detected build's key → clear an active correction
   * (otherwise nothing to do); any other key → apply it.
   * @param {string} userId
   * @param {Record<string, any>} row
   * @param {string|null|undefined} key
   * @param {{
   *   reason: IneligibleReason|null,
   *   matchup: string|null,
   *   oppOptions: OptionsPayload|null,
   *   via: "agent"|"web",
   *   origin: "postgame"|"web",
   *   now: Date,
   * }} ctx
   * @returns {Promise<Array<Record<string, any>>>}
   */
  async _opponentStages(userId, row, key, ctx) {
    if (key === undefined) return [];
    const opp = row.buildIntent && typeof row.buildIntent === "object"
      && row.buildIntent.opponent && typeof row.buildIntent.opponent === "object"
      ? row.buildIntent.opponent
      : null;
    const active = opponentOverrideActive(row);
    const clear = active || (opp !== null && opp.status === "confirmed")
      ? clearOpponentOverridePipeline(opponentClearPatch(ctx.now))
      : [];
    if (key === null) return clear;
    if (ctx.reason) throw notEligible(ctx.reason);
    const ref = await this._resolveOpponentKey(userId, row, ctx.matchup, key);
    if (!ref) {
      throw new BuildIntentError(400, "unknown_opponent_build", "Unknown opponent build for this game.");
    }
    const detected = ctx.oppOptions
      ? detectedOpponentOption(opponentDetectorView(row), ctx.oppOptions.builds)
      : null;
    if (detected && detected.key === ref.key) return clear;
    return applyOpponentOverridePipeline(eraBuild(ref, row), {
      origin: ctx.origin, via: ctx.via, confirmedAt: ctx.now, updatedAt: ctx.now,
    });
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
    /** @type {Map<string, { options: OptionsPayload|null, oppOptions: OptionsPayload|null }>} */
    const optionsByMatchup = new Map();
    const items = [];
    for (const row of rows) {
      const matchup = gameMatchup(row);
      const cached = matchup ? optionsByMatchup.get(matchup) : undefined;
      const { options, oppOptions } = cached || await this._optionsFor(userId, matchup);
      if (matchup && !cached) optionsByMatchup.set(matchup, { options, oppOptions });
      const intent = row.buildIntent && typeof row.buildIntent === "object" ? row.buildIntent : null;
      let suggestion = suggestionOut(intent && intent.suggestion);
      let randomizerDeviated = cachedDeviation(intent, suggestion);
      const eligible = ineligibleReason(row) === null;
      if (!suggestion && options && matchup && eligible) {
        const fresh = await this.suggestFor(userId, row, matchup, options, { events: null });
        suggestion = fresh.suggestion;
        randomizerDeviated = fresh.randomizerDeviated;
      }
      items.push(await this.serialize(userId, row, {
        prefs,
        options,
        oppOptions,
        suggestion,
        oppSuggestion: eligible ? this._labelOnlyOpponentSuggestion(row, oppOptions) : null,
        randomizerDeviated,
        includeOptions: false,
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
    const res = await gameWrite(this.userRevision, userId, () => this.games.updateMany(
      {
        userId,
        gameId: { $in: ids },
        ...LIVE_GAME_MATCH,
        "buildIntent.status": "pending",
        isResumedFromReplay: { $ne: true },
      },
      clearOverridePipeline({
        status: "skipped", build: null, origin, via, confirmedAt: null, updatedAt: now,
      }),
    ));
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
      ...LIVE_GAME_MATCH,
      "buildIntent.status": "pending",
      date: { $gte: new Date(this.now() - BUILD_INTENT.PENDING_WINDOW_MS) },
      isResumedFromReplay: { $ne: true },
    };
  }

  /**
   * Both sides' options of a matchup (both null without one).
   * @param {string} userId
   * @param {string|null} matchup
   * @returns {Promise<{ options: OptionsPayload|null, oppOptions: OptionsPayload|null }>}
   */
  async _optionsFor(userId, matchup) {
    if (!matchup) return { options: null, oppOptions: null };
    const [options, oppOptions] = await Promise.all([
      this.options.forMatchup(userId, matchup),
      this.options.forOpponent(userId, matchup),
    ]);
    return { options, oppOptions };
  }

  /**
   * A confirmable key: an option of the game's matchup (the detector's build
   * when it is one), the game's randomizer roll, or the user's live custom
   * build fitting the matchup (saved after the options were cached).
   * @param {string} userId
   * @param {Record<string, any>} row
   * @param {string|null} matchup
   * @param {OptionsPayload|null} options
   * @param {unknown} key
   * @returns {Promise<BuildRef|null>}
   */
  async _resolveConfirmKey(userId, row, matchup, options, key) {
    const parsed = parseBuildKey(key);
    if (!options || !parsed) return null;
    const option = options.builds.find((b) => b.key === key);
    if (option) return { key: option.key, name: option.name, slug: option.slug, source: option.source };
    const roll = asBuildRef(row.buildIntent && row.buildIntent.randomizer);
    if (roll && roll.key === key) return roll;
    if (parsed.source !== "custom") return null;
    const resolved = await this.options.resolveForUser(userId, key);
    return resolved && fitsMatchup(resolved, matchup) ? resolved.ref : null;
  }

  /**
   * An opponent key this game can take: an opponent option, a fitting live
   * opponent-perspective custom build, or the game's current correction
   * (re-sending it is idempotent even after that build was deleted).
   * @param {string} userId
   * @param {Record<string, any>} row
   * @param {string|null} matchup
   * @param {string} key
   * @returns {Promise<BuildRef|null>}
   */
  async _resolveOpponentKey(userId, row, matchup, key) {
    if (!matchup || !parseBuildKey(key)) return null;
    const current = asBuildRef(row.buildIntent && row.buildIntent.opponent && row.buildIntent.opponent.build);
    if (current && current.key === key) return current;
    return this.options.resolveOpponentKey(userId, matchup, key);
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
   * What the opponent suggestion of a single-game read needs: the
   * opponent-perspective rules, and whether the opponent's events are worth
   * a detail read (no detected option, no correction, some build has rules).
   * @param {string} userId
   * @param {Record<string, any>} row
   * @param {string} matchup
   * @param {OptionsPayload} oppOptions
   */
  async _opponentSuggestionInput(userId, row, matchup, oppOptions) {
    const customRules = oppOptions.builds.some((b) => b.source === "custom")
      ? await this.options.customRules(userId, matchup, "opponent")
      : new Map();
    const detected = detectedOpponentOption(opponentDetectorView(row), oppOptions.builds);
    const wantEvents = !detected
      && !opponentOverrideActive(row)
      && [...customRules.values()].some((set) => set.rules.length > 0);
    return { customRules, wantEvents };
  }

  /**
   * The opponent suggestion from the detector label alone (pending list,
   * PUT responses).
   * @param {Record<string, any>} row
   * @param {OptionsPayload|null} oppOptions
   * @returns {Suggestion|null}
   */
  _labelOnlyOpponentSuggestion(row, oppOptions) {
    if (!oppOptions || ineligibleReason(row) !== null) return null;
    return suggestOpponent({
      game: row,
      detector: opponentDetectorView(row),
      events: null,
      builds: oppOptions.builds,
    });
  }

  /**
   * Start-time events from the detail store, per side asked for; null for a
   * side when the store is unavailable or the game has no such log.
   * @param {string} userId
   * @param {string} gameId
   * @param {{ you: boolean, opponent: boolean }} [want]
   * @returns {Promise<GameEvents>}
   */
  async readEvents(userId, gameId, want = { you: true, opponent: false }) {
    /** @type {GameEvents} */
    const none = { you: null, opponent: null };
    if (!this.perGame || typeof this.perGame._readGameWithDetails !== "function") return none;
    const fields = [...(want.you ? ["buildLog"] : []), ...(want.opponent ? ["oppBuildLog"] : [])];
    if (fields.length === 0) return none;
    try {
      const { slim, blob } = await this.perGame._readGameWithDetails(userId, gameId, { fields });
      if (!slim) return none;
      const side = (/** @type {unknown} */ lines, /** @type {"my"|"opp"} */ proxies) => {
        if (!Array.isArray(lines) || lines.length === 0) return null;
        return eventsToStartTime(
          parseBuildLogWithProxies(lines, this.perGame.catalog || null, slim.spatial, proxies),
          slim,
        );
      };
      return {
        you: want.you ? side(blob.buildLog, "my") : null,
        opponent: want.opponent ? side(blob.oppBuildLog, "opp") : null,
      };
    } catch {
      // 503 game_details_unavailable / aborts: suggest from the label alone.
      return none;
    }
  }

  /**
   * ``GameIntentState``.
   * @param {string} userId
   * @param {Record<string, any>} row
   * @param {{
   *   prefs: import('./buildIntentPrefs').CheckinPrefs,
   *   options: OptionsPayload|null,
   *   oppOptions: OptionsPayload|null,
   *   suggestion: Suggestion|null,
   *   oppSuggestion: Suggestion|null,
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
    const build = await this._buildOut(userId, intent && intent.build, "you");
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
      opponent: await this._opponentState(userId, row, ctx),
      ...(ctx.includeOptions
        ? { options: builds, usualKey: ctx.options ? ctx.options.usualKey : null }
        : {}),
    };
  }

  /**
   * The opponent axis of ``GameIntentState``; null without a matchup.
   * @param {string} userId
   * @param {Record<string, any>} row
   * @param {{ oppOptions: OptionsPayload|null, oppSuggestion: Suggestion|null, includeOptions: boolean }} ctx
   */
  async _opponentState(userId, row, ctx) {
    if (!gameMatchup(row)) return null;
    const intent = row.buildIntent && typeof row.buildIntent === "object" ? row.buildIntent : null;
    const opp = intent && intent.opponent && typeof intent.opponent === "object" ? intent.opponent : null;
    const opponent = row.opponent && typeof row.opponent === "object" ? row.opponent : {};
    const view = opponentDetectorView(row);
    const label = opponentDetectorLabel(view);
    const builds = ctx.oppOptions ? ctx.oppOptions.builds : [];
    const build = await this._buildOut(userId, opp && opp.build, "opponent");
    return {
      label: typeof opponent.strategy === "string" ? opponent.strategy : null,
      status: opp && opp.status === "confirmed" ? "confirmed" : "none",
      build,
      applied: Boolean(opp && opp.applied === true),
      detected: {
        name: view.strategy,
        slug: view.customStrategySlug,
        key: detectedOptionKey(label, builds),
      },
      suggestion: ctx.oppSuggestion,
      executed: build ? executedFor(build, label) : null,
      ...(ctx.includeOptions ? { options: builds } : {}),
    };
  }

  /**
   * A stored BuildRef for output, flagged ``deleted`` when its custom build
   * of that side is gone (the check-in stays frozen on it).
   * @param {string} userId
   * @param {unknown} value
   * @param {"you"|"opponent"} side
   * @returns {Promise<(BuildRef & { deleted?: boolean })|null>}
   */
  async _buildOut(userId, value, side) {
    const ref = asBuildRef(/** @type {any} */ (value));
    if (ref && ref.source === "custom" && ref.slug
      && !(await this.options.customBuildExists(userId, ref.slug, side))) {
      return { ...ref, deleted: true };
    }
    return ref;
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
