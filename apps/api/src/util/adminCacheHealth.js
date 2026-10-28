"use strict";

const { LIMITS } = require("../middleware/userCache");

/** @param {unknown} value @param {number} maximum */
function count(value, maximum) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
}

/** A read-only, allowlisted process snapshot. Never reads counters when OFF.
 * Unknown or broken reporting must not fail the existing health probe.
 * @param {unknown} source
 * @returns {null|{enabled:false,counters:null}|{enabled:true,counters:{hit:number,miss:number,entries:number,bytes:number,reserved_bytes:number}}}
 */
function readPersonalChartCache(source) {
  try {
    if (!source || typeof source !== "object" || Array.isArray(source) || !("enabled" in source)) return null;
    const enabled = source.enabled;
    if (typeof enabled !== "boolean") return null;
    if (!enabled) return { enabled: false, counters: null };
    if (!("counters" in source)) return null;
    const counters = source.counters;
    if (!counters || typeof counters !== "object" || Array.isArray(counters)) return null;
    const raw = /** @type {Record<string,unknown>} */ (counters);
    const hit = count(raw.hit, Number.MAX_SAFE_INTEGER), miss = count(raw.miss, Number.MAX_SAFE_INTEGER);
    const entries = count(raw.entries, LIMITS.entries), bytes = count(raw.bytes, LIMITS.bytes);
    const reserved = count(raw.reserved_bytes, LIMITS.bytes);
    if (hit === null || miss === null || entries === null || bytes === null || reserved === null || bytes + reserved > LIMITS.bytes) return null;
    return { enabled: true, counters: { hit, miss, entries, bytes, reserved_bytes: reserved } };
  } catch {
    return null;
  }
}

module.exports = { readPersonalChartCache };
