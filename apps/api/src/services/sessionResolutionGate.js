"use strict";

// Reconnect-storm admission for the overlay session widget.
//
// A Browser Source reconnect asks for the same per-user session snapshot on
// connect, timezone registration, and resync. Several OBS scenes/widgets can
// reconnect together, so without a shared lane each socket independently
// scans Mongo and asks SC2Pulse for the same current MMR. This gate keeps one
// resolver active per user, coalesces identical queued work, caps total
// cross-user compute concurrency, and retains only a very short result cache.
// Game writes explicitly invalidate the user's generation, so the cache
// cannot hide a newly ingested replay.

const DEFAULT_TTL_MS = 15_000;
const DEFAULT_MAX_USERS = 256;
const DEFAULT_MAX_TASKS_PER_USER = 8;
const DEFAULT_MAX_SUBSCRIBERS_PER_TASK = 64;
const DEFAULT_MAX_CACHE_KEYS_PER_USER = 4;
const DEFAULT_MAX_ACTIVE_COMPUTES = 4;
const DEFAULT_MAX_COMPUTE_WAITERS = 32;

/** @typedef {{promise: Promise<any>, subscribers: number, cacheResult: boolean}} ResolutionEntry */
/**
 * @typedef {{
 *   generation: number,
 *   tail: Promise<any>,
 *   tasks: Map<string, ResolutionEntry>,
 *   cache: Map<string, {generation: number, value: any, expiresAt: number}>,
 *   touchedAt: number,
 * }} SessionLane
 */

class SessionResolutionGate {
  /**
   * @param {{
   *   now?: () => number,
   *   ttlMs?: number,
   *   maxUsers?: number,
   *   maxTasksPerUser?: number,
   *   maxSubscribersPerTask?: number,
   *   maxCacheKeysPerUser?: number,
   *   maxActiveComputes?: number,
   *   maxComputeWaiters?: number,
   * }} [opts]
   */
  constructor(opts = {}) {
    this.now = opts.now || (() => Date.now());
    this.ttlMs = positiveInt(opts.ttlMs, DEFAULT_TTL_MS);
    this.maxUsers = positiveInt(opts.maxUsers, DEFAULT_MAX_USERS);
    this.maxTasksPerUser = positiveInt(
      opts.maxTasksPerUser,
      DEFAULT_MAX_TASKS_PER_USER,
    );
    this.maxSubscribersPerTask = positiveInt(
      opts.maxSubscribersPerTask,
      DEFAULT_MAX_SUBSCRIBERS_PER_TASK,
    );
    this.maxCacheKeysPerUser = positiveInt(
      opts.maxCacheKeysPerUser,
      DEFAULT_MAX_CACHE_KEYS_PER_USER,
    );
    this.computeAdmission = new SessionComputeAdmission({
      maxActive: positiveInt(
        opts.maxActiveComputes,
        DEFAULT_MAX_ACTIVE_COMPUTES,
      ),
      maxWaiters: nonNegativeInt(
        opts.maxComputeWaiters,
        DEFAULT_MAX_COMPUTE_WAITERS,
      ),
    });
    /** @type {Map<string, SessionLane>} */
    this.lanes = new Map();
  }

  /**
   * @param {string} userId
   * @param {string} timezone already validated/canonicalized by GamesService
   * @param {{refreshCurrentMmr?: boolean, reuseRecent?: boolean}|undefined} opts
   * @param {() => Promise<any>} compute
   * @returns {Promise<any>}
   */
  resolve(userId, timezone, opts, compute) {
    if (!userId || typeof userId !== "string")
      return Promise.reject(new Error("userId required"));
    if (typeof compute !== "function")
      return Promise.reject(new TypeError("session compute required"));
    let lane;
    try { lane = this._lane(userId); } catch (err) {
      return Promise.reject(err);
    }
    lane.touchedAt = this.now();
    const timezoneKey = String(timezone || "UTC");
    const force = opts?.refreshCurrentMmr === true, reuseRecent = opts?.reuseRecent === true;
    const generation = lane.generation;
    // Once a forced refresh is pending for this exact session bucket, normal
    // reconnects share it. Serving the old short-cache entry here would race
    // the post-game refresh and briefly resurrect the pre-game rating.
    if (!force) {
      const forced = lane.tasks.get(taskKey(generation, timezoneKey, true));
      if (forced) return this._join(forced);
      if (reuseRecent) {
        const cached = lane.cache.get(timezoneKey);
        if (cached && cached.generation === generation) {
          if (this.now() < cached.expiresAt) return Promise.resolve(cached.value);
          lane.cache.delete(timezoneKey);
        }
      }
    } else {
      lane.cache.clear();
    }

    const key = taskKey(generation, timezoneKey, force);
    const existing = lane.tasks.get(key);
    if (existing) {
      if (reuseRecent || force) existing.cacheResult = true;
      return this._join(existing);
    }
    if (lane.tasks.size >= this.maxTasksPerUser) {
      return Promise.reject(sessionResolutionBusyError());
    }

    const predecessor = lane.tail;
    /** @type {ResolutionEntry} */
    const entry = {
      promise: Promise.resolve(),
      subscribers: 1,
      cacheResult: reuseRecent || force,
    };
    const promise = predecessor.catch(() => undefined).then(() =>
      this._compute(
        lane,
        generation,
        timezoneKey,
        force,
        reuseRecent,
        compute,
        entry,
      ));
    entry.promise = promise;
    lane.tasks.set(key, entry);
    lane.tail = promise;
    promise.then(
      () => this._settled(userId, lane, key, promise),
      () => this._settled(userId, lane, key, promise),
    );
    return promise;
  }

  /**
   * @private
   * @param {SessionLane} lane
   * @param {number} generation
   * @param {string} timezoneKey
   * @param {boolean} force
   * @param {boolean} reuseRecent
   * @param {() => Promise<any>} compute
   * @param {ResolutionEntry} entry
   */
  async _compute(
    lane,
    generation,
    timezoneKey,
    force,
    reuseRecent,
    compute,
    entry,
  ) {
    // A queued normal request often discovers that an earlier request has
    // populated the short cache. Recheck before consuming global capacity.
    if (!force && reuseRecent && lane.generation === generation) {
      const cached = lane.cache.get(timezoneKey);
      if (cached && this.now() < cached.expiresAt) return cached.value;
    }
    const releaseCompute = await this.computeAdmission.acquire();
    let value;
    try {
      value = await compute();
    } finally {
      releaseCompute();
    }
    if (entry.cacheResult && lane.generation === generation) {
      this._cache(lane, timezoneKey, generation, value);
    }
    return value;
  }

  /**
   * Invalidate all completed results for a user and put later requests in a
   * new generation. Work that started before the write may finish for its
   * original callers, but it cannot repopulate the post-write cache.
   *
   * @param {string} userId
   */
  invalidate(userId) {
    const lane = this.lanes.get(userId);
    if (!lane) return;
    lane.generation += 1;
    lane.cache.clear();
    lane.touchedAt = this.now();
  }

  /**
   * Aggregate lane pressure without exposing user ids, timezones, or cached
   * session payloads.
   */
  capacitySnapshot() {
    let tasks = 0;
    let subscribers = 0;
    let cachedResults = 0;
    for (const lane of this.lanes.values()) {
      tasks += lane.tasks.size;
      cachedResults += lane.cache.size;
      for (const entry of lane.tasks.values()) {
        subscribers += Number(entry.subscribers) || 0;
      }
    }
    return {
      lanes: this.lanes.size,
      tasks,
      subscribers,
      cachedResults,
      maxLanes: this.maxUsers,
      maxTasksPerLane: this.maxTasksPerUser,
      maxSubscribersPerTask: this.maxSubscribersPerTask,
      maxCacheKeysPerLane: this.maxCacheKeysPerUser,
      computeActive: this.computeAdmission.active,
      computeWaiters: this.computeAdmission.waiters.length,
      maxActiveComputes: this.computeAdmission.maxActive,
      maxComputeWaiters: this.computeAdmission.maxWaiters,
    };
  }

  /**
   * @private
   * @param {string} userId
   * @returns {SessionLane}
   */
  _lane(userId) {
    const existing = this.lanes.get(userId);
    if (existing) return existing;
    this._prune();
    if (this.lanes.size >= this.maxUsers) {
      throw sessionResolutionBusyError();
    }
    const lane = makeLane(this.now());
    this.lanes.set(userId, lane);
    return lane;
  }

  /** @private */
  _prune() {
    const now = this.now();
    for (const [userId, lane] of this.lanes) {
      for (const [key, cached] of lane.cache) {
        if (now >= cached.expiresAt) lane.cache.delete(key);
      }
      if (lane.tasks.size === 0 && lane.cache.size === 0) {
        this.lanes.delete(userId);
      }
    }
    while (this.lanes.size >= this.maxUsers) {
      /** @type {[string, SessionLane] | null} */
      let oldest = null;
      for (const [userId, lane] of this.lanes) {
        if (lane.tasks.size > 0) continue;
        if (!oldest || lane.touchedAt < oldest[1].touchedAt) {
          oldest = [userId, lane];
        }
      }
      if (!oldest) break;
      this.lanes.delete(oldest[0]);
    }
  }

  /**
   * @private
   * @param {ResolutionEntry} entry
   * @returns {Promise<any>}
   */
  _join(entry) {
    if (entry.subscribers >= this.maxSubscribersPerTask) {
      return Promise.reject(sessionResolutionBusyError());
    }
    entry.subscribers += 1;
    return entry.promise;
  }

  /**
   * @private
   * @param {SessionLane} lane
   * @param {string} timezoneKey
   * @param {number} generation
   * @param {any} value
   */
  _cache(lane, timezoneKey, generation, value) {
    if (!lane.cache.has(timezoneKey)) {
      while (lane.cache.size >= this.maxCacheKeysPerUser) {
        const oldestKey = lane.cache.keys().next().value;
        if (typeof oldestKey !== "string") break;
        lane.cache.delete(oldestKey);
      }
    } else {
      lane.cache.delete(timezoneKey);
    }
    lane.cache.set(timezoneKey, {
      generation,
      value,
      expiresAt: this.now() + this.ttlMs,
    });
  }

  /**
   * @private
   * @param {string} userId
   * @param {SessionLane} lane
   * @param {string} key
   * @param {Promise<any>} promise
   */
  _settled(userId, lane, key, promise) {
    const current = lane.tasks.get(key);
    if (current && current.promise === promise) lane.tasks.delete(key);
    if (lane.tail === promise) lane.tail = Promise.resolve();
    lane.touchedAt = this.now();
    if (lane.tasks.size === 0 && lane.cache.size === 0) {
      this.lanes.delete(userId);
    }
  }
}

/**
 * Process-wide FIFO admission for the Mongo + SC2Pulse work behind a session
 * resolution. Per-user lanes still coalesce duplicates; this second bound
 * prevents many different users from computing concurrently during a global
 * reconnect burst.
 */
class SessionComputeAdmission {
  /** @param {{maxActive: number, maxWaiters: number}} opts */
  constructor(opts) {
    this.maxActive = opts.maxActive;
    this.maxWaiters = opts.maxWaiters;
    this.active = 0;
    /** @type {Array<(release: () => void) => void>} */
    this.waiters = [];
  }

  /** @returns {Promise<() => void>} */
  acquire() {
    if (this.active < this.maxActive) {
      this.active += 1;
      return Promise.resolve(this._makeRelease());
    }
    if (this.waiters.length >= this.maxWaiters) {
      return Promise.reject(sessionResolutionBusyError());
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  _releaseSlot() {
    const next = this.waiters.shift();
    if (next) {
      // Direct transfer: the released slot stays counted as active while the
      // oldest waiter takes ownership, leaving no over-admission race window.
      next(this._makeRelease());
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }

  _makeRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this._releaseSlot();
    };
  }
}

/**
 * @param {number} now
 * @returns {SessionLane}
 */
function makeLane(now) {
  return {
    generation: 0,
    tail: Promise.resolve(),
    tasks: new Map(),
    cache: new Map(),
    touchedAt: now,
  };
}

/**
 * @param {number} generation
 * @param {string} timezone
 * @param {boolean} force
 */
function taskKey(generation, timezone, force) {
  return `${generation}|${timezone}|${force ? "force" : "normal"}`;
}

function sessionResolutionBusyError() {
  const err = /** @type {Error & {code: string}} */ (
    new Error("session resolution busy")
  );
  err.code = "SESSION_RESOLUTION_BUSY";
  return err;
}

/**
 * @param {unknown} raw
 * @param {number} fallback
 * @returns {number}
 */
function positiveInt(raw, fallback) {
  return Number.isInteger(raw) && Number(raw) > 0 ? Number(raw) : fallback;
}

/**
 * @param {unknown} raw
 * @param {number} fallback
 * @returns {number}
 */
function nonNegativeInt(raw, fallback) {
  return Number.isInteger(raw) && Number(raw) >= 0 ? Number(raw) : fallback;
}

module.exports = {
  SessionResolutionGate,
  __internal: {
    DEFAULT_TTL_MS,
    DEFAULT_MAX_USERS,
    DEFAULT_MAX_TASKS_PER_USER,
    DEFAULT_MAX_SUBSCRIBERS_PER_TASK,
    DEFAULT_MAX_CACHE_KEYS_PER_USER,
    DEFAULT_MAX_ACTIVE_COMPUTES,
    DEFAULT_MAX_COMPUTE_WAITERS,
    sessionResolutionBusyError,
  },
};
