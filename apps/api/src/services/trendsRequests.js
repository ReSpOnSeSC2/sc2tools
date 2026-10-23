"use strict";

const MAX_PENDING = 256;
const MAX_JOIN_AGE_MS = 30000;

/** Share work that is currently running on one service instance. Completed
 * responses are cached only when explicitly requested for lightweight metadata.
 * Keys include the method, authenticated user, filters, and all chart options. */
class TrendsRequests {
  constructor() {
    /** @type {Map<string, {startedAt: number, promise: Promise<any>}>} */
    this.pending = new Map();
    /** @type {Map<string, {expiresAt: number, sequence: number, value: any}>} */
    this.completed = new Map();
    this.cacheSequence = 0;
  }

  /** Optional short cache for metadata shared between browser tabs. Normal
   * chart requests keep using run(), which always reads fresh completed data.
   * @template T @param {unknown[]} parts @param {() => Promise<T>} work
   * @param {number} ttlMs @returns {Promise<T>} */
  cached(parts, work, ttlMs) {
    const key = requestKey(parts);
    if (key === null) return this.run(parts, work);
    const now = Date.now();
    for (const [oldKey, entry] of this.completed) {
      if (entry.expiresAt <= now) this.completed.delete(oldKey);
    }
    const previous = this.completed.get(key);
    if (previous) return Promise.resolve(cloneResult(previous.value));
    return this.run(parts, async () => {
      const sequence = ++this.cacheSequence;
      const value = await work();
      // An aged request may finish after its replacement. Keep the newer answer.
      if ((this.completed.get(key)?.sequence ?? 0) > sequence) return value;
      this.completed.delete(key);
      while (this.completed.size >= MAX_PENDING) {
        const oldest = this.completed.keys().next().value;
        if (oldest === undefined) break;
        this.completed.delete(oldest);
      }
      this.completed.set(key, { expiresAt: Date.now() + ttlMs, sequence, value: cloneResult(value) });
      return value;
    });
  }

  /** @template T
   * @param {unknown[]} parts
   * @param {() => Promise<T>} work
   * @returns {Promise<T>} */
  run(parts, work) {
    const now = Date.now();
    for (const [key, entry] of this.pending) {
      if (now - entry.startedAt >= MAX_JOIN_AGE_MS) this.pending.delete(key);
    }
    const key = requestKey(parts);
    // Sharing is optional under load or for an unsupported future option type.
    // Do not reject a valid request simply because this small registry is full.
    if (key === null) return work();
    const previous = this.pending.get(key);
    if (previous) return previous.promise.then(cloneResult);
    if (this.pending.size >= MAX_PENDING) return work();
    const entry = { startedAt: now, promise: /** @type {Promise<T>} */ (Promise.resolve()) };
    const release = () => {
      // An aged-out request must not remove its newer replacement.
      if (this.pending.get(key) === entry) this.pending.delete(key);
    };
    entry.promise = Promise.resolve().then(work).then((result) => {
      release();
      return result;
    }, (error) => {
      release();
      throw error;
    });
    this.pending.set(key, entry);
    return entry.promise.then(cloneResult);
  }
}

/** These chart DTOs contain plain objects, arrays, primitives and Dates.
 * Never hand a shared mutable result to a caller, including the first caller.
 * @template T @param {T} value @returns {T} */
function cloneResult(value) { return structuredClone(value); }

/** Preserve Date, regex, undefined, and value types without JSON key collisions.
 * Sort object keys so equivalent parsed filters share a request regardless of
 * query-string order; array order is intentionally preserved.
 * @param {unknown} value @returns {string | null} */
function requestKey(value) {
  try { return JSON.stringify(keyValue(value)); } catch { return null; }
}

/** @param {unknown} value @returns {unknown} */
function keyValue(value) {
  if (value === null) return ["null"];
  if (value instanceof Date) return ["date", value.getTime().toString()];
  if (value instanceof RegExp) return ["regex", value.source, value.flags];
  if (Array.isArray(value)) return ["array", value.map(keyValue)];
  if (typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError("Unsupported request key value");
    }
    return ["object", Object.keys(value).sort().map((key) => [key, keyValue(/** @type {Record<string, unknown>} */ (value)[key])])];
  }
  if (["function", "symbol"].includes(typeof value)) throw new TypeError("Unsupported request key value");
  return [typeof value, typeof value === "number" && Object.is(value, -0) ? "-0" : String(value)];
}

module.exports = { TrendsRequests, requestKey, MAX_PENDING, MAX_JOIN_AGE_MS };
