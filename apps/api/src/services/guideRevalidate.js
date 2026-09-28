"use strict";

/**
 * On-demand ISR purge for the public guide pages.
 *
 * After a successful nightly guide_stats run the job POSTs a signed ping
 * to the web app (apps/web/app/api/revalidate-guides), which then purges
 * the "guides" fetch-cache tag and the /guides + /sitemap.xml paths, so
 * fresh numbers show up without waiting out the 6 h ISR window.
 *
 * Wire format (the web route verifies exactly this):
 *   POST <GUIDES_REVALIDATE_URL>
 *   content-type: application/json
 *   x-sc2tools-signature: sha256=<hex HMAC-SHA256(secret, `${ts}.${body}`)>
 *   body: {"ts":<epoch milliseconds>,"scope":"guides"}
 * ``ts`` lets the receiver reject replays outside its window (±5 min).
 *
 * Fail-soft: a missing URL/secret makes the revalidator a no-op, and a
 * network error, timeout (5 s) or non-2xx answer is logged (status code
 * only — the URL and secret never reach a log line) and reported in the
 * result; it never throws.
 */

const { createHmac } = require("crypto");

const REVALIDATE_TIMEOUT_MS = 5000;
const SIGNATURE_HEADER = "x-sc2tools-signature";
const SIGNATURE_PREFIX = "sha256=";
const SCOPE = "guides";

/**
 * @typedef {object} GuideRevalidateResult
 * @property {boolean} ok
 * @property {number} [status]  HTTP status when the web app answered
 * @property {"not_configured"} [skipped]
 * @property {string} [error]   "timeout" | "network"
 */

/**
 * @typedef {(url: string, init: Record<string, any>) => Promise<{ ok: boolean, status: number }>} FetchLike
 */

/**
 * Signature header value for a body sent at ``ts``.
 *
 * Example: `signGuideRevalidation("s3cret", 1767225600000, '{"ts":1767225600000,"scope":"guides"}')`
 * → "sha256=<64 hex>".
 *
 * @param {string} secret
 * @param {number} ts epoch milliseconds (the same value as the body's ``ts``)
 * @param {string} body exact request body
 * @returns {string}
 */
function signGuideRevalidation(secret, ts, body) {
  return SIGNATURE_PREFIX + createHmac("sha256", secret).update(`${ts}.${body}`, "utf8").digest("hex");
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errorCode(err) {
  const name = err && typeof err === "object" ? /** @type {{name?: unknown}} */ (err).name : null;
  return name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
}

/**
 * Build the revalidation callback the guide_stats job calls after a run.
 *
 * Example:
 *   const revalidate = buildGuideRevalidator({ url: config.guidesRevalidateUrl,
 *     secret: config.guidesRevalidateSecret, logger });
 *   await revalidate(); // → { ok: true, status: 200 } | { ok: false, skipped: "not_configured" }
 *
 * @param {{
 *   url?: string|null,
 *   secret?: string|null,
 *   logger?: import('pino').Logger|null,
 *   fetchImpl?: FetchLike,
 *   now?: () => number,
 * }} deps
 * @returns {() => Promise<GuideRevalidateResult>}
 */
function buildGuideRevalidator(deps) {
  const url = typeof deps.url === "string" ? deps.url.trim() : "";
  const secret = typeof deps.secret === "string" ? deps.secret : "";
  const logger = deps.logger || null;
  const fetchImpl = deps.fetchImpl || /** @type {FetchLike} */ (/** @type {unknown} */ (globalThis.fetch));
  const now = deps.now || Date.now;

  return async function revalidateGuides() {
    if (!url || !secret) return { ok: false, skipped: "not_configured" };
    const ts = now();
    const body = JSON.stringify({ ts, scope: SCOPE });
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signGuideRevalidation(secret, ts, body) },
        body,
        signal: AbortSignal.timeout(REVALIDATE_TIMEOUT_MS),
      });
      if (!res.ok && logger) logger.warn({ status: res.status }, "guide_revalidate_rejected");
      return { ok: Boolean(res.ok), status: res.status };
    } catch (err) {
      const error = errorCode(err);
      if (logger) logger.warn({ error }, "guide_revalidate_failed");
      return { ok: false, error };
    }
  };
}

module.exports = {
  REVALIDATE_TIMEOUT_MS,
  SIGNATURE_HEADER,
  buildGuideRevalidator,
  signGuideRevalidation,
};
