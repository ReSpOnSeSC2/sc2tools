"use strict";

const { COLLECTIONS, LIMITS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");
const os = require("os");

const VALID_DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.\-+Z]+)?$/;

/**
 * ImportService — coordinates a "scan & bulk import historical
 * replays" job. The cloud can't open the user's local replay folder,
 * so the agent owns the actual scan + parse: this service tracks the
 * job lifecycle, broadcasts requests to the user's connected agent
 * over Socket.io, and exposes the legacy /import/{scan, start, cancel,
 * status, cores, extract-identities, pick-folder} surface so the SPA
 * doesn't need to know whether the work runs server-side or
 * agent-side.
 *
 * Job document shape (stored in `import_jobs`):
 *   {
 *     userId,
 *     status: 'pending' | 'scanning' | 'running' | 'done' | 'cancelled' | 'error',
 *     phase, folder,
 *     total, completed, errors,
 *     workers, since_iso, until_iso,
 *     startedAt, finishedAt, lastMessage,
 *     errorBreakdown, errorSamples,
 *   }
 */
class ImportService {
  /**
   * @param {{importJobs: import('mongodb').Collection}} db
   * @param {{ io?: import('socket.io').Server }} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.io = opts.io || null;
  }

  /**
   * Issue a scan request to the agent. The agent walks its local
   * replay folder and reports a candidate count back via
   * `reportProgress`.
   *
   * @param {string} userId
   * @param {{ folder?: string, since_iso?: string, until_iso?: string }} body
   */
  async scan(userId, body) {
    const validation = validateImportBody(body, { folderRequired: false });
    if (validation.error) throw httpError(400, validation.error);
    const job = makeJobDoc(userId, body, "scan");
    job.status = "scanning";
    const res = await this.db.importJobs.insertOne(job);
    const jobId = String(res.insertedId);
    this.broadcast(userId, "import:scan_request", { jobId, ...body });
    return { jobId, status: "scanning" };
  }

  /**
   * Kick off the bulk-import worker on the agent.
   *
   * @param {string} userId
   * @param {{
   *   folder: string,
   *   workers?: number,
   *   since_iso?: string,
   *   until_iso?: string,
   *   force?: boolean,
   * }} body
   */
  async start(userId, body) {
    const validation = validateImportBody(body, { folderRequired: true });
    if (validation.error) throw httpError(400, validation.error);
    const running = await this.db.importJobs.findOne({
      userId,
      status: { $in: ["scanning", "running"] },
    });
    if (running) {
      throw httpError(409, "import_already_running", { jobId: String(running._id) });
    }
    const cores = pickWorkerCount(body.workers);
    const job = makeJobDoc(userId, body, "import");
    job.status = "running";
    job.workers = cores;
    const res = await this.db.importJobs.insertOne(job);
    const jobId = String(res.insertedId);
    this.broadcast(userId, "import:start_request", {
      jobId,
      folder: body.folder,
      workers: cores,
      since_iso: body.since_iso || null,
      until_iso: body.until_iso || null,
      force: !!body.force,
    });
    return { jobId, status: "running", workers: cores };
  }

  /**
   * Signal the agent to abort the current import.
   *
   * @param {string} userId
   */
  async cancel(userId) {
    const running = await this.db.importJobs.findOne(
      { userId, status: { $in: ["scanning", "running"] } },
      { sort: { startedAt: -1 } },
    );
    if (!running) return { ok: true, cancelled: 0 };
    await this.db.importJobs.updateOne(
      { _id: running._id },
      {
        $set: {
          status: "cancelled",
          finishedAt: new Date(),
          lastMessage: "cancelled_by_user",
        },
      },
    );
    this.broadcast(userId, "import:cancel_request", { jobId: String(running._id) });
    return { ok: true, cancelled: 1, jobId: String(running._id) };
  }

  /**
   * Latest job status for the user.
   *
   * @param {string} userId
   */
  async status(userId) {
    const job = await this.db.importJobs.findOne(
      { userId },
      { sort: { startedAt: -1 } },
    );
    if (!job) return { ok: true, running: false, phase: "idle" };
    return { ok: true, ...serialiseJob(job) };
  }

  /**
   * Most recent N jobs for history view.
   *
   * @param {string} userId
   */
  async list(userId) {
    const docs = await this.db.importJobs
      .find({ userId })
      .sort({ startedAt: -1 })
      .limit(LIMITS.IMPORT_JOB_HISTORY)
      .toArray();
    return { ok: true, items: docs.map(serialiseJob) };
  }

  /**
   * Apply progress reported by the agent. The agent calls this
   * periodically with a counter delta and an optional `done` flag.
   *
   * @param {string} userId
   * @param {string} jobId
   * @param {{
   *   completed?: number,
   *   total?: number,
   *   errors?: number,
   *   message?: string,
   *   phase?: string,
   *   done?: boolean,
   *   errorBreakdown?: object,
   *   errorSamples?: object[],
   * }} payload
   */
  async reportProgress(userId, jobId, payload) {
    const { ObjectId } = require("mongodb");
    let _id;
    try {
      _id = new ObjectId(jobId);
    } catch (_e) {
      throw httpError(400, "invalid_job_id");
    }
    /** @type {Record<string, any>} */
    const set = {};
    if (typeof payload.completed === "number") set.completed = payload.completed;
    if (typeof payload.total === "number") set.total = payload.total;
    if (typeof payload.errors === "number") set.errors = payload.errors;
    if (typeof payload.phase === "string") set.phase = payload.phase;
    if (typeof payload.message === "string") set.lastMessage = payload.message.slice(0, 1000);
    if (payload.errorBreakdown && typeof payload.errorBreakdown === "object") {
      set.errorBreakdown = payload.errorBreakdown;
    }
    if (Array.isArray(payload.errorSamples)) {
      set.errorSamples = payload.errorSamples.slice(0, 25);
    }
    if (payload.done) {
      set.status = "done";
      set.finishedAt = new Date();
    }
    if (Object.keys(set).length === 0) return { ok: true, noop: true };
    await this.db.importJobs.updateOne({ _id, userId }, { $set: set });
    if (this.io) {
      this.io.to(`user:${userId}`).emit("import:progress", {
        jobId,
        ...set,
      });
    }
    return { ok: true };
  }

  /**
   * Number of CPU cores reported by the agent (mirrors the legacy
   * /import/cores endpoint). The agent reports its host's core count
   * during the pairing handshake; the cloud caches the most recent
   * reading.
   *
   * @param {string} userId
   */
  async cores(userId) {
    const job = await this.db.importJobs.findOne(
      { userId, agentCores: { $exists: true } },
      { sort: { startedAt: -1 } },
    );
    return {
      ok: true,
      cores: job?.agentCores || os.cpus().length,
      defaultWorkers: pickWorkerCount(),
    };
  }

  /**
   * Persist the agent's reported host info (cores, replay folder).
   *
   * @param {string} userId
   * @param {{ cores?: number, replayFolders?: string[] }} payload
   */
  async setHostInfo(userId, payload) {
    const set = {};
    if (typeof payload.cores === "number" && payload.cores > 0) {
      set.agentCores = payload.cores;
    }
    if (Array.isArray(payload.replayFolders)) {
      set.agentReplayFolders = payload.replayFolders.slice(0, 16);
    }
    if (Object.keys(set).length === 0) return { ok: true };
    await this.db.importJobs.updateOne(
      { userId, kind: "host_info" },
      {
        $setOnInsert: { userId, kind: "host_info", startedAt: new Date(), status: "info" },
        $set: { ...set, finishedAt: new Date() },
      },
      { upsert: true },
    );
    return { ok: true };
  }

  /**
   * Ask the agent to invoke its `--extract-identities` flow.
   *
   * @param {string} userId
   * @param {{ folder?: string }} body
   */
  async extractIdentities(userId, body) {
    if (!body || !body.folder) throw httpError(400, "folder is required");
    const job = makeJobDoc(userId, body, "extract_identities");
    job.status = "running";
    const res = await this.db.importJobs.insertOne(job);
    const jobId = String(res.insertedId);
    this.broadcast(userId, "import:extract_identities_request", {
      jobId,
      folder: body.folder,
    });
    return { jobId };
  }

  /**
   * Ask the agent to open a folder picker and return the selected
   * path. The agent shows the dialog locally and posts the result
   * via `setHostInfo` / progress.
   *
   * @param {string} userId
   */
  async pickFolder(userId) {
    const reqId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.broadcast(userId, "import:pick_folder_request", { reqId });
    return { ok: true, reqId };
  }

  /**
   * @private
   * @param {string} userId
   * @param {string} event
   * @param {Record<string, any>} payload
   */
  broadcast(userId, event, payload) {
    if (!this.io) return;
    try {
      this.io.to(`user:${userId}`).emit(event, payload);
    } catch (_e) {
      // best-effort
    }
  }
}

/**
 * @param {string} userId
 * @param {Record<string, any> | undefined} body
 * @param {string} kind
 */
function makeJobDoc(userId, body, kind) {
  /** @type {Record<string, any>} */
  const doc = {
    userId,
    kind,
    status: "pending",
    phase: kind,
    folder: (body && body.folder) || null,
    total: 0,
    completed: 0,
    errors: 0,
    workers: 0,
    since_iso: (body && body.since_iso) || null,
    until_iso: (body && body.until_iso) || null,
    force: !!(body && body.force),
    startedAt: new Date(),
    finishedAt: null,
    lastMessage: "",
    errorBreakdown: null,
    errorSamples: null,
  };
  stampVersion(doc, COLLECTIONS.IMPORT_JOBS);
  return doc;
}

/** @param {Record<string, any> | null | undefined} job */
function serialiseJob(job) {
  if (!job) return null;
  return {
    jobId: String(job._id),
    kind: job.kind || null,
    status: job.status || "idle",
    phase: job.phase || null,
    folder: job.folder || null,
    total: job.total || 0,
    completed: job.completed || 0,
    errors: job.errors || 0,
    workers: job.workers || 0,
    since_iso: job.since_iso || null,
    until_iso: job.until_iso || null,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    lastMessage: job.lastMessage || "",
    errorBreakdown: job.errorBreakdown || null,
    errorSamples: job.errorSamples || null,
  };
}

/**
 * @param {any} body
 * @param {{ folderRequired: boolean }} opts
 */
function validateImportBody(body, opts) {
  if (!body || typeof body !== "object") return { error: "invalid body" };
  if (opts.folderRequired) {
    if (!body.folder || typeof body.folder !== "string") {
      return { error: "folder is required" };
    }
    if (body.folder.length > 4096) return { error: "folder path too long" };
  }
  if (body.since_iso && !VALID_DATE_RE.test(body.since_iso)) {
    return { error: "since_iso must be YYYY-MM-DD" };
  }
  if (body.until_iso && !VALID_DATE_RE.test(body.until_iso)) {
    return { error: "until_iso must be YYYY-MM-DD" };
  }
  if (
    body.workers !== undefined &&
    (!Number.isFinite(Number(body.workers)) || Number(body.workers) <= 0)
  ) {
    return { error: "workers must be a positive integer" };
  }
  return {};
}

/** @param {unknown} [requested] */
function pickWorkerCount(requested) {
  const fallback = Math.min(8, Math.max(1, os.cpus().length));
  if (requested === undefined) return fallback;
  const n = Number.parseInt(String(requested), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 32);
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

module.exports = { ImportService };
