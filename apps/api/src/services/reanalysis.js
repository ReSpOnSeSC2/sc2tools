"use strict";

const { ObjectId } = require("mongodb");
const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");
const { sha256 } = require("../util/hash");
const { parseStrictSemver } = require("../util/strictSemver");
const cohorts = require("./reanalysisCohorts");

/**
 * Managed re-analysis: bring games an older engine labelled up to date.
 *
 * One durable `reanalysis_jobs` row per run (at most one active per owner,
 * enforced by a unique partial index). The row holds fixed counters, a keyset
 * cursor and the current batch of at most 100 games, never a history-sized
 * id list. A batch goes to one connected, capable agent with
 * `reanalyze:batch` (emitWithAck). The next batch is selected only after that
 * batch was acknowledged AND every game in it reached a terminal outcome;
 * an "uploaded" outcome counts as updated only when the stored row shows an
 * agent upload made after the batch was created. Uploads use the normal
 * ingest route, so its admission gate bounds them as well.
 *
 * Every transition is a compare-and-set on (status, generation, batch seq),
 * so an API restart or a second API process cannot double-dispatch or
 * double-count. Pause/cancel bump the generation; a late acknowledgement of
 * an older generation never marks the current one delivered. There is no
 * timer: work advances on agent acknowledgements and outcomes, on agent
 * (re)connects, and on the owner's status reads, which also redeliver a
 * batch that has gone quiet.
 */

const BATCH_SIZE = 100;
const ACK_TIMEOUT_MS = 10_000;
const PRESENCE_TIMEOUT_MS = 1_000;
const STALL_MS = 5 * 60_000;
const MAX_STALLS = 3;
const PROGRESS_INTERVAL_MS = 1_000;
const MAX_KICK_STEPS = 6;
const DEVICE_ID = /^[a-f0-9]{24}$/;
const JOB_ID = /^[a-f0-9]{24}$/;
const GAME_ID_MAX = 200;
const ACK_CODES = new Set(["accepted", "unsupported", "invalid_request", "owner_changed", "local_error"]);
/** Agent outcome -> counter. "uploaded" is re-checked against the stored row. */
const OUTCOMES = new Map([
  ["uploaded", "updated"],
  ["not_found", "unavailable"],
  ["download_failed", "failed"],
  ["invalid_original", "failed"],
  ["game_mismatch", "failed"],
  ["parse_failed", "failed"],
  ["rejected", "failed"],
  ["upload_failed", "failed"],
  ["no_result", "failed"],
]);
const JOB_VIEW_PROJECTION = Object.freeze({ "batch.items": 0, versions: 0 });

/** @param {number} status @param {string} code */
function fail(status, code) {
  return Object.assign(new Error(code), { status, code });
}

/** @param {unknown} body @param {string[]} keys @returns {Record<string, any>} */
function exactBody(body, keys) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== keys.length
    || keys.some((key) => !Object.hasOwn(body, key))) throw fail(400, "reanalysis_request_invalid");
  return /** @type {Record<string, any>} */ (body);
}

/** @template T @param {Promise<T>} promise @param {number} ms @returns {Promise<T>} */
function bounded(promise, ms) {
  /** @type {NodeJS.Timeout|undefined} */
  let timer;
  /** @type {Promise<never>} */
  const deadline = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(fail(504, "reanalysis_timeout")), ms); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** @param {unknown} value */
function iso(value) {
  return value instanceof Date ? value.toISOString() : null;
}

/** @param {any} job @param {number} now */
function elapsedMs(job, now) {
  return job?.runningSince instanceof Date ? Math.max(0, now - job.runningSince.getTime()) : 0;
}

/**
 * Owner-facing job summary: counters and state only, no game ids.
 * @param {any} job @param {number} now
 */
function jobView(job, now) {
  if (!job) return null;
  const processed = Number(job.processed) || 0;
  const total = Math.max(Number(job.total) || 0, processed);
  const activeMs = (Number(job.activeMs) || 0) + elapsedMs(job, now);
  const remaining = total - processed;
  const etaSec = job.status === "running" && processed >= 5 && remaining > 0 && activeMs > 0
    ? Math.round((remaining * activeMs) / processed / 1000) : null;
  return {
    id: String(job._id),
    cohortId: job.cohortId,
    engine: typeof job.engine === "string" ? job.engine : null,
    status: job.status,
    total,
    processed,
    updated: Number(job.updated) || 0,
    unavailable: Number(job.unavailable) || 0,
    failed: Number(job.failed) || 0,
    etaSec,
    createdAt: iso(job.createdAt),
    completedAt: iso(job.completedAt),
  };
}

/** @param {unknown} raw */
function parseItemOutcome(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { gameId, outcome, engineVersion } = /** @type {Record<string, any>} */ (raw);
  if (typeof gameId !== "string" || gameId.length === 0 || gameId.length > GAME_ID_MAX) return null;
  if (typeof outcome !== "string" || !OUTCOMES.has(outcome) || outcome === "no_result") return null;
  if (engineVersion !== undefined && engineVersion !== null && !parseStrictSemver(engineVersion)) return null;
  return { gameId, outcome, engineVersion: typeof engineVersion === "string" ? engineVersion : null };
}

/** `reanalyze:outcome` from an agent. @param {unknown} raw */
function parseOutcomeEvent(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = /** @type {Record<string, any>} */ (raw);
  if (body.version !== 1 || typeof body.jobId !== "string" || !JOB_ID.test(body.jobId)
    || !Number.isSafeInteger(body.seq) || body.seq < 1
    || !Number.isSafeInteger(body.generation) || body.generation < 1) return null;
  const item = parseItemOutcome(body);
  return item ? { jobId: body.jobId, seq: body.seq, generation: body.generation, ...item } : null;
}

/**
 * The acknowledgement must echo this exact delivery; it may carry outcomes
 * the agent already settled for this batch (a redelivery after reconnect).
 * @param {unknown} reply @param {{jobId: string, seq: number, generation: number, games: Array<{gameId: string}>}} payload
 */
function parseAck(reply, payload) {
  if (!reply || typeof reply !== "object" || Array.isArray(reply)) return null;
  const body = /** @type {Record<string, any>} */ (reply);
  if (body.jobId !== payload.jobId || body.seq !== payload.seq || body.generation !== payload.generation
    || typeof body.code !== "string" || !ACK_CODES.has(body.code)) return null;
  /** @type {NonNullable<ReturnType<typeof parseItemOutcome>>[]} */
  const outcomes = [];
  if (body.outcomes !== undefined) {
    if (!Array.isArray(body.outcomes) || body.outcomes.length > BATCH_SIZE) return null;
    const requested = new Set(payload.games.map((game) => game.gameId));
    for (const raw of body.outcomes) {
      const outcome = parseItemOutcome(raw);
      if (!outcome || !requested.has(outcome.gameId)) return null;
      outcomes.push(outcome);
    }
  }
  return { code: body.code, outcomes };
}

/**
 * Pause and cancel retire the generation (late acknowledgements of the old
 * delivery no longer count); resume starts a new one through the agent check.
 * @param {"pause"|"resume"|"cancel"} action @param {any} job @param {number} now
 */
function controlUpdate(action, job, now) {
  const at = new Date(now);
  const elapsed = elapsedMs(job, now);
  if (action === "pause") return { $set: { status: "paused", runningSince: null, updatedAt: at }, $inc: { generation: 1, activeMs: elapsed } };
  if (action === "resume") return { $set: { status: "waiting_for_agent", runningSince: null, updatedAt: at }, $inc: { generation: 1 } };
  return { $set: { status: "cancelled", active: false, runningSince: null, completedAt: at, updatedAt: at }, $inc: { generation: 1, activeMs: elapsed } };
}

/** @param {any} batch */
function batchSettled(batch) {
  return Array.isArray(batch?.items) && batch.items.every((/** @type {any} */ item) => typeof item.outcome === "string");
}

/** @param {unknown} error */
function isDuplicateKey(error) {
  return /** @type {any} */ (error)?.code === 11000;
}

class ReanalysisService {
  /**
   * @param {{
   *   db: {games: import('mongodb').Collection, reanalysisJobs: import('mongodb').Collection},
   *   io?: any,
   *   pairings?: {findTokenByHash(hash: string): Promise<{userId: string, deviceId?: string}|null>}|null,
   *   notifications?: {notify(userId: string, input: Record<string, any>): Promise<unknown>}|null,
   *   logger?: {warn: (...args: any[]) => void}|null,
   *   now?: () => number,
   *   ackTimeoutMs?: number,
   *   stallMs?: number,
   *   catalog?: import('./reanalysisCohorts').MilestoneCatalog,
   * }} deps
   */
  constructor(deps) {
    this.games = deps.db.games;
    this.jobs = deps.db.reanalysisJobs;
    this.io = deps.io || null;
    this.pairings = deps.pairings || null;
    this.notifications = deps.notifications || null;
    this.logger = deps.logger || null;
    this.now = deps.now || Date.now;
    this.ackTimeoutMs = Math.min(15_000, Math.max(20, deps.ackTimeoutMs ?? ACK_TIMEOUT_MS));
    this.stallMs = Math.max(1, deps.stallMs ?? STALL_MS);
    this.catalog = deps.catalog || cohorts.MILESTONE_CATALOG;
    /** @type {Map<string, {started: boolean, redeliver: string|false, promise: Promise<void>}>} */
    this.kicks = new Map();
    /** @type {Map<string, number>} */
    this.lastProgress = new Map();
  }

  /** GET /v1/me/reanalysis. @param {string} userId */
  async overview(userId) {
    const [counts, job, agent] = await Promise.all([
      cohorts.countCohorts(this.games, userId, this.catalog),
      this.jobs.find({ userId }).sort({ createdAt: -1 }).limit(1).next(),
      this._agent(userId),
    ]);
    if (job?.active) this._watch(userId, job, agent.state);
    return {
      catalogRevision: counts.catalogRevision,
      cohorts: counts.cohorts.map(({ versions: _versions, ...cohort }) => cohort),
      job: jobView(job, this.now()),
      agent: agent.state,
    };
  }

  /** POST /v1/me/reanalysis {cohortId}. @param {string} userId @param {unknown} body */
  async start(userId, body) {
    const { cohortId } = exactBody(body, ["cohortId"]);
    if (!cohorts.isKnownCohort(cohortId, this.catalog)) throw fail(400, "reanalysis_cohort_unknown");
    if (await this.jobs.findOne({ userId, active: true }, { projection: { _id: 1 } })) throw fail(409, "reanalysis_job_active");
    const counts = await cohorts.countCohorts(this.games, userId, this.catalog);
    const cohort = counts.cohorts.find((entry) => entry.id === cohortId);
    if (!cohort || cohort.count === 0) throw fail(409, "reanalysis_cohort_empty");
    if ((cohort.versions?.length || 0) > cohorts.MAX_JOB_VERSIONS) throw fail(409, "reanalysis_cohort_too_varied");
    const agent = await this._agent(userId);
    const now = new Date(this.now());
    const doc = stampVersion({
      _id: new ObjectId(),
      userId,
      cohortId,
      catalogRevision: counts.catalogRevision,
      ...(cohort.kind === "engine" ? { engine: cohort.engine, matchups: cohort.matchups, versions: cohort.versions } : {}),
      status: agent.state === "ready" ? "running" : agent.state === "update_required" ? "update_required" : "waiting_for_agent",
      active: true,
      generation: 1,
      seq: 0,
      total: cohort.count,
      processed: 0,
      updated: 0,
      unavailable: 0,
      failed: 0,
      cursor: null,
      batch: null,
      activeMs: 0,
      runningSince: agent.state === "ready" ? now : null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    }, COLLECTIONS.REANALYSIS_JOBS);
    try {
      await this.jobs.insertOne(doc);
    } catch (error) {
      if (isDuplicateKey(error)) throw fail(409, "reanalysis_job_active");
      throw error;
    }
    this._progress(userId, doc, true);
    if (agent.state === "ready") void this._schedule(userId, false);
    return { job: jobView(doc, this.now()) };
  }

  /**
   * POST /v1/me/reanalysis/{pause,resume,cancel} {jobId}. Idempotent.
   * @param {string} userId @param {"pause"|"resume"|"cancel"} action @param {unknown} body
   */
  async control(userId, action, body) {
    const { jobId } = exactBody(body, ["jobId"]);
    if (typeof jobId !== "string" || !JOB_ID.test(jobId)) throw fail(400, "reanalysis_request_invalid");
    const _id = new ObjectId(jobId);
    // A concurrent status change (agent connects, batch completes) is retried.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const job = await this.jobs.findOne({ _id, userId }, { projection: JOB_VIEW_PROJECTION });
      if (!job) throw fail(404, "reanalysis_job_not_found");
      const now = this.now();
      if (!job.active) {
        if (action === "cancel" && job.status === "cancelled") return { job: jobView(job, now) };
        throw fail(409, "reanalysis_job_finished");
      }
      if ((action === "pause" && job.status === "paused") || (action === "resume" && job.status !== "paused")) {
        return { job: jobView(job, now) };
      }
      const updated = await this.jobs.findOneAndUpdate(
        { _id, userId, active: true, generation: job.generation, status: job.status },
        controlUpdate(action, job, now),
        { returnDocument: "after", projection: JOB_VIEW_PROJECTION },
      );
      if (!updated) continue;
      if (action === "resume") void this._schedule(userId, false);
      else this._stopOnAgents(userId, jobId, updated.generation);
      this._progress(userId, updated, true);
      return { job: jobView(updated, this.now()) };
    }
    throw fail(409, "reanalysis_job_changed");
  }

  /**
   * A device socket finished its handshake: resume or redeliver its owner's
   * job (the agent answers a batch it already holds with what it settled).
   * @param {any} data
   * @returns {Promise<void>}
   */
  async deviceReady(data) {
    const userId = data?.kind === "device" && typeof data.userId === "string" ? data.userId : null;
    if (!userId) return;
    try {
      if (await this.jobs.findOne({ userId, active: true }, { projection: { _id: 1 } })) await this._schedule(userId, "always");
    } catch (error) {
      this.logger?.warn({ err: error }, "reanalysis_device_ready_failed");
    }
  }

  /**
   * `reanalyze:outcome` from an authenticated device socket of the owner.
   * @param {any} data socket.data @param {unknown} raw
   */
  async recordOutcome(data, raw) {
    const userId = data?.kind === "device" && typeof data.userId === "string" ? data.userId : null;
    if (!userId || !DEVICE_ID.test(String(data.deviceId || ""))) return false;
    const outcome = parseOutcomeEvent(raw);
    if (!outcome) return false;
    const job = await this.jobs.findOne(
      { _id: new ObjectId(outcome.jobId), userId, active: true },
      { projection: { "batch.seq": 1, "batch.createdAt": 1 } },
    );
    if (!job?.batch || job.batch.seq !== outcome.seq) return false;
    const settled = await this._settle(userId, job._id, job.batch, outcome);
    if (settled) {
      this._progress(userId, settled, false);
      void this._schedule(userId, false);
    }
    return Boolean(settled);
  }

  /**
   * Serialize work per owner; coalesce triggers that arrive while one waits.
   * @param {string} userId @param {string|false} redeliver
   */
  _schedule(userId, redeliver) {
    const pending = this.kicks.get(userId);
    if (pending && !pending.started) {
      if (redeliver === "always" || (redeliver && !pending.redeliver)) pending.redeliver = redeliver;
      return pending.promise;
    }
    const entry = { started: false, redeliver, promise: Promise.resolve() };
    const previous = pending ? pending.promise : Promise.resolve();
    entry.promise = previous.catch(() => undefined).then(() => {
      entry.started = true;
      return this._kick(userId, entry.redeliver);
    }).catch((error) => {
      this.logger?.warn({ err: error }, "reanalysis_kick_failed");
    }).finally(() => {
      if (this.kicks.get(userId) === entry) this.kicks.delete(userId);
    });
    this.kicks.set(userId, entry);
    return entry.promise;
  }

  /** @param {string} userId @param {any} job @param {string} agentState */
  _watch(userId, job, agentState) {
    const now = this.now();
    const stale = job.batch && job.batch.lastActivityAt instanceof Date && now - job.batch.lastActivityAt.getTime() > this.stallMs;
    const mismatch = (job.status === "running") !== (agentState === "ready")
      || (job.status === "waiting_for_agent" && agentState === "update_required")
      || (job.status === "update_required" && agentState === "offline");
    const undelivered = job.status === "running" && job.batch && job.batch.ackedGeneration !== job.generation;
    if (job.status !== "paused" && (mismatch || stale || undelivered)) void this._schedule(userId, stale ? "stale" : false);
  }

  /** @param {string} userId @param {string|false} redeliver */
  async _kick(userId, redeliver) {
    for (let step = 0; step < MAX_KICK_STEPS; step += 1) {
      const job = await this.jobs.findOne({ userId, active: true });
      if (!job || job.status === "paused") return;
      const inFlight = job.status === "running" && job.batch && job.batch.ackedGeneration === job.generation && !batchSettled(job.batch);
      if (inFlight && !redeliver) return;
      const now = this.now();
      if (inFlight && redeliver === "stale" && !(job.batch.lastActivityAt instanceof Date && now - job.batch.lastActivityAt.getTime() > this.stallMs)) return;
      const agent = await this._agent(userId);
      if (agent.state !== "ready") {
        await this._setWaiting(job, agent.state === "update_required" ? "update_required" : "waiting_for_agent");
        return;
      }
      if (job.status !== "running") {
        const at = new Date(now);
        const running = await this.jobs.findOneAndUpdate(
          { _id: job._id, active: true, status: job.status, generation: job.generation },
          { $set: { status: "running", runningSince: at, updatedAt: at } },
          { returnDocument: "after", projection: JOB_VIEW_PROJECTION },
        );
        if (!running) return;
        this._progress(userId, running, true);
        continue;
      }
      if (!job.batch) {
        if (!await this._nextBatch(job)) return;
        continue;
      }
      if (batchSettled(job.batch) && job.batch.acked === true) {
        await this.jobs.updateOne(
          { _id: job._id, active: true, status: "running", "batch.seq": job.batch.seq },
          { $set: { cursor: job.batch.lastGameId, batch: null, updatedAt: new Date(now) } },
        );
        continue;
      }
      // An unanswered delivery waits for the next trigger instead of retrying here.
      if (!await this._dispatch(job, agent.device)) return;
      redeliver = false;
    }
    // Every step above made progress; keep going in a fresh turn.
    void this._schedule(userId, false);
  }

  /** @param {any} job */
  async _nextBatch(job) {
    const items = await cohorts.selectCohortPage(this.games, job.userId, job, BATCH_SIZE);
    const now = new Date(this.now());
    if (items.length === 0) {
      const done = await this.jobs.findOneAndUpdate(
        { _id: job._id, active: true, status: "running", generation: job.generation, batch: null },
        { $set: { status: "completed", active: false, runningSince: null, completedAt: now, updatedAt: now },
          $inc: { activeMs: elapsedMs(job, now.getTime()) } },
        { returnDocument: "after", projection: JOB_VIEW_PROJECTION },
      );
      if (done) {
        this._progress(job.userId, done, true);
        await this._notifyFinished(done);
      }
      return false;
    }
    const batch = {
      seq: (Number(job.seq) || 0) + 1,
      items: items.map((item) => ({ gameId: item.gameId, original: item.original, outcome: null })),
      lastGameId: items[items.length - 1].gameId,
      createdAt: now,
      dispatchedAt: null,
      deviceId: null,
      acked: false,
      ackedGeneration: 0,
      lastActivityAt: now,
      stalls: 0,
    };
    const result = await this.jobs.updateOne(
      { _id: job._id, active: true, status: "running", generation: job.generation, batch: null, seq: job.seq },
      { $set: { batch, seq: batch.seq, updatedAt: now } },
    );
    return result.modifiedCount === 1;
  }

  /**
   * Deliver the batch's open games; true once the agent accepted them.
   * @param {any} job @param {any} device
   */
  async _dispatch(job, device) {
    const userId = job.userId;
    const pending = job.batch.items.filter((/** @type {any} */ item) => typeof item.outcome !== "string");
    if (pending.length === 0) return false;
    const at = new Date(this.now());
    const claimed = await this.jobs.findOneAndUpdate(
      { _id: job._id, active: true, status: "running", generation: job.generation, "batch.seq": job.batch.seq,
        "batch.dispatchedAt": job.batch.dispatchedAt ?? null },
      { $set: { "batch.dispatchedAt": at, "batch.deviceId": device.data.deviceId, updatedAt: at } },
      { returnDocument: "after", projection: { _id: 1 } },
    );
    if (!claimed) return false;
    if (!await this._current(device, userId)) {
      await this._stall(job);
      return false;
    }
    const payload = {
      version: 1,
      jobId: String(job._id),
      generation: job.generation,
      seq: job.batch.seq,
      deviceId: device.data.deviceId,
      sessionId: device.id,
      games: pending.map((/** @type {any} */ item) => ({ gameId: item.gameId, original: item.original || null })),
    };
    let reply = null;
    try {
      reply = await bounded(device.timeout(this.ackTimeoutMs).emitWithAck("reanalyze:batch", payload), this.ackTimeoutMs + 500);
    } catch {
      reply = null;
    }
    const ack = parseAck(reply, payload);
    if (ack?.code === "unsupported" || ack?.code === "invalid_request") {
      // This agent cannot run this protocol; a newer agent can.
      await this._setWaiting(job, "update_required");
      return false;
    }
    if (!ack || ack.code !== "accepted") {
      await this._stall(job);
      return false;
    }
    const acked = new Date(this.now());
    const marked = await this.jobs.updateOne(
      { _id: job._id, active: true, generation: job.generation, "batch.seq": job.batch.seq },
      { $set: { "batch.acked": true, "batch.ackedGeneration": job.generation, "batch.lastActivityAt": acked, "batch.stalls": 0, updatedAt: acked } },
    );
    let latest = null;
    for (const outcome of ack.outcomes) latest = await this._settle(userId, job._id, job.batch, outcome) || latest;
    if (latest) this._progress(userId, latest, false);
    return marked.matchedCount === 1;
  }

  /**
   * An unanswered delivery. Once an agent had accepted this batch and then
   * missed MAX_STALLS redeliveries, its remaining games settle as failed so
   * one stuck item cannot hold the job forever. A batch no agent ever accepted
   * is never failed this way: it simply waits.
   * @param {any} job
   */
  async _stall(job) {
    const at = new Date(this.now());
    const stalled = await this.jobs.findOneAndUpdate(
      { _id: job._id, active: true, "batch.seq": job.batch.seq },
      { $inc: { "batch.stalls": 1 }, $set: { updatedAt: at } },
      { returnDocument: "after", projection: { "batch.seq": 1, "batch.stalls": 1, "batch.acked": 1, "batch.items": 1, "batch.createdAt": 1 } },
    );
    if (!stalled?.batch || stalled.batch.acked !== true || stalled.batch.stalls < MAX_STALLS) return;
    let latest = null;
    for (const item of stalled.batch.items) {
      if (typeof item.outcome === "string") continue;
      latest = await this._settle(job.userId, job._id, stalled.batch, { gameId: item.gameId, outcome: "no_result", engineVersion: null }) || latest;
    }
    await this.jobs.updateOne({ _id: job._id, active: true, "batch.seq": job.batch.seq }, { $set: { "batch.acked": true } });
    if (latest) this._progress(job.userId, latest, true);
    void this._schedule(job.userId, false);
  }

  /**
   * Record one terminal outcome exactly once (the item must still be open).
   * @param {string} userId @param {any} jobId @param {any} batch
   * @param {{gameId: string, outcome: string, engineVersion: string|null}} outcome
   */
  async _settle(userId, jobId, batch, outcome) {
    let counter = OUTCOMES.get(outcome.outcome);
    if (!counter) return null;
    if (counter === "updated" && !await this._verifiedUpload(userId, outcome, batch.createdAt)) counter = "failed";
    const at = new Date(this.now());
    return this.jobs.findOneAndUpdate(
      { _id: jobId, userId, active: true, "batch.seq": batch.seq,
        "batch.items": { $elemMatch: { gameId: outcome.gameId, outcome: null } } },
      { $set: { "batch.items.$.outcome": outcome.outcome, "batch.lastActivityAt": at, updatedAt: at },
        $inc: { processed: 1, [counter]: 1 } },
      { returnDocument: "after", projection: JOB_VIEW_PROJECTION },
    );
  }

  /**
   * The agent's claim must match the stored row: an agent upload newer than
   * the batch, carrying the engine version the agent reported for the parse.
   * @param {string} userId @param {{gameId: string, engineVersion: string|null}} outcome @param {unknown} since
   */
  async _verifiedUpload(userId, outcome, since) {
    const row = await this.games.findOne(
      { userId, gameId: outcome.gameId },
      { projection: { _id: 0, ingestSource: 1, engineVersion: 1, updatedAt: 1 } },
    );
    if (!row || row.ingestSource !== "agent" || !(row.updatedAt instanceof Date) || !(since instanceof Date)) return false;
    if (row.updatedAt.getTime() < since.getTime()) return false;
    return outcome.engineVersion === null || row.engineVersion === outcome.engineVersion;
  }

  /** @param {any} job @param {"waiting_for_agent"|"update_required"} status */
  async _setWaiting(job, status) {
    if (job.status === status) return;
    const now = this.now();
    const at = new Date(now);
    const updated = await this.jobs.findOneAndUpdate(
      { _id: job._id, active: true, status: job.status, generation: job.generation },
      { $set: { status, runningSince: null, updatedAt: at }, $inc: { activeMs: elapsedMs(job, now) } },
      { returnDocument: "after", projection: JOB_VIEW_PROJECTION },
    );
    if (updated) this._progress(job.userId, updated, true);
  }

  /** One bounded presence read of the owner's sockets, never a broadcast. @param {string} userId */
  async _agent(userId) {
    /** @type {any[]} */
    let sockets = [];
    if (this.io) {
      try { sockets = await bounded(this.io.in(`user:${userId}`).fetchSockets(), PRESENCE_TIMEOUT_MS); } catch { sockets = []; }
    }
    const devices = sockets.filter((socket) => socket?.data?.kind === "device" && String(socket.data.userId) === userId).slice(0, 32);
    const capable = devices.find((socket) => socket.data.reanalysisVersion === 1 && DEVICE_ID.test(String(socket.data.deviceId || "")));
    if (capable) return { state: "ready", device: capable };
    return { state: devices.length > 0 ? "update_required" : "offline", device: null };
  }

  /** Re-read the device credential before handing it work. @param {any} device @param {string} userId */
  async _current(device, userId) {
    if (!this.pairings) return true;
    const token = device?.handshake?.auth?.deviceToken;
    if (typeof token !== "string" || !token) return false;
    try {
      const hit = await bounded(this.pairings.findTokenByHash(sha256(token)), PRESENCE_TIMEOUT_MS);
      return hit?.userId === userId && hit.deviceId === device.data.deviceId;
    } catch {
      return false;
    }
  }

  /** @param {string} userId @param {string} jobId @param {number} generation */
  _stopOnAgents(userId, jobId, generation) {
    try { this.io?.to(`user:${userId}`).emit("reanalyze:cancel", { jobId, generation }); } catch { /* advisory */ }
  }

  /** @param {string} userId @param {any} job @param {boolean} force */
  _progress(userId, job, force) {
    if (!this.io || !job) return;
    const now = this.now();
    const last = this.lastProgress.get(userId) || 0;
    if (!force && now - last < PROGRESS_INTERVAL_MS) return;
    this.lastProgress.set(userId, now);
    if (this.lastProgress.size > 4096) this.lastProgress.delete(this.lastProgress.keys().next().value || "");
    try { this.io.to(`user:${userId}`).emit("reanalysis:progress", jobView(job, now)); } catch { /* advisory */ }
  }

  /** @param {any} job */
  async _notifyFinished(job) {
    if (!this.notifications) return;
    const notes = [
      job.unavailable ? `${job.unavailable} had no replay file on this PC or in your replay archive.` : "",
      job.failed ? `${job.failed} could not be updated.` : "",
    ].filter(Boolean).join(" ");
    try {
      await this.notifications.notify(job.userId, {
        kind: "data.reanalysis",
        title: "Re-analysis finished",
        body: `${job.updated} of ${job.processed} games now use the current analysis.${notes ? ` ${notes}` : ""}`,
        href: "/settings?tab=backups#reanalyze",
        eventKey: `reanalysis:${String(job._id)}`,
      });
    } catch (error) {
      this.logger?.warn({ err: error }, "reanalysis_notification_failed");
    }
  }
}

/**
 * Wipes and restores replace game history: drop the owner's jobs and tell
 * the agent to stop, so an in-flight batch cannot re-upload removed games.
 * @param {import('mongodb').Collection|undefined} jobs @param {any} io @param {string} userId
 */
async function retireReanalysisJobs(jobs, io, userId) {
  if (!jobs) return 0;
  const active = await jobs.findOne({ userId, active: true }, { projection: { _id: 1, generation: 1 } });
  const result = await jobs.deleteMany({ userId });
  if (active) {
    try { io?.to(`user:${userId}`).emit("reanalyze:cancel", { jobId: String(active._id), generation: (Number(active.generation) || 0) + 1 }); } catch { /* advisory */ }
  }
  return result.deletedCount || 0;
}

module.exports = { ReanalysisService, retireReanalysisJobs, jobView, parseAck, parseOutcomeEvent, BATCH_SIZE };
