"use strict";

/** A complete, bounded observed alias cohort, never a regex or silently truncated subset.
 * @param {unknown} raw @returns {string[]|undefined} */
function parseExactMapNames(raw) {
  if (raw === undefined) return;
  let value;
  try { value = typeof raw === "string" && raw.length <= 2048 ? JSON.parse(raw) : null; } catch { value = null; }
  if (!Array.isArray(value) || !value.length || value.length > 16
    || value.some((name) => typeof name !== "string" || !name.trim() || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name))
    || encodeURIComponent(JSON.stringify(value)).length > 2048) {
    throw Object.assign(new Error("Invalid exact map cohort"), { status: 400, code: "bad_request" });
  }
  return [...new Set(/** @type {string[]} */ (value))];
}

module.exports = { parseExactMapNames };
