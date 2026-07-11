"use strict";

/**
 * Optional Sentry wiring for the Express API.
 *
 * Soft-import: install with `npm install --workspace apps/api @sentry/node`
 * and set SENTRY_DSN. Until both are in place the helpers are no-ops so
 * production deploys keep working.
 */

/**
 * The lazily-required module, ``false`` once a require attempt failed
 * (or no DSN is set), ``null`` before the first attempt.
 * @type {typeof import("@sentry/node") | false | null}
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

/**
 * Initialise Sentry. Returns whether reporting is actually live so the
 * boot log can say so — a DSN configured in Render with the package
 * missing from package.json silently no-ops otherwise, and that exact
 * misconfiguration shipped for months.
 *
 * @returns {boolean} true when Sentry is installed AND a DSN is set
 */
function init() {
  const s = tryRequireSentry();
  if (!s) return false;
  s.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.1,
    environment: process.env.SC2TOOLS_ENV || "production",
  });
  return true;
}

/**
 * @param {unknown} err
 */
function captureException(err) {
  const s = tryRequireSentry();
  if (s) s.captureException(err);
}

/**
 * Flush buffered events before the process exits — used by the
 * uncaughtException handler, where exiting without a flush would drop
 * the one event that explains the crash. Resolves on timeout too.
 *
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
async function flush(timeoutMs = 2000) {
  const s = tryRequireSentry();
  if (!s || typeof s.flush !== "function") return;
  try {
    await s.flush(timeoutMs);
  } catch {
    // Flushing is best-effort; the process is going down either way.
  }
}

module.exports = { init, captureException, flush };
