"use strict";

const sentry = require("../util/sentry");
const { sanitiseRequestUrl } = require("./requestLogging");
const { isSearchQueryUrl } = require("./searchQueryPrivacy");

/**
 * Build a 4-arg Express error handler that logs structured fields and
 * returns a JSON error envelope. NEVER leaks stack traces in prod.
 *
 * @param {import('pino').Logger} logger
 * @returns {import('express').ErrorRequestHandler}
 */
function buildErrorHandler(logger) {
  return (err, req, res, next) => {
    const status = pickStatus(err);
    const code = err && err.code ? String(err.code) : codeFromStatus(status);
    logger.error(
      {
        err: isSearchQueryUrl(req.originalUrl || req.url) ? searchSafeError(err) : err,
        reqId: req.id,
        method: req.method,
        // Same redaction as request logs: tokens and live game keys in
        // path segments never reach error logs.
        path: sanitiseRequestUrl(req.path),
        status,
      },
      "request_failed",
    );
    // Forward unexpected 5xx to Sentry. 4xx are user errors and noise.
    if (status >= 500) {
      sentry.captureException(err);
    }
    // A replay-body deadline may already have sent a bounded 408 before
    // destroying the slow upload stream. body-parser then reports the abort;
    // delegate instead of attempting a second JSON response.
    if (res.headersSent) {
      next(err);
      return;
    }
    res.status(status).json({
      error: {
        code,
        message: status >= 500 ? "internal_error" : err.message || code,
        requestId: req.id,
      },
    });
  };
}

/**
 * A request whose URL carries typed search text logs its error's kind only:
 * a database message can echo the search filter.
 * @param {any} err
 */
function searchSafeError(err) {
  return {
    type: typeof err?.name === "string" ? err.name : undefined,
    code: typeof err?.code === "string" || Number.isInteger(err?.code) ? err.code : undefined,
    codeName: typeof err?.codeName === "string" ? err.codeName : undefined,
  };
}

/** @param {any} err @returns {number} */
function pickStatus(err) {
  if (err && typeof err.status === "number") return err.status;
  if (err && typeof err.statusCode === "number") return err.statusCode;
  return 500;
}

/** @param {number} status @returns {string} */
function codeFromStatus(status) {
  if (status === 400) return "bad_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 422) return "unprocessable";
  if (status === 429) return "rate_limited";
  return "internal_error";
}

module.exports = { buildErrorHandler };
