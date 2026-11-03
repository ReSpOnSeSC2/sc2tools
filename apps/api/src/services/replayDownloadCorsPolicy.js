"use strict";

// Dormant, pure policy only. No runtime imports this module; no SDK/fetch/configuration calls exist here.
const { browserUploadOrigins, _internals } = require("./replayFilesCors");
const BROWSER_DOWNLOAD_CORS_RULE_ID = "sc2tools-browser-replay-download";
const HEADERS = Object.freeze(["range"]);
const EXPOSED = Object.freeze(["Content-Length", "Content-Disposition", "ETag"]);
/** @typedef {import('@aws-sdk/client-s3').CORSRule} Rule */

/** @param {ReadonlyArray<string>} origins @param {{nodeEnv?:string}} [options] @returns {Rule} */
function desiredDownloadRule(origins, options = {}) {
  return { ID: BROWSER_DOWNLOAD_CORS_RULE_ID, AllowedOrigins: browserUploadOrigins(origins, options),
    AllowedMethods: ["GET"], AllowedHeaders: [...HEADERS], ExposeHeaders: [...EXPOSED], MaxAgeSeconds: 3600 };
}

/** GET coverage is independent of upload readiness, including exposed response metadata.
 * @param {ReadonlyArray<Rule>|null|undefined} rules @param {Rule} desired
 */
function downloadRuleCovers(rules, desired) {
  if (!Array.isArray(rules) || !desired.AllowedOrigins?.length) return false;
  return rules.some(rule => rule && list(rule.AllowedMethods).some(method => method.toUpperCase() === "GET")
    && list(desired.AllowedOrigins).every(origin => list(rule.AllowedOrigins).some(pattern => _internals.wildcardMatch(pattern, origin)))
    && list(desired.AllowedHeaders).every(header => list(rule.AllowedHeaders).some(pattern => _internals.wildcardMatch(pattern, header)))
    && list(desired.ExposeHeaders).every(header => list(rule.ExposeHeaders).some(pattern => _internals.wildcardMatch(pattern, header))));
}

/** Preserve PUT, unrelated and ID-less rules. This only returns a prospective value.
 * @param {ReadonlyArray<Rule>} existing @param {Rule} desired @returns {Rule[]}
 */
function mergeDownloadRules(existing, desired) {
  return existing.filter(rule => !rule || rule.ID !== BROWSER_DOWNLOAD_CORS_RULE_ID).concat([desired]);
}

/** Only an explicitly supplied, dated GET check can report ready; desired/PUT facts do not qualify.
 * @param {{method?:unknown,result?:unknown,checkedAt?:unknown,uploadReady?:unknown}} [facts]
 * @returns {{status:'unknown'|'missing_cors'|'no_permission'|'error'|'ready',checkedAt:string|null}}
 */
function downloadCorsStatus(facts = {}) {
  const checkedAt = typeof facts.checkedAt === "string" && facts.checkedAt.length <= 64 && Number.isFinite(Date.parse(facts.checkedAt))
    ? new Date(facts.checkedAt).toISOString() : null;
  if (facts.method !== "GET" || !checkedAt) return { status: "unknown", checkedAt: null };
  const result = facts.result;
  if (result === "ready" || result === "missing_cors" || result === "no_permission" || result === "error") return { status: result, checkedAt };
  return { status: "unknown", checkedAt: null };
}

/** @param {unknown} value @returns {string[]} */
function list(value) { return Array.isArray(value) ? value.filter(item => typeof item === "string") : []; }

module.exports = { BROWSER_DOWNLOAD_CORS_RULE_ID, desiredDownloadRule, downloadRuleCovers, mergeDownloadRules, downloadCorsStatus };
