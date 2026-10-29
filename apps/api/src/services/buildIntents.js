"use strict";

/**
 * Build check-in ("build intent") service: the one object the routes, the
 * socket layer, the live-envelope route and the ingest route talk to.
 *
 *   options      — buildIntentOptions.js  (per-matchup build list + record,
 *                                          the user's and the opponent's)
 *   live records — buildIntentLive.js     (registration, hold, declare, roll)
 *   game state   — buildIntentGameState.js (GET/PUT on a game, pending queue)
 *   ingest bind  — buildIntentBind.js     (live record → uploaded game)
 *
 * See docs/adr/0025-build-check-in-attribution.md for why a confirmed
 * check-in rewrites the game's effective build label.
 */

const { BuildIntentOptions } = require("./buildIntentOptions");
const { BuildIntentLive } = require("./buildIntentLive");
const { BuildIntentGameState } = require("./buildIntentGameState");
const { BuildIntentBind } = require("./buildIntentBind");
const { BuildIntentNotifier } = require("./buildIntentCommon");
const { CHECKIN_PREF_TYPE, readBuildIntentPrefs } = require("./buildIntentPrefs");
const { overlayRandomizerConfig } = require("./overlayRandomizerConfig");

class BuildIntentsService {
  /**
   * @param {import('../db/connect').DbContext} db
   * @param {{
   *   io?: import('socket.io').Server|null,
   *   liveGameBroker?: import('./liveGameBroker').LiveGameBroker|null,
   *   perGame?: import('./perGameCompute').PerGameComputeService|null,
   *   logger?: import('pino').Logger|null,
   *   now?: () => number,
   *   userRevision?: import('../util/userRevision').UserRevision,
   * }} [opts]
   */
  constructor(db, opts = {}) {
    const now = opts.now || Date.now;
    this.options = new BuildIntentOptions(db, { now });
    this.notifier = new BuildIntentNotifier({
      io: opts.io || null,
      overlayTokens: db.overlayTokens,
      logger: opts.logger || null,
    });
    const shared = { db, options: this.options, notifier: this.notifier, now, userRevision: opts.userRevision };
    this.live = new BuildIntentLive({
      ...shared,
      broker: opts.liveGameBroker || null,
      overlayTokens: db.overlayTokens,
    });
    this.gameState = new BuildIntentGameState({ ...shared, perGame: opts.perGame || null });
    this.binder = new BuildIntentBind({ ...shared, perGame: opts.perGame || null });
  }

  /**
   * @param {string} userId
   * @param {string} matchup
   * @param {"you"|"opponent"} [side]
   */
  getOptions(userId, matchup, side = "you") {
    return this.options.forSide(userId, matchup, side);
  }

  /**
   * Drop the user's cached options (both sides). Called when a custom build
   * is saved or deleted, so a build created from a check-in is listed and
   * confirmable at once.
   * @param {string} userId
   */
  invalidateOptions(userId) {
    this.options.invalidate(userId);
  }

  /**
   * A preference block was replaced (``PUT /v1/me/preferences/:type``).
   * ``buildCheckin`` pings the user room with ``build-intent:changed
   * {prefs: true}`` so the agent drops its cards within one round trip;
   * ``randomizer`` changes which builds are options.
   * @param {string} userId
   * @param {string} type
   */
  preferencesChanged(userId, type) {
    if (type === CHECKIN_PREF_TYPE) {
      this.notifier.changed(userId, { prefs: true });
    } else if (type === "randomizer") {
      this.options.invalidate(userId);
      return this.overlayRandomizerConfig(userId).then((config) =>
        this.notifier.overlay(userId, { randomizer: config }, "overlay:config"));
    }
  }

  /** @param {string} userId */
  async overlayRandomizerConfig(userId) {
    const prefs = await readBuildIntentPrefs(this.live.users, userId);
    return overlayRandomizerConfig(this.options, userId, prefs.randomizer);
  }

  /**
   * @param {string} userId
   * @param {string} gameKey
   * @param {Parameters<BuildIntentLive['put']>[2]} body
   * @param {{ source?: string }} auth
   */
  putLive(userId, gameKey, body, auth) {
    return this.live.put(userId, gameKey, body, auth);
  }

  /** @param {string} userId @param {string} gameKey */
  getLive(userId, gameKey) {
    return this.live.get(userId, gameKey);
  }

  /** @param {string} userId @param {string} gameKey @param {{matchup:string,releaseHold:boolean,revealInWidget?:boolean}} body */
  rollNativeRandomizer(userId, gameKey, body) {
    return this.live.nativeRoll(userId, gameKey, body);
  }

  /** @param {string} userId @param {unknown} envelope */
  registerFromEnvelope(userId, envelope) {
    return this.live.registerFromEnvelope(userId, envelope);
  }

  /** @param {string} userId */
  overlayStateForCurrentGame(userId) {
    return this.live.overlayStateForCurrentGame(userId);
  }

  /** @param {string} userId @param {string} token @param {unknown} payload */
  handleRandomizerRoll(userId, token, payload) {
    return this.live.handleRandomizerRoll(userId, token, payload);
  }

  /**
   * @param {string} userId
   * @param {string} gameId
   * @param {{ includeOptions?: boolean }} [opts]
   */
  getGameIntent(userId, gameId, opts) {
    return this.gameState.get(userId, gameId, opts);
  }

  /**
   * @param {string} userId
   * @param {string} gameId
   * @param {Parameters<BuildIntentGameState['put']>[2]} body
   * @param {{ source?: string }} auth
   */
  putGameIntent(userId, gameId, body, auth) {
    return this.gameState.put(userId, gameId, body, auth);
  }

  /** @param {string} userId @param {number} limit */
  listPending(userId, limit) {
    return this.gameState.listPending(userId, limit);
  }

  /** @param {string} userId @param {{ source?: string }} auth */
  dismissPending(userId, auth) {
    return this.gameState.dismissPending(userId, auth);
  }

  /**
   * @param {string} userId
   * @param {Record<string, any>} game
   * @param {{ created: boolean, spatial?: unknown, statsOwner?:import('./gameStatsWrites').GameStatsOwner }} opts
   */
  bindIngestedGame(userId, game, opts) {
    return this.binder.bindIngestedGame(userId, game, opts);
  }
}

module.exports = { BuildIntentsService };
