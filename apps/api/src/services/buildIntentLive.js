"use strict";

/**
 * Build check-in live records (``build_intent_live``), one per live game key:
 * registration from the agent's live envelopes, the OBS randomizer hold,
 * pre-game declarations, randomizer rolls and post-game answers, until the
 * replay upload binds the record to a game (``gameId``). A bound record is
 * read-only: every later write answers 409 ``already_bound``.
 *
 * Races are authoritative from the envelope; request bodies only fill fields
 * the record does not have yet.
 */

const { BUILD_INTENT, COLLECTIONS } = require("../config/constants");
const { expectedVersion } = require("../db/schemaVersioning");
const { sanitizeNotes } = require("./buildIntentShape");
const { randomizerPool, readBuildIntentPrefs } = require("./buildIntentPrefs");
const {
  BuildIntentError,
  normalizeRace,
  matchupFromRaces,
  isValidGameKey,
  keyStartedAtMs,
  playerNamesFromKey,
  provenanceFromAuth,
  holdRemainingMs,
  overlayPayload,
  isDuplicateKeyError,
} = require("./buildIntentCommon");

const REGISTER_PHASES = new Set(["match_loading", "match_started"]);
const ROLL_PHASES = new Set(["match_loading", "match_started", "match_in_progress"]);
const BUILD_ID_MAX_LENGTH = 200;

/** Aggregation expression: "PvZ" from the stored races, else null. */
const MATCHUP_EXPR = Object.freeze({
  $let: {
    vars: {
      mine: { $substrCP: [{ $ifNull: ["$myRace", ""] }, 0, 1] },
      theirs: { $substrCP: [{ $ifNull: ["$oppRace", ""] }, 0, 1] },
    },
    in: {
      $cond: [
        {
          $and: [
            { $in: ["$$mine", ["P", "T", "Z"]] },
            { $in: ["$$theirs", ["P", "T", "Z"]] },
          ],
        },
        { $concat: ["$$mine", "v", "$$theirs"] },
        null,
      ],
    },
  },
});

/**
 * Pipeline expression marking the hold decided and released.
 * @param {Date} now
 */
function releasedHoldExpr(now) {
  return {
    $mergeObjects: [
      { $ifNull: ["$hold", { untilMs: null, decidedAt: now }] },
      { released: true },
    ],
  };
}

/**
 * @param {unknown} name
 * @returns {string|null}
 */
function cleanOppName(name) {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  return trimmed ? trimmed.slice(0, BUILD_INTENT.OPP_NAME_MAX_LENGTH) : null;
}

/**
 * @typedef {{ myRace: string|null, oppRace: string|null, oppName: string|null }} LiveFields
 */

/**
 * Registration fields of an agent envelope, or null when the envelope does
 * not register a live game (wrong phase, replay, no game key, no opponent).
 * @param {unknown} envelope
 * @returns {(LiveFields & { gameKey: string }) | null}
 */
function registrationFields(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return null;
  const env = /** @type {Record<string, any>} */ (envelope);
  if (!REGISTER_PHASES.has(env.phase) || env.isReplay === true) return null;
  const gameKey = env.gameKey;
  if (typeof gameKey !== "string" || !gameKey || gameKey.length > BUILD_INTENT.GAME_KEY_MAX_LENGTH) {
    return null;
  }
  const opponent = env.opponent;
  if (!opponent || typeof opponent !== "object" || Array.isArray(opponent)) return null;
  const user = env.user && typeof env.user === "object" ? env.user : {};
  return {
    gameKey,
    myRace: normalizeRace(user.race),
    oppRace: normalizeRace(opponent.race),
    oppName: cleanOppName(opponent.name),
  };
}

/**
 * @param {Record<string, any>|null|undefined} ref
 * @param {boolean} withVia
 */
function liveRef(ref, withVia) {
  if (!ref || typeof ref !== "object" || typeof ref.key !== "string") return null;
  return {
    key: ref.key,
    name: String(ref.name || ""),
    slug: typeof ref.slug === "string" ? ref.slug : null,
    source: ref.source === "custom" ? "custom" : "catalog",
    at: ref.at instanceof Date ? ref.at : null,
    ...(withVia ? { via: ref.via === "agent" ? "agent" : "web" } : {}),
  };
}

/** Bounded insertion-ordered map used as a small LRU. */
class BoundedMap {
  /** @param {number} max */
  constructor(max) {
    this.max = max;
    /** @type {Map<string, any>} */
    this.map = new Map();
  }

  /** @param {string} key */
  get(key) {
    return this.map.get(key);
  }

  /** @param {string} key @param {any} value */
  set(key, value) {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (typeof oldest !== "string") break;
      this.map.delete(oldest);
    }
  }
}

class BuildIntentLive {
  /**
   * @param {{
   *   db: { buildIntentLive: import('mongodb').Collection<any>, users: import('mongodb').Collection },
   *   broker?: import('./liveGameBroker').LiveGameBroker|null,
   *   options: import('./buildIntentOptions').BuildIntentOptions,
   *   notifier: import('./buildIntentCommon').BuildIntentNotifier,
   *   overlayTokens: import('mongodb').Collection,
   *   now?: () => number,
   * }} deps
   */
  constructor(deps) {
    this.collection = deps.db.buildIntentLive;
    this.users = deps.db.users;
    this.broker = deps.broker || null;
    this.options = deps.options;
    this.notifier = deps.notifier;
    this.overlayTokens = deps.overlayTokens;
    this.now = deps.now || Date.now;
    // Last registration written per user: identical envelopes (the agent
    // posts ~1 Hz) skip the write.
    this.registrations = new BoundedMap(BUILD_INTENT.REGISTRATION_CACHE_MAX_ENTRIES);
    // Accepted randomizer roll reports per user + game key.
    this.rollReports = new BoundedMap(BUILD_INTENT.ROLL_TRACKER_MAX_ENTRIES);
  }

  /**
   * Register (or refresh) the live record of an agent envelope. Envelope
   * races and opponent name win over earlier values. Decides the randomizer
   * hold once the matchup is concrete.
   *
   * @param {string} userId
   * @param {unknown} envelope
   * @returns {Promise<Record<string, any>|null>}
   */
  async registerFromEnvelope(userId, envelope) {
    const fields = registrationFields(envelope);
    if (!fields) return null;
    const signature = JSON.stringify([fields.gameKey, fields.myRace, fields.oppRace, fields.oppName]);
    if (this.registrations.get(userId) === signature) return null;
    let doc;
    try {
      doc = await this._upsert(userId, fields.gameKey, fields, true);
    } catch (err) {
      if (err instanceof BuildIntentError) return null;
      throw err;
    }
    doc = await this._maybeDecideHold(userId, doc);
    this.registrations.set(userId, signature);
    return doc;
  }

  /**
   * ``PUT /v1/build-intents/live/:gameKey``.
   *
   * @param {string} userId
   * @param {string} gameKey validated by the caller
   * @param {{ action: string, buildKey?: string, notes?: string, skip?: boolean,
   *   myRace?: string|null, oppRace?: string|null, oppName?: string|null }} body
   * @param {{ source?: string }} auth
   */
  async put(userId, gameKey, body, auth) {
    const { via } = provenanceFromAuth(auth);
    const fields = {
      myRace: normalizeRace(body.myRace),
      oppRace: normalizeRace(body.oppRace),
      oppName: cleanOppName(body.oppName),
    };
    switch (body.action) {
      case "register":
        return this._register(userId, gameKey, fields);
      case "declare":
        return this._declare(userId, gameKey, fields, body.buildKey, via);
      case "undeclare":
        return this._write(userId, gameKey, fields, { declared: null }, { overlay: true });
      case "release":
        return this._write(userId, gameKey, fields, {
          hold: releasedHoldExpr(new Date(this.now())),
        }, { overlay: true });
      case "postgame":
        return this._postgame(userId, gameKey, fields, body, via);
      default:
        throw new BuildIntentError(400, "invalid_action", "Unknown action.");
    }
  }

  /**
   * ``GET /v1/build-intents/live/:gameKey``.
   * @param {string} userId
   * @param {string} gameKey
   */
  async get(userId, gameKey) {
    const doc = await this.collection.findOne({ userId, gameKey });
    return doc ? this._state(userId, doc) : null;
  }

  /**
   * The overlay payload for the broker's current game, when it has a live
   * record (replayed to overlay sockets on connect / resync).
   * @param {string} userId
   */
  async overlayStateForCurrentGame(userId) {
    const gameKey = this.broker ? this.broker.currentGameKey(userId) : null;
    if (!gameKey) return null;
    const doc = await this.collection.findOne(
      { userId, gameKey },
      { projection: { _id: 0, gameKey: 1, declared: 1, randomizer: 1, hold: 1 } },
    );
    return doc ? overlayPayload(doc, this.now()) : null;
  }

  /**
   * ``overlay:randomizer:rolled`` from an overlay socket. Every check fails
   * closed and silently: the token must still be active with the randomizer
   * widget on, the report must be for the broker's current game in an
   * active phase, and the build must be in that matchup's pool and resolve
   * on the server. The first accepted roll wins.
   *
   * @param {string} userId
   * @param {string} token
   * @param {unknown} payload
   */
  async handleRandomizerRoll(userId, token, payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    const { gameKey, buildId } = /** @type {Record<string, unknown>} */ (payload);
    if (!isValidGameKey(gameKey) || typeof buildId !== "string") return;
    if (buildId.length === 0 || buildId.length > BUILD_ID_MAX_LENGTH) return;
    const key = /** @type {string} */ (gameKey);
    if (!this.broker || this.broker.currentGameKey(userId) !== key) return;
    const latest = /** @type {Record<string, any>|null} */ (this.broker.latest(userId));
    if (!latest || !ROLL_PHASES.has(String(latest.phase))) return;
    const tokenRow = await this.overlayTokens.findOne(
      { userId, token, revokedAt: null },
      { projection: { _id: 0, enabledWidgets: 1 } },
    );
    if (!tokenRow || !Array.isArray(tokenRow.enabledWidgets)
      || !tokenRow.enabledWidgets.includes("randomizer")) return;
    const reportKey = `${userId}\u0000${key}`;
    const reports = Number(this.rollReports.get(reportKey) || 0);
    if (reports >= BUILD_INTENT.ROLL_MAX_WRITES) return;
    this.rollReports.set(reportKey, reports + 1);

    let doc = await this.collection.findOne({ userId, gameKey: key });
    if (doc && (doc.randomizer || doc.gameId)) return;
    const matchup = (doc && doc.matchup)
      || matchupFromRaces(normalizeRace(latest.user?.race), normalizeRace(latest.opponent?.race));
    if (!matchup) return;
    const prefs = await readBuildIntentPrefs(this.users, userId);
    const pool = randomizerPool(prefs.randomizer, matchup);
    if (!pool.enabled || !pool.ids.includes(buildId)) return;
    const ref = await this.options.resolveKey(userId, matchup, buildId);
    if (!ref) return;
    if (!doc) {
      const fields = registrationFields(latest);
      try {
        doc = await this._upsert(userId, key, fields || { myRace: null, oppRace: null, oppName: null }, false);
      } catch (err) {
        if (err instanceof BuildIntentError) return;
        throw err;
      }
    }
    const now = new Date(this.now());
    const updated = await this.collection.findOneAndUpdate(
      { userId, gameKey: key, gameId: null, randomizer: null },
      {
        $set: {
          randomizer: { ...ref, at: now, verifiedPool: true },
          expiresAt: new Date(now.getTime() + BUILD_INTENT.LIVE_ANSWERED_TTL_MS),
          updatedAt: now,
        },
      },
      { returnDocument: "after" },
    );
    if (!updated) return;
    this.options.invalidate(userId);
    if (updated.declared) await this.notifier.overlay(userId, overlayPayload(updated, this.now()));
    this.notifier.changed(userId, { gameKey: key });
  }

  /**
   * @param {string} userId
   * @param {string} gameKey
   * @param {LiveFields} fields
   */
  async _register(userId, gameKey, fields) {
    let doc = await this._upsert(userId, gameKey, fields, false);
    doc = await this._maybeDecideHold(userId, doc);
    this.options.invalidate(userId);
    return this._state(userId, doc);
  }

  /**
   * @param {string} userId
   * @param {string} gameKey
   * @param {LiveFields} fields
   * @param {unknown} buildKey
   * @param {"agent"|"web"} via
   */
  async _declare(userId, gameKey, fields, buildKey, via) {
    const latest = /** @type {Record<string, any>|null} */ (
      this.broker ? this.broker.latest(userId) : null
    );
    if (
      latest
      && latest.gameKey === gameKey
      && typeof latest.displayTime === "number"
      && latest.displayTime > BUILD_INTENT.DECLARE_WINDOW_SEC
    ) {
      throw new BuildIntentError(409, "declare_window_closed", "The game is too far in to check in a plan.");
    }
    const doc = await this._upsert(userId, gameKey, fields, false);
    if (!doc.matchup) {
      throw new BuildIntentError(409, "matchup_unknown", "The matchup is not known yet.");
    }
    const ref = await this.options.resolveKey(userId, doc.matchup, buildKey);
    if (!ref) throw new BuildIntentError(400, "unknown_build", "Unknown build for this matchup.");
    const now = new Date(this.now());
    return this._write(userId, gameKey, fields, {
      declared: { $literal: { ...ref, at: now, via } },
      hold: releasedHoldExpr(now),
      expiresAt: new Date(now.getTime() + BUILD_INTENT.LIVE_ANSWERED_TTL_MS),
    }, { overlay: true, existing: doc });
  }

  /**
   * @param {string} userId
   * @param {string} gameKey
   * @param {LiveFields} fields
   * @param {{ buildKey?: string, notes?: string, skip?: boolean }} body
   * @param {"agent"|"web"} via
   */
  async _postgame(userId, gameKey, fields, body, via) {
    const skip = body.skip === true;
    const hasKey = typeof body.buildKey === "string";
    if (skip === hasKey) {
      throw new BuildIntentError(400, "invalid_request", "Send either buildKey or skip: true.");
    }
    /** @type {string|null} */
    let notes = null;
    if (body.notes !== undefined) {
      notes = sanitizeNotes(body.notes);
      if (notes === null) throw new BuildIntentError(400, "invalid_notes", "Notes are limited to 1000 characters.");
    }
    const doc = await this._upsert(userId, gameKey, fields, false);
    /** @type {string|null} */
    let resolvedKey = null;
    if (hasKey) {
      if (doc.matchup) {
        const ref = await this.options.resolveKey(userId, doc.matchup, body.buildKey);
        resolvedKey = ref ? ref.key : null;
      } else {
        // The matchup can still be unknown (Random); the bind checks the fit.
        const resolved = await this.options.resolveForUser(userId, body.buildKey);
        resolvedKey = resolved ? resolved.ref.key : null;
      }
      if (!resolvedKey) throw new BuildIntentError(400, "unknown_build", "Unknown build.");
    }
    const now = new Date(this.now());
    return this._write(userId, gameKey, fields, {
      postgame: { $literal: { buildKey: resolvedKey, skip, notes, at: now, via } },
      expiresAt: new Date(now.getTime() + BUILD_INTENT.LIVE_ANSWERED_TTL_MS),
    }, { overlay: false, existing: doc });
  }

  /**
   * Apply ``set`` (pipeline ``$set`` expressions) to an unbound record,
   * creating it from ``fields`` first when needed.
   *
   * @param {string} userId
   * @param {string} gameKey
   * @param {LiveFields} fields
   * @param {Record<string, unknown>} set
   * @param {{ overlay: boolean, existing?: Record<string, any> }} opts
   */
  async _write(userId, gameKey, fields, set, opts) {
    const doc = opts.existing || await this._upsert(userId, gameKey, fields, false);
    const now = new Date(this.now());
    const updated = await this.collection.findOneAndUpdate(
      { _id: doc._id, gameId: null },
      [{ $set: { ...set, updatedAt: now } }],
      { returnDocument: "after" },
    );
    if (!updated) throw await this._alreadyBound(userId, gameKey);
    this.options.invalidate(userId);
    if (opts.overlay) await this.notifier.overlay(userId, overlayPayload(updated, this.now()));
    this.notifier.changed(userId, { gameKey });
    return this._state(userId, updated);
  }

  /**
   * Create the unbound record, or update it: ``overwrite`` replaces races
   * and opponent name with non-null ``fields`` (envelope data), otherwise
   * they only fill missing values (request bodies).
   *
   * @param {string} userId
   * @param {string} gameKey
   * @param {LiveFields} fields
   * @param {boolean} overwrite
   * @returns {Promise<Record<string, any>>}
   */
  async _upsert(userId, gameKey, fields, overwrite) {
    const now = new Date(this.now());
    /** @param {string} name @param {string|null} value */
    const field = (name, value) => {
      if (value === null) return { $ifNull: [`$${name}`, null] };
      return overwrite ? { $literal: value } : { $ifNull: [`$${name}`, { $literal: value }] };
    };
    const pipeline = [
      {
        $set: {
          createdAt: { $ifNull: ["$createdAt", now] },
          expiresAt: { $ifNull: ["$expiresAt", new Date(now.getTime() + BUILD_INTENT.LIVE_TTL_MS)] },
          keyStartedAtMs: { $ifNull: ["$keyStartedAtMs", { $literal: keyStartedAtMs(gameKey) }] },
          playerNames: { $ifNull: ["$playerNames", { $literal: playerNamesFromKey(gameKey) }] },
          myRace: field("myRace", fields.myRace),
          oppRace: field("oppRace", fields.oppRace),
          oppName: field("oppName", fields.oppName),
          declared: { $ifNull: ["$declared", null] },
          postgame: { $ifNull: ["$postgame", null] },
          randomizer: { $ifNull: ["$randomizer", null] },
          hold: { $ifNull: ["$hold", null] },
          boundAt: { $ifNull: ["$boundAt", null] },
          updatedAt: now,
          _schemaVersion: expectedVersion(COLLECTIONS.BUILD_INTENT_LIVE),
        },
      },
      { $set: { matchup: MATCHUP_EXPR } },
    ];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const doc = await this.collection.findOneAndUpdate(
          { userId, gameKey, gameId: null },
          pipeline,
          { upsert: true, returnDocument: "after" },
        );
        if (doc) return doc;
      } catch (err) {
        // A concurrent first write inserted the record, or it is bound.
        if (!isDuplicateKeyError(err)) throw err;
      }
      const existing = await this.collection.findOne(
        { userId, gameKey },
        { projection: { _id: 0, gameId: 1 } },
      );
      if (existing && existing.gameId) throw await this._alreadyBound(userId, gameKey);
    }
    throw new Error("build_intent_live_upsert_conflict");
  }

  /**
   * @param {string} userId
   * @param {string} gameKey
   * @returns {Promise<BuildIntentError>}
   */
  async _alreadyBound(userId, gameKey) {
    const doc = await this.collection.findOne(
      { userId, gameKey },
      { projection: { _id: 0, gameId: 1 } },
    );
    if (!doc) return new BuildIntentError(404, "not_found", "Live game not found.");
    return new BuildIntentError(409, "already_bound", "This game was already uploaded.", {
      gameId: doc.gameId,
    });
  }

  /**
   * Decide the randomizer hold once, when the matchup is first concrete.
   * @param {string} userId
   * @param {Record<string, any>} doc
   * @returns {Promise<Record<string, any>>}
   */
  async _maybeDecideHold(userId, doc) {
    if (!doc || !doc.matchup || doc.hold || doc.gameId) return doc;
    const applies = await this._holdApplies(userId, doc.matchup);
    const nowMs = this.now();
    const hold = applies
      ? { untilMs: nowMs + BUILD_INTENT.HOLD_MS, released: false, decidedAt: new Date(nowMs) }
      : { untilMs: null, released: true, decidedAt: new Date(nowMs) };
    const updated = await this.collection.findOneAndUpdate(
      { _id: doc._id, gameId: null, hold: null },
      { $set: { hold, updatedAt: new Date(nowMs) } },
      { returnDocument: "after" },
    );
    if (!updated) return doc;
    await this.notifier.overlay(userId, overlayPayload(updated, this.now()));
    return updated;
  }

  /**
   * @param {string} userId
   * @param {string} matchup
   * @returns {Promise<boolean>}
   */
  async _holdApplies(userId, matchup) {
    const prefs = await readBuildIntentPrefs(this.users, userId);
    if (!prefs.checkin.enabled || !prefs.checkin.askAtLoading) return false;
    if (!randomizerPool(prefs.randomizer, matchup).enabled) return false;
    return this.notifier.hasRandomizerWidget(userId);
  }

  /**
   * ``LiveState`` for the agent and the web.
   * @param {string} userId
   * @param {Record<string, any>} doc
   */
  async _state(userId, doc) {
    const prefs = await readBuildIntentPrefs(this.users, userId);
    const matchup = typeof doc.matchup === "string" ? doc.matchup : null;
    return {
      gameKey: String(doc.gameKey),
      matchup,
      myRace: doc.myRace || null,
      oppRace: doc.oppRace || null,
      oppName: doc.oppName || null,
      declared: liveRef(doc.declared, true),
      randomizer: liveRef(doc.randomizer, false),
      randomizerEnabled: matchup ? randomizerPool(prefs.randomizer, matchup).enabled : false,
      holdRemainingMs: holdRemainingMs(doc.hold, this.now()),
      gameId: typeof doc.gameId === "string" ? doc.gameId : null,
      prefs: prefs.checkin,
    };
  }
}

module.exports = { BuildIntentLive, registrationFields, MATCHUP_EXPR };
