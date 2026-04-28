"use strict";

const crypto = require("crypto");
const { HEADER } = require("../constants");

const REQUEST_ID_BYTES = 8;

/**
 * Attach a request id (incoming X-Request-Id wins, else random hex).
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function requestId(req, res, next) {
  const incoming = req.header(HEADER.REQUEST_ID);
  const id = isSafeRequestId(incoming)
    ? /** @type {string} */ (incoming)
    : crypto.randomBytes(REQUEST_ID_BYTES).toString("hex");
  req.id = id;
  res.setHeader(HEADER.REQUEST_ID, id);
  next();
}

/** @param {unknown} value @returns {boolean} */
function isSafeRequestId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(value);
}

module.exports = { requestId };
