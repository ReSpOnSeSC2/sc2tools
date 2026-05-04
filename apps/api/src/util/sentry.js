"use strict";

/**
 * Optional Sentry wiring for the Express API.
 *
 * Soft-import: install with `npm install --workspace apps/api @sentry/node`
 * and set SENTRY_DSN. Until both are in place the helpers are no-ops so
 * production deploys keep working.
 */

let cached = null;

function tryRequireSentry() {
  if (cached !== null) return cached;
  if (!process.env.SENTRY_DSN) return (cached = false);
  try {
    // Lazy require so a missing dep doesn't crash bootstrap.
    cached = require("@sentry/node");
    return cached;
  } catch {
    return (cached = false);
  }
}

function init() {
  const s = tryRequireSentry();
  if (!s) return;
  s.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.1,
    environment: process.env.SC2TOOLS_ENV || "production",
  });
}

/**
 * @param {unknown} err
 */
function captureException(err) {
  const s = tryRequireSentry();
  if (s) s.captureException(err);
}

module.exports = { init, captureException };
