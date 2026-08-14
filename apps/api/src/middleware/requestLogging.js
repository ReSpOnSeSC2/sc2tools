"use strict";

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

const CREDENTIAL_PATH_SEGMENT =
  /\/(multichat|chatbot|overlay-tokens|device-pairings)\/[^/?#]+/giu;
const SENSITIVE_QUERY_KEY = /(authorization|credential|key|secret|signature|token)/iu;

/**
 * Preserve route shape and useful filters while removing credentials.
 * @param {unknown} value
 * @returns {string}
 */
function sanitiseRequestUrl(value) {
  const raw = typeof value === "string" ? value : "";
  if (!raw) return "";
  let redacted = raw.replace(
    CREDENTIAL_PATH_SEGMENT,
    (_match, route) => `/${route}/[redacted]`,
  );
  try {
    const parsed = new URL(redacted, "http://request.invalid");
    for (const key of parsed.searchParams.keys()) {
      if (SENSITIVE_QUERY_KEY.test(key)) {
        parsed.searchParams.set(key, "[redacted]");
      }
    }
    redacted = `${parsed.pathname}${parsed.search}`;
  } catch {
    // A malformed URL must not break request logging. The path credential
    // replacement above still ran, which covers every credential-bearing API
    // route currently mounted by the service.
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

module.exports = {
  SAFE_HEADER_NAMES,
  sanitiseRequestForLog,
  sanitiseRequestUrl,
};
