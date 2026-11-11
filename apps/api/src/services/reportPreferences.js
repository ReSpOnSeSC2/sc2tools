"use strict";

const { canonicalTimeZone } = require("./reportTime");

/**
 * ``/v1/me/preferences/reports``: {weekly, stream, timezone}.
 *
 *   weekly    Monday-morning weekly report in the bell (default on)
 *   stream    a stream report when a Dock stream ends (default on)
 *   timezone  IANA zone for week boundaries and the Monday 09:00 send;
 *             null means UTC until the browser saves one
 */
const REPORTS_PREF_TYPE = "reports";

/** @param {unknown} input */
function sanitizeReportPrefs(input) {
  const value = /** @type {Record<string, unknown>|null} */ (input && typeof input === "object" && !Array.isArray(input) ? input : null);
  return {
    weekly: value?.weekly !== false,
    stream: value?.stream !== false,
    timezone: canonicalTimeZone(value?.timezone),
  };
}

module.exports = { REPORTS_PREF_TYPE, sanitizeReportPrefs };
