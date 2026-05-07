"use strict";

const { COLLECTIONS, LIMITS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");
const {
  runPythonNdjson,
  spawnPythonNdjson,
  pythonAvailable,
  writeTempFile,
  PythonError,
} = require("../util/pythonRunner");

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
   * @param {{ io?: import('socket.io').Server }} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.io = opts.io || null;
    this._activeJobs = new Map();
    // Optional GameDetailsService — used by ``_writeTrainingNdjson``
    // to hydrate ``buildLog`` for games whose slim row no longer
    // carries it inline (post-v0.4.3 cutover migration).
    this.gameDetails = opts.gameDetails || null;
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
    if (running && !running.cancelled) {
      throw httpError(409, "training_already_running", { jobId: running.jobId });
    }
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
    const insertResult = await this.db.mlJobs.insertOne(job);
    const jobId = String(insertResult.insertedId);
    // Kick async; the route handler returned 202 already.
    this._runTraining({ userId, jobId, kind }).catch((err) => {
      this._jobError(userId, jobId, err);
    });
    return { jobId, status: "running" };
  }

  /**
   * @private
   * @param {{ userId: string, jobId: string, kind: string }} args
   */
  async _runTraining({ userId, jobId, kind }) {
    const tmpPath = await this._writeTrainingNdjson(userId);
    try {
      await this._updateJob(userId, jobId, {
        phase: "training",
        lastMessage: "training_started",
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
            require("fs").unlinkSync(tmpPath);
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
      this._activeJobs.set(userId, { jobId, handle });
    } catch (err) {
      try {
        require("fs").unlinkSync(tmpPath);
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
  async _writeTrainingNdjson(userId) {
    // Two-stage scan so the cutover keeps working with both legacy
    // (buildLog inline on games) and post-cutover (buildLog in the
    // detail store) docs:
    //   1. Page slim rows for every eligible game.
    //   2. Bulk-fetch buildLog for the games that don't have it
    //      inline anymore.
    // ``deriveEarlyBuildLog`` is then applied to the unified buildLog
    // — the Python trainer (``scripts/ml_cli.py``) keeps the same
    // NDJSON shape it always has, no model-format change.
    const { deriveEarlyBuildLog } = require("./perGameCompute");
    const cursor = this.db.games
      .find(
        {
          userId,
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
            // Project the legacy inline copy when present; the
            // hydration step below fills in any missing ones from
            // the detail store. We keep the field projected so the
            // pre-migration code path doesn't need a $exists guard.
            buildLog: 1,
            opponent: 1,
            macroScore: 1,
          },
        },
      )
      .sort({ date: -1 })
      .limit(LIMITS.ML_TRAINING_MAX_GAMES);
    /** @type {Array<any>} */
    const games = [];
    /** @type {string[]} */
    const needHydration = [];
    for await (const game of cursor) {
      games.push(game);
      if (!Array.isArray(game.buildLog) && game.gameId) {
        needHydration.push(String(game.gameId));
      }
    }
    if (this.gameDetails && needHydration.length > 0) {
      const blobs = await this.gameDetails.findMany(userId, needHydration);
      for (const game of games) {
        if (Array.isArray(game.buildLog)) continue;
        const blob = blobs.get(String(game.gameId || ""));
        if (blob && Array.isArray(blob.buildLog)) {
          game.buildLog = blob.buildLog;
        }
      }
    }
    const lines = [];
    for (const game of games) {
      if (!Array.isArray(game.buildLog) || game.buildLog.length === 0) {
        // No build log available for this game — skip rather than
        // train on an empty feature row, which would silently degrade
        // the model. Same effect as the old ``$exists: true`` filter.
        continue;
      }
      const enriched = {
        ...game,
        earlyBuildLog: deriveEarlyBuildLog(game.buildLog),
      };
      lines.push(JSON.stringify(enriched));
    }
    if (lines.length === 0) {
      throw httpError(412, "not_enough_training_data");
    }
    return writeTempFile("ml-train", "ndjson", lines.join("\n") + "\n");
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
    await this._updateJob(userId, jobId, {
      status: "error",
      phase: "error",
      finishedAt: new Date(),
      lastMessage: (err && err.message) || "unknown_error",
    });
    this._activeJobs.delete(userId);
    this._broadcast(userId, "ml:error", { jobId, message: err && err.message });
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

module.exports = { MLService };
