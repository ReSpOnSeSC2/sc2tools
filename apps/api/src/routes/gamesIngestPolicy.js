"use strict";

/**
 * Caller-dependent ingest policy for POST /v1/games.
 *
 * Two uploaders share the ingest route: the paired desktop agent (device
 * token) and the signed-in browser importer (Clerk session). Neither is
 * trusted to describe itself, so this module:
 *
 *   - stamps ``ingestSource`` from the authenticated credential and keeps
 *     ``engineVersion`` only for browser uploads;
 *   - enforces the per-user daily browser-ingest cap (Clerk sessions only)
 *     before a batch is processed, and bills accepted games afterwards.
 *
 * Kept out of routes/games.js so the ingest handler only gains call sites.
 */

const { INGEST_PROVENANCE } = require("../config/constants");

/**
 * @typedef {{ userId: string, source?: string } | undefined} IngestAuth
 * @typedef {{ blocked: boolean, day?: string }} BrowserBatchAdmission
 * @typedef {Pick<import('../services/browserIngestQuota').BrowserIngestQuotaService, 'check' | 'record'>} BrowserIngestQuota
 */

/**
 * Only an interactive Clerk session counts as browser ingest for the cap.
 * Example: isBrowserSession({ userId: "u1", source: "clerk" }) === true
 * @param {IngestAuth} auth
 */
function isBrowserSession(auth) {
  return Boolean(auth && auth.userId && auth.source === "clerk");
}

/**
 * Provenance label for a verified credential source, or ``undefined`` when
 * the source is not one this route knows how to attribute.
 * Example: provenanceForAuth({ userId: "u1", source: "clerk" }) === "browser"
 * @param {IngestAuth} auth
 * @returns {string|undefined}
 */
function provenanceForAuth(auth) {
  if (!auth) return undefined;
  if (auth.source === "device") return INGEST_PROVENANCE.SOURCE_AGENT;
  if (auth.source === "clerk") return INGEST_PROVENANCE.SOURCE_BROWSER;
  return undefined;
}

/**
 * Overwrite client-claimed provenance on a validated game record. Only the
 * credential decides: device token -> "agent" (engine version dropped),
 * Clerk session -> "browser" (engine version kept). Any other source gets
 * neither field, so an unexpected caller can never mislabel a row.
 *
 * Example:
 *   stampIngestProvenance(game, { userId, source: "device" });
 *   // game.ingestSource === "agent", game.engineVersion deleted
 *
 * @param {Record<string, any>} game validated record (mutated in place)
 * @param {IngestAuth} auth
 */
function stampIngestProvenance(game, auth) {
  const source = provenanceForAuth(auth);
  if (source === undefined) delete game.ingestSource;
  else game.ingestSource = source;
  if (source !== INGEST_PROVENANCE.SOURCE_BROWSER) delete game.engineVersion;
}

/**
 * Admit or refuse a browser batch against today's cap. On refusal the 429
 * response is already sent; the caller must stop (its ``finally`` still
 * releases the ingest admission slot).
 *
 * Example:
 *   const admission = await admitBrowserBatch(req, res, quota, games.length);
 *   if (admission.blocked) return;
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {BrowserIngestQuota | undefined} quota
 * @param {number} incomingCount games in this batch
 * @returns {Promise<BrowserBatchAdmission>}
 */
async function admitBrowserBatch(req, res, quota, incomingCount) {
  const auth = /** @type {IngestAuth} */ (req.auth);
  if (!quota || !auth || !isBrowserSession(auth)) return { blocked: false };
  const decision = await quota.check(auth.userId, incomingCount);
  if (decision.allowed) return { blocked: false, day: decision.day };
  res.set("Retry-After", String(decision.retryAfterSec));
  res.set("Cache-Control", "no-store");
  res.status(429).json({
    error: {
      code: "browser_ingest_daily_cap",
      message: `Browser uploads are limited to ${decision.limit} games per day. `
        + "The limit resets at UTC midnight; the desktop agent is not limited.",
      retryable: false,
      limit: decision.limit,
      // The whole batch is refused when it would cross the cap, so tell the
      // client how many games still fit today (a smaller batch may succeed).
      remaining: decision.remaining,
      resetAt: decision.resetAt.toISOString(),
    },
  });
  return { blocked: true };
}

/**
 * Bill accepted browser games to the day the batch was admitted on. Never
 * throws: the games are already durably stored, so a counter hiccup must
 * not turn a successful upload into a client retry.
 *
 * Example:
 *   await recordBrowserBatch(req, quota, admission, accepted.length);
 *
 * @param {import('express').Request} req
 * @param {BrowserIngestQuota | undefined} quota
 * @param {BrowserBatchAdmission} admission
 * @param {number} acceptedCount
 */
async function recordBrowserBatch(req, quota, admission, acceptedCount) {
  const auth = /** @type {IngestAuth} */ (req.auth);
  if (!quota || !auth || !isBrowserSession(auth) || acceptedCount <= 0) return;
  try {
    await quota.record(auth.userId, acceptedCount, admission.day);
  } catch (err) {
    if (req.log) {
      req.log.warn(
        { err, userId: auth.userId, accepted: acceptedCount },
        "browser_ingest_quota_record_failed",
      );
    }
  }
}

module.exports = {
  isBrowserSession,
  stampIngestProvenance,
  admitBrowserBatch,
  recordBrowserBatch,
};
