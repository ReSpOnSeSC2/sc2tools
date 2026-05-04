"use strict";

const { COLLECTIONS, LIMITS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");

const BUILD_LOG_LINE_RE = /^\[(\d+):(\d{2})\]\s+(.+?)\s*$/;
const BUILD_LOG_NOISE_RE = /^(Beacon|Reward|Spray)/;

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
   * @param {{ catalog?: { lookup: (name: string) => object | null } }} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.catalog = opts.catalog || null;
  }

  /**
   * Return the parsed build-order timeline for a single game.
   *
   * @param {string} userId
   * @param {string} gameId
   * @returns {Promise<object | null>}
   */
  async buildOrder(userId, gameId) {
    const game = await this.db.games.findOne(
      { userId, gameId },
      { projection: { _id: 0 } },
    );
    if (!game) return null;
    return {
      ok: true,
      game_id: game.gameId,
      my_build: game.myBuild || null,
      my_race: game.myRace || null,
      opp_strategy: game.opponent?.strategy || null,
      opponent: game.opponent?.displayName || null,
      opp_race: game.opponent?.race || null,
      map: game.map || null,
      result: game.result || null,
      events: parseBuildLogLines(game.buildLog || [], this.catalog),
      early_events: parseBuildLogLines(game.earlyBuildLog || [], this.catalog),
      opp_events: parseBuildLogLines(game.oppBuildLog || [], this.catalog),
      opp_early_events: parseBuildLogLines(
        game.oppEarlyBuildLog || [],
        this.catalog,
      ),
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
    const game = await this.db.games.findOne(
      { userId, gameId },
      {
        projection: {
          _id: 0,
          macroBreakdown: 1,
          macroScore: 1,
          myRace: 1,
          durationSec: 1,
        },
      },
    );
    if (!game) return null;
    if (!game.macroBreakdown) return { ok: false, code: "not_computed" };
    return {
      ok: true,
      macro_score: game.macroScore || null,
      race: game.myRace || null,
      game_length_sec: game.durationSec || 0,
      ...game.macroBreakdown,
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
    const game = await this.db.games.findOne(
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
    if (!game) return null;
    if (!game.apmCurve) return { ok: false, code: "not_computed" };
    return {
      ok: true,
      game_id: game.gameId,
      game_length_sec: game.durationSec || 0,
      window_sec: game.apmCurve.window_sec || 30,
      has_data: !!game.apmCurve.has_data,
      players: Array.isArray(game.apmCurve.players)
        ? game.apmCurve.players
        : [],
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
    /** @type {Record<string, any>} */
    const set = {
      macroScore: payload.macroScore,
      macroBreakdown: payload.breakdown || {},
    };
    if (Array.isArray(payload.top3Leaks)) {
      set.top3Leaks = payload.top3Leaks;
    }
    stampVersion(set, COLLECTIONS.GAMES);
    await this.db.games.updateOne({ userId, gameId }, { $set: set });
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
    const set = { apmCurve: curve };
    stampVersion(set, COLLECTIONS.GAMES);
    await this.db.games.updateOne({ userId, gameId }, { $set: set });
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
    /** @type {Record<string, any>} */
    const set = {
      oppBuildLog: payload.oppBuildLog.slice(0, 5000),
    };
    if (Array.isArray(payload.oppEarlyBuildLog)) {
      set.oppEarlyBuildLog = payload.oppEarlyBuildLog.slice(0, 5000);
    }
    stampVersion(set, COLLECTIONS.GAMES);
    await this.db.games.updateOne({ userId, gameId }, { $set: set });
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
   * @param {{ limit?: number, force?: boolean }} [opts]
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
};
