"use strict";

const { randomUUID } = require("crypto");
const { COLLECTIONS } = require("../config/constants");
const { expectedVersion, stampVersion } = require("../db/schemaVersioning");
const { evaluateRules } = require("./buildRulesEvaluator");
const { computeDossierExtras } = require("./buildDossier");
const { computeCompositions } = require("./buildCompositions");
const { computeTransitions } = require("./buildTransitions");
const TimingCatalog = require("./timingCatalog");
const { parseBuildLogLines, eventsToStartTime } = require("./perGameCompute");
const {
  assertNoActiveOpponentBuildOrderWrites,
  assertStableOpponentBuildOrderPage,
  isRetryableReclassificationError,
} = require("./opponentBuildOrderFence");

const STATS_GAME_SCAN_CAP = 1000;
const RECENT_GAMES_LIMIT = 50;
const RECLASSIFY_MAX_ATTEMPTS = 3;
const RECLASSIFY_RETRY_BASE_MS = 250;
const RECLASSIFY_WORKER_RETRY_MS = 1000;
const RECLASSIFY_LEASE_MS = 60 * 1000;
const RECLASSIFY_LEASE_RENEW_MS = 20 * 1000;
const RECLASSIFY_RECOVERY_INTERVAL_MS = 15 * 1000;

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {Date} now */
function runnableReclassificationMatch(now) {
  return {
    $or: [
      {
        $and: [
          { status: "queued" },
          { $or: [
            { notBefore: { $exists: false } },
            { notBefore: { $lte: now } },
          ] },
        ],
      },
      { status: "running", leaseUntil: { $lte: now } },
      { status: "running", leaseUntil: { $exists: false } },
    ],
  };
}

/**
 * Custom builds service. Per-user authored builds. Stored under
 * (userId, slug) — slug is a stable client-generated id.
 *
 * NOTE: shared community-builds remain in cloud/community-builds/ —
 * this is the user's PRIVATE library, which they may publish to the
 * community DB via a separate flow.
 *
 * Rule evaluation:
 *   The /v1/builds endpoint groups stored games by `myBuild`, which
 *   only reflects what the agent classified at upload time. A custom
 *   build the user just saved has zero matching games until the agent
 *   reclassifies, leaving the BuildCard stuck on "0 games" even though
 *   the live preview pinged "1 match".
 *
 *   `evaluateBuild` and `evaluateAllStats` re-run the saved rules
 *   against the user's last N games at request time, so the library
 *   and detail views show real numbers immediately.
 */
class CustomBuildsService {
  /**
   * @param {{
   *   customBuilds: import('mongodb').Collection,
   *   customBuildJobs?: import('mongodb').Collection,
   * }} db
   * @param {{
   *   perGame?: import('./types').PerGameComputeService,
   *   logger?: {warn?: Function, error?: Function},
   *   onReclassified?: (userId: string, result: Record<string, any>) => void|Promise<void>,
   * }} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    // Production uses a dedicated, stable per-user job document. Focused
    // legacy test doubles fall back to a sibling collection from the same DB.
    this.reclassifyJobs = db.customBuildJobs
      || /** @type {any} */ (db.customBuilds).s.db.collection("custom_build_jobs");
    this.perGame = opts.perGame || null;
    this.logger = opts.logger || null;
    this.onReclassified = opts.onReclassified || null;
    this._reclassifyQueuedUsers = new Set();
    this._reclassifyWorker = null;
    /** @type {{
     *   userId: string,
     *   slug: string,
     *   mode: string,
     *   generation: string,
     *   controller: AbortController,
     *   finished: Promise<void>,
     *   finish: () => void,
     * } | null} */
    this._activeReclassify = null;
    this._reclassifyStopping = false;
    this._reclassifyRecoveryTimer = null;
  }

  /**
   * Iterate rule-evaluation pages in production, with a compatibility
   * fallback for narrow test doubles. Production callers always choose one
   * perspective, keeping detail hydration memory bounded.
   * @param {string} userId
   * @param {{
   *   limit?: number,
   *   pageSize?: number,
   *   perspective?: "you"|"opponent"|"both",
   *   includeMacroBreakdown?: boolean,
   *   filters?: object,
   *   match?: Record<string, unknown>,
   *   metadataFilter?: (game: {
   *     gameId?: string,
   *     myBuild?: string|null,
   *     customBuildSlug?: string|null,
   *     _customBuildSlug?: string|null,
   *     myRace?: string|null,
   *     opponent?: {displayName?: string|null, race?: string|null, strategy?: string|null}|null,
   *   }) => boolean,
   *   signal?: AbortSignal,
   *   strictDetails?: boolean,
   * }} [opts]
   * @returns {AsyncGenerator<{games: import('./types').PerGameComputeServiceListedGame[], candidates: number, hasMore: boolean}>}
   * @private
   */
  async *_rulePages(userId, opts = {}) {
    if (this.perGame && typeof this.perGame.iterateRulePreviewPages === "function") {
      yield* this.perGame.iterateRulePreviewPages(userId, opts);
      return;
    }
    if (!this.perGame) throw new Error("perGame_unavailable");
    const games = await this.perGame.listForRulePreview(userId, {
      limit: opts.limit || STATS_GAME_SCAN_CAP,
      includeMacroBreakdown: opts.includeMacroBreakdown,
      filters: opts.filters,
      match: opts.match,
    });
    const filtered = typeof opts.metadataFilter === "function"
      ? games.filter(opts.metadataFilter)
      : games;
    yield { games: filtered, candidates: games.length, hasMore: false };
  }

  /**
   * @param {string} userId
   * @returns {Promise<Array<import('./types').CustomBuildRecord & {slug: string}>>}
   */
  async list(userId) {
    return /** @type {Promise<Array<import('./types').CustomBuildRecord & {slug: string}>>} */ (/** @type {unknown} */ (
      this.db.customBuilds
      .find(
        { userId, deletedAt: { $exists: false } },
        { projection: { _id: 0, reclassifyJob: 0 } },
      )
      .sort({ updatedAt: -1 })
      .toArray()
    ));
  }

  /**
   * @param {string} userId
   * @param {string} slug
   */
  async get(userId, slug) {
    return this.db.customBuilds.findOne(
      { userId, slug, deletedAt: { $exists: false } },
      { projection: { _id: 0, reclassifyJob: 0 } },
    );
  }

  /**
   * Project only fields the rule classifier consumes. Saved builds may carry
   * notes/source payloads and future editor metadata; none of that should be
   * retained while a full replay-history scan is running.
   * @param {string} userId
   */
  async _listForClassification(userId) {
    return this.db.customBuilds.find(
      { userId, deletedAt: { $exists: false } },
      {
        projection: {
          _id: 0,
          slug: 1,
          name: 1,
          race: 1,
          vsRace: 1,
          perspective: 1,
          rules: 1,
          signature: 1,
          updatedAt: 1,
        },
      },
    ).sort({ updatedAt: -1 }).toArray();
  }

  /**
   * Idempotent upsert. Updates updatedAt on every write.
   *
   * @param {string} userId
   * @param {{slug: string} & Record<string, unknown>} build
   */
  async upsert(userId, build) {
    if (!build || !build.slug) throw new Error("slug required");
    const now = new Date();
    /** @type {Record<string, any>} */
    const doc = { ...build, userId, updatedAt: now };
    delete doc._id;
    delete doc.deletedAt;
    delete doc._schemaVersion;
    // Background classification state is server-owned. Never allow a web
    // client save to forge, erase, or replace it.
    delete doc.reclassifyJob;
    stampVersion(doc, COLLECTIONS.CUSTOM_BUILDS);
    await this.db.customBuilds.updateOne(
      { userId, slug: build.slug },
      { $setOnInsert: { createdAt: now }, $set: doc, $unset: { deletedAt: "" } },
      { upsert: true },
    );
  }

  /**
   * Persist a coalescing background reclassification request.
   * @param {string} userId
   * @param {string} slug
   * @param {{replace?: boolean, previousNames?: string[]}} [opts]
   */
  async enqueueReclassify(userId, slug, opts = {}) {
    const previousNames = Array.isArray(opts.previousNames)
      ? opts.previousNames.filter((n) => typeof n === "string" && n)
      : [];
    const queued = await this._queueAllReclassification(userId, {
      clearUnmatched: opts.replace !== false,
      previousNamesBySlug: previousNames.length > 0 ? { [slug]: previousNames } : {},
    });
    this._abortSupersededReclassification(userId, slug);
    this._startReclassifyWorker(userId);
    return queued;
  }

  /**
   * Queue one deterministic all-build closest-winner pass.
   * @param {string} userId
   * @param {{
   *   clearUnmatched?: boolean,
   *   previousNamesBySlug?: Record<string, string[]>,
   * }} [opts]
   */
  async enqueueReclassifyAll(userId, opts = {}) {
    const builds = await this.db.customBuilds.countDocuments(
      { userId, deletedAt: { $exists: false } },
    );
    const queued = await this._queueAllReclassification(userId, {
      clearUnmatched: !!opts.clearUnmatched,
      previousNamesBySlug: opts.previousNamesBySlug || {},
    });
    this._abortSupersededReclassification(userId, null);
    this._startReclassifyWorker(userId);
    return { ...queued, builds };
  }

  /**
   * Coalesce every edit into one user-wide closest-winner pass. A stable job
   * document avoids the old arbitrary-build anchor, which could overwrite an
   * all-build request or lose rename history.
   * @param {string} userId
   * @param {{clearUnmatched: boolean, previousNamesBySlug: Record<string, string[]>}} opts
   */
  async _queueAllReclassification(userId, opts) {
    const requestedAt = new Date();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await this.reclassifyJobs.findOne({ userId });
      const carryForward = current
        && current.status !== "complete"
        && current.status !== "cancelled";
      const previousNamesBySlug = mergePreviousNamesBySlug(
        carryForward ? current.previousNamesBySlug : null,
        opts.previousNamesBySlug,
      );
      const generation = randomUUID();
      // Persist wall-clock monotonic ordering rather than a resettable counter.
      // `custom_build_jobs` is purge-only, while game backups may retain their
      // last classification sequence; a recreated job must still outrank it.
      const sequence = Math.max(
        requestedAt.getTime(),
        Math.max(0, Number(current && current.sequence) || 0) + 1,
      );
      try {
        const result = await this.reclassifyJobs.updateOne(
          current
            ? { userId, generation: current.generation }
            : { userId, generation: { $exists: false } },
          {
            $set: {
               userId,
               generation,
              sequence,
              status: "queued",
              requestedAt,
              clearUnmatched: opts.clearUnmatched
                || !!(carryForward && current.clearUnmatched),
              previousNamesBySlug,
              attempts: 0,
              progress: { scanned: 0, tagged: 0, cleared: 0 },
              _schemaVersion: expectedVersion(COLLECTIONS.CUSTOM_BUILD_JOBS),
            },
            $unset: {
              leaseToken: "",
              leaseUntil: "",
              notBefore: "",
              completedAt: "",
              failedAt: "",
              error: "",
            },
          },
          { upsert: !current },
        );
        if (result.matchedCount > 0 || result.upsertedCount > 0) {
          return { status: "queued", generation, sequence, requestedAt };
        }
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
      }
    }
    throw new Error("custom_build_reclassify_enqueue_conflict");
  }

  /** Recover queued/running work after a process restart. */
  async recoverQueuedReclassifications() {
    if (!this._reclassifyRecoveryTimer && !this._reclassifyStopping) {
      this._reclassifyRecoveryTimer = setInterval(() => {
        void this._recoverRunnableReclassificationUsers().catch((err) => {
          if (this.logger?.error) {
            this.logger.error(
              { err },
              "custom_build_reclassify_recovery_failed",
            );
          }
        });
      }, RECLASSIFY_RECOVERY_INTERVAL_MS);
      if (typeof this._reclassifyRecoveryTimer.unref === "function") {
        this._reclassifyRecoveryTimer.unref();
      }
    }
    // Install the retry lane before the initial read. A transient Mongo error
    // during boot must not permanently strand durable queued work.
    await this._recoverRunnableReclassificationUsers();
  }

  async _recoverRunnableReclassificationUsers() {
    const now = new Date();
    const users = await this.reclassifyJobs.distinct(
      "userId",
      runnableReclassificationMatch(now),
    );
    for (const userId of users) this._startReclassifyWorker(userId);
  }

  /** @param {string} userId */
  _startReclassifyWorker(userId) {
    if (this._reclassifyStopping) return;
    this._reclassifyQueuedUsers.add(userId);
    if (this._reclassifyWorker) return;
    this._reclassifyWorker = this._drainGlobalReclassifyQueue()
      .catch((err) => {
        if (this.logger?.error) {
          this.logger.error({ err }, "custom_build_reclassify_worker_failed");
        }
      })
      .finally(() => {
        this._reclassifyWorker = null;
        if (this._reclassifyQueuedUsers.size > 0) {
          const next = this._reclassifyQueuedUsers.values().next().value;
          if (next) this._startReclassifyWorker(next);
        }
      });
  }

  async _drainGlobalReclassifyQueue() {
    while (!this._reclassifyStopping && this._reclassifyQueuedUsers.size > 0) {
      const userId = this._reclassifyQueuedUsers.values().next().value;
      this._reclassifyQueuedUsers.delete(userId);
      try {
        await this._drainReclassifyJobs(userId);
      } catch (err) {
        if (this.logger?.error) {
          this.logger.error(
            { err, userId },
            "custom_build_reclassify_queue_failed",
          );
        }
        if (!this._reclassifyStopping) {
          await delay(RECLASSIFY_WORKER_RETRY_MS);
          this._reclassifyQueuedUsers.add(userId);
        }
      }
    }
  }

  /** @param {string} userId */
  async _drainReclassifyJobs(userId) {
    for (;;) {
      if (this._reclassifyStopping) return;
      const now = new Date();
      const leaseToken = randomUUID();
      const job = await this.reclassifyJobs.findOneAndUpdate(
        { userId, ...runnableReclassificationMatch(now) },
        { $set: {
          status: "running",
          startedAt: now,
          leaseToken,
          leaseUntil: new Date(now.getTime() + RECLASSIFY_LEASE_MS),
        }, $inc: { sequence: 1 }, $unset: { notBefore: "" } },
        {
          projection: { _id: 0 },
          returnDocument: "after",
        },
      );
      if (!job) return;
      const slug = "*";
      const generation = job.generation;
      if (this._reclassifyStopping) {
        await this.reclassifyJobs.updateOne(
          {
            userId,
            generation,
            leaseToken,
          },
          { $set: {
            status: "queued",
            interruptedAt: new Date(),
          } },
        );
        return;
      }
      const controller = new AbortController();
      /** @type {() => void} */
      let finish = () => {};
      const finished = new Promise(/** @param {(value?: void) => void} resolve */ (resolve) => {
        finish = () => resolve();
      });
      this._activeReclassify = {
        userId,
        slug,
        mode: "all",
        generation,
        controller,
        finished,
        finish,
      };
      let leaseLost = false;
      const renewLease = async () => {
        const renewed = await this.reclassifyJobs.updateOne(
          {
            userId,
            generation,
            leaseToken,
            status: "running",
          },
          { $set: {
            leaseUntil: new Date(Date.now() + RECLASSIFY_LEASE_MS),
          } },
        );
        if (renewed.matchedCount === 0) {
          leaseLost = true;
          controller.abort();
        }
      };
      const leaseTimer = setInterval(() => {
        void renewLease().catch((err) => {
          leaseLost = true;
          controller.abort();
          if (this.logger?.error) {
            this.logger.error(
              { err, userId, slug },
              "custom_build_reclassify_lease_renew_failed",
            );
          }
        });
      }, RECLASSIFY_LEASE_RENEW_MS);
      if (typeof leaseTimer.unref === "function") leaseTimer.unref();
      const assertLease = async () => {
        if (controller.signal.aborted) throw abortError();
        const current = await this.reclassifyJobs.findOne(
          { userId, generation, leaseToken, status: "running" },
          { projection: { _id: 1 } },
        );
        if (current) return;
        leaseLost = true;
        controller.abort();
        throw abortError();
      };
      try {
        const result = await this.reclassifyAll(userId, {
          clearUnmatched: !!job.clearUnmatched,
          previousNamesBySlug: job.previousNamesBySlug || {},
          signal: controller.signal,
          assertLease,
          jobSequence: Number(job.sequence) || 0,
        });
        await assertLease();
        const completed = await this.reclassifyJobs.updateOne(
          {
            userId,
            generation,
            leaseToken,
            status: "running",
          },
          { $set: {
            status: "complete",
            completedAt: new Date(),
            progress: result || {},
          } },
        );
        if (completed.matchedCount > 0 && result && this.onReclassified) {
          try {
            await this.onReclassified(userId, result);
          } catch (err) {
            if (this.logger?.warn) {
              this.logger.warn(
                { err, userId, slug },
                "custom_build_reclassify_notify_failed",
              );
            }
          }
        }
      } catch (err) {
        if (controller.signal.aborted) {
          if (leaseLost) return;
          await this.reclassifyJobs.updateOne(
            {
              userId,
              generation,
              leaseToken,
            },
            { $set: {
              status: "queued",
              interruptedAt: new Date(),
            } },
          );
          if (this._reclassifyStopping) return;
          break;
        }
        const retryDetailWrite = isRetryableReclassificationError(err);
        const attempts = retryDetailWrite
          ? Number(job.attempts || 0)
          : Number(job.attempts || 0) + 1;
        const requestedRetryDelay = retryDetailWrite
          && err && typeof err === "object" && "retryAfterMs" in err
          ? Number(/** @type {{retryAfterMs?: unknown}} */ (err).retryAfterMs)
          : 0;
        const retryDelayMs = retryDetailWrite
          ? Math.max(1_000, Math.min(15_000, requestedRetryDelay || 5_000))
          : RECLASSIFY_RETRY_BASE_MS * attempts;
        const queuedState = {
          status: "queued",
          attempts,
          error: errorMessage(err),
          ...(retryDetailWrite
            ? { notBefore: new Date(Date.now() + retryDelayMs) }
            : {}),
        };
        if (this.logger?.warn) {
          this.logger.warn(
            { err, userId, slug, attempts },
            "custom_build_reclassify_attempt_failed",
          );
        }
        await this.reclassifyJobs.updateOne(
          {
            userId,
            generation,
            leaseToken,
          },
          { $set: retryDetailWrite || attempts < RECLASSIFY_MAX_ATTEMPTS
            ? queuedState : {
            status: "failed",
            attempts,
            failedAt: new Date(),
            error: errorMessage(err),
          } },
        );
        if (retryDetailWrite) {
          const wakeTimer = setTimeout(() => {
            this._startReclassifyWorker(userId);
          }, retryDelayMs);
          if (typeof wakeTimer.unref === "function") wakeTimer.unref();
        } else if (attempts < RECLASSIFY_MAX_ATTEMPTS) {
          await delay(
            retryDelayMs,
          );
        }
      } finally {
        clearInterval(leaseTimer);
        if (this._activeReclassify?.controller === controller) {
          this._activeReclassify = null;
        }
        finish();
      }
      break;
    }
    if (!this._reclassifyStopping) {
      const pending = await this.reclassifyJobs.findOne(
        { userId, ...runnableReclassificationMatch(new Date()) },
        { projection: { _id: 1 } },
      );
      if (pending) this._reclassifyQueuedUsers.add(userId);
    }
  }

  /**
   * Abort an obsolete in-process generation. The durable replacement job is
   * already stored before this runs, so the worker immediately picks it up.
   * @param {string} userId
   * @param {string|null} slug null supersedes every job for the user
   */
  _abortSupersededReclassification(userId, slug) {
    const active = this._activeReclassify;
    if (!active || active.userId !== userId) return;
    if (slug === null || active.mode === "all" || active.slug === slug) {
      active.controller.abort();
    }
  }

  /** Stop and durably requeue any in-flight classifier before DB shutdown. */
  async stopReclassifications() {
    this._reclassifyStopping = true;
    if (this._reclassifyRecoveryTimer) {
      clearInterval(this._reclassifyRecoveryTimer);
      this._reclassifyRecoveryTimer = null;
    }
    if (this._activeReclassify) this._activeReclassify.controller.abort();
    if (this._reclassifyWorker) await this._reclassifyWorker;
    this._reclassifyQueuedUsers.clear();
  }

  /**
   * Cancel this user's durable and in-flight work before deleting replay or
   * account data. Waiting for the current page prevents a late classification
   * write from recreating state after a GDPR wipe.
   * @param {string} userId
   */
  async cancelUserReclassifications(userId) {
    this._reclassifyQueuedUsers.delete(userId);
    await this.reclassifyJobs.deleteOne({ userId });
    const active = this._activeReclassify;
    if (!active || active.userId !== userId) return;
    active.controller.abort();
    await active.finished;
  }

  /**
   * Soft-delete: keep the document so the agent's local cache can
   * reconcile, but mark it deleted so list queries skip it.
   *
   * @param {string} userId
   * @param {string} slug
   */
  async softDelete(userId, slug) {
    // Include an already-deleted row so a retry can recover the old display
    // name and recreate cleanup intent after a transient queue failure.
    const existing = await this.db.customBuilds.findOne(
      { userId, slug },
      { projection: { _id: 0, slug: 1, name: 1 } },
    );
    await this.db.customBuilds.updateOne(
      { userId, slug },
      { $set: { deletedAt: new Date() }, $unset: { reclassifyJob: "" } },
    );
    if (!existing || !this.perGame) return;
    const previousName = typeof existing.name === "string" && existing.name
      ? existing.name
      : existing.slug;
    await this._queueAllReclassification(userId, {
      clearUnmatched: true,
      previousNamesBySlug: previousName ? { [slug]: [previousName] } : {},
    });
    this._abortSupersededReclassification(userId, slug);
    this._startReclassifyWorker(userId);
  }

  /**
   * Re-run a saved build's rules against the user's recent games and
   * return the same shape /v1/builds/:name uses, plus the matching
   * games per map / matchup / strategy so BuildDetailView renders the
   * standard breakdown cards. Returns null when the build doesn't
   * exist for this user.
   *
   * @param {string} userId
   * @param {string} slug
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<null | {
   *   slug: string,
   *   name: string,
   *   totals: { wins: number, losses: number, total: number, winRate: number, lastPlayed: Date|null },
   *   byMatchup: Array<{name: string, wins: number, losses: number, total: number, winRate: number}>,
   *   byMap: Array<{name: string, wins: number, losses: number, total: number, winRate: number}>,
   *   byStrategy: Array<{name: string, wins: number, losses: number, total: number, winRate: number}>,
   *   recent: Array<{gameId: string, date: string|null, map: string, opponent: string, opp_race: string, opp_strategy: string|null, result: string|null, duration: number|null}>,
   *   scannedGames: number,
   *   ruleCount: number,
   * }>}
   */
  async evaluateBuild(userId, slug, opts = {}) {
    if (!this.perGame) throw new Error("perGame_unavailable");
    const build = await this.get(userId, slug);
    if (!build) return null;
    const rules = extractRules(build);
    const perspective = build.perspective === "opponent" ? "opponent" : "you";
    let scannedGames = 0;
    const matched = [];
    for await (const page of this._rulePages(userId, {
      limit: STATS_GAME_SCAN_CAP,
      pageSize: 50,
      perspective: "both",
      signal: opts.signal,
      metadataFilter: (g) => gameMatchesBuildMatchup(
        normaliseGameRaces(g), build, perspective,
      ),
    })) {
      scannedGames += page.games.length;
      for (const game of filterMatchingGames(page.games, rules, perspective)) {
        matched.push(toDossierAggregationGame(game));
      }
    }
    const extras = computeDossierExtras(matched);
    return {
      slug: build.slug,
      name: build.name || build.slug,
      totals: rollupTotals(matched),
      byMatchup: groupRows(matched, matchupKey),
      byMap: groupRows(matched, (g) => g.map || "Unknown"),
      byStrategy: groupRows(
        matched,
        (g) => (g.opponent && g.opponent.strategy) || "Unknown",
      ),
      recent: matched.slice(0, RECENT_GAMES_LIMIT).map(toRecent),
      scannedGames,
      ruleCount: rules.length,
      ...extras,
    };
  }

  /**
   * Latest game date (ms since epoch) for the user, or 0 when they
   * have no games yet. Exposed for the phase-cache key in the routes
   * layer so a freshly-ingested game invalidates a cached compositions
   * / transitions payload without waiting for the TTL. Hits the same
   * index ``/v1/games`` and the dossier services use, so this is a
   * single seek.
   *
   * @param {string} userId
   * @returns {Promise<number>}
   */
  async latestGameDateMs(userId) {
    const doc = await this._gamesCollection().findOne(
      { userId, isResumedFromReplay: { $ne: true } },
      { projection: { _id: 0, date: 1 }, sort: { date: -1 } },
    );
    if (!doc || !doc.date) return 0;
    return doc.date instanceof Date ? doc.date.getTime() : 0;
  }

  /**
   * Phase-aware analysis of a saved build's matched games. Feeds the
   * scouting widget (compositions panel) and the BuildDetail
   * transitions Sankey. Mirrors evaluateBuild's matchup-gate + rule-
   * evaluator pipeline but pulls the heavier ``macroBreakdown`` blob
   * per game (via ``includeMacroBreakdown: true``) so each matched
   * game carries the phase classifier's required input.
   *
   * ``includeTransitions=false`` skips the Sankey aggregation entirely
   * so the scouting widget can request only the compositions payload
   * — meaningfully cheaper than recomputing the full bundle.
   *
   * ``perspective`` overrides which side of the matched games the
   * classifier and the signature picker score. Defaults to the
   * build's stored perspective (a "this is what my opponent does"
   * build implicitly wants the opponent's trajectory) so existing
   * callers don't need to change. Caller can still override — the
   * StrategiesTabBuildVs comparison view fetches the same build
   * twice with different perspectives.
   *
   * ``strategyName`` restricts the rule-matched set to games where
   * ``opponent.strategy`` equals the requested value — the drill-down
   * passes it through so the left column describes the same build ×
   * strategy cell as the matrix the user clicked.
   *
   * @param {string} userId
   * @param {string} slug
   * @param {{ includeTransitions?: boolean, perspective?: "you"|"opponent", strategyName?: string|null, filters?: ReturnType<typeof import('../util/parseQuery').parseFilters> }} [opts]
   * @returns {Promise<null | {
   *   slug: string,
   *   name: string,
   *   perspective: "you"|"opponent",
   *   sampleSize: Record<string, number>,
   *   perPhase: Record<string, import('./types').BuildPhaseRow>,
   *   finalPhaseDistribution: Record<string, number>,
   *   medianCrossings: {
   *     earlyMidAt: number|null,
   *     midAt: number|null,
   *     midLateAt: number|null,
   *     lateAt: number|null,
   *   },
   *   durationP95Sec: number,
   *   flags: string[],
   *   transitions?: import('./types').BuildTransitionsPayload["transitions"],
   * }>}
   */
  /**
   * @param {string} userId
   * @param {{
   *   limit: number,
   *   pageSize: number,
   *   perspective: "you"|"opponent",
   *   build: Record<string, any>,
   *   rules: any[],
   *   strategyName: string|null,
   *   signal?: AbortSignal,
   *   filters?: object,
   *   match?: Record<string, unknown>,
   * }} opts
   */
  async _listForRulePhases(userId, opts) {
    /** @type {Record<string, any>[]} */
    const games = [];
    if (!Array.isArray(opts.rules) || opts.rules.length === 0) return games;
    for await (const page of this._rulePages(userId, {
      limit: opts.limit,
      pageSize: opts.pageSize || 25,
      perspective: opts.perspective,
      includeMacroBreakdown: true,
      filters: opts.filters,
      match: opts.match,
      signal: opts.signal,
      metadataFilter: (game) => gameMatchesBuildMatchup(
        normaliseGameRaces(game), opts.build, opts.perspective,
      ) && (!opts.strategyName || game?.opponent?.strategy === opts.strategyName),
    })) {
      for (const game of page.games) {
        // Defensive checks keep the compatibility fallback correct when a
        // narrow per-game implementation ignores metadata/match push-down.
        if (!gameMatchesBuildMatchup(game, opts.build, opts.perspective)) continue;
        if (opts.strategyName && game?.opponent?.strategy !== opts.strategyName) continue;
        if (evaluateGameRules(game, opts.rules, opts.perspective) !== "pass") continue;
        games.push(toPhaseAggregationGame(game));
      }
    }
    return games;
  }

  /**
   * @param {string} userId
   * @param {string} slug
   * @param {{ includeTransitions?: boolean, perspective?: "you"|"opponent", strategyName?: string|null, filters?: ReturnType<typeof import('../util/parseQuery').parseFilters>, signal?: AbortSignal }} [opts]
   */
  async evaluateBuildPhases(userId, slug, opts = {}) {
    if (!this.perGame) throw new Error("perGame_unavailable");
    const includeTransitions = opts.includeTransitions !== false;
    const build = await this.get(userId, slug);
    if (!build) return null;
    const rules = extractRules(build);
    // ``rulePerspective`` decides which side's events the rule
    // evaluator scans — that always follows the saved build's intent
    // (a build saved as "opponent" describes the opponent's opener).
    // ``phasePerspective`` decides which side the classifier /
    // signature picker score, and can be overridden by the caller so
    // the comparison view can render both sides off the same matched
    // set.
    const rulePerspective = build.perspective === "opponent" ? "opponent" : "you";
    const phasePerspective = opts.perspective === "opponent"
      || opts.perspective === "you"
      ? opts.perspective
      : rulePerspective;
    // Optional cell-scoping filter: when the BuildVsStrategyComparison
    // drill-down asks for a saved build's compositions, it also passes
    // the opponent strategy axis so the trajectory describes the SAME
    // game set as the matrix cell the user clicked. Unscoped callers
    // (BuildDossier) pass nothing and still get the full marginal.
    const strategyName =
      typeof opts.strategyName === "string" && opts.strategyName
        ? opts.strategyName
        : null;
    // Push the strategy predicate into the Mongo find so the recency
    // cap applies to matching games. Without push-down a user with
    // more games than ``STATS_GAME_SCAN_CAP`` saw the comparison
    // cohort silently shrink whenever the matrix cell sat outside the
    // most recent slice — this is what produced the "265 games in the
    // BvS cell, 13 in the WHAT YOU TYPICALLY DO header" discrepancy.
    // The race / opponent-race side of the matchup-gate stays in JS
    // because the legacy fallback (deriving race from a "PvT - …"
    // build-name prefix when the field is absent) can't be expressed
    // as a Mongo predicate without a more expensive aggregate.
    /** @type {Record<string, any>|null} */
    const matchPushdown = strategyName
      ? { "opponent.strategy": strategyName }
      : null;
    // ``filters`` is consumed by the real perGameCompute implementation
    // (it feeds gamesMatchStage) but the trimmed PerGameComputeService
    // interface in types.d.ts doesn't declare it yet — widen the opts
    // literal locally so the pass-through stays typed.
    const games = await this._listForRulePhases(
      userId,
      {
        limit: STATS_GAME_SCAN_CAP,
        pageSize: 25,
        perspective: rulePerspective,
        build,
        rules,
        strategyName,
        signal: opts.signal,
        filters: opts && opts.filters,
        ...(matchPushdown ? { match: matchPushdown } : {}),
      },
    );
    const ruleMatched = games;
    // Defensive in-memory filter — keeps the service correct against
    // a perGame implementation that ignores ``match`` (test mocks).
    // In production the Mongo find has already done this work.
    const matched = ruleMatched;
    const comps = computeCompositions(matched, { perspective: phasePerspective });
    /** @type {{
     *   slug: string,
     *   name: string,
     *   perspective: "you"|"opponent",
     *   sampleSize: Record<string, number>,
     *   perPhase: Record<string, import('./types').BuildPhaseRow>,
     *   finalPhaseDistribution: Record<string, number>,
     *   medianCrossings: {
     *     earlyMidAt: number|null,
     *     midAt: number|null,
     *     midLateAt: number|null,
     *     lateAt: number|null,
     *   },
     *   durationP95Sec: number,
     *   flags: string[],
     *   transitions?: import('./types').BuildTransitionsPayload["transitions"],
     * }} */
    const out = {
      slug: build.slug,
      name: build.name || build.slug,
      perspective: phasePerspective,
      sampleSize: comps.sampleSize,
      perPhase: comps.perPhase,
      finalPhaseDistribution: comps.finalPhaseDistribution,
      medianCrossings: comps.medianCrossings,
      durationP95Sec: comps.durationP95Sec,
      flags: comps.flags,
    };
    if (includeTransitions) {
      out.transitions = computeTransitions(matched, {
        perspective: phasePerspective,
      });
    }
    return out;
  }

  /**
   * Aggregate stats for every saved build the user owns. One scan over
   * the user's recent games, evaluating every build's rules per game.
   * The returned rows match `/v1/builds` row shape so the existing
   * `decorateBuilds` UI code works unchanged.
   *
   * @param {string} userId
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<Array<{name: string, slug: string, total: number, wins: number, losses: number, winRate: number, lastPlayed: Date|null, ruleCount: number}>>}
   */
  async evaluateAllStats(userId, opts = {}) {
    if (!this.perGame) throw new Error("perGame_unavailable");
    const builds = await this._listForClassification(userId);
    if (builds.length === 0) return [];
    const accum = /** @type {Array<{
     *   build: any,
     *   rules: ReadonlyArray<import('./buildRulesEvaluator').BuildRule>,
     *   perspective: "you"|"opponent",
     *   total: number,
     *   wins: number,
     *   losses: number,
     *   lastPlayed: Date|null,
     * }>} */ (builds.map(
      /** @param {any} b */ (b) => ({
        build: b,
        rules: extractRules(b),
        perspective: b.perspective === "opponent" ? "opponent" : "you",
        total: 0,
        wins: 0,
        losses: 0,
        lastPlayed: null,
      }),
    ));
    // Two passes are intentional: each page hydrates only one perspective,
    // while every build for that side is evaluated before the page is freed.
    for (const perspective of /** @type {Array<"you"|"opponent">} */ (["you", "opponent"])) {
      if (!accum.some((a) => a.perspective === perspective)) continue;
      for await (const page of this._rulePages(userId, {
        limit: STATS_GAME_SCAN_CAP,
        pageSize: 50,
        perspective,
        signal: opts.signal,
      })) {
        for (const a of accum) {
          if (a.perspective !== perspective || a.rules.length === 0) continue;
          for (const game of page.games) {
            if (!gameMatchesBuildMatchup(game, a.build, perspective)) continue;
            if (evaluateGameRules(game, a.rules, perspective) !== "pass") continue;
            a.total += 1;
            if (isWin(game.result)) a.wins += 1;
            else if (isLoss(game.result)) a.losses += 1;
            if (game.date && (!a.lastPlayed || game.date > a.lastPlayed)) {
              a.lastPlayed = game.date;
            }
          }
        }
      }
    }
    return accum.map(
      (a) => {
        const b = a.build;
        const decided = a.wins + a.losses;
        return {
          name: b.name || b.slug,
          slug: b.slug,
          total: a.total,
          wins: a.wins,
          losses: a.losses,
          winRate: decided > 0 ? a.wins / decided : 0,
          lastPlayed: a.lastPlayed,
          ruleCount: a.rules.length,
        };
      },
    );
  }

  /**
   * Reclassify the user's stored games against ONE saved build.
   *
   * For each game whose stored events satisfy the build's rules (and
   * whose matchup matches the build's race/vsRace gate), set the
   * game document's `myBuild` to the build's name. For games that
   * were previously tagged with this build's name but no longer
   * match, clear the tag (only when `replace` is true) so the
   * standard /v1/builds aggregations stay accurate.
   *
   * Important: we never push back to the agent. The cloud already has
   * each uploaded game's parsed buildLog/oppBuildLog, so reclassification
   * pages through cloud data without retaining the full history at once.
   *
   * @param {string} userId
   * @param {string} slug
   * @param {{
   *   replace?: boolean,
   *   previousName?: string,
   *   previousNames?: string[],
   *   signal?: AbortSignal,
   *   jobSequence?: number,
   * }} [opts]
   * @returns {Promise<null | {
   *   slug: string,
   *   name: string,
   *   scanned: number,
   *   matched: number,
   *   tagged: number,
   *   cleared: number,
   *   ruleCount: number,
   * }>}
   */
  async reclassify(userId, slug, opts = {}) {
    if (!this.perGame) throw new Error("perGame_unavailable");
    await assertNoActiveOpponentBuildOrderWrites(
      this._gamesCollection(),
      userId,
    );
    const build = await this.get(userId, slug);
    if (!build) return null;
    const replace = opts.replace !== false;
    const rules = extractRules(build);
    const buildName = build.name || build.slug;
    const perspective = build.perspective === "opponent" ? "opponent" : "you";
    const runId = randomUUID();
    const jobSequence = Math.max(0, Number(opts.jobSequence) || 0);
    const gamesCollection = this._gamesCollection();
    let scanned = 0;
    let matchedCount = 0;
    let cleared = 0;
    let tagged = 0;
    try {
    for await (const page of this._rulePages(userId, {
      pageSize: 50,
      perspective,
      strictDetails: true,
      signal: opts.signal,
      metadataFilter: (g) => gameMatchesBuildMatchup(
        normaliseGameRaces(g), build, perspective,
      ) || g.customBuildSlug === slug || g._customBuildSlug === slug,
    })) {
      if (opts.signal && opts.signal.aborted) throw abortError();
      assertStableOpponentBuildOrderPage(page.games);
      scanned += page.candidates;
      const matched = [];
      const stale = [];
      for (const g of page.games) {
        const inMatchup = gameMatchesBuildMatchup(g, build, perspective);
        const owned = g.customBuildSlug === slug;
        if (!inMatchup) {
          if (replace && owned && g.gameId) stale.push(g);
          continue;
        }
        const verdict = evaluateGameRules(g, rules, perspective);
        if (verdict === "pass") matched.push(g);
        else if (verdict === "fail" && replace && owned && g.gameId) stale.push(g);
        // Missing detail / evaluator errors are intentionally untouched.
      }
      matchedCount += matched.length;
      const toTag = matched
        .filter((g) => (
          g.myBuild !== buildName || g.customBuildSlug !== slug
        ) && Boolean(g.gameId))
        .map((g) => ({
          gameId: g.gameId,
          revision: g.customBuildRevision || null,
        }));
      if (toTag.length > 0) {
        const staged = await gamesCollection.bulkWrite(
          toTag.map((row) => ({
            updateOne: {
              filter: {
                userId,
                gameId: row.gameId,
                ...customBuildRevisionMatch(row.revision),
              },
              update: {
                $set: {
                  _schemaVersion: expectedVersion(COLLECTIONS.GAMES),
                },
                $addToSet: { _customBuildReclassify: {
                   runId,
                  sequence: jobSequence,
                  mode: "single",
                  slug,
                  action: "set",
                  desiredBuild: buildName,
                  desiredSlug: slug,
                } },
              },
            },
          })),
          { ordered: false },
        );
        tagged += staged.matchedCount || 0;
      }
      // Clear only definite, successfully evaluated nonmatches in this page.
      // A missing detail blob or failed page is never interpreted as a miss.
      if (replace && stale.length > 0) {
        const staged = await gamesCollection.bulkWrite(
          stale.map((g) => ({
            updateOne: {
              filter: {
                userId,
                gameId: g.gameId,
                _customBuildSlug: slug,
                ...customBuildRevisionMatch(g.customBuildRevision || null),
              },
              update: {
                $set: {
                  _schemaVersion: expectedVersion(COLLECTIONS.GAMES),
                },
                $addToSet: { _customBuildReclassify: {
                   runId,
                  sequence: jobSequence,
                  mode: "single",
                  slug,
                  action: "clear",
                } },
              },
            },
          })),
          { ordered: false },
        );
        cleared += staged.matchedCount || 0;
      }
    }
    if (opts.signal && opts.signal.aborted) throw abortError();
    // A writer that starts after this scan began rotates the replay revision;
    // its stale staged rows therefore match zero documents at commit. Queued
    // all-build work is coalesced by the writer after its final fence.
    await gamesCollection.updateMany(
      { userId, "_customBuildReclassify.runId": runId },
      commitReclassifyRunPipeline(runId, jobSequence),
    );
    } catch (err) {
      // A partial/failed history scan must have zero destructive effects.
      await gamesCollection.updateMany(
        { userId, "_customBuildReclassify.runId": runId },
        removeReclassifyRunPipeline(runId),
      );
      throw err;
    }
    return {
      slug: build.slug,
      name: buildName,
      scanned,
      matched: matchedCount,
      tagged,
      cleared,
      ruleCount: rules.length,
    };
  }

  /**
   * Memory-bounded full-history all-build classifier. Each page is scored
   * against every saved build before its detail blobs are released. A game
   * claimed by multiple builds is assigned to the most specific rule set;
   * equal-sized rule sets keep the list's updatedAt-desc order.
   *
   * @param {string} userId
   * @param {{
   *   clearUnmatched?: boolean,
   *   signal?: AbortSignal,
   *   previousNamesBySlug?: Record<string, string[]>,
   *   assertLease?: () => Promise<void>,
   *   jobSequence?: number,
   * }} [opts]
   */
  async reclassifyAll(userId, opts = {}) {
    if (!this.perGame) throw new Error("perGame_unavailable");
    await assertNoActiveOpponentBuildOrderWrites(
      this._gamesCollection(),
      userId,
    );
    const clearUnmatched = !!opts.clearUnmatched;
    const builds = await this._listForClassification(userId);
    const descriptors = builds.map((build, ord) => ({
      build,
      ord,
      name: build.name || build.slug,
      rules: extractRules(build),
      perspective: /** @type {"you"|"opponent"} */ (
        build.perspective === "opponent" ? "opponent" : "you"
      ),
    }));
    const ownedSlugs = new Set([
      ...descriptors.map((d) => d.build.slug).filter(Boolean),
      ...Object.keys(opts.previousNamesBySlug || {}),
    ]);
    const perBuild = descriptors.map((d) => ({
      slug: d.build.slug,
      name: d.name,
      matched: 0,
      tagged: 0,
    }));
    const runId = randomUUID();
    const jobSequence = Math.max(0, Number(opts.jobSequence) || 0);
    const games = this._gamesCollection();
    let scanned = 0;
    let tagged = 0;
    let cleared = 0;
    try {
      for await (const page of this._rulePages(userId, {
        pageSize: 50,
        perspective: "both",
        strictDetails: true,
        signal: opts.signal,
      })) {
        if (opts.signal && opts.signal.aborted) throw abortError();
        assertStableOpponentBuildOrderPage(page.games);
        if (opts.assertLease) await opts.assertLease();
        scanned += page.candidates;
        /** @type {Map<string, {name: string, slug: string, rows: Array<{gameId: string, revision: string|null}>}>} */
        const desiredGroups = new Map();
        /** @type {Array<{gameId: string, revision: string|null}>} */
        const clearGames = [];
        for (const game of page.games) {
          let best = null;
          const unknownContenders = [];
          for (const descriptor of descriptors) {
            if (!gameMatchesBuildMatchup(
              game,
              descriptor.build,
              descriptor.perspective,
            )) continue;
            const verdict = evaluateGameRules(
              game,
              descriptor.rules,
              descriptor.perspective,
            );
            if (verdict === "unknown") {
              unknownContenders.push(descriptor);
              continue;
            }
            if (verdict !== "pass") continue;
            perBuild[descriptor.ord].matched += 1;
            if (
              !best
              || descriptor.rules.length > best.rules.length
              || (
                descriptor.rules.length === best.rules.length
                && descriptor.ord < best.ord
              )
            ) {
              best = descriptor;
            }
          }

          // A missing detail side is safe to ignore only when every unknown
          // contender is lower priority than the known winner. Otherwise the
          // closest-match result is genuinely unknown, so preserve the game's
          // current tag until a later run can hydrate and score that side.
          const winnerIsUncertain = best && unknownContenders.some(
            (candidate) => descriptorOutranks(candidate, best),
          );
          if (winnerIsUncertain || (!best && unknownContenders.length > 0)) {
            continue;
          }

          if (best && game.gameId) {
            // A matching tag is already correct and needs no staged write.
            if (
              game.myBuild === best.name
              && game.customBuildSlug === best.build.slug
            ) continue;
            const group = desiredGroups.get(best.build.slug) || /** @type {{name: string, slug: string, rows: Array<{gameId: string, revision: string|null}>}} */ ({
              name: best.name,
              slug: best.build.slug,
              rows: [],
            });
            group.rows.push({
              gameId: game.gameId,
              revision: game.customBuildRevision || null,
            });
            desiredGroups.set(best.build.slug, group);
          } else if (
            clearUnmatched
            && game.gameId
            && typeof game.customBuildSlug === "string"
            && ownedSlugs.has(game.customBuildSlug)
          ) {
            clearGames.push({
              gameId: game.gameId,
              revision: game.customBuildRevision || null,
            });
          }
        }

        // Stage both positive assignments and removals. Nothing touches
        // `myBuild` until the iterator reaches a complete, successfully
        // hydrated EOF and the worker still owns its durable lease.
        for (const group of desiredGroups.values()) {
          if (opts.assertLease) await opts.assertLease();
          const staged = await games.bulkWrite(
            group.rows.map((row) => ({
              updateOne: {
                filter: {
                  userId,
                  gameId: row.gameId,
                  ...customBuildRevisionMatch(row.revision),
                },
                update: {
                  $set: {
                    _schemaVersion: expectedVersion(COLLECTIONS.GAMES),
                  },
                  $addToSet: { _customBuildReclassify: {
                     runId,
                    sequence: jobSequence,
                    mode: "all",
                    action: "set",
                    desiredBuild: group.name,
                    desiredSlug: group.slug,
                  } },
                },
              },
            })),
            { ordered: false },
          );
          const stagedCount = staged.matchedCount || 0;
          tagged += stagedCount;
          const descriptor = descriptors.find((d) => d.build.slug === group.slug);
          if (descriptor) perBuild[descriptor.ord].tagged += stagedCount;
        }
        if (clearGames.length > 0) {
          if (opts.assertLease) await opts.assertLease();
          const staged = await games.bulkWrite(
            clearGames.map((row) => ({
              updateOne: {
                filter: {
                  userId,
                  gameId: row.gameId,
                  _customBuildSlug: { $in: [...ownedSlugs] },
                  ...customBuildRevisionMatch(row.revision),
                },
                update: {
                  $set: {
                    _schemaVersion: expectedVersion(COLLECTIONS.GAMES),
                  },
                  $addToSet: { _customBuildReclassify: {
                     runId,
                    sequence: jobSequence,
                    mode: "all",
                    action: "clear",
                  } },
                },
              },
            })),
            { ordered: false },
          );
          cleared += staged.matchedCount || 0;
        }
      }
      // The iterator treats cancellation as a normal return so previews can
      // disappear quietly. A destructive classifier must distinguish that
      // from a successful EOF before it commits staged removals.
      if (opts.signal && opts.signal.aborted) throw abortError();
      await assertNoActiveOpponentBuildOrderWrites(games, userId);
      if (opts.assertLease) await opts.assertLease();

      // Commit every staged decision in one server-side update. `$$REMOVE`
      // clears definitive stale tags and also removes the private marker;
      // set actions copy their staged desired value into `myBuild`.
      await games.updateMany(
        { userId, "_customBuildReclassify.runId": runId },
        commitReclassifyRunPipeline(runId, jobSequence),
      );
    } catch (err) {
      await games.updateMany(
        { userId, "_customBuildReclassify.runId": runId },
        removeReclassifyRunPipeline(runId),
      );
      throw err;
    }
    return { builds: builds.length, scanned, tagged, cleared, perBuild };
  }

  /**
   * Reclassify the user's stored games against EVERY saved build.
   *
   * Single scan, each game tested against each build's rules. When a
   * game matches multiple builds, the "closest" build wins: the build
   * with the most rules (the most specific) takes the game. Ties on
   * rule count are broken by `updatedAt desc` (most recently edited
   * wins), consistent with the per-slug `reclassify` flow. Games that
   * match no build keep whatever tag was already present unless
   * `clearUnmatched` is true.
   *
   * @param {string} userId
   * @param {{ clearUnmatched?: boolean }} [opts]
   * @returns {Promise<{
   *   builds: number,
   *   scanned: number,
   *   tagged: number,
   *   cleared: number,
   *   perBuild: Array<{slug: string, name: string, matched: number, tagged: number}>,
   * }>}
   */
  async _reclassifyAllLegacy(userId, opts = {}) {
    if (!this.perGame) throw new Error("perGame_unavailable");
    const clearUnmatched = !!opts.clearUnmatched;
    const builds = await this._listForClassification(userId);
    const games = await this.perGame.listForRulePreview(userId, {
      limit: STATS_GAME_SCAN_CAP,
    });
    /** @type {Map<string, {name: string, ruleCount: number, ord: number}>} */
    const claims = new Map();
    /** @type {Set<string>} */
    const ownedNames = new Set();
    /** @type {Array<{slug: string, name: string, matched: number, tagged: number}>} */
    const perBuild = [];

    for (let i = 0; i < builds.length; i++) {
      const b = /** @type {any} */ (builds[i]);
      const rules = extractRules(b);
      const perspective = b.perspective === "opponent" ? "opponent" : "you";
      const buildName = b.name || b.slug;
      ownedNames.add(buildName);
      let matchedCount = 0;
      if (rules.length > 0) {
        const inMatchup = games.filter((g) =>
          gameMatchesBuildMatchup(g, b, perspective),
        );
        const matched = filterMatchingGames(inMatchup, rules, perspective);
        for (const g of matched) {
          if (!g.gameId) continue;
          // Closest-match: keep whichever claim has more rules. Ties
          // broken by index (lower = more recent, since `list()` orders
          // by `updatedAt desc`).
          const cur = claims.get(g.gameId);
          if (
            !cur ||
            rules.length > cur.ruleCount ||
            (rules.length === cur.ruleCount && i < cur.ord)
          ) {
            claims.set(g.gameId, {
              name: buildName,
              ruleCount: rules.length,
              ord: i,
            });
          }
        }
        matchedCount = matched.length;
      }
      perBuild.push({
        slug: b.slug,
        name: buildName,
        matched: matchedCount,
        tagged: 0,
      });
    }
    /** @type {Map<string, string>} */
    const desiredTag = new Map();
    for (const [gid, claim] of claims) desiredTag.set(gid, claim.name);

    let totalTagged = 0;
    /** @type {Map<string, string[]>} */
    const grouped = new Map();
    for (const [gid, name] of desiredTag) {
      const arr = grouped.get(name) || [];
      arr.push(gid);
      grouped.set(name, arr);
    }
    const games_ = this._gamesCollection();
    for (const [name, ids] of grouped) {
      if (ids.length === 0) continue;
      const res = await tagGames(games_, userId, ids, name);
      totalTagged += res.modifiedCount || 0;
      const row = perBuild.find((p) => p.name === name);
      if (row) row.tagged = res.modifiedCount || 0;
    }

    let cleared = 0;
    if (clearUnmatched && ownedNames.size > 0) {
      // Clear tags for games whose `myBuild` references one of THIS
      // user's saved builds but no longer matches that build's rules.
      // We never touch tags that belong to community builds or the
      // legacy agent classifier — those names are unknown to us.
      const namesArr = Array.from(ownedNames);
      const taggedIds = Array.from(desiredTag.keys());
      const clearRes = await games_.updateMany(
        {
          userId,
          isResumedFromReplay: { $ne: true },
          myBuild: { $in: namesArr },
          ...(taggedIds.length > 0 ? { gameId: { $nin: taggedIds } } : {}),
        },
        { $unset: { myBuild: "" } },
      );
      cleared = clearRes.modifiedCount || 0;
    }

    return {
      builds: builds.length,
      scanned: games.length,
      tagged: totalTagged,
      cleared,
      perBuild,
    };
  }

  /**
   * Tag a freshly-ingested game against the user's saved custom builds
   * and stamp `myBuild` on the game document if any match. This is the
   * piece that keeps the opponent profile / Recent games view in sync
   * with what the user actually plays — without it, the agent's
   * built-in classifier always wins, and a brand new replay never gets
   * the user's custom-build name no matter how many times they hit
   * Reclassify (the next upload re-tags it back to the agent's label).
   *
   * Closest-match selection: builds with more rules win. Ties are
   * broken by `updatedAt desc` (most recently edited wins). When no
   * saved build matches, the game's `myBuild` is left as the agent
   * uploaded it.
   *
   * No-ops when the input game has no parsed events (legacy import,
   * bad parse on the agent side) or when the user has no saved builds.
   * Called from `POST /v1/games` after `games.upsert` so a single
   * ingest path covers both new uploads and re-uploads.
   *
   * @param {string} userId
   * @param {{
   *   gameId?: string,
   *   myRace?: string|null,
   *   myBuild?: string|null,
   *   buildLog?: string[],
   *   oppBuildLog?: string[],
   *   opponent?: { race?: string|null }|null,
   * }} game
   * @returns {Promise<null | {
   *   gameId: string,
   *   matched: number,
   *   chosen: string|null,
   *   ruleCount: number,
   * }>}
   */
  async tagSingleGame(userId, game) {
    if (!this.perGame || !game || !game.gameId) return null;
    const builds = await this._listForClassification(userId);
    if (builds.length === 0) return null;
    // Parse the just-uploaded build logs into the same event shape the
    // rule evaluator expects. We pull this from the game payload (not
    // re-reading from Mongo) so this stays a pure post-write hook with
    // no extra round-trip.
    // The catalog enriches events (is_building / category / race) for
    // rules that depend on those fields; we reach for it via /any/ to
    // mirror how the rest of this file reaches for the games collection
    // — the typed surface in types.d.ts intentionally omits internals.
    const catalog = /** @type {any} */ (this.perGame).catalog || null;
    // Rules saved through the SaveAsBuild button / BuildEditorModal
    // capture ``time_lt`` thresholds off the start-time timeline the
    // user sees. Match against start-time events so what they save
    // matches what they author. ``eventsToStartTime`` rewinds finish-
    // time entries (units / morphs / upgrades) using the build-
    // duration catalog; non-morph structures pass through unchanged.
    const events = eventsToStartTime(
      parseBuildLogLines(
        Array.isArray(game.buildLog) ? game.buildLog : [],
        catalog,
      ),
    );
    const oppEvents = eventsToStartTime(
      parseBuildLogLines(
        Array.isArray(game.oppBuildLog) ? game.oppBuildLog : [],
        catalog,
      ),
    );
    if (events.length === 0 && oppEvents.length === 0) {
      return { gameId: game.gameId, matched: 0, chosen: null, ruleCount: 0 };
    }
    const oppRace =
      game.opponent && typeof game.opponent === "object"
        ? game.opponent.race || null
        : null;
    const probe = {
      gameId: String(game.gameId),
      myRace: game.myRace || null,
      oppRace,
      myBuild: game.myBuild || null,
      events,
      oppEvents,
    };

    /** @type {{name: string, slug: string, ruleCount: number, ord: number} | null} */
    let best = null;
    let matchCount = 0;
    for (let i = 0; i < builds.length; i++) {
      const b = /** @type {any} */ (builds[i]);
      const rules = extractRules(b);
      if (rules.length === 0) continue;
      const perspective = b.perspective === "opponent" ? "opponent" : "you";
      if (!gameMatchesBuildMatchup(probe, b, perspective)) continue;
      const evs = perspective === "opponent" ? probe.oppEvents : probe.events;
      if (evs.length === 0) continue;
      let result;
      try {
        result = evaluateRules(/** @type {any} */ (rules), evs);
      } catch (_e) {
        continue;
      }
      if (!result.pass) continue;
      matchCount += 1;
      const buildName = b.name || b.slug;
      if (
        !best ||
        rules.length > best.ruleCount ||
        (rules.length === best.ruleCount && i < best.ord)
      ) {
        best = { name: buildName, slug: b.slug, ruleCount: rules.length, ord: i };
      }
    }

    if (!best) {
      return { gameId: probe.gameId, matched: 0, chosen: null, ruleCount: 0 };
    }
    // Always claim explicit provenance, including when the agent/community
    // label happens to have the same display name. The caller's payload cannot
    // be trusted to report this private server-owned field.
    await this._gamesCollection().updateOne(
      { userId, gameId: probe.gameId },
      {
        $set: {
          myBuild: best.name,
          _customBuildSlug: best.slug,
          _schemaVersion: expectedVersion(COLLECTIONS.GAMES),
        },
        $unset: {
          _customBuildReclassify: "",
          _customBuildClassificationSequence: "",
        },
      },
    );
    return {
      gameId: probe.gameId,
      matched: matchCount,
      chosen: best.name,
      ruleCount: best.ruleCount,
    };
  }

  /**
   * @private
   * @returns {import('mongodb').Collection}
   */
  _gamesCollection() {
    // We share the DbContext with the rest of the API; reach for the
    // games collection without holding a separate handle so the service
    // stays a thin layer over Mongo.
    return /** @type {any} */ (this.db).games;
  }
}

/**
 * @param {import('mongodb').Collection} games
 * @param {string} userId
 * @param {string[]} gameIds
 * @param {string} buildName
 */
async function tagGames(games, userId, gameIds, buildName) {
  if (!gameIds || gameIds.length === 0) return { modifiedCount: 0 };
  return games.updateMany(
    { userId, gameId: { $in: gameIds } },
    {
      $set: { myBuild: buildName },
      $unset: { _customBuildReclassify: "" },
    },
  );
}

/**
 * Pull a v3-shaped rules array from the saved build, falling back to
 * an empty list when neither rules nor a usable signature is present.
 * v2 signatures (unit/count/beforeSec) are converted to count_min
 * rules so old saved builds still match.
 *
 * @param {any} build
 * @returns {Array<import('./buildRulesEvaluator').BuildRule>}
 */
function extractRules(build) {
  if (Array.isArray(build.rules) && build.rules.length > 0) {
    return build.rules.filter(
      /** @param {any} r */ (r) => r && typeof r === "object" && r.name,
    );
  }
  if (Array.isArray(build.signature) && build.signature.length > 0) {
    return build.signature
      .filter(
        /** @param {any} s */ (s) =>
          s && typeof s === "object" && typeof s.unit === "string",
      )
      .map(/** @param {any} s */ (s) => ({
        type: "count_min",
        name: ruleNameFromUnit(s.unit),
        time_lt: Math.max(1, Number(s.beforeSec) || 60),
        count: Math.max(1, Number(s.count) || 1),
      }));
  }
  return [];
}

/**
 * Convert a free-form unit/building label into the canonical
 * eventToken form (e.g. "Stargate" → "BuildStargate"). Mirrors the
 * fallback in buildRulesEvaluator.eventToken.
 *
 * @param {string} raw
 */
function ruleNameFromUnit(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  if (/^(Build|Train|Research|Morph)[A-Z]/.test(trimmed)) return trimmed;
  const noun = trimmed.replace(/[^A-Za-z0-9]/g, "");
  if (!noun) return "";
  return "Build" + noun.charAt(0).toUpperCase() + noun.slice(1);
}

/**
 * Strict matchup gate. A saved build with a single-matchup target
 * (e.g. PvP, PvT) must only count games where both sides line up;
 * otherwise the build silently absorbs cross-matchup replays and
 * Top-matchups / Recent-games / Vs-strategy all show wrong rows.
 *
 * Semantics:
 *   - vsRace omitted or "Any" → opponent side is unconstrained.
 *   - From perspective="you", race is the user's race and vsRace is the
 *     opponent's race (compared to g.myRace / g.oppRace).
 *   - From perspective="opponent", the build describes what the opponent
 *     ran, so race is the opponent's race and vsRace is the user's race
 *     (sides flipped).
 *   - When the game has no race recorded (legacy import), fall back to
 *     the "PvT — …" prefix on g.myBuild; if neither is available we
 *     drop the game from the bucket. The previous permissive behavior
 *     in the live preview let unverifiable replays leak in, which is
 *     exactly what produced PvT games on a PvP build.
 *
 * @param {{myRace: string|null, oppRace: string|null, myBuild?: string|null}} g
 * @param {any} build
 * @param {'you'|'opponent'} perspective
 * @returns {boolean}
 */
function gameMatchesBuildMatchup(g, build, perspective) {
  const mySideActual = perspective === "opponent" ? g.oppRace : g.myRace;
  const oppSideActual = perspective === "opponent" ? g.myRace : g.oppRace;
  const myBucketPos = perspective === "opponent" ? 2 : 0;
  const oppBucketPos = perspective === "opponent" ? 0 : 2;
  return (
    raceStrictMatch(mySideActual, build && build.race, g.myBuild, myBucketPos) &&
    raceStrictMatch(
      oppSideActual,
      build && build.vsRace,
      g.myBuild,
      oppBucketPos,
    )
  );
}

/** Normalise a slim Mongo metadata row to the evaluator's race shape. */
function normaliseGameRaces(/** @type {any} */ g) {
  if (!g || typeof g !== "object") return g;
  if (g.oppRace) return g;
  return {
    ...g,
    oppRace: g.opponent && g.opponent.race ? g.opponent.race : null,
  };
}

function abortError() {
  const err = new Error("reclassify_aborted");
  err.name = "AbortError";
  return err;
}

/** @param {unknown} err */
function errorMessage(err) {
  if (err instanceof Error && err.message) return err.message;
  return String(err || "failed");
}

/**
 * Merge bounded rename history for coalesced full-library jobs. Keeping names
 * by stable slug lets an A -> B -> C edit clear both older labels after a
 * single eventual scan.
 * @param {unknown} current
 * @param {unknown} incoming
 * @returns {Record<string, string[]>}
 */
function mergePreviousNamesBySlug(current, incoming) {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const source of [current, incoming]) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    for (const [slug, rawNames] of Object.entries(source)) {
      if (!slug || !Array.isArray(rawNames)) continue;
      const merged = [
        ...(out[slug] || []),
        ...rawNames.filter((name) => typeof name === "string" && name.trim()),
      ];
      out[slug] = [...new Set(merged)].slice(-20);
    }
  }
  return out;
}

/**
 * Flatten the bounded rename history stored on a durable all-build job.
 * @param {unknown} value
 * @returns {string[]}
 */
function collectPreviousBuildNames(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const names = [];
  for (const rawNames of Object.values(value)) {
    if (!Array.isArray(rawNames)) continue;
    for (const name of rawNames) {
      if (typeof name === "string" && name.trim()) names.push(name);
    }
  }
  return [...new Set(names)];
}

/**
 * Retain only the replay signals consumed by phase/composition aggregation.
 * This deliberately drops the rest of the hydrated detail blob between pages.
 * @param {Record<string, any>} game
 */
function toPhaseAggregationGame(game) {
  const macro = game && game.macroBreakdown && typeof game.macroBreakdown === "object"
    ? game.macroBreakdown
    : {};
  return {
    gameId: game.gameId,
    myBuild: game.myBuild,
    myRace: game.myRace,
    oppRace: game.oppRace || game?.opponent?.race || null,
    opponent: game.opponent ? {
      race: game.opponent.race || null,
      strategy: game.opponent.strategy || null,
    } : null,
    durationSec: game.durationSec,
    result: game.result,
    events: Array.isArray(game.events) ? game.events : [],
    oppEvents: Array.isArray(game.oppEvents) ? game.oppEvents : [],
    macroBreakdown: {
      stats_events: Array.isArray(macro.stats_events) ? macro.stats_events : [],
      opp_stats_events: Array.isArray(macro.opp_stats_events)
        ? macro.opp_stats_events : [],
      unit_timeline: Array.isArray(macro.unit_timeline) ? macro.unit_timeline : [],
      bases: Array.isArray(macro.bases) ? macro.bases : [],
      production_buildings: Array.isArray(macro.production_buildings)
        ? macro.production_buildings : [],
      opp_bases: Array.isArray(macro.opp_bases) ? macro.opp_bases : [],
      opp_production_buildings: Array.isArray(macro.opp_production_buildings)
        ? macro.opp_production_buildings : [],
    },
  };
}

const DOSSIER_TIMING_TOKENS = Object.freeze(
  Object.values(TimingCatalog.RACE_BUILDINGS)
    .flat()
    .map((row) => String(row.token || "").toLowerCase())
    .filter(Boolean),
);

/**
 * Keep at most the first timing-catalog line per token. Dossier timing code
 * only asks for first occurrence, so retaining thousands of unrelated army
 * and upgrade lines until aggregation completes wastes memory without changing
 * any output.
 * @param {unknown} value
 */
function compactDossierTimingLog(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    const line = String(raw || "");
    const lower = line.toLowerCase();
    let keep = false;
    for (const token of DOSSIER_TIMING_TOKENS) {
      if (seen.has(token) || !lower.includes(token)) continue;
      seen.add(token);
      keep = true;
    }
    if (keep) out.push(line);
  }
  return out;
}

/** @param {Record<string, any>} game */
function toDossierAggregationGame(game) {
  return {
    gameId: game.gameId,
    date: game.date,
    result: game.result,
    map: game.map,
    myRace: game.myRace,
    oppRace: game.oppRace || game?.opponent?.race || null,
    myBuild: game.myBuild,
    durationSec: game.durationSec,
    macroScore: game.macroScore,
    apm: game.apm,
    spq: game.spq,
    opponent: game.opponent ? {
      displayName: game.opponent.displayName || null,
      race: game.opponent.race || null,
      strategy: game.opponent.strategy || null,
    } : null,
    buildLog: compactDossierTimingLog(game.buildLog),
    oppBuildLog: compactDossierTimingLog(game.oppBuildLog),
  };
}

/**
 * Closest-match priority: more rules wins; list order resolves ties.
 * @param {{rules: readonly unknown[], ord: number}} candidate
 * @param {{rules: readonly unknown[], ord: number}} current
 */
function descriptorOutranks(candidate, current) {
  return candidate.rules.length > current.rules.length
    || (
      candidate.rules.length === current.rules.length
      && candidate.ord < current.ord
    );
}

/**
 * Compare the replay payload revision observed during hydration. Mongo's null
 * equality intentionally matches both null and missing for pre-revision rows.
 * @param {string|null} revision
 */
function customBuildRevisionMatch(revision) {
  return { _customBuildRevision: revision || null };
}

/** Convert legacy single-object staging into the current marker-array shape. */
function reclassifyMarkersExpression() {
  return {
    $cond: [
      { $isArray: "$_customBuildReclassify" },
      "$_customBuildReclassify",
      {
        $cond: [
          { $eq: [{ $type: "$_customBuildReclassify" }, "object"] },
          ["$_customBuildReclassify"],
          [],
        ],
      },
    ],
  };
}

/** @param {string} runId */
function reclassifyDecisionExpression(runId) {
  return {
    $arrayElemAt: [
      {
        $filter: {
          input: reclassifyMarkersExpression(),
          as: "marker",
          cond: { $eq: ["$$marker.runId", runId] },
        },
      },
      0,
    ],
  };
}

/** @param {string} runId */
function remainingReclassifyMarkersExpression(runId) {
  return {
    $filter: {
      input: reclassifyMarkersExpression(),
      as: "marker",
      cond: { $ne: ["$$marker.runId", runId] },
    },
  };
}

/**
 * A successful sequence makes every older/equal staged verdict obsolete,
 * including residue from a hard crash that recovery resumed with a new runId.
 * @param {number} sequence
 */
function newerReclassifyMarkersExpression(sequence) {
  return {
    $filter: {
      input: reclassifyMarkersExpression(),
      as: "marker",
      cond: {
        $gt: [
          { $ifNull: ["$$marker.sequence", 0] },
          Math.max(0, Number(sequence) || 0),
        ],
      },
    },
  };
}

/**
 * Apply only this run's staged verdict and retain every other in-flight run.
 * @param {string} runId
 * @param {number} sequence
 */
function commitReclassifyRunPipeline(runId, sequence) {
  const safeSequence = Math.max(0, Number(sequence) || 0);
  const decision = reclassifyDecisionExpression(runId);
  const canApply = {
    $gte: [
      { $ifNull: ["$$decision.sequence", safeSequence] },
      { $ifNull: ["$_customBuildClassificationSequence", 0] },
    ],
  };
  return [{
    $set: {
      _schemaVersion: expectedVersion(COLLECTIONS.GAMES),
      myBuild: {
        $let: {
          vars: { decision },
          in: {
            $cond: [
              canApply,
              {
                $cond: [
                  { $eq: ["$$decision.action", "set"] },
                  "$$decision.desiredBuild",
                  "$$REMOVE",
                ],
              },
              "$myBuild",
            ],
          },
        },
      },
      _customBuildSlug: {
        $let: {
          vars: { decision },
          in: {
            $cond: [
              canApply,
              {
                $cond: [
                  { $eq: ["$$decision.action", "set"] },
                  "$$decision.desiredSlug",
                  "$$REMOVE",
                ],
              },
              "$_customBuildSlug",
            ],
          },
        },
      },
      _customBuildClassificationSequence: {
        $let: {
          vars: { decision },
          in: {
            $cond: [
              canApply,
              { $ifNull: ["$$decision.sequence", safeSequence] },
              "$_customBuildClassificationSequence",
            ],
          },
        },
      },
      _customBuildReclassify: {
        $let: {
          vars: { remaining: newerReclassifyMarkersExpression(safeSequence) },
          in: {
            $cond: [
              { $gt: [{ $size: "$$remaining" }, 0] },
              "$$remaining",
              "$$REMOVE",
            ],
          },
        },
      },
    },
  }];
}

/** Remove only this failed/aborted run's staging. @param {string} runId */
function removeReclassifyRunPipeline(runId) {
  return [{
    $set: {
      _customBuildReclassify: {
        $let: {
          vars: { remaining: remainingReclassifyMarkersExpression(runId) },
          in: {
            $cond: [
              { $gt: [{ $size: "$$remaining" }, 0] },
              "$$remaining",
              "$$REMOVE",
            ],
          },
        },
      },
    },
  }];
}

/** @param {unknown} err */
function isDuplicateKeyError(err) {
  return !!(
    err && typeof err === "object" && "code" in err
    && Number(/** @type {{code?: unknown}} */ (err).code) === 11000
  );
}

/**
 * @param {string|null|undefined} actual
 * @param {string|undefined} requested
 * @param {string|null|undefined} buildName
 * @param {number} bucketPos
 * @returns {boolean}
 */
function raceStrictMatch(actual, requested, buildName, bucketPos) {
  if (!requested || requested === "Any") return true;
  const r = requested.charAt(0).toUpperCase();
  if (actual) return actual.charAt(0).toUpperCase() === r;
  if (typeof buildName === "string" && /^[PTZ]v[PTZ]/.test(buildName)) {
    return buildName.charAt(bucketPos) === r;
  }
  return false;
}

/**
 * @param {Array<{events: any[], oppEvents: any[], myRace: string|null, oppRace: string|null, gameId: string, result: string|null, date: Date|null, map: string|null}>} games
 * @param {ReadonlyArray<import('./buildRulesEvaluator').BuildRule>} rules
 * @param {'you'|'opponent'} perspective
 */
function filterMatchingGames(games, rules, perspective) {
  if (rules.length === 0) return [];
  /** @type {any[]} */
  const out = [];
  for (const g of games) {
    const events =
      perspective === "opponent" ? g.oppEvents || [] : g.events || [];
    if (events.length === 0) continue;
    let res;
    try {
      res = evaluateRules(rules, events);
    } catch (_e) {
      continue;
    }
    if (res.pass) out.push(g);
  }
  return out;
}

/**
 * Tri-state evaluator used by destructive reclassification. Unlike the
 * display-only helper above, missing detail or evaluator exceptions are not
 * collapsed into a nonmatch.
 * @param {any} game
 * @param {ReadonlyArray<import('./buildRulesEvaluator').BuildRule>} rules
 * @param {"you"|"opponent"} perspective
 * @returns {"pass"|"fail"|"unknown"}
 */
function evaluateGameRules(game, rules, perspective) {
  const detailAvailable = perspective === "opponent"
    ? game && game.detailAvailableOpponent
    : game && game.detailAvailableYou;
  if (!game || detailAvailable === false) {
    return "unknown";
  }
  if (rules.length === 0) return "fail";

  const events = perspective === "opponent"
    ? game.oppEvents || []
    : game.events || [];
  try {
    return evaluateRules(rules, events).pass ? "pass" : "fail";
  } catch (_err) {
    return "unknown";
  }
}

/**
 * @param {Array<{result: string|null, date: Date|null}>} games
 * @returns {{wins: number, losses: number, total: number, winRate: number, lastPlayed: Date|null}}
 */
function rollupTotals(games) {
  let wins = 0;
  let losses = 0;
  let last = null;
  for (const g of games) {
    if (isWin(g.result)) wins++;
    else if (isLoss(g.result)) losses++;
    if (g.date && (!last || g.date > last)) last = g.date;
  }
  const total = games.length;
  const decided = wins + losses;
  return {
    wins,
    losses,
    total,
    winRate: decided > 0 ? wins / decided : 0,
    lastPlayed: last,
  };
}

/**
 * @template T
 * @param {Array<{result: string|null}>} games
 * @param {(g: any) => string} keyFn
 */
function groupRows(games, keyFn) {
  /** @type {Map<string, {wins: number, losses: number, total: number}>} */
  const buckets = new Map();
  for (const g of games) {
    const key = (keyFn(g) || "Unknown").trim() || "Unknown";
    const cur = buckets.get(key) || { wins: 0, losses: 0, total: 0 };
    cur.total += 1;
    if (isWin(g.result)) cur.wins += 1;
    else if (isLoss(g.result)) cur.losses += 1;
    buckets.set(key, cur);
  }
  return [...buckets.entries()]
    .map(([name, v]) => {
      const decided = v.wins + v.losses;
      return {
        name,
        wins: v.wins,
        losses: v.losses,
        total: v.total,
        winRate: decided > 0 ? v.wins / decided : 0,
      };
    })
    .sort((a, b) => b.total - a.total);
}

/** @param {{myRace: string|null, oppRace: string|null}} g */
function matchupKey(g) {
  const my = (g.myRace || "?").charAt(0).toUpperCase() || "?";
  const opp = (g.oppRace || "?").charAt(0).toUpperCase() || "?";
  return `${my}v${opp}`;
}

/** @param {string|null} r */
function isWin(r) {
  if (!r) return false;
  const s = String(r).toLowerCase();
  return s === "win" || s === "victory";
}

/** @param {string|null} r */
function isLoss(r) {
  if (!r) return false;
  const s = String(r).toLowerCase();
  return s === "loss" || s === "defeat";
}

/** @param {any} g */
function toRecent(g) {
  return {
    gameId: g.gameId,
    date: g.date instanceof Date ? g.date.toISOString() : g.date,
    map: g.map || "",
    opponent: (g.opponent && g.opponent.displayName) || "",
    opp_race: g.oppRace || (g.opponent && g.opponent.race) || "",
    opp_strategy: (g.opponent && g.opponent.strategy) || null,
    result: g.result || null,
    duration: g.durationSec != null ? g.durationSec : null,
    macroScore: typeof g.macroScore === "number" ? g.macroScore : null,
  };
}

module.exports = {
  CustomBuildsService,
};
