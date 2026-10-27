"use strict";

/** @typedef {{method?: unknown, originalUrl?: unknown, url?: unknown}} SearchRequest */
/** @typedef {Error & {status: number, code: string, retryAfter?: number}} SearchError */
const PRIVATE_PATH = /^\/v1\/search\/quick\/?$/i;
const ABSOLUTE_ORIGIN = /^https?:\/\/[^/]+(?=\/)/i;
const PRIVATE_FAILURE = Symbol("privateSearchFailure");
const CANONICAL_PATH = "/v1/search/quick";
const BODY_LIMIT = 1024;
/** @type {Readonly<Record<string, number>>} */
const SAFE_CODES = Object.freeze({
  private_search_invalid_request: 400,
  private_search_body_too_large: 413,
  private_search_unsupported_media_type: 415,
  private_search_method_not_allowed: 405,
  private_search_invalid_owner: 401,
  private_search_retired: 409,
  private_search_busy: 503,
  private_search_rate_limited: 429,
  private_search_deadline: 503,
  private_search_unavailable: 503,
  private_search_cleanup_failed: 503,
  private_search_failed: 500,
  missing_token: 401,
  invalid_token: 401,
  auth_failed: 401,
  account_deleted: 401,
  gdpr_operation_busy: 503,
});
/** @type {Readonly<Record<string, string>>} */
const PARSER_CODES = Object.freeze({
  "entity.parse.failed": "private_search_invalid_request",
  "entity.too.large": "private_search_body_too_large",
  "request.aborted": "private_search_invalid_request",
  "request.size.invalid": "private_search_invalid_request",
  "encoding.unsupported": "private_search_unsupported_media_type",
  "charset.unsupported": "private_search_unsupported_media_type",
});

/** Read data only; error/accessor text never becomes a diagnostic.
 * @param {unknown} value @param {PropertyKey} key @returns {unknown}
 */
function ownData(value, key) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try {
    const field = Object.getOwnPropertyDescriptor(value, key);
    return field && Object.hasOwn(field, "value") ? field.value : undefined;
  } catch { return undefined; }
}

/**
 * Exact route recognition without URL dot-segment normalization.
 * Example: isPrivateSearchPath("/V1/search/quick/?q=ignored") === true.
 * @param {unknown} value @returns {boolean}
 */
function isPrivateSearchPath(value) {
  if (typeof value !== "string") return false;
  const end = value.search(/[?#]/);
  const rawPath = (end < 0 ? value : value.slice(0, end)).replace(ABSOLUTE_ORIGIN, "");
  const match = PRIVATE_PATH.exec(rawPath);
  return !!match && match[0] === rawPath;
}

/** Example: isPrivateSearchRequest(req) checks the original mounted path.
 * @param {SearchRequest} req @returns {boolean}
 */
function isPrivateSearchRequest(req) {
  return isPrivateSearchPath(req.originalUrl || req.url);
}

/**
 * A predicate for the EXISTING write fence's post-auth callback only.
 * It verifies no credential and must never replace authentication.
 * Example: isPrivateSearchPost(req) exempts this read from mutation leases.
 * @param {SearchRequest} req @returns {boolean}
 */
function isPrivateSearchPost(req) {
  return req.method === "POST" && isPrivateSearchRequest(req);
}

/** Strip every parameter on this private route; other log URLs are unchanged.
 * Example: privateSearchLogUrl("/v1/search/quick?unknown=secret") returns the fixed path.
 * @param {unknown} value @returns {string}
 */
function privateSearchLogUrl(value) {
  return isPrivateSearchPath(value) ? CANONICAL_PATH : typeof value === "string" ? value : "";
}

/**
 * Set before parsers/rate limiters so private error responses have the same policy.
 * Example: app.use(privateSearchNoStore).
 * @type {import("express").RequestHandler}
 */
const privateSearchNoStore = (req, res, next) => {
  if (isPrivateSearchRequest(req)) res.setHeader("Cache-Control", "private, no-store");
  next();
};

/** Pick only fixed known codes; never inspect/copy message, body, cause or stack.
 * @param {unknown} error @returns {string}
 */
function safeCode(error) {
  const parserType = ownData(error, "type");
  if (typeof parserType === "string" && Object.hasOwn(PARSER_CODES, parserType)) return PARSER_CODES[parserType];
  const code = ownData(error, "code");
  return typeof code === "string" && Object.hasOwn(SAFE_CODES, code) ? code : "private_search_failed";
}

/**
 * Always create a fresh safe error, including for an already mapped failure.
 * Example: safePrivateSearchError(parserError) does not retain parserError.body.
 * @param {unknown} error @returns {SearchError}
 */
function safePrivateSearchError(error) {
  const code = safeCode(error);
  const result = Object.assign(new Error(code), { status: SAFE_CODES[code], code });
  Object.defineProperty(result, PRIVATE_FAILURE, { value: true });
  const retryAfter = ownData(error, "retryAfter");
  if (code === "private_search_rate_limited" && typeof retryAfter === "number"
    && Number.isSafeInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60) {
    /** @type {SearchError} */ (result).retryAfter = retryAfter;
  }
  return result;
}

/** Known private errors can be skipped before optional Sentry capture.
 * Example: isPrivateSearchFailure(safePrivateSearchError(error)) === true.
 * @param {unknown} error @returns {boolean}
 */
function isPrivateSearchFailure(error) {
  return ownData(error, PRIVATE_FAILURE) === true;
}

/**
 * Construct only during app setup, after optional Sentry initialization.
 * The module itself does not load Express or start any SDK/provider.
 * Example: app.use(buildPrivateSearchJsonParser()) before ordinary JSON parsing.
 * @returns {import("express").RequestHandler}
 */
function buildPrivateSearchJsonParser() {
  const parser = require("express").json({ limit: BODY_LIMIT, strict: true });
  return (req, res, next) => {
    if (!isPrivateSearchPost(req)) { next(); return; }
    parser(req, res, (error) => {
      next(error ? safePrivateSearchError(error) : undefined);
    });
  };
}

/**
 * Install before the shared error handler; unrelated routes retain their errors.
 * Example: app.use(privateSearchErrorBoundary, buildErrorHandler(logger)).
 * @param {unknown} error @param {import("express").Request} req
 * @param {import("express").Response} res @param {import("express").NextFunction} next
 */
function privateSearchErrorBoundary(error, req, res, next) {
  if (!isPrivateSearchRequest(req)) { next(error); return; }
  res.setHeader("Cache-Control", "private, no-store");
  const safe = safePrivateSearchError(error);
  if (safe.retryAfter !== undefined) res.setHeader("Retry-After", String(safe.retryAfter));
  next(safe);
}

module.exports = {
  BODY_LIMIT, CANONICAL_PATH, isPrivateSearchPath, isPrivateSearchRequest, isPrivateSearchPost,
  privateSearchLogUrl, privateSearchNoStore, safePrivateSearchError, isPrivateSearchFailure,
  buildPrivateSearchJsonParser, privateSearchErrorBoundary,
};
