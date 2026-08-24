"use strict";

const { randomUUID } = require("crypto");
const { COLLECTIONS, LIMITS } = require("../config/constants");
const { expectedVersion, stampVersion } = require("../db/schemaVersioning");
const { HEAVY_FIELDS } = require("./gameDetails");
const {
  OPPONENT_BUILD_ORDER_WRITE_LEASE_FIELD,
  OPPONENT_BUILD_ORDER_WRITE_LEASE_MS,
  OPPONENT_BUILD_ORDER_WRITE_RENEW_MS,
  OPPONENT_BUILD_ORDER_WRITE_RETRY_MS,
  OPPONENT_BUILD_ORDER_WRITE_ACQUIRE_TIMEOUT_MS,
  CLASSIFIER_WRITE_SENTINEL,
  opponentBuildOrderBusyError,
  opponentBuildOrderClassificationQueueError,
} = require("./opponentBuildOrderFence");
const { toStartSeconds, isFinishTimeEvent } = require("./buildDurations");
const { gamesMatchStage } = require("../util/parseQuery");

const {
  KNOWN_BUILDING_NAMES,
  isKnownBuilding,
  isKnownUpgrade,
} = require("./knownBuildings");

const BUILD_LOG_LINE_RE = /^\[(\d+):(\d{2})\]\s+(.+?)\s*$/;
const BUILD_LOG_NOISE_RE = /^(Beacon|Reward|Spray)/;

/** @param {number} ms */
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestAbortError() {
  const err = new Error("request_aborted");
  err.name = "AbortError";
  return err;
}

/**
 * Cutoff (inclusive, in seconds) the agent used when it shipped a
 * separate ``earlyBuildLog`` field. Now that the agent (v0.4.3+)
 * stops sending the early variant — see the storage trim in the
 * v0.4.3 CHANGELOG — services derive the same window from the full
 * log on read using this cutoff. Kept module-level so the value is
 * defined exactly once and matches the agent's
 * ``build_log_lines(events, cutoff_seconds=300)``.
 */
const EARLY_BUILD_LOG_CUTOFF_SEC = 300;

/**
 * Filter a stored build-log to its first 5 minutes. Mirrors what the
 * agent used to compute and send as ``earlyBuildLog`` / ``oppEarlyBuildLog``
 * before v0.4.3.
 *
 * @param {string[] | undefined | null} fullLog
 * @returns {string[]}
 */
function deriveEarlyBuildLog(fullLog) {
  if (!Array.isArray(fullLog) || fullLog.length === 0) return [];
  const out = [];
  for (const line of fullLog) {
    const m = BUILD_LOG_LINE_RE.exec(String(line || ""));
    if (!m) continue;
    const sec = Number.parseInt(m[1], 10) * 60 + Number.parseInt(m[2], 10);
    if (sec > EARLY_BUILD_LOG_CUTOFF_SEC) break;
    out.push(line);
  }
  return out;
}

/**
 * Read the early build-log from the game doc if v0.4.x stored it,
 * else derive from the full log. Lets us drop the redundant field
 * from new uploads without breaking older docs.
 *
 * @param {{ buildLog?: string[], earlyBuildLog?: string[] }} game
 * @returns {string[]}
 */
function readEarlyBuildLog(game) {
  if (!game) return [];
  if (Array.isArray(game.earlyBuildLog) && game.earlyBuildLog.length > 0) {
    return game.earlyBuildLog;
  }
  return deriveEarlyBuildLog(game.buildLog);
}

/**
 * Same logic, opponent perspective.
 *
 * @param {{ oppBuildLog?: string[], oppEarlyBuildLog?: string[] }} game
 * @returns {string[]}
 */
function readOppEarlyBuildLog(game) {
  if (!game) return [];
  if (
    Array.isArray(game.oppEarlyBuildLog)
    && game.oppEarlyBuildLog.length > 0
  ) {
    return game.oppEarlyBuildLog;
  }
  return deriveEarlyBuildLog(game.oppBuildLog);
}

/**
 * PerGameComputeService — operates on a single stored game document.
 *
 * Build-order parsing is pure JavaScript so it never needs Python on
 * the server: the agent already uploaded `buildLog`, `oppBuildLog`,
 * etc. as part of the game record. APM curves and macro breakdowns
 * are stored alongside the game when the agent computed them locally;
 * if absent, the route handler can request a recompute via Socket.io
 * (see `requestAgentRecompute`).
 *
 * Reasoning:
 *   - We never store the .SC2Replay binary in Mongo — too expensive
 *     and a privacy footgun. The agent has the file, so it owns the
 *     "recompute" path.
 *   - When the agent uploads a game, it sends the structured outputs
 *     (build log lines + macro breakdown JSON if available). The
 *     server only ever serves what's already in the document.
 */
class PerGameComputeService {
  /**
   * @param {{games: import('mongodb').Collection}} db
   * @param {{
   *   catalog?: { lookup: (name: string) => object | null },
   *   gameDetails?: import('./gameDetails').GameDetailsService,
   *   onOpponentBuildOrderWritten?: (userId: string, gameId: string) => void|Promise<void>,
   *   users?: import('mongodb').Collection,
   * }} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.catalog = opts.catalog || null;
    // ``gameDetails`` may be omitted in narrow unit tests that only
    // care about the catalog lookup or the rule-preview cursor.
    // Production wiring (see ``app.js``) always provides it.
    this.gameDetails = opts.gameDetails || null;
    this.onOpponentBuildOrderWritten = opts.onOpponentBuildOrderWritten || null;
    this.users = opts.users || null;
  }

  /**
   * Read a game's heavy blob from the gameDetails store with a
   * back-compat fallback to the inline copy on the games doc. While
   * the v0.4.3 cutover migration is in flight, some legacy games
   * still have ``buildLog`` / ``oppBuildLog`` / ``macroBreakdown`` /
   * ``apmCurve`` inline; reading the slim row gives us those for
   * free. Once the $unset cleanup migration runs, the inline copies
   * are gone and this method serves entirely from the store.
   *
   * @private
   * @param {string} userId
   * @param {string} gameId
   * @param {{ slim?: object | null, fields?: string[], signal?: AbortSignal } | undefined} [opts]
   *        when the caller already loaded the slim games doc, pass
   *        it through to avoid a second findOne.
   * @returns {Promise<{ slim: any | null, blob: Record<string, any> }>}
   */
  async _readGameWithDetails(userId, gameId, opts = {}) {
    /** @type {string[]} */
    const fields = Array.isArray(opts.fields) && opts.fields.length > 0
      ? opts.fields.filter((field) => HEAVY_FIELDS.includes(field))
      : [...HEAVY_FIELDS];
    /** @type {Record<string, 0|1>} */
    const slimProjection = {
      _id: 0,
      gameId: 1,
      myBuild: 1,
      myRace: 1,
      map: 1,
      result: 1,
      "opponent.displayName": 1,
      "opponent.race": 1,
      "opponent.strategy": 1,
    };
    for (const field of fields) slimProjection[field] = 1;
    const [slim, fromStore] = await Promise.all([
      opts.slim !== undefined
        ? Promise.resolve(opts.slim)
        : this.db.games.findOne(
          { userId, gameId },
          { projection: slimProjection },
        ),
      this.gameDetails
        ? this.gameDetails.findOne(userId, gameId, {
          fields,
          signal: opts.signal,
        })
        : Promise.resolve(null),
    ]);
    /** @type {Record<string, any>} */
    const blob = {};
    // Detail-store wins when it has a value (it's authoritative
    // post-cutover); the slim row supplies the legacy fallback.
    /** @type {Array<any>} */
    const sources = [slim, fromStore];
    for (const k of fields) {
      for (const src of sources) {
        if (src && src[k] !== undefined) {
          blob[k] = src[k];
          break;
        }
      }
    }
    return { slim, blob };
  }

  /**
   * Return the parsed build-order timeline for a single game.
   *
   * @param {string} userId
   * @param {string} gameId
   * @returns {Promise<object | null>}
   */
  async buildOrder(userId, gameId) {
    const { slim, blob } = await this._readGameWithDetails(userId, gameId, {
      fields: ["buildLog", "oppBuildLog"],
    });
    if (!slim) return null;
    // Merge so ``readEarlyBuildLog`` / ``readOppEarlyBuildLog`` see
    // a single object with the build-log fields populated, regardless
    // of whether they came from the slim row or the detail store.
    const merged = { ...slim, ...blob };
    // The agent stores recorded times — start for non-morph
    // structures, finish for units / morphs / upgrades. The
    // BuildOrderTimeline UI presents construction-START times
    // ("the moment the player commanded this") which is what
    // players naturally reason about. ``eventsToStartTime`` rewinds
    // the finish-time entries using the build-duration catalog so
    // every row in the timeline answers the same question.
    //
    // The raw events are NOT modified for ML or rule evaluation
    // surfaces — those continue to operate on recorded timestamps
    // so existing user-saved custom builds and built-in detection
    // rules keep their calibration.
    const buildLogPresent = Array.isArray(merged.buildLog)
      && merged.buildLog.length > 0;
    const oppBuildLogPresent = Array.isArray(merged.oppBuildLog)
      && merged.oppBuildLog.length > 0;
    const rawEvents = parseBuildLogLines(merged.buildLog || [], this.catalog);
    const rawEarly = parseBuildLogLines(readEarlyBuildLog(merged), this.catalog);
    const rawOpp = parseBuildLogLines(merged.oppBuildLog || [], this.catalog);
    const rawOppEarly = parseBuildLogLines(
      readOppEarlyBuildLog(merged),
      this.catalog,
    );
    // Diagnostic reason codes for the UI's empty state. ``not_extracted``
    // = the agent hasn't uploaded a build log for this side yet (the
    // common case when the user is on an older agent for opponent
    // builds, or hasn't Resync'd at all). ``empty`` = the agent
    // uploaded a buildLog but parsing produced zero events — almost
    // always a malformed / pre-game-only replay. ``ok`` = events
    // present.
    return {
      ok: true,
      game_id: slim.gameId,
      my_build: slim.myBuild || null,
      my_race: slim.myRace || null,
      opp_strategy: slim.opponent?.strategy || null,
      opponent: slim.opponent?.displayName || null,
      opp_race: slim.opponent?.race || null,
      map: slim.map || null,
      result: slim.result || null,
      events: eventsToStartTime(rawEvents),
      early_events: eventsToStartTime(rawEarly),
      opp_events: eventsToStartTime(rawOpp),
      opp_early_events: eventsToStartTime(rawOppEarly),
      my_status: diagBuildStatus(buildLogPresent, rawEvents.length),
      opp_status: diagBuildStatus(oppBuildLogPresent, rawOpp.length),
    };
  }

  /**
   * Return the stored macro breakdown for a game. Returns null when
   * the agent hasn't uploaded one yet — caller decides whether to
   * 404 or queue a recompute request.
   *
   * @param {string} userId
   * @param {string} gameId
   */
  /**
   * Map-playback payload for the vespene-style replayer. Lives in the
   * per-game detail blob (uploaded by agents that compute it); games
   * from older agents 404 with ``not_computed`` so the SPA can show a
   * "re-sync with the latest agent" hint instead of an empty canvas.
   *
   * @param {string} userId
   * @param {string} gameId
   */
  async mapPlayback(userId, gameId) {
    const slim = await this.db.games.findOne(
      { userId, gameId },
      { projection: { _id: 0, gameId: 1, map: 1, durationSec: 1, myRace: 1 } },
    );
    if (!slim) return null;
    const { blob } = await this._readGameWithDetails(userId, gameId, {
      slim,
      fields: ["mapPlayback"],
    });
    const playback = blob.mapPlayback || null;
    if (!playback) return { ok: false, code: "not_computed" };
    return { ok: true, ...playback };
  }

  /**
   * @param {string} userId
   * @param {string} gameId
   */
  async macroBreakdown(userId, gameId) {
    // The slim row carries macroScore + race + durationSec; the
    // detail blob carries the macroBreakdown payload itself. Fetch
    // both — the projection on the slim row keeps Mongo's network
    // cost minimal even though _readGameWithDetails normally pulls
    // the full doc.
    const slim = await this.db.games.findOne(
      { userId, gameId },
      {
        projection: {
          _id: 0,
          macroBreakdown: 1,
          macroScore: 1,
          myRace: 1,
          durationSec: 1,
          gameId: 1,
        },
      },
    );
    if (!slim) return null;
    const { blob } = await this._readGameWithDetails(userId, gameId, {
      slim,
      fields: ["macroBreakdown"],
    });
    const breakdown = blob.macroBreakdown || slim.macroBreakdown || null;
    if (!breakdown) return { ok: false, code: "not_computed" };
    return {
      ok: true,
      macro_score: slim.macroScore || null,
      race: slim.myRace || null,
      game_length_sec: slim.durationSec || 0,
      ...breakdown,
    };
  }

  /**
   * Return the stored APM curve. Schema:
   *   apmCurve: {
   *     window_sec: number,
   *     has_data: boolean,
   *     players: Array<{ name, race, samples: Array<{t, apm, spm}> }>
   *   }
   *
   * @param {string} userId
   * @param {string} gameId
   */
  async apmCurve(userId, gameId) {
    const slim = await this.db.games.findOne(
      { userId, gameId },
      {
        projection: {
          _id: 0,
          apmCurve: 1,
          gameId: 1,
          durationSec: 1,
        },
      },
    );
    if (!slim) return null;
    const { blob } = await this._readGameWithDetails(userId, gameId, {
      slim,
      fields: ["apmCurve"],
    });
    const curve = blob.apmCurve || slim.apmCurve || null;
    if (!curve) return { ok: false, code: "not_computed" };
    return {
      ok: true,
      game_id: slim.gameId,
      game_length_sec: slim.durationSec || 0,
      window_sec: curve.window_sec || 30,
      has_data: !!curve.has_data,
      players: Array.isArray(curve.players) ? curve.players : [],
    };
  }

  /**
   * Persist a recomputed macro breakdown (called after the agent
   * re-uploads). Updates `macroScore`, `top_3_leaks`, and the slim
   * breakdown blob.
   *
   * @param {string} userId
   * @param {string} gameId
   * @param {{
   *   macroScore: number,
   *   top3Leaks?: object[],
   *   breakdown: object,
   * }} payload
   */
  async writeMacroBreakdown(userId, gameId, payload) {
    if (!payload || typeof payload.macroScore !== "number") {
      throw new Error("macroScore required");
    }
    // Slim-row update keeps the surface fields the Recent Games table
    // and aggregations read directly: macroScore + top3Leaks for
    // hover cards. The macroBreakdown blob itself goes to the detail
    // store. ``$unset`` removes any legacy inline copy from games
    // — the cutover is incremental: each recompute flips one game.
    /** @type {Record<string, any>} */
    const set = { macroScore: payload.macroScore };
    if (Array.isArray(payload.top3Leaks)) {
      set.top3Leaks = payload.top3Leaks;
    }
    stampVersion(set, COLLECTIONS.GAMES);
    await this.db.games.updateOne(
      { userId, gameId },
      { $set: set, $unset: { macroBreakdown: "" } },
    );
    if (this.gameDetails) {
      const slim = await this.db.games.findOne(
        { userId, gameId },
        { projection: { _id: 0, date: 1 } },
      );
      const date = slim && slim.date instanceof Date
        ? slim.date
        : new Date();
      await this.gameDetails.upsert(userId, gameId, date, {
        macroBreakdown: payload.breakdown || {},
      });
    }
  }

  /**
   * Persist a recomputed APM curve.
   *
   * @param {string} userId
   * @param {string} gameId
   * @param {object} curve
   */
  async writeApmCurve(userId, gameId, curve) {
    if (!curve || typeof curve !== "object") throw new Error("curve required");
    // Bump the slim row's _schemaVersion + $unset any legacy inline
    // apmCurve so the on-disk row shrinks the next time WiredTiger
    // compacts. The curve itself moves to the detail store.
    /** @type {Record<string, any>} */
    const set = {};
    stampVersion(set, COLLECTIONS.GAMES);
    await this.db.games.updateOne(
      { userId, gameId },
      { $set: set, $unset: { apmCurve: "" } },
    );
    if (this.gameDetails) {
      const slim = await this.db.games.findOne(
        { userId, gameId },
        { projection: { _id: 0, date: 1 } },
      );
      const date = slim && slim.date instanceof Date
        ? slim.date
        : new Date();
      await this.gameDetails.upsert(userId, gameId, date, { apmCurve: curve });
    }
  }

  /**
   * Persist a recomputed opponent build log (mirrors the legacy
   * POST /games/:gameId/opp-build-order endpoint).
   *
   * @param {string} userId
   * @param {string} gameId
   * @param {{ oppBuildLog: string[], oppEarlyBuildLog?: string[] }} payload
   * @param {{signal?: AbortSignal}} [opts]
   */
  async writeOpponentBuildOrder(userId, gameId, payload, opts = {}) {
    if (!payload || !Array.isArray(payload.oppBuildLog)) {
      throw new Error("oppBuildLog required");
    }
    const oppBuildLog = payload.oppBuildLog.slice(0, 5000);
    const writeToken = randomUUID();
    const leasePath = OPPONENT_BUILD_ORDER_WRITE_LEASE_FIELD;
    const acquireDeadline = Date.now()
      + OPPONENT_BUILD_ORDER_WRITE_ACQUIRE_TIMEOUT_MS;
    let acquired = null;
    // Serialize writers for one game across every API process. Waiting here
    // avoids two R2 optimistic merges racing to replace the same field, while
    // the expiry lets a later request recover a process that died mid-write.
    while (!acquired) {
      if (this.users) {
        const user = await this.users.findOne(
          { userId, _gdprMutation: { $exists: false } },
          { projection: { _id: 1 } },
        );
        if (!user) throw opponentBuildOrderBusyError();
      }
      const now = new Date();
      acquired = await this.db.games.findOneAndUpdate(
        {
          userId,
          gameId,
          $or: [
            { [leasePath]: { $exists: false } },
            { [`${leasePath}.leaseUntil`]: { $lte: now } },
            { [`${leasePath}.leaseUntil`]: { $exists: false } },
          ],
        },
        {
          $set: {
            _schemaVersion: expectedVersion(COLLECTIONS.GAMES),
            _customBuildRevision: randomUUID(),
            _customBuildClassificationSequence: CLASSIFIER_WRITE_SENTINEL,
            [leasePath]: {
              id: writeToken,
              leaseUntil: new Date(
                now.getTime() + OPPONENT_BUILD_ORDER_WRITE_LEASE_MS,
              ),
            },
          },
          $unset: {
            oppBuildLog: "",
            oppEarlyBuildLog: "",
            _customBuildReclassify: "",
          },
        },
        {
          projection: { _id: 0, date: 1 },
          returnDocument: "after",
        },
      );
      if (acquired) break;
      if (opts.signal && opts.signal.aborted) throw requestAbortError();
      const existing = await this.db.games.findOne(
        { userId, gameId },
        { projection: { _id: 1 } },
      );
      if (!existing) throw new Error("game_not_found");
      if (Date.now() >= acquireDeadline) throw opponentBuildOrderBusyError();
      await wait(OPPONENT_BUILD_ORDER_WRITE_RETRY_MS);
    }

    // Close the check/acquire race: a GDPR operation may claim its durable
    // user fence immediately after our first lookup. Release this lease and
    // refuse external detail I/O in that case.
    if (this.users) {
      const stillAllowed = await this.users.findOne(
        { userId, _gdprMutation: { $exists: false } },
        { projection: { _id: 1 } },
      );
      if (!stillAllowed) {
        await this.db.games.updateOne(
          { userId, gameId, [`${leasePath}.id`]: writeToken },
          { $set: { _customBuildRevision: randomUUID() }, $unset: {
            [leasePath]: "",
            _customBuildClassificationSequence: "",
            _customBuildReclassify: "",
          } },
        );
        throw opponentBuildOrderBusyError();
      }
    }

    const detailController = new AbortController();
    const abortDetails = () => detailController.abort();
    if (opts.signal) opts.signal.addEventListener("abort", abortDetails, { once: true });
    /** @type {Promise<void>|null} */
    let renewalPromise = null;
    let leaseLost = false;
    const renew = () => {
      if (renewalPromise) return renewalPromise;
      renewalPromise = (async () => {
        const renewed = await this.db.games.updateOne(
          { userId, gameId, [`${leasePath}.id`]: writeToken },
          {
            $set: {
              [`${leasePath}.leaseUntil`]: new Date(
                Date.now() + OPPONENT_BUILD_ORDER_WRITE_LEASE_MS,
              ),
            },
          },
        );
        if (renewed.matchedCount === 0) {
          leaseLost = true;
          detailController.abort();
        }
      })().finally(() => {
        renewalPromise = null;
      });
      return renewalPromise;
    };
    const assertDetailLease = async () => {
      await renew();
      if (leaseLost || detailController.signal.aborted) {
        throw opponentBuildOrderBusyError();
      }
    };
    const renewTimer = setInterval(() => {
      void renew().catch(() => {
        // External detail I/O is allowed only while ownership is provable.
        // Aborting on a transient Mongo failure is safer than letting an old
        // writer outlive its lease and overwrite a successor's R2 object.
        leaseLost = true;
        detailController.abort();
      });
    }, OPPONENT_BUILD_ORDER_WRITE_RENEW_MS);
    if (typeof renewTimer.unref === "function") renewTimer.unref();
    try {
      if (this.gameDetails) {
        const date = acquired.date instanceof Date
          ? acquired.date
          : new Date();
        await this.gameDetails.upsert(
          userId,
          gameId,
          date,
          { oppBuildLog },
          { signal: detailController.signal, assertLease: assertDetailLease },
        );
        if (leaseLost) throw opponentBuildOrderBusyError();
        const stillOwner = await this.db.games.findOne(
          { userId, gameId, [`${leasePath}.id`]: writeToken },
          { projection: { _id: 1 } },
        );
        if (!stillOwner) throw opponentBuildOrderBusyError();
      }
    } finally {
      clearInterval(renewTimer);
      if (opts.signal) opts.signal.removeEventListener("abort", abortDetails);
      // Owner-CAS is critical after expiry: a delayed old writer may finish
      // after another process has acquired the row, but it cannot release the
      // new owner's fence or rotate its revision.
      const released = await this.db.games.updateOne(
        { userId, gameId, [`${leasePath}.id`]: writeToken },
        {
          $set: {
            _schemaVersion: expectedVersion(COLLECTIONS.GAMES),
            _customBuildRevision: randomUUID(),
          },
          $unset: {
            oppBuildLog: "",
            oppEarlyBuildLog: "",
            _customBuildReclassify: "",
            _customBuildClassificationSequence: "",
            [leasePath]: "",
          },
        },
      );
      if (released.matchedCount === 0) throw opponentBuildOrderBusyError();
    }
    if (this.onOpponentBuildOrderWritten) {
      try {
        await this.onOpponentBuildOrderWritten(userId, gameId);
      } catch (err) {
        // Detail upserts are idempotent. Tell the agent to retry until the
        // durable all-build job is successfully coalesced; returning success
        // here could leave the new opponent log classified with stale rules.
        throw opponentBuildOrderClassificationQueueError(err);
      }
    }
  }

  /**
   * Iterate the user's games for rule-based preview matching. Returns
   * lightweight {gameId, parsedEvents, myBuild, myRace, oppRace, ...}
   * tuples suitable for a server-side rules evaluator. Pulls only the
   * fields the evaluator needs (buildLog, oppBuildLog, race, current
   * bucket).
   *
   * Filtering is intentionally permissive: we always return up to
   * `limit` of the user's most recent games and let the route layer
   * decide which ones the rules apply to. The previous implementation
   * used a strict regex on `myRace` / `opponent.race`, which silently
   * excluded games where those fields were missing or stored in a
   * different shape (legacy imports, older agent versions). Returning
   * both my-events AND opp-events lets the route honour the build's
   * perspective without a second query.
   *
   * ``filters`` — optional global-filter-bar object (since / until /
   * race / oppRace / map / mmr range / regions / excludeTooShort).
   * When present, the userId-scoped Mongo $match is built via
   * ``gamesMatchStage`` so the caller honours the same time-frame /
   * matchup / region scoping the "All games" list uses. Unscoped
   * callers (legacy preview, dossier) keep the userId-only behaviour
   * by omitting it.
   *
   * ``match`` is an optional cohort push-down merged on top of the
   * filter-bar match. Callers that already know the matchup — the
   * StrategiesTab build × strategy drill-down passes ``myBuild`` and
   * ``opponent.strategy`` for example — push their predicate down
   * here so the ``limit`` cap applies to the *matching* set instead
   * of the user's full recent window. Without push-down, a user with
   * more than ``limit`` games would see the analysis cohort silently
   * shrink to whichever fraction of their most-recent ``limit`` games
   * happened to satisfy the post-filter, even if many more matching
   * games exist further back.
   *
   * @param {string} userId
   * @param {{
   *   limit?: number,
   *   includeMacroBreakdown?: boolean,
   *   filters?: ReturnType<typeof import('../util/parseQuery').parseFilters>,
   *   match?: Record<string, any>,
   * }} [opts]
   * @returns {Promise<Array<{
   *   gameId: string,
   *   myBuild: string|null,
   *   myRace: string|null,
   *   oppRace: string|null,
   *   opponent: { displayName?: string, race?: string, strategy?: string }|null,
   *   durationSec: number|null,
   *   events: any[],
   *   oppEvents: any[],
   *   result: string|null,
   *   date: Date|null,
   *   map: string|null,
   *   macroBreakdown?: object|null,
   * }>>}
   */
  async listForRulePreview(userId, opts = {}) {
    const limit = Math.max(1, Math.min(2000, Number(opts.limit) || 600));
    const includeMacroBreakdown = !!opts.includeMacroBreakdown;
    // Build the base match from the global filter bar (if any), then
    // merge the optional cohort push-down on top. The two are
    // orthogonal: filters narrow by timeframe / race / map / region;
    // match narrows by build / opponent.strategy. Combined, the
    // ``limit`` cap applies to games that satisfy both — which is what
    // the StrategiesTab build × strategy comparison view needs.
    const baseMatch = opts.filters
      ? gamesMatchStage(userId, opts.filters)
      : { userId, isResumedFromReplay: { $ne: true } };
    const extraMatch =
      opts.match && typeof opts.match === "object" && !Array.isArray(opts.match)
        ? opts.match
        : null;
    /** @type {Record<string, number>} */
    const projection = {
      _id: 0,
      gameId: 1,
      myBuild: 1,
      myRace: 1,
      "opponent.displayName": 1,
      "opponent.race": 1,
      "opponent.strategy": 1,
      // Legacy fallback: pre-v0.4.3 docs still have these
      // inline. Once the cleanup migration runs, the projection
      // returns ``undefined`` and we serve from the detail
      // store via the readMany call below.
      buildLog: 1,
      oppBuildLog: 1,
      result: 1,
      date: 1,
      map: 1,
      durationSec: 1,
      macroScore: 1,
      apm: 1,
      spq: 1,
    };
    if (includeMacroBreakdown) {
      // Legacy fallback: a few pre-v0.4.3 docs still carry
      // ``macroBreakdown`` inline. Project it so we can hand it back
      // without a detail-store round trip when present. Post-migration
      // it's ``undefined`` and the value comes from the detail blob.
      projection.macroBreakdown = 1;
    }
    // Slim metadata first — needed for both legacy fallback and the
    // gameId list we'll batch-fetch detail blobs for. ``userId`` is
    // always the most selective predicate; extra match keys are merged
    // on top so a downstream {myBuild, "opponent.strategy"} pair gets
    // pushed into the same indexed find rather than filtered in memory.
    const filter = extraMatch
      ? {
        ...baseMatch,
        ...extraMatch,
        isResumedFromReplay: { $ne: true },
      }
      : baseMatch;
    const games = await this.db.games
      .find(filter, { projection })
      .sort({ date: -1 })
      .limit(limit)
      .toArray();
    // Identify games that need a detail-store lookup — anything
    // missing buildLog/oppBuildLog inline (or, when the caller asked
    // for macroBreakdown, missing that too). With the slim-only schema
    // this will be every game; with legacy docs still on disk it's
    // the post-migration ones.
    const needDetails = [];
    for (const g of games) {
      const missingLogs =
        !Array.isArray(g.buildLog) || !Array.isArray(g.oppBuildLog);
      const missingMacro =
        includeMacroBreakdown && !g.macroBreakdown;
      if (missingLogs || missingMacro) {
        needDetails.push(String(g.gameId || ""));
      }
    }
    const detailFields = ["buildLog", "oppBuildLog"];
    if (includeMacroBreakdown) detailFields.push("macroBreakdown");
    const blobs = this.gameDetails && needDetails.length > 0
      ? await this.gameDetails.findMany(userId, needDetails.filter(Boolean), {
        fields: detailFields,
        concurrency: 4,
      })
      : new Map();
    return games.map(
      /** @param {any} g @returns {any} */ (g) => {
        const gid = String(g.gameId || "");
        const blob = blobs.get(gid) || {};
        const buildLog = Array.isArray(g.buildLog)
          ? g.buildLog
          : Array.isArray(blob.buildLog) ? blob.buildLog : [];
        const oppBuildLog = Array.isArray(g.oppBuildLog)
          ? g.oppBuildLog
          : Array.isArray(blob.oppBuildLog) ? blob.oppBuildLog : [];
        /** @type {Record<string, any>} */
        const out = {
          gameId: gid,
          myBuild: g.myBuild || null,
          myRace: g.myRace || null,
          oppRace: g.opponent ? g.opponent.race || null : null,
          opponent: g.opponent || null,
          durationSec: typeof g.durationSec === "number" ? g.durationSec : null,
          macroScore: typeof g.macroScore === "number" ? g.macroScore : null,
          apm: typeof g.apm === "number" ? g.apm : null,
          spq: typeof g.spq === "number" ? g.spq : null,
          buildLog,
          oppBuildLog,
          // Custom-build rules are authored against the start-time
          // timeline the user sees, so the preview / reclassify rule
          // evaluator must match against start-time events too. We
          // apply ``eventsToStartTime`` here (the single rule-eval
          // event source) so every downstream caller automatically
          // sees the right semantic.
          events: eventsToStartTime(parseBuildLogLines(buildLog, this.catalog)),
          oppEvents: eventsToStartTime(
            parseBuildLogLines(oppBuildLog, this.catalog),
          ),
          result: g.result || null,
          date: g.date || null,
          map: g.map || null,
        };
        if (includeMacroBreakdown) {
          out.macroBreakdown = g.macroBreakdown || blob.macroBreakdown || null;
        }
        return out;
      },
    );
  }

  /**
   * Cursor-page rule-evaluation inputs while retaining only one small detail
   * page. The metadata predicate runs before detail hydration; perspective
   * selects the sole build-log side a caller needs.
   *
   * @param {string} userId
   * @param {{limit?: number, pageSize?: number, perspective?: "you"|"opponent"|"both", includeMacroBreakdown?: boolean, filters?: object, match?: Record<string, any>, metadataFilter?: (game: any) => boolean, signal?: AbortSignal, strictDetails?: boolean, tolerateCorruptDetails?: boolean}} [opts]
   * @returns {AsyncGenerator<{games: any[], candidates: number, hasMore: boolean}>}
   */
  async *iterateRulePreviewPages(userId, opts = {}) {
    const requestedLimit = Number(opts.limit);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.floor(requestedLimit)
      : Number.POSITIVE_INFINITY;
    // Metadata rows are slim, so a moderate cursor page keeps Mongo efficient.
    // Heavy detail is intentionally hydrated one replay at a time below; a
    // count-only page bound is not a memory bound when one valid replay body
    // can approach the ingest limit.
    const pageSize = Math.max(1, Math.min(50, Number(opts.pageSize) || 50));
    const perspective = opts.perspective === "opponent"
      ? "opponent"
      : opts.perspective === "both" ? "both" : "you";
    const includeMacroBreakdown = !!opts.includeMacroBreakdown;
    const baseMatch = opts.filters
      ? gamesMatchStage(userId, opts.filters)
      : { userId, isResumedFromReplay: { $ne: true } };
    const extraMatch = opts.match && typeof opts.match === "object"
      && !Array.isArray(opts.match) ? opts.match : null;
    const filter = extraMatch
      ? { ...baseMatch, ...extraMatch, isResumedFromReplay: { $ne: true } }
      : baseMatch;
    const logFields = perspective === "both"
      ? ["buildLog", "oppBuildLog"]
      : [perspective === "opponent" ? "oppBuildLog" : "buildLog"];
    /** @type {Record<string, number>} */
    const projection = {
      _id: 1,
      gameId: 1,
      myBuild: 1,
      _customBuildRevision: 1,
      _customBuildSlug: 1,
      _customOpponentStrategySlug: 1,
      _opponentBuildOrderWriteLease: 1,
      myRace: 1,
      "opponent.displayName": 1,
      "opponent.race": 1,
      "opponent.strategy": 1,
      result: 1,
      date: 1,
      map: 1,
      durationSec: 1,
      macroScore: 1,
      apm: 1,
      spq: 1,
    };
    // Do not include legacy inline heavy fields in the metadata page. They are
    // read as a one-row fallback below only when the detail store lacks that
    // replay, preventing N large inline logs from being retained together.

    let consumed = 0;
    /** @type {{date: Date|null, id: any}|null} */
    let cursor = null;
    while (consumed < limit) {
      if (opts.signal && opts.signal.aborted) return;
      const take = Math.min(pageSize, limit - consumed);
      /** @type {Record<string, any>} */
      let pageFilter = filter;
      if (cursor) {
        const before = cursor.date !== null
          ? { $or: [
            { date: { $lt: cursor.date } },
            { date: cursor.date, _id: { $lt: cursor.id } },
            ...lowerLegacyDateTypeBranches(cursor.date),
            { date: null },
          ] }
          : { date: null, _id: { $lt: cursor.id } };
        pageFilter = { $and: [filter, before] };
      }
      const fetched = await this.db.games
        .find(pageFilter, { projection })
        .sort({ date: -1, _id: -1 })
        .limit(take + 1)
        .toArray();
      if (opts.signal && opts.signal.aborted) return;
      const hasMore = fetched.length > take;
      const rows = fetched.slice(0, take);
      if (rows.length === 0) return;
      consumed += rows.length;
      const tail = rows[rows.length - 1];
      cursor = {
        // Preserve the raw BSON value. Old imports may carry an ISO string;
        // Mongo's comparison order is deterministic across BSON types, while
        // coercing a string to null would skip the rest of that cohort.
        date: tail.date === undefined ? null : tail.date,
        id: tail._id,
      };
      const metadataFilter = opts.metadataFilter;
      const gated = typeof metadataFilter === "function"
        ? rows.filter((g) => metadataFilter(g))
        : rows;
      const detailFields = [...logFields];
      if (includeMacroBreakdown) detailFields.push("macroBreakdown");
      if (gated.length === 0) {
        yield { games: [], candidates: rows.length, hasMore };
      }
      for (let index = 0; index < gated.length; index += 1) {
        if (opts.signal && opts.signal.aborted) return;
        const g = gated[index];
        const gid = String(g.gameId || "");
        /** @type {Record<string, any>} */
        let blob = {};
        if (this.gameDetails && gid) {
          const one = await this.gameDetails.findMany(userId, [gid], {
            fields: detailFields,
            concurrency: 1,
            strict: opts.strictDetails === true,
            tolerateCorruptObjects: opts.tolerateCorruptDetails === true,
            signal: opts.signal,
          });
          blob = one.get(gid) || {};
        }
        if (opts.signal && opts.signal.aborted) return;
        // Pre-cutover games may carry the selected fields only on the slim
        // document. Fetch that fallback one row at a time and only when the
        // detail store did not provide every required field.
        const needsLegacy = detailFields.some((field) => (
          field === "macroBreakdown"
            ? !blob[field] || typeof blob[field] !== "object"
            : !Array.isArray(blob[field])
        ));
        /** @type {Record<string, any>} */
        let legacy = {};
        if (needsLegacy && gid) {
          /** @type {Record<string, number>} */
          const legacyProjection = { _id: 0 };
          for (const field of detailFields) legacyProjection[field] = 1;
          legacy = await this.db.games.findOne(
            { userId, gameId: gid },
            {
              projection: legacyProjection,
              ...(opts.signal ? { signal: opts.signal } : {}),
            },
          ) || {};
        }
        if (opts.signal && opts.signal.aborted) return;
        const buildLog = Array.isArray(blob.buildLog)
          ? blob.buildLog
          : Array.isArray(legacy.buildLog) ? legacy.buildLog : [];
        const oppBuildLog = Array.isArray(blob.oppBuildLog)
          ? blob.oppBuildLog
          : Array.isArray(legacy.oppBuildLog) ? legacy.oppBuildLog : [];
        const detailAvailableYou = Array.isArray(blob.buildLog)
          || Array.isArray(legacy.buildLog);
        const detailAvailableOpponent = Array.isArray(blob.oppBuildLog)
          || Array.isArray(legacy.oppBuildLog);
        /** @type {Record<string, any>} */
        const out = {
          gameId: gid,
          myBuild: g.myBuild || null,
          customBuildRevision: typeof g._customBuildRevision === "string"
            ? g._customBuildRevision
            : null,
          customBuildSlug: typeof g._customBuildSlug === "string"
            ? g._customBuildSlug
            : null,
          customOpponentStrategySlug:
            typeof g._customOpponentStrategySlug === "string"
              ? g._customOpponentStrategySlug
              : null,
          opponentBuildOrderWriteLease:
            g._opponentBuildOrderWriteLease
              && typeof g._opponentBuildOrderWriteLease === "object"
              ? {
                  id: String(g._opponentBuildOrderWriteLease.id || ""),
                  leaseUntil: g._opponentBuildOrderWriteLease.leaseUntil || null,
                }
              : null,
          myRace: g.myRace || null,
          oppRace: g.opponent ? g.opponent.race || null : null,
          opponent: g.opponent || null,
          durationSec: typeof g.durationSec === "number" ? g.durationSec : null,
          macroScore: typeof g.macroScore === "number" ? g.macroScore : null,
          apm: typeof g.apm === "number" ? g.apm : null,
          spq: typeof g.spq === "number" ? g.spq : null,
          buildLog,
          oppBuildLog,
          events: perspective === "opponent" ? []
            : eventsToStartTime(parseBuildLogLines(buildLog, this.catalog)),
          oppEvents: perspective === "you" ? []
            : eventsToStartTime(parseBuildLogLines(oppBuildLog, this.catalog)),
          result: g.result || null,
          date: g.date || null,
          map: g.map || null,
          detailAvailableYou,
          detailAvailableOpponent,
        };
        out.detailAvailable = perspective === "both"
          ? detailAvailableYou && detailAvailableOpponent
          : perspective === "you" ? detailAvailableYou : detailAvailableOpponent;
        if (includeMacroBreakdown) {
          out.macroBreakdown = blob.macroBreakdown
            || legacy.macroBreakdown
            || null;
        }
        // Attribute the slim metadata page's candidate count exactly once;
        // callers can retain their existing progress math while each yielded
        // page owns at most one replay's raw logs and parsed event arrays.
        yield {
          games: [out],
          candidates: index === 0 ? rows.length : 0,
          hasMore: hasMore || index < gated.length - 1,
        };
      }
      if (!hasMore) return;
    }
  }
}

/**
 * Mongo range predicates compare only within the cursor value's BSON type.
 * Historical imports may store ISO date strings (or numeric epochs), while
 * current rows use BSON Date. Descending scans therefore need explicit lower
 * BSON-type branches when crossing from Date -> string -> number -> null.
 * @param {unknown} value
 * @returns {Array<Record<string, any>>}
 */
function lowerLegacyDateTypeBranches(value) {
  if (value instanceof Date) {
    return [
      { date: { $type: "string" } },
      { date: { $type: ["double", "int", "long", "decimal"] } },
    ];
  }
  if (typeof value === "string") {
    return [{ date: { $type: ["double", "int", "long", "decimal"] } }];
  }
  return [];
}

/**
 * MacroBackfillService — coordinates a per-user "recompute macro for
 * games missing it" pass. The cloud doesn't own the .SC2Replay files
 * so the actual computation happens on the agent: this service
 * (a) finds the games that still need a breakdown, and (b) emits a
 * Socket.io request asking the user's agent to recompute and
 * re-upload them.
 */
class MacroBackfillService {
  /**
   * @param {{
   *   games: import('mongodb').Collection,
   *   macroJobs: import('mongodb').Collection,
   * }} db
   * @param {{ io?: import('socket.io').Server }} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.io = opts.io || null;
  }

  /**
   * @param {string} userId
   * @param {{ limit?: number, force?: boolean, reason?: string }} [opts]
   */
  async start(userId, opts = {}) {
    const force = !!opts.force;
    const limit = clampPositive(opts.limit, 0);
    /** @type {Record<string, any>} */
    const filter = { userId, isResumedFromReplay: { $ne: true } };
    // "Needs macro" is detected via the slim row's macroScore — score
    // and breakdown travel together, and post-v0.4.3 the breakdown
    // blob never sits on the slim row (it's $unset on every upsert),
    // so the old `macroBreakdown: {$exists: false}` filter matched
    // EVERY game and a non-force backfill recomputed the whole
    // history.
    if (!force) filter.macroScore = { $exists: false };
    const candidatesCursor = this.db.games
      .find(filter, { projection: { _id: 0, gameId: 1 } })
      .sort({ date: -1 });
    if (limit > 0) candidatesCursor.limit(limit);
    const gameIds = (await candidatesCursor.toArray()).map(
      /** @param {any} g */ (g) => g.gameId,
    );
    const job = {
      userId,
      kind: "macro",
      status: gameIds.length === 0 ? "done" : "pending",
      total: gameIds.length,
      done: 0,
      updated: 0,
      errors: 0,
      remaining: gameIds.slice(),
      startedAt: new Date(),
      finishedAt: gameIds.length === 0 ? new Date() : null,
      lastMessage: gameIds.length === 0 ? "no_games_need_recompute" : "",
    };
    stampVersion(job, COLLECTIONS.MACRO_JOBS);
    const res = await this.db.macroJobs.insertOne(job);
    const jobId = String(res.insertedId);
    if (gameIds.length > 0 && this.io) {
      this.io.to(`user:${userId}`).emit("macro:recompute_request", {
        jobId,
        gameIds,
      });
      // When the user explicitly forces a backfill (e.g. clicked
      // "Request resync" on a Map Intel surface to populate spatial
      // extracts), ALSO emit the dedicated full-resync event. The
      // per-game request only acts on the agent's path_by_game_id
      // index — which is empty on agent state files written before
      // v0.4 and so silently no-ops for users with older uploads.
      // The full-resync event drops the agent's uploaded cursor and
      // re-walks every watched replay folder, ensuring the next
      // sweep re-uploads with the latest extracts attached. Targeted
      // recomputes (force=false) still flow through the per-game
      // path so a single missing macroBreakdown doesn't trigger a
      // multi-thousand-replay walk.
      if (force) {
        this.io.to(`user:${userId}`).emit("resync:request", {
          jobId,
          reason:
            typeof opts.reason === "string" && opts.reason
              ? opts.reason
              : "macro_backfill_force",
        });
      }
    }
    return { jobId, total: gameIds.length, status: job.status };
  }

  /**
   * Mark progress reported by the agent (one game at a time).
   *
   * @param {string} userId
   * @param {string} jobId
   * @param {{ gameId: string, ok: boolean, message?: string }} payload
   */
  async reportProgress(userId, jobId, payload) {
    const { ObjectId } = require("mongodb");
    let _id;
    try {
      _id = new ObjectId(jobId);
    } catch (_e) {
      throw new Error("invalid_job_id");
    }
    /** @type {Record<string, any>} */
    const update = {
      $inc: { done: 1, ...(payload.ok ? { updated: 1 } : { errors: 1 }) },
      $pull: { remaining: payload.gameId },
      $set: {
        lastMessage:
          (payload.ok ? "ok " : "err ") + (payload.message || payload.gameId),
      },
    };
    const before = await this.db.macroJobs.findOne({ _id, userId });
    if (!before) throw new Error("job_not_found");
    const remainingAfter = (before.remaining || []).filter(
      /** @param {string} g */ (g) => g !== payload.gameId,
    );
    if (remainingAfter.length === 0) {
      update.$set.status = "done";
      update.$set.finishedAt = new Date();
    }
    await this.db.macroJobs.updateOne({ _id, userId }, update);
  }

  /**
   * @param {string} userId
   * @param {string} jobId
   */
  async status(userId, jobId) {
    const { ObjectId } = require("mongodb");
    let _id;
    try {
      _id = new ObjectId(jobId);
    } catch (_e) {
      return null;
    }
    return this.db.macroJobs.findOne(
      { _id, userId },
      { projection: { _id: 0, remaining: 0 } },
    );
  }

  /**
   * @param {string} userId
   */
  async latest(userId) {
    return this.db.macroJobs
      .find({ userId }, { projection: { _id: 0, remaining: 0 } })
      .sort({ startedAt: -1 })
      .limit(LIMITS.MACRO_JOB_HISTORY)
      .toArray();
  }

}

/**
 * Strip noisy lines (sprays, rewards, beacons) and parse each
 * `[m:ss] Name` line into a structured event. Mirrors
 * `parseBuildLogLines` from the legacy analyzer.js so the SPA's
 * BuildOrderTimeline component renders identical data.
 *
 * Returns events at their **recorded** time (the timestamp the agent
 * stored). Most surfaces use this as-is for rule evaluation and ML
 * training. Display surfaces that want construction-START times call
 * ``eventsToStartTime`` to remap ``time``/``time_display`` without
 * re-parsing — this keeps the rule evaluator semantics rock-stable
 * across the start-time UI rollout.
 *
 * @param {string[]} lines
 * @param {{ lookup: (name: string) => object | null } | null} [catalog]
 */
function parseBuildLogLines(lines, catalog) {
  /** @type {Array<{time: number, time_display: string, name: string, display: string, race: string, category: string, tier: number, is_building: boolean, comp: any}>} */
  const events = [];
  if (!Array.isArray(lines)) return events;
  for (const line of lines) {
    const m = BUILD_LOG_LINE_RE.exec(String(line || ""));
    if (!m) continue;
    const minutes = Number.parseInt(m[1], 10);
    const seconds = Number.parseInt(m[2], 10);
    const rawName = m[3].trim();
    if (BUILD_LOG_NOISE_RE.test(rawName)) continue;
    /** @type {any} */
    let entry = null;
    if (catalog && typeof catalog.lookup === "function") {
      try {
        entry = catalog.lookup(rawName);
      } catch (_e) {
        entry = null;
      }
    }
    // Buildings classification falls back to the local known-buildings
    // set when the catalog file isn't loaded or doesn't recognise the
    // name. Without this, the macro-breakdown Buildings roster reads
    // empty for cold-start requests and for any deployment where the
    // ``data/sc2_catalog.json`` file isn't on disk.
    const isBuilding = entry && entry.isBuilding != null
      ? !!entry.isBuilding
      : isKnownBuilding(rawName);
    // Upgrades fall back to the same catalog-independent path so the
    // macro-breakdown Upgrades chip row, the BuildOrderTimeline upgrade
    // tier, the "Save as new build order" flow, and the custom-build
    // editor all see ``category: "upgrade"`` on every research event —
    // even when the catalog JSON is absent. Without this, every upgrade
    // event got tagged ``category: "unknown"`` and the downstream
    // ``ev.category === "upgrade"`` filters silently dropped them.
    const isUpgradeFallback = !isBuilding && isKnownUpgrade(rawName);
    const category = entry
      ? entry.category
      : (isBuilding ? "building" : (isUpgradeFallback ? "upgrade" : "unknown"));
    events.push({
      time: minutes * 60 + seconds,
      time_display: `${minutes}:${String(seconds).padStart(2, "0")}`,
      name: rawName,
      display: entry ? entry.display : rawName,
      race: entry ? entry.race : "Neutral",
      category,
      tier: entry ? entry.tier : 0,
      is_building: isBuilding,
      comp: entry ? entry.comp || null : null,
    });
  }
  events.sort((a, b) => a.time - b.time);
  return events;
}

/**
 * Map a list of parsed events into construction-start time. Re-uses
 * the same ``buildDurations`` lookup ``firstOccurrenceSeconds`` does,
 * so display surfaces (build-order timeline, dossier preview) stay
 * consistent without duplicating the offset table.
 *
 * For finish-time events (upgrades, units, structure morphs) the
 * recorded ``time`` IS the completion timestamp, so it's preserved on
 * the output as ``complete_time``. The macro-breakdown roster
 * (``countUpgradesAt`` in compositionAt.ts) needs this to only show an
 * upgrade once its research has actually completed — using the rewound
 * start time made every upgrade pop into the chip row at the moment
 * the player clicked Research, well before the buff actually applied.
 *
 * Pure: input is unchanged, output is a fresh array sorted by the
 * adjusted time.
 *
 * @param {Array<ReturnType<typeof parseBuildLogLines>[number]>} events
 */
function eventsToStartTime(events) {
  if (!Array.isArray(events) || events.length === 0) return [];
  const out = events.map((ev) => {
    const hints = {
      isBuilding: !!ev.is_building,
      category: ev.category,
    };
    const startSec = Math.round(toStartSeconds(ev.name, ev.time, hints));
    const m = Math.floor(startSec / 60);
    const s = startSec - m * 60;
    const completeTime = isFinishTimeEvent(ev.name, hints) ? ev.time : undefined;
    return {
      ...ev,
      time: startSec,
      time_display: `${m}:${String(s).padStart(2, "0")}`,
      ...(completeTime != null ? { complete_time: completeTime } : {}),
    };
  });
  out.sort((a, b) => a.time - b.time);
  return out;
}

/**
 * @param {unknown} raw
 * @param {number} fallback
 */
function clampPositive(raw, fallback) {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw || ""), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/**
 * Reason code for the build-order UI's empty state. Lets the frontend
 * distinguish "agent never uploaded this side's build log" from
 * "uploaded but parsed to zero events" so the help text in each empty
 * card can be specific instead of the same generic "no build" line.
 *
 * @param {boolean} hadLog
 * @param {number} eventCount
 * @returns {"ok" | "empty" | "not_extracted"}
 */
function diagBuildStatus(hadLog, eventCount) {
  if (eventCount > 0) return "ok";
  if (hadLog) return "empty";
  return "not_extracted";
}

module.exports = {
  PerGameComputeService,
  MacroBackfillService,
  parseBuildLogLines,
  eventsToStartTime,
  // Exported so other services (dnaTimings, ml) consume the same
  // derivation logic instead of each rolling their own filter.
  deriveEarlyBuildLog,
  readEarlyBuildLog,
  readOppEarlyBuildLog,
  // Exported for tests + cross-service reuse — the macro/build flow
  // wants the same fallback classification regardless of catalog state.
  isKnownBuilding,
  KNOWN_BUILDING_NAMES,
  EARLY_BUILD_LOG_CUTOFF_SEC,
};
