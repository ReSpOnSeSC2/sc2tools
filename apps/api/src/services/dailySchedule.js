"use strict";

const SCHEDULE_URL = "https://sc2tools.com/daily/v1/index.json";
const MAX_INDEX_BYTES = 40_000;
const PACK_DIGEST = /^[0-9a-f]{64}$/u;
const DAY_KEY = /^[1-9][0-9]{0,5}$/u;
const DAY_MS = 86_400_000;
const currentDay = (time = Date.now()) => Math.floor(time / DAY_MS);

/** @param {Response} response @returns {Promise<unknown>} */
async function readIndex(response) {
  const reader = response.body?.getReader();
  if (!response.ok || !reader) throw new Error("daily_schedule_unavailable");
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_INDEX_BYTES) throw new Error("daily_schedule_too_large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** @param {unknown} index @param {number} day */
function recordedPack(index, day) {
  if (!index || typeof index !== "object" || Object.keys(index).length !== 3) throw new Error("daily_schedule_invalid");
  const { version, days, practice } = /** @type {Record<string,unknown>} */ (index);
  if (version !== 1 || !validDays(days) || !validPractice(practice)) throw new Error("daily_schedule_invalid");
  const digest = days[String(day)];
  return digest && !practice.includes(digest) ? digest : null;
}

/** @param {unknown} value @returns {value is string} */
const isDigest = value => typeof value === "string" && PACK_DIGEST.test(value);

/** @param {unknown} value @returns {value is Record<string,string>} */
function validDays(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 366 && entries.every(([day, digest]) => DAY_KEY.test(day) && isDigest(digest));
}

/** @param {unknown} value @returns {value is string[]} */
function validPractice(value) {
  return Array.isArray(value) && value.length === 7 && value.every(isDigest);
}

/** Pin the first recorded digest for the day, while refreshing publication status.
 * @param {{fetchImpl?:typeof fetch, now?:() => number}} [options] */
function createDailySchedule({ fetchImpl = fetch, now = Date.now } = {}) {
  /** @type {{day:number, expiresAt:number, digest:string|null}|null} */
  let cached = null;
  /** @type {{day:number, digest:string}|null} */
  let pinned = null;
  /** @type {{day:number, promise:Promise<string|null>}|null} */
  let pending = null;
  return function schedule(day) {
    if (day !== currentDay(now())) return Promise.resolve(null);
    if (cached?.day === day && cached.expiresAt > now()) return Promise.resolve(cached.digest);
    if (pending?.day === day) return pending.promise;
    const promise = fetchImpl(SCHEDULE_URL, { cache: "no-cache", redirect: "error", signal: AbortSignal.timeout(2_500) })
      .then(readIndex)
      .then(index => {
        if (day !== currentDay(now())) return null;
        const digest = recordedPack(index, day);
        if (digest && pinned?.day !== day) pinned = { day, digest };
        const published = digest === pinned?.digest ? digest : null;
        cached = { day, digest: published, expiresAt: now() + 30_000 };
        return published;
      })
      .finally(() => { if (pending?.day === day) pending = null; });
    pending = { day, promise };
    return promise;
  };
}

module.exports = { currentDay, createDailySchedule, DAY_MS, PACK_DIGEST };
