"use strict";
const MAX_RIVALS = 50;
const MAX_RIVAL_KEY_LENGTH = 320;

/** Grouped player keys are opaque identity data, not display names. Legacy
 * invalid data is ignored on read; writes reject malformed/unbounded input.
 * @param {unknown} raw @param {boolean} [strict] */
function sanitizeRivals(raw, strict = false) {
  const value = /** @type {{keys?:unknown}|null} */ (raw);
  const object = !!raw && typeof raw === "object" && !Array.isArray(raw);
  const keys = object && value?.keys !== undefined ? value.keys : [];
  const valid = object && Object.keys(raw).every(key => key === "keys") && Array.isArray(keys) && keys.length <= MAX_RIVALS
    && keys.every(key => typeof key === "string" && key.length > 0 && key.length <= MAX_RIVAL_KEY_LENGTH && key.trim() === key && !/[\u0000-\u001f\u007f]/u.test(key));
  if (!valid) {
    if (strict) throw Object.assign(new Error("Choose at most 50 valid rival player keys."), { status: 400, code: "invalid_rivals" });
    return { keys: [] };
  }
  return { keys: [...new Set(/** @type {string[]} */ (keys))] };
}

module.exports = { sanitizeRivals, MAX_RIVALS, MAX_RIVAL_KEY_LENGTH };
