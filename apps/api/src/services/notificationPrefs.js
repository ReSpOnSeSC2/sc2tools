"use strict";

const NOTIFICATIONS_PREF_TYPE = "notifications";
const KIND_RE = /^[a-z][a-z0-9_.]{1,63}$/;

/** @param {unknown} input */
function sanitizeNotificationPrefs(input) {
  const value = /** @type {any} */ (input);
  return { muted: [...new Set(Array.isArray(value?.muted)
    ? value.muted.filter((/** @type {unknown} */ kind) => typeof kind === "string" && KIND_RE.test(kind)).slice(0, 50)
    : [])] };
}

module.exports = { NOTIFICATIONS_PREF_TYPE, sanitizeNotificationPrefs };
