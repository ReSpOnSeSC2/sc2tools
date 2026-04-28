"use strict";

/**
 * Error subclass that carries an HTTP status and a stable code.
 *
 * Example:
 *   throw new HttpError(404, "not_found");
 */
class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} [message]
   */
  constructor(status, code, message) {
    super(message || code);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

/**
 * @param {number} status
 * @param {string} code
 * @returns {HttpError}
 */
function httpError(status, code) {
  return new HttpError(status, code);
}

module.exports = { HttpError, httpError };
