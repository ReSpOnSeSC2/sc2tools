"use strict";

/**
 * Shared pieces of the build check-in services: the coded error the routes
 * turn into ``{error: {code, message}}``, race/matchup normalisation, live
 * game-key parsing and the realtime notifier.
 *
 * Realtime privacy: overlay rooms only ever receive
 * ``overlay:buildIntent {gameKey, suppressRandomizer, holdRemainingMs}`` and
 * the user room only ``build-intent:changed {gameKey}`` / ``{gameId}`` /
 * ``{prefs: true}`` (the ``buildCheckin`` switches changed). No build key
 * or name reaches a room an overlay token can join.
 */

const { MATCHUP_RE } = require("./buildIntentShape");
const { normalizePlayerName } = require("../util/playerName");
const { BUILD_INTENT } = require("../config/constants");

class BuildIntentError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} [message]
   * @param {Record<string, unknown>} [extra] merged into the error envelope
   */
  constructor(status, code, message, extra) {
    super(message || code);
    this.name = "BuildIntentError";
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}

const RACE_BY_TOKEN = Object.freeze(/** @type {Record<string, string>} */ ({
  p: "Protoss", prot: "Protoss", protoss: "Protoss",
  t: "Terran", terr: "Terran", terran: "Terran",
  z: "Zerg", zerg: "Zerg",
  r: "Random", rand: "Random", random: "Random",
}));

/**
 * Canonical race word, or null for unknown values ("?", "", non-strings).
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizeRace(value) {
  if (typeof value !== "string") return null;
  const token = value.trim().toLowerCase();
  return Object.hasOwn(RACE_BY_TOKEN, token) ? RACE_BY_TOKEN[token] : null;
}

/**
 * "PvZ" from two concrete races (Random or unknown → null).
 * @param {unknown} myRace
 * @param {unknown} oppRace
 * @returns {string|null}
 */
function matchupFromRaces(myRace, oppRace) {
  const mine = typeof myRace === "string" ? myRace.charAt(0).toUpperCase() : "";
  const theirs = typeof oppRace === "string" ? oppRace.charAt(0).toUpperCase() : "";
  const matchup = `${mine}v${theirs}`;
  return MATCHUP_RE.test(matchup) ? matchup : null;
}

/**
 * A stored game's matchup from ``myRace`` / ``opponent.race``.
 * @param {Record<string, any>} row
 * @returns {string|null}
 */
function gameMatchup(row) {
  const opponent = row && row.opponent && typeof row.opponent === "object" ? row.opponent : {};
  return matchupFromRaces(row && row.myRace, opponent.race);
}

/**
 * Live keys are "<sorted names>|<start ms>": the trailing segment must be
 * digits.
 * @param {unknown} gameKey
 * @returns {boolean}
 */
function isValidGameKey(gameKey) {
  if (typeof gameKey !== "string") return false;
  if (gameKey.length === 0 || gameKey.length > BUILD_INTENT.GAME_KEY_MAX_LENGTH) return false;
  const at = gameKey.lastIndexOf("|");
  return at >= 0 && /^\d+$/.test(gameKey.slice(at + 1));
}

/**
 * The agent's wall-clock ms at the first loading poll (last key segment).
 * @param {string} gameKey
 * @returns {number|null}
 */
function keyStartedAtMs(gameKey) {
  const at = gameKey.lastIndexOf("|");
  const tail = at >= 0 ? gameKey.slice(at + 1) : "";
  if (!/^\d{1,16}$/.test(tail)) return null;
  const ms = Number(tail);
  return Number.isSafeInteger(ms) ? ms : null;
}

const KEY_NAMES_MAX = 8;

/**
 * Normalised player names of a live key ("unknown" kept for a nameless key).
 * @param {string} gameKey
 * @returns {string[]}
 */
function playerNamesFromKey(gameKey) {
  const parts = gameKey.split("|");
  parts.pop();
  /** @type {string[]} */
  const names = [];
  for (const part of parts) {
    const name = normalizePlayerName(part).slice(0, BUILD_INTENT.OPP_NAME_MAX_LENGTH);
    if (name && !names.includes(name)) names.push(name);
    if (names.length >= KEY_NAMES_MAX) break;
  }
  return names;
}

/**
 * ``via``/``origin`` of a write, from the verified credential.
 * @param {{ source?: string } | undefined} auth
 * @returns {{ via: "agent"|"web", origin: "postgame"|"web" }}
 */
function provenanceFromAuth(auth) {
  return auth && auth.source === "device"
    ? { via: "agent", origin: "postgame" }
    : { via: "web", origin: "web" };
}

/**
 * Remaining hold in ms (0 once released or undecided).
 * @param {Record<string, any>|null|undefined} hold
 * @param {number} nowMs
 * @returns {number}
 */
function holdRemainingMs(hold, nowMs) {
  if (!hold || typeof hold !== "object" || hold.released === true) return 0;
  return typeof hold.untilMs === "number" ? Math.max(0, hold.untilMs - nowMs) : 0;
}

/**
 * The only payload an overlay room receives about a check-in.
 * @param {Record<string, any>} doc a build_intent_live row
 * @param {number} nowMs
 * @returns {{ gameKey: string, suppressRandomizer: boolean, holdRemainingMs: number, randomizer?: {key:string,name:string,source:string} }}
 */
function overlayPayload(doc, nowMs) {
  const declared = doc.declared && typeof doc.declared === "object" ? doc.declared : null;
  const roll = doc.randomizer && typeof doc.randomizer === "object" ? doc.randomizer : null;
  return {
    gameKey: String(doc.gameKey),
    suppressRandomizer: roll?.native === true || (Boolean(declared) && (!roll || declared.key !== roll.key)),
    holdRemainingMs: holdRemainingMs(doc.hold, nowMs),
    ...(roll?.widgetReveal === true && typeof roll.key === "string" && typeof roll.name === "string"
      ? { randomizer: { key: roll.key, name: roll.name, source: roll.source === "custom" ? "custom" : "catalog" } } : {}),
  };
}

class BuildIntentNotifier {
  /**
   * @param {{
   *   io?: import('socket.io').Server|null,
   *   overlayTokens: import('mongodb').Collection,
   *   logger?: import('pino').Logger|null,
   * }} deps
   */
  constructor(deps) {
    this.io = deps.io || null;
    this.overlayTokens = deps.overlayTokens;
    this.logger = deps.logger || null;
  }

  /**
   * Ping the user's private room: ``{gameKey}``, ``{gameId}`` or
   * ``{prefs: true}`` only.
   * @param {string} userId
   * @param {{ gameKey: string } | { gameId: string } | { prefs: true }} payload
   */
  changed(userId, payload) {
    if (!this.io) return;
    try {
      this.io.to(`user:${userId}`).emit("build-intent:changed", payload);
    } catch {
      // Realtime pings are advisory; clients also refresh on their own.
    }
  }

  /** @param {string} userId */
  gamesChanged(userId) {
    if (!this.io) return;
    try {
      this.io.to(`user:${userId}`).emit("games:changed", { count: 1, inserted: 0, bulk: false, reason: "build_intent" });
    } catch {
      // See ``changed``.
    }
  }

  /**
   * Fan ``overlay:buildIntent`` out to every active overlay token room.
   * @param {string} userId
   * @param {Record<string, any>} payload
   * @param {string} [eventName]
   */
  async overlay(userId, payload, eventName = "overlay:buildIntent") {
    if (!this.io) return;
    let tokens;
    try {
      tokens = await this.overlayTokens
        .find({ userId, revokedAt: null }, { projection: { _id: 0, token: 1 } })
        .toArray();
    } catch (err) {
      if (this.logger) {
        this.logger.warn({ errName: errorName(err) }, "build_intent_overlay_tokens_failed");
      }
      return;
    }
    for (const row of tokens) {
      if (!row || typeof row.token !== "string") continue;
      try {
        this.io.to(`overlay:${row.token}`).emit(eventName, payload);
      } catch {
        // One failed room must not stop the rest.
      }
    }
  }

  /**
   * Does any active overlay token show the randomizer widget?
   * @param {string} userId
   * @returns {Promise<boolean>}
   */
  async hasRandomizerWidget(userId) {
    const hit = await this.overlayTokens.findOne(
      { userId, revokedAt: null, enabledWidgets: "randomizer" },
      { projection: { _id: 1 } },
    );
    return Boolean(hit);
  }
}

/**
 * A log-safe error label: never the message (driver messages can echo key
 * values such as a game key).
 * @param {unknown} err
 * @returns {string}
 */
function errorName(err) {
  if (err && typeof err === "object") {
    const e = /** @type {{ code?: unknown, name?: unknown }} */ (err);
    if (typeof e.code === "string" || typeof e.code === "number") return String(e.code);
    if (typeof e.name === "string") return e.name;
  }
  return "error";
}

/** @param {unknown} err @returns {boolean} */
function isDuplicateKeyError(err) {
  return Boolean(err && typeof err === "object" && /** @type {any} */ (err).code === 11000);
}

module.exports = {
  BuildIntentError,
  BuildIntentNotifier,
  normalizeRace,
  matchupFromRaces,
  gameMatchup,
  isValidGameKey,
  keyStartedAtMs,
  playerNamesFromKey,
  provenanceFromAuth,
  holdRemainingMs,
  overlayPayload,
  errorName,
  isDuplicateKeyError,
};
