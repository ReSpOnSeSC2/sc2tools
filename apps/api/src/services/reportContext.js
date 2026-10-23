"use strict";

const { sanitiseRequestUrl } = require("../middleware/requestLogging");

/**
 * Report type and diagnostics context carried by a user's bug report
 * (``POST /v1/messages``, stored on the ``user_message`` admin event).
 *
 * The web app attaches what helps an admin reproduce the problem: the
 * page path, the web build, browser and OS, viewport, the desktop app's
 * version and online state, and the last few failed API requests. The
 * player can untick any of it before sending, so every field is
 * optional.
 *
 * ``sanitiseReportContext`` is the storage-side pass: it keeps only the
 * whitelisted fields, caps each one and strips credentials from paths
 * (overlay tokens, pairing codes, sensitive query values) with the same
 * rules as the request logs. The route validates strictly first
 * (validation/userMessage.js); this pass is the last line of defence,
 * so it never throws.
 */

const REPORT_TYPES = Object.freeze(["problem", "idea", "question"]);
const AGENT_STATUSES = Object.freeze(["online", "offline", "not_paired"]);

/** Serialized size cap for a whole context object, in bytes of JSON. */
const REPORT_CONTEXT_MAX_BYTES = 2048;
const FAILED_REQUESTS_MAX = 5;

const LIMITS = Object.freeze({
  page: 200,
  build: 40,
  browser: 120,
  viewport: 20,
  agentVersion: 32,
  requestPath: 160,
  requestCode: 64,
  requestId: 64,
});

// Browser-source pages carry their credential in the URL.
const TOKEN_PAGE_SEGMENT = /^\/(overlay|dock)\/[^/?#]+/iu;

/**
 * A page path for a report: no query string or #anchor, browser-source
 * tokens and credential API segments redacted.
 *
 * Example: ``sanitiseReportPagePath("/overlay/abc123/widget/x?y=1")``
 * → "/overlay/[redacted]/widget/x".
 *
 * @param {unknown} raw
 * @returns {string}
 */
function sanitiseReportPagePath(raw) {
  if (typeof raw !== "string") return "";
  const path = raw.trim().split(/[?#]/u)[0];
  if (!path.startsWith("/")) return "";
  const redacted = sanitiseRequestUrl(
    path.replace(TOKEN_PAGE_SEGMENT, (_match, root) => `/${root}/[redacted]`),
  );
  return cap(redacted, LIMITS.page);
}

/**
 * An API request path for a report, credentials redacted.
 *
 * @param {unknown} raw
 * @returns {string}
 */
function sanitiseReportRequestPath(raw) {
  if (typeof raw !== "string") return "";
  const path = raw.trim();
  if (!path.startsWith("/")) return "";
  return cap(sanitiseRequestUrl(path), LIMITS.requestPath);
}

/**
 * The stored form of a report's context: whitelisted, capped and
 * credential-free. Returns null when nothing usable is left.
 *
 * @param {unknown} raw
 * @returns {ReportContext | null}
 */
function sanitiseReportContext(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const src = /** @type {Record<string, unknown>} */ (raw);
  /** @type {ReportContext} */
  const out = {};
  const page = sanitiseReportPagePath(src.page);
  if (page) out.page = page;
  for (const key of /** @type {const} */ (["build", "browser", "viewport", "agentVersion"])) {
    const value = cleanString(src[key], LIMITS[key]);
    if (value) out[key] = value;
  }
  if (typeof src.agentStatus === "string" && AGENT_STATUSES.includes(src.agentStatus)) {
    out.agentStatus = /** @type {ReportContext["agentStatus"]} */ (src.agentStatus);
  }
  const requests = sanitiseFailedRequests(src.failedRequests);
  if (requests.length > 0) out.failedRequests = requests;
  if (Object.keys(out).length === 0) return null;
  return fitContext(out);
}

/**
 * @param {unknown} raw
 * @returns {FailedRequest[]}
 */
function sanitiseFailedRequests(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {FailedRequest[]} */
  const out = [];
  for (const item of raw.slice(0, FAILED_REQUESTS_MAX)) {
    if (!item || typeof item !== "object") continue;
    const entry = /** @type {Record<string, unknown>} */ (item);
    const path = sanitiseReportRequestPath(entry.path);
    const status = Number.isInteger(entry.status) ? Number(entry.status) : NaN;
    if (!path || !(status >= 0 && status <= 599)) continue;
    /** @type {FailedRequest} */
    const request = { path, status };
    const code = cleanString(entry.code, LIMITS.requestCode);
    if (code) request.code = code;
    const requestId = cleanString(entry.requestId, LIMITS.requestId);
    if (requestId) request.requestId = requestId;
    out.push(request);
  }
  return out;
}

/**
 * Drop the oldest failed requests until the context fits the size cap.
 * The per-field caps already keep a whole context under it; this only
 * matters if those caps grow.
 *
 * @param {ReportContext} context
 * @returns {ReportContext}
 */
function fitContext(context) {
  const out = { ...context };
  while (contextBytes(out) > REPORT_CONTEXT_MAX_BYTES && out.failedRequests?.length) {
    out.failedRequests = out.failedRequests.slice(1);
    if (out.failedRequests.length === 0) delete out.failedRequests;
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function contextBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * @param {unknown} raw
 * @param {number} max
 */
function cleanString(raw, max) {
  if (typeof raw !== "string") return "";
  // Control characters never belong in a one-line diagnostic.
  return cap(raw.replace(/[\u0000-\u001f\u007f]/gu, " ").trim(), max);
}

/**
 * @param {string} value
 * @param {number} max
 */
function cap(value, max) {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * @typedef {{ path: string, status: number, code?: string, requestId?: string }} FailedRequest
 * @typedef {{
 *   page?: string,
 *   build?: string,
 *   browser?: string,
 *   viewport?: string,
 *   agentVersion?: string,
 *   agentStatus?: "online" | "offline" | "not_paired",
 *   failedRequests?: FailedRequest[],
 * }} ReportContext
 */

module.exports = {
  REPORT_TYPES,
  AGENT_STATUSES,
  REPORT_CONTEXT_MAX_BYTES,
  FAILED_REQUESTS_MAX,
  REPORT_CONTEXT_LIMITS: LIMITS,
  sanitiseReportContext,
  sanitiseReportPagePath,
  sanitiseReportRequestPath,
  contextBytes,
};
