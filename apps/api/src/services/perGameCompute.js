"use strict";

const { COLLECTIONS, LIMITS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");
const { HEAVY_FIELDS } = require("./gameDetails");
const { toStartSeconds } = require("./buildDurations");

const BUILD_LOG_LINE_RE = /^\[(\d+):(\d{2})\]\s+(.+?)\s*$/;
const BUILD_LOG_NOISE_RE = /^(Beacon|Reward|Spray)/;

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
   * }} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.catalog = opts.catalog || null;
    // ``gameDetails`` may be omitted in narrow unit tests that only
    // care about the catalog lookup or the rule-preview cursor.
    // Production wiring (see ``app.js``) always provides it.
    this.gameDetails = opts.gameDetails || null;
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
   * @param {{ slim?: object | null } | undefined} [opts]
   *        when the caller already loaded the slim games doc, pass
   *        it through to avoid a second findOne.
   * @returns {Promise<{ slim: any | null, blob: Record<string, any> }>}
   */
  async _readGameWithDetails(userId, gameId, opts = {}) {
    const [slim, fromStore] = await Promise.all([
      opts.slim !== undefined
        ? Promise.resolve(opts.slim)
        : this.db.games.findOne({ userId, gameId }, { projection: { _id: 0 } }),
      this.gameDetails
        ? this.gameDetails.findOne(userId, gameId)
        : Promise.resolve(null),
    ]);
    /** @type {Record<string, any>} */
    const blob = {};
    // Detail-store wins when it has a value (it's authoritative
    // post-cutover); the slim row supplies the legacy fallback.
    const sources = [slim, fromStore];
    for (const k of HEAVY_FIELDS) {
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
    const { slim, blob } = await this._readGameWithDetails(userId, gameId);
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
    const rawEvents = parseBuildLogLines(merged.buildLog || [], this.catalog);
    const rawEarly = parseBuildLogLines(readEarlyBuildLog(merged), this.catalog);
    const rawOpp = parseBuildLogLines(merged.oppBuildLog || [], this.catalog);
    const rawOppEarly = parseBuildLogLines(
      readOppEarlyBuildLog(merged),
      this.catalog,
    );
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
    const { blob } = await this._readGameWithDetails(userId, gameId, { slim });
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
    const { blob } = await this._readGameWithDetails(userId, gameId, { slim });
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
   */
  async writeOpponentBuildOrder(userId, gameId, payload) {
    if (!payload || !Array.isArray(payload.oppBuildLog)) {
      throw new Error("oppBuildLog required");
    }
    const oppBuildLog = payload.oppBuildLog.slice(0, 5000);
    // Slim row keeps only metadata + the version stamp. The
    // ``oppBuildLog`` array moves to the detail store; legacy
    // inline copies (and the deprecated ``oppEarlyBuildLog``) are
    // $unset so each recompute incrementally trims the games doc.
    /** @type {Record<string, any>} */
    const set = {};
    stampVersion(set, COLLECTIONS.GAMES);
    await this.db.games.updateOne(
      { userId, gameId },
      {
        $set: set,
        $unset: { oppBuildLog: "", oppEarlyBuildLog: "" },
      },
    );
    if (this.gameDetails) {
      const slim = await this.db.games.findOne(
        { userId, gameId },
        { projection: { _id: 0, date: 1 } },
      );
      const date = slim && slim.date instanceof Date
        ? slim.date
        : new Date();
      await this.gameDetails.upsert(userId, gameId, date, { oppBuildLog });
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
   * @param {string} userId
   * @param {{ limit?: number }} [opts]
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
   * }>>}
   */
  async listForRulePreview(userId, opts = {}) {
    const limit = Math.max(1, Math.min(2000, Number(opts.limit) || 600));
    // Slim metadata first — needed for both legacy fallback and the
    // gameId list we'll batch-fetch detail blobs for.
    const games = await this.db.games
      .find(
        { userId },
        {
          projection: {
            _id: 0,
            gameId: 1,
            myBuild: 1,
            myRace: 1,
            opponent: 1,
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
          },
        },
      )
      .sort({ date: -1 })
      .limit(limit)
      .toArray();
    // Identify games that need a detail-store lookup — anything
    // missing buildLog/oppBuildLog inline. With the slim-only schema
    // this will be every game; with legacy docs still on disk it's
    // the post-migration ones.
    const needDetails = [];
    for (const g of games) {
      if (!Array.isArray(g.buildLog) || !Array.isArray(g.oppBuildLog)) {
        needDetails.push(String(g.gameId || ""));
      }
    }
    const blobs = this.gameDetails && needDetails.length > 0
      ? await this.gameDetails.findMany(userId, needDetails.filter(Boolean))
      : new Map();
    return games.map(
      /** @param {any} g */ (g) => {
        const gid = String(g.gameId || "");
        const blob = blobs.get(gid) || {};
        const buildLog = Array.isArray(g.buildLog)
          ? g.buildLog
          : Array.isArray(blob.buildLog) ? blob.buildLog : [];
        const oppBuildLog = Array.isArray(g.oppBuildLog)
          ? g.oppBuildLog
          : Array.isArray(blob.oppBuildLog) ? blob.oppBuildLog : [];
        return {
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
      },
    );
  }
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
    const filter = { userId };
    if (!force) filter.macroBreakdown = { $exists: false };
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
    events.push({
      time: minutes * 60 + seconds,
      time_display: `${minutes}:${String(seconds).padStart(2, "0")}`,
      name: rawName,
      display: entry ? entry.display : rawName,
      race: entry ? entry.race : "Neutral",
      category: entry ? entry.category : "unknown",
      tier: entry ? entry.tier : 0,
      is_building: entry ? !!entry.isBuilding : false,
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
 * Pure: input is unchanged, output is a fresh array sorted by the
 * adjusted time.
 *
 * @param {Array<ReturnType<typeof parseBuildLogLines>[number]>} events
 */
function eventsToStartTime(events) {
  if (!Array.isArray(events) || events.length === 0) return [];
  const out = events.map((ev) => {
    const startSec = Math.round(
      toStartSeconds(ev.name, ev.time, {
        isBuilding: !!ev.is_building,
        category: ev.category,
      }),
    );
    const m = Math.floor(startSec / 60);
    const s = startSec - m * 60;
    return {
      ...ev,
      time: startSec,
      time_display: `${m}:${String(s).padStart(2, "0")}`,
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
  EARLY_BUILD_LOG_CUTOFF_SEC,
};
