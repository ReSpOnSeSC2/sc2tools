"use strict";

const { isPrivateSearchPath, privateSearchLogUrl } = require("./privateSearchBoundary");
const { isSearchQueryUrl, redactSearchQuery } = require("./searchQueryPrivacy");
const { isReplayDownloadBatchPath } = require("./replayDownloadBatchBoundary");

// Request logs are operational telemetry, not a copy of the incoming
// request.  In particular, Clerk/device bearer tokens and overlay tokens are
// credentials.  Keeping the whole headers object also makes every heartbeat
// and chat poll allocate/stringify a large JWT for no diagnostic benefit.
const SAFE_HEADER_NAMES = Object.freeze([
  "host",
  "user-agent",
  "content-type",
  "content-length",
  "accept",
  "accept-encoding",
  "accept-language",
  "cf-connecting-ip",
  "cf-ray",
  "x-forwarded-for",
  "x-request-id",
  "x-render-routing",
]);

const SAFE_RESPONSE_HEADER_NAMES = Object.freeze([
  "content-type",
  "content-length",
  "retry-after",
  "x-request-id",
]);

// ``build-intents/live/<gameKey>``: a live game key holds both players'
// names, which never belong in request logs. ``shares/<token>``: a game
// share token is the bearer credential of its public page.
// ``calendar/<secret>.ics``: the private coaching calendar feed's bearer secret.
const CREDENTIAL_PATH_SEGMENT =
  /\/(multichat|chatbot|overlay-tokens|device-pairings|build-intents\/live|shares|calendar|match-rooms)\/[^/?#]+/giu;
// ``review_tag`` is owner-authored review-queue text (routes/replays.js).
const SENSITIVE_QUERY_KEY = /(authorization|credential|key|secret|signature|token|review_tag)/iu;
const SPATIAL_PATH = /^\/v1\/spatial\//iu;
const STREAM_VIEWER_PUBLIC = /^\/(?:v1\/)?public\/players\/[^/]+\/live\/?$/i;
const STREAM_VIEWER_OWNER = /^\/(?:v1\/)?me\/stream-viewer\/?$/i;
const DAILY_CALLS = /^\/(?:v1\/)?daily\/calls\/?$/i;
const OAUTH_CALLBACK_PATH =
  /^\/v1\/integrations\/(?:twitch|kick|youtube)\/callback\/?$/iu;
const OAUTH_CALLBACK_SENSITIVE_QUERY_KEYS = new Set([
  "code",
  "state",
  "error",
  "error_description",
  "error_uri",
]);

/** @param {unknown} value */
function streamViewerLogPath(value) {
  if (typeof value !== "string") return null;
  const path = value.replace(/^https?:\/\/[^/]+(?=\/)/i, "").split(/[?#]/u, 1)[0];
  if (STREAM_VIEWER_PUBLIC.test(path)) return "/v1/public/players/[redacted]/live";
  return STREAM_VIEWER_OWNER.test(path) ? "/v1/me/stream-viewer" : null;
}

/** @param {unknown} value */
function isStreamViewerRequest(value) { return streamViewerLogPath(value) !== null; }

/** @param {unknown} value */
function isDailyCallsRequest(value) {
  return typeof value === "string" && DAILY_CALLS.test(value.split(/[?#]/u, 1)[0].replace(/^https?:\/\/[^/]+(?=\/)/i, ""));
}

/** @param {string} raw */
function privateOperationalPath(raw) {
  if (isReplayDownloadBatchPath(raw)) return "/v1/replays/download-batch";
  if (isPrivateSearchPath(raw)) return privateSearchLogUrl(raw);
  if (isDailyCallsRequest(raw)) return "/v1/daily/calls";
  return streamViewerLogPath(raw);
}

/**
 * Preserve route shape and useful filters while removing credentials.
 * @param {unknown} value
 * @returns {string}
 */
function sanitiseRequestUrl(value) {
  const raw = typeof value === "string" ? value : "";
  if (!raw) return "";
  const operational = privateOperationalPath(raw);
  if (operational) return operational;
  let redacted = raw.replace(
    CREDENTIAL_PATH_SEGMENT,
    (_match, route) => `/${route}/[redacted]`,
  ).replace(/(\/public\/replays\/[^/?#]+\/)[^/?#]+/giu, "$1[redacted]");
  try {
    const parsed = new URL(redacted, "http://request.invalid");
    const isOauthCallback = OAUTH_CALLBACK_PATH.test(parsed.pathname);
    // A heatmap filter can contain a private opponent identity.
    if (SPATIAL_PATH.test(parsed.pathname) && parsed.searchParams.has("opponent")) {
      parsed.searchParams.set("opponent", "[redacted]");
    }
    for (const key of parsed.searchParams.keys()) {
      if (
        SENSITIVE_QUERY_KEY.test(key)
        || (
          isOauthCallback
          && OAUTH_CALLBACK_SENSITIVE_QUERY_KEYS.has(key.toLowerCase())
        )
      ) {
        parsed.searchParams.set(key, "[redacted]");
      }
    }
    redactSearchQuery(parsed);
    redacted = `${parsed.pathname}${parsed.search}`;
  } catch {
    // A malformed URL must not break request logging. The path credential
    // replacement above still ran, which covers every credential-bearing API
    // route currently mounted by the service. A search route keeps its path only.
    if (isSearchQueryUrl(redacted)) return redacted.split(/[?#]/u, 1)[0];
  }
  return redacted;
}

/**
 * Pino HTTP serializer operating on the raw IncomingMessage.  The explicit
 * allowlist is fail-closed: newly introduced secret headers cannot silently
 * start appearing in production logs.
 * @param {import('http').IncomingMessage & {id?: unknown, originalUrl?: string}} req
 * @returns {Record<string, unknown>}
 */
function sanitiseRequestForLog(req) {
  if (isDailyCallsRequest(req.originalUrl || req.url)) return { method: req.method, url: "/v1/daily/calls" };
  /** @type {Record<string, string|string[]>} */
  const headers = {};
  for (const name of SAFE_HEADER_NAMES) {
    const value = req.headers?.[name];
    if (typeof value === "string" || Array.isArray(value)) {
      headers[name] = value;
    }
  }
  return {
    id: req.id,
    method: req.method,
    url: sanitiseRequestUrl(req.originalUrl || req.url),
    headers,
    remoteAddress: req.socket?.remoteAddress,
    remotePort: req.socket?.remotePort,
  };
}

/**
 * With wrapSerializers:false, Pino otherwise serializes the complete
 * ServerResponse, including its request and raw authorization headers.
 * Allowlist response metadata too; cookies, redirects, bodies and the
 * response/request object graph are never operational log fields.
 * @param {import('http').ServerResponse} res
 * @returns {Record<string, unknown>}
 */
function sanitiseResponseForLog(res) {
  const statusCode = res.headersSent ? res.statusCode : null;
  if (isDailyCallsRequest(res.req?.url)) return { statusCode };
  /** @type {Record<string, string|string[]|number>} */
  const headers = {};
  for (const name of SAFE_RESPONSE_HEADER_NAMES) {
    const value = res.getHeader(name);
    if (typeof value === "string" || typeof value === "number" || Array.isArray(value)) headers[name] = value;
  }
  return { statusCode, headers };
}

module.exports = {
  SAFE_HEADER_NAMES,
  sanitiseRequestForLog,
  sanitiseResponseForLog,
  sanitiseRequestUrl,
  isStreamViewerRequest,
  isDailyCallsRequest,
};
