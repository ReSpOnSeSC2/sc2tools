"use strict";

const fs = require("fs");
const { COLLECTIONS, LIMITS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");
const {
  runPythonNdjson,
  spawnPythonNdjson,
  pythonAvailable,
  writeTempFile,
  PythonError,
} = require("../util/pythonRunner");

// Training runs beside the API process on a small shared-memory
// instance. Keep both the Python input and the number of samples
// finite even for accounts with tens of thousands of replays.
const ML_TRAINING_GAME_CAP = Math.min(LIMITS.ML_TRAINING_MAX_GAMES, 2_000);
const ML_TRAINING_NDJSON_BYTE_CAP = 8 * 1024 * 1024;
const ML_TRAINING_ROW_BYTE_CAP = 128 * 1024;
const ML_TRAINING_LOG_LINE_CAP = 64;
const ML_TRAINING_LOG_LINE_CHAR_CAP = 128;
const ML_TRAINING_LOG_SCAN_CAP = 256;
const ML_TRAINING_DETAIL_FIELDS = Object.freeze(["buildLog"]);

/**
 * MLService — train + serve the per-user opening-prediction model.
 *
 * The model itself lives in MongoDB under `ml_models` (one document
 * per (userId, kind)). Training pulls every game with structured
 * fields, writes them to a tmp NDJSON file, invokes scripts/ml_cli.py
 * train, and stores the resulting model blob back. Predict / pregame
 * read the stored model and shell out to ml_cli.py predict.
 *
 * Model document shape:
 *   {
 *     userId, kind: 'opener_predict',
 *     blob: BinData,                  // pickle bytes from sklearn
 *     metadata: {                     // metrics + feature schema
 *       trainedAt, gamesUsed,
 *       races, openings,
 *       trainingMetrics: { accuracy, f1, ... },
 *     },
 *   }
 */
class MLService {
  /**
   * @param {{
   *   games: import('mongodb').Collection,
   *   mlModels: import('mongodb').Collection,
   *   mlJobs: import('mongodb').Collection,
   * }} db
   * @param {{
   *   io?: import('socket.io').Server,
   *   gameDetails?: import('./gameDetails').GameDetailsService,
   * }} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.io = opts.io || null;
    this._activeJobs = new Map();
    this._trainingReservations = new Set();
    // Optional GameDetailsService — used by ``_writeTrainingNdjson``
    // to hydrate ``buildLog`` for games whose slim row no longer
    // carries it inline (post-v0.4.3 cutover migration).
    this.gameDetails = opts.gameDetails || null;
  }

  /** Identifier-free occupancy for the single process-wide training lane. */
  trainingCapacitySnapshot() {
    return {
      active: this._activeJobs.size,
      reserved: this._trainingReservations.size,
      maxActive: 1,
    };
  }

  /**
   * Snapshot of the user's trained model + the most-recent training
   * job. Mirrors the legacy /ml/status payload.
   *
   * @param {string} userId
   */
  async status(userId) {
    const model = await this.db.mlModels.findOne(
      { userId, kind: "opener_predict" },
      { projection: { blob: 0 } },
    );
    const job = await this.db.mlJobs.findOne(
      { userId },
      { sort: { createdAt: -1 } },
    );
    return {
      ok: true,
      pythonAvailable: pythonAvailable(),
      hasModel: !!model,
      model: model
        ? {
            kind: model.kind,
            trainedAt: model.metadata?.trainedAt || null,
            gamesUsed: model.metadata?.gamesUsed || 0,
            metrics: model.metadata?.trainingMetrics || null,
            openings: model.metadata?.openings || [],
          }
        : null,
      job: job
        ? {
            jobId: String(job._id),
            status: job.status,
            phase: job.phase,
            progress: job.progress,
            startedAt: job.createdAt,
            finishedAt: job.finishedAt,
            lastMessage: job.lastMessage,
          }
        : null,
    };
  }

  /**
   * Kick off a training job. Returns immediately; progress streams
   * over Socket.io to the user's room.
   *
   * @param {string} userId
   * @param {{ kind?: string }} [opts]
   */
  async train(userId, opts = {}) {
    if (!pythonAvailable()) {
      throw httpError(503, "python_unavailable");
    }
    const kind = opts.kind || "opener_predict";
    const running = this._activeJobs.get(userId);
    if (
      (running && !running.cancelled)
      || this._trainingReservations.has(userId)
    ) {
      throw httpError(409, "training_already_running", {
        jobId: running ? running.jobId : null,
      });
    }
    if (this._activeJobs.size + this._trainingReservations.size >= 1) {
      throw httpError(503, "training_capacity_busy", { retryAfterSec: 30 });
    }
    this._trainingReservations.add(userId);
    const job = {
      userId,
      kind,
      status: "running",
      phase: "preparing",
      progress: { i: 0, total: 0 },
      lastMessage: "",
      createdAt: new Date(),
      finishedAt: null,
    };
    stampVersion(job, COLLECTIONS.ML_JOBS);
    let insertResult;
    try {
      insertResult = await this.db.mlJobs.insertOne(job);
    } finally {
      this._trainingReservations.delete(userId);
    }
    const jobId = String(insertResult.insertedId);
    this._activeJobs.set(userId, {
      jobId,
      handle: null,
      cancelled: false,
    });
    // Kick async; the route handler returned 202 already.
    void this._runTraining({ userId, jobId, kind }).catch(async (err) => {
      try {
        await this._jobError(userId, jobId, err);
      } catch {
        // Status persistence is best-effort here. _jobError always releases
        // the process-wide training lane in its finally block, and this catch
        // prevents a secondary Mongo outage from becoming an unhandled
        // rejection that can terminate Node.
      }
    });
    return { jobId, status: "running" };
  }

  /**
   * @private
   * @param {{ userId: string, jobId: string, kind: string }} args
   */
  async _runTraining({ userId, jobId, kind }) {
    const prepared = await this._writeTrainingNdjson(userId);
    const tmpPath = prepared.path;
    try {
      await this._updateJob(userId, jobId, {
        phase: "training",
        progress: { i: 0, total: prepared.gamesWritten },
        lastMessage: prepared.truncated
          ? `training_started sample=${prepared.gamesWritten} truncated=${prepared.limitReason}`
          : `training_started sample=${prepared.gamesWritten}`,
      });
      const handle = spawnPythonNdjson({
        script: "scripts/ml_cli.py",
        args: ["train", "--input", tmpPath, "--kind", kind],
        timeoutMs: 30 * 60 * 1000,
        onRecord: (record) => {
          this._handleTrainingRecord(userId, jobId, record).catch(() => {});
        },
        onClose: ({ exitCode, stderr }) => {
          this._activeJobs.delete(userId);
          try {
            fs.unlinkSync(tmpPath);
          } catch (_e) {
            // best-effort cleanup
          }
          if (exitCode !== 0) {
            this._jobError(
              userId,
              jobId,
              new PythonError(stderr.trim() || `ml_cli exit ${exitCode}`, {
                kind: "exit_nonzero",
                exitCode,
              }),
            ).catch(() => {});
          }
        },
      });
      this._activeJobs.set(userId, { jobId, handle, cancelled: false });
    } catch (err) {
      try {
        fs.unlinkSync(tmpPath);
      } catch (_e) {
        // best-effort
      }
      throw err;
    }
  }

  /**
   * @private
   * @param {string} userId
   * @param {string} jobId
   * @param {Record<string, any>} record
   */
  async _handleTrainingRecord(userId, jobId, record) {
    if (!record || typeof record !== "object") return;
    if (record.progress) {
      const update = {
        progress: {
          i: record.progress.i || 0,
          total: record.progress.total || 0,
        },
        lastMessage: record.progress.message || "",
      };
      await this._updateJob(userId, jobId, update);
      this._broadcast(userId, "ml:progress", { jobId, ...update.progress });
      return;
    }
    if (record.model) {
      const blob = Buffer.from(record.model.blob_b64 || "", "base64");
      const metadata = {
        trainedAt: new Date(),
        gamesUsed: record.model.gamesUsed || 0,
        races: record.model.races || [],
        openings: record.model.openings || [],
        trainingMetrics: record.model.metrics || {},
      };
      const doc = {
        userId,
        kind: record.model.kind || "opener_predict",
        blob,
        metadata,
      };
      stampVersion(doc, COLLECTIONS.ML_MODELS);
      await this.db.mlModels.updateOne(
        { userId, kind: doc.kind },
        { $set: doc, $setOnInsert: { createdAt: new Date() } },
        { upsert: true },
      );
      await this._updateJob(userId, jobId, {
        status: "done",
        phase: "done",
        finishedAt: new Date(),
        lastMessage: `model_saved gamesUsed=${metadata.gamesUsed}`,
      });
      this._broadcast(userId, "ml:done", { jobId, metadata });
    }
  }

  /**
   * Predict the most likely opener for an in-progress game given a
   * partial set of features (matchup + early build log).
   *
   * @param {string} userId
   * @param {{ myRace: string, oppRace: string, earlyBuildLog?: string[], map?: string }} payload
   */
  async predict(userId, payload) {
    if (!pythonAvailable()) throw httpError(503, "python_unavailable");
    if (!payload || typeof payload !== "object") {
      throw httpError(400, "invalid_payload");
    }
    const model = await this.db.mlModels.findOne(
      { userId, kind: "opener_predict" },
      { projection: { _id: 0 } },
    );
    if (!model) throw httpError(404, "no_model_trained");
    const tmpModel = writeTempFile("ml-model", "pkl", "");
    require("fs").writeFileSync(tmpModel, model.blob);
    try {
      const records = await runPythonNdjson({
        script: "scripts/ml_cli.py",
        args: ["predict", "--model", tmpModel, "--input", "-"],
        stdin: JSON.stringify(payload) + "\n",
      });
      const result = /** @type {any} */ (
        records.find((r) => r && /** @type {any} */ (r).ok)
      );
      if (!result) {
        throw new PythonError("ml_predict_no_result", { kind: "no_result" });
      }
      return {
        ok: true,
        prediction: result.prediction,
        confidence: result.confidence,
        topK: result.topK || [],
      };
    } finally {
      try {
        require("fs").unlinkSync(tmpModel);
      } catch (_e) {
        // best-effort
      }
    }
  }

  /**
   * Pre-game prediction: opener probabilities given just the
   * matchup + map. No build log yet.
   *
   * @param {string} userId
   * @param {{ myRace: string, oppRace: string, map?: string }} payload
   */
  async pregame(userId, payload) {
    return this.predict(userId, { ...payload, earlyBuildLog: [] });
  }

  /**
   * Available openings + races for the user's trained model.
   *
   * @param {string} userId
   */
  async options(userId) {
    const model = await this.db.mlModels.findOne(
      { userId, kind: "opener_predict" },
      { projection: { blob: 0 } },
    );
    return {
      ok: true,
      hasModel: !!model,
      races: model?.metadata?.races || [],
      openings: model?.metadata?.openings || [],
    };
  }

  /**
   * @private
   * @param {string} userId
   */
  // eslint-disable-next-line max-lines-per-function
  async _writeTrainingNdjson(userId) {
    // Page one slim row at a time and hydrate at most one detail blob.
    // Each completed training row is written straight to disk; neither
    // replay blobs nor a second in-memory NDJSON copy accumulate here.
    let cursor = this.db.games
      .find(
        {
          userId,
          isResumedFromReplay: { $ne: true },
          myRace: { $exists: true },
          "opponent.race": { $exists: true },
        },
        {
          projection: {
            _id: 0,
            gameId: 1,
            date: 1,
            result: 1,
            myRace: 1,
            myBuild: 1,
            map: 1,
            buildLog: 1,
            "opponent.race": 1,
            macroScore: 1,
          },
        },
      )
      .sort({ date: -1 })
      // The extra row lets us report game-cap truncation without ever
      // materialising more than the current cursor item.
      .limit(ML_TRAINING_GAME_CAP + 1);
    if (typeof cursor.batchSize === "function") cursor = cursor.batchSize(1);

    const path = writeTempFile("ml-train", "ndjson", "");
    const output = await fs.promises.open(path, "w");
    let gamesScanned = 0;
    let gamesWritten = 0;
    let bytesWritten = 0;
    let truncated = false;
    let limitReason = null;
    try {
      for await (const game of cursor) {
        if (gamesScanned >= ML_TRAINING_GAME_CAP) {
          truncated = true;
          limitReason = "game_cap";
          break;
        }
        gamesScanned += 1;
        const buildLog = await this._trainingBuildLog(userId, game);
        if (!Array.isArray(buildLog) || buildLog.length === 0) continue;

        const row = compactTrainingGame(game, buildLog);
        const line = `${JSON.stringify(row)}\n`;
        const lineBytes = Buffer.byteLength(line, "utf8");
        if (lineBytes > ML_TRAINING_ROW_BYTE_CAP) {
          truncated = true;
          limitReason = limitReason || "row_cap";
          continue;
        }
        if (bytesWritten + lineBytes > ML_TRAINING_NDJSON_BYTE_CAP) {
          truncated = true;
          limitReason = "byte_cap";
          break;
        }
        await output.write(line);
        bytesWritten += lineBytes;
        gamesWritten += 1;
      }
    } catch (err) {
      await output.close().catch(() => {});
      try {
        fs.unlinkSync(path);
      } catch {
        // best-effort cleanup
      }
      throw err;
    }
    await output.close();
    if (gamesWritten === 0) {
      try {
        fs.unlinkSync(path);
      } catch {
        // best-effort cleanup
      }
      throw httpError(412, "not_enough_training_data");
    }
    return {
      path,
      gamesScanned,
      gamesWritten,
      bytesWritten,
      truncated,
      limitReason,
    };
  }

  /**
   * @private
   * @param {string} userId
   * @param {any} game
   * @returns {Promise<any[] | null>}
   */
  async _trainingBuildLog(userId, game) {
    if (Array.isArray(game.buildLog)) return game.buildLog;
    const gameId = String(game.gameId || "");
    if (!this.gameDetails || !gameId) return null;
    const detail = await this.gameDetails.findMany(userId, [gameId], {
      fields: [...ML_TRAINING_DETAIL_FIELDS],
      concurrency: 1,
    });
    const blob = detail.get(gameId);
    return blob && Array.isArray(blob.buildLog) ? blob.buildLog : null;
  }

  /**
   * @private
   * @param {string} userId
   * @param {string} jobId
   * @param {Record<string, any>} fields
   */
  async _updateJob(userId, jobId, fields) {
    const { ObjectId } = require("mongodb");
    let _id;
    try {
      _id = new ObjectId(jobId);
    } catch (_e) {
      return;
    }
    await this.db.mlJobs.updateOne({ _id, userId }, { $set: fields });
  }

  /**
   * @private
   * @param {string} userId
   * @param {string} jobId
   * @param {Error} err
   */
  async _jobError(userId, jobId, err) {
    try {
      await this._updateJob(userId, jobId, {
        status: "error",
        phase: "error",
        finishedAt: new Date(),
        lastMessage: (err && err.message) || "unknown_error",
      });
      this._broadcast(userId, "ml:error", { jobId, message: err && err.message });
    } finally {
      this._activeJobs.delete(userId);
    }
  }

  /**
   * @private
   * @param {string} userId
   * @param {string} event
   * @param {Record<string, any>} payload
   */
  _broadcast(userId, event, payload) {
    if (!this.io) return;
    try {
      this.io.to(`user:${userId}`).emit(event, payload);
    } catch (_e) {
      // best-effort
    }
  }
}

const TRAINING_BUILD_LOG_RE = /^\[(\d+):(\d{2})\]\s+(.+?)\s*$/;

/**
 * Preserve the trainer's legacy ``buildLog`` + ``earlyBuildLog`` keys,
 * but keep only a bounded first-five-minute opener sample. The Python
 * model consumes opener features; late-game log entries only inflated
 * the input and were previously duplicated across both keys.
 *
 * @param {any} game
 * @param {any[]} buildLog
 * @returns {Record<string, any>}
 */
function compactTrainingGame(game, buildLog) {
  const earlyBuildLog = boundedEarlyBuildLog(buildLog);
  const macroScore = Number(game.macroScore);
  return {
    gameId: clippedString(game.gameId, 128),
    date: game.date instanceof Date
      ? game.date.toISOString()
      : clippedString(game.date, 64),
    result: clippedString(game.result, 32),
    myRace: clippedString(game.myRace, 32),
    myBuild: clippedString(game.myBuild, 256),
    map: clippedString(game.map, 256),
    opponent: {
      race: clippedString(game.opponent && game.opponent.race, 32),
    },
    macroScore: Number.isFinite(macroScore) ? macroScore : undefined,
    buildLog: earlyBuildLog,
    earlyBuildLog,
  };
}

/**
 * @param {any[]} fullLog
 * @returns {string[]}
 */
function boundedEarlyBuildLog(fullLog) {
  const out = [];
  const scanLength = Math.min(fullLog.length, ML_TRAINING_LOG_SCAN_CAP);
  for (let i = 0; i < scanLength; i += 1) {
    const raw = fullLog[i];
    const line = String(raw || "").slice(0, ML_TRAINING_LOG_LINE_CHAR_CAP);
    const match = TRAINING_BUILD_LOG_RE.exec(line);
    if (!match) continue;
    const seconds = Number.parseInt(match[1], 10) * 60
      + Number.parseInt(match[2], 10);
    if (seconds > 300) break;
    out.push(line);
    if (out.length >= ML_TRAINING_LOG_LINE_CAP) break;
  }
  return out;
}

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string | undefined}
 */
function clippedString(value, max) {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

/**
 * @param {number} status
 * @param {string} code
 * @param {Record<string, any>} [extra]
 */
function httpError(status, code, extra = {}) {
  const err = new Error(code);
  /** @type {any} */ (err).status = status;
  /** @type {any} */ (err).code = code;
  Object.assign(err, extra);
  return err;
}

module.exports = {
  MLService,
  ML_TRAINING_GAME_CAP,
  ML_TRAINING_NDJSON_BYTE_CAP,
};
