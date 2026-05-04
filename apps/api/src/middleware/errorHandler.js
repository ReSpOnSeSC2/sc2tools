"use strict";

/**
 * Build a 4-arg Express error handler that logs structured fields and
 * returns a JSON error envelope. NEVER leaks stack traces in prod.
 *
 * @param {import('pino').Logger} logger
 * @returns {import('express').ErrorRequestHandler}
 */
function buildErrorHandler(logger) {
  return (err, req, res, _next) => {
    const status = pickStatus(err);
    const code = err && err.code ? String(err.code) : codeFromStatus(status);
    logger.error(
      {
        err,
        reqId: req.id,
        method: req.method,
        path: req.path,
        status,
      },
      "request_failed",
    );
    res.status(status).json({
      error: {
        code,
        message: status >= 500 ? "internal_error" : err.message || code,
        requestId: req.id,
      },
    });
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
