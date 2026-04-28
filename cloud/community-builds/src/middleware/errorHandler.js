"use strict";

/**
 * @typedef {{ status?: number, statusCode?: number, code?: string, type?: string,
 *             message?: string, name?: string }} HttpishError
 */

/**
 * Final express error handler. Translates known error types into JSON
 * responses, hides internals from clients, and logs full detail.
 *
 * @param {import('pino').Logger} logger
 * @returns {import('express').ErrorRequestHandler}
 */
function buildErrorHandler(logger) {
  return function errorHandler(err, req, res, _next) {
    const safeErr = /** @type {HttpishError} */ (err);
    const status = pickStatus(safeErr);
    const code = pickCode(safeErr);
    if (status >= 500) {
      logger.error({ err, reqId: req.id, path: req.path }, "request_failed");
    } else {
      logger.warn({ err: safeErr.message, code, reqId: req.id, path: req.path }, "request_rejected");
    }
    res.status(status).json({ error: code, requestId: req.id });
  };
}

/** @param {HttpishError} err @returns {number} */
function pickStatus(err) {
  if (typeof err.status === "number") return err.status;
  if (typeof err.statusCode === "number") return err.statusCode;
  if (err.type === "entity.too.large") return 413;
  if (err.type === "entity.parse.failed") return 400;
  return 500;
}

/** @param {HttpishError} err @returns {string} */
function pickCode(err) {
  if (typeof err.code === "string") return err.code;
  if (typeof err.type === "string") return err.type;
  return "internal_error";
}

module.exports = { buildErrorHandler };
