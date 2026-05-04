"use strict";

const crypto = require("crypto");

/**
 * Attach a per-request `req.id`. Pino logs it on every line so we can
 * trace one request through ingress → service → DB.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {Function} next
 */
function requestId(req, res, next) {
  const incoming = req.headers["x-request-id"];
  const id =
    typeof incoming === "string" && incoming.length > 0
      ? incoming
      : crypto.randomUUID();
  req.id = id;
  res.setHeader("x-request-id", id);
  next();
}

module.exports = { requestId };
